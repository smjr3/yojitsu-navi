/**
 * 文字の大きさ（SPEC §111）: 設定画面で 5 段階から選び、全画面の本文・表・グラフの文字が変わる。上部のタブ・フィルタは標準のまま
 */
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";

const SIZES: [string, string, number][] = [
  ["s", "小", 0.9],
  ["m", "標準", 1],
  ["l", "やや大", 1.1],
  ["xl", "大", 1.25],
  ["xxl", "特大", 1.4],
];

const px = (loc: import("@playwright/test").Locator) => loc.evaluate((e) => parseFloat(getComputedStyle(e).fontSize));

test.describe("文字の大きさ", () => {
  test("設定画面で 5 段階から選べ、本文・表・グラフの文字が変わり、次の画面でも続く。上部は変わらない", { tag: "@smoke" }, async ({ page }) => {
    await gotoPage(page, "/settings");
    const radios = page.locator('input[name="yn-set-text-size"]');
    await expect(radios).toHaveCount(5);
    for (const [v, label] of SIZES) await expect(page.locator(`input[name="yn-set-text-size"][value="${v}"]`).locator("xpath=..")).toHaveText(label);
    await expect(page.locator('input[name="yn-set-text-size"][value="m"]')).toBeChecked();

    await gotoPage(page, "/contracts");
    const cell = page.locator("#observablehq-main table td").first();
    const tab = page.locator(".yn-tab").first();
    const tick = page.locator("#observablehq-main figure svg").first();
    const base = { cell: await px(cell), tab: await px(tab) };
    await gotoPage(page, "/");
    const baseTick = await px(tick);

    await gotoPage(page, "/settings");
    await page.locator('input[name="yn-set-text-size"][value="xxl"]').check();
    await expect(page.locator("html")).toHaveAttribute("data-text-size", "xxl");

    await gotoPage(page, "/contracts");
    await expect(page.locator("html")).toHaveAttribute("data-text-size", "xxl");
    expect(await px(cell)).toBeCloseTo(base.cell * 1.4, 0);
    expect(await px(tab)).toBe(base.tab);
    await gotoPage(page, "/");
    expect(await px(tick)).toBeCloseTo(baseTick * 1.4, 0);

    // 標準に戻すと属性が消える
    await gotoPage(page, "/settings");
    await page.locator('input[name="yn-set-text-size"][value="m"]').check();
    await expect(page.locator("html")).not.toHaveAttribute("data-text-size", /.*/);
  });

  for (const width of [390, 768, 1024, 1280]) {
    test(`特大でも横にはみ出さない（幅 ${width}px・ライト/ダーク）`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(() => localStorage.setItem("yn-text-size", "xxl"));
      for (const dark of [false, true]) {
        if (dark) await useDarkTheme(page);
        for (const path of ["/", "/contracts", "/plan", "/masters", "/settings"]) {
          await gotoPage(page, path);
          const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          expect(over, `${path} dark=${dark}`).toBeLessThanOrEqual(0);
        }
      }
    });
  }
});
