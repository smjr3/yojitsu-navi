/**
 * 開閉の印（SPEC §143）: 組織ツリー・リソース計画の人の行・データ確認の節・案件の期間の分類・
 * 「表で見る」などの開閉を、同じ見た目（枠の付いた四角の中に向き）にそろえる
 * - 印は 20px 四方以上・枠あり・文字の大きさに追随。▸／▾ の文字は使わない
 * - 組織ツリーの開閉は印の少し外を押しても開閉し、キーボード（Enter）でも開閉、aria-expanded が変わる
 * - 長いチーム名が折り返しても、2 行目が字下げの位置にそろう（左端に戻らない）
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme, tableByCaption } from "./helpers/app.js";

const box = (loc: Locator) => loc.evaluate((e) => {
  const r = e.getBoundingClientRect();
  const cs = getComputedStyle(e);
  return { w: r.width, h: r.height, x: r.x, y: r.y, border: parseFloat(cs.borderTopWidth) };
});

const PLACES: [string, string, (page: Page) => Locator][] = [
  ["組織ツリー", "/teams", (p) => p.locator(".yn-tree-toggle .yn-disc").first()],
  ["リソース計画の人の行", "/plan", (p) => p.locator(".yn-me-plan-toggle .yn-disc").first()],
  ["リソース計画のすべて開く", "/plan", (p) => p.locator(".yn-me-plan-expand-all .yn-disc")],
  ["データ確認の節", "/data-check", (p) => p.locator(".yn-fold-toggle .yn-disc").first()],
  ["案件の期間の分類", "/contracts?view=timeline", (p) => p.locator(".yn-tl-group-btn .yn-disc").first()],
  ["表で見る", "/", (p) => p.locator(".yn-details > summary .yn-disc").first()],
];

test("開閉の印はどの画面も同じ大きさの枠付きの四角で、▸／▾ の文字を使わない", { tag: "@smoke" }, async ({ page }) => {
  for (const [name, path, pick] of PLACES) {
    await gotoPage(page, path);
    const disc = pick(page);
    await expect(disc, name).toBeVisible();
    const b = await box(disc);
    expect(b.w, name).toBeGreaterThanOrEqual(19.5);
    expect(b.h, name).toBeGreaterThanOrEqual(19.5);
    expect(b.border, name).toBeGreaterThanOrEqual(1);
    await expect(disc, name).toHaveText("");
  }
  await gotoPage(page, "/teams");
  expect(await page.locator("#observablehq-main .yn-tree-toggle").evaluateAll((els) => els.filter((e) => /[▸▾]/.test(e.textContent ?? "")).length)).toBe(0);
});

test("開閉の印は文字の大きさに追随する", async ({ page }) => {
  await gotoPage(page, "/teams");
  const base = await box(page.locator(".yn-tree-toggle .yn-disc").first());
  await page.evaluate(() => localStorage.setItem("yn-text-size", "xxl"));
  await gotoPage(page, "/teams");
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "xxl");
  const big = await box(page.locator(".yn-tree-toggle .yn-disc").first());
  expect(big.w).toBeCloseTo(base.w * 1.4, 0);
});

test("組織ツリー: 印の少し外を押しても開閉し、Enter でも開閉する", async ({ page }) => {
  await gotoPage(page, "/teams");
  const table = tableByCaption(page, "チーム一覧");
  const toggle = table.locator('tbody tr[data-key="D1"] .yn-tree-toggle');
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const b = await box(toggle.locator(".yn-disc"));
  // 印の下端から 4px 外（見た目の四角の外）
  await page.mouse.click(b.x + b.w / 2, b.y + b.h + 4);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page).toHaveURL(/\/teams/);
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

test("組織ツリー: 長いチーム名が折り返しても 2 行目は字下げの位置にそろう（390px・ダーク）", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await useDarkTheme(page);
  await gotoPage(page, "/teams");
  const table = tableByCaption(page, "チーム一覧");
  const misaligned = await table.locator("tbody tr").evaluateAll((rows) =>
    rows.flatMap((tr) => {
      const name = tr.querySelector("th .yn-tree-cell > :last-child");
      const indent = tr.querySelector("th .yn-tree-indent");
      if (!name || !indent) return [];
      const rects = Array.from(name.getClientRects());
      const left = indent.getBoundingClientRect().right;
      return rects.some((r) => r.left < left - 0.5) ? [tr.getAttribute("data-key")] : [];
    }),
  );
  expect(misaligned).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
