/**
 * データ確認「キーワードに合致しない作業」（SPEC §62.3）: 作業名のキーワードで運用保守を抜き出した案件の、合致しなかった作業
 */
import { test, expect, gotoPage, useDarkTheme, tableByCaption, dataRows, headerIndex, col, cellText } from "./helpers/app.js";

const TITLE = "キーワードに合致しない作業";

test("国際送金の案件で【保守】の付かない作業が一覧に出る", async ({ page }) => {
  await gotoPage(page, "/data-check");
  await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();
  const table = tableByCaption(page, TITLE);
  const rows = dataRows(table);
  expect(await rows.count()).toBeGreaterThan(0);
  const head = await headerIndex(table);
  const n = Math.min(await rows.count(), 10);
  for (let i = 0; i < n; i++) {
    expect(await cellText(rows.nth(i), col(head, "案件名（作業実績側）"))).toMatch(/国際送金|外為/);
    expect(await cellText(rows.nth(i), col(head, "作業名"))).not.toContain("【保守】");
    expect(await cellText(rows.nth(i), col(head, "扱い"))).not.toBe("");
  }
  // 「未紐付けの作業実績」の次に置く
  const headings = await page.locator("h2.yn-section-title").allTextContents();
  expect(headings.indexOf(TITLE)).toBe(headings.indexOf("未紐付けの作業実績") + 1);
});

for (const [width, dark] of [[390, false], [768, true], [1280, false], [1280, true]] as const) {
  test(`はみ出さない（${width}px${dark ? "・ダーク" : ""}）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    if (dark) await useDarkTheme(page);
    await gotoPage(page, "/data-check");
    await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
