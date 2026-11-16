/**
 * CI の依存の取得（.gitlab-ci.yml の before_script）。Windows・Linux のどちらの Runner でも動く
 * - 前のジョブで入れた node_modules が残っていて、package-lock.json・Node の主な版・OS が同じなら入れ直さない（SPEC §126）。
 *   .gitlab-ci.yml の GIT_CLEAN_FLAGS で node_modules/ を消さずに残す（Runner が作業フォルダを使い回すとき。使い回さなければ毎回入れる）。
 *   CI/CD 変数 YOJITSU_FRESH_INSTALL=1 で必ず入れ直す
 * - 依存込みのパッケージで作ったプロジェクト（vendor/npm-cache がある）は、同梱のキャッシュだけで入れる
 *   （npm ci --offline --cache vendor/npm-cache。外に出ない。SPEC §44）
 * - それ以外は npm ci。社内ミラーは CI/CD 変数 NPM_CONFIG_REGISTRY で切り替わる（npm が自動で読む）
 */
import { npm } from "../lib/npm.mjs";
import { clearInstallStamp, installKey, installUpToDate, writeInstallStamp } from "../lib/install-stamp.mjs";

const key = installKey(".");
if (process.env.YOJITSU_FRESH_INSTALL !== "1" && installUpToDate(".", key)) {
  console.log("依存は前に入れたものを使います（package-lock.json・Node の版・OS が同じ。入れ直すときは YOJITSU_FRESH_INSTALL=1）");
  process.exit(0);
}
if (process.env.NPM_CONFIG_REGISTRY) console.log(`npm registry: ${process.env.NPM_CONFIG_REGISTRY}`);
const args = key.vendor
  ? ["ci", "--offline", "--cache", "vendor/npm-cache", "--no-audit", "--no-fund"]
  : ["ci", "--prefer-offline", "--no-audit", "--no-fund"];
clearInstallStamp(".");
try {
  npm(args, { stdio: "inherit" });
} catch {
  process.exit(1);
}
writeInstallStamp(".", key);
