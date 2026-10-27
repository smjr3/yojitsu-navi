/**
 * 全テストの前に 1 回だけ dist/ をビルドする（計算基準日を固定）。
 * E2E_SKIP_BUILD=1 なら既存の dist/ をそのまま使う（ローカルで繰り返すとき用）。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AS_OF, ROOT_DIR } from "./constants.js";

export default async function globalSetup(): Promise<void> {
  const skip = process.env.E2E_SKIP_BUILD === "1";
  const distIndex = join(ROOT_DIR, "dist", "index.html");
  if (skip && existsSync(distIndex)) {
    console.log(`[e2e] E2E_SKIP_BUILD=1: 既存の dist/ を使います（計算基準日が ${AS_OF} でビルドされている前提）`);
    return;
  }
  if (skip) console.log("[e2e] E2E_SKIP_BUILD=1 ですが dist/index.html が無いのでビルドします");
  console.log(`[e2e] YOJITSU_AS_OF=${AS_OF} npm run build`);
  const started = Date.now();
  execFileSync("npm", ["run", "build", "--silent"], {
    cwd: ROOT_DIR,
    stdio: "inherit",
    env: { ...process.env, YOJITSU_AS_OF: AS_OF },
  });
  console.log(`[e2e] build done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
