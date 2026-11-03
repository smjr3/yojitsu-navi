/**
 * スモーク: 全ページが読み込め、コンソールエラー 0・失敗リクエスト 0・h1 あり・今日（計算基準日）が固定値
 * このファイルのテストはすべて @smoke（PR 時の縮小版 E2E `npm run test:e2e:smoke` に入る）
 */
import { test, expect, gotoPage } from "./helpers/app.js";
import { AS_OF } from "./constants.js";

const PAGES: Array<{ path: string; h1: string; extra?: string; noMeta?: boolean }> = [
  { path: "/", h1: "全体サマリー" },
  { path: "/teams", h1: "チーム一覧" },
  { path: "/contracts", h1: "案件一覧" },
  { path: "/contract?id=C008", h1: "こもれび出版 / 会員サイト保守" },
  { path: "/contract?id=NOPE", h1: "案件詳細", extra: "案件 NOPE は見つかりません" },
  { path: "/rules", h1: "計算ルール" },
  { path: "/guide", h1: "使い方" },
  { path: "/data-check", h1: "データ確認" },
  { path: "/team?id=S11", h1: "" },
  { path: "/customers", h1: "顧客" },
  { path: "/members", h1: "メンバー" },
  { path: "/member?id=M011", h1: "" },
  { path: "/workload", h1: "稼働実績" },
  { path: "/plan?team=S11", h1: "リソース計画", noMeta: true },
  { path: "/masters", h1: "マスタ編集", noMeta: true },
  { path: "/settings", h1: "設定", noMeta: true },
];

for (const p of PAGES) {
  test(`${p.path} が読み込める（エラー 0・h1${p.noMeta ? "" : `・今日 ${AS_OF}`}）`, { tag: "@smoke" }, async ({ page }) => {
    await gotoPage(page, p.path);
    await expect(page.locator("h1")).toHaveCount(1);
    if (p.h1) await expect(page.locator("h1")).toContainText(p.h1);
    else await expect(page.locator("h1")).not.toBeEmpty();
    // 編集・設定の画面には今日の表示が無い
    if (!p.noMeta) {
      const meta = page.locator(".yn-meta").first();
      await expect(meta).toContainText("今日");
      await expect(meta.locator("time").first()).toHaveText(AS_OF);
    }
    if (p.extra) await expect(page.getByText(p.extra)).toBeVisible();
    // 遅延で走る fetch（model.json など）まで待ってからエラーを数える
    await page.waitForLoadState("networkidle");
    // タイトルにサイト名
    await expect(page).toHaveTitle(/予実ナビ/);
    // ファビコンは埋め込みの SVG（§89。画像ファイルを読まない）
    const icons = page.locator('link[rel="icon"]');
    await expect(icons).toHaveCount(1);
    expect(await icons.getAttribute("href")).toMatch(/^data:image\/svg\+xml,%3Csvg/);
  });
}

test("存在しないページは 404 を返す（cleanUrls の配信確認）", { tag: "@smoke" }, async ({ page, errors }) => {
  const res = await page.goto("/no-such-page");
  expect(res?.status()).toBe(404);
  // 404 は意図した結果なので記録から除く（ブラウザは 404 を console.error にも出す）
  errors.failedRequests = errors.failedRequests.filter((x) => !x.includes("/no-such-page"));
  errors.console = errors.console.filter((x) => !x.includes("/no-such-page"));
});
