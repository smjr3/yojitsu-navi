/**
 * 確認要求からマスタ修正へ（SPEC §101）
 * - データ確認: エラーと確認要求、契約期間外の実績（契約期間・実績の期間・月ごと）、未登録の案件の「案件に登録」、未設定・仮の値
 * - マスタ編集: 値の入った「＋ 新しい案件」、未設定の絞り込み、顧客の既定の担当チーム、仮の単価
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme, tableByCaption, dataRows, headerIndex, col, cell, cellText } from "./helpers/app.js";

/** 追加・修正のダイアログを確定する（過去に影響があると確認の画面が出るので、もう一度押す） */
async function submitDialog(page: Page, dialog: Locator): Promise<void> {
  await dialog.locator("[data-role=submit]").click();
  const confirm = dialog.locator(".yn-me-confirm:not([hidden])");
  await expect.poll(async () => (await page.locator("dialog[open]").count()) === 0 || (await confirm.count()) > 0).toBe(true);
  if ((await page.locator("dialog[open]").count()) > 0) await dialog.locator("[data-role=submit]").click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
}

test("データ確認: 契約期間外の実績は契約期間と実績の期間を並べ、案件を開くとマスタ編集で検索した状態", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/data-check");
  // 未紐付けの一覧からは分ける
  const unmapped = tableByCaption(page, "未紐付けの作業実績");
  await expect(unmapped.locator("tbody", { hasText: "契約期間外" })).toHaveCount(0);
  const table = tableByCaption(page, "契約期間外の実績");
  const head = await headerIndex(table);
  const row = dataRows(table).first();
  expect(await cellText(row, col(head, "契約期間"))).toMatch(/年\d+月〜/);
  expect(await cellText(row, col(head, "実績の期間"))).toMatch(/^\d{4}-\d{2}-\d{2}/);
  const contractId = await cellText(row, col(head, "案件ID"));
  // 時間を押すと月ごと
  await cell(row, col(head, "時間")).locator("button").click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog.getByRole("columnheader", { name: "月" })).toBeVisible();
  await dialog.getByRole("button", { name: "閉じる" }).first().click();
  await row.getByRole("link", { name: /案件をマスタ編集で開く/ }).click();
  await expect(page).toHaveURL(/masters\?view=contracts&q=/);
  await expect(page.locator("#yn-me-q-contracts")).toHaveValue(contractId);
  await expect(page.locator(".yn-me-ledger tbody tr").first()).toContainText(contractId);
});

test("データ確認: 重要度はエラーと確認要求", async ({ page }) => {
  await gotoPage(page, "/data-check");
  const table = tableByCaption(page, "データ検証の結果");
  await expect(table.locator("tbody").getByText("確認要求").first()).toBeVisible();
  await expect(table.locator("tbody").getByText("警告", { exact: true })).toHaveCount(0);
});

test("マスタに無い正式な案件の「案件に登録」: 正式な案件ID・顧客名・案件名と続き番号の入ったダイアログ。追加は下書きで、保存は人が決める", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/data-check");
  const table = tableByCaption(page, "マスタに無い正式な案件");
  const head = await headerIndex(table);
  const row = dataRows(table).first();
  const projectId = await cellText(row, col(head, "正式な案件ID"));
  const customer = await cellText(row, col(head, "顧客名"));
  const project = await cellText(row, col(head, "案件名"));
  await row.getByRole("link", { name: /案件に登録する/ }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog.getByRole("heading", { name: /新しい案件/ })).toBeVisible();
  await expect(dialog.locator("#yn-me-f-customer_name")).toHaveValue(customer);
  await expect(dialog.locator("#yn-me-f-project_name")).toHaveValue(project);
  await expect(dialog.locator("#yn-me-f-project_id")).toHaveValue(projectId);
  await expect(dialog.locator("#yn-me-f-contract_id")).toHaveValue(/^C\d{3}$/);
  // 期間・金額は人が入れる（入れないと追加できない）
  await dialog.locator("[data-role=submit]").click();
  await expect(dialog.locator(".yn-me-form-msg")).toContainText("開始月");
  await dialog.locator("#yn-me-f-start_month").fill("2026-11");
  await dialog.locator("#yn-me-f-end_month").fill("2027-10");
  await dialog.locator("#yn-me-f-total_amount").fill("1200000");
  await submitDialog(page, dialog);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  const added = page.locator(".yn-me-ledger tbody tr.is-added");
  await expect(added).toHaveCount(1);
  await expect(added).toContainText(project);
  // 足した行は消せる（取り込み済みの行には削除が無い）
  await expect(added.getByRole("button", { name: /削除/ })).toBeVisible();
  await expect(page.locator(".yn-me-ledger tbody tr:not(.is-added)").first().getByRole("button", { name: /削除/ })).toHaveCount(0);
});

test("未設定・仮の値: データ確認の「マスタで直す」で担当チーム未設定の案件だけに絞って開く。顧客の既定を入れると未設定から外れる", async ({ page }) => {
  await gotoPage(page, "/data-check");
  const table = tableByCaption(page, "未設定・仮の値");
  const row = dataRows(table).filter({ hasText: "担当チーム未設定" }).first();
  const target = await cellText(row, 1);
  const customer = target.replace(/ \/ .*$/, "");
  await row.getByRole("link", { name: /マスタ編集で直す/ }).click();
  await expect(page).toHaveURL(/unset=team/);
  const chip = page.locator(".yn-me-unset", { hasText: "担当チーム未設定" });
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".yn-me-ledger tbody tr")).toHaveCount(1);
  // 絞り込みを外すと全件
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "false");

  // 顧客タブで既定の担当チームを入れる → 案件は「顧客の既定」で出て、未設定の数が減る
  const before = Number((await chip.locator(".num").innerText()).trim());
  await page.locator("#yn-me-tab-customerTeams").click();
  await page.getByRole("button", { name: "＋ 新しい顧客" }).click();
  const dialog = page.locator("dialog[open]");
  await dialog.locator("#yn-me-f-customer_name").fill(customer);
  await dialog.locator("#yn-me-f-team_id").selectOption({ index: 1 });
  await submitDialog(page, dialog);
  await page.locator("#yn-me-tab-contracts").click();
  await page.locator("#yn-me-q-contracts").fill("");
  await page.locator("#yn-me-q-contracts").fill(customer);
  await expect(page.locator(".yn-me-ledger tbody").getByText("顧客の既定").first()).toBeVisible();
  if (before > 1) await expect(page.locator(".yn-me-unset", { hasText: "担当チーム未設定" }).locator(".num")).toHaveText(String(before - 1));
  else await expect(page.locator(".yn-me-unset", { hasText: "担当チーム未設定" })).toHaveCount(0);
});

test("単価: 仮の値を「仮」にすると表に出て、仮の単価のボタンで絞れる。保存する見出しに provisional を足す", async ({ page }) => {
  await gotoPage(page, "/masters?view=rates");
  await expect(page.locator(".yn-me-unset")).toHaveCount(0);
  await page.locator(".yn-me-ledger tbody tr.yn-me-group").first().getByRole("button", { name: /修正/ }).click();
  const dialog = page.locator("dialog[open]");
  await dialog.locator("#yn-me-f-provisional").selectOption("1");
  await submitDialog(page, dialog);
  const chip = page.locator(".yn-me-unset", { hasText: "仮の単価" });
  await expect(chip.locator(".num")).toHaveText("1");
  await chip.click();
  await expect(page.locator(".yn-me-ledger tbody tr.yn-me-group")).toHaveCount(1);
  await expect(page.locator(".yn-me-ledger tbody tr.yn-me-group")).toContainText("仮");
  await expect(page.locator(".yn-me-ledger thead")).toContainText("仮の値");
});

for (const [w, dark] of [
  [390, false],
  [768, true],
  [1280, false],
] as const) {
  test(`見た目: ${w}px${dark ? "・ダーク" : ""}でデータ確認と顧客タブが横にはみ出さない`, async ({ page }) => {
    if (dark) await useDarkTheme(page);
    await page.setViewportSize({ width: w, height: 900 });
    for (const url of ["/data-check", "/masters?view=customerTeams", "/masters?view=contracts&unset=team"]) {
      await gotoPage(page, url);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    }
  });
}
