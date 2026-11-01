/**
 * マスタ編集「祝日」タブ（SPEC §80）
 * - holidays.csv の全行を日付（曜日つき）・名前で一覧
 * - 追加 → ダウンロードした CSV は元 + 1 行（UTF-8・BOM なし）。過去の月の日付なら営業日が変わる確認
 * - 日付の誤りは検証エラー、削除は元に戻せる
 * - 390px・ダークで横スクロールしない
 */
import { readFileSync } from "node:fs";
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";
import { ROOT_DIR } from "./constants.js";
import { buildMastersPayload } from "../../src/data/_masters.js";
import { addRow, parseMasterDoc, serializeMasterDoc } from "../../src/core/masterEdit.js";

const HOLIDAYS_TEXT = buildMastersPayload(ROOT_DIR).files.holidays.text;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem("yojitsu-navi:masters-draft:v1");
    sessionStorage.removeItem("yojitsu-navi:masters-draft-session");
  });
});

test("一覧と追加: 曜日つきで出し、追加した日はダウンロードした CSV の末尾に入る", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/masters?view=holidays");
  await expect(page.getByRole("tab", { name: /祝日/ })).toHaveAttribute("aria-selected", "true");
  const doc = parseMasterDoc("holidays", HOLIDAYS_TEXT);
  const rows = page.locator("table.yn-me-table tbody tr.yn-me-group");
  await expect(rows).toHaveCount(doc.rows.length);
  await expect(page.locator("table.yn-me-table thead")).toContainText("日付");
  await expect(rows.first()).toContainText(/（[日月火水木金土]）/);

  await page.getByRole("button", { name: "＋ 新しい祝日" }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  await d.locator("#yn-me-f-date").fill("2027-08-13");
  await d.locator("#yn-me-f-name").fill("夏季休暇");
  await d.locator('[data-role="submit"]').click();
  // 未来の日なので確認なしで反映
  await expect(d).toHaveCount(0);
  await expect(rows).toHaveCount(doc.rows.length + 1);
  await expect(rows.last()).toContainText("2027-08-13");
  await expect(rows.last()).toContainText("（金）");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /holidays\.csv をダウンロード/ }).click()]);
  const text = readFileSync((await dl.path())!, "utf-8");
  expect(text).toBe(serializeMasterDoc(addRow(doc, { date: "2027-08-13", name: "夏季休暇" }).doc).text);
  expect(text.charCodeAt(0)).not.toBe(0xfeff);
});

test("過去の月の休日を足すと営業日が変わる確認。日付の誤りは検証エラー、削除で元に戻る", async ({ page }) => {
  await gotoPage(page, "/masters?view=holidays");
  const rows = page.locator("table.yn-me-table tbody tr.yn-me-group");
  const before = await rows.count();
  await page.getByRole("button", { name: "＋ 新しい祝日" }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  await d.locator("#yn-me-f-date").fill("2026-06-15");
  await d.locator("#yn-me-f-name").fill("創立記念日");
  await d.locator('[data-role="submit"]').click();
  await expect(d.locator(".yn-me-impact")).toContainText("営業日");
  await d.locator('[data-role="submit"]').click();
  await expect(rows).toHaveCount(before + 1);
  await expect(page.locator(".yn-me-check")).toContainText("エラーなし");

  // CSV で日付の誤りを入れると行にエラー
  await page.getByRole("button", { name: "CSV で編集" }).click();
  const area = page.locator("#yn-me-csv-holidays");
  await area.fill(`${await area.inputValue()}2026-02-30,誤り\n`);
  await page.getByRole("button", { name: "反映" }).click();
  await page.getByRole("button", { name: "表で編集" }).click();
  await expect(page.locator(".yn-me-check")).toContainText("エラー");
  await expect(page.locator("tr.yn-me-issue-row").first()).toContainText("2026-02-30");
  const bad = rows.last();
  await bad.getByRole("button", { name: "削除" }).click();
  await page.locator("dialog.yn-me-dialog[open]").locator('[data-role="confirm-delete"]').click();
  await expect(rows).toHaveCount(before + 1);
  await expect(page.locator(".yn-me-check")).toContainText("エラーなし");
});

test("390px・ダーク: 祝日タブで画面が横にはみ出さない", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useDarkTheme(page);
  await gotoPage(page, "/masters?view=holidays");
  await expect(page.locator("table.yn-me-table tbody tr.yn-me-group").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
