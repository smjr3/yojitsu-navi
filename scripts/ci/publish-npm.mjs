/**
 * GitHub Actions の publish-npm: タグ core-v<版> / app-v<版> の push で npmjs.com に公開する（SPEC §83）。
 * 認証は GitHub の Secrets の NPM_TOKEN（setup-node が .npmrc に入れる）。版とタグが違えば止める。
 * 手元の PC からは公開しない（scripts/check-publish.mjs が YOJITSU_PUBLIC_PUBLISH=1 のときだけ npmjs.com を通す）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { npm } from "../lib/npm.mjs";

const tag = process.env.GITHUB_REF_NAME ?? "";
const m = /^(core|app)-v(.+)$/.exec(tag);
if (!m) {
  console.error(`タグ ${tag || "（なし）"} は core-v<版> か app-v<版> ではありません`);
  process.exit(1);
}
const [, kind, tagVersion] = m;
const pkgDir = join("packages", kind);
const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")).version;
if (tagVersion !== version) {
  console.error(`タグ ${tag} と ${pkgDir}/package.json の version ${version} が一致しません`);
  process.exit(1);
}
try {
  // 公開する前に型チェック・テストを通し、配布物を作り直す
  npm(["run", "typecheck"], { stdio: "inherit" });
  npm(["exec", "--", "vitest", "run"], { stdio: "inherit" });
  npm(["run", `${kind}:build`], { stdio: "inherit" });
  npm(["publish", "--access", "public"], { cwd: pkgDir, stdio: "inherit", env: { ...process.env, YOJITSU_PUBLIC_PUBLISH: "1" } });
} catch {
  process.exit(1);
}
