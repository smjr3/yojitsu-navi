/**
 * 月次推移の今月の速報（SPEC §125）: 月の途中でも、入っている今月の実績を斜線の棒で出す。
 * 全体・チーム・案件の月次推移、メンバー詳細の計画と実績の時間に出て、凡例にも「実績（速報）」が出る
 */
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";

// Plot は fill を棒のまとまり（g）に付ける
const HATCH = 'svg[role="img"] [fill^="url(#yn-hatch-"]';

for (const dark of [false, true]) {
  test(`月次推移: 今月の実績が斜線の棒で出て、凡例に速報が出る${dark ? "（ダーク）" : ""}`, { tag: dark ? [] : ["@smoke"] }, async ({ page }) => {
    if (dark) await useDarkTheme(page);
    await gotoPage(page, "/");
    await expect(page.locator(`svg[role="img"][aria-label*="月次推移"] [fill^="url(#yn-hatch-"]`).first()).toBeAttached();
    // 斜線の pattern が同じ svg の中にある（url の参照先が切れていない）
    const ok = await page.locator('svg[role="img"][aria-label*="月次推移"]').first().evaluate((svg) => {
      const g = svg.querySelector('[fill^="url(#yn-hatch-"]');
      const id = g?.getAttribute("fill")?.slice(5, -1);
      const rect = g?.tagName === "rect" ? g : g?.querySelector("rect, path");
      return !!id && !!svg.querySelector(`pattern#${CSS.escape(id)}`) && !!rect && rect.getBoundingClientRect().height > 0;
    });
    expect(ok).toBe(true);
    await expect(page.locator(".yn-legend li", { hasText: /^実績(時間)?（速報）$/ }).first()).toBeVisible();
  });
}

test("月次推移の今月の速報: チーム詳細・メンバー詳細にも出る", async ({ page }) => {
  await gotoPage(page, "/team?id=T111");
  await expect(page.locator(HATCH).first()).toBeAttached();
  await gotoPage(page, "/members");
  await page.locator("table tbody tr a").first().click();
  await expect(page.locator(HATCH).first()).toBeAttached();
  await expect(page.locator(".yn-legend li", { hasText: /^実績(時間)?（速報）$/ }).first()).toBeVisible();
});

test("月次推移の今月の速報: 先月だけの期間では出さない", async ({ page }) => {
  await gotoPage(page, "/");
  await expect(page.locator(HATCH).first()).toBeAttached();
  const btn = page.locator('button[data-preset="lastMonth"]');
  await btn.click();
  await expect(page.locator('svg[role="img"][aria-label*="月次推移"]').first()).toBeVisible();
  await expect(page.locator(HATCH)).toHaveCount(0);
  await expect(page.locator(".yn-legend li", { hasText: /^実績(時間)?（速報）$/ })).toHaveCount(0);
});
