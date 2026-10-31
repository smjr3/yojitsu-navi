/**
 * CI の依存の取得（.gitlab-ci.yml の before_script）。Windows・Linux のどちらの Runner でも動く
 * - 依存込みのパッケージで作ったプロジェクト（vendor/npm-cache がある）は、同梱のキャッシュだけで入れる
 *   （npm ci --offline --cache vendor/npm-cache。外に出ない。SPEC §44）
 * - それ以外は npm ci。社内ミラーは CI/CD 変数 NPM_CONFIG_REGISTRY で切り替わる（npm が自動で読む）
 */
import { existsSync } from "node:fs";
import { npm } from "../lib/npm.mjs";

if (process.env.NPM_CONFIG_REGISTRY) console.log(`npm registry: ${process.env.NPM_CONFIG_REGISTRY}`);
const args = existsSync("vendor/npm-cache")
  ? ["ci", "--offline", "--cache", "vendor/npm-cache", "--no-audit", "--no-fund"]
  : ["ci", "--prefer-offline", "--no-audit", "--no-fund"];
try {
  npm(args, { stdio: "inherit" });
} catch {
  process.exit(1);
}
