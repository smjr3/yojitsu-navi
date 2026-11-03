/**
 * マスタ編集の表の列幅（2026-10-31 試用版のコメント「表が横に大きく一覧で見られない。列の幅を調整できるように」）
 * - 列見出しの右端（区切り）をドラッグ・矢印キーで変え、ダブルクリック・Home で既定に戻す
 * - ファイルごとにこのブラウザへ覚え、再読み込み・行の開閉・タブの切替でも保たれる
 * - 狭くした列は「…」で切り、マウスを載せると全文が出る。行をまたぐ行（エラーの説明）は崩れない
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";

const KEY = "yojitsu-navi:masters-col-width:members";
const panel = (page: Page) => page.locator("#yn-me-panel");
const handle = (page: Page, col: string) => panel(page).locator(`thead .yn-col-resizer[data-col="${col}"]`);
const colWidth = (page: Page, col: string) => handle(page, col).evaluate((h) => Math.round(h.closest("th")!.getBoundingClientRect().width));
const tableOverflow = (page: Page) => panel(page).locator(".yn-me-table-wrap").evaluate((w) => w.scrollWidth - w.clientWidth);

test.beforeEach(async ({ page }) => {
  // 最初の表示の前に 1 回だけ消す（再読み込みでは消さない）
  await page.addInitScript(() => {
    if (sessionStorage.getItem("colw-test-cleared")) return;
    sessionStorage.setItem("colw-test-cleared", "1");
    for (const k of Object.keys(localStorage)) if (k.startsWith("yojitsu-navi:masters-col-width:")) localStorage.removeItem(k);
  });
});

test("列の区切りをドラッグして狭くでき、表が枠に収まる。再読み込みでも保たれ、ダブルクリックで戻る", async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 900 });
  await gotoPage(page, "/masters");
  const team = handle(page, "team_id");
  await expect(team).toHaveAttribute("role", "separator");
  await expect(team).toHaveAttribute("aria-label", /所属チーム/);
  const before = await colWidth(page, "team_id");
  const over = await tableOverflow(page);
  expect(over).toBeGreaterThan(0);

  const box = (await team.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // はみ出している分より少し多く狭くする
  await page.mouse.move(box.x + box.width / 2 - over - 30, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const after = await colWidth(page, "team_id");
  expect(after).toBeLessThan(before - over);
  // 本文の同じ列のセルも同じ幅
  const cellW = await panel(page).locator("tbody tr.yn-me-group").first().evaluate((tr, i) => Math.round((tr as HTMLTableRowElement).cells[i]!.getBoundingClientRect().width), await handle(page, "team_id").evaluate((h) => (h.closest("th") as HTMLTableCellElement).cellIndex));
  expect(Math.abs(cellW - after)).toBeLessThanOrEqual(1);
  expect(await tableOverflow(page)).toBeLessThanOrEqual(0);
  expect(JSON.parse((await page.evaluate((k) => localStorage.getItem(k), KEY))!)).toEqual({ team_id: after });

  // 入りきらない欄は「…」で切り、マウスを載せると全文
  const clipped = panel(page).locator("tbody td.is-col-sized", { hasText: "ネットワーク保守チーム" }).first();
  await clipped.hover();
  await expect(clipped).toHaveAttribute("title", /ネットワーク保守チーム/);
  expect(await clipped.evaluate((c) => getComputedStyle(c).overflowX)).toBe("hidden");

  await page.reload();
  await expect(panel(page).locator("table.yn-me-ledger")).toBeVisible();
  expect(Math.abs((await colWidth(page, "team_id")) - after)).toBeLessThanOrEqual(1);
  await expect(handle(page, "team_id")).toHaveAttribute("aria-valuenow", String(after));

  // 行を開いて描き直しても、開いた履歴の行も同じ幅
  await panel(page).locator(".yn-me-hist-toggle").first().click();
  const hist = panel(page).locator("tr.yn-me-hist").first();
  await expect(hist).toBeVisible();
  expect(Math.abs((await colWidth(page, "team_id")) - after)).toBeLessThanOrEqual(1);
  const idx = await handle(page, "team_id").evaluate((h) => (h.closest("th") as HTMLTableCellElement).cellIndex);
  expect(Math.abs((await hist.evaluate((tr, i) => Math.round((tr as HTMLTableRowElement).cells[i]!.getBoundingClientRect().width), idx)) - after)).toBeLessThanOrEqual(1);

  await handle(page, "team_id").dblclick();
  expect(Math.abs((await colWidth(page, "team_id")) - before)).toBeLessThanOrEqual(2);
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull();
  await expect(panel(page).locator(".is-col-sized")).toHaveCount(0);
});

test("矢印キーで変えられ、上限・下限で止まる。Home で戻る。ファイルごとに別に覚える", async ({ page }) => {
  await gotoPage(page, "/masters");
  const lead = handle(page, "__lead");
  await lead.focus();
  for (let i = 0; i < 30; i++) await page.keyboard.press("Shift+ArrowLeft");
  await expect(lead).toHaveAttribute("aria-valuenow", "40");
  // 名前の列は狭くしても表の中に収まり、ページは横にはみ出さない
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.keyboard.press("ArrowRight");
  await expect(lead).toHaveAttribute("aria-valuenow", "50");
  await page.keyboard.press("Home");
  await expect(lead).not.toHaveAttribute("aria-valuenow", /.*/);

  await handle(page, "title").focus();
  for (let i = 0; i < 20; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect(handle(page, "title")).toHaveAttribute("aria-valuenow", "640");

  // 単価の表は別に覚える（メンバーの幅は持ち込まない）
  await page.getByRole("tab", { name: /単価/ }).click();
  await expect(panel(page).locator("thead .yn-col-resizer").first()).toBeVisible();
  await expect(panel(page).locator(".is-col-sized")).toHaveCount(0);
  const first = panel(page).locator("thead .yn-col-resizer").nth(1);
  await first.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  const col = (await first.getAttribute("data-col"))!;
  expect(Object.keys(JSON.parse((await page.evaluate(() => localStorage.getItem("yojitsu-navi:masters-col-width:rates")))!))).toEqual([col]);
  await page.getByRole("tab", { name: /メンバー/ }).click();
  await expect(handle(page, "title")).toHaveAttribute("aria-valuenow", "640");
});

test("名前の列を広く覚えたまま狭い画面で開いても、表示幅の 6 割までで他の列が見える", async ({ page }) => {
  await page.addInitScript((k) => localStorage.setItem(k, JSON.stringify({ __lead: 640 })), KEY);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoPage(page, "/masters");
  expect(await colWidth(page, "__lead")).toBeLessThanOrEqual(Math.floor(390 * 0.6) + 1);
  await expect(handle(page, "__lead")).toHaveAttribute("aria-valuenow", String(Math.floor(390 * 0.6)));
  await expect(handle(page, "__lead")).toBeInViewport();
  const lead = handle(page, "__lead");
  await lead.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(lead).toHaveAttribute("aria-valuenow", String(Math.floor(390 * 0.6)));
});

test("ダーク・スマホ幅でも区切りが見え、狭くした列で行の高さが崩れない", async ({ page }) => {
  await useDarkTheme(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoPage(page, "/masters");
  const dept = handle(page, "department");
  await expect(dept).toBeVisible();
  const rowH = await panel(page).locator("tbody tr.yn-me-group").first().evaluate((tr) => Math.round(tr.getBoundingClientRect().height));
  await dept.focus();
  for (let i = 0; i < 30; i++) await page.keyboard.press("Shift+ArrowLeft");
  await expect(dept).toHaveAttribute("aria-valuenow", "40");
  const rowH2 = await panel(page).locator("tbody tr.yn-me-group").first().evaluate((tr) => Math.round(tr.getBoundingClientRect().height));
  expect(Math.abs(rowH2 - rowH)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("在籍の列は理由（退職・休職など）を出さず一律「不在」（§35）", async ({ page }) => {
  await gotoPage(page, "/masters");
  const idx = await handle(page, "status").evaluate((h) => (h.closest("th") as HTMLTableCellElement).cellIndex);
  const texts = await panel(page).locator("tbody tr.yn-me-group").evaluateAll((trs, i) => trs.map((tr) => (tr as HTMLTableRowElement).cells[i]!.innerText.trim()), idx);
  expect(texts).toContain("不在");
  for (const t of texts) expect(["不在", "在籍", "—", ""]).toContain(t);
});
