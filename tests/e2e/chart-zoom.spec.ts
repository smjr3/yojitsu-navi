/**
 * グラフの拡大表示（全グラフ共通）: 拡大ボタン → ダイアログでグラフを広く描き直す。
 * 各画面幅・ライト/ダークで、開く・閉じる・画面からはみ出さない・ツールチップが出ることを確かめる
 */
import type { Page } from "@playwright/test";
import { test, expect, useDarkTheme, gotoPage } from "./helpers/app.js";

const zoomDialog = (page: Page) => page.locator("dialog.yn-chart-zoom[open]");

/** グラフのある画面（拡大ボタンが 1 つ以上ある） */
const PAGES = ["/", "/team?id=S21", "/contract?id=C002", "/customer?key=%E9%9D%92%E8%91%89%E7%89%A9%E6%B5%81", "/member?id=M011", "/workload"];

async function openZoom(page: Page) {
  const btn = page.locator(".yn-chart-zoom-btn").first();
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  await expect(zoomDialog(page)).toBeVisible();
  await expect(zoomDialog(page).locator(".yn-chart-zoom-plot svg").first()).toBeVisible();
}

/** ダイアログ内のグラフの大きさとはみ出し */
const zoomGeometry = (page: Page) =>
  page.evaluate(() => {
    const d = document.querySelector("dialog.yn-chart-zoom") as HTMLElement;
    const host = d.querySelector(".yn-chart-zoom-plot") as HTMLElement;
    const svg = host.querySelector("svg") as SVGSVGElement;
    const r = d.getBoundingClientRect();
    return {
      dialog: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
      svgW: svg.getBoundingClientRect().width,
      svgH: svg.getBoundingClientRect().height,
      hostW: host.clientWidth,
      hScroll: host.scrollWidth - host.clientWidth,
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  });

test.describe("グラフの拡大表示", () => {
  for (const path of PAGES) {
    test(`${path}: 拡大ボタンで開き、元より大きく描いて、閉じるとボタンに戻る`, async ({ page }) => {
      await gotoPage(page, path);
      const card = page.locator(".yn-chart-card").first();
      await expect(card.locator(".yn-chart-plot svg").first()).toBeVisible();
      const inline = await card.locator(".yn-chart-plot svg").first().boundingBox();
      await openZoom(page);
      // 何のグラフか分かる見出し（グラフ名＋画面名・期間）
      await expect(zoomDialog(page).locator(".yn-dialog-title")).not.toBeEmpty();
      await expect(zoomDialog(page).locator(".yn-chart-zoom-sub")).toContainText(/\d{4}年\d{1,2}月/);
      // 凡例も一緒に出す
      await expect(zoomDialog(page).locator(".yn-legend li").first()).toBeVisible();
      const g = await zoomGeometry(page);
      expect(g.svgW).toBeGreaterThanOrEqual(inline!.width - 1);
      expect(g.svgH).toBeGreaterThan(inline!.height);
      expect(g.hScroll).toBeLessThanOrEqual(1);
      await page.keyboard.press("Escape");
      await expect(zoomDialog(page)).toHaveCount(0);
      await expect(page.locator(".yn-chart-zoom-btn").first()).toBeFocused();
    });
  }

  test("工数タブ: 分布グラフは画面では上位 20 件、拡大すると全件を出す", async ({ page }) => {
    await gotoPage(page, "/workload?axis=member");
    const card = page.locator(".yn-chart-card").nth(1);
    await expect(card.locator(".yn-chart-plot svg").first()).toBeVisible();
    const yTicks = (root: import("@playwright/test").Locator) => root.locator("svg [aria-label='y-axis tick label'] text").count();
    const inline = await yTicks(card.locator(".yn-chart-plot"));
    expect(inline).toBeLessThanOrEqual(20);
    const trimmed = (await card.locator(".yn-note").count()) > 0;
    await card.locator(".yn-chart-zoom-btn").click();
    await expect(zoomDialog(page).locator(".yn-chart-zoom-plot svg").first()).toBeVisible();
    const zoomed = await yTicks(zoomDialog(page).locator(".yn-chart-zoom-plot"));
    if (trimmed) expect(zoomed).toBeGreaterThan(inline);
    else expect(zoomed).toBe(inline);
    expect((await zoomGeometry(page)).hScroll).toBeLessThanOrEqual(1);
  });

  test("× ボタンと背景のクリックでも閉じる", async ({ page }) => {
    await gotoPage(page, "/");
    await openZoom(page);
    await zoomDialog(page).locator(".yn-dialog-close").click();
    await expect(zoomDialog(page)).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 800 });
    await openZoom(page);
    await page.mouse.click(4, 4);
    await expect(zoomDialog(page)).toHaveCount(0);
  });

  test("キーボードだけで開ける（Tab で移動して Enter）", async ({ page }) => {
    await gotoPage(page, "/");
    const btn = page.locator(".yn-chart-zoom-btn").first();
    await btn.focus();
    await page.keyboard.press("Enter");
    await expect(zoomDialog(page)).toBeVisible();
    await expect(zoomDialog(page).locator(".yn-dialog-close")).toBeFocused();
  });

  test("拡大したグラフでもマウスを乗せると値の吹き出しが出る", async ({ page }) => {
    await gotoPage(page, "/");
    await openZoom(page);
    const svg = zoomDialog(page).locator(".yn-chart-zoom-plot svg").first();
    const bb = (await svg.boundingBox())!;
    await page.mouse.move(bb.x + bb.width * 0.4, bb.y + bb.height * 0.6);
    await expect(svg.locator("[aria-label=tip]").first()).toBeVisible();
  });

  test("ウィンドウの大きさを変えると拡大中のグラフも描き直す", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoPage(page, "/");
    await openZoom(page);
    const before = await zoomGeometry(page);
    await page.setViewportSize({ width: 900, height: 700 });
    await expect.poll(async () => (await zoomGeometry(page)).svgW).toBeLessThan(before.svgW - 100);
    expect((await zoomGeometry(page)).hScroll).toBeLessThanOrEqual(1);
  });

  const SIZES = [
    { name: "スマホ縦", width: 390, height: 844 },
    { name: "スマホ横", width: 844, height: 390 },
    { name: "タブレット", width: 768, height: 1024 },
    { name: "PC", width: 1280, height: 800 },
  ];
  for (const dark of [false, true]) {
    for (const s of SIZES) {
      test(`${s.name}（${s.width}×${s.height}・${dark ? "ダーク" : "ライト"}）: 画面に収まり、横スクロールが出ない`, async ({ page }) => {
        await page.setViewportSize({ width: s.width, height: s.height });
        if (dark) await useDarkTheme(page);
        await gotoPage(page, "/");
        await openZoom(page);
        const g = await zoomGeometry(page);
        expect(g.dialog.left).toBeGreaterThanOrEqual(-1);
        expect(g.dialog.right).toBeLessThanOrEqual(g.vw + 1);
        expect(g.dialog.top).toBeGreaterThanOrEqual(-1);
        expect(g.dialog.bottom).toBeLessThanOrEqual(g.vh + 1);
        expect(g.hScroll).toBeLessThanOrEqual(1);
        // 狭い画面・横向きのスマホは全画面で使う
        if (s.width <= 640 || s.height <= 500) {
          expect(g.dialog.right - g.dialog.left).toBeGreaterThanOrEqual(g.vw - 1);
        }
        // 縦向きのスマホだけ「横向きにすると見やすい」の案内を出す
        await expect(zoomDialog(page).locator(".yn-chart-zoom-rotate")).toBeVisible({ visible: s.width <= 640 && s.height > s.width });
        // 背景のページはスクロールしない
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe("hidden");
      });
    }
  }
});
