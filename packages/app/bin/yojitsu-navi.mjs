#!/usr/bin/env node
// 予実ナビを社内 GitLab に持ち込むコマンド（SPEC §44）。外部の依存なし・ネットワーク接続なしで動く（gitlab-setup だけ社内 GitLab に接続する）
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, gitlabFromRemote, init, normalizeGitlab, readGitlabTarget, update } from "../lib/project.mjs";

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version;

const HELP = `予実ナビ ${VERSION}

使い方:
  yojitsu-navi init [フォルダ] [--gitlab <社内GitLabのURL> --project <グループ/プロジェクト>] [--no-git]
      新しいプロジェクトのフォルダを作る（既定 yojitsu-navi）。接続先を config.json と git remote に入れる
  yojitsu-navi update [フォルダ] [--force]
      今あるプロジェクトをこの版にする（data/ と config.json は変えない）。ブランチ update-<版> にコミットする
  yojitsu-navi gitlab-setup [--apply] [--api <URL> --project <グループ/プロジェクト>]
      GitLab プロジェクトの設定を確認（--apply で直す）。トークンは環境変数 GITLAB_TOKEN（無ければ聞く）。接続先は config.json から読む
  yojitsu-navi --version

手順: docs/DEPLOY_GITLAB.md`;

function opt(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : "";
}
/** オプションとその値を除いた引数 */
function positional(argv, withValue) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (withValue.includes(argv[i])) i++;
    else if (!argv[i].startsWith("--")) out.push(argv[i]);
  }
  return out;
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** 入力を画面に出さずに 1 行読む（トークン用） */
function askSecret(question) {
  return new Promise((done, fail) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");
    let value = "";
    const finish = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stdout.write("\n");
      if (err) fail(err);
      else done(value.trim());
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish();
        if (ch === "\u0003") return finish(new CliError("中止しました"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const log = (s) => console.log(s);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    log(HELP);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    log(VERSION);
    return 0;
  }
  if (cmd === "init") {
    const dir = resolve(positional(rest, ["--gitlab", "--project"])[0] ?? "yojitsu-navi");
    let gitlab = normalizeGitlab(opt(rest, "gitlab"), opt(rest, "project"));
    // パッケージに接続先が入っていなければ聞く（空のまま進めてもよい。あとで config.json に書ける）
    if (!gitlab && !readGitlabTarget(`${PKG_DIR}/template`) && process.stdin.isTTY) {
      const url = await ask("社内 GitLab の URL（例 https://gitlab.example.local。わからなければ空のまま Enter）: ");
      if (url) gitlab = normalizeGitlab(url, (await ask("グループ/プロジェクト [yojitsu-navi/yojitsu-navi]: ")) || "yojitsu-navi/yojitsu-navi");
    }
    init({ pkgDir: PKG_DIR, version: VERSION, dir, gitlab, git: !rest.includes("--no-git"), log });
    return 0;
  }
  if (cmd === "update") {
    const dir = resolve(positional(rest, [])[0] ?? ".");
    update({ pkgDir: PKG_DIR, version: VERSION, dir, force: rest.includes("--force"), log });
    return 0;
  }
  if (cmd === "gitlab-setup") {
    const args = [...rest];
    // config.json に接続先が無ければ git remote（origin）から読む
    if (!opt(args, "api") && !opt(args, "project") && !readGitlabTarget(process.cwd())) {
      const remote = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf-8" }).stdout ?? "";
      const g = gitlabFromRemote(remote);
      if (g) args.push("--api", g.apiBaseUrl, "--project", g.projectId);
    }
    const env = { ...process.env };
    // Windows のコマンドプロンプトでも使えるよう、環境変数が無ければその場で聞く（引数には取らない）
    if (!env.GITLAB_TOKEN && process.stdin.isTTY) env.GITLAB_TOKEN = await askSecret("Owner か Maintainer のトークン（scope: api。画面には出ません）: ");
    const setup = await import("../dist/gitlab-setup.mjs");
    return setup.main(args, env, (url, init) => fetch(url, init), log, process.cwd());
  }
  log(`知らないコマンドです: ${cmd}\n\n${HELP}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof CliError ? e.message : e);
    process.exit(e instanceof CliError ? 2 : 1);
  },
);
