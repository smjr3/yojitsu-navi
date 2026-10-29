// 計算コア（src/core）を npm パッケージ @yojitsu-navi/core として packages/core/dist/ に出力する（SPEC §43）
//
//   npm run core:build          … dist を作り直す
//   npm run core:pack           … 上に加えて packages/core/*.tgz を作る（中身の確認・手で渡すとき）
//
// ソースの正は src/core（画面と同じものを配る。packages/core にコピーを置かない）。
// 文言（src/i18n）も計算コアが使うので dist/i18n に同梱する。外部の依存は無い。
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PKG = join(ROOT, "packages/core");
const DIST = join(PKG, "dist");

rmSync(DIST, { recursive: true, force: true });
execFileSync(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", join(PKG, "tsconfig.json")], { stdio: "inherit" });

// tsc は src/i18n/index.d.ts を型に使うので .js を出さない。文言はそのまま写す（rules.txt は画面専用なので入れない）
mkdirSync(join(DIST, "i18n"), { recursive: true });
for (const f of ["index.js", "index.d.ts", "ja.js"]) cpSync(join(ROOT, "src/i18n", f), join(DIST, "i18n", f));

if (process.argv.includes("--pack")) {
  execFileSync("npm", ["pack", "--pack-destination", PKG], { cwd: PKG, stdio: "inherit" });
}
