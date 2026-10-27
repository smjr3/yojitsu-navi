/**
 * スモーク: 全ページが読み込め、コンソールエラー 0・失敗リクエスト 0・h1 あり・計算基準日が固定値
 */
import { test, expect, gotoPage } from "./helpers/app.js";
import { AS_OF } from "./constants.js";

const PAGES: Array<{ path: string; h1: string; extra?: string }> = [
  { path: "/", h1: "全体サマリー" },
  { path: "/teams", h1: "チーム一覧" },
  { path: "/contracts", h1: "契約一覧" },
  { path: "/contract?id=C008", h1: "C008" },
  { path: "/contract?id=NOPE", h1: "契約詳細", extra: "契約 NOPE は見つかりません" },
  { path: "/rules", h1: "計算ルール" },
  { path: "/data-check", h1: "データ確認" },
];

for (const p of PAGES) {
  test(`${p.path} が読み込める（エラー 0・h1・計算基準日 ${AS_OF}）`, async ({ page }) => {
    await gotoPage(page, p.path);
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator("h1")).toContainText(p.h1);
    const meta = page.locator(".yn-meta").first();
    await expect(meta).toContainText("計算基準日");
    await expect(meta.locator("time").first()).toHaveText(AS_OF);
    if (p.extra) await expect(page.getByText(p.extra)).toBeVisible();
    // 遅延で走る fetch（model.json など）まで待ってからエラーを数える
    await page.waitForLoadState("networkidle");
    // タイトルにサイト名
    await expect(page).toHaveTitle(/予実ナビ/);
  });
}

test("存在しないページは 404 を返す（cleanUrls の配信確認）", async ({ page, errors }) => {
  const res = await page.goto("/no-such-page");
  expect(res?.status()).toBe(404);
  // 404 は意図した結果なので記録から除く（ブラウザは 404 を console.error にも出す）
  errors.failedRequests = errors.failedRequests.filter((x) => !x.includes("/no-such-page"));
  errors.console = errors.console.filter((x) => !x.includes("/no-such-page"));
});
