/**
 * publish-core ジョブ: 計算コアを @yojitsu-navi/core としてこのプロジェクトの Package Registry に公開する（SPEC §43）。
 * Windows・Linux のどちらの Runner でも動く。認証は CI_JOB_TOKEN（追加の変数は要らない）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { npm } from "../lib/npm.mjs";

const { CI_COMMIT_TAG: tag, CI_API_V4_URL: api, CI_PROJECT_ID: id, CI_JOB_TOKEN: token } = process.env;
const version = JSON.parse(readFileSync(join("packages", "core", "package.json"), "utf-8")).version;
if (tag !== `core-v${version}`) {
  console.error(`タグ ${tag ?? "（なし）"} と packages/core/package.json の version ${version} が一致しません`);
  process.exit(1);
}
try {
  // 公開する前に、計算のテストと配布物の検査を通す
  npm(["run", "typecheck"], { stdio: "inherit" });
  npm(["exec", "--", "vitest", "run"], { stdio: "inherit" });
  npm(["run", "core:build"], { stdio: "inherit" });
  const registry = `${api}/projects/${id}/packages/npm/`;
  writeFileSync(join("packages", "core", ".npmrc"), `@yojitsu-navi:registry=${registry}\n${registry.replace(/^https?:/, "")}:_authToken=${token}\n`);
  npm(["publish"], { cwd: join("packages", "core"), stdio: "inherit" });
} catch {
  process.exit(1);
}
