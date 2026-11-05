/**
 * npm パッケージ yojitsu-navi（SPEC §44・§84。パッケージはこれ 1 つ）
 * - npm run app:build が通り、パッケージに入るのは bin・lib・dist・template・README だけ（依存なし）
 * - template はリポジトリのファイル一式（.github/ を除く）。個人・会社の情報と接続先を含まない
 * - init: フォルダ・.gitignore・記録（.yojitsu-navi.json）・接続先（config.json と git remote）・最初のコミット
 * - update: data/ と config.json を変えない・消えたファイルを消す・社内で変えたファイルがあれば止まる（--dry-run・--overwrite・--keep-local）・
 *   上書き前のファイルをバックアップ・ブランチにコミット
 * - 計算コア（import して使う部分。SPEC §43・§84）: dist/core の公開 API が src/core と同じ・src/core が読むのは src/core と src/i18n だけ・
 *   別プロジェクトから Node で読み込めて NodeNext で型が解決できる
 * （同じパッケージを組み立てるので 1 ファイルにまとめる。ファイルを分けると並行で build-app が走り、template を消し合う）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { npmCommand } from "../../scripts/lib/npm.mjs";
import { runAsync, runOk, scaled } from "../test-env.js";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as src from "../../src/core/index.js";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(__dirname, "..", "..");
const PKG = join(ROOT, "packages", "app");
const pkgJson = JSON.parse(readFileSync(join(PKG, "package.json"), "utf-8"));
const rootJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
let app: any;
let tpl: any;
let work = "";
let consumer = "";
const logs: string[] = [];
const log = (s: string) => logs.push(s);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
/** npm pack --dry-run の中身（重いので beforeAll で 1 回だけ作り、2 つのテストで使う） */
let packed: string[] = [];

beforeAll(async () => {
  // 組み立てと npm pack は重い（Windows では 1 分を超えることがある）ので、待つ間も Vitest のワーカーを止めない形で動かす（tests/test-env.ts）
  await runOk(process.execPath, [join(ROOT, "scripts", "build-app.mjs")], { cwd: ROOT });
  const [npmCmd, npmArgs] = npmCommand(["pack", "--dry-run", "--json", "--ignore-scripts"]);
  packed = JSON.parse(await runOk(npmCmd, npmArgs, { cwd: PKG }))[0].files.map((f: { path: string }) => f.path);
  app = await import(pathToFileURL(join(PKG, "lib", "project.mjs")).href);
  tpl = await import(pathToFileURL(join(PKG, "lib", "template-files.mjs")).href);
  work = mkdtempSync(join(tmpdir(), "yojitsu-app-"));
  // コミットする人の設定が無い環境（CI）でも動くように
  Object.assign(process.env, { GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.local", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.local" });
  // 動かす PC の git の設定に左右されないように（Git for Windows の既定 core.autocrlf=true・長いパス・コミットの署名）
  Object.assign(process.env, {
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "core.autocrlf",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.longpaths",
    GIT_CONFIG_VALUE_1: "true",
    GIT_CONFIG_KEY_2: "commit.gpgsign",
    GIT_CONFIG_VALUE_2: "false",
  });
  // 計算コアを import する別プロジェクトを再現する（node_modules/yojitsu-navi → packages/app）
  consumer = join(work, "consumer");
  mkdirSync(join(consumer, "node_modules"), { recursive: true });
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  // Windows は管理者権限なしでシンボリックリンクを作れないので、ジャンクションにする
  symlinkSync(PKG, join(consumer, "node_modules", "yojitsu-navi"), process.platform === "win32" ? "junction" : "dir");
}, scaled(180_000));

afterAll(() => {
  // Windows はウイルス対策の検査などでファイルが一時的に使用中になり、消せないことがあるので待って何度か試す
  if (work) rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}, scaled(60_000));

/** 小さな偽のパッケージ（update の確認用）。files は template に置くファイル */
function fakePackage(name: string, version: string, files: Record<string, string>, withDeps = false, sample: Record<string, string> = {}): string {
  const dir = join(work, name);
  for (const [f, body] of Object.entries(sample)) {
    mkdirSync(join(dir, "sample", f, ".."), { recursive: true });
    writeFileSync(join(dir, "sample", f), body);
  }
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, "template", f, ".."), { recursive: true });
    writeFileSync(join(dir, "template", f), body);
  }
  if (withDeps) {
    mkdirSync(join(dir, "deps", "npm-cache"), { recursive: true });
    writeFileSync(join(dir, "deps", "npm-cache", "index"), version);
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  return dir;
}

const CONFIG = (extra = "") => `{\n  "a": 1,${extra}\n  "masterEdit": { "gitlab": { "apiBaseUrl": "", "projectId": "" } }\n}\n`;

describe("パッケージの中身", () => {
  it("名前・版・依存なし・個人の情報なし", () => {
    expect(pkgJson.name).toBe("yojitsu-navi");
    expect(pkgJson.version).toBe(rootJson.version);
    expect(pkgJson.dependencies ?? {}).toEqual({});
    expect(pkgJson.bin).toEqual({ "yojitsu-navi": "bin/yojitsu-navi.mjs" });
    for (const k of ["author", "repository", "homepage", "bugs", "publishConfig"]) expect(pkgJson[k]).toBeUndefined();
  });

  it("入るのは bin・lib・dist・template・sample・README・LICENSE だけで、利用環境に配るファイルが揃っている", () => {
    const files = packed;
    expect(files.filter((f) => !/^(bin|lib|dist|template|sample)\//.test(f) && !["README.md", "LICENSE", "package.json"].includes(f))).toEqual([]);
    for (const f of ["LICENSE", "bin/yojitsu-navi.mjs", "lib/project.mjs", "dist/gitlab-setup.mjs", "template/package.json", "template/package-lock.json", "template/.gitlab-ci.yml", "template/_gitignore", "template/config.json", "template/src/index.md", "template/data/contracts.csv", "template/docs/DEPLOY_GITLAB.md"]) {
      expect(files).toContain(f);
    }
    expect(files.some((f) => f.startsWith("template/.github/") || f.includes("node_modules/") || f.startsWith("deps/"))).toBe(false);
    // git が管理するファイルのうち利用環境に配るもの（SPEC §93）がすべて入っている。data/ はサンプル（sample/）に、サンプルを除いたものが template に
    const tests = tpl.testClosure(ROOT);
    const tracked = git(ROOT, "ls-files").split("\n").filter((f) => f && existsSync(join(ROOT, f)) && tpl.isShipped(f, tests));
    const inPkg = new Set(files.filter((f) => f.startsWith("template/")).map((f) => f.slice("template/".length).replace(/(^|\/)_gitignore$/, "$1.gitignore")));
    const inSample = new Set(files.filter((f) => f.startsWith("sample/")).map((f) => f.slice("sample/".length)));
    expect(tracked.filter((f) => !f.startsWith("data/") && !inPkg.has(f))).toEqual([]);
    expect(tracked.filter((f) => f.startsWith("data/") && !inSample.has(f))).toEqual([]);
    expect([...inSample].filter((f) => !f.startsWith("data/"))).toEqual([]);
  });

  it("開発元だけで使うファイル・テストは配らない。テストは運用に要るもの（取り込み・データ検証・CI）だけ（SPEC §93）", () => {
    const t = packed.filter((f) => f.startsWith("template/")).map((f) => f.slice("template/".length));
    for (const dev of ["CLAUDE.md", "CONTRIBUTING.md", "scripts/build-app.mjs", "scripts/check-publish.mjs", "scripts/ci/publish-npm.mjs", "tests/integration/app-package.test.ts", "tests/integration/dummy-data.test.ts", "tests/unit/perf.test.ts", "tests/unit/members.perf.test.ts"]) {
      expect(t).not.toContain(dev);
    }
    expect(t.filter((f) => /^(packages|tests\/(e2e|fuzz|property))\//.test(f))).toEqual([]);
    const shippedTests = t.filter((f) => /\.test\.ts$/.test(f)).sort();
    expect(shippedTests).toEqual([...tpl.USER_TESTS].sort());
    expect(t).toContain("tests/test-env.ts");
    expect(t.filter((f) => f.startsWith("tests/fixtures/project/data/")).length).toBeGreaterThan(5);
    // 配るテストは本番の config.json・data/ を読まない（設定はテストの中、データは tests/fixtures/）
    for (const f of shippedTests) {
      const text = readFileSync(join(PKG, "template", f), "utf-8");
      expect(text, f).not.toMatch(/\b(REPO|ROOT)\b\s*,\s*["'](config\.json|data)/);
      expect(text, f).not.toMatch(/["']\.\.\/\.\.\/(config\.json|data\/)/);
    }
    // 開発元だけの npm scripts は外す（中で使うファイルを配らないので）
    const scripts = JSON.parse(readFileSync(join(PKG, "template", "package.json"), "utf-8")).scripts;
    for (const s of tpl.DEV_SCRIPTS) expect(scripts[s]).toBeUndefined();
    expect(scripts.test).toBe(rootJson.scripts.test);
  });

  it("data/ はサンプルを除いた空のもの（見出しの行だけ。祝日・作業種類はそのまま）。サンプルは sample/ にある", () => {
    const tplData = packed.filter((f) => f.startsWith("template/data/"));
    expect(tplData.some((f) => f.startsWith("template/data/worklogs/"))).toBe(false);
    for (const f of tplData) {
      const path = f.slice("template/".length);
      const body = readFileSync(join(PKG, f), "utf-8");
      if (tpl.STARTER_DATA_KEEP.has(path)) expect(body).toBe(readFileSync(join(ROOT, path), "utf-8"));
      else expect(body.trimEnd().split("\n"), path).toHaveLength(1);
    }
    expect(packed).toContain("template/data/masters/members.csv");
    expect(packed.filter((f) => f.startsWith("sample/data/worklogs/")).length).toBeGreaterThan(10);
  });

  it("利用環境に配るテストと型チェックは、配るファイルだけで通る", async () => {
    const tplDir = join(PKG, "template");
    // 依存はリポジトリの node_modules（template の親をたどって見つかる）を使う
    await runOk(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", join(tplDir, "tsconfig.json"), "--noEmit"], { cwd: tplDir });
    const out = await runOk(process.execPath, [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--root", tplDir], { cwd: tplDir, env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST"))), VITEST_MAX_FORKS: "2", NO_COLOR: "1" } });
    // eslint-disable-next-line no-control-regex
    expect(out.replace(/\u001b\[[0-9;]*m/g, "")).toMatch(new RegExp(`Test Files\\s+${tpl.USER_TESTS.length} passed`));
  }, scaled(180_000));

  it("template に個人・会社の情報と接続先が入っていない", () => {
    // 個人名・アカウント名はここにも書けないので、持ち込む人が環境変数 YOJITSU_PRIVATE_WORDS（カンマ区切り）で渡す
    const words = (process.env.YOJITSU_PRIVATE_WORDS ?? "").split(",").map((w) => w.trim()).filter(Boolean);
    // grep は Windows に無いので Node で探す（grep -I と同じく、中身に NUL がある＝バイナリのファイルは見ない）
    const textFiles = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return textFiles(p);
        const buf = readFileSync(p);
        return buf.includes(0) ? [] : [p];
      });
    const tpl = textFiles(join(PKG, "template"));
    const grep = (re: RegExp) => tpl.filter((f) => re.test(readFileSync(f, "utf-8")));
    const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (words.length) expect(grep(new RegExp(words.map(escape).join("|"), "i"))).toEqual([]);
    // 環境変数がなくても見つかる形: 英字の名前＋「さん」（依頼者は「依頼者」と書く。CLAUDE.md）
    expect(grep(/[A-Za-z]さん/)).toEqual([]);
    // GitHub のアカウントへのリンク（npm の依存の寄付先 = package-lock.json と、フォントの著作権表示 = src/fonts/OFL.txt は除く。
    // OFL はライセンス本文と著作権表示をそのまま添えることが条件で、書き換えられない。§46）・メールアドレス（例示用のドメインは除く）
    expect(grep(/github\.com\//).filter((f) => !f.endsWith("package-lock.json") && !f.endsWith(join("src", "fonts", "OFL.txt")))).toEqual([]);
    const mailRoots = ["src", "docs", "scripts", "README.md"].map((d) => join(PKG, "template", d));
    const mails = tpl
      .filter((f) => mailRoots.some((r) => f === r || f.startsWith(r + sep)))
      .flatMap((f) => readFileSync(f, "utf-8").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g) ?? []);
    expect(mails.filter((m) => !/@(example\.(local|com|jp)|users\.noreply)/.test(m) && !/@[0-9]/.test(m))).toEqual([]);
    const g = JSON.parse(readFileSync(join(PKG, "template", "config.json"), "utf-8")).masterEdit.gitlab;
    expect([g.apiBaseUrl, g.projectId]).toEqual(["", ""]);
  });

  it("gitlab-setup は依存なしの JS になっていて、scripts/gitlab-setup.ts と同じ引数を受け付ける", async () => {
    const setup = await import(pathToFileURL(join(PKG, "dist", "gitlab-setup.mjs")).href);
    expect(setup.parseArgs(["--api", "https://gl.example.local", "--project", "g/p"], { GITLAB_TOKEN: "t" })).toEqual({ api: "https://gl.example.local/api/v4", project: "g/p", branch: "main", token: "t", apply: false });
    expect(readFileSync(join(PKG, "dist", "gitlab-setup.mjs"), "utf-8")).not.toMatch(/^import .* from "(?!node:)/m);
  });

  it("コマンドの使い方と版を出せる", () => {
    const r = spawnSync(process.execPath, [join(PKG, "bin", "yojitsu-navi.mjs"), "--version"], { encoding: "utf-8" });
    expect(r.stdout.trim()).toBe(pkgJson.version);
    const h = spawnSync(process.execPath, [join(PKG, "bin", "yojitsu-navi.mjs"), "nope"], { encoding: "utf-8" });
    expect(h.status).toBe(2);
    expect(h.stdout).toContain("yojitsu-navi init");
  });
});

describe("接続先", () => {
  it("URL とプロジェクトを API の URL・remote にする（末尾の / や /api/v4 があってもよい）", () => {
    const want = { webUrl: "https://gl.example.local", apiBaseUrl: "https://gl.example.local/api/v4", projectId: "grp/sub/proj", remoteUrl: "https://gl.example.local/grp/sub/proj.git" };
    expect(app.normalizeGitlab("https://gl.example.local/", "grp/sub/proj")).toEqual(want);
    expect(app.normalizeGitlab("https://gl.example.local/api/v4", "/grp/sub/proj.git")).toEqual(want);
    expect(app.normalizeGitlab("", "")).toBeNull();
    expect(() => app.normalizeGitlab("https://gl.example.local", "")).toThrow(/--project/);
    expect(() => app.normalizeGitlab("", "g/p")).toThrow(/--gitlab/);
    expect(() => app.normalizeGitlab("gl.example.local", "g/p")).toThrow(/http/);
    expect(() => app.normalizeGitlab("https://gl.example.local", "proj")).toThrow(/グループ/);
  });

  it("git remote から読む（認証情報は捨てる。ssh や 1 階層は読まない）", () => {
    expect(app.gitlabFromRemote("https://user:tok@gl.example.local/g/p.git\n")?.apiBaseUrl).toBe("https://gl.example.local/api/v4");
    expect(app.gitlabFromRemote("https://gl.example.local/g/p")?.projectId).toBe("g/p");
    expect(app.gitlabFromRemote("git@gl.example.local:g/p.git")).toBeNull();
    expect(app.gitlabFromRemote("https://gl.example.local/p.git")).toBeNull();
    expect(app.gitlabFromRemote("")).toBeNull();
  });

  it("config.json は接続先の 2 項目だけを書き換え、ほかの書式は変えない", () => {
    const text = readFileSync(join(ROOT, "config.json"), "utf-8");
    const out = app.applyGitlabTarget(text, app.normalizeGitlab("https://gl.example.local", "g/p"));
    const diff = out.split("\n").filter((l: string, i: number) => l !== text.split("\n")[i]);
    expect(diff.map((l: string) => l.trim())).toEqual(['"apiBaseUrl": "https://gl.example.local/api/v4",', '"projectId": "g/p",']);
    expect(() => app.applyGitlabTarget('{"a":1}', app.normalizeGitlab("https://gl.example.local", "g/p"))).toThrow(/apiBaseUrl/);
  });
});

describe("init", () => {
  it("一式を写し、接続先・記録・最初のコミットを作る（コマンドで）", async () => {
    const dir = join(work, "proj");
    // 一式（リポジトリ全体）の写しとコミットは重いので、別プロセスのコマンドで動かして待つ（ワーカーを止めない。tests/test-env.ts）
    const r = await runAsync(process.execPath, [join(PKG, "bin", "yojitsu-navi.mjs"), "init", dir, "--gitlab", "https://gl.example.local", "--project", "yojitsu-navi/yojitsu-navi"], { cwd: work });
    expect(r.status, r.stderr).toBe(0);
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
    expect(existsSync(join(dir, app.VENDOR_CACHE))).toBe(false);
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
    expect(existsSync(join(dir, "_gitignore"))).toBe(false);
    expect(readFileSync(join(dir, "src", "core", "index.ts"), "utf-8")).toBe(readFileSync(join(ROOT, "src", "core", "index.ts"), "utf-8"));
    const g = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")).masterEdit.gitlab;
    expect([g.apiBaseUrl, g.projectId]).toEqual(["https://gl.example.local/api/v4", "yojitsu-navi/yojitsu-navi"]);
    expect(git(dir, "remote", "get-url", "origin")).toBe("https://gl.example.local/yojitsu-navi/yojitsu-navi.git");
    expect(git(dir, "branch", "--show-current")).toBe("main");
    expect(git(dir, "status", "--porcelain")).toBe("");
    const manifest = JSON.parse(readFileSync(join(dir, app.MANIFEST), "utf-8"));
    expect(manifest.version).toBe(pkgJson.version);
    expect(Object.keys(manifest.files)).toContain(".gitignore");
    expect(r.stdout).toContain("git push -u origin main");
    // data/ はサンプルなし（見出しの行だけ・作業実績なし。SPEC §93）
    expect(existsSync(join(dir, "data", "worklogs"))).toBe(false);
    expect(readFileSync(join(dir, "data", "contracts.csv"), "utf-8").trimEnd().split("\n")).toHaveLength(1);
    expect(r.stdout).toContain("data/ は空です");
    expect(app.sampleLeftovers(PKG, dir)).toEqual([]);
  }, scaled(60_000));

  it("--sample でサンプルのデータを入れる（記録にも入る）。知らないオプションは止める", async () => {
    const dir = join(work, "proj-sample");
    const r = await runAsync(process.execPath, [join(PKG, "bin", "yojitsu-navi.mjs"), "init", dir, "--sample", "--no-git"], { cwd: work });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(dir, "data", "worklogs", "2026-10.csv"), "utf-8")).toBe(readFileSync(join(ROOT, "data", "worklogs", "2026-10.csv"), "utf-8"));
    expect(readFileSync(join(dir, "data", "contracts.csv"), "utf-8")).toBe(readFileSync(join(ROOT, "data", "contracts.csv"), "utf-8"));
    expect(Object.keys(JSON.parse(readFileSync(join(dir, app.MANIFEST), "utf-8")).files)).toContain("data/worklogs/2026-10.csv");
    expect(r.stdout).toContain("サンプル");
    const left = app.sampleLeftovers(PKG, dir);
    expect(left).toContain("data/worklogs/2026-10.csv");
    expect(left).not.toContain("data/holidays.csv");
    const bad = await runAsync(process.execPath, [join(PKG, "bin", "yojitsu-navi.mjs"), "init", join(work, "proj-bad"), "--sampel"], { cwd: work });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("--sampel");
    expect(existsSync(join(work, "proj-bad"))).toBe(false);
  }, scaled(60_000));

  it("空でないフォルダには作らない", () => {
    const dir = join(work, "busy");
    mkdirSync(dir);
    writeFileSync(join(dir, "x"), "");
    expect(() => app.init({ pkgDir: PKG, version: "0.0.1", dir, log })).toThrow(/空ではありません/);
  });

  it("接続先なし・git なしでも作れる（あとで config.json に書ける）", () => {
    const dir = join(work, "nogit");
    logs.length = 0;
    const pkg = fakePackage("pkg-nogit", "1.0.0", { "config.json": CONFIG(), "src/a.js": "a" });
    app.init({ pkgDir: pkg, version: "1.0.0", dir, git: false, log });
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(logs.join("\n")).toContain("git remote add origin");
  });
});

describe("update", () => {
  const v1 = { "config.json": CONFIG(), "data/contracts.csv": "sample1", "src/a.js": "a1", "src/old.js": "old", "src/keep.js": "k", "_gitignore": "node_modules/\n" };
  const v2 = { "config.json": CONFIG('\n  "b": { "c": 2 },'), "data/contracts.csv": "sample2", "data/new.csv": "n", "data/worklogs/2027-01.csv": "w", "src/a.js": "a2", "src/new.js": "new", "src/keep.js": "k", "_gitignore": "node_modules/\n" };

  function project(name: string, withDeps = false) {
    const dir = join(work, name);
    app.init({ pkgDir: fakePackage(`${name}-v1`, "1.0.0", v1, withDeps), version: "1.0.0", dir, log });
    return dir;
  }

  it("data/ にサンプルのまま残っているファイルを知らせる（消さない。空の data/ と同じもの＝祝日などは除く。SPEC §93）", () => {
    const dir = project("upd-sample");
    mkdirSync(join(dir, "data", "worklogs"), { recursive: true });
    writeFileSync(join(dir, "data", "worklogs", "2026-01.csv"), "w-sample\n");
    writeFileSync(join(dir, "data", "worklogs", "2026-02.csv"), "本番\n");
    writeFileSync(join(dir, "data", "holidays.csv"), "h\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "社内のデータ");
    const sample = { "data/worklogs/2026-01.csv": "w-sample\r\n", "data/worklogs/2026-02.csv": "w2", "data/holidays.csv": "h\n", "data/contracts.csv": "sample1" };
    const pkg = fakePackage("upd-sample-v2", "1.1.0", { ...v2, "data/holidays.csv": "h\n" }, false, sample);
    logs.length = 0;
    const dry = app.update({ pkgDir: pkg, version: "1.1.0", dir, log, dryRun: true });
    // data/contracts.csv は v1 の init で入った "sample1"（サンプルと同じ）
    expect(dry.sampleLeft).toEqual(["data/contracts.csv", "data/worklogs/2026-01.csv"]);
    expect(logs.join("\n")).toContain("サンプルのまま残っているデータ");
    const r = app.update({ pkgDir: pkg, version: "1.1.0", dir, log });
    expect(r.sampleLeft).toEqual(dry.sampleLeft);
    expect(readFileSync(join(dir, "data", "worklogs", "2026-01.csv"), "utf-8")).toBe("w-sample\n");
  });

  it("data/ と config.json はそのまま、ほかは新しい版にし、消えたファイルを消してブランチにコミットする", () => {
    const dir = project("upd");
    writeFileSync(join(dir, "data", "contracts.csv"), "real data");
    writeFileSync(join(dir, "config.json"), CONFIG().replace('"a": 1', '"a": 9'));
    writeFileSync(join(dir, "src", "local.js"), "社内で足したファイル");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "社内の変更");
    logs.length = 0;
    const r = app.update({ pkgDir: fakePackage("upd-v2", "1.1.0", v2), version: "1.1.0", dir, log, now: new Date(2030, 0, 2, 3, 4, 5) });
    expect(readFileSync(join(dir, "data", "contracts.csv"), "utf-8")).toBe("real data");
    expect(readFileSync(join(dir, "config.json"), "utf-8")).toContain('"a": 9');
    expect(readFileSync(join(dir, "src", "a.js"), "utf-8")).toBe("a2");
    expect(readFileSync(join(dir, "src", "local.js"), "utf-8")).toBe("社内で足したファイル");
    expect(existsSync(join(dir, "src", "old.js"))).toBe(false);
    expect(existsSync(join(dir, "data", "new.csv"))).toBe(false);
    expect(existsSync(join(dir, "data", "worklogs", "2027-01.csv"))).toBe(false);
    expect(r.conflicts).toEqual([]);
    expect(r.changed).toEqual(["src/a.js"]);
    expect(r.removed).toEqual(["src/old.js"]);
    expect(r.added).toEqual(["src/new.js"]);
    expect(r.missing).toEqual(["b"]);
    expect(r.newData).toEqual(["data/new.csv"]);
    // 上書き・削除する前のファイルを日時のフォルダに写し、git には入れない
    expect(r.backup).toBe(".yojitsu-navi-backup/20300102-030405");
    expect(readFileSync(join(dir, r.backup, "src", "a.js"), "utf-8")).toBe("a1");
    expect(readFileSync(join(dir, r.backup, "src", "old.js"), "utf-8")).toBe("old");
    expect(JSON.parse(readFileSync(join(dir, r.backup, app.MANIFEST), "utf-8")).version).toBe("1.0.0");
    expect(existsSync(join(dir, r.backup, "src", "keep.js"))).toBe(false);
    expect(git(dir, "ls-files", ".yojitsu-navi-backup")).toBe("");
    expect(r.branch).toBe("update-1.1.0");
    expect(git(dir, "branch", "--show-current")).toBe("update-1.1.0");
    expect(git(dir, "status", "--porcelain", "--", ".", ":(exclude).yojitsu-navi-backup")).toBe("");
    expect(JSON.parse(readFileSync(join(dir, app.MANIFEST), "utf-8")).version).toBe("1.1.0");
    expect(logs.join("\n")).toContain("git push -u origin update-1.1.0");
    // もう一度実行しても何も変わらない（バックアップのフォルダがあっても「コミットしていない変更」にしない）
    git(dir, "switch", "-q", "main");
    git(dir, "merge", "-q", "update-1.1.0");
    logs.length = 0;
    const again = app.update({ pkgDir: join(work, "upd-v2"), version: "1.1.0", dir, log });
    expect([again.changed, again.added, again.removed, again.branch, again.backup]).toEqual([[], [], [], "", ""]);
  }, scaled(60_000));

  it("上書き・削除するファイルを社内で変えていたら、何も変えずに止まる", () => {
    const dir = project("upd-conflict");
    writeFileSync(join(dir, "src", "keep.js"), "local edit");
    writeFileSync(join(dir, "src", "old.js"), "local old");
    rmSync(join(dir, "src", "a.js"));
    writeFileSync(join(dir, "src", "new.js"), "local new");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "社内の変更");
    const head = git(dir, "rev-parse", "HEAD");
    const manifest = readFileSync(join(dir, app.MANIFEST), "utf-8");
    let err: any;
    try {
      app.update({ pkgDir: fakePackage("upd-conflict-v2", "1.1.0", { ...v2, "src/keep.js": "k2" }), version: "1.1.0", dir, log });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(app.CliError);
    expect(err.message).toMatch(/社内で変えたファイル/);
    expect(err.message).toContain("--dry-run");
    expect(err.conflicts).toEqual([
      { path: "src/keep.js", type: "modified" },
      { path: "src/new.js", type: "created" },
      { path: "src/old.js", type: "removedModified" },
    ]);
    // 何も変えていない
    expect(readFileSync(join(dir, "src", "keep.js"), "utf-8")).toBe("local edit");
    expect(readFileSync(join(dir, app.MANIFEST), "utf-8")).toBe(manifest);
    expect(existsSync(join(dir, ".yojitsu-navi-backup"))).toBe(false);
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "branch", "--show-current")).toBe("main");
    expect(existsSync(join(dir, "src", "a.js"))).toBe(false);
  }, scaled(60_000));

  it("無くなっていたファイル（git の除外設定でコミットされなかったものなど）は止まらずに入れ直す", () => {
    const dir = project("upd-missing");
    rmSync(join(dir, "src", "keep.js"));
    git(dir, "commit", "-qam", "無くなった");
    const r = app.update({ pkgDir: fakePackage("upd-missing-v2", "1.1.0", v2), version: "1.1.0", dir, log });
    expect(r.conflicts).toEqual([]);
    expect(r.added).toContain("src/keep.js");
    expect(readFileSync(join(dir, "src", "keep.js"), "utf-8")).toBe("k");
  }, scaled(60_000));

  it("--dry-run は何も変えずに一覧と差分（社内の今 → 新しい版）を出す", () => {
    const dir = project("upd-dry");
    writeFileSync(join(dir, "src", "keep.js"), "local edit\n");
    git(dir, "commit", "-qam", "社内の変更");
    writeFileSync(join(dir, "src", "dirty.txt"), "コミットしていない変更があっても確かめられる");
    logs.length = 0;
    const r = app.update({ pkgDir: fakePackage("upd-dry-v2", "1.1.0", { ...v2, "src/keep.js": "k2\n" }), version: "1.1.0", dir, log, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.conflicts).toEqual([{ path: "src/keep.js", type: "modified" }]);
    expect(r.changed).toEqual(["src/a.js"]);
    const out = logs.join("\n");
    expect(out).toContain("何も変えていません");
    expect(out).toContain("src/keep.js（社内で変更）");
    expect(out).toContain("--- a/src/keep.js");
    expect(out).toContain("+++ b/src/keep.js");
    expect(out).toContain("-local edit");
    expect(out).toContain("+k2");
    expect(out).not.toContain(tmpdir());
    expect(readFileSync(join(dir, "src", "a.js"), "utf-8")).toBe("a1");
    expect(JSON.parse(readFileSync(join(dir, app.MANIFEST), "utf-8")).version).toBe("1.0.0");
    expect(existsSync(join(dir, ".yojitsu-navi-backup"))).toBe(false);
    expect(git(dir, "branch", "--show-current")).toBe("main");
  }, scaled(60_000));

  it("--overwrite は社内の変更も新しい版にし、前のものをバックアップに残す", () => {
    const dir = project("upd-over");
    writeFileSync(join(dir, "src", "keep.js"), "local edit");
    writeFileSync(join(dir, "src", "old.js"), "local old");
    git(dir, "commit", "-qam", "社内の変更");
    const r = app.update({ pkgDir: fakePackage("upd-over-v2", "1.1.0", v2), version: "1.1.0", dir, log, overwrite: true });
    expect(r.overwritten).toEqual(["src/keep.js", "src/old.js"]);
    expect(readFileSync(join(dir, "src", "keep.js"), "utf-8")).toBe("k");
    expect(existsSync(join(dir, "src", "old.js"))).toBe(false);
    expect(readFileSync(join(dir, r.backup, "src", "keep.js"), "utf-8")).toBe("local edit");
    expect(readFileSync(join(dir, r.backup, "src", "old.js"), "utf-8")).toBe("local old");
    expect(r.branch).toBe("update-1.1.0");
  }, scaled(60_000));

  it("--keep-local は社内の版を残し、次の update でも止まらずに残す（--overwrite で新しい版に戻せる）", () => {
    const dir = project("upd-keep");
    writeFileSync(join(dir, ".gitlab-ci.yml"), "社内:\n  script: [a]\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "社内の変更");
    // 記録に無いファイルを同じ名前で作っていた → 社内で作成
    const r = app.update({ pkgDir: fakePackage("upd-keep-v2", "1.1.0", { ...v2, ".gitlab-ci.yml": "ci2:\n  script: [a]\n" }), version: "1.1.0", dir, log, keepLocal: true });
    expect(r.kept).toEqual([".gitlab-ci.yml"]);
    expect(readFileSync(join(dir, ".gitlab-ci.yml"), "utf-8")).toBe("社内:\n  script: [a]\n");
    expect(JSON.parse(readFileSync(join(dir, app.MANIFEST), "utf-8")).kept).toEqual([".gitlab-ci.yml"]);
    git(dir, "switch", "-q", "main");
    git(dir, "merge", "-q", "update-1.1.0");
    logs.length = 0;
    const r2 = app.update({ pkgDir: fakePackage("upd-keep-v3", "1.2.0", { ...v2, ".gitlab-ci.yml": "ci3:\n  script: [a]\n" }), version: "1.2.0", dir, log });
    expect(r2.kept).toEqual([".gitlab-ci.yml"]);
    expect(readFileSync(join(dir, ".gitlab-ci.yml"), "utf-8")).toBe("社内:\n  script: [a]\n");
    expect(logs.join("\n")).toContain("社内の版のまま残したファイル");
    git(dir, "switch", "-q", "main");
    git(dir, "merge", "-q", "update-1.2.0");
    const r3 = app.update({ pkgDir: join(work, "upd-keep-v3"), version: "1.2.0", dir, log, overwrite: true });
    expect(r3.overwritten).toEqual([".gitlab-ci.yml"]);
    expect(readFileSync(join(dir, ".gitlab-ci.yml"), "utf-8")).toBe("ci3:\n  script: [a]\n");
    expect(JSON.parse(readFileSync(join(dir, app.MANIFEST), "utf-8")).kept).toBeUndefined();
    expect(() => app.update({ pkgDir: join(work, "upd-keep-v3"), version: "1.2.0", dir, log, overwrite: true, keepLocal: true })).toThrow(/どちらか/);
  }, scaled(60_000));

  it("--keep-local で残したファイルは、新しい版と中身が同じになった版を挟んでも、その次の版で上書きしない", () => {
    const dir = project("upd-keep-same");
    writeFileSync(join(dir, "src", "keep.js"), "社内版");
    git(dir, "commit", "-qam", "社内の変更");
    app.update({ pkgDir: fakePackage("upd-keep-same-v2", "1.1.0", { ...v2, "src/keep.js": "k2" }), version: "1.1.0", dir, log, keepLocal: true, git: false });
    const r2 = app.update({ pkgDir: fakePackage("upd-keep-same-v3", "1.2.0", { ...v2, "src/keep.js": "社内版" }), version: "1.2.0", dir, log, git: false });
    expect(r2.kept).toEqual(["src/keep.js"]);
    const r3 = app.update({ pkgDir: fakePackage("upd-keep-same-v4", "1.3.0", { ...v2, "src/keep.js": "k4" }), version: "1.3.0", dir, log, git: false });
    expect(r3.kept).toEqual(["src/keep.js"]);
    expect(readFileSync(join(dir, "src", "keep.js"), "utf-8")).toBe("社内版");
  }, scaled(60_000));

  it.skipIf(process.platform === "win32")("シンボリックリンクは指す先の中身をバックアップし、指す先を書き換えない", () => {
    const dir = project("upd-link");
    const outside = join(work, "upd-link-outside.js");
    writeFileSync(outside, "社内の中身");
    rmSync(join(dir, "src", "keep.js"));
    symlinkSync(outside, join(dir, "src", "keep.js"));
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "社内の変更");
    const r = app.update({ pkgDir: fakePackage("upd-link-v2", "1.1.0", v2), version: "1.1.0", dir, log, overwrite: true });
    expect(r.overwritten).toEqual(["src/keep.js"]);
    expect(readFileSync(outside, "utf-8")).toBe("社内の中身");
    expect(readFileSync(join(dir, r.backup, "src", "keep.js"), "utf-8")).toBe("社内の中身");
    expect(readFileSync(join(dir, "src", "keep.js"), "utf-8")).toBe("k");
  }, scaled(60_000));

  it("改行が CRLF になっただけ（Windows の autocrlf）は社内の変更にしない", () => {
    const dir = project("upd-crlf");
    writeFileSync(join(dir, ".gitignore"), "node_modules/\r\n");
    const r = app.update({ pkgDir: fakePackage("upd-crlf-v2", "1.1.0", v2), version: "1.1.0", dir, log, git: false });
    expect(r.conflicts).toEqual([]);
    expect(r.changed).not.toContain(".gitignore");
  }, scaled(60_000));

  it("コマンド: 社内の変更で止まると終了コード 2、知らないオプションも止まる", () => {
    // 本物のパッケージで作ったプロジェクトの CI 定義を社内で変えた
    const dir = join(work, "upd-cli");
    app.init({ pkgDir: PKG, version: pkgJson.version, dir, log });
    writeFileSync(join(dir, ".gitlab-ci.yml"), "社内で変えた");
    git(dir, "commit", "-qam", "社内の変更");
    const bin = join(PKG, "bin", "yojitsu-navi.mjs");
    const r = spawnSync(process.execPath, [bin, "update", dir], { encoding: "utf-8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(".gitlab-ci.yml（社内で変更）");
    const d = spawnSync(process.execPath, [bin, "update", dir, "--dry-run"], { encoding: "utf-8" });
    expect(d.status).toBe(0);
    expect(d.stdout).toContain("何も変えていません");
    const u = spawnSync(process.execPath, [bin, "update", dir, "--dryrun"], { encoding: "utf-8" });
    expect(u.status).toBe(2);
    expect(u.stderr).toContain("知らないオプション");
    expect(d.stdout).toContain("-社内で変えた");
    expect(readFileSync(join(dir, ".gitlab-ci.yml"), "utf-8")).toBe("社内で変えた");
    // CI 定義で止まったときは、社内の設定の置き場を案内する（SPEC §91.1）
    expect(r.stderr).toContain(".gitlab-ci.local.yml");
  }, scaled(60_000));

  it("社内の CI・npm の設定（.gitlab-ci.local.yml・.npmrc）は上書き・削除せず、.gitlab-ci.local.yml が無ければひな形を足す（SPEC §91.1）", () => {
    // 前の版（.gitlab-ci.local.yml が無い）で作ったプロジェクトに、社内で .npmrc と証明書を足した
    const dir = project("upd-local");
    writeFileSync(join(dir, ".npmrc"), "registry=https://npm.example.local/\n");
    mkdirSync(join(dir, "certs"));
    writeFileSync(join(dir, "certs", "ca.pem"), "pem");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "社内の設定");
    const local = "# ひな形\n.yojitsu-navi-local: {}\n";
    const v2l = { ...v2, ".gitlab-ci.local.yml": local, ".npmrc": "registry=https://registry.npmjs.org/\n" };
    const r = app.update({ pkgDir: fakePackage("upd-local-v2", "1.1.0", v2l), version: "1.1.0", dir, log });
    expect(r.conflicts).toEqual([]);
    expect(r.added).toContain(".gitlab-ci.local.yml");
    expect(readFileSync(join(dir, ".gitlab-ci.local.yml"), "utf-8")).toBe(local);
    expect(readFileSync(join(dir, ".npmrc"), "utf-8")).toBe("registry=https://npm.example.local/\n");
    expect(readFileSync(join(dir, "certs", "ca.pem"), "utf-8")).toBe("pem");
    expect(git(dir, "ls-files", ".gitlab-ci.local.yml")).toBe(".gitlab-ci.local.yml");
    expect(Object.keys(JSON.parse(readFileSync(join(dir, app.MANIFEST), "utf-8")).files)).not.toContain(".gitlab-ci.local.yml");
    // 社内で書き足した .gitlab-ci.local.yml は、ひな形が変わった版でも、消えた版でも残す（止まらない）
    git(dir, "switch", "-q", "main");
    git(dir, "merge", "-q", "update-1.1.0");
    writeFileSync(join(dir, ".gitlab-ci.local.yml"), "default:\n  tags: [windows]\n");
    git(dir, "commit", "-qam", "ランナーのタグ");
    const r3 = app.update({ pkgDir: fakePackage("upd-local-v3", "1.2.0", { ...v2l, ".gitlab-ci.local.yml": "# 新しいひな形\n.yojitsu-navi-local: {}\n" }), version: "1.2.0", dir, log });
    expect([r3.conflicts, r3.removed]).toEqual([[], []]);
    expect(readFileSync(join(dir, ".gitlab-ci.local.yml"), "utf-8")).toBe("default:\n  tags: [windows]\n");
    git(dir, "switch", "-q", "main");
    git(dir, "merge", "-q", "update-1.2.0");
    const { ".gitlab-ci.local.yml": _gone, ...v4 } = v2l;
    const r4 = app.update({ pkgDir: fakePackage("upd-local-v4", "1.3.0", v4), version: "1.3.0", dir, log });
    expect([r4.conflicts, r4.removed]).toEqual([[], []]);
    expect(readFileSync(join(dir, ".gitlab-ci.local.yml"), "utf-8")).toBe("default:\n  tags: [windows]\n");
  }, scaled(60_000));

  it("update は 0.2.0〜0.2.1 のひな形の中身の無い項目（GitLab の config can't be blank）を直し、check はそれを見つける（SPEC §91.3）", () => {
    const placeholder = '.yojitsu-navi-local:\n  variables:\n    YOJITSU_NAVI_LOCAL: "1"';
    const ci = "include:\n  - local: .gitlab-ci.local.yml\nbuild:\n  script:\n    - echo build\n";
    const w = { ...v1, ".gitlab-ci.yml": ci, ".gitlab-ci.local.yml": `# ひな形\n${placeholder}\n` };
    const dir = join(work, "upd-blank");
    app.init({ pkgDir: fakePackage("upd-blank-v1", "1.0.0", w), version: "1.0.0", dir, log });
    // 前の版のひな形のまま、社内でタグを書き足した
    writeFileSync(join(dir, ".gitlab-ci.local.yml"), "# ひな形\n.yojitsu-navi-local: {}\ndefault:\n  tags: [windows]\n");
    git(dir, "commit", "-qam", "ランナーのタグ");
    expect(() => app.check({ dir, log })).toThrow(/jobs:\.yojitsu-navi-local config can't be blank/);
    const r = app.update({ pkgDir: fakePackage("upd-blank-v2", "1.1.0", { ...v2, ".gitlab-ci.yml": ci, ".gitlab-ci.local.yml": w[".gitlab-ci.local.yml"] }), version: "1.1.0", dir, log });
    expect([r.conflicts, r.repairedLocal]).toEqual([[], true]);
    expect(readFileSync(join(dir, ".gitlab-ci.local.yml"), "utf-8")).toBe(`# ひな形\n${placeholder}\ndefault:\n  tags: [windows]\n`);
    expect(readFileSync(join(dir, r.backup, ".gitlab-ci.local.yml"), "utf-8")).toContain(".yojitsu-navi-local: {}");
    expect(() => app.check({ dir, log })).not.toThrow();
  }, scaled(60_000));

  it("migrate-ci は社内で .gitlab-ci.yml に書いたタグ・変数・ジョブを .gitlab-ci.local.yml に移し、次の update は .gitlab-ci.yml を止めずに新しい版にする（SPEC §91.4）", () => {
    const placeholder = '.yojitsu-navi-local:\n  variables:\n    YOJITSU_NAVI_LOCAL: "1"';
    const ci1 = 'include:\n  - local: .gitlab-ci.local.yml\nvariables:\n  A: "1"\ndefault:\n  before_script:\n    - echo a\nbuild:\n  script:\n    - echo build\n';
    const ci2 = `${ci1}pages:\n  script:\n    - echo pages\n`;
    const local = `# ひな形\n${placeholder}\n`;
    const dir = join(work, "mig");
    const pkg1 = fakePackage("mig-v1", "1.0.0", { ...v1, ".gitlab-ci.yml": ci1, ".gitlab-ci.local.yml": local });
    app.init({ pkgDir: pkg1, version: "1.0.0", dir, log });
    // 前の版のひな形（中身の無い項目）のまま、.gitlab-ci.yml にタグ・変数・社内だけのジョブを書いた
    writeFileSync(join(dir, ".gitlab-ci.local.yml"), "# ひな形\n.yojitsu-navi-local: {}\n");
    const custom = ci1.replace("default:\n", "default:\n  tags: [windows]\n").replace('  A: "1"\n', '  A: "1"\n  B: "2"\n').concat("internal:\n  script:\n    - echo internal\n");
    writeFileSync(join(dir, ".gitlab-ci.yml"), custom);
    git(dir, "commit", "-qam", "社内の CI 設定");
    // 新しい版（パッケージが新しくなったあと）: もとの版は git の履歴から探す
    const pkg2 = fakePackage("mig-v2", "1.1.0", { ...v2, ".gitlab-ci.yml": ci2, ".gitlab-ci.local.yml": local });
    expect(() => app.update({ pkgDir: pkg2, version: "1.1.0", dir, log })).toThrow(/migrate-ci/);

    logs.length = 0;
    const dry = app.migrateCiCommand({ pkgDir: pkg2, dir, dryRun: true, log });
    expect([dry.written, dry.base, dry.moved, dry.manual]).toEqual([false, "original", ["変数 B", "default のタグ", "ジョブ internal"], []]);
    expect(readFileSync(join(dir, ".gitlab-ci.local.yml"), "utf-8")).toBe("# ひな形\n.yojitsu-navi-local: {}\n");

    const r = app.migrateCiCommand({ pkgDir: pkg2, dir, log });
    expect(r.written).toBe(true);
    const moved = readFileSync(join(dir, ".gitlab-ci.local.yml"), "utf-8");
    expect(moved).toContain(placeholder);
    expect(moved).toContain("default:\n  tags: [windows]");
    expect(moved).toContain('variables:\n  B: "2"');
    expect(moved).toContain("internal:\n  script:\n    - echo internal");
    expect(readFileSync(join(dir, ".gitlab-ci.yml"), "utf-8")).toBe(custom);
    git(dir, "commit", "-qam", "社内の CI 設定を移す");

    // 移したあとに .gitlab-ci.yml をまた変えたら、印と合わないので止まる
    writeFileSync(join(dir, ".gitlab-ci.yml"), `${custom}# また変えた\n`);
    git(dir, "commit", "-qam", "また変えた");
    expect(() => app.update({ pkgDir: pkg2, version: "1.1.0", dir, log })).toThrow(/社内で変えたファイル/);
    git(dir, "revert", "--no-edit", "HEAD");

    const u = app.update({ pkgDir: pkg2, version: "1.1.0", dir, log });
    expect([u.conflicts, u.migratedCi, u.changed]).toEqual([[], true, expect.arrayContaining([".gitlab-ci.yml"])]);
    expect(readFileSync(join(dir, ".gitlab-ci.yml"), "utf-8")).toBe(ci2);
    expect(readFileSync(join(dir, u.backup, ".gitlab-ci.yml"), "utf-8")).toBe(custom);
    expect(readFileSync(join(dir, ".gitlab-ci.local.yml"), "utf-8")).toBe(moved);
    expect(() => app.check({ dir, log })).not.toThrow();
    // 社内で変えていなければ移すものは無い。古いひな形だけは直す
    expect(app.migrateCiCommand({ pkgDir: pkg2, dir, log }).moved).toEqual([]);
    git(dir, "switch", "-q", "main");
    git(dir, "merge", "-q", "update-1.1.0");
    writeFileSync(join(dir, ".gitlab-ci.local.yml"), "# ひな形\n.yojitsu-navi-local: {}\n");
    git(dir, "commit", "-qam", "古いひな形に戻す");
    expect(app.migrateCiCommand({ pkgDir: pkg2, dir, dryRun: true, log }).written).toBe(false);
    expect(app.migrateCiCommand({ pkgDir: pkg2, dir, log }).written).toBe(true);
    expect(readFileSync(join(dir, ".gitlab-ci.local.yml"), "utf-8")).toBe(`# ひな形\n${placeholder}\n`);
  }, scaled(60_000));

  it("更新後に、今の版から新しい版までの変更履歴の「更新後に行うこと」などを今の設定の値つきで出す（SPEC §91.2）", () => {
    const dir = project("upd-notes");
    writeFileSync(join(dir, "config.json"), CONFIG('\n  "p": { "stopWhen": "empty" },'));
    git(dir, "commit", "-qam", "社内の設定");
    const changelog = [
      "# 変更履歴",
      "## 次の版",
      "### 更新後に行うこと",
      "- まだ出さない",
      "## 1.2.0",
      "### 更新後に行うこと",
      "- `x` を書く",
      "### テスト・CI の前提",
      "- test は既定で動かない",
      "### 変更",
      "- 出さない変更",
      "## 1.1.0（例）",
      "### 新しい設定と推奨値",
      "| 項目 | 書かないとき | 推奨 | 理由・いつ |",
      "|---|---|---|---|",
      "| `p.stopWhen` | `short` | `empty` | ページ番号だけの API |",
      "| `q.r` | なし | 列名 | |",
      "## 1.0.0",
      "### 更新後に行うこと",
      "- 前の版のこと",
      "",
    ].join("\n");
    const pkg = fakePackage("upd-notes-v2", "1.2.0", { ...v2, "CHANGELOG.md": changelog });
    logs.length = 0;
    const dry = app.update({ pkgDir: pkg, version: "1.2.0", dir, log, dryRun: true });
    expect(dry.notes).toEqual([
      "1.1.0:",
      "  [新しい設定と推奨値]",
      '    - p.stopWhen  今: "empty" / 推奨: empty（ページ番号だけの API）',
      "    - q.r  今: 未設定（書かないとき: なし） / 推奨: 列名",
      "1.2.0:",
      "  [更新後に行うこと]",
      "    - x を書く",
      "  [テスト・CI の前提]",
      "    - test は既定で動かない",
    ]);
    expect(logs.join("\n")).toContain("1.0.0 → 1.2.0 で導入先が行うこと");
    logs.length = 0;
    const r = app.update({ pkgDir: pkg, version: "1.2.0", dir, log });
    expect(r.notes).toEqual(dry.notes);
    const out = logs.join("\n");
    expect(out).toContain("x を書く");
    expect(out).not.toMatch(/まだ出さない|出さない変更|前の版のこと/);
    // 同じ版での実行は何も出さない
    expect(app.update({ pkgDir: pkg, version: "1.2.0", dir, log, dryRun: true }).notes).toEqual([]);
  }, scaled(60_000));

  it("ファイルの扱いの区分", () => {
    expect(["config.json", "data/mapping.csv", "data/masters/members.csv", "data/worklogs/x.csv"].map(app.fileKind)).toEqual(["keep", "keep", "keep", "keep"]);
    expect([".gitlab-ci.local.yml", ".npmrc"].map(app.fileKind)).toEqual(["keep", "keep"]);
    expect(["vendor/npm-cache/index", ".yojitsu-navi.json", ".yojitsu-navi-backup/1/a"].map(app.fileKind)).toEqual(["vendor", "tool", "tool"]);
    expect([".gitlab-ci.yml", "package.json", "src/index.md", "scripts/ci/install.mjs", ".gitignore"].map(app.fileKind)).toEqual(["package", "package", "package", "package", "package"]);
    expect(app.backupStamp(new Date(2031, 11, 31, 23, 59, 8))).toBe("20311231-235908");
    expect(readFileSync(join(ROOT, ".gitignore"), "utf-8")).toContain(".yojitsu-navi-backup/");
  });

  it("コミットしていない変更・古い版・記録の無いフォルダでは止まる", () => {
    const dir = project("upd-stop");
    writeFileSync(join(dir, "src", "a.js"), "dirty");
    const pkg = fakePackage("upd-stop-v2", "1.1.0", v2);
    expect(() => app.update({ pkgDir: pkg, version: "1.1.0", dir, log })).toThrow(/コミットしていない変更/);
    git(dir, "checkout", "--", ".");
    expect(() => app.update({ pkgDir: pkg, version: "0.9.0", dir, log })).toThrow(/古い版/);
    expect(() => app.update({ pkgDir: pkg, version: "1.1.0", dir: join(work, "nogit"), log })).not.toThrow();
    expect(() => app.update({ pkgDir: pkg, version: "1.1.0", dir: work, log })).toThrow(/\.yojitsu-navi\.json/);
  }, scaled(60_000));

  it("依存込みのプロジェクトは依存込みのパッケージでだけ更新し、キャッシュを入れ替える", () => {
    const dir = project("upd-deps", true);
    expect(readFileSync(join(dir, app.VENDOR_CACHE, "index"), "utf-8")).toBe("1.0.0");
    expect(() => app.update({ pkgDir: fakePackage("upd-deps-v2", "1.1.0", v2), version: "1.1.0", dir, log })).toThrow(/依存込み/);
    const r = app.update({ pkgDir: fakePackage("upd-deps-v2d", "1.1.0", v2, true), version: "1.1.0", dir, log });
    expect(r.vendorUpdated).toBe(true);
    expect(readFileSync(join(dir, app.VENDOR_CACHE, "index"), "utf-8")).toBe("1.1.0");
  }, scaled(60_000));

  it("版の比較", () => {
    expect(app.compareVersion("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(app.compareVersion("1.0.0", "1.0.0")).toBe(0);
    expect(app.compareVersion("0.9.0", "1.0.0")).toBeLessThan(0);
  });
});

describe("CI 定義", () => {
  it("依存込みのプロジェクトは vendor/npm-cache から外に出ずに入れる", () => {
    const ci = readFileSync(join(ROOT, ".gitlab-ci.yml"), "utf-8");
    expect(ci).toContain("node scripts/ci/install.mjs");
    const install = readFileSync(join(ROOT, "scripts", "ci", "install.mjs"), "utf-8");
    expect(install).toContain('existsSync("vendor/npm-cache")');
    expect(install).toContain('["ci", "--offline", "--cache", "vendor/npm-cache"');
    expect(readFileSync(join(ROOT, ".gitignore"), "utf-8")).toContain("vendor/npm-cache/_logs/");
  });
});

describe("CI 定義とファイルの整合（SPEC §85）", () => {
  let ci: any;
  beforeAll(async () => {
    ci = await import(pathToFileURL(join(PKG, "lib", "ci-files.mjs")).href);
  });

  /** 一時的に PC 全体の git 設定（core.excludesFile）を差し替える。社内の PC で *.mjs などを除外していても CI のファイルが入ることの確認用 */
  function withGlobalIgnore<T>(patterns: string, fn: () => T): T {
    const dir = mkdtempSync(join(work, "gitglobal-"));
    writeFileSync(join(dir, "ignore"), patterns);
    writeFileSync(join(dir, "config"), `[core]\n\texcludesFile = ${join(dir, "ignore").split(sep).join("/")}\n`);
    const prev = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = join(dir, "config");
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prev;
    }
  }

  it("CI 定義のコマンド・npm run の中身・読み込み先を辿って、要るファイルを洗い出す", () => {
    const r = ci.checkCiFiles(ROOT, { git: false });
    for (const f of [".gitlab-ci.yml", "package.json", "package-lock.json", "scripts/ci/install.mjs", "scripts/lib/npm.mjs", "scripts/ci/fetch-data.mjs", "scripts/ci/push-data-mr.mjs", "scripts/ci/pages.mjs", "scripts/validate-data.ts", "scripts/build.ts", "scripts/seed-npm-cache.mjs", "scripts/fetch-worklogs.ts", "scripts/fetch-members.ts", "tests/test-env.ts", "tsconfig.json", "vitest.config.ts", "src/core/index.ts"].filter((f) => f !== "src/core/index.ts" || r.required.includes(f))) {
      expect(r.required).toContain(f);
    }
    expect([r.missing, r.missingScripts]).toEqual([[], []]);
  });

  it("参照の取り出し: script の 1 行・配列の形・npm run の pre/post・無いスクリプト・CI 用スクリプトの中の npm run", () => {
    const dir = mkdtempSync(join(work, "refs-"));
    const put = (f: string, body: string) => {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), body);
    };
    put(".gitlab-ci.yml", ["default:", "  before_script:", "    - node scripts/ci/a.mjs", "job:", "  script:", "    # node scripts/ci/comment.mjs", '    - "npm run build"', "    - npm run nope", "other:", '  script: ["node ./scripts/ci/b.mjs x"]', "  artifacts:", "    paths:", "      - dist/", ""].join("\n"));
    put("package.json", JSON.stringify({ scripts: { prebuild: "node scripts/pre.mjs", build: "tsx scripts/build.ts --out dist", inner: "node scripts/inner.mjs" } }));
    put("package-lock.json", "{}");
    put("scripts/ci/a.mjs", 'import { x } from "../lib/x.mjs";\nnpm(["run", "inner"]);\n');
    put("scripts/lib/x.mjs", 'export * from "./y.js";\n');
    put("scripts/lib/y.ts", "export const y = 1;\n");
    put("scripts/ci/b.mjs", 'await import("./c.mjs");\n');
    put("scripts/pre.mjs", "");
    put("scripts/build.ts", 'import "../src/z.js";\n');
    const r = ci.checkCiFiles(dir, { git: false });
    expect(r.required).toEqual([".gitlab-ci.yml", "package-lock.json", "package.json", "scripts/build.ts", "scripts/ci/a.mjs", "scripts/ci/b.mjs", "scripts/ci/c.mjs", "scripts/inner.mjs", "scripts/lib/x.mjs", "scripts/lib/y.ts", "scripts/pre.mjs", "src/z.js"]);
    expect(r.missing).toEqual(["scripts/ci/c.mjs", "scripts/inner.mjs", "src/z.js"]);
    expect(r.missingScripts).toEqual(["nope"]);
    expect(ci.describeCiProblems(r)).toMatch(/scripts\/ci\/c\.mjs[\s\S]*nope/);
  });

  it("include: の local のファイル（.gitlab-ci.local.yml）も要るファイルにし、その中のコマンドも辿る（SPEC §91.1）", () => {
    const dir = mkdtempSync(join(work, "incl-"));
    const put = (f: string, body: string) => {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), body);
    };
    expect(ci.ciLocalIncludes(["include:", "  - local: .gitlab-ci.local.yml", '  - local: "/ci/extra.yml"', "  - project: g/p", "    file: x.yml", ""].join("\n"))).toEqual([".gitlab-ci.local.yml", "ci/extra.yml"]);
    put(".gitlab-ci.yml", ["include:", "  - local: .gitlab-ci.local.yml", "job:", "  script:", "    - node scripts/ci/a.mjs", ""].join("\n"));
    put("scripts/ci/a.mjs", "");
    const missing = ci.checkCiFiles(dir, { git: false });
    expect(missing.missing).toEqual([".gitlab-ci.local.yml"]);
    put(".gitlab-ci.local.yml", ["local-job:", "  script:", "    - node scripts/local.mjs", ""].join("\n"));
    const r = ci.checkCiFiles(dir, { git: false });
    expect(r.required).toEqual([".gitlab-ci.local.yml", ".gitlab-ci.yml", "scripts/ci/a.mjs", "scripts/local.mjs"]);
    expect(r.missing).toEqual(["scripts/local.mjs"]);
    // include 先がさらに include するファイルも辿る（循環しても止まる）
    put(".gitlab-ci.local.yml", ["include:", "  - local: ci/nested.yml", "  - local: .gitlab-ci.yml", ""].join("\n"));
    put("ci/nested.yml", ["include:", "  - local: .gitlab-ci.local.yml", "  - local: missing-ci.yml", ""].join("\n"));
    const n = ci.checkCiFiles(dir, { git: false });
    expect(n.required).toEqual([".gitlab-ci.local.yml", ".gitlab-ci.yml", "ci/nested.yml", "missing-ci.yml", "scripts/ci/a.mjs"]);
    expect(n.missing).toEqual(["missing-ci.yml"]);
  });

  it("git: 追加しただけ（未コミット）のファイルは未コミットと出す。リポジトリのサブフォルダにあるプロジェクトも正しく見る", () => {
    const repo = mkdtempSync(join(work, "nested-"));
    const dir = join(repo, "src");
    mkdirSync(dir);
    writeFileSync(join(dir, ".gitlab-ci.yml"), "job:\n  script:\n    - node src/run.mjs\n    - node staged.mjs\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "run.mjs"), "");
    git(repo, "init", "-q");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "1");
    writeFileSync(join(dir, "staged.mjs"), "");
    git(repo, "add", "-A");
    const r = ci.checkCiFiles(dir);
    expect([r.missing, r.untracked]).toEqual([[], ["staged.mjs"]]);
  });

  it("init 直後のプロジェクト: CI が使うファイルがすべてあり、最初のコミットに入っている（PC 全体の git 除外設定に当たっても）", () => {
    const dir = join(work, "ci-init");
    withGlobalIgnore("*.mjs\nscripts/ci/\nlib/\n", () => app.init({ pkgDir: PKG, version: pkgJson.version, dir, log }));
    const r = ci.checkCiFiles(dir);
    expect(r.required).toContain("scripts/ci/install.mjs");
    expect(r.required).toContain("scripts/lib/npm.mjs");
    expect([r.missing, r.untracked, r.missingScripts]).toEqual([[], [], []]);
    // パッケージのファイルは全部コミットされている
    const tracked = new Set(git(dir, "ls-files").split("\n"));
    expect(Object.keys(JSON.parse(readFileSync(join(dir, app.MANIFEST), "utf-8")).files).filter((f) => !tracked.has(f))).toEqual([]);
    const cli = spawnSync(process.execPath, [join(PKG, "bin", "yojitsu-navi.mjs"), "check", dir], { encoding: "utf-8" });
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain("揃っています");
  }, 120_000);

  it("update: 前の版で欠けていた・コミットされていなかった CI のファイルを入れ直してコミットする", () => {
    const dir = join(work, "ci-update");
    app.init({ pkgDir: PKG, version: pkgJson.version, dir, log });
    // 前の版を再現: CI が使うファイルが無い／フォルダにはあるがコミットされていない（git の除外設定に当たった）
    git(dir, "rm", "-q", "scripts/ci/install.mjs");
    git(dir, "rm", "-q", "--cached", "scripts/lib/npm.mjs");
    const manifest = JSON.parse(readFileSync(join(dir, app.MANIFEST), "utf-8"));
    writeFileSync(join(dir, app.MANIFEST), JSON.stringify({ ...manifest, version: "0.0.1" }));
    git(dir, "add", app.MANIFEST);
    git(dir, "commit", "-qm", "前の版");
    expect(spawnSync(process.execPath, [join(PKG, "bin", "yojitsu-navi.mjs"), "check", dir], { encoding: "utf-8" }).status).toBe(2);
    const r = withGlobalIgnore("scripts/lib/npm.mjs\n", () => app.update({ pkgDir: PKG, version: pkgJson.version, dir, log }));
    expect(r.added).toContain("scripts/ci/install.mjs");
    expect(r.branch).toBe(`update-${pkgJson.version}`);
    expect(git(dir, "status", "--porcelain")).toBe("");
    const c = ci.checkCiFiles(dir);
    expect([c.missing, c.untracked, c.missingScripts]).toEqual([[], [], []]);
  }, 120_000);

  it("CI が使うファイルが揃わないパッケージでは init・update が止まる（知らせて CI の失敗を防ぐ）", () => {
    const files = { ".gitlab-ci.yml": "job:\n  script:\n    - node scripts/ci/run.mjs\n", "package.json": "{}", "package-lock.json": "{}", "config.json": CONFIG(), "scripts/ci/run.mjs": 'import "../lib/gone.mjs";\n' };
    const pkg = fakePackage("ci-broken", "1.0.0", files);
    expect(() => app.init({ pkgDir: pkg, version: "1.0.0", dir: join(work, "ci-broken-proj"), log })).toThrow(/scripts\/lib\/gone\.mjs/);
    const ok = fakePackage("ci-ok", "1.0.0", { ...files, "scripts/lib/gone.mjs": "" });
    const dir = join(work, "ci-ok-proj");
    app.init({ pkgDir: ok, version: "1.0.0", dir, log });
    expect(() => app.update({ pkgDir: fakePackage("ci-broken2", "1.1.0", files), version: "1.1.0", dir, log })).toThrow(/scripts\/lib\/gone\.mjs/);
  }, scaled(60_000));
});

describe("yojitsu-navi の計算コア", () => {
  it("パッケージは 1 つ（yojitsu-navi）で、import の入口が計算コア", () => {
    expect(pkgJson.name).toBe("yojitsu-navi");
    expect(pkgJson.exports["."]).toEqual({ types: "./dist/core/index.d.ts", import: "./dist/core/index.js" });
    expect(pkgJson.dependencies ?? {}).toEqual({});
  });

  it("src/core が読むのは src/core と src/i18n（パッケージに入るもの）だけ", () => {
    const dir = join(ROOT, "src", "core");
    const bad: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      for (const m of readFileSync(join(dir, f), "utf-8").matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']/gm)) {
        const spec = (m[1] ?? m[2] ?? m[3])!;
        if (spec.startsWith("./") || spec === "../i18n/index.js") continue;
        bad.push(`${f}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("dist の公開 API が src/core/index.ts と同じ", async () => {
    const dist = await import(pathToFileURL(join(PKG, "dist", "core", "index.js")).href);
    expect(Object.keys(dist).sort()).toEqual(Object.keys(src).sort());
  });

  it("パッケージに計算コア（dist/core・dist/i18n）が入り、.ts のソースは入らない", () => {
    const files = packed;
    for (const f of ["dist/core/index.js", "dist/core/index.d.ts", "dist/i18n/ja.js"]) expect(files).toContain(f);
    expect(files.filter((f) => f.startsWith("dist/") && f.endsWith(".ts") && !f.endsWith(".d.ts"))).toEqual([]);
  });

  it("別プロジェクトから Node で読み込める（ルートと個別のモジュール）", () => {
    const script = [
      'import { monthRange, formatYen, buildModel } from "yojitsu-navi";',
      'import { effectiveSaveMode } from "yojitsu-navi/gitlab";',
      'console.log(JSON.stringify([monthRange("2026-03", "2026-05"), formatYen(1234567, "millionYen"), typeof buildModel, typeof effectiveSaveMode]));',
    ].join("\n");
    writeFileSync(join(consumer, "run.mjs"), script);
    const r = spawnSync(process.execPath, ["run.mjs"], { cwd: consumer, encoding: "utf-8" });
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual([["2026-03", "2026-04", "2026-05"], src.formatYen(1234567, "millionYen"), "function", "function"]);
  });

  it("別プロジェクトの TypeScript で型が解決できる（型の誤りは誤りとして出る）", async () => {
    const ok = [
      'import { monthRange, type Contract, type MoneyUnit } from "yojitsu-navi";',
      'import type { MasterEditConfig } from "yojitsu-navi/types";',
      'const m: string[] = monthRange("2026-04", "2026-06");',
      'const u: MoneyUnit = "thousandYen";',
      "const c: Contract | undefined = undefined;",
      "const e: MasterEditConfig | undefined = undefined;",
      "export { m, u, c, e };",
    ].join("\n");
    writeFileSync(join(consumer, "ok.ts"), ok);
    writeFileSync(join(consumer, "ng.ts"), 'import { monthRange } from "yojitsu-navi";\nexport const n: number = monthRange("2026-04", "2026-06");\n');
    const tsc = (file: string) =>
      runAsync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", file], { cwd: consumer });
    const [good, bad] = await Promise.all([tsc("ok.ts"), tsc("ng.ts")]);
    expect(good.stdout + good.stderr).toBe("");
    expect(good.status).toBe(0);
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toMatch(/TS2322/);
  }, scaled(60_000));
});
