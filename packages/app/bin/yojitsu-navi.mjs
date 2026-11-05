#!/usr/bin/env node
// 予実ナビを社内 GitLab に持ち込むコマンド（SPEC §44）。外部の依存なし・ネットワーク接続なしで動く（gitlab-setup だけ社内 GitLab に接続する）
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, LOG_DIR, backupStamp, check, gitlabFromRemote, init, migrateCiCommand, normalizeGitlab, readGitlabTarget, resetData, update } from "../lib/project.mjs";
import { createOutput } from "../lib/output.mjs";
import { upgrade } from "../lib/upgrade.mjs";

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version;

const HELP = `予実ナビ ${VERSION}

使い方:
  yojitsu-navi init [フォルダ] [--gitlab <社内GitLabのURL> --project <グループ/プロジェクト>] [--sample] [--no-git]
      新しいプロジェクトのフォルダを作る（既定 yojitsu-navi）。接続先を config.json と git remote に入れる
      data/ は空（見出しの行だけ）で作る
        --sample      試す用のサンプルのデータ（架空の会社。作業実績 約 13MB）を data/ に入れる（本番には使わない）
  yojitsu-navi upgrade [フォルダ] [--overwrite | --keep-local] [--no-commit] [--force] [--test] [--log <ファイル>]
      版を上げる作業を 1 回で行う: update → 設定の互換確認（config.json）→ 依存を入れる（npm ci）→ check → データ検証 → テスト（既定は飛ばす）→ ビルド
      失敗したところで止まり、最後に結果の要約を出す。全部の出力は ${LOG_DIR}/upgrade-<日時>.log（UTF-8）に残す
        --test        テストも動かす（CI/CD 変数と同じく環境変数 YOJITSU_RUN_TESTS=1 でもよい）
        ほかのオプションは update と同じ
  yojitsu-navi update [フォルダ] [--dry-run] [--overwrite | --keep-local] [--no-commit] [--force] [--summary] [--log <ファイル>]
      今あるプロジェクトをこの版にする（data/ と config.json は変えない）。ブランチ update-<版> を作って自動でコミットする
      上書き・削除するファイルを社内で変えていたら、何も変えずに止まる。前のファイルは .yojitsu-navi-backup/<日時>/ に写す
      config.json が新しい版でそのまま動くか（必須の項目・型・値）も確かめる
      data/ にサンプルのまま残っているファイル・パッケージに無いファイル（社内で足したもの）があれば一覧を出す（消さない）
        --dry-run     何も変えずに、変わるファイルと社内で変えたファイルの差分を出す
        --overwrite   社内で変えたファイルも新しい版にする
        --keep-local  社内で変えたファイルは社内の版のまま残す（次の update でも残す）
        --no-commit   ブランチを作らず、コミットもしない（git add まで）
        --force       コミットしていない変更・古い版・依存込みの確認を飛ばす
        --summary     画面には件数と要るものだけを出す（ファイルの一覧・差分・変更履歴は --log のファイルに）
        --log <ファイル>  出力をファイルにも書く（UTF-8。PowerShell で日本語が化けるときはこのファイルを開く）
  yojitsu-navi reset-data [フォルダ] [--dry-run] [--log <ファイル>]
      data/ にサンプルのまま残っているファイルを空にする（作業実績の月のファイルは消し、ほかの CSV は見出しの行だけにする）
      サンプルと中身が同じファイルだけを変える。前のものは .yojitsu-navi-backup/<日時>/ に写す。コミットはしない
  yojitsu-navi check [フォルダ] [--log <ファイル>]
      CI（.gitlab-ci.yml）が使うファイルがフォルダにあり、git にコミットされているか、GitLab が受け付けない書き方（中身の無いジョブなど）が無いか確かめる
      （init・update の最後にも確かめる。プロジェクトの中では npm run ci:check でも同じことができる）
  yojitsu-navi migrate-ci [フォルダ] [--dry-run] [--force] [--log <ファイル>]
      社内で .gitlab-ci.yml に書いたランナーのタグ・変数・社内だけのジョブを .gitlab-ci.local.yml に移す（.gitlab-ci.yml は変えない）。
      移し終えると、次の update は .gitlab-ci.yml で止まらずに新しい版にする
        --dry-run     何も変えずに、移すものと自動で移せないものを出す
        --force       自動で移せないものが残っていても、次の update で .gitlab-ci.yml を新しい版にする（前のものはバックアップに残る）
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

/** 今のコマンドの出力（エラーもログのファイルに書くため） */
let out = createOutput();

/** 知らないオプションがあれば止める（withValue は値を取るオプション） */
function assertKnown(rest, known, withValue = []) {
  const unknown = rest.filter((a, i) => a.startsWith("--") && !known.includes(a) && !withValue.includes(a) && !withValue.includes(rest[i - 1]));
  if (unknown.length) throw new CliError(`知らないオプションです: ${unknown.join(" ")}\n\n${HELP}`);
  for (const w of withValue) if (rest.includes(w) && !opt(rest, w.slice(2))) throw new CliError(`${w} のあとにファイルの名前を書いてください`);
}

/** update・upgrade に共通のオプション */
function updateOptions(rest) {
  return { force: rest.includes("--force"), overwrite: rest.includes("--overwrite"), keepLocal: rest.includes("--keep-local"), commit: !rest.includes("--no-commit") };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const log = (s) => out.log(s);
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
    const known = ["--gitlab", "--project", "--sample", "--no-sample", "--no-git"];
    const unknown = rest.filter((a) => a.startsWith("--") && !known.includes(a));
    if (unknown.length) throw new CliError(`知らないオプションです: ${unknown.join(" ")}\n\n${HELP}`);
    if (rest.includes("--sample") && rest.includes("--no-sample")) throw new CliError("--sample と --no-sample はどちらか 1 つにしてください");
    init({ pkgDir: PKG_DIR, version: VERSION, dir, gitlab, git: !rest.includes("--no-git"), sample: rest.includes("--sample"), log });
    return 0;
  }
  if (cmd === "update") {
    assertKnown(rest, ["--force", "--dry-run", "--overwrite", "--keep-local", "--no-commit", "--summary"], ["--log"]);
    const dir = resolve(positional(rest, ["--log"])[0] ?? ".");
    out = createOutput({ file: opt(rest, "log") && resolve(opt(rest, "log")), summary: rest.includes("--summary") });
    update({ pkgDir: PKG_DIR, version: VERSION, dir, ...updateOptions(rest), dryRun: rest.includes("--dry-run"), log: out.log, detail: out.detail, exclude: out.file ? [out.file] : [] });
    if (out.file) out.log(`出力を ${out.file} に書きました（UTF-8）`);
    else if (rest.includes("--summary")) out.log("（ファイルの一覧・差分・変更履歴は --log <ファイル> で書き出せます）");
    return 0;
  }
  if (cmd === "upgrade") {
    assertKnown(rest, ["--force", "--overwrite", "--keep-local", "--no-commit", "--test"], ["--log"]);
    const dir = resolve(positional(rest, ["--log"])[0] ?? ".");
    if (!existsSync(join(dir, ".yojitsu-navi.json"))) throw new CliError(`${dir} に .yojitsu-navi.json がありません。yojitsu-navi init で作ったプロジェクトのフォルダで実行してください`);
    // 画面には要約、ログのファイルには全部（update のファイルの一覧・変更履歴、npm の出力）
    out = createOutput({ file: opt(rest, "log") ? resolve(opt(rest, "log")) : join(dir, LOG_DIR, `upgrade-${backupStamp()}.log`), summary: true });
    out.log(`予実ナビ ${VERSION} への版上げ（${dir}）`);
    const r = await upgrade({ pkgDir: PKG_DIR, version: VERSION, dir, out, update: updateOptions(rest), test: rest.includes("--test") || undefined });
    return r.code;
  }
  if (cmd === "reset-data") {
    assertKnown(rest, ["--dry-run"], ["--log"]);
    out = createOutput({ file: opt(rest, "log") && resolve(opt(rest, "log")) });
    resetData({ pkgDir: PKG_DIR, dir: resolve(positional(rest, ["--log"])[0] ?? "."), dryRun: rest.includes("--dry-run"), log: out.log });
    return 0;
  }
  if (cmd === "check") {
    assertKnown(rest, [], ["--log"]);
    out = createOutput({ file: opt(rest, "log") && resolve(opt(rest, "log")) });
    check({ dir: resolve(positional(rest, ["--log"])[0] ?? "."), log: out.log });
    return 0;
  }
  if (cmd === "migrate-ci") {
    assertKnown(rest, ["--dry-run", "--force"], ["--log"]);
    out = createOutput({ file: opt(rest, "log") && resolve(opt(rest, "log")) });
    migrateCiCommand({ pkgDir: PKG_DIR, dir: resolve(positional(rest, ["--log"])[0] ?? "."), dryRun: rest.includes("--dry-run"), force: rest.includes("--force"), log: out.log });
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
    out.error(e instanceof CliError ? e.message : String(e?.stack ?? e));
    if (out.file) out.error(`（出力は ${out.file} にもあります。UTF-8）`);
    process.exit(e instanceof CliError ? 2 : 1);
  },
);
