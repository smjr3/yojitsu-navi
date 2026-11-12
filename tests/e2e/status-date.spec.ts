/**
 * 退職・休みなどを日付で指定する（SPEC §119。members.csv の任意列 status_date）
 * - リソース計画: 不在のチップに日付、その月の吹き出しに在籍の営業日と稼働できる量
 * - メンバー詳細: 不在のチップに日付、所属の変遷の在籍の列に「（日付から）」
 * - マスタ編集: 行の編集に「在籍・不在の開始日」、台帳の在籍の列に添える。「＋ 変更」では写さない
 * - 390px・ダークで横スクロール無し
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme, usePlanFiscalYear } from "./helpers/app.js";
import { AS_OF } from "./constants.js";

// ダミーデータ: M151 は 6 月に退職し、status_date = 6 月 6 日（最初の 5 営業日に引き継ぎの実績。docs/DUMMY_DATA.md）
const LEAVER = "M151";

test.beforeEach(async ({ page }) => {
  await usePlanFiscalYear(page, AS_OF);
  await page.addInitScript(() => {
    localStorage.removeItem("yojitsu-navi:masters-draft:v1");
    sessionStorage.removeItem("yojitsu-navi:masters-draft-session");
    sessionStorage.removeItem("yojitsu-navi:plan-cell-scope");
  });
});

const planRow = (page: Page, member: string) => page.locator(`tr.yn-me-plan-row[data-member="${member}"]`);
const cell = (page: Page, member: string, month: string) => page.locator(`[data-fk="plan:cell:${member}:all:${month}"]`);
const group = (page: Page, key: string) => page.locator(`tr.yn-me-group[data-group="${key}"]`);

test("リソース計画: 不在のチップに日付、その月の吹き出しに在籍の営業日", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/plan?team=T421");
  const row = planRow(page, LEAVER);
  await expect(row.locator(".yn-chip-neutral", { hasText: "不在" })).toHaveText("不在 2026年6月6日");
  const june = cell(page, LEAVER, "2026-06");
  await june.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }));
  await june.hover();
  const tip = page.locator("#yn-plan-tip");
  await expect(tip).toBeVisible();
  // 6 月は 22 営業日。6 日（土）より前の営業日は 5 日
  await expect(tip).toContainText("在籍 5 / 22 営業日（0.23 人月まで）");
  await expect(tip).toContainText("空き 0.23 人月");
  // 6 月は稼働（斜線なし）、7 月からは稼働しない
  await expect(june.locator("xpath=..")).not.toHaveClass(/is-left/);
  await expect(cell(page, LEAVER, "2026-07").locator("xpath=..")).toHaveClass(/is-left/);
});

test("メンバー詳細: 不在のチップと所属の変遷に日付", async ({ page }) => {
  await gotoPage(page, `/member?id=${LEAVER}`);
  await expect(page.locator(".yn-facts")).toContainText("不在 2026年6月6日");
  await page.locator(".yn-member-history summary").click();
  await expect(page.locator(".yn-member-history")).toContainText("不在（2026年6月6日から）");
});

test("マスタ編集: 在籍・不在の開始日を入れられ、台帳の在籍の列に添える。「＋ 変更」では写さない", async ({ page }) => {
  await gotoPage(page, "/masters");
  await expect(group(page, LEAVER)).toContainText("6日から");
  const d = page.locator("dialog.yn-me-dialog[open]");
  // 今の行の修正には日付が入っている
  await group(page, LEAVER).locator("button", { hasText: /^修正$/ }).click();
  await expect(d.locator('[name="status_date"]')).toHaveValue("2026-06-06");
  await expect(d.locator('label[for="yn-me-f-status_date"]')).toContainText("在籍・不在の開始日");
  await page.keyboard.press("Escape");
  // 「＋ 変更」は写さない
  await group(page, LEAVER).getByRole("button", { name: /の変更を追加/ }).click();
  await expect(d.locator('[name="status_date"]')).toHaveValue("");
  await page.keyboard.press("Escape");

  // 在籍の人を月の途中から不在にする
  await group(page, "M010").getByRole("button", { name: /の変更を追加/ }).click();
  await d.locator('[name="status"]').selectOption({ label: "不在" });
  await d.locator('[name="effective_from"]').fill("2026-11");
  await d.locator('[name="status_date"]').fill("2026-11-16");
  await d.locator('[data-role="submit"]').click();
  if (await d.isVisible()) await d.locator('[data-role="submit"]').click();
  await expect(d).toHaveCount(0);
  // 先の変更の予告も日付から
  await expect(group(page, "M010")).toContainText("2026年11月16日〜 不在");
  await expect(page.locator('tr.yn-me-hist[data-parent="M010"]').last()).toContainText("16日から");
});

test("390px・ダークで横にはみ出さない", async ({ page }) => {
  await useDarkTheme(page);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/plan?team=T421", `/member?id=${LEAVER}`]) {
    await gotoPage(page, path);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over, path).toBeLessThanOrEqual(0);
  }
});
