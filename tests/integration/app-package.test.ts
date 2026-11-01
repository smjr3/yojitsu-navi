/**
 * アプリ全体を社内へ持ち込む npm パッケージ yojitsu-navi（SPEC §44）
 * - npm run app:build が通り、パッケージに入るのは bin・lib・dist・template・README だけ（依存なし）
 * - template はリポジトリのファイル一式（.github/ を除く）。個人・会社の情報と接続先を含まない
 * - init: フォルダ・.gitignore・記録（.yojitsu-navi.json）・接続先（config.json と git remote）・最初のコミット
 * - update: data/ と config.json を変えない・消えたファイルを消す・手で変えたファイルを知らせる・ブランチにコミット
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { npm } from "../../scripts/lib/npm.mjs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(__dirname, "..", "..");
const PKG = join(ROOT, "packages", "app");
const pkgJson = JSON.parse(readFileSync(join(PKG, "package.json"), "utf-8"));
const rootJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
let app: any;
let work = "";
const logs: string[] = [];
const log = (s: string) => logs.push(s);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

beforeAll(async () => {
  execFileSync(process.execPath, [join(ROOT, "scripts", "build-app.mjs")], { cwd: ROOT, stdio: "pipe" });
  app = await import(pathToFileURL(join(PKG, "lib", "project.mjs")).href);
  work = mkdtempSync(join(tmpdir(), "yojitsu-app-"));
  // コミットする人の設定が無い環境（CI）でも動くように
  Object.assign(process.env, { GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.local", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.local" });
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

  it("入るのは bin・lib・dist・template・README だけで、リポジトリ一式が揃っている", () => {
    const out = String(npm(["pack", "--dry-run", "--json"], { cwd: PKG, encoding: "utf-8" }));
    const files: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
    expect(files.filter((f) => !/^(bin|lib|dist|template)\//.test(f) && f !== "README.md" && f !== "package.json")).toEqual([]);
    for (const f of ["bin/yojitsu-navi.mjs", "lib/project.mjs", "dist/gitlab-setup.mjs", "template/package.json", "template/package-lock.json", "template/.gitlab-ci.yml", "template/_gitignore", "template/config.json", "template/src/index.md", "template/data/contracts.csv", "template/docs/DEPLOY_GITLAB.md"]) {
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
