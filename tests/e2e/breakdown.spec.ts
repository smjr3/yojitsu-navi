/**
 * 計算根拠パネル（<dialog>）: 原価の内訳、作業ログの遅延読み込み、予算の月割り、消化率、着地見込み、キーボード操作
 */
import { test, expect, gotoPage, kpiValue, dialog, dialogRow, tableByCaption, headerIndex, col, cell, cellText, parseNumber } from "./helpers/app.js";
import { DEFAULT_UNIT, contractResult, contractsInPeriod, fiscalPeriod, formatPercent, getModel, totalsFor, yen } from "./helpers/core.js";

/** 内訳の算術は円の精度で照合するので、表示単位を円にして開く（既定は百万円） */
const inYen = (path: string) => `${path}${path.includes("?") ? "&" : "?"}unit=yen`;

const model = getModel();
const FY = fiscalPeriod(model);

test("原価 KPI の内訳: 契約ごとの原価の合計が表示値と一致する", async ({ page }) => {
  await gotoPage(page, inYen("/"));
  const kpi = kpiValue(page, 1);
  const shown = (await kpi.textContent())!.trim();
  // KPI は画面の既定単位（百万円）の表示、dialog の金額は単位に関係なく常に円
  expect(shown).toBe(yen(totalsFor(FY, undefined, model).cost, DEFAULT_UNIT));
  await kpi.click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await expect(d.locator("#yn-dialog-title")).toContainText("原価の計算根拠");
  // 式が表示される
  await expect(d.locator(".yn-bd-formula")).toContainText("作業時間 × その月に有効な時間単価");
  // 強調行 = KPI の値
  const totals = totalsFor(FY, undefined, model);
  expect(await dialogRow(page, "原価合計")).toBe(yen(totals.cost, "yen"));
  expect(await dialogRow(page, "対象契約")).toBe(`${contractsInPeriod(FY, undefined, model).length}件`);
  // 契約ごとの内訳表の「原価」列の合計 = 表示値
  const table = d.locator(".yn-bd-section table").first();
  const h = await headerIndex(table);
  const rows = table.locator("tbody tr");
  const n = await rows.count();
  expect(n).toBe(contractsInPeriod(FY, undefined, model).length);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = parseNumber(await cellText(rows.nth(i), col(h, "原価")));
    expect(v).not.toBeNull();
    sum += v!;
  }
  expect(sum).toBe(totals.cost);
  // 契約ID は詳細へのリンク
  await expect(rows.first().locator("a")).toHaveAttribute("href", /contract\?/);
});

test("月の原価の内訳から作業ログを遅延読み込みする（C008 2026-10）", async ({ page }) => {
  const worklogUrls: string[] = [];
  page.on("response", (res) => {
    if (/\/data\/worklogs\//.test(res.url())) worklogUrls.push(`${res.status()} ${res.url()}`);
  });
  await gotoPage(page, inYen("/contract?id=C008"));
  const r = contractResult("C008", model);
  const month = "2026-10";
  const cm = r.months.find((m) => m.month === month)!;
  const table = tableByCaption(page, "月ごとの予実");
  const h = await headerIndex(table);
  const row = table.locator(`tbody tr[data-key="${month}"]`);
  await cell(row, col(h, "原価")).locator("button").click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await expect(d.locator("#yn-dialog-title")).toContainText("原価の計算根拠");
  await expect(d.locator("#yn-dialog-title")).toContainText("2026年10月");
  expect(await dialogRow(page, "原価行の数")).toBe(String(cm.costLines.length));
  expect(await dialogRow(page, "2026年10月 の原価")).toBe(yen(cm.cost, "yen"));
  // メンバーごとの原価行の金額合計 = 月の原価
  const lines = d.locator(".yn-bd-section").first().locator("table tbody tr");
  await expect(lines).toHaveCount(cm.costLines.length);
  const lh = await headerIndex(d.locator(".yn-bd-section").first().locator("table"));
  let lineSum = 0;
  for (let i = 0; i < cm.costLines.length; i++) lineSum += parseNumber(await cellText(lines.nth(i), col(lh, "金額"))) ?? NaN;
  expect(lineSum).toBe(cm.cost);
  // まだ明細は読まれていない
  expect(worklogUrls, "開く前は作業ログを取得しない").toEqual([]);
  await expect(d.locator(".yn-bd-lazy table")).toHaveCount(0);
  const loadBtn = d.getByRole("button", { name: "作業ログを読み込む" });
  await expect(loadBtn).toBeVisible();
  const resPromise = page.waitForResponse((res) => /\/data\/worklogs\/C008\.json$/.test(res.url()));
  await loadBtn.click();
  const res = await resPromise;
  expect(res.status()).toBe(200);
  const wl = d.locator(".yn-bd-lazy table");
  await expect(wl).toBeVisible();
  await expect(loadBtn).toHaveCount(0);
  const entries = cm.worklogs;
  expect(entries.length).toBeGreaterThan(0);
  await expect(wl.locator("tbody tr")).toHaveCount(Math.min(entries.length, 500));
  const foot = wl.locator("tfoot tr");
  await expect(foot).toContainText(`${entries.length} 件`);
  const wh = await headerIndex(wl);
  const total = entries.reduce((s, w) => s + w.amount, 0);
  expect(await cellText(foot, col(wh, "金額"))).toBe(yen(total, "yen"));
  expect(total, "作業ログの金額合計 = 月の原価").toBe(cm.cost);
  // 行の金額の合計も一致
  const rows = wl.locator("tbody tr");
  let rowSum = 0;
  const n = await rows.count();
  for (let i = 0; i < n; i++) rowSum += parseNumber(await cellText(rows.nth(i), col(wh, "金額"))) ?? NaN;
  if (entries.length <= 500) expect(rowSum).toBe(total);
  expect(worklogUrls.length, "取得は 1 回").toBe(1);
});

test("予算の月割り: 総額 ÷ 月数 = 基本額、端数は最終月に加算（C005: 38,000,000 → 3,166,666 / 3,166,674）", async ({ page }) => {
  await gotoPage(page, inYen("/contract?id=C005"));
  const r = contractResult("C005", model);
  const table = tableByCaption(page, "月ごとの予実");
  const h = await headerIndex(table);
  const check = async (month: string, expectedBudgetYen: string, expectedBudgetShown: string, last: boolean) => {
    const row = table.locator(`tbody tr[data-key="${month}"]`);
    // 表のセルは画面の既定単位、内訳（dialog）は常に円
    await expect(cell(row, col(h, "予算"))).toHaveText(expectedBudgetShown);
    await cell(row, col(h, "予算")).locator("button").click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    await expect(d.locator("#yn-dialog-title")).toContainText("予算の計算根拠");
    await expect(d.locator(".yn-bd-formula")).toContainText("floor(契約総額 ÷ 契約月数)");
    expect(await dialogRow(page, "契約総額")).toBe("38,000,000円");
    expect(await dialogRow(page, "契約月数")).toBe("12か月");
    expect(await dialogRow(page, "基本額")).toBe("3,166,666円");
    expect(await dialogRow(page, "端数（最終月に加算）")).toBe("8円");
    expect(await dialogRow(page, "この月は最終月か")).toBe(last ? "はい" : "いいえ");
    const cm = r.months.find((m) => m.month === month)!;
    expect(cm.budgetBreakdown).toMatchObject({ totalAmount: 38_000_000, monthCount: 12, baseMonthly: 3_166_666, remainder: 8, isLastMonth: last });
    const label = `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月 の予算`;
    expect(await dialogRow(page, label)).toBe(expectedBudgetYen);
    expect(yen(cm.budget, "yen")).toBe(expectedBudgetYen);
    expect(yen(cm.budget, DEFAULT_UNIT)).toBe(expectedBudgetShown);
    await page.keyboard.press("Escape");
    await expect(d).toHaveCount(0);
  };
  await check("2026-04", "3,166,666円", yen(3_166_666, DEFAULT_UNIT), false);
  await check("2027-03", "3,166,674円", yen(3_166_674, DEFAULT_UNIT), true);
  // 12 か月の合計 = 契約総額
  expect(r.months.reduce((s, m) => s + m.budget, 0)).toBe(38_000_000);
});

test("消化率の内訳: 累計原価 ÷ 累計予算 が KPI と一致する", async ({ page }) => {
  await gotoPage(page, inYen("/"));
  const kpi = kpiValue(page, 3);
  const shown = (await kpi.textContent())!.trim();
  await kpi.click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await expect(d.locator("#yn-dialog-title")).toContainText("消化率の計算根拠");
  await expect(d.locator(".yn-bd-formula")).toContainText("経過月の累計原価 ÷ 経過月の累計予算");
  const t = totalsFor(FY, undefined, model);
  const b = t.burnRateBreakdown;
  expect(await dialogRow(page, "経過月")).toBe(`${b.elapsedMonths.length}か月`);
  const cost = await dialogRow(page, "累計原価（経過月）");
  const budget = await dialogRow(page, "累計予算（経過月）");
  expect(cost).toBe(yen(b.cumulativeCost, "yen"));
  expect(budget).toBe(yen(b.cumulativeBudget, "yen"));
  const rate = await dialogRow(page, "消化率");
  expect(rate).toBe(shown);
  expect(rate).toBe(formatPercent(t.burnRate));
  // 表示値どうしの算術: 累計原価 ÷ 累計予算 ≒ 消化率（小数1桁）
  const c = parseNumber(cost)!;
  const bud = parseNumber(budget)!;
  expect(formatPercent(c / bud)).toBe(rate);
  expect(await dialogRow(page, "赤の基準")).toBe(`${formatPercent(model.config.burnRateDangerThreshold)} 超`);
});

test("着地見込みの内訳: 方式・実績月・残り月・平均 × 残り月 の算術が通る（C008・直近実績）", async ({ page }) => {
  await gotoPage(page, inYen("/contract?id=C008"));
  const r = contractResult("C008", model);
  const f = r.forecasts.recent3;
  const b = f.breakdown;
  const kpi = kpiValue(page, 4);
  const shown = (await kpi.textContent())!.trim();
  await kpi.click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await expect(d.locator("#yn-dialog-title")).toContainText("着地見込みの計算根拠");
  await expect(d.locator(".yn-bd-formula")).toContainText("着地粗利 = 年度予算 − 着地原価");
  expect(await dialogRow(page, "方式")).toBe("直近実績");
  expect(await dialogRow(page, "対象年度")).toBe(`FY${f.fiscalYear}`);
  expect(await dialogRow(page, "実績月（完了した月）")).toBe(`${b.actualMonths.length}か月`);
  expect(await dialogRow(page, "残り月（基準月を含む）")).toBe(`${b.remainingMonths.length}か月`);
  expect(await dialogRow(page, "平均の基礎にした月")).toBe(`${b.averageBasisMonths.length}か月`);
  expect(b.averageBasisMonths.length).toBe(model.config.forecastRecentMonths);
  const fyBudget = parseNumber(await dialogRow(page, "年度予算"))!;
  const actual = parseNumber(await dialogRow(page, "実績原価（実績月の合計）"))!;
  const avg = parseNumber(await dialogRow(page, "平均月次原価"))!;
  const remaining = parseNumber(await dialogRow(page, "残り原価"))!;
  const forecastCost = parseNumber(await dialogRow(page, "着地原価"))!;
  const gp = await dialogRow(page, "着地粗利");
  expect(shown, "KPI は画面の既定単位").toBe(yen(f.forecastGrossProfit, DEFAULT_UNIT));
  expect(gp, "dialog は常に円").toBe(yen(f.forecastGrossProfit, "yen"));
  // core の値と一致
  expect(fyBudget).toBe(f.fyBudget);
  expect(actual).toBe(b.actualCost);
  expect(avg).toBe(Math.round(b.averageMonthlyCost));
  expect(remaining).toBe(b.remainingCost);
  expect(forecastCost).toBe(f.forecastCost);
  // 表示値どうしの算術
  const n = b.remainingMonths.length;
  expect(Math.abs(remaining - avg * n), "残り原価 ≒ 平均 × 残り月数（丸め差は月数以内）").toBeLessThanOrEqual(n);
  expect(actual + remaining).toBe(forecastCost);
  expect(fyBudget - forecastCost).toBe(parseNumber(gp));
  // 実績月 + 残り月 = 年度内の契約月
  expect(b.actualMonths.length + b.remainingMonths.length).toBe(b.contractMonthsInFY.length);
  await expect(d.locator(".yn-bd-rows")).toContainText(b.remainingMonths[0]!);
  await expect(d.locator(".yn-bd-rows")).toContainText("赤字見込み");
});

test("Esc で閉じ、フォーカスは開いたボタンに戻り、開いている間はフォーカスが閉じ込められる", async ({ page }) => {
  await gotoPage(page, inYen("/"));
  const kpi = kpiValue(page, 1);
  await kpi.focus();
  await page.keyboard.press("Enter");
  const d = dialog(page);
  await expect(d).toBeVisible();
  await expect(d).toHaveAttribute("aria-labelledby", "yn-dialog-title");
  // 開いた直後は閉じるボタンにフォーカス
  await expect(d.locator(".yn-dialog-close")).toBeFocused();
  // showModal() の間、背面は inert。Tab を何度押してもダイアログの外の要素にはフォーカスが行かない。
  // （Chromium のネイティブ dialog は末尾の要素から先はブラウザ UI（activeElement = body）に抜けてから先頭に戻る。
  //   body は許容し、ページ内の要素に出ないことを確認する）
  const where = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return "body";
      return el.closest("dialog[open]") ? "dialog" : `outside:${el.tagName}.${(el as HTMLElement).className}`;
    });
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const w = await where();
    seen.add(w);
    expect(w, `Tab ${i + 1} 回目の後にページ内の要素へ抜けない`).toMatch(/^(dialog|body)$/);
  }
  expect(seen.has("dialog"), "Tab でダイアログ内を巡回する").toBe(true);
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await where(), `Shift+Tab ${i + 1} 回目の後にページ内の要素へ抜けない`).toMatch(/^(dialog|body)$/);
  }
  // 背面は操作できない（inert）: フィルタのボタンにフォーカスを移そうとしても移らない
  await page.locator(".yn-seg-btn[data-unit=k]").focus({ timeout: 2000 }).catch(() => {});
  expect(await where()).not.toMatch(/^outside/);
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
  await expect(kpi).toBeFocused();
  // 閉じるボタンでも閉じる & フォーカスが戻る
  await kpi.click();
  await expect(dialog(page)).toBeVisible();
  await page.locator(".yn-dialog-close2").click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(kpi).toBeFocused();
  // 背景クリックでも閉じる
  await kpi.click();
  await expect(dialog(page)).toBeVisible();
  await page.locator("dialog.yn-dialog[open]").click({ position: { x: 2, y: 2 } });
  await expect(dialog(page)).toHaveCount(0);
});
