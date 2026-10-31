/**
 * GitLab CI の値で接続先を補う（SPEC §39.1）・データ取り込みの MR 反映（§39.4）
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withGitLabEnv } from "../../src/components/gitlab-env.js";
import { resolveMasterEdit } from "../../src/core/gitlab.js";
import { computeFingerprint } from "../../scripts/lib/inputs.js";
import type { MasterEditConfig } from "../../src/core/types.js";

const env = { YOJITSU_GITLAB_API_URL: "https://g.local/api/v4", YOJITSU_GITLAB_PROJECT: "grp/yojitsu-navi" };

describe("withGitLabEnv", () => {
  it("config の接続先が空なら環境変数で埋める（mr のまま保存できる）", () => {
    const me = resolveMasterEdit(withGitLabEnv({ mode: "gitlab", gitlab: { apiBaseUrl: "", projectId: "", targetBranch: "main", commitMode: "mr" } }, env) as MasterEditConfig);
    expect(me.gitlab).toMatchObject({ apiBaseUrl: "https://g.local/api/v4", projectId: "grp/yojitsu-navi", targetBranch: "main", commitMode: "mr" });
  });
  it("config に値があればそちらを優先。masterEdit が無くても埋める", () => {
    expect(withGitLabEnv({ gitlab: { apiBaseUrl: "https://other/api/v4", projectId: " " } }, env)).toEqual({ gitlab: { apiBaseUrl: "https://other/api/v4", projectId: "grp/yojitsu-navi" } });
    expect(withGitLabEnv(undefined, env)).toEqual({ gitlab: { apiBaseUrl: env.YOJITSU_GITLAB_API_URL, projectId: env.YOJITSU_GITLAB_PROJECT } });
  });
  it("環境変数が無い・demo・download なら元のまま", () => {
    const cfg = { mode: "gitlab", gitlab: { apiBaseUrl: "" } };
    expect(withGitLabEnv(cfg, {})).toBe(cfg);
    const demo = { mode: "demo" };
    expect(withGitLabEnv(demo, env)).toBe(demo);
    const dl = { mode: "download", gitlab: {} };
    expect(withGitLabEnv(dl, env)).toBe(dl);
  });
  it("入力の指紋に入る（接続先が変わればローダのキャッシュを捨てる）", () => {
    const dir = mkdtempSync(join(tmpdir(), "yn-fp-"));
    try {
      writeFileSync(join(dir, "config.json"), "{}");
      const a = computeFingerprint(dir, { asOf: "2026-10-01", git: false, env: {} });
      const b = computeFingerprint(dir, { asOf: "2026-10-01", git: false, env });
      expect(a.hash).not.toBe(b.hash);
      expect(computeFingerprint(dir, { asOf: "2026-10-01", git: false, env }).hash).toBe(b.hash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/ci/push-data-mr.mjs（取り込み結果を MR で反映。Windows・Linux の Runner で動く）", () => {
  const SCRIPT = join(process.cwd(), "scripts/ci/push-data-mr.mjs");
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  /** push オプションを受け付ける bare リポジトリ（受け取ったオプションを options.txt に書く）と作業コピー */
  function setup() {
    dir = mkdtempSync(join(tmpdir(), "yn-push-"));
    const remote = join(dir, "remote.git");
    const work = join(dir, "work");
    git(dir, "init", "-q", "--bare", "-b", "main", remote);
    // bare リポジトリの中を cwd にすると Windows の git が「not in a git directory」になるので --git-dir で指定する
    git(dir, `--git-dir=${remote}`, "config", "receive.advertisePushOptions", "true");
    // フックは git 同梱の sh が動かす。Windows のパスの \ を sh が解釈しないよう / にする
    const out = join(dir, "options.txt").replace(/\\/g, "/");
    writeFileSync(join(remote, "hooks", "pre-receive"), `#!/bin/sh\nread line\ni=0\nwhile [ "$i" -lt "\${GIT_PUSH_OPTION_COUNT:-0}" ]; do eval "echo \\$GIT_PUSH_OPTION_$i"; i=$((i+1)); done > "${out}"\n`, { mode: 0o755 });
    git(dir, "clone", "-q", remote, work);
    mkdirSync(join(work, "data/worklogs"), { recursive: true });
    writeFileSync(join(work, "data/worklogs/2026-10.csv"), "a\n");
    writeFileSync(join(work, "other.txt"), "x\n");
    git(work, "add", ".");
    git(work, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "init");
    git(work, "push", "-q", "origin", "HEAD:main");
    return { remote, work };
  }
  const run = (work: string, remote: string) =>
    execFileSync(process.execPath, [SCRIPT, "worklogs", "chore(data): 作業実績を更新", "data/worklogs"], {
      cwd: work,
      encoding: "utf-8",
      env: { ...process.env, DATA_PUSH_REMOTE: remote, CI_COMMIT_BRANCH: "main", GIT_PUSH_TOKEN: "" },
    });

  it("変更が無ければ何も push しない", () => {
    const { remote, work } = setup();
    expect(run(work, remote)).toContain("変更はありません");
    expect(git(remote, "branch", "--list")).toBe("* main");
  });
  it("変更があれば data/worklogs-<日時> に 1 コミットして MR・自動マージを指定。対象外のファイルは入れない", () => {
    const { remote, work } = setup();
    writeFileSync(join(work, "data/worklogs/2026-10.csv"), "a\nb\n");
    writeFileSync(join(work, "other.txt"), "changed\n");
    expect(run(work, remote)).toContain("MR を作成しました");
    const branch = git(remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/data/");
    expect(branch).toMatch(/^data\/worklogs-\d{8}-\d{6}$/);
    expect(git(remote, "rev-parse", "main")).not.toBe(git(remote, "rev-parse", branch));
    expect(git(remote, "show", "--name-only", "--format=%s", branch).split("\n").filter(Boolean)).toEqual(["chore(data): 作業実績を更新", "data/worklogs/2026-10.csv"]);
    expect(readFileSync(join(dir, "options.txt"), "utf-8").trim().split("\n")).toEqual([
      "merge_request.create",
      "merge_request.target=main",
      "merge_request.merge_when_pipeline_succeeds",
      "merge_request.remove_source_branch",
      "merge_request.title=chore(data): 作業実績を更新",
    ]);
  });
  it("GitLab CI ではトークン付きの URL を組み立てる（トークンが無ければ止める）", () => {
    const { work } = setup();
    writeFileSync(join(work, "data/worklogs/2026-10.csv"), "c\n");
    expect(() =>
      execFileSync(process.execPath, [SCRIPT, "worklogs", "m", "data/worklogs"], { cwd: work, stdio: "pipe", env: { ...process.env, DATA_PUSH_REMOTE: "", GIT_PUSH_TOKEN: "", CI_COMMIT_BRANCH: "main" } }),
    ).toThrow(/GIT_PUSH_TOKEN/);
  });
  it("トークン付きの URL（ポート付きもそのまま）・ブランチ名は UTC の日時", async () => {
    const { remoteUrl, dataBranch } = await import("../../scripts/ci/push-data-mr.mjs");
    expect(remoteUrl({ GIT_PUSH_TOKEN: "tk", CI_SERVER_URL: "https://gl.example.local:8443", CI_PROJECT_PATH: "g/p" })).toBe("https://oauth2:tk@gl.example.local:8443/g/p.git");
    expect(dataBranch("members", new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe("data/members-20260102-030405");
  });
});
