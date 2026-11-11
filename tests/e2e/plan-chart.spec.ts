/**
 * リソース計画の月別の合計グラフ（SPEC §58）: 表の上に運用保守・運用保守以外の積み上げ棒、人数 × 1.0 の破線、
 * 1.0 人月を超える人がいる月の人数。表の絞り込みに連動し、狭い画面でも人数の表示が重ならない
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";

const chart = (page: Page) => page.locator("figure.yn-me-plan-chart");

/** 表から、月ごとの「1.0 超の人数」を数える（グラフの「!n人」と比べる） */
async function overCountsFromTable(page: Page): Promise<number[]> {
  return page.locator("tr.yn-me-plan-row").evaluateAll((rows) => {
    const counts: number[] = [];
    for (const r of rows) {
      r.querySelectorAll("td.yn-me-plan-cell").forEach((td, i) => {
        counts[i] = (counts[i] ?? 0) + (td.classList.contains("is-over") ? 1 : 0);
      });
    }
    return counts;
  });
}

async function overLabels(page: Page): Promise<string[]> {
  return chart(page).locator("svg text").evaluateAll((els) => els.map((e) => e.textContent ?? "").filter((t) => /^1\.0超 \d+人$|^\d+人$/.test(t)));
}

test("月別の合計: 表の上に出て、1.0 超の人数が表の黄色のセルの数と一致する", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/plan?team=S11");
  await expect(chart(page).locator('svg[role="img"]')).toBeVisible();
  await expect(chart(page).locator(".yn-legend")).toContainText("運用保守以外");
  await expect(chart(page).locator(".yn-legend")).toContainText("人数 × 1.0");
  const counts = await overCountsFromTable(page);
  expect(counts.some((n) => n > 0)).toBe(true);
  expect(await overLabels(page)).toEqual(counts.filter((n) => n > 0).map((n) => `1.0超 ${n}人`));
  // グラフは表より上
  const g = await chart(page).boundingBox();
  const t = await page.locator(".yn-me-plan-table").boundingBox();
  expect(g!.y + g!.height).toBeLessThanOrEqual(t!.y);
});

test("月別の合計: 絞り込むとグラフも絞り込んだ人だけ。該当なしならグラフを出さない", async ({ page }) => {
  await gotoPage(page, "/plan?team=S11");
  const search = page.locator("#yn-me-plan-q");
  await search.fill("山田 智也");
  await expect(page.locator("tr.yn-me-plan-row")).toHaveCount(1);
  const counts = await overCountsFromTable(page);
  await expect.poll(() => overLabels(page)).toEqual(counts.filter((n) => n > 0).map((n) => `1.0超 ${n}人`));
  await search.fill("該当しない名前ZZZ");
  await expect(page.locator("tr.yn-me-plan-row")).toHaveCount(0);
  await expect(chart(page)).toHaveCount(0);
});

test("月別の合計: マウスを乗せると月の内訳（運用保守・運用保守以外・合計・人数 × 1.0・1.0 超）", async ({ page }) => {
  await gotoPage(page, "/plan?team=S11");
  const svg = chart(page).locator('svg[role="img"]');
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
  const tip = svg.locator('g[aria-label="tip"]');
  await expect(tip).toContainText("運用保守以外");
  await expect(tip).toContainText("人数 × 1.0");
  await expect(tip).toContainText("1.0 超");
});

for (const [width, dark] of [[390, false], [768, true], [1280, true]] as const) {
  test(`月別の合計: ${width}px${dark ? "・ダーク" : ""}で横にはみ出さず、人数の表示が重ならない`, async ({ page }) => {
    if (dark) await useDarkTheme(page);
    await page.setViewportSize({ width, height: 900 });
    await gotoPage(page, "/plan?team=S11");
    const fig = chart(page);
    await expect(fig.locator('svg[role="img"]')).toBeVisible();
    const f = (await fig.boundingBox())!;
    const s = (await fig.locator('svg[role="img"]').boundingBox())!;
    expect(s.x + s.width).toBeLessThanOrEqual(f.x + f.width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const boxes = await fig.locator("svg text").evaluateAll((els) =>
      els.filter((e) => /^1\.0超 \d+人$|^\d+人$/.test(e.textContent ?? "")).map((e) => {
        const r = e.getBoundingClientRect();
        return { l: r.left, r: r.right };
      }),
    );
    expect(boxes.length).toBeGreaterThan(0);
    boxes.sort((a, b) => a.l - b.l);
    for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.l).toBeGreaterThanOrEqual(boxes[i - 1]!.r);
  });
}

test("月別の合計: 表示モードが自動で PC の設定がダークに変わると、グラフもダークの配色で描き直す", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await gotoPage(page, "/plan?team=S11");
  const svg = chart(page).locator('svg[role="img"]');
  const color = () => svg.evaluate((el) => getComputedStyle(el).color);
  await expect(svg).toBeVisible();
  const light = await color();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  await expect.poll(color).not.toBe(light);
  await expect(chart(page)).toHaveCount(1);
});
