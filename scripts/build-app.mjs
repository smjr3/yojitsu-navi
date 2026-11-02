// npm パッケージ yojitsu-navi を packages/app/ に組み立てる（SPEC §44・§84）。
// 中身は 2 つ: アプリ一式を作るコマンド（bin・lib・template・dist/gitlab-setup.mjs）と、
// import して使う計算コア（dist/core・dist/i18n。ソースの正は src/core）。パッケージは 1 つだけ。
//
//   npm run app:build                         … packages/app/template・dist（計算コアを含む）を作り直す
//   npm run app:pack                          … 上に加えて packages/app/yojitsu-navi-<版>.tgz を作る
//   npm run app:pack -- --with-deps           … 依存（npm のキャッシュ）も入れた yojitsu-navi-<版>-with-deps.tgz を作る
//                                               （社内に npm のミラーが無いとき。Linux x64 の CI と Windows x64 の PC で使える）
//
// template/ は git が管理しているファイル（.github/ を除く）をそのまま写したもの。dist/ は依存なしで動く
// gitlab-setup（scripts/gitlab-setup.ts を JS にしたもの）。パッケージ自体は依存を持たないので、
// 社内で npx・npm install するときに外へ接続しない。
// 社内 GitLab の接続先・個人や会社の情報はパッケージに入れない（展開先で init --gitlab … で入れる）。
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { npm } from "./lib/npm.mjs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { isImage } from "./lib/image-detect.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG = join(ROOT, "packages/app");
const TEMPLATE = join(PKG, "template");
const DIST = join(PKG, "dist");
const DEPS = join(PKG, "deps");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);

/** git が管理するファイル（まだコミットしていない新しいファイルも含む。消したファイルと .github/ は除く） */
function templateFiles(root) {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf-8" });
  return [...new Set(out.split("\0").filter(Boolean))]
    .filter((f) => !f.startsWith(".github/") && !f.startsWith("packages/app/template/"))
    .filter((f) => existsSync(join(root, f)))
    .sort();
}

const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const appPkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf-8"));
if (rootPkg.version !== appPkg.version) {
  console.error(`packages/app/package.json の version（${appPkg.version}）をルートの package.json（${rootPkg.version}）に合わせてください`);
  process.exit(1);
}

// 1. template/: 開発元のファイルを写す。.gitignore は npm pack が別扱いにするので _gitignore にしておく（init で戻す）
rmSync(TEMPLATE, { recursive: true, force: true });
for (const f of templateFiles(ROOT)) {
  const to = join(TEMPLATE, f.replace(/(^|\/)\.gitignore$/, "$1_gitignore"));
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join(ROOT, f), to);
}

// 2. dist/gitlab-setup.mjs: 依存なしで動くように TypeScript の型だけを外す
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
// 計算コア: tsc で dist/core（.js と .d.ts）。文言（src/i18n）は計算コアが使うのでそのまま dist/i18n に写す（rules.txt は画面専用なので入れない）
execFileSync(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", join(PKG, "tsconfig.core.json")], { stdio: "inherit" });
mkdirSync(join(DIST, "i18n"), { recursive: true });
for (const f of ["index.js", "index.d.ts", "ja.js"]) cpSync(join(ROOT, "src/i18n", f), join(DIST, "i18n", f));
const ts = createRequire(import.meta.url)(join(ROOT, "node_modules/typescript"));
const src = readFileSync(join(ROOT, "scripts/gitlab-setup.ts"), "utf-8");
const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
writeFileSync(join(DIST, "gitlab-setup.mjs"), `// scripts/gitlab-setup.ts から npm run app:build で作ったもの（直接編集しない）\n${js}`);

// ライセンス（ルートの LICENSE。MIT、SPEC §83）をパッケージにも入れる
cpSync(join(ROOT, "LICENSE"), join(PKG, "LICENSE"));

// 3. deps/npm-cache: --with-deps のときだけ。package-lock.json の依存を npm のキャッシュの形で入れる
rmSync(DEPS, { recursive: true, force: true });
if (flag("with-deps")) {
  const cache = join(DEPS, "npm-cache");
  const work = join(tmpdir(), `yojitsu-app-deps-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  cpSync(join(ROOT, "package.json"), join(work, "package.json"));
  cpSync(join(ROOT, "package-lock.json"), join(work, "package-lock.json"));
  // この PC の分を入れる
  npm(["ci", "--cache", cache, "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: work, stdio: "inherit" });
  // もう一方の OS（Linux x64 / Windows x64。Runner と PC のどちらでも npm ci できるように）で要る、OS ごとのバイナリ（esbuild・rollup）
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf-8"));
  for (const spec of extraPlatformPackages(lock)) {
    npm(["cache", "add", spec, "--cache", cache], { cwd: work, stdio: "inherit" });
  }
  rmSync(join(cache, "_logs"), { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

/** package-lock.json のうち、Linux x64・Windows x64 で使う OS 別のパッケージ（name@version）。この PC の分はすでに入っていて、足しても変わらない */
function extraPlatformPackages(lock) {
  const specs = new Set();
  for (const [key, v] of Object.entries(lock.packages ?? {})) {
    if (!key || !v.os || !v.cpu) continue;
    if ((v.os.includes("win32") || v.os.includes("linux")) && v.cpu.includes("x64")) specs.add(`${key.replace(/^.*node_modules\//, "")}@${v.version}`);
  }
  return [...specs].sort();
}

console.log(`packages/app を作りました（template ${templateFiles(ROOT).length} ファイル${flag("with-deps") ? "・依存込み" : ""}）`);

// 4. pack
if (flag("pack")) {
  const out = npm(["pack", "--json"], { cwd: PKG, encoding: "utf-8" });
  const packed = JSON.parse(out)[0];
  const name = packed.filename;
  // 画像を同梱しない（リポジトリにも置かない。tests/unit/docs-links.test.ts）。依存（deps/）は外部の npm パッケージなので見ない
  const images = packed.files.map((f) => f.path).filter((f) => !f.startsWith("deps/") && isImage(f, join(PKG, f)));
  if (images.length) {
    rmSync(join(PKG, name), { force: true });
    console.error(`パッケージに画像が入っています（入れない）: ${images.join(", ")}`);
    process.exit(1);
  }
  let file = name;
  if (flag("with-deps")) {
    file = name.replace(/\.tgz$/, "-with-deps.tgz");
    renameSync(join(PKG, name), join(PKG, file));
  }
  console.log(`packages/app/${file}`);
}
