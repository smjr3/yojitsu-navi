/**
 * 使い方（SPEC §47）
 * - 右端「その他」（⋯）のメニューから開ける。目次で各節へ移動でき、見出しが固定ヘッダーに隠れない
 * - リンクはすべてアプリの中の画面・節（README など外部の文書へ誘導しない）
 */
import { test, expect, gotoPage } from "./helpers/app.js";

test("⋯ のメニューから使い方を開き、目次で節へ移動できる", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/teams");
  await page.getByRole("button", { name: "その他" }).click();
  await page.locator("#yn-more-menu").getByRole("link", { name: "使い方" }).click();
  await expect(page).toHaveURL(/\/guide/);
  await expect(page.getByRole("heading", { level: 1, name: "使い方" })).toBeVisible();
  const toc = page.getByRole("navigation", { name: "目次" });
  const items = toc.getByRole("link");
  expect(await items.count()).toBeGreaterThanOrEqual(5);
  await toc.getByRole("link", { name: /リソース計画/ }).click();
  await expect(page).toHaveURL(/#7$/);
  const h = page.locator(".yn-prose h2#\\37");
  await expect(h).toBeInViewport();
  // 固定ヘッダー（上部タブ・表示条件）の下に見出しが出る
  const headerBottom = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll(".yn-topbar, .yn-filterbar-slot, #observablehq-header")].map((e) => (getComputedStyle(e).position === "sticky" || getComputedStyle(e).position === "fixed" ? e.getBoundingClientRect().bottom : 0))));
  const top = (await h.boundingBox())!.y;
  expect(top).toBeGreaterThanOrEqual(headerBottom - 1);
});

test("使い方のリンクはすべてアプリの中を指し、開ける", async ({ page }) => {
  await gotoPage(page, "/guide");
  const hrefs = await page.locator(".yn-prose a[href]").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  expect(hrefs.length).toBeGreaterThan(10);
  const origin = new URL(page.url()).origin;
  for (const h of hrefs) expect(new URL(h).origin, h).toBe(origin);
  const paths = [...new Set(hrefs.map((h) => new URL(h).pathname))].filter((p) => p !== "/guide");
  for (const p of paths) {
    const res = await page.request.get(p);
    expect(res.status(), p).toBe(200);
  }
  // 節へのリンクの行き先がある
  for (const h of hrefs.filter((x) => new URL(x).pathname === "/guide" && new URL(x).hash)) {
    await expect(page.locator(`[id="${decodeURIComponent(new URL(h).hash.slice(1))}"]`), h).toHaveCount(1);
  }
});

for (const width of [390, 320]) {
  test(`${width}px: 使い方が横にはみ出さない（ライト・ダーク）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    for (const theme of ["light", "dark"]) {
      await page.addInitScript((t) => localStorage.setItem("yn-theme", t), theme);
      await gotoPage(page, "/guide");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), theme).toBe(0);
    }
  });
}
