/**
 * npm パッケージ yojitsu-navi（SPEC §44・§84。パッケージはこれ 1 つ）
 * - npm run app:build が通り、パッケージに入るのは bin・lib・dist・template・README だけ（依存なし）
 * - template はリポジトリのファイル一式（.github/ を除く）。個人・会社の情報と接続先を含まない
 * - init: フォルダ・.gitignore・記録（.yojitsu-navi.json）・接続先（config.json と git remote）・最初のコミット
 * - update: data/ と config.json を変えない・消えたファイルを消す・手で変えたファイルを知らせる・ブランチにコミット
 * - 計算コア（import して使う部分。SPEC §43・§84）: dist/core の公開 API が src/core と同じ・src/core が読むのは src/core と src/i18n だけ・
 *   別プロジェクトから Node で読み込めて NodeNext で型が解決できる
 * （同じパッケージを組み立てるので 1 ファイルにまとめる。ファイルを分けると並行で build-app が走り、template を消し合う）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { npm } from "../../scripts/lib/npm.mjs";
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
let work = "";
let consumer = "";
const logs: string[] = [];
const log = (s: string) => logs.push(s);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

beforeAll(async () => {
  execFileSync(process.execPath, [join(ROOT, "scripts", "build-app.mjs")], { cwd: ROOT, stdio: "pipe" });
  app = await import(pathToFileURL(join(PKG, "lib", "project.mjs")).href);
  work = mkdtempSync(join(tmpdir(), "yojitsu-app-"));
  // コミットする人の設定が無い環境（CI）でも動くように
  Object.assign(process.env, { GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.local", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.local" });
  // 計算コアを import する別プロジェクトを再現する（node_modules/yojitsu-navi → packages/app）
  consumer = join(work, "consumer");
  mkdirSync(join(consumer, "node_modules"), { recursive: true });
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  // Windows は管理者権限なしでシンボリックリンクを作れないので、ジャンクションにする
  symlinkSync(PKG, join(consumer, "node_modules", "yojitsu-navi"), process.platform === "win32" ? "junction" : "dir");
}, 120_000);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

/** 小さな偽のパッケージ（update の確認用）。files は template に置くファイル */
function fakePackage(name: string, version: string, files: Record<string, string>, withDeps = false): string {
  const dir = join(work, name);
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

  it("入るのは bin・lib・dist・template・README・LICENSE だけで、リポジトリ一式が揃っている", () => {
    const out = String(npm(["pack", "--dry-run", "--json"], { cwd: PKG, encoding: "utf-8" }));
    const files: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
    expect(files.filter((f) => !/^(bin|lib|dist|template)\//.test(f) && !["README.md", "LICENSE", "package.json"].includes(f))).toEqual([]);
    for (const f of ["LICENSE", "bin/yojitsu-navi.mjs", "lib/project.mjs", "dist/gitlab-setup.mjs", "template/package.json", "template/package-lock.json", "template/.gitlab-ci.yml", "template/_gitignore", "template/config.json", "template/src/index.md", "template/data/contracts.csv", "template/docs/DEPLOY_GITLAB.md"]) {
      expect(files).toContain(f);
    }
    expect(files.some((f) => f.startsWith("template/.github/") || f.includes("node_modules/") || f.startsWith("deps/"))).toBe(false);
    // git が管理するファイル（.github/ を除く）がすべて入っている
    const tracked = git(ROOT, "ls-files").split("\n").filter((f) => f && !f.startsWith(".github/") && existsSync(join(ROOT, f)));
    const inPkg = new Set(files.filter((f) => f.startsWith("template/")).map((f) => f.slice("template/".length).replace(/(^|\/)_gitignore$/, "$1.gitignore")));
    expect(tracked.filter((f) => !inPkg.has(f))).toEqual([]);
  });

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
  it("一式を写し、接続先・記録・最初のコミットを作る", () => {
    const dir = join(work, "proj");
    logs.length = 0;
    const r = app.init({ pkgDir: PKG, version: pkgJson.version, dir, gitlab: app.normalizeGitlab("https://gl.example.local", "yojitsu-navi/yojitsu-navi"), log });
    expect(r.committed).toBe(true);
    expect(r.withDeps).toBe(false);
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
    expect(logs.join("\n")).toContain("git push -u origin main");
  }, 60_000);

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

  it("data/ と config.json はそのまま、ほかは新しい版にし、消えたファイルを消してブランチにコミットする", () => {
    const dir = project("upd");
    writeFileSync(join(dir, "data", "contracts.csv"), "real data");
    writeFileSync(join(dir, "config.json"), CONFIG().replace('"a": 1', '"a": 9'));
    writeFileSync(join(dir, "src", "keep.js"), "local edit");
    git(dir, "commit", "-qam", "社内の変更");
    logs.length = 0;
    const r = app.update({ pkgDir: fakePackage("upd-v2", "1.1.0", v2), version: "1.1.0", dir, log });
    expect(readFileSync(join(dir, "data", "contracts.csv"), "utf-8")).toBe("real data");
    expect(readFileSync(join(dir, "config.json"), "utf-8")).toContain('"a": 9');
    expect(readFileSync(join(dir, "src", "a.js"), "utf-8")).toBe("a2");
    expect(readFileSync(join(dir, "src", "keep.js"), "utf-8")).toBe("k");
    expect(existsSync(join(dir, "src", "old.js"))).toBe(false);
    expect(existsSync(join(dir, "data", "new.csv"))).toBe(false);
    expect(existsSync(join(dir, "data", "worklogs", "2027-01.csv"))).toBe(false);
    expect(r.overwritten).toEqual(["src/keep.js"]);
    expect(r.removed).toEqual(["src/old.js"]);
    expect(r.added).toEqual(["src/new.js"]);
    expect(r.missing).toEqual(["b"]);
    expect(r.newData).toEqual(["data/new.csv"]);
    expect(r.branch).toBe("update-1.1.0");
    expect(git(dir, "branch", "--show-current")).toBe("update-1.1.0");
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(JSON.parse(readFileSync(join(dir, app.MANIFEST), "utf-8")).version).toBe("1.1.0");
    expect(logs.join("\n")).toContain("git push -u origin update-1.1.0");
    // もう一度実行しても何も変わらない
    git(dir, "switch", "-q", "main");
    git(dir, "merge", "-q", "update-1.1.0");
    logs.length = 0;
    const again = app.update({ pkgDir: join(work, "upd-v2"), version: "1.1.0", dir, log });
    expect([again.changed, again.added, again.removed, again.branch]).toEqual([[], [], [], ""]);
  }, 60_000);

  it("コミットしていない変更・古い版・記録の無いフォルダでは止まる", () => {
    const dir = project("upd-stop");
    writeFileSync(join(dir, "src", "a.js"), "dirty");
    const pkg = fakePackage("upd-stop-v2", "1.1.0", v2);
    expect(() => app.update({ pkgDir: pkg, version: "1.1.0", dir, log })).toThrow(/コミットしていない変更/);
    git(dir, "checkout", "--", ".");
    expect(() => app.update({ pkgDir: pkg, version: "0.9.0", dir, log })).toThrow(/古い版/);
    expect(() => app.update({ pkgDir: pkg, version: "1.1.0", dir: join(work, "nogit"), log })).not.toThrow();
    expect(() => app.update({ pkgDir: pkg, version: "1.1.0", dir: work, log })).toThrow(/\.yojitsu-navi\.json/);
  }, 60_000);

  it("依存込みのプロジェクトは依存込みのパッケージでだけ更新し、キャッシュを入れ替える", () => {
    const dir = project("upd-deps", true);
    expect(readFileSync(join(dir, app.VENDOR_CACHE, "index"), "utf-8")).toBe("1.0.0");
    expect(() => app.update({ pkgDir: fakePackage("upd-deps-v2", "1.1.0", v2), version: "1.1.0", dir, log })).toThrow(/依存込み/);
    const r = app.update({ pkgDir: fakePackage("upd-deps-v2d", "1.1.0", v2, true), version: "1.1.0", dir, log });
    expect(r.vendorUpdated).toBe(true);
    expect(readFileSync(join(dir, app.VENDOR_CACHE, "index"), "utf-8")).toBe("1.1.0");
  }, 60_000);

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
    for (const f of [".gitlab-ci.yml", "package.json", "package-lock.json", "scripts/ci/install.mjs", "scripts/lib/npm.mjs", "scripts/ci/fetch-data.mjs", "scripts/ci/push-data-mr.mjs", "scripts/ci/pages.mjs", "scripts/ci/e2e.mjs", "scripts/validate-data.ts", "scripts/build.ts", "scripts/seed-npm-cache.mjs", "scripts/fetch-worklogs.ts", "scripts/fetch-members.ts", "tests/e2e/playwright.config.ts", "tsconfig.json", "vitest.config.ts", "src/core/index.ts"].filter((f) => f !== "src/core/index.ts" || r.required.includes(f))) {
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
  }, 60_000);
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
    const out = String(npm(["pack", "--dry-run", "--json"], { cwd: PKG, encoding: "utf-8" }));
    const files: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
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

  it("別プロジェクトの TypeScript で型が解決できる（型の誤りは誤りとして出る）", () => {
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
      spawnSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", file], { cwd: consumer, encoding: "utf-8" });
    const good = tsc("ok.ts");
    expect(good.stdout + good.stderr).toBe("");
    expect(good.status).toBe(0);
    const bad = tsc("ng.ts");
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toMatch(/TS2322/);
  }, 60_000);
});
