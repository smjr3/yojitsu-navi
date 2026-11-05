// npm パッケージ yojitsu-navi を packages/app/ に組み立てる（SPEC §44・§84）。
// 中身は 2 つ: アプリ一式を作るコマンド（bin・lib・template・sample・dist/gitlab-setup.mjs）と、
// import して使う計算コア（dist/core・dist/i18n。ソースの正は src/core）。パッケージは 1 つだけ。
//
//   npm run app:build                         … packages/app/template・dist（計算コアを含む）を作り直す
//   npm run app:pack                          … 上に加えて packages/app/yojitsu-navi-<版>.tgz を作る
//   npm run app:pack -- --with-deps           … 依存（npm のキャッシュ）も入れた yojitsu-navi-<版>-with-deps.tgz を作る
//                                               （社内に npm のミラーが無いとき。Linux x64 の CI と Windows x64 の PC で使える）
//
// template/ は git が管理しているファイルのうち、利用環境に配るもの（開発元だけで使うファイル・テストを除く。SPEC §93、
// packages/app/lib/template-files.mjs）。data/ はサンプルを除いた空のもの（見出しの行だけ）で、サンプルは sample/data/ に分ける
// （init --sample のときだけ入れる）。dist/ は依存なしで動く
// gitlab-setup（scripts/gitlab-setup.ts を JS にしたもの）。パッケージ自体は依存を持たないので、
// 社内で npx・npm install するときに外へ接続しない。
// 社内 GitLab の接続先・個人や会社の情報はパッケージに入れない（展開先で init --gitlab … で入れる）。
// 開発元のリポジトリ専用。init で作ったプロジェクト（利用環境）や、.npmrc・証明書などがあるときは止める（scripts/lib/package-guard.mjs、SPEC §84.1）。
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { npm } from "./lib/npm.mjs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { isAllowedImage, isImage } from "./lib/image-detect.mjs";
import { checkCiFiles, describeCiProblems } from "./lib/ci-files.mjs";
import { isShipped, starterData, testClosure, userPackageJson, userPackageLock } from "../packages/app/lib/template-files.mjs";
import { packageGuardProblems } from "./lib/package-guard.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG = join(ROOT, "packages/app");
const TEMPLATE = join(PKG, "template");
const DIST = join(PKG, "dist");
const DEPS = join(PKG, "deps");
const SAMPLE = join(PKG, "sample");
/** scripts/lib から packages/app/lib に写すもの（yojitsu-navi コマンドが使う） */
const SHARED_LIB = ["ci-files.mjs", "ci-local.mjs"];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);

/** git が管理するファイル（まだコミットしていない新しいファイルも含む。消したファイルは除く）のうち、利用環境に配るもの */
function templateFiles(root) {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf-8" });
  const tests = testClosure(root);
  return [...new Set(out.split("\0").filter(Boolean))]
    .filter((f) => isShipped(f, tests))
    .filter((f) => existsSync(join(root, f)))
    .sort();
}

const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const appPkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf-8"));
if (rootPkg.version !== appPkg.version) {
  console.error(`packages/app/package.json の version（${appPkg.version}）をルートの package.json（${rootPkg.version}）に合わせてください`);
  process.exit(1);
}

// 0. 利用環境で動かしていないか・社内の設定ファイルが紛れていないか（何か作る前に止める）
const guardProblems = packageGuardProblems(ROOT, templateFiles(ROOT));
if (guardProblems.length) {
  console.error(`パッケージを作りません。\n${guardProblems.map((p) => `- ${p}`).join("\n")}`);
  process.exit(1);
}

// 1. template/: 開発元のファイルを写す。.gitignore は npm pack が別扱いにするので _gitignore にしておく（init で戻す）
//    data/ はサンプルを除いたもの（見出しの行だけ）を template に、サンプルそのものを sample/ に置く。package.json は開発元だけの scripts を外す。
//    package.json・package-lock.json の名前は yojitsu-navi-site にする（コマンドと同じ名前だとプロジェクトの中で npx yojitsu-navi が動かない）
rmSync(TEMPLATE, { recursive: true, force: true });
rmSync(SAMPLE, { recursive: true, force: true });
const put = (to, body) => {
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, body);
};
for (const f of templateFiles(ROOT)) {
  const to = join(TEMPLATE, f.replace(/(^|\/)\.gitignore$/, "$1_gitignore"));
  const buf = readFileSync(join(ROOT, f));
  if (f.startsWith("data/")) {
    put(join(SAMPLE, f), buf);
    const starter = starterData(f, buf);
    if (starter) put(to, starter);
  } else if (f === "package.json") put(to, userPackageJson(buf.toString("utf-8")));
  else if (f === "package-lock.json") put(to, userPackageLock(buf.toString("utf-8")));
  else put(to, buf);
}

// lib/: CI の確かめ・移し替え（scripts/lib/ のもの）を写す。プロジェクトの npm run ci:check と yojitsu-navi コマンドで同じものを使う（git には入れない。.gitignore）
for (const f of SHARED_LIB) cpSync(join(ROOT, "scripts/lib", f), join(PKG, "lib", f));

// CI 定義（.gitlab-ci.yml）が使うファイル（npm run の中身・読み込み先まで）が template に揃っていなければ止める（SPEC §85）
const ciProblems = describeCiProblems(checkCiFiles(TEMPLATE, { git: false }));
if (ciProblems) {
  console.error(`${ciProblems}\n（packages/app/template。init で作るプロジェクトの CI が失敗します）`);
  process.exit(1);
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
  // 画像を同梱しない（リポジトリにも置かない。tests/unit/docs-links.test.ts）。ファビコン（IMAGE_ALLOWLIST）だけ例外。
  // 依存（deps/）は外部の npm パッケージなので見ない
  const images = packed.files.map((f) => f.path).filter((f) => !f.startsWith("deps/") && !isAllowedImage(f) && isImage(f, join(PKG, f)));
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
