/**
 * GitHub Actions の publish-npm: タグ v<版> の push で yojitsu-navi を npmjs.com に公開する（SPEC §83・§84）。
 * 認証は GitHub の Secrets の NPM_TOKEN（setup-node が .npmrc に入れる）。版とタグが違えば止める。
 * 手元の PC からは公開しない（scripts/check-publish.mjs が YOJITSU_PUBLIC_PUBLISH=1 のときだけ npmjs.com を通す）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { npm } from "../lib/npm.mjs";

const tag = process.env.GITHUB_REF_NAME ?? "";
const pkgDir = join("packages", "app");
const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")).version;
if (tag !== `v${version}`) {
  console.error(`タグ ${tag || "（なし）"} と packages/app/package.json の version ${version} が一致しません（タグは v${version}）`);
  process.exit(1);
}
try {
  // 公開する前に型チェック・テストを通し、配布物を作り直す
  npm(["run", "typecheck"], { stdio: "inherit" });
  npm(["exec", "--", "vitest", "run"], { stdio: "inherit" });
  npm(["run", "app:build"], { stdio: "inherit" });
  npm(["publish", "--access", "public"], { cwd: pkgDir, stdio: "inherit", env: { ...process.env, YOJITSU_PUBLIC_PUBLISH: "1" } });
} catch {
  process.exit(1);
}
