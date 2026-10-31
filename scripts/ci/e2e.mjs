/**
 * build ジョブの任意の E2E（CI/CD 変数 PLAYWRIGHT_E2E=1 のときだけ）。Windows・Linux のどちらの Runner でも動く
 */
import { existsSync } from "node:fs";
import { npm } from "../lib/npm.mjs";

if (process.env.PLAYWRIGHT_E2E !== "1" || !existsSync("tests/e2e/playwright.config.ts")) {
  console.log("E2E はスキップ（PLAYWRIGHT_E2E 未設定または tests/e2e/playwright.config.ts が無い）");
  process.exit(0);
}
try {
  // --with-deps（OS のライブラリを入れる）は Linux だけ。Windows では要らない
  npm(["exec", "--", "playwright", "install", ...(process.platform === "linux" ? ["--with-deps"] : []), "chromium"], { stdio: "inherit" });
  npm(["run", "test:e2e"], { stdio: "inherit" });
} catch {
  process.exit(1);
}
