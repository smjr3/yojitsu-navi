/**
 * データ確認「正式な案件IDの無い案件」「マスタに無い正式な案件」・マスタ編集の「正式な案件ID」（SPEC §98）
 */
import { test, expect, gotoPage, useDarkTheme, tableByCaption, dataRows, headerIndex, col, cellText } from "./helpers/app.js";

const UNLINKED = "正式な案件IDの無い案件";
const UNREGISTERED = "マスタに無い正式な案件";

test("正式な案件IDの無い案件（候補つき）とマスタに無い正式な案件が一覧に出る", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/data-check");
  await expect(page.getByRole("heading", { name: UNLINKED })).toBeVisible();
  const un = tableByCaption(page, UNLINKED);
  // 顧客・案件名が先頭。案件IDは「列」で選べる列（SPEC §106.1）
  expect(await un.locator("thead th").first().getAttribute("data-key")).toBe("customerName");
  await expect(un.locator('thead th[data-key="contractId"]')).toHaveCount(0);
  await page.locator(".yn-table-block", { has: un }).locator(".yn-cols-btn").click();
  await page.locator('.yn-cols-pop .yn-cols-item[data-key="contractId"] input').click();
  await page.keyboard.press("Escape");
  const uh = await headerIndex(un);
  const rows = dataRows(un);
  expect(await rows.count()).toBe(2);
  const candidates = new Map<string, string>();
  for (let i = 0; i < 2; i++) candidates.set(await cellText(rows.nth(i), col(uh, "案件ID")), await cellText(rows.nth(i), col(uh, "候補の正式な案件")));
  // C009 は同じ案件名の正式な案件がある（候補として出すだけ。顧客 / 案件名（正式な案件ID）。§127）。C021 は候補なし
  expect(candidates.get("C009")).toMatch(/^しらかば医療 \/ 電子カルテ連携保守（PJ-\d{4}）$/);
  expect(candidates.get("C021")).toBe("なし");

  const reg = tableByCaption(page, UNREGISTERED);
  const rh = await headerIndex(reg);
  const rr = dataRows(reg);
  expect(await rr.count()).toBe(3);
  const names: string[] = [];
  for (let i = 0; i < 3; i++) names.push(await cellText(rr.nth(i), col(rh, "案件名")));
  expect(names).toContain("監視基盤更改");
  expect(names).toContain("電子カルテ連携保守");
});

test("マスタ編集の案件: 正式な案件IDは修正のダイアログに値だけ出る（一覧の列にはしない）", async ({ page }) => {
  await gotoPage(page, "/masters?view=contracts");
  await expect(page.getByRole("columnheader", { name: /正式な案件ID/ })).toHaveCount(0);
  const first = page.locator("table.yn-me-table tbody tr.yn-me-group").first();
  await first.getByRole("button", { name: "修正" }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  await expect(d.locator("#yn-me-f-project_id")).toHaveCount(0);
  await expect(d.locator(".yn-me-fixed")).toContainText(/PJ-\d{4}/);
});

test("マスタ編集の案件: 正式な案件IDの無い案件は正式な案件を案件名で選んで結び付けられる。選ぶと顧客名・案件名は正式な値で変えられない（SPEC §137）", async ({ page }) => {
  // データ確認の「正式な案件IDの無い案件」の「案件を開く」から
  await gotoPage(page, "/data-check");
  const un = tableByCaption(page, UNLINKED);
  await dataRows(un).filter({ hasText: "電子カルテ連携保守" }).getByRole("link", { name: /マスタ編集で開く/ }).click();
  await expect(page).toHaveURL(/masters\?view=contracts&q=C009/);
  const row = page.locator("table.yn-me-table tbody tr.yn-me-group", { hasText: "電子カルテ連携保守" }).first();
  await row.getByRole("button", { name: "修正" }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  await expect(d.locator("#yn-me-f-contract_id")).toHaveCount(0);
  await expect(d.locator("#yn-me-f-customer_name")).toBeEnabled();
  await expect(d.locator("#yn-me-f-project_name")).toBeEnabled();
  const pick = d.locator("#yn-me-f-project_id");
  await pick.fill("電子カルテ");
  const opt = d.locator("#yn-me-f-project_id-listbox li.yn-combo-opt").first();
  // 案件名で選ぶ。顧客名と ID は補足に出す
  await expect(opt).toContainText("電子カルテ連携保守");
  await expect(opt).toContainText(/しらかば医療 ・ PJ-\d{4}/);
  await opt.click();
  await expect(d.locator("#yn-me-f-customer_name")).toBeDisabled();
  await expect(d.locator("#yn-me-f-customer_name")).toHaveValue("しらかば医療");
  await expect(d.locator("#yn-me-f-project_name")).toHaveValue("電子カルテ連携保守");
  await d.locator('[data-role="submit"]').click();
  // 確認では ID だけでなく案件名も出す
  await expect(d.locator(".yn-me-change-list")).toContainText(/正式な案件ID: .*→ 電子カルテ連携保守（PJ-\d{4}）/);
  await d.locator('[data-role="submit"]').click();
  await expect(d).toHaveCount(0);
  await expect(row).toContainText("変更");
  // 結び付けた後は取り込みで書き換わる行なので、顧客名・案件名は変えられない
  await row.getByRole("button", { name: "修正" }).click();
  await expect(d.locator("#yn-me-f-customer_name")).toHaveCount(0);
  await expect(d.locator(".yn-me-fixed")).toContainText(/PJ-\d{4}/);
});

test("マスタ編集の案件: 正式な案件IDの無い案件は顧客を候補から選んで直せる（新しい顧客名も書ける。SPEC §137）", async ({ page }) => {
  await gotoPage(page, "/masters?view=contracts&q=C021");
  const row = page.locator("table.yn-me-table tbody tr.yn-me-group", { hasText: "開発環境運用" }).first();
  await row.getByRole("button", { name: "修正" }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  const cust = d.locator("#yn-me-f-customer_name");
  await expect(cust).toHaveValue("北斗建設");
  // 候補は案件・顧客・正式な案件にある顧客名
  const opts = await d.locator("#yn-me-f-customer_name-list option").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  expect(opts).toContain("青葉物流");
  await cust.fill("青葉物流");
  await d.locator('[data-role="submit"]').click();
  await expect(d.locator(".yn-me-change-list")).toContainText("北斗建設 → 青葉物流");
  await d.locator('[data-role="submit"]').click();
  await expect(d).toHaveCount(0);
  await expect(page.locator("table.yn-me-table tbody tr.yn-me-group", { hasText: "開発環境運用" }).first()).toContainText("青葉物流");
});

for (const [width, dark] of [[390, false], [768, true], [1024, false], [1280, true]] as const) {
  test(`正式な案件の一覧がはみ出さない（${width}px${dark ? "・ダーク" : ""}）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    if (dark) await useDarkTheme(page);
    await gotoPage(page, "/data-check");
    await expect(page.getByRole("heading", { name: UNREGISTERED })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
