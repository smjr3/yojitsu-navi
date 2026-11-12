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
  // 最初の読み込みでだけ下書きを消す（同じタブで画面を移っても下書きが続くことを確かめるテストがある）
  await page.addInitScript(() => {
    if (sessionStorage.getItem("e2e-draft-cleared")) return;
    sessionStorage.setItem("e2e-draft-cleared", "1");
    localStorage.removeItem("yojitsu-navi:masters-draft:v1");
    sessionStorage.removeItem("yojitsu-navi:masters-draft-session");
  });
});

test("一覧と追加: 曜日つきで出し、追加した日はダウンロードした CSV の同じ日の行の後ろに入る", { tag: "@smoke" }, async ({ page }) => {
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
  const added = rows.filter({ hasText: "追加" });
  await expect(added).toHaveCount(1);
  await expect(added).toContainText("2027-08-13");
  await expect(added).toContainText("（金）");
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

test("祝日を足すと、リソース計画の 1 人月の時間・変更の影響がその祝日で変わる（§114）", async ({ page }) => {
  await gotoPage(page, "/masters?view=holidays");
  await page.getByRole("button", { name: "＋ 新しい祝日" }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  // 2026-11-30（月）。ダミーの祝日表で 11 月は 19 日 = 152h → 18 日 = 144h
  await d.locator("#yn-me-f-date").fill("2026-11-30");
  await d.locator("#yn-me-f-name").fill("会社の休日");
  await d.locator('[data-role="submit"]').click();
  // 予算は契約期間の営業日で按分するので、11 月を含む案件の過去の月の予算も変わる（§118）
  await expect(d.locator(".yn-me-impact")).toContainText("予算");
  await d.locator('[data-role="submit"]').click();
  await expect(d).toHaveCount(0);
  // 同じタブでリソース計画へ（下書きは続き）
  await gotoPage(page, "/plan?team=T111");
  const cellEl = page.locator('[data-fk="plan:cell:M010:all:2026-11"]');
  await cellEl.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await cellEl.hover();
  // 吹き出しの時間は編集中の祝日で数える（人月 × 144h）
  const tip = page.locator("#yn-plan-tip");
  await expect(tip).toContainText("2026年11月 合計");
  const m = /合計 ([\d.]+) 人月（([\d.,]+) 時間）/.exec((await tip.textContent()) ?? "");
  expect(m).not.toBeNull();
  expect(Number(m![1])).toBeGreaterThan(0);
  expect(Number(m![2]!.replace(/,/g, ""))).toBeCloseTo(Number(m![1]) * 144, 0);
  // 祝日だけの編集でも変更の影響を出す（計画値の着地が減る）
  const section = page.locator(".yn-me-impact");
  await expect(section.locator('[data-role="impact-rows"] tbody tr').first()).toBeVisible();
});
