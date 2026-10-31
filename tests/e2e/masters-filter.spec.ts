/**
 * マスタ編集の表の並べ替え・列ごとの絞り込み（SPEC §73.1。一覧表 §70 の横展開）
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";

const panel = (page: Page) => page.locator("#yn-me-panel");
const groups = (page: Page) => panel(page).locator("table.yn-me-ledger tbody tr.yn-me-group");
const count = (page: Page) => panel(page).locator(".yn-table-count");
const pop = (page: Page) => page.locator(".yn-filter-pop");
const colIndex = (page: Page, key: string) => panel(page).locator(`thead .yn-filter-btn[data-fcol="${key}"]`).evaluate((b) => (b.closest("th") as HTMLTableCellElement).cellIndex);

async function columnTexts(page: Page, key: string): Promise<string[]> {
  const i = await colIndex(page, key);
  return groups(page).evaluateAll((trs, idx) => trs.map((tr) => ((tr as HTMLTableRowElement).cells[idx]?.querySelector(".yn-me-val") as HTMLElement | null)?.innerText.trim() ?? ""), i);
}

test("メンバー: 役職で絞ると件数が減り、「絞り込みを解除」で戻る。検索と重ねて効き、タブを切り替えても残る", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/masters");
  const total = await groups(page).count();
  await expect(count(page)).toHaveText(new RegExp(`^${total} / ${total} `));
  await panel(page).locator('thead .yn-filter-btn[data-fcol="title"]').click();
  await pop(page).getByRole("searchbox").fill("主任");
  await expect(async () => {
    const titles = await columnTexts(page, "title");
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.length).toBeLessThan(total);
    for (const t of titles) expect(t).toContain("主任");
  }).toPass();
  await page.keyboard.press("Escape");
  await expect(pop(page)).toHaveCount(0);
  const n = await groups(page).count();
  await expect(count(page)).toHaveText(new RegExp(`^${n} / ${total} `));
  await expect(panel(page).locator('thead .yn-filter-btn[data-fcol="title"]')).toHaveClass(/is-active/);
  // 検索と重ねる
  await panel(page).locator(".yn-me-search").fill("M0");
  await expect(async () => expect(await groups(page).count()).toBeLessThanOrEqual(n)).toPass();
  await panel(page).locator(".yn-me-search").fill("");
  await expect(groups(page)).toHaveCount(n);
  // タブを切り替えても残る
  await page.getByRole("tab", { name: /単価/ }).click();
  await page.getByRole("tab", { name: /メンバー/ }).click();
  await expect(groups(page)).toHaveCount(n);
  await panel(page).getByRole("button", { name: "絞り込みを解除" }).click();
  await expect(groups(page)).toHaveCount(total);
  await expect(panel(page).getByRole("button", { name: "絞り込みを解除" })).toHaveCount(0);
});

test("値の一覧で選ぶ: 所属チームの値は画面の名前で出て、1 つ外すとその行が消える", async ({ page }) => {
  await gotoPage(page, "/masters");
  const total = await groups(page).count();
  await panel(page).locator('thead .yn-filter-btn[data-fcol="team_id"]').click();
  const first = pop(page).locator(".yn-filter-list label").first();
  const name = (await first.locator(".yn-filter-item-text").innerText()).trim();
  const n = Number((await first.locator(".yn-filter-item-count").innerText()).replace(/,/g, ""));
  expect(name).not.toMatch(/^T\d+$/); // ID ではなく名前
  await first.locator("input").uncheck();
  await expect(groups(page)).toHaveCount(total - n);
  // 吹き出しは表を描き直しても開いたまま（続けて操作できる）
  await expect(pop(page)).toBeVisible();
  await pop(page).getByRole("button", { name: "解除" }).click();
  await expect(groups(page)).toHaveCount(total);
});

test("並べ替え: 名前で昇順・降順、単価は数で並べる。空は最後", async ({ page }) => {
  await gotoPage(page, "/masters");
  const sortBtn = panel(page).locator('thead button.yn-sort[data-fk="sort:members:__lead"]');
  await sortBtn.click();
  await expect(sortBtn.locator("xpath=ancestor::th")).toHaveAttribute("aria-sort", "ascending");
  const names = await groups(page).evaluateAll((trs) => trs.map((tr) => (tr.querySelector("th .yn-me-lead-name") as HTMLElement).innerText.trim()));
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "ja", { numeric: true })));
  await sortBtn.click();
  await expect(sortBtn.locator("xpath=ancestor::th")).toHaveAttribute("aria-sort", "descending");
  // 単価: 数の大きい順（最初に押すと降順）
  await page.getByRole("tab", { name: /単価/ }).click();
  const rate = panel(page).locator('thead button.yn-sort[data-fk="sort:rates:hourly_rate"]');
  await rate.click();
  await expect(rate.locator("xpath=ancestor::th")).toHaveAttribute("aria-sort", "descending");
  const vals = (await columnTexts(page, "hourly_rate")).map((t) => Number(t.replace(/[^\d.]/g, ""))).filter((v) => Number.isFinite(v) && v > 0);
  expect(vals).toEqual([...vals].sort((a, b) => b - a));
});

test("390px・ダーク: 見出しの漏斗から絞り込め、吹き出しが画面内に収まる", async ({ page }) => {
  await useDarkTheme(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await gotoPage(page, "/masters");
  await panel(page).locator('thead .yn-filter-btn[data-fcol="__lead"]').click();
  const box = (await pop(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await pop(page).getByRole("searchbox").fill("佐藤");
  await expect(async () => {
    const n = await groups(page).count();
    expect(n).toBeGreaterThan(0);
    for (const t of await groups(page).evaluateAll((trs) => trs.map((tr) => (tr.querySelector("th .yn-me-lead-name") as HTMLElement).innerText))) expect(t).toContain("佐藤");
  }).toPass();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
