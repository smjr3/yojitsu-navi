/**
 * 広い画面で横幅を使い切る（SPEC §85。2026-11-03 依頼者「横幅が使えるならもっと広げて。マスタ編集の一覧が横に切れてスクロールしないと見られない」）
 * - 本文に最大幅を設けない（1920px・2560px でも左右の余白を除いた幅いっぱい）
 * - マスタ編集の表は、長いチーム名・組織名・氏名を折り返し、1280px 以上なら全タブが横スクロールなしで収まる
 * - 一覧表の名前列は、広い画面では上限を広げて省略を減らす
 */
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";

const TABS = ["メンバー", "単価", "組織", "案件", "目標", "祝日"];

for (const width of [1280, 1440, 1920]) {
  test(`${width}px: マスタ編集の全タブの表が横スクロールなしで収まり、ページも横にはみ出さない`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await gotoPage(page, "/masters");
    for (const tab of TABS) {
      await page.locator(".yn-me-tab", { hasText: tab }).click();
      const wrap = page.locator("#yn-me-panel .yn-me-table-wrap");
      await expect(wrap).toBeVisible();
      const over = await wrap.evaluate((w) => w.scrollWidth - w.clientWidth);
      expect(over, `${tab} の表のはみ出し`).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    }
  });
}

test("マスタ編集: 長い値は折り返し（省略しない）、開いた履歴の行も同じ扱い", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoPage(page, "/masters");
  const cell = page.locator("#yn-me-panel tbody tr.yn-me-group td.is-val").first();
  expect(await cell.evaluate((c) => getComputedStyle(c).whiteSpace)).toBe("normal");
  await page.locator("#yn-me-panel .yn-me-hist-toggle").first().click();
  const histCell = page.locator("#yn-me-panel tbody tr.yn-me-hist td.is-val").first();
  await expect(histCell).toBeVisible();
  expect(await histCell.evaluate((c) => getComputedStyle(c).whiteSpace)).toBe("normal");
});

for (const path of ["/contracts", "/teams", "/customers", "/members", "/workload", "/plan", "/masters"]) {
  test(`2560px・ダーク: ${path} の本文が横いっぱい（最大幅なし）で、横スクロールが出ない`, async ({ page }) => {
    await useDarkTheme(page);
    await page.setViewportSize({ width: 2560, height: 900 });
    await gotoPage(page, path);
    const r = await page.evaluate(() => ({
      main: document.querySelector("#observablehq-main")!.getBoundingClientRect().width,
      over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    expect(r.main).toBeGreaterThanOrEqual(2560 - 64 - 20);
    expect(r.over).toBeLessThanOrEqual(0);
  });
}

test("案件一覧: 広い画面では名前列の上限が広がり、省略される案件名が減る（極端に長い名前は従来どおり「…」）", async ({ page }) => {
  const clippedAt = async (width: number) => {
    await page.setViewportSize({ width, height: 900 });
    await gotoPage(page, "/contracts");
    return page.locator(".yn-table tbody .yn-cell-main").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
  };
  const narrow = await clippedAt(1440);
  const wide = await clippedAt(2560);
  expect(narrow).toBeGreaterThan(0);
  expect(wide).toBeLessThan(narrow);
});
