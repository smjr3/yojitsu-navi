/**
 * リソース計画の表示する月（SPEC §71）: 既定は基準月から 12 か月、開始月〜終了月を選べる、◀ ▶ で 1 か月ずつ、
 * 選んだ範囲はリロード後も残る、24 か月まで、狭い画面でもはみ出さない
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage } from "./helpers/app.js";
import { AS_OF } from "./constants.js";
import { addMonths } from "../../src/core/calendar.js";

const asOfMonth = AS_OF.slice(0, 7);
const ja = (m: string) => `${Number(m.slice(0, 4))}年${Number(m.slice(5))}月`;
/** 月の列の見出し（年の補足を除いた「n月」） */
const monthHeads = (page: Page) => page.locator(".yn-me-plan-table thead th.num").evaluateAll((ths) => ths.map((t) => t.firstChild?.textContent ?? "").filter((t) => /^\d+月$/.test(t)));
/** 年の補足が付いた列（最初の月と 1 月） */
const yearSubs = (page: Page) => page.locator(".yn-me-plan-table thead th.num").evaluateAll((ths) => ths.map((t) => [t.firstChild?.textContent ?? "", t.querySelector(".yn-th-sub")?.textContent ?? ""]).filter(([m, y]) => /^\d+月$/.test(m ?? "") && y));
const from = (page: Page) => page.locator("#yn-me-plan-from");
const to = (page: Page) => page.locator("#yn-me-plan-to");
const mLabel = (m: string) => `${Number(m.slice(5))}月`;

test("表示する月: 既定は今月から 12 か月。開始・終了を選ぶと表の列が変わり、リロード後も残る", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/plan?team=S11");
  await expect(from(page)).toHaveValue(asOfMonth);
  await expect(to(page)).toHaveValue(addMonths(asOfMonth, 11));
  expect(await monthHeads(page)).toHaveLength(12);
  expect((await monthHeads(page))[0]).toBe(mLabel(asOfMonth));
  await expect(page.locator(".yn-me-plan-table thead")).toContainText("期間計");
  // 年をまたいでも分かるよう、最初の月と 1 月に年を出す
  const jan = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => addMonths(asOfMonth, i)).find((m) => m.endsWith("-01"))!;
  expect(await yearSubs(page)).toEqual([
    [mLabel(asOfMonth), `${asOfMonth.slice(0, 4)}年`],
    ...(jan !== asOfMonth ? [["1月", `${jan.slice(0, 4)}年`]] : []),
  ]);

  await from(page).selectOption(addMonths(asOfMonth, -2));
  await to(page).selectOption(addMonths(asOfMonth, 5));
  await expect.poll(() => monthHeads(page)).toHaveLength(8);
  expect((await monthHeads(page))[0]).toBe(mLabel(addMonths(asOfMonth, -2)));
  await expect(to(page)).toBeFocused();
  await expect(page.locator(".yn-me-plan-table caption")).toContainText(`${ja(addMonths(asOfMonth, -2))}〜${ja(addMonths(asOfMonth, 5))}（8か月）`);

  await page.reload();
  await expect(from(page)).toHaveValue(addMonths(asOfMonth, -2));
  await expect(to(page)).toHaveValue(addMonths(asOfMonth, 5));
});

test("表示する月: ◀ ▶ は月数を保って 1 か月ずつ。終了を開始より前にすると月数を保って前へ。24 か月まで", async ({ page }) => {
  await gotoPage(page, "/plan?team=S11");
  await page.locator('[data-fk="plan:next"]').click();
  await expect(from(page)).toHaveValue(addMonths(asOfMonth, 1));
  await expect(to(page)).toHaveValue(addMonths(asOfMonth, 12));
  await expect(page.locator('[data-fk="plan:next"]')).toBeFocused();
  await page.locator('[data-fk="plan:prev"]').click();
  await page.locator('[data-fk="plan:prev"]').click();
  await expect(from(page)).toHaveValue(addMonths(asOfMonth, -1));

  await to(page).selectOption(addMonths(asOfMonth, -3));
  await expect(from(page)).toHaveValue(addMonths(asOfMonth, -14));
  await expect.poll(() => monthHeads(page)).toHaveLength(12);

  await to(page).selectOption(addMonths(asOfMonth, 20));
  await expect(from(page)).toHaveValue(addMonths(asOfMonth, -3));
  await expect.poll(() => monthHeads(page)).toHaveLength(24);
});

for (const width of [390, 768, 1280]) {
  test(`表示する月: 幅 ${width}px でも操作欄が画面からはみ出さない`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await gotoPage(page, "/plan?team=S11");
    for (const el of [from(page), to(page), page.locator('[data-fk="plan:next"]')]) {
      const b = await el.boundingBox();
      expect(b!.x + b!.width).toBeLessThanOrEqual(width);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
