/**
 * リソース計画の表の並べ替え・列ごとの絞り込み（SPEC §99。一覧表 §70・マスタ編集 §73.1 の横展開）
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";
import { AS_OF } from "./constants.js";

const asOfMonth = AS_OF.slice(0, 7);
const table = (page: Page) => page.locator(".yn-me-plan-table");
const rows = (page: Page) => table(page).locator("tbody tr.yn-me-plan-row");
const count = (page: Page) => page.locator(".yn-me-plan-filter .yn-table-count");
const pop = (page: Page) => page.locator(".yn-filter-pop");
const filterBtn = (page: Page, key: string) => table(page).locator(`thead .yn-filter-btn[data-fcol="${key}"]`);
const sortBtn = (page: Page, key: string) => table(page).locator(`thead button.yn-sort[data-fk="plan:sort:${key}"]`);
const names = (page: Page) => rows(page).evaluateAll((trs) => trs.map((tr) => (tr.querySelector(".yn-me-plan-name") as HTMLElement).innerText.trim()));
/** 人の行の、見出しの key の列の値（「—」は 0） */
async function colValues(page: Page, key: string): Promise<number[]> {
  const idx = await filterBtn(page, key).evaluate((b) => (b.closest("th") as HTMLTableCellElement).cellIndex);
  return rows(page).evaluateAll(
    (trs, i) => trs.map((tr) => {
      const t = ((tr as HTMLTableRowElement).cells[i] as HTMLElement).innerText.trim();
      return /^[\d.]+$/.test(t) ? Number(t) : 0;
    }),
    idx,
  );
}
/** 合計行の、見出しの key の列の値 */
async function footValue(page: Page, key: string): Promise<number> {
  const idx = await filterBtn(page, key).evaluate((b) => (b.closest("th") as HTMLTableCellElement).cellIndex);
  const t = await table(page).locator("tfoot tr").first().evaluate((tr, i) => ((tr as HTMLTableRowElement).cells[i] as HTMLElement).innerText.trim(), idx);
  return Number(t);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("yojitsu-navi:masters-draft:v1"));
});

test("月の列を人月の範囲で絞ると、その月が範囲内の人だけになり、合計行も作り直す。「絞り込みを解除」で戻る", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/plan");
  const key = `m:${asOfMonth}`;
  const total = await rows(page).count();
  expect(total).toBeGreaterThan(3);
  await expect(count(page)).toHaveText(new RegExp(`^${total} / ${total} `));
  await filterBtn(page, key).click();
  await expect(pop(page)).toBeVisible();
  await expect(pop(page).locator(".yn-filter-unit")).toHaveText("人月");
  await pop(page).getByRole("textbox").first().fill("1.01");
  await expect(async () => {
    const vals = await colValues(page, key);
    expect(vals.length).toBeGreaterThan(0);
    expect(vals.length).toBeLessThan(total);
    for (const v of vals) expect(v).toBeGreaterThanOrEqual(1.01);
  }).toPass();
  await page.keyboard.press("Escape");
  await expect(pop(page)).toHaveCount(0);
  const n = await rows(page).count();
  await expect(count(page)).toHaveText(new RegExp(`^${n} / ${total} `));
  await expect(filterBtn(page, key)).toHaveClass(/is-active/);
  // 合計行は残った人の合計
  const sum = (await colValues(page, key)).reduce((a, b) => a + b, 0);
  expect(Math.abs((await footValue(page, key)) - sum)).toBeLessThan(0.011 * n);
  // 再読み込みしても残る（タブ単位）
  await page.reload();
  await expect(rows(page)).toHaveCount(n);
  await page.locator(".yn-me-plan-filter").getByRole("button", { name: "絞り込みを解除" }).click();
  await expect(rows(page)).toHaveCount(total);
  await expect(page.locator(".yn-me-plan-filter").getByRole("button", { name: "絞り込みを解除" })).toHaveCount(0);
  await expect(filterBtn(page, key)).not.toHaveClass(/is-active/);
});

test("並べ替え: 月の列は最初に押すと多い順、もう一度で少ない順。名前は五十音順。開いた明細は人の行について動く", async ({ page }) => {
  await gotoPage(page, "/plan");
  const key = `m:${asOfMonth}`;
  await sortBtn(page, key).click();
  const th = sortBtn(page, key).locator("xpath=ancestor::th");
  await expect(th).toHaveAttribute("aria-sort", "descending");
  const desc = await colValues(page, key);
  expect(desc).toEqual([...desc].sort((a, b) => b - a));
  await expect(sortBtn(page, key)).toBeFocused();
  await sortBtn(page, key).click();
  await expect(th).toHaveAttribute("aria-sort", "ascending");
  const asc = await colValues(page, key);
  expect(asc).toEqual([...asc].sort((a, b) => a - b));

  await sortBtn(page, "__name").click();
  await expect(sortBtn(page, "__name").locator("xpath=ancestor::th")).toHaveAttribute("aria-sort", "ascending");
  await expect(th).toHaveAttribute("aria-sort", "none");
  const ns = await names(page);
  expect(ns).toEqual([...ns].sort((a, b) => a.localeCompare(b, "ja", { numeric: true })));
  // 2 人目を開いて降順にすると、明細はその人の行の直後に付いたまま
  const second = rows(page).nth(1);
  const member = (await second.getAttribute("data-member"))!;
  await second.getByRole("button", { name: /作業/ }).first().click();
  await sortBtn(page, "__name").click();
  await expect(sortBtn(page, "__name").locator("xpath=ancestor::th")).toHaveAttribute("aria-sort", "descending");
  const next = table(page).locator(`tbody tr[data-member="${member}"].yn-me-plan-row + tr`);
  await expect(next).toHaveAttribute("data-parent", member);
});

test("名前の列は値の一覧で選べ、検索欄と重ねて効く。表示する月を変えて無くなった月の絞り込みは外れる", async ({ page }) => {
  await gotoPage(page, "/plan");
  const total = await rows(page).count();
  await filterBtn(page, "__name").click();
  const first = pop(page).locator(".yn-filter-list label").first();
  const name = (await first.locator(".yn-filter-item-text").innerText()).trim();
  await pop(page).getByRole("searchbox").fill(name);
  await expect(rows(page)).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect((await names(page))[0]).toBe(name);
  // 検索欄と重ねる（一致しない語なら 0 人）
  await page.locator("#yn-me-plan-q").fill("該当しない語ZZZ");
  await expect(rows(page)).toHaveCount(0);
  await page.locator("#yn-me-plan-q").fill("");
  await expect(rows(page)).toHaveCount(1);
  await page.locator(".yn-me-plan-filter").getByRole("button", { name: "絞り込みを解除" }).click();
  await expect(rows(page)).toHaveCount(total);

  // 今月で絞ってから、今月を含まない範囲へ動かすと絞り込みは外れる
  const key = `m:${asOfMonth}`;
  await filterBtn(page, key).click();
  await pop(page).getByRole("textbox").first().fill("1.01");
  await expect(async () => expect(await rows(page).count()).toBeLessThan(total)).toPass();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "1か月先へ" }).click();
  await expect(rows(page)).toHaveCount(total);
  await expect(page.locator(".yn-me-plan-filter").getByRole("button", { name: "絞り込みを解除" })).toHaveCount(0);
});

for (const width of [390, 1280]) {
  test(`見出しの並べ替え・漏斗が ${width}px・ダークでも収まり、ページが横にはみ出さない`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await useDarkTheme(page);
    await gotoPage(page, "/plan");
    await expect(filterBtn(page, `m:${asOfMonth}`)).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // 月の見出しは 1 行（並べ替えの印と漏斗が折り返さない）
    const heights = await table(page).locator("thead th.num .yn-sort-main").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    for (const h of heights) expect(h).toBeLessThan(30);
  });
}
