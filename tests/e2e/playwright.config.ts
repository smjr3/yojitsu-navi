/**
 * E2E（Playwright）設定 — `npm run test:e2e`
 *
 * - globalSetup で YOJITSU_AS_OF を固定して dist/ をビルド（E2E_SKIP_BUILD=1 で省略）
 * - webServer で tests/e2e/serve.mjs が dist/ を配信（cleanUrls 対応）
 * - ブラウザは chromium のみ。PW_CHROMIUM_PATH が設定されていればその実行ファイルを使う
 *   （Playwright の版と同梱ブラウザの版がずれている環境用。CI では `npx playwright install` 済みなので未設定でよい）
 */
import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, PORT, ROOT_DIR } from "./constants.js";

const CI = !!process.env.CI;
const chromiumPath = process.env.PW_CHROMIUM_PATH?.trim();

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  globalSetup: "./global-setup.ts",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  ...(CI ? { workers: 2 } : {}),
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { outputFolder: "./report", open: "never" }]],
  use: {
    baseURL: BASE_URL,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    // 計算ルール等のコードブロックにある Framework 標準のコピーボタンが navigator.clipboard.writeText を呼ぶ。
    // headless の CI ではクリップボード権限が無く未捕捉の例外になるため、権限を付与する
    permissions: ["clipboard-read", "clipboard-write"],
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node tests/e2e/serve.mjs dist ${PORT}`,
    url: `${BASE_URL}/__health`,
    cwd: ROOT_DIR,
    reuseExistingServer: !CI,
    timeout: 30_000,
  },
});
