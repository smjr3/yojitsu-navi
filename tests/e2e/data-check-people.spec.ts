/**
 * データ確認で「誰の作業か」を見る・マスタに無い人に気づく（SPEC §100）
 * 稼働実績の顧客別で、案件の無い顧客に「案件なし」を付ける
 */
import { test, expect, gotoPage, useDarkTheme, tableByCaption, dataRows, headerIndex, col, cellText } from "./helpers/app.js";

const UNMAPPED = "未紐付けの作業実績";

test("未紐付けの作業実績に作業した人が出て、人ごとに切り替えられる", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/data-check");
  const table = tableByCaption(page, UNMAPPED);
  const head = await headerIndex(table);
  const rows = dataRows(table);
  expect(await rows.count()).toBeGreaterThan(0);
  for (let i = 0; i < (await rows.count()); i++) expect(await cellText(rows.nth(i), col(head, "作業した人"))).not.toBe("");
  // 人数の多いまとまりは「ほか n人」。押すと人ごとの時間が開く
  const many = rows.filter({ hasText: "ほか" }).first();
  await many.locator("button", { hasText: "ほか" }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog.getByRole("columnheader", { name: "社員番号" })).toBeVisible();
  expect(await dialog.locator("tbody tr").count()).toBeGreaterThan(1);
  await dialog.getByRole("button", { name: "閉じる" }).first().click();

  // 人ごと: 社員番号・名前・所属・時間・案件数
  const section = page.locator(".yn-grouped-worklogs").first();
  await section.getByRole("button", { name: "人ごと" }).click();
  await expect(section.getByRole("button", { name: "人ごと" })).toHaveAttribute("aria-pressed", "true");
  const byPerson = tableByCaption(page, UNMAPPED);
  const ph = await headerIndex(byPerson);
  expect(ph.has("社員番号") && ph.has("案件数")).toBe(true);
  const first = dataRows(byPerson).first();
  expect(await cellText(first, col(ph, "社員番号"))).toMatch(/^[A-Z]\d+$/);
  // 時間の合計は案件ごとと同じ
  await section.getByRole("button", { name: "案件ごと" }).click();
  await expect(tableByCaption(page, UNMAPPED).getByRole("columnheader", { name: /作業した人/ })).toBeVisible();
});

test("作業した人の列で人を選んで絞り込める", async ({ page }) => {
  await gotoPage(page, "/data-check");
  const table = tableByCaption(page, UNMAPPED);
  const before = await dataRows(table).count();
  await table.locator('thead th[data-key="people"] .yn-filter-btn').click();
  const pop = page.locator(".yn-filter-pop");
  await expect(pop).toBeVisible();
  await pop.getByLabel("（すべて）").uncheck();
  await pop.locator(".yn-filter-item", { hasText: "木村 陽菜" }).first().locator("input").check();
  await page.keyboard.press("Escape");
  const after = await dataRows(table).count();
  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThan(before);
  const head = await headerIndex(table);
  // 先頭の人でなくても、そのまとまりに入っていれば残る
  for (let i = 0; i < after; i++) expect(await cellText(dataRows(table).nth(i), col(head, "顧客名"))).not.toBe("");
});

test("マスタに無いメンバーが KPI と一覧に出る（名前・時間・作業した顧客）", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/data-check");
  const tile = page.locator(".yn-kpi", { hasText: "マスタに無いメンバー" });
  await expect(tile).toContainText("1人");
  await expect(tile).toContainText("集計に含む");
  const table = tableByCaption(page, "不明なメンバー");
  const head = await headerIndex(table);
  const row = dataRows(table).first();
  expect(await cellText(row, col(head, "社員番号"))).toBe("M099");
  expect(await cellText(row, col(head, "名前"))).toBe("臨時 太郎");
  expect(await cellText(row, col(head, "作業した顧客"))).toContain("あかつき商事");
});

test("単価のないメンバーは人ごとに 1 行（月ごとは時間の内訳）", async ({ page }) => {
  await gotoPage(page, "/data-check");
  const table = tableByCaption(page, "単価のないメンバー");
  const head = await headerIndex(table);
  const rows = dataRows(table);
  const ids = [];
  for (let i = 0; i < (await rows.count()); i++) ids.push(await cellText(rows.nth(i), col(head, "社員番号")));
  expect(new Set(ids).size).toBe(ids.length);
  await rows.first().locator("button").first().click();
  await expect(page.locator("dialog[open]").getByRole("columnheader", { name: "月" })).toBeVisible();
});

test("稼働実績の顧客別: 案件の無い顧客に「案件なし」、顧客名の無い作業は「顧客名なし」", async ({ page }) => {
  await gotoPage(page, "/workload?axis=customer");
  const table = page.locator("table").filter({ has: page.getByRole("columnheader", { name: /^顧客/ }) }).first();
  const noContract = table.locator("tbody tr", { hasText: "さくらんぼ交通" });
  await expect(noContract.locator(".yn-chip", { hasText: "案件なし" })).toBeVisible();
  // 案件のある顧客には付けない
  await expect(table.locator("tbody tr", { hasText: "青葉物流" }).locator(".yn-chip", { hasText: "案件なし" })).toHaveCount(0);
  await expect(table.locator("tbody tr", { hasText: "顧客名なし" })).toHaveCount(1);
});

for (const [width, dark] of [[390, true], [768, false], [1024, true], [1280, false]] as const) {
  test(`はみ出さない（${width}px${dark ? "・ダーク" : ""}）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    if (dark) await useDarkTheme(page);
    await gotoPage(page, "/data-check");
    await page.locator(".yn-grouped-worklogs").first().getByRole("button", { name: "人ごと" }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
