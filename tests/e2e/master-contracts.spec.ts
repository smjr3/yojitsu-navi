/**
 * マスタ編集「案件」タブ（SPEC §80）
 * - contracts.csv の全行を、顧客・案件名・開始月・終了月・金額・担当チームで一覧（担当チームは名前、金額は円）
 * - 追加（案件ID は続き番号を入れておく）→ ダウンロードした CSV は元 + 1 行（変更日付き）
 * - 金額の修正は、過去の月の予算が変わることを確認で知らせる
 * - 追加した案件は、同じ画面の目標の対象の候補にすぐ出る（保存前でも）
 * - 重複 ID・存在しないチームは検証エラー
 * - 390px・ダークで横スクロールしない
 */
import { readFileSync } from "node:fs";
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";
import { ROOT_DIR } from "./constants.js";
import { buildMastersPayload } from "../../src/data/_masters.js";
import { addRow, nextContractId, parseMasterDoc, rowRecord, serializeMasterDoc, stampChangedRows } from "../../src/core/masterEdit.js";

const PAYLOAD = buildMastersPayload(ROOT_DIR);
const CONTRACTS_TEXT = PAYLOAD.files.contracts.text;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem("yojitsu-navi:masters-draft:v1");
    sessionStorage.removeItem("yojitsu-navi:masters-draft-session");
  });
});

test("一覧: 全案件を顧客・案件名・期間・金額・担当チームで出す", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/masters?view=contracts");
  await expect(page.getByRole("tab", { name: /案件/ })).toHaveAttribute("aria-selected", "true");
  const doc = parseMasterDoc("contracts", CONTRACTS_TEXT);
  const rows = page.locator("table.yn-me-table tbody tr.yn-me-group");
  await expect(rows).toHaveCount(doc.rows.length);
  const head = page.locator("table.yn-me-table thead");
  for (const label of ["顧客", "案件名", "開始月", "終了月", "金額", "担当チーム"]) await expect(head).toContainText(label);
  const first = rowRecord(doc, doc.rows[0]!);
  const teams = parseMasterDoc("teams", PAYLOAD.files.teams.text);
  const teamName = teams.rows.map((r) => rowRecord(teams, r)).filter((t) => t.team_id === first.team_id).at(-1)!.name!;
  const row = rows.first();
  await expect(row).toContainText(first.customer_name!);
  await expect(row).toContainText(first.project_name!);
  await expect(row).toContainText(first.contract_id!);
  await expect(row).toContainText(`${Number(first.total_amount).toLocaleString("ja-JP")}円`);
  await expect(row).toContainText(teamName);
  // 金額の列で並べ替え（大きい順）
  await page.locator('[data-fk="sort:contracts:total_amount"]').click();
  const max = Math.max(...doc.rows.map((r) => Number(rowRecord(doc, r).total_amount)));
  await expect(rows.first()).toContainText(`${max.toLocaleString("ja-JP")}円`);
});

test("追加: 案件ID は続き番号。ダウンロードした CSV は元 + 1 行。目標の対象の候補にもすぐ出る", async ({ page }) => {
  await gotoPage(page, "/masters?view=contracts");
  const doc = parseMasterDoc("contracts", CONTRACTS_TEXT);
  const rows = page.locator("table.yn-me-table tbody tr.yn-me-group");
  await page.getByRole("button", { name: "＋ 新しい案件" }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  const id = nextContractId(doc.rows.map((r) => rowRecord(doc, r).contract_id ?? ""));
  await expect(d.locator("#yn-me-f-contract_id")).toHaveValue(id);
  // 必須の未入力は止める
  await d.locator('[data-role="submit"]').click();
  await expect(d.locator(".yn-me-form-msg")).toContainText("顧客");
  await d.locator("#yn-me-f-customer_name").fill("テスト商事");
  await d.locator("#yn-me-f-project_name").fill("試験システム保守");
  await d.locator("#yn-me-f-start_month").fill("2027-04");
  await d.locator("#yn-me-f-end_month").fill("2028-03");
  await d.locator("#yn-me-f-total_amount").fill("24000000");
  await d.locator("#yn-me-f-team_id").selectOption("T111");
  await d.locator('[data-role="submit"]').click();
  // 未来の案件なので過去の影響なし → 確認なしで反映
  await expect(d).toHaveCount(0);
  await expect(rows).toHaveCount(doc.rows.length + 1);
  const added = rows.last();
  await expect(added).toContainText("テスト商事");
  await expect(added).toContainText("24,000,000円");
  await expect(added).toContainText("追加");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /contracts\.csv をダウンロード/ }).click()]);
  const text = readFileSync((await dl.path())!, "utf-8");
  const today = await page.evaluate(() => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()));
  const expected = stampChangedRows(addRow(doc, { contract_id: id, customer_name: "テスト商事", project_name: "試験システム保守", team_id: "T111", start_month: "2027-04", end_month: "2028-03", total_amount: "24000000", note: "" }).doc, "", today);
  expect(text).toBe(serializeMasterDoc(expected).text);

  // 同じ画面の「目標」タブ: 対象の候補に保存前の案件も出る
  await page.getByRole("tab", { name: /目標/ }).click();
  await page.getByRole("button", { name: "＋ 新しい目標" }).click();
  await d.locator("#yn-me-f-target_id").fill("試験システム");
  await expect(page.getByRole("option", { name: /試験システム保守/ })).toBeVisible();
});

test("金額の修正は過去の月の予算が変わることを知らせる。重複 ID は検証エラー", async ({ page }) => {
  await gotoPage(page, "/masters?view=contracts");
  const rows = page.locator("table.yn-me-table tbody tr.yn-me-group");
  const first = rows.first();
  await first.getByRole("button", { name: "修正" }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  await d.locator("#yn-me-f-total_amount").fill("1");
  await d.locator('[data-role="submit"]').click();
  await expect(d.locator(".yn-me-impact")).toContainText("予算");
  await d.locator('[data-role="submit"]').click();
  await expect(first).toContainText("1円");
  await expect(first).toContainText("変更");

  // 既にある案件ID で追加すると重複のエラー
  const doc = parseMasterDoc("contracts", CONTRACTS_TEXT);
  const firstId = rowRecord(doc, doc.rows[0]!).contract_id!;
  await page.getByRole("button", { name: "＋ 新しい案件" }).click();
  await d.locator("#yn-me-f-contract_id").fill(firstId);
  await d.locator("#yn-me-f-customer_name").fill("重複商事");
  await d.locator("#yn-me-f-project_name").fill("重複");
  await d.locator("#yn-me-f-start_month").fill("2027-04");
  await d.locator("#yn-me-f-end_month").fill("2028-03");
  await d.locator("#yn-me-f-total_amount").fill("100");
  await d.locator('[data-role="submit"]').click();
  await expect(d).toHaveCount(0);
  await expect(page.locator(".yn-me-check")).toContainText("エラー");
  await expect(page.locator("tr.yn-me-issue-row").first()).toContainText(firstId);
});

test("390px・ダーク / 768px: 案件タブで画面が横にはみ出さない", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useDarkTheme(page);
  await gotoPage(page, "/masters?view=contracts");
  await expect(page.locator("table.yn-me-table tbody tr.yn-me-group").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 768, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
