/**
 * マスタ編集「案件」タブ（SPEC §80）
 * - contracts.csv の全行を、顧客・案件名・開始月・終了月・金額・担当チームで一覧（担当チームは名前、金額は円）
 * - 変えられるのは期間と金額だけ（顧客名・案件名などは他システムから取り込む）。追加・削除・CSV で編集は無い
 * - 期間の修正 → ダウンロードした CSV は期間だけ変わり変更日付き
 * - 金額の修正は、過去の月の予算が変わることを確認で知らせる
 * - 390px・ダークで横スクロールしない
 */
import { readFileSync } from "node:fs";
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";
import { ROOT_DIR } from "./constants.js";
import { buildMastersPayload } from "../../src/data/_masters.js";
import { parseMasterDoc, rowRecord, serializeMasterDoc, stampChangedRows, updateRow } from "../../src/core/masterEdit.js";

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

test("顧客名・案件名・担当チームは変えられない（他システムから取り込む）。行の追加・削除・CSV で編集も無い", async ({ page }) => {
  await gotoPage(page, "/masters?view=contracts");
  await expect(page.getByRole("button", { name: /新しい案件/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "CSV で編集" })).toHaveCount(0);
  const first = page.locator("table.yn-me-table tbody tr.yn-me-group").first();
  await expect(first.getByRole("button", { name: "削除" })).toHaveCount(0);
  await first.getByRole("button", { name: "修正" }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  // 取り込む列は入力欄にせず、値だけ見せる
  for (const name of ["contract_id", "customer_name", "project_name", "team_id", "note"]) await expect(d.locator(`#yn-me-f-${name}`)).toHaveCount(0);
  const doc = parseMasterDoc("contracts", CONTRACTS_TEXT);
  const rec = rowRecord(doc, doc.rows[0]!);
  await expect(d.locator(".yn-me-fixed")).toContainText(rec.customer_name!);
  await expect(d.locator(".yn-me-fixed")).toContainText(rec.project_name!);
  await expect(d).toContainText("他システムから取り込むため変更できません");
  for (const name of ["start_month", "end_month", "total_amount"]) await expect(d.locator(`#yn-me-f-${name}`)).toBeEnabled();
});

test("期間の修正: 予算の月割りが変わるので過去の月にかかれば確認。ダウンロードした CSV は期間だけ変わり変更日付き", async ({ page }) => {
  await gotoPage(page, "/masters?view=contracts");
  const doc = parseMasterDoc("contracts", CONTRACTS_TEXT);
  // 計算基準月をまたぐ案件の終了月を 1 年延ばす（月割りが変わるので、始まっている月の予算も変わる）
  const target = doc.rows.find((r) => (rowRecord(doc, r).start_month ?? "") < "2026-10" && (rowRecord(doc, r).end_month ?? "") > "2027-01")!;
  const rec = rowRecord(doc, target);
  const newEnd = `${Number(rec.end_month!.slice(0, 4)) + 1}${rec.end_month!.slice(4)}`;
  const row = page.locator(`table.yn-me-table tbody tr[data-key="${target.id}"]`);
  await row.getByRole("button", { name: "修正" }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  await d.locator("#yn-me-f-end_month").fill(newEnd);
  await d.locator('[data-role="submit"]').click();
  await expect(d.locator(".yn-me-impact")).toContainText("予算");
  await d.locator('[data-role="submit"]').click();
  await expect(d).toHaveCount(0);
  await expect(row).toContainText(newEnd);
  await expect(row).toContainText("変更");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /contracts\.csv をダウンロード/ }).click()]);
  const text = readFileSync((await dl.path())!, "utf-8");
  const today = await page.evaluate(() => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()));
  expect(text).toBe(serializeMasterDoc(stampChangedRows(updateRow(doc, target.id, { end_month: newEnd }), "", today)).text);
});

test("金額の修正は過去の月の予算が変わることを知らせる。「48,000,000円」のような書き方も数値として並べる", async ({ page }) => {
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
  // CSV の読み込みと同じく、カンマ区切り・全角・「円」付きの金額も円で表示し、数値として並べる（Codex 指摘）
  await first.getByRole("button", { name: "修正" }).click();
  await d.locator("#yn-me-f-total_amount").fill("９,９９９,９９９,９９９円");
  await d.locator('[data-role="submit"]').click();
  await d.locator('[data-role="submit"]').click();
  await expect(first).toContainText("9,999,999,999円");
  await page.locator('[data-fk="sort:contracts:total_amount"]').click();
  await expect(rows.first()).toContainText("9,999,999,999円");
  // 終了月を開始月より前にすると検証エラー
  await rows.first().getByRole("button", { name: "修正" }).click();
  await d.locator("#yn-me-f-end_month").fill("2000-01");
  await d.locator('[data-role="submit"]').click();
  await d.locator('[data-role="submit"]').click();
  await expect(page.locator(".yn-me-check")).toContainText("エラー");
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
