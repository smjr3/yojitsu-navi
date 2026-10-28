/**
 * 数値の突合: 画面の KPI・一覧の行・案件詳細の月行が、計算コア（aggregate / forecastTotals / ContractMonth）と一致する
 */
import { test, expect, gotoPage, kpiValue, tableByCaption, dataRows, headerIndex, col, cellText, query } from "./helpers/app.js";
import {
  UNASSIGNED_TEAM_ID,
  contractResult,
  contractRowExpected,
  contractsInPeriod,
  fiscalPeriod,
  forecastFor,
  formatPercent,
  getModel,
  DEFAULT_UNIT,
  UNIT_LABEL,
  presetPeriod,
  teamContractIds,
  totalsFor,
  treeAt,
  yen,
  type ForecastMethod,
  type Unit,
  type Period,
} from "./helpers/core.js";

const model = getModel();
const FY = fiscalPeriod(model);

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/**
 * 全体サマリーの KPI 5 枚を core の値と比べる。unit は「画面が今出している単位」（省略 = 画面の既定単位）。
 * 厳密に見たい（丸めで差が隠れてほしくない）テストは URL に unit=yen を付けて "yen" で比べる。
 */
async function expectKpis(page: import("@playwright/test").Page, period: Period, teamId = "", method: ForecastMethod = "recent3", unit: Unit = DEFAULT_UNIT) {
  const ids = teamContractIds(teamId, period, model);
  const totals = totalsFor(period, ids, model);
  const fc = forecastFor(method, ids, model);
  await expect(kpiValue(page, 0)).toHaveText(yen(totals.budget, unit));
  await expect(kpiValue(page, 1)).toHaveText(yen(totals.cost, unit));
  await expect(kpiValue(page, 2)).toHaveText(yen(totals.grossProfit, unit));
  await expect(kpiValue(page, 3)).toHaveText(formatPercent(totals.burnRate));
  await expect(kpiValue(page, 4)).toHaveText(yen(fc.forecastGrossProfit, unit));
  return { totals, fc };
}

test.describe("全体サマリー", () => {
  test("既定の表示単位が config 由来（百万円）で、初回表示の URL・KPI・ボタンがそれになる", async ({ page }) => {
    expect(DEFAULT_UNIT, "config.currency.defaultUnit = millionYen → 画面の unit は m").toBe("m");
    await gotoPage(page, "/");
    expect(query(page).get("unit")).toBe(DEFAULT_UNIT);
    for (const u of ["m", "k", "yen"] as const) {
      await expect(page.locator(`.yn-seg-btn[data-unit=${u}]`)).toHaveAttribute("aria-pressed", u === DEFAULT_UNIT ? "true" : "false");
    }
    await expect(page.locator(`.yn-seg-btn[data-unit=${DEFAULT_UNIT}]`)).toHaveText(UNIT_LABEL[DEFAULT_UNIT]);
    const totals = totalsFor(FY, undefined, model);
    // 百万円表記（小数 1 桁 + 「百万円」）で core の値と一致
    await expect(kpiValue(page, 0)).toHaveText(yen(totals.budget, "m"));
    await expect(kpiValue(page, 0)).toHaveText(/^-?[\d,]+\.\d百万円$/);
    await expect(kpiValue(page, 1)).toHaveText(yen(totals.cost, "m"));
    await expectKpis(page, FY, "", "recent3", "m");
    // 保存された状態が無い（localStorage 空）ことが前提なので、保存もこの単位になる
    const stored = await page.evaluate(() => localStorage.getItem("yojitsu-navi:state:v2"));
    expect(JSON.parse(stored ?? "{}")).toMatchObject({ unit: "m" });
  });

  test("KPI が core の aggregate / forecastTotals と一致（FY2026・円で厳密）", async ({ page }) => {
    await gotoPage(page, "/?unit=yen");
    await expect(page.locator(".yn-kpi-grid .yn-kpi")).toHaveCount(5);
    const { totals, fc } = await expectKpis(page, FY, "", "recent3", "yen");
    // 補足: 案件数、残予算率、赤字件数
    await expect(page.locator(".yn-kpi").nth(0)).toContainText(`${totals.contractCount}件の案件`);
    await expect(page.locator(".yn-kpi").nth(2)).toContainText(formatPercent(totals.grossMargin));
    const deficit = fc.deficitContractIds.length;
    await expect(page.locator(".yn-kpi").nth(4).locator(".yn-chip")).toHaveText(deficit > 0 ? new RegExp(`超過見込み ${deficit}件`) : /超過見込みなし/);
    // URL は初回表示で正規化される
    const q = query(page);
    expect(q.get("from")).toBe(FY.from);
    expect(q.get("to")).toBe(FY.to);
    expect(q.get("unit")).toBe("yen");
    expect(q.get("method")).toBe("recent3");
  });

  test("単位の切替: 百万円 → 千円 → 円 → 百万円 の往復で KPI・URL・aria-pressed・保存が変わる", async ({ page }) => {
    await gotoPage(page, "/");
    expect(query(page).get("unit")).toBe("m");
    for (const unit of ["k", "yen", "m"] as const) {
      await page.locator(`.yn-seg-btn[data-unit=${unit}]`).click();
      for (const u of ["m", "k", "yen"] as const) {
        await expect(page.locator(`.yn-seg-btn[data-unit=${u}]`)).toHaveAttribute("aria-pressed", String(u === unit));
      }
      await expectKpis(page, FY, "", "recent3", unit);
      await expect(kpiValue(page, 0)).toContainText(UNIT_LABEL[unit]);
      expect(query(page).get("unit")).toBe(unit);
      const stored = await page.evaluate(() => localStorage.getItem("yojitsu-navi:state:v2"));
      expect(JSON.parse(stored ?? "{}")).toMatchObject({ unit });
    }
  });

  for (const preset of ["prevFy", "thisMonth", "lastMonth", "recent3", "recent12", "fy"] as const) {
    test(`期間プリセット ${preset} で KPI が core の値になる`, async ({ page }) => {
      await gotoPage(page, "/?unit=yen");
      const period = presetPeriod(preset, model);
      const btn = page.locator(`.yn-seg-btn[data-preset=${preset}]`);
      await btn.click();
      await expect(btn).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("#yn-filter-from")).toHaveValue(period.from);
      await expect(page.locator("#yn-filter-to")).toHaveValue(period.to);
      await expectKpis(page, period, "", "recent3", "yen");
      expect(query(page).get("from")).toBe(period.from);
      expect(query(page).get("to")).toBe(period.to);
    });
  }

  test("開始月・終了月を選ぶと KPI が core の値になる", async ({ page }) => {
    await gotoPage(page, "/?unit=yen");
    const period = { from: "2026-06", to: "2026-09" };
    await page.locator("#yn-filter-from").selectOption(period.from);
    await page.locator("#yn-filter-to").selectOption(period.to);
    await expectKpis(page, period, "", "recent3", "yen");
    expect(query(page).get("from")).toBe(period.from);
    expect(query(page).get("to")).toBe(period.to);
    // 逆転（終了 < 開始）は入れ替わる
    await page.locator("#yn-filter-to").selectOption("2026-05");
    await expect(page.locator("#yn-filter-from")).toHaveValue("2026-05");
    await expect(page.locator("#yn-filter-to")).toHaveValue("2026-05");
    await expectKpis(page, { from: "2026-05", to: "2026-05" }, "", "recent3", "yen");
    // 既定単位（百万円）の画面でも同じ期間の KPI が core の値（百万円表記）になる
    await page.locator(".yn-seg-btn[data-unit=m]").click();
    await expectKpis(page, { from: "2026-05", to: "2026-05" }, "", "recent3", "m");
  });

  test("カレンダーで選んだ日付はその月として期間に入る", async ({ page }) => {
    await gotoPage(page, "/?unit=yen");
    await page.locator("#yn-filter-from-date").fill("2026-06-15");
    await page.locator("#yn-filter-to-date").fill("2026-09-03");
    await expect(page.locator("#yn-filter-from")).toHaveValue("2026-06");
    await expect(page.locator("#yn-filter-to")).toHaveValue("2026-09");
    await expectKpis(page, { from: "2026-06", to: "2026-09" }, "", "recent3", "yen");
    // 日付欄は期間の初日・末日を指す
    await expect(page.locator("#yn-filter-from-date")).toHaveValue("2026-06-01");
    await expect(page.locator("#yn-filter-to-date")).toHaveValue("2026-09-30");
    // 終了日を開始より前にすると開始も合わせる
    await page.locator("#yn-filter-to-date").fill("2026-05-20");
    await expect(page.locator("#yn-filter-from")).toHaveValue("2026-05");
    await expect(page.locator("#yn-filter-to")).toHaveValue("2026-05");
  });

  for (const method of ["all", "assignment", "recent3"] as const) {
    test(`着地方式 ${method} で 着地見込みの差 が core の forecastTotals と一致`, async ({ page }) => {
      await gotoPage(page, "/?unit=yen");
      await page.locator(`#yn-method-${method}`).check();
      await expect(page.locator(`input[name=yn-method][value=${method}]`)).toBeChecked();
      await expectKpis(page, FY, "", method, "yen");
      expect(query(page).get("method")).toBe(method);
      await expect(page.locator(".yn-kpi").nth(4).locator(".yn-kpi-label")).toContainText(
        { recent3: "直近実績", all: "全期間平均", assignment: "アサイン計画" }[method],
      );
    });
  }

  for (const teamId of ["S11", "T111", "D2", UNASSIGNED_TEAM_ID]) {
    test(`チーム ${teamId} で絞ると core の contractsForTeam の集計になる`, async ({ page }) => {
      await gotoPage(page, "/?unit=yen");
      await page.locator("#yn-filter-team").selectOption(teamId);
      await expect(page.locator("#yn-filter-team")).toHaveValue(teamId);
      const { totals } = await expectKpis(page, FY, teamId, "recent3", "yen");
      const ids = teamContractIds(teamId, FY, model)!;
      expect(totals.contractCount).toBeLessThanOrEqual(ids.length);
      await expect(page.locator(".yn-kpi").nth(0)).toContainText(`${totals.contractCount}件の案件`);
      expect(query(page).get("team")).toBe(teamId);
      // 「チーム別」セクションは選んだチームの配下だけになる
      const tree = treeAt(FY.to, model);
      const node = tree[teamId];
      if (node && node.children.length) {
        const table = tableByCaption(page, "チーム別の集計");
        const keys = await dataRows(table).evaluateAll((rows) => rows.map((r) => r.getAttribute("data-key")));
        expect(keys).toEqual(node.children);
      }
    });
  }

  test("URL クエリが状態を表し、再読込で復元される", async ({ page }) => {
    const url = "/?from=2026-06&to=2026-09&team=T111&unit=k&method=all";
    // 単位の指定が無いクエリは既定（百万円）になる
    await gotoPage(page, "/?from=2026-06&to=2026-09&team=T111&method=all");
    expect(query(page).get("unit")).toBe(DEFAULT_UNIT);
    await expectKpis(page, { from: "2026-06", to: "2026-09" }, "T111", "all", DEFAULT_UNIT);
    await page.evaluate(() => localStorage.clear());
    await gotoPage(page, url);
    const period = { from: "2026-06", to: "2026-09" };
    await expectKpis(page, period, "T111", "all", "k");
    await expect(page.locator("#yn-filter-team")).toHaveValue("T111");
    await expect(page.locator("#yn-method-all")).toBeChecked();
    await expect(page.locator(".yn-seg-btn[data-unit=k]")).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(page.locator(".yn-page-header").first()).toBeVisible();
    await expectKpis(page, period, "T111", "all", "k");
    // 不正な値は既定に戻る（優先順位は URL > localStorage > 既定。クエリに無いキーは localStorage から来るので先に消す）
    await page.evaluate(() => localStorage.clear());
    await gotoPage(page, "/?from=xxxx&to=2027-99&team=NOPE&unit=gold&method=magic");
    await expectKpis(page, FY, "", "recent3", DEFAULT_UNIT);
    const q = query(page);
    expect(q.get("from")).toBe(FY.from);
    expect(q.get("to")).toBe(FY.to);
    expect(q.get("team")).toBe("");
    expect(q.get("unit")).toBe(DEFAULT_UNIT);
    expect(q.get("method")).toBe("recent3");
    // クエリに無いキーは localStorage の値が使われる（from だけ指定 → to は保存値）
    await gotoPage(page, url);
    await page.evaluate(() => localStorage.clear());
    await gotoPage(page, "/?from=2026-06&to=2026-09&unit=k");
    await gotoPage(page, "/?from=2026-05");
    await expectKpis(page, { from: "2026-05", to: "2026-09" }, "", "recent3", "k");
  });

  test("localStorage で状態が別ページにも引き継がれる", async ({ page }) => {
    await gotoPage(page, "/");
    await page.locator(".yn-seg-btn[data-unit=k]").click();
    await page.locator("#yn-method-all").check();
    await page.locator(".yn-seg-btn[data-preset=recent3]").click();
    const period = presetPeriod("recent3", model);
    await expectKpis(page, period, "", "all", "k");
    const stored = await page.evaluate(() => localStorage.getItem("yojitsu-navi:state:v2"));
    expect(JSON.parse(stored ?? "{}")).toMatchObject({ unit: "k", method: "all", from: period.from, to: period.to });
    // クエリ無しで別ページへ → 保存された状態が使われ、URL に正規化される
    await gotoPage(page, "/teams");
    const q = query(page);
    expect(q.get("unit")).toBe("k");
    expect(q.get("method")).toBe("all");
    expect(q.get("from")).toBe(period.from);
    expect(q.get("to")).toBe(period.to);
    await expect(page.locator(".yn-seg-btn[data-unit=k]")).toHaveAttribute("aria-pressed", "true");
    const table = tableByCaption(page, "チーム一覧");
    const h = await headerIndex(table);
    const hq = dataRows(table).filter({ has: page.locator('[data-key="HQ"]') }).first();
    const hqRow = table.locator('tbody tr[data-key="HQ"]');
    await expect(hqRow).toHaveCount(1);
    const ids = teamContractIds("HQ", period, model);
    await expect(hqRow.locator("th, td").nth(col(h, "予算"))).toHaveText(yen(totalsFor(period, ids, model).budget, "k"));
    void hq;
    // 案件一覧にも引き継がれる
    await gotoPage(page, "/contracts");
    expect(query(page).get("unit")).toBe("k");
    // 新しいコンテキスト相当: localStorage を消すと既定に戻る
    await page.evaluate(() => localStorage.clear());
    await gotoPage(page, "/");
    await expectKpis(page, FY, "", "recent3", DEFAULT_UNIT);
    expect(query(page).get("unit")).toBe(DEFAULT_UNIT);
  });

  test("古い保存（v1 キーの円）は読まれず、既定の百万円で始まる", async ({ page }) => {
    await gotoPage(page, "/");
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem("yojitsu-navi:state:v1", JSON.stringify({ unit: "yen" }));
    });
    await gotoPage(page, "/");
    expect(query(page).get("unit")).toBe(DEFAULT_UNIT);
    await expectKpis(page, FY, "", "recent3", DEFAULT_UNIT);
  });
});

test.describe("チーム一覧", () => {
  for (const unit of uniq<Unit>(["yen", DEFAULT_UNIT])) {
  test(`木のすべてのチーム行（＋未設定）が core の contractsForTeam + aggregate と一致（${UNIT_LABEL[unit]}）`, async ({ page }) => {
    await gotoPage(page, `/teams?unit=${unit}`);
    const table = tableByCaption(page, "チーム一覧");
    await expect(table).toBeVisible();
    const h = await headerIndex(table);
    const rows = dataRows(table);
    const keys = (await rows.evaluateAll((trs) => trs.map((tr) => tr.getAttribute("data-key")))) as string[];
    const tree = treeAt(FY.to, model);
    expect(new Set(keys)).toEqual(new Set([...Object.keys(tree), UNASSIGNED_TEAM_ID]));
    const fc = "recent3";
    for (const key of keys) {
      const row = table.locator(`tbody tr[data-key="${key}"]`);
      const ids = teamContractIds(key, FY, model)!;
      const t = totalsFor(FY, ids, model);
      const f = forecastFor(fc, ids, model);
      const label = `チーム ${key}`;
      expect(await cellText(row, col(h, "予算")), `${label} 予算`).toBe(yen(t.budget, unit));
      expect(await cellText(row, col(h, "実績")), `${label} 実績`).toBe(yen(t.cost, unit));
      expect(await cellText(row, col(h, "残予算")), `${label} 残予算`).toBe(yen(t.grossProfit, unit));
      expect(await cellText(row, col(h, "残予算率")), `${label} 残予算率`).toBe(formatPercent(t.grossMargin));
      expect(await cellText(row, col(h, "案件数")), `${label} 案件数`).toBe(String(t.contractCount));
      expect(await cellText(row, col(h, "着地差")), `${label} 着地差`).toContain(yen(f.forecastGrossProfit, unit));
      const burn = await cellText(row, col(h, "消化率"));
      expect(burn.replace(/[▲\s]/g, ""), `${label} 消化率`).toBe(formatPercent(t.burnRate));
      const nameCell = row.locator("th, td").nth(col(h, "チーム"));
      await expect(nameCell).toContainText(key === UNASSIGNED_TEAM_ID ? "未設定" : tree[key]!.name);
    }
  });
  }
});

test.describe("案件一覧", () => {
  for (const unit of uniq<Unit>(["yen", DEFAULT_UNIT])) {
  test(`期間内の案件がすべて並び、各行が core の aggregate / forecast と一致（${UNIT_LABEL[unit]}）`, async ({ page }) => {
    await gotoPage(page, `/contracts?unit=${unit}`);
    const table = tableByCaption(page, "案件一覧");
    await expect(table).toBeVisible();
    const h = await headerIndex(table);
    const rows = dataRows(table);
    const keys = (await rows.evaluateAll((trs) => trs.map((tr) => tr.getAttribute("data-key")))) as string[];
    const expected = contractsInPeriod(FY, undefined, model);
    expect(new Set(keys)).toEqual(new Set(expected.map((r) => r.contract.contractId)));
    let sumBudget = 0;
    let sumCost = 0;
    for (const r of expected) {
      const id = r.contract.contractId;
      const row = table.locator(`tbody tr[data-key="${id}"]`);
      const e = contractRowExpected(r, FY, "recent3", model);
      sumBudget += e.totals.budget;
      sumCost += e.totals.cost;
      expect(await cellText(row, col(h, "予算")), `${id} 予算`).toBe(yen(e.totals.budget, unit));
      expect(await cellText(row, col(h, "実績")), `${id} 実績`).toBe(yen(e.totals.cost, unit));
      expect(await cellText(row, col(h, "残予算")), `${id} 残予算`).toBe(yen(e.totals.grossProfit, unit));
      expect(await cellText(row, col(h, "残予算率")), `${id} 残予算率`).toBe(formatPercent(e.totals.grossMargin));
      const burn = (await cellText(row, col(h, "消化率"))).replace(/[▲\s]/g, "");
      expect(burn, `${id} 消化率`).toBe(formatPercent(e.totals.burnRate));
      const fcText = (await cellText(row, col(h, "着地差"))).replace(/[▲\s]/g, "");
      expect(fcText, `${id} 着地差`).toBe(e.forecastGrossProfit === null ? "—" : yen(e.forecastGrossProfit, unit));
      const status = await cellText(row, col(h, "状態"));
      if (e.isDeficit) expect(status, `${id} 状態`).toContain("超過見込み");
      if (e.isOverBudget) expect(status, `${id} 状態`).toContain("消化率超過");
      if (!e.isDeficit && !e.isOverBudget && e.includesPreliminary) expect(status, `${id} 状態`).toContain("速報含む");
      // 行の先頭セルに顧客名・案件名（ID は出さない。§31.1）
      const first = await cellText(row, 0);
      expect(first).not.toContain(id);
      expect(first).toContain(r.contract.projectName);
      expect(first).toContain(r.contract.customerName);
      // 赤字 or 超過の行は is-danger
      if (e.isDeficit || e.isOverBudget) await expect(row).toHaveClass(/is-danger/);
    }
    // 合計行
    const foot = table.locator("tfoot tr");
    await expect(foot).toHaveCount(1);
    expect(await cellText(foot, col(h, "予算"))).toBe(yen(sumBudget, unit));
    expect(await cellText(foot, col(h, "実績"))).toBe(yen(sumCost, unit));
    expect(await cellText(foot, col(h, "残予算"))).toBe(yen(sumBudget - sumCost, unit));
    await expect(foot).toContainText(`合計（${expected.length}件）`);
    await expect(page.locator(".yn-table-count")).toHaveText(`${expected.length} 件`);
  });
  }

  test("千円でも各行が一致", async ({ page }) => {
    await gotoPage(page, "/contracts?unit=k");
    const table = tableByCaption(page, "案件一覧");
    const h = await headerIndex(table);
    for (const r of contractsInPeriod(FY, undefined, model)) {
      const id = r.contract.contractId;
      const row = table.locator(`tbody tr[data-key="${id}"]`);
      const e = contractRowExpected(r, FY, "recent3", model);
      expect(await cellText(row, col(h, "予算")), `${id} 予算`).toBe(yen(e.totals.budget, "k"));
      expect(await cellText(row, col(h, "実績")), `${id} 実績`).toBe(yen(e.totals.cost, "k"));
    }
  });
});

test.describe("案件詳細", () => {
  for (const unit of uniq<Unit>(["yen", DEFAULT_UNIT])) {
  test(`C008: KPI と月ごとの予実が core の ContractMonth と一致（${UNIT_LABEL[unit]}）`, async ({ page }) => {
    await gotoPage(page, `/contract?id=C008&unit=${unit}`);
    const r = contractResult("C008", model);
    const t = totalsFor(FY, ["C008"], model);
    const f = r.forecasts.recent3;
    await expect(page.locator("h1")).toHaveText("こもれび出版 / 会員サイト保守");
    await expect(page.locator("h1")).toContainText(r.contract.customerName);
    await expect(kpiValue(page, 0)).toHaveText(yen(t.budget, unit));
    await expect(kpiValue(page, 1)).toHaveText(yen(t.cost, unit));
    await expect(kpiValue(page, 2)).toHaveText(yen(t.grossProfit, unit));
    await expect(kpiValue(page, 3)).toHaveText(formatPercent(t.burnRate));
    await expect(kpiValue(page, 4)).toHaveText(yen(f.forecastGrossProfit, unit));
    expect(f.isDeficit, "C008 はダミーデータ上は超過見込み").toBe(true);
    await expect(page.locator(".yn-kpi").nth(4).locator(".yn-chip")).toContainText("超過見込み");
    // 基本情報
    await expect(page.locator(".yn-facts")).toContainText(yen(r.contract.totalAmount, unit));
    await expect(page.locator(".yn-facts")).toContainText(`${r.months.length}か月`);

    const table = tableByCaption(page, "月ごとの予実");
    await expect(table).toBeVisible();
    const h = await headerIndex(table);
    const months = r.months.filter((m) => FY.from <= m.month && m.month <= FY.to);
    const keys = (await dataRows(table).evaluateAll((trs) => trs.map((tr) => tr.getAttribute("data-key")))) as string[];
    expect(keys).toEqual(months.map((m) => m.month));
    const statusLabel = { final: "確定", preliminary: "速報", future: "予定", outside: "期間外" } as const;
    // 予定（未来）の月は選択中の方式の見込み額（recent3/all: 平均 × 1 か月、analysis.forecastMonthlyCost と同じ）を「見込」として表示する
    const monthlyForecast = (month: string) => (f.breakdown.remainingMonths.includes(month) ? Math.round(f.breakdown.averageMonthlyCost) : null);
    let sumCost = 0;
    for (const m of months) {
      const row = table.locator(`tbody tr[data-key="${m.month}"]`);
      expect(await cellText(row, col(h, "予算")), `${m.month} 予算`).toBe(yen(m.budget, unit));
      if (m.status === "future") {
        const fcCost = monthlyForecast(m.month);
        expect(fcCost, `${m.month} は残り月`).not.toBeNull();
        const costText = await cellText(row, col(h, "実績"));
        expect(costText, `${m.month} 実績（見込）`).toContain(yen(fcCost, unit));
        expect(costText, `${m.month} 実績は見込と分かる`).toContain("見込");
        expect(await cellText(row, col(h, "残予算")), `${m.month} 残予算（見込）`).toBe(yen(m.budget - fcCost!, unit));
        expect(await cellText(row, col(h, "残予算率")), `${m.month} 残予算率（見込）`).toBe(formatPercent(m.budget ? (m.budget - fcCost!) / m.budget : null));
        expect(m.cost, `core の未来月の実績は 0`).toBe(0);
      } else {
        sumCost += m.cost;
        expect(await cellText(row, col(h, "実績")), `${m.month} 実績`).toBe(yen(m.cost, unit));
        expect(await cellText(row, col(h, "残予算")), `${m.month} 残予算`).toBe(yen(m.grossProfit, unit));
        expect(await cellText(row, col(h, "残予算率")), `${m.month} 残予算率`).toBe(formatPercent(m.budget ? m.grossProfit / m.budget : null));
      }
      expect(await cellText(row, col(h, "時間")), `${m.month} 時間`).toBe(`${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 }).format(m.hours)}h`);
      expect(await cellText(row, col(h, "状態")), `${m.month} 状態`).toContain(statusLabel[m.status]);
      expect(await cellText(row, col(h, "作業者数")), `${m.month} 作業者数`).toContain(String(m.costLines.length));
      expect(await cellText(row, col(h, "営業日")), `${m.month} 営業日`).toBe(String(m.businessDays));
    }
    // 合計行: 予算は全月、実績は実績月（確定・速報）のみ
    const foot = table.locator("tfoot tr");
    expect(await cellText(foot, col(h, "予算"))).toBe(yen(t.budget, unit));
    expect(await cellText(foot, col(h, "実績"))).toBe(yen(sumCost, unit));
    expect(sumCost).toBe(t.cost);
    // 3 方式の着地カード: 選択中が強調され、値が core と一致
    for (const method of ["recent3", "all", "assignment"] as const) {
      const card = page.locator(".yn-forecast-card").filter({ hasText: { recent3: "直近実績", all: "全期間平均", assignment: "アサイン計画" }[method] });
      await expect(card.locator(".yn-kpi-value")).toHaveText(yen(r.forecasts[method].forecastGrossProfit, unit));
    }
    await expect(page.locator(".yn-forecast-card.is-selected")).toHaveCount(1);
    await expect(page.locator(".yn-forecast-card.is-selected")).toContainText("直近実績");
    // カードのボタンで方式を切り替えると KPI が変わる
    await page.locator(".yn-forecast-card").filter({ hasText: "全期間平均" }).getByRole("button", { name: "この方式で表示" }).click();
    await expect(kpiValue(page, 4)).toHaveText(yen(r.forecasts.all.forecastGrossProfit, unit));
    await expect(page.locator(".yn-forecast-card.is-selected")).toContainText("全期間平均");
    expect(query(page).get("method")).toBe("all");
  });
  }

  test("期間を契約期間外にすると案件の全期間にフォールバックする（C003）", async ({ page }) => {
    // C003 は 2025-10〜2026-09。FY2026 の既定期間と重なるが、2027-01〜2027-03 にすると重ならない
    await gotoPage(page, "/contract?id=C003&from=2027-01&to=2027-03&unit=yen");
    await expect(page.locator(".yn-note-warn")).toContainText("重なりません");
    const r = contractResult("C003", model);
    const t = totalsFor({ from: r.contract.startMonth, to: r.contract.endMonth }, ["C003"], model);
    await expect(kpiValue(page, 0)).toHaveText(yen(t.budget, "yen"));
    await expect(kpiValue(page, 1)).toHaveText(yen(t.cost, "yen"));
  });

  test("百万円の丸めで 0 になる小さい金額は「0.0百万円」で、「-0.0」にならない（C003 2026-06 の残予算 -7,375 / C013 の月）", async ({ page }) => {
    const small = [
      { id: "C003", month: "2026-06", key: "grossProfit" as const },
      { id: "C013", month: "2026-04", key: "budget" as const },
      { id: "C013", month: "2026-04", key: "cost" as const },
      { id: "C013", month: "2026-04", key: "grossProfit" as const },
    ];
    const label = { budget: "予算", cost: "実績", grossProfit: "残予算" } as const;
    let negative = 0;
    for (const id of ["C003", "C013"]) {
      await gotoPage(page, `/contract?id=${id}&unit=m`);
      const table = tableByCaption(page, "月ごとの予実");
      const h = await headerIndex(table);
      for (const c of small.filter((x) => x.id === id)) {
        const cm = contractResult(id, model).months.find((m) => m.month === c.month)!;
        const v = cm[c.key];
        expect(v !== 0 && Math.abs(v) < 50_000, `前提: ${id} ${c.month} ${c.key}=${v} は百万円で 0.0 に丸まる非ゼロ`).toBe(true);
        if (v < 0) negative++;
        const text = await cellText(table.locator(`tbody tr[data-key="${c.month}"]`), col(h, label[c.key]));
        expect(text, `${id} ${c.month} ${label[c.key]}`).toBe(yen(v, "m"));
        expect(text.replace(/[▲\s]/g, ""), `${id} ${c.month} ${label[c.key]} は 0.0 百万円`).toBe("0.0百万円");
        expect(text, "マイナスゼロを出さない").not.toMatch(/[-−]\s*0\.0/);
      }
    }
    expect(negative, "負の小さい値（-7,375）を 1 件は含む").toBeGreaterThan(0);
  });
});
