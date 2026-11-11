/**
 * リソース計画で計画が何も入っていない人を目立たせる（SPEC §116）
 * - 表示中の今月以降に、在籍して組織に所属している月があり、そのどの月も 0 の人だけ（人ごと。月ごとの空きでは出さない）
 * - 名前の横に「計画なし」、月のセルは「なし」（赤紫・点線。1.0 超の黄・1.0 未満の青と別の色）
 * - 表の上の「計画なし n人」でその人だけに絞る。計画を入れると外れる
 * - 不在の人・所属組織の無い人（他部署のヘルプ）・今月より前の月は対象外。390px・ダークで横スクロール無し
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage, pickCombo, useDarkTheme, usePlanFiscalYear } from "./helpers/app.js";
import { AS_OF } from "./constants.js";
import { addMonths, type YearMonth } from "../../src/core/index.js";

test.beforeEach(async ({ page }) => {
  // 年度の月を前提にする（表示する月の既定は今月から 12 か月。§71）
  await usePlanFiscalYear(page, AS_OF);
  await page.addInitScript(() => {
    localStorage.removeItem("yojitsu-navi:masters-draft:v1");
    sessionStorage.removeItem("yojitsu-navi:masters-draft-session");
    sessionStorage.removeItem("yojitsu-navi:plan-cell-scope");
  });
});

const asOfMonth = AS_OF.slice(0, 7) as YearMonth;
const row = (page: Page, member: string) => page.locator(`tr.yn-me-plan-row[data-member="${member}"]`);
const emptyToggle = (page: Page) => page.locator('[data-fk="plan:empty-only"]');
const cell = (page: Page, member: string, month: string) => page.locator(`[data-fk="plan:cell:${member}:all:${month}"]`);

test("すべての組織: 計画なしの人に印、件数のボタンでその人だけに絞る", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/plan");
  const flagged = page.locator("tr.yn-me-plan-row:has(.yn-chip-empty)");
  const n = await flagged.count();
  expect(n).toBeGreaterThan(0);
  await expect(emptyToggle(page)).toHaveText(`計画なし ${n}人`);
  await expect(emptyToggle(page)).toHaveAttribute("aria-pressed", "false");
  // 「なし」のセルは印のある人の行だけ、今月以降だけ
  const emptyCells = await page.locator(".yn-me-plan-cell.is-empty").evaluateAll((tds) =>
    tds.map((td) => ({ flagged: !!td.closest("tr")!.querySelector(".yn-chip-empty"), fk: td.querySelector("button")!.getAttribute("data-fk")!, text: td.textContent })),
  );
  expect(emptyCells.length).toBeGreaterThan(0);
  for (const c of emptyCells) {
    expect(c.flagged).toBe(true);
    expect(c.fk.slice(-7) >= asOfMonth).toBe(true);
    expect(c.text).toBe("なし");
  }
  // 不在の人・所属組織の無い人（他部署のヘルプ）には付けない
  for (const id of ["M122", "M301"]) await expect(row(page, id).locator(".yn-chip-empty")).toHaveCount(0);
  // 絞り込み
  const total = await page.locator("tr.yn-me-plan-row").count();
  await emptyToggle(page).click();
  await expect(emptyToggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(emptyToggle(page)).toBeFocused();
  await expect(page.locator("tr.yn-me-plan-row")).toHaveCount(n);
  await expect(page.locator("tr.yn-me-plan-row:not(:has(.yn-chip-empty))")).toHaveCount(0);
  await emptyToggle(page).click();
  await expect(page.locator("tr.yn-me-plan-row")).toHaveCount(total);
});

test("計画を入れると印が外れ、全員入ればボタンも消える", async ({ page }) => {
  await gotoPage(page, "/plan?team=T611");
  const flagged = page.locator("tr.yn-me-plan-row:has(.yn-chip-empty)");
  const ids = await flagged.evaluateAll((trs) => trs.map((tr) => tr.getAttribute("data-member")!));
  expect(ids).toContain("M189");
  await expect(row(page, "M189").locator(".yn-chip-empty")).toHaveAttribute("title", /に計画が何も入っていません/);
  await emptyToggle(page).click();
  for (const id of ids) {
    // 今月は過去として確認が出るので翌月に入れる
    const month = addMonths(asOfMonth, 1);
    await cell(page, id, month).click();
    const p = page.locator("dialog.yn-plan-pop[open]");
    await pickCombo(p.locator("#yn-plan-pop-project"), "保守");
    await p.locator("#yn-plan-pop-new").fill("0.5");
    await p.locator("#yn-plan-pop-new").press("Enter");
    await expect(p).toHaveCount(0);
    await expect(row(page, id)).toHaveCount(ids.indexOf(id) === ids.length - 1 ? 1 : 0);
  }
  // 最後の人に入れたら絞り込みは外れ、ボタンも無くなる
  await expect(emptyToggle(page)).toHaveCount(0);
  await expect(page.locator(".yn-chip-empty")).toHaveCount(0);
  await expect(row(page, "M189")).toBeVisible();
  await expect(page.locator(".yn-me-plan-cell.is-empty")).toHaveCount(0);
});

test("390px・ダーク: 横スクロールせず、計画なしの色は 1.0 超・1.0 未満と見分けられる", async ({ page }) => {
  await useDarkTheme(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoPage(page, "/plan");
  await expect(emptyToggle(page)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const bg = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const empty = await bg(".yn-me-plan-cell.is-empty");
  expect(empty).not.toBe(await bg(".yn-me-plan-cell.is-under"));
  expect(empty).not.toBe(await bg(".yn-me-plan-cell.is-over"));
});
