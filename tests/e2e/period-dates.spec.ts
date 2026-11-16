/**
 * アサイン・運用保守以外の予定を日付で指定する（SPEC §123。assignments.csv / outside-plans.csv の任意列 start_date / end_date）
 * - 計画を追加のダイアログ: 開始・終了は日付の 1 欄（月の欄・日付の欄に分かれない）。月から入れた期間は 1 日〜月末
 * - 月の途中から始まる月は営業日で日割りした人月を出し、セルの角に印。吹き出しに「16日から」
 * - 変更の履歴の期間は日付、保存する CSV は月の列＋日付の列（月の初日・末日なら日付の列は空）
 * - 390px・ダークで横スクロール無し
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage, pickCombo, useDarkTheme, usePlanFiscalYear } from "./helpers/app.js";
import { AS_OF } from "./constants.js";

test.beforeEach(async ({ page }) => {
  await usePlanFiscalYear(page, AS_OF);
  await page.addInitScript(() => {
    localStorage.removeItem("yojitsu-navi:masters-draft:v1");
    sessionStorage.removeItem("yojitsu-navi:masters-draft-session");
    sessionStorage.removeItem("yojitsu-navi:plan-cell-scope");
  });
});

const subRow = (page: Page, member: string, text: string) => page.locator(`tr.yn-me-plan-sub.is-project[data-member="${member}"]`).filter({ hasText: text });

/** M011 に倉庫管理の計画を 11 月 16 日から 2 月末まで 0.5 人月で足す */
async function addDated(page: Page): Promise<void> {
  await gotoPage(page, "/plan?member=M011");
  await page.locator('tr.yn-me-plan-row[data-member="M011"]').getByRole("button", { name: /計画を追加/ }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  // 日付の 1 欄（月の欄は無い。既定は月の 1 日）
  await expect(d.locator("#yn-me-f-start_month")).toHaveAttribute("type", "date");
  await expect(d.locator('label[for="yn-me-f-start_month"]')).toContainText("開始日");
  await expect(d.locator('label[for="yn-me-f-end_month"]')).toContainText("終了日");
  await expect(d.locator('[name="start_date"]')).toHaveCount(0);
  await expect(d.locator("#yn-me-f-start_month")).toHaveValue(/-01$/);
  await pickCombo(d.locator("#yn-me-f-contract_id"), "倉庫管理");
  await d.locator("#yn-me-f-start_month").fill("2026-11-16");
  await d.locator("#yn-me-f-end_month").fill("2027-02-28");
  await d.locator("#yn-me-f-allocation").fill("0.5");
  await d.locator('[data-role="submit"]').click();
  if (await d.isVisible()) await d.locator('[data-role="submit"]').click();
  await expect(d).toHaveCount(0);
}

test("計画を追加: 開始日から日割り。セルの角に印、吹き出しに「16日から」、履歴は日付", { tag: "@smoke" }, async ({ page }) => {
  await addDated(page);
  const sub = subRow(page, "M011", "倉庫管理");
  // 11 月（ダミーの祝日表で 19 営業日）のうち 16 日からは 10 営業日 → 0.9 ＋ 0.5 × 10/19 = 1.16
  const nov = sub.locator('[data-fk$=":2026-11"]');
  await expect(nov).toHaveText("1.16");
  await expect(nov.locator("xpath=..")).toHaveClass(/is-partial/);
  // 12 月は丸 1 か月（0.9 ＋ 0.5）
  await expect(sub.locator('[data-fk$=":2026-12"]')).toHaveText("1.40");
  await expect(sub.locator('[data-fk$=":2026-12"]').locator("xpath=..")).not.toHaveClass(/is-partial/);
  await nov.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }));
  await nov.hover();
  const tip = page.locator("#yn-plan-tip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("16日から");
  await expect(tip).toContainText("0.26");
  // 変更の履歴は日付
  await sub.locator('[data-fk^="plan:hist:"]').click();
  await expect(page.locator("tr.yn-me-plan-hist li.yn-me-plan-entry.is-added")).toContainText("2026-11-16〜2027-02");
  // 保存する CSV: 月の列＋開始日の列（終了は月末なので空）
  await expect(page.locator(".yn-me-diff-slot")).toContainText(/2026-11 ・ 2027-02 ・ 0\.5 ・ 2026-11-16/);
});

test("修正: 日付の 1 欄に保存した日付が入り、月末に変えると終了日の列は空のまま", async ({ page }) => {
  await addDated(page);
  const sub = subRow(page, "M011", "倉庫管理");
  await sub.locator('[data-fk^="plan:hist:"]').click();
  await page.locator("tr.yn-me-plan-hist li.yn-me-plan-entry.is-added").getByRole("button", { name: /修正/ }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  await expect(d.locator("#yn-me-f-start_month")).toHaveValue("2026-11-16");
  await expect(d.locator("#yn-me-f-end_month")).toHaveValue("2027-02-28");
  // 月の初日に戻すと日割りしない
  await d.locator("#yn-me-f-start_month").fill("2026-11-01");
  await d.locator('[data-role="submit"]').click();
  await expect(d.locator(".yn-me-change-list")).toContainText("開始日: 2026年11月16日 → 2026年11月1日");
  await d.locator('[data-role="submit"]').click();
  await expect(d).toHaveCount(0);
  await expect(sub.locator('[data-fk$=":2026-11"]')).toHaveText("1.40");
  await expect(sub.locator('[data-fk$=":2026-11"]').locator("xpath=..")).not.toHaveClass(/is-partial/);
});

test("390px・ダークで横にはみ出さない", async ({ page }) => {
  await useDarkTheme(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await addDated(page);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
});
