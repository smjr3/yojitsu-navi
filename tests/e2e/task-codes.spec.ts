/**
 * データ確認「未登録の作業コード」「作業名が変わった作業コード」（SPEC §92）
 */
import { test, expect, gotoPage, useDarkTheme, tableByCaption, dataRows, headerIndex, col, cellText } from "./helpers/app.js";

const UNREG = "未登録の作業コード";
const CHANGES = "作業名が変わった作業コード";

test("未登録の作業コードと作業名の変更が一覧に出る（キーワードの一致の変化つき）", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/data-check");
  const unreg = tableByCaption(page, UNREG);
  await expect(page.getByRole("heading", { name: UNREG })).toBeVisible();
  const uh = await headerIndex(unreg);
  const ur = dataRows(unreg);
  expect(await ur.count()).toBe(1);
  expect(await cellText(ur.first(), col(uh, "作業コード"))).toBe("SK-900");
  expect(await cellText(ur.first(), col(uh, "作業名"))).toBe("新規監視項目の設定_保守対応");
  expect(await cellText(ur.first(), col(uh, "状態"))).toBe("未登録");

  const changes = tableByCaption(page, CHANGES);
  const ch = await headerIndex(changes);
  const cr = dataRows(changes);
  expect(await cr.count()).toBe(2);
  const byCode = new Map<string, string>();
  for (let i = 0; i < 2; i++) byCode.set(await cellText(cr.nth(i), col(ch, "作業コード")), await cellText(cr.nth(i), col(ch, "キーワード")));
  expect(byCode.get("SK-004")).toBe("合わなくなった");
  expect(byCode.get("SK-005")).toBe("変わらず");
  // 「キーワードに合致しない作業」の次に置く
  const headings = await page.locator("h2.yn-section-title").allTextContents();
  expect(headings.indexOf(UNREG)).toBe(headings.indexOf("キーワードに合致しない作業") + 1);
  expect(headings.indexOf(CHANGES)).toBe(headings.indexOf(UNREG) + 1);
});

for (const [width, dark] of [[390, false], [768, true], [1024, false], [1280, true]] as const) {
  test(`作業コードの一覧がはみ出さない（${width}px${dark ? "・ダーク" : ""}）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    if (dark) await useDarkTheme(page);
    await gotoPage(page, "/data-check");
    await expect(page.getByRole("heading", { name: CHANGES })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
