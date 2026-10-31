/**
 * 一覧表（dataTable）の列幅（SPEC §76。マスタ編集の列幅 §73 の横展開）
 * - 見出しの右端の境目をドラッグ・矢印キーで変え、ダブルクリック・Home で既定に戻す
 * - 画面と表ごとにこのブラウザへ覚え、並べ替え・絞り込み・再読み込みで保つ
 * - 狭くした列は「…」で切り、合計行も同じ幅。境目は並べ替え・絞り込みのボタンを邪魔しない
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect, gotoPage, tableByCaption, dataRows, useDarkTheme } from "./helpers/app.js";

const handle = (table: Locator, key: string) => table.locator(`thead th[data-key="${key}"] .yn-col-resizer`);
const width = (table: Locator, key: string) => table.locator(`thead th[data-key="${key}"]`).evaluate((th) => Math.round(th.getBoundingClientRect().width));

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("tcolw-cleared")) return;
    sessionStorage.setItem("tcolw-cleared", "1");
    for (const k of Object.keys(localStorage)) if (k.startsWith("yojitsu-navi:col-width:")) localStorage.removeItem(k);
  });
});

/** 境目の左寄り（自分の見出しの内側）をつかんで dx だけ動かす */
async function drag(page: Page, h: Locator, dx: number) {
  const b = (await h.boundingBox())!;
  const x = b.x + 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 5 });
  await page.mouse.up();
}

test("チーム一覧: 名前の列をドラッグで広げると全文が見え、再読み込みでも保たれ、ダブルクリックで戻る", { tag: "@smoke" }, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoPage(page, "/teams");
  const table = tableByCaption(page, "チーム一覧");
  const h = handle(table, "name");
  await expect(h).toHaveAttribute("role", "separator");
  await expect(h).toHaveAttribute("aria-label", /チーム/);
  const before = await width(table, "name");
  await drag(page, h, 120);
  const after = await width(table, "name");
  expect(after).toBeGreaterThan(before + 100);
  // 本文の行も同じ幅
  const cellW = await dataRows(table).first().locator("th").evaluate((c) => Math.round(c.getBoundingClientRect().width));
  expect(Math.abs(cellW - after)).toBeLessThanOrEqual(1);
  await page.reload();
  const t2 = tableByCaption(page, "チーム一覧");
  await expect(dataRows(t2).first()).toBeVisible();
  expect(Math.abs((await width(t2, "name")) - after)).toBeLessThanOrEqual(1);
  // ダブルクリックで既定に戻す
  await handle(t2, "name").dblclick({ position: { x: 2, y: 8 } });
  expect(Math.abs((await width(t2, "name")) - before)).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("yojitsu-navi:col-width:")))).toEqual([]);
});

test("案件一覧: 矢印キーで狭くすると「…」で切れ、合計行も同じ幅。並べ替え・絞り込みでも保たれる。境目の操作では並べ替えない", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoPage(page, "/contracts?unit=yen");
  const table = tableByCaption(page, "案件一覧");
  const h = handle(table, "budget");
  const before = await width(table, "budget");
  const sortBefore = await table.locator('thead th[data-key="budget"]').getAttribute("aria-sort");
  await h.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowLeft");
  const narrow = await width(table, "budget");
  expect(narrow).toBeLessThan(before - 100);
  await expect(table.locator('thead th[data-key="budget"]')).toHaveAttribute("aria-sort", sortBefore ?? "none");
  await expect(h).toHaveAttribute("aria-valuenow", String(narrow));
  // 「…」で切れる（セルの中身がはみ出さない）
  const cell = table.locator("tbody tr[data-key]").first().locator("td").nth(await table.locator('thead th[data-key="budget"]').evaluate((th) => (th as HTMLTableCellElement).cellIndex - 1));
  await expect(cell).toHaveClass(/is-col-sized/);
  const foot = table.locator("tfoot td").nth(await table.locator('thead th[data-key="budget"]').evaluate((th) => (th as HTMLTableCellElement).cellIndex));
  await expect(foot).toHaveClass(/is-col-sized/);
  // 並べ替え（別の列）と絞り込み（状態）をしても幅は保たれる
  await table.locator('thead th[data-key="cost"] .yn-sort').click();
  expect(Math.abs((await width(table, "budget")) - narrow)).toBeLessThanOrEqual(1);
  await table.locator('thead th[data-key="status"] .yn-filter-btn').click();
  await page.locator(".yn-filter-pop .yn-filter-list input").first().uncheck();
  await page.keyboard.press("Escape");
  expect(Math.abs((await width(table, "budget")) - narrow)).toBeLessThanOrEqual(1);
  // Home で既定（中身に合わせる）に戻す（絞り込みで中身が変わったので幅は比べない）
  await h.focus();
  await page.keyboard.press("Home");
  await expect(h).not.toHaveAttribute("aria-valuenow", /./);
  await expect(table.locator('thead th[data-key="budget"]')).not.toHaveClass(/is-col-sized/);
  expect(await width(table, "budget")).toBeGreaterThan(narrow);
});

test("390px・ダーク: 境目があってもページ幅は崩れず、一覧の表は今までどおり枠の中で横スクロール", async ({ page }) => {
  await useDarkTheme(page);
  await page.setViewportSize({ width: 390, height: 800 });
  for (const path of ["/teams", "/contracts", "/members"]) {
    await gotoPage(page, path);
    await expect(page.locator("table.yn-table").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(390);
  }
});
