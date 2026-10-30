/**
 * 今月の進み（SPEC §59）: 今月を含む期間だけ、全体・チーム・顧客・案件の詳細に出る。KPI の値は core の計算と一致し、
 * チーム詳細にはメンバー×日の表が出る。各画面幅・ダークで画面からはみ出さない
 */
import type { Page } from "@playwright/test";
import { contractsForTeam, dailyMembers, dailyProgress, encodeDaily, formatYen, teamTreeForMonth } from "../../src/core/index.js";
import { test, expect, gotoPage, useDarkTheme, parseNumber } from "./helpers/app.js";
import { getModel } from "./helpers/core.js";

const model = getModel();
const daily = encodeDaily(model);
const asOfMonth = model.meta.asOfMonth;
const TEAM = "T111";
const teamIds = contractsForTeam(model, TEAM, teamTreeForMonth(model, asOfMonth)).map((c) => c.contractId);
const section = (page: Page) => page.locator("#yn-daily");

/** 円表示の KPI の値（円） */
async function kpiYen(page: Page, id: string): Promise<number | null> {
  return parseNumber((await page.locator(`#${id} .yn-kpi-value`).first().textContent()) ?? "");
}

test("今月の進み: 全体・チーム・顧客・案件の詳細に出る（今年度）", { tag: "@smoke" }, async ({ page }) => {
  const contract = teamIds.find((id) => dailyProgress(model, daily, [id]) !== null)!;
  for (const path of ["/", `/team?id=${TEAM}`, `/contract?id=${contract}`]) {
    await gotoPage(page, path);
    await expect(section(page).locator("h2").first()).toContainText("今月の進み");
    await expect(section(page).locator(".yn-kpi")).toHaveCount(4);
    await expect(section(page).locator('svg[role="img"]')).toBeVisible();
  }
  await gotoPage(page, "/customers");
  await page.locator("table tbody tr a").first().click();
  await expect(section(page).locator("h2").first()).toContainText("今月の進み");
});

test("今月の進み: KPI の値が core の計算と一致し、表の最後の累計が今日までの実績", async ({ page }) => {
  const p = dailyProgress(model, daily, teamIds)!;
  await gotoPage(page, `/team?id=${TEAM}&unit=yen`);
  expect(await kpiYen(page, "yn-daily-cap")).toBe(Math.round(p.cap));
  expect(await kpiYen(page, "yn-daily-actual")).toBe(Math.round(p.actual));
  expect(await kpiYen(page, "yn-daily-left")).toBe(Math.round(p.remaining));
  expect(await kpiYen(page, "yn-daily-projection")).toBe(Math.round(p.projection));
  await expect(section(page).locator("#yn-daily-left .yn-kpi-label")).toContainText(`残り ${p.remainingBusinessDays} 営業日`);
  await section(page).locator("summary", { hasText: "表で見る" }).click();
  const rows = section(page).locator("table").first().locator("tbody tr");
  await expect(rows).toHaveCount(p.points.filter((x) => x.cumulative !== null).length);
  await expect(rows.last()).toContainText(formatYen(p.actual, "yen"));
  // 数字を押すと根拠（式）
  await section(page).locator("#yn-daily-projection .yn-kpi-value").click();
  await expect(page.locator("dialog[open]")).toContainText("このペースの月末 =");
});

test("今月の進み: 今月を含まない期間（前年度・先月）では出さない", async ({ page }) => {
  await gotoPage(page, `/team?id=${TEAM}`);
  await expect(section(page)).toHaveCount(1);
  for (const preset of ["prevFy", "lastMonth"]) {
    const btn = page.locator(`button[data-preset="${preset}"]`);
    if ((await btn.count()) === 0 || (await btn.isDisabled())) continue;
    await btn.click();
    await expect(section(page)).toHaveCount(0);
    // 出さないときに「null」の文字を出さない
    await expect(page.locator("#observablehq-main")).not.toContainText("null");
  }
  await page.locator('button[data-preset="thisMonth"]').click();
  await expect(section(page)).toHaveCount(1);
});

test("今月の進み: チーム詳細のメンバー×日の表（累計・計画・残り/日）", async ({ page }) => {
  const p = dailyProgress(model, daily, teamIds)!;
  const rows = dailyMembers(model, daily, p, teamIds);
  await gotoPage(page, `/team?id=${TEAM}`);
  const table = section(page).locator("table.yn-dg");
  await expect(table.locator("tbody tr")).toHaveCount(rows.length);
  // 日の列は今月の日数
  await expect(table.locator("thead th.yn-dg-day")).toHaveCount(p.points.length);
  const first = rows[0]!;
  const tr = table.locator("tbody tr").first();
  await expect(tr.locator("td.yn-dg-num").nth(0)).toHaveText(`${Number(first.total.toFixed(2))}h`);
  // 計画を超えた人は「超過」
  const over = rows.filter((r) => r.plan > 0 && r.remaining < 0).length;
  await expect(table.locator("td.is-over")).toHaveCount(over);
  // 全体・案件詳細には出さない
  await gotoPage(page, "/");
  await expect(section(page).locator("table.yn-dg")).toHaveCount(0);
});

for (const [w, dark] of [
  [390, false],
  [768, true],
  [1280, false],
  [1024, true],
] as const) {
  test(`今月の進み: ${w}px${dark ? "・ダーク" : ""}ではみ出さない`, async ({ page }) => {
    if (dark) await useDarkTheme(page);
    await page.setViewportSize({ width: w, height: 900 });
    await gotoPage(page, `/team?id=${TEAM}&unit=yen`);
    await expect(section(page).locator('svg[role="img"]')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // KPI の値がタイルからはみ出さない
    const clipped = await section(page).locator(".yn-kpi").evaluateAll((tiles) =>
      tiles.filter((t) => {
        const v = t.querySelector(".yn-kpi-value") as HTMLElement | null;
        return v ? v.getBoundingClientRect().right > t.getBoundingClientRect().right + 1 : false;
      }).length,
    );
    expect(clipped).toBe(0);
    // 名前の列は固定（横に送っても見える）
    const wrap = section(page).locator(".yn-dg-wrap");
    await wrap.evaluate((el) => (el.scrollLeft = el.scrollWidth));
    const name = section(page).locator("tbody th.yn-dg-name").first();
    const nb = (await name.boundingBox())!;
    const wb = (await wrap.boundingBox())!;
    expect(nb.x).toBeGreaterThanOrEqual(wb.x - 1);
  });
}
