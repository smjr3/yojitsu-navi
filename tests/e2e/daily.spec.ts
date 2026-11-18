/**
 * 今月の進捗（SPEC §61）: 今月を含む期間だけ、全体・チーム・顧客・案件の詳細に出る。KPI の値は core の計算と一致し、
 * チーム詳細にはメンバー×日の表が出る。各画面幅・ダークで画面からはみ出さない
 */
import type { Page } from "@playwright/test";
import { contractsForTeam, dailyMembers, dailyProgress, dayHoursLines, encodeDaily, formatYen, targetForMonth, teamTreeForMonth, type Model } from "../../src/core/index.js";
import { test, expect, gotoPage, useDarkTheme, parseNumber } from "./helpers/app.js";
import { getModel } from "./helpers/core.js";

const model = getModel();
const daily = encodeDaily(model);
const asOfMonth = model.meta.asOfMonth;
const TEAM = "T111";
const teamIds = contractsForTeam(model, TEAM, teamTreeForMonth(model, asOfMonth)).map((c) => c.contractId);
const section = (page: Page) => page.locator("#yn-daily");
/** 画面と同じ上限（今月を含む目標があれば 予算 ×（1 − 目標の残予算率）） */
const capOpts = (kind: "team" | "customer" | "project", id: string) => {
  const t = targetForMonth(model as Model, kind, id, asOfMonth);
  return t ? { capRatio: 1 - t.remainingRate } : {};
};

/** 円表示の KPI の値（円） */
async function kpiYen(page: Page, id: string): Promise<number | null> {
  return parseNumber((await page.locator(`#${id} .yn-kpi-value`).first().textContent()) ?? "");
}

test("今月の進捗: 全体・チーム・顧客・案件の詳細に出る（今年度）", { tag: "@smoke" }, async ({ page }) => {
  const contract = teamIds.find((id) => dailyProgress(model, daily, [id]) !== null)!;
  for (const path of ["/", `/team?id=${TEAM}`, `/contract?id=${contract}`]) {
    await gotoPage(page, path);
    await expect(section(page).locator("h2").first()).toContainText("今月の進捗");
    await expect(section(page).locator(".yn-kpi")).toHaveCount(4);
    await expect(section(page).locator('svg[role="img"]')).toBeVisible();
  }
  await gotoPage(page, "/customers");
  await page.locator("table tbody tr a").first().click();
  await expect(section(page).locator("h2").first()).toContainText("今月の進捗");
});

test("今月の進捗: KPI の値が core の計算と一致し、表の最後の累計が今日までの実績", async ({ page }) => {
  const p = dailyProgress(model, daily, teamIds, capOpts("team", TEAM))!;
  await gotoPage(page, `/team?id=${TEAM}&unit=yen`);
  expect(await kpiYen(page, "yn-daily-cap")).toBe(Math.round(p.cap));
  expect(await kpiYen(page, "yn-daily-actual")).toBe(Math.round(p.actual));
  expect(await kpiYen(page, "yn-daily-left")).toBe(Math.round(p.remaining));
  expect(await kpiYen(page, "yn-daily-projection")).toBe(Math.round(p.projection));
  await expect(section(page).locator("#yn-daily-left .yn-kpi-label")).toHaveText(`残り ${p.remainingBusinessDays} 営業日の予算`);
  await section(page).locator("summary", { hasText: "表で見る" }).click();
  const rows = section(page).locator("table").first().locator("tbody tr");
  await expect(rows).toHaveCount(p.points.filter((x) => x.cumulative !== null).length);
  await expect(rows.last()).toContainText(formatYen(p.actual, "yen"));
  // 数字を押すと根拠（式）
  await section(page).locator("#yn-daily-projection .yn-kpi-value").click();
  await expect(page.locator("dialog[open]")).toContainText("このペースの月末 =");
});

test("今月の進捗: 今月を含む目標があれば、上限 = 予算 ×（1 − 目標の残予算率）。無ければ予算", async ({ page }) => {
  const teams = Object.keys(teamTreeForMonth(model, asOfMonth));
  const ids = (id: string) => contractsForTeam(model, id, teamTreeForMonth(model, asOfMonth)).map((c) => c.contractId);
  const withTarget = teams.find((id) => targetForMonth(model as Model, "team", id, asOfMonth) && dailyProgress(model, daily, ids(id)));
  const without = teams.find((id) => !targetForMonth(model as Model, "team", id, asOfMonth) && dailyProgress(model, daily, ids(id)));
  expect(withTarget, "ダミーデータに今月を含む目標のあるチームがある").toBeTruthy();
  const t = targetForMonth(model as Model, "team", withTarget!, asOfMonth)!;
  const p = dailyProgress(model, daily, ids(withTarget!), { capRatio: 1 - t.remainingRate })!;
  await gotoPage(page, `/team?id=${withTarget}&unit=yen`);
  expect(await kpiYen(page, "yn-daily-cap")).toBe(Math.round(p.budget * (1 - t.remainingRate)));
  await expect(section(page).locator("#yn-daily-cap .yn-kpi-sub")).toContainText(`目標の残予算率 ${Math.round(t.remainingRate * 100)}%`);
  await section(page).locator("#yn-daily-cap .yn-kpi-value").click();
  await expect(page.locator("dialog[open]")).toContainText("今月の上限 = 今月の予算 ×（1 − 目標の残予算率）");
  await page.keyboard.press("Escape");
  if (without) {
    const q = dailyProgress(model, daily, ids(without))!;
    await gotoPage(page, `/team?id=${without}&unit=yen`);
    expect(await kpiYen(page, "yn-daily-cap")).toBe(Math.round(q.budget));
    await expect(section(page).locator("#yn-daily-cap .yn-kpi-sub")).not.toContainText("目標");
  }
});

test("グラフの目標: 月次推移に「目標の上限」（予算 ×（1 − 目標の残予算率））、今月の進捗の凡例は「上限（目標）」", async ({ page }) => {
  const tree = teamTreeForMonth(model, asOfMonth);
  const ids = (id: string) => contractsForTeam(model, id, tree).map((c) => c.contractId);
  const teams = Object.keys(tree).filter((id) => dailyProgress(model, daily, ids(id)));
  const withTarget = teams.find((id) => targetForMonth(model as Model, "team", id, asOfMonth))!;
  const t = targetForMonth(model as Model, "team", withTarget, asOfMonth)!;
  await gotoPage(page, `/team?id=${withTarget}&unit=yen`);
  const monthly = page.locator(".yn-chart-card").filter({ hasText: "月次推移" }).first();
  await expect(monthly.locator(".yn-legend")).toContainText("目標の上限");
  // 赤の破線が描かれている
  await expect(monthly.locator('svg[role="img"] line[stroke-dasharray="4 2"], svg[role="img"] g[stroke-dasharray="4 2"] line').first()).toBeAttached();
  await monthly.locator("summary", { hasText: "表で見る" }).click();
  const table = monthly.locator("table").first();
  const headers = (await table.locator("thead th").allTextContents()).map((x) => x.trim());
  const ti = headers.findIndex((h) => h.startsWith("目標の上限"));
  const bi = headers.findIndex((h) => h.startsWith("予算"));
  expect(ti).toBeGreaterThan(0);
  const [y, m] = asOfMonth.split("-");
  const row = table.locator("tbody tr").filter({ hasText: `${y}年${Number(m)}月` }).first();
  const budget = parseNumber((await row.locator("td, th").nth(bi).textContent()) ?? "")!;
  const cap = parseNumber((await row.locator("td, th").nth(ti).textContent()) ?? "")!;
  expect(Math.abs(cap - budget * (1 - t.remainingRate))).toBeLessThanOrEqual(1);
  await expect(section(page).locator(".yn-legend")).toContainText("上限（目標）");
  // 月末見込みはグラフも凡例も点線（目安・上限の破線と見分ける）
  await expect(section(page).locator(".yn-legend li", { hasText: "月末見込み" }).locator(".yn-legend-line-dotted")).toHaveCount(1);
  // 凡例の線種が見た目でも分かれる（実線・破線・点線の背景がそれぞれ違い、高さがある）
  const looks = await section(page).locator(".yn-legend li .yn-legend-swatch").evaluateAll((els) =>
    els.map((e) => {
      const cs = getComputedStyle(e);
      return { cls: [...e.classList], image: cs.backgroundImage, height: e.getBoundingClientRect().height };
    }),
  );
  const pick = (c: string) => looks.find((x) => x.cls.includes(c))!;
  expect(pick("yn-legend-line").image === "none" || pick("yn-legend-line").image === "").toBe(true);
  expect(pick("yn-legend-line-dashed").image).toContain("repeating-linear-gradient");
  expect(pick("yn-legend-line-dotted").image).toContain("repeating-linear-gradient");
  expect(pick("yn-legend-line-dotted").image).not.toBe(pick("yn-legend-line-dashed").image);
  for (const l of looks) expect(l.height).toBeGreaterThan(0);
  // 目標の無いチームは凡例・列を増やさない
  const without = teams.find((id) => !Object.values(model.targets ?? []).some((x) => x.kind === "team" && x.targetId === id));
  if (without) {
    await gotoPage(page, `/team?id=${without}`);
    const m2 = page.locator(".yn-chart-card").filter({ hasText: "月次推移" }).first();
    await expect(m2.locator(".yn-legend")).not.toContainText("目標");
    await expect(section(page).locator(".yn-legend")).not.toContainText("目標");
  }
});

test("今月の進捗: 今月を含まない期間（前年度・先月）では出さない", async ({ page }) => {
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

test("今月の進捗: チーム詳細のメンバー×日の表（累計・計画・残り/日）", async ({ page }) => {
  const p = dailyProgress(model, daily, teamIds)!;
  const rows = dailyMembers(model, daily, p, teamIds);
  await gotoPage(page, `/team?id=${TEAM}`);
  const table = section(page).locator("table.yn-dg-table");
  await expect(table.locator("tbody tr")).toHaveCount(rows.length);
  // 日の列は今月の日数
  await expect(table.locator("thead th.yn-dg-day")).toHaveCount(p.points.length);
  const first = rows[0]!;
  const tr = table.locator("tbody tr").first();
  const col = async (label: string) => (await table.locator("thead th").allTextContents()).findIndex((t) => t.trim().startsWith(label));
  await expect(tr.locator("th, td").nth(await col("累計"))).toHaveText(`${Number(first.total.toFixed(2))}h`);
  // 計画を超えた人は「超過」
  const over = rows.filter((r) => r.plan > 0 && r.remaining < 0).length;
  await expect(table.locator("tbody td.is-over")).toHaveCount(over);
  // 合計行
  await expect(table.locator("tfoot tr")).toHaveCount(1);
  // 全体・案件詳細には出さない
  await gotoPage(page, "/");
  await expect(section(page).locator("table.yn-dg-table")).toHaveCount(0);
});

test("今月の進捗: メンバー×日の表は他の表と同じく役職・並べ替え・絞り込み・列の設定・Excel（§124）", async ({ page }) => {
  const p = dailyProgress(model, daily, teamIds)!;
  const rows = dailyMembers(model, daily, p, teamIds);
  await gotoPage(page, `/team?id=${TEAM}`);
  const block = section(page).locator(".yn-table-block").filter({ has: page.locator("table.yn-dg-table") });
  const table = block.locator("table.yn-dg-table");
  // 役職の列は最初から出る
  await expect(table.locator("thead th", { hasText: "役職" })).toHaveCount(1);
  // 累計で並べ替え（多い順）
  await table.locator("thead th", { hasText: "累計" }).locator("button.yn-sort").click();
  const max = Math.max(...rows.map((r) => r.total));
  await expect(table.locator("tbody tr").first().locator("td").nth(await table.locator("thead th").evaluateAll((ths) => ths.findIndex((t) => t.textContent!.trim().startsWith("累計")) - 1))).toHaveText(`${Number(max.toFixed(2))}h`);
  // 列の絞り込みの漏斗は名前・役職などにあり、日の列には無い
  await expect(table.locator("thead th.yn-dg-day .yn-filter-btn")).toHaveCount(0);
  await expect(table.locator("thead th", { hasText: "役職" }).locator(".yn-filter-btn")).toHaveCount(1);
  // 「列」に部・課などがあり、日の列は出ない
  await block.locator(".yn-table-actions button", { hasText: "列" }).click();
  const pop = page.locator(".yn-cols-pop");
  await expect(pop).toContainText("事業本部");
  await expect(pop.locator("label", { hasText: /^\s*1\s*$/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // Excel 出力のボタン
  await expect(block.locator(".yn-table-actions button", { hasText: "Excel" })).toHaveCount(1);
});

for (const [w, dark] of [
  [390, false],
  [768, true],
  [1280, false],
  [1024, true],
] as const) {
  test(`今月の進捗: ${w}px${dark ? "・ダーク" : ""}ではみ出さない`, async ({ page }) => {
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
    const wrap = section(page).locator(".yn-table-wrap").filter({ has: page.locator("table.yn-dg-table") });
    await wrap.evaluate((el) => (el.scrollLeft = el.scrollWidth));
    const name = wrap.locator("tbody th").first();
    const nb = (await name.boundingBox())!;
    const wb = (await wrap.boundingBox())!;
    expect(nb.x).toBeGreaterThanOrEqual(wb.x - 1);
  });
}

test("メンバー×日の表: 日の数字を押すと、その日の案件ごと・作業ごとの時間が開く（合計行も。§133）", { tag: "@smoke" }, async ({ page }) => {
  const p = dailyProgress(model, daily, teamIds)!;
  const rows = dailyMembers(model, daily, p, teamIds);
  const first = rows[0]!;
  const i = first.hours.findIndex((v) => (v ?? 0) > 0);
  const day = p.points[i]!.day;
  const lines = dayHoursLines(daily, teamIds, day, first.memberId);
  await gotoPage(page, `/team?id=${TEAM}`);
  const table = section(page).locator("table.yn-dg-table");
  const tr = table.locator("tbody tr").first();
  // 日の列は名前・役職・累計・計画・残り/日の後ろ（表の左から数える）
  const heads = await table.locator("thead th").allTextContents();
  const col = heads.findIndex((t) => t.trim() === String(day));
  await tr.locator("th, td").nth(col).locator("button.yn-num").click();
  const dialog = page.locator("dialog.yn-bd-dialog[open]");
  await expect(dialog.locator(".yn-dialog-title")).toContainText(`${day}日`);
  await expect(dialog.locator(".yn-bd-rows .is-emphasis")).toContainText(`${Number(first.hours[i]!.toFixed(2))}h`);
  const byContract = dialog.locator(".yn-bd-section").filter({ hasText: "案件ごとの内訳" });
  await expect(byContract.locator("tbody tr")).toHaveCount(lines.length);
  // 作業ごとの内訳は開いたらすぐ作業ログ明細を読む。合計はその日の時間
  const byTask = dialog.locator(".yn-bd-section").filter({ hasText: "作業ごとの内訳" });
  await expect(byTask.locator("tfoot")).toContainText(`${Number(first.hours[i]!.toFixed(2))}h`);
  await page.keyboard.press("Escape");
  // 合計行: 表示中の人のその日の 人 × 案件
  await table.locator("tfoot td").nth(col).locator("button.yn-num").click();
  await expect(dialog.locator(".yn-dialog-title")).toContainText(`${day}日の時間`);
  await expect(dialog.locator(".yn-bd-section tbody tr")).toHaveCount(dayHoursLines(daily, teamIds, day).length);
});

test("メンバー×日の表: スマートフォンでも日の数字をタップすると内訳が開く（§133）", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await gotoPage(page, `/team?id=${TEAM}`);
  const btn = section(page).locator("table.yn-dg-table tbody td.yn-dg-day button.yn-num").first();
  await btn.scrollIntoViewIfNeeded();
  await btn.tap();
  await expect(page.locator("dialog.yn-bd-dialog[open] .yn-bd-section").filter({ hasText: "案件ごとの内訳" })).toBeVisible();
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
  await ctx.close();
});
