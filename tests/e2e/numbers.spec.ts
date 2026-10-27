/**
 * 数値の突合: 画面の KPI・一覧の行・契約詳細の月行が、計算コア（aggregate / forecastTotals / ContractMonth）と一致する
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
  presetPeriod,
  teamContractIds,
  totalsFor,
  treeAt,
  yen,
  type ForecastMethod,
  type Period,
} from "./helpers/core.js";

const model = getModel();
const FY = fiscalPeriod(model);

/** 全体サマリーの KPI 5 枚を core の値と比べる */
async function expectKpis(page: import("@playwright/test").Page, period: Period, teamId = "", method: ForecastMethod = "recent3", unit: "yen" | "k" = "yen") {
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
  test("KPI が core の aggregate / forecastTotals と一致（FY2026・円）", async ({ page }) => {
    await gotoPage(page, "/");
    await expect(page.locator(".yn-kpi-grid .yn-kpi")).toHaveCount(5);
    const { totals, fc } = await expectKpis(page, FY);
    // 補足: 契約数、粗利率、赤字件数
    await expect(page.locator(".yn-kpi").nth(0)).toContainText(`${totals.contractCount}件の契約`);
    await expect(page.locator(".yn-kpi").nth(2)).toContainText(formatPercent(totals.grossMargin));
    const deficit = fc.deficitContractIds.length;
    await expect(page.locator(".yn-kpi").nth(4).locator(".yn-chip")).toHaveText(deficit > 0 ? new RegExp(`赤字見込み ${deficit}件`) : /赤字見込みなし/);
    // URL は初回表示で正規化される
    const q = query(page);
    expect(q.get("from")).toBe(FY.from);
    expect(q.get("to")).toBe(FY.to);
    expect(q.get("unit")).toBe("yen");
    expect(q.get("method")).toBe("recent3");
  });

  test("千円に切り替えると KPI と URL が変わる", async ({ page }) => {
    await gotoPage(page, "/");
    await page.locator(".yn-seg-btn[data-unit=k]").click();
    await expect(page.locator(".yn-seg-btn[data-unit=k]")).toHaveAttribute("aria-pressed", "true");
    await expectKpis(page, FY, "", "recent3", "k");
    expect(query(page).get("unit")).toBe("k");
    await page.locator(".yn-seg-btn[data-unit=yen]").click();
    await expectKpis(page, FY, "", "recent3", "yen");
    expect(query(page).get("unit")).toBe("yen");
  });

  for (const preset of ["prevFy", "recent3", "recent12", "fy"] as const) {
    test(`期間プリセット ${preset} で KPI が core の値になる`, async ({ page }) => {
      await gotoPage(page, "/");
      const period = presetPeriod(preset, model);
      const btn = page.locator(`.yn-seg-btn[data-preset=${preset}]`);
      await btn.click();
      await expect(btn).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("#yn-filter-from")).toHaveValue(period.from);
      await expect(page.locator("#yn-filter-to")).toHaveValue(period.to);
      await expectKpis(page, period);
      expect(query(page).get("from")).toBe(period.from);
      expect(query(page).get("to")).toBe(period.to);
    });
  }

  test("開始月・終了月を選ぶと KPI が core の値になる", async ({ page }) => {
    await gotoPage(page, "/");
    const period = { from: "2026-06", to: "2026-09" };
    await page.locator("#yn-filter-from").selectOption(period.from);
    await page.locator("#yn-filter-to").selectOption(period.to);
    await expectKpis(page, period);
    expect(query(page).get("from")).toBe(period.from);
    expect(query(page).get("to")).toBe(period.to);
    // 逆転（終了 < 開始）は入れ替わる
    await page.locator("#yn-filter-to").selectOption("2026-05");
    await expect(page.locator("#yn-filter-from")).toHaveValue("2026-05");
    await expect(page.locator("#yn-filter-to")).toHaveValue("2026-05");
    await expectKpis(page, { from: "2026-05", to: "2026-05" });
  });

  for (const method of ["all", "assignment", "recent3"] as const) {
    test(`着地方式 ${method} で 着地見込み粗利 が core の forecastTotals と一致`, async ({ page }) => {
      await gotoPage(page, "/");
      await page.locator(`#yn-method-${method}`).check();
      await expect(page.locator(`input[name=yn-method][value=${method}]`)).toBeChecked();
      await expectKpis(page, FY, "", method);
      expect(query(page).get("method")).toBe(method);
      await expect(page.locator(".yn-kpi").nth(4).locator(".yn-kpi-label")).toContainText(
        { recent3: "直近実績", all: "全期間平均", assignment: "アサイン計画" }[method],
      );
    });
  }

  for (const teamId of ["S11", "T111", "D2", UNASSIGNED_TEAM_ID]) {
    test(`チーム ${teamId} で絞ると core の contractsForTeam の集計になる`, async ({ page }) => {
      await gotoPage(page, "/");
      await page.locator("#yn-filter-team").selectOption(teamId);
      await expect(page.locator("#yn-filter-team")).toHaveValue(teamId);
      const { totals } = await expectKpis(page, FY, teamId);
      const ids = teamContractIds(teamId, FY, model)!;
      expect(totals.contractCount).toBeLessThanOrEqual(ids.length);
      await expect(page.locator(".yn-kpi").nth(0)).toContainText(`${totals.contractCount}件の契約`);
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
    await expectKpis(page, FY);
    const q = query(page);
    expect(q.get("from")).toBe(FY.from);
    expect(q.get("to")).toBe(FY.to);
    expect(q.get("team")).toBe("");
    expect(q.get("unit")).toBe("yen");
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
    // 契約一覧にも引き継がれる
    await gotoPage(page, "/contracts");
    expect(query(page).get("unit")).toBe("k");
    // 新しいコンテキスト相当: localStorage を消すと既定に戻る
    await page.evaluate(() => localStorage.clear());
    await gotoPage(page, "/");
    await expectKpis(page, FY);
  });
});

test.describe("チーム一覧", () => {
  test("木のすべてのチーム行（＋未設定）が core の contractsForTeam + aggregate と一致", async ({ page }) => {
    await gotoPage(page, "/teams");
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
      expect(await cellText(row, col(h, "予算")), `${label} 予算`).toBe(yen(t.budget));
      expect(await cellText(row, col(h, "原価")), `${label} 原価`).toBe(yen(t.cost));
      expect(await cellText(row, col(h, "粗利")), `${label} 粗利`).toBe(yen(t.grossProfit));
      expect(await cellText(row, col(h, "粗利率")), `${label} 粗利率`).toBe(formatPercent(t.grossMargin));
      expect(await cellText(row, col(h, "契約数")), `${label} 契約数`).toBe(String(t.contractCount));
      expect(await cellText(row, col(h, "着地粗利")), `${label} 着地粗利`).toContain(yen(f.forecastGrossProfit));
      const burn = await cellText(row, col(h, "消化率"));
      expect(burn.replace(/[▲\s]/g, ""), `${label} 消化率`).toBe(formatPercent(t.burnRate));
      const nameCell = row.locator("th, td").nth(col(h, "チーム"));
      await expect(nameCell).toContainText(key === UNASSIGNED_TEAM_ID ? "未設定" : tree[key]!.name);
    }
  });
});

test.describe("契約一覧", () => {
  test("期間内の契約がすべて並び、各行が core の aggregate / forecast と一致", async ({ page }) => {
    await gotoPage(page, "/contracts");
    const table = tableByCaption(page, "契約一覧");
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
      expect(await cellText(row, col(h, "予算")), `${id} 予算`).toBe(yen(e.totals.budget));
      expect(await cellText(row, col(h, "原価")), `${id} 原価`).toBe(yen(e.totals.cost));
      expect(await cellText(row, col(h, "粗利")), `${id} 粗利`).toBe(yen(e.totals.grossProfit));
      expect(await cellText(row, col(h, "粗利率")), `${id} 粗利率`).toBe(formatPercent(e.totals.grossMargin));
      const burn = (await cellText(row, col(h, "消化率"))).replace(/[▲\s]/g, "");
      expect(burn, `${id} 消化率`).toBe(formatPercent(e.totals.burnRate));
      const fcText = (await cellText(row, col(h, "着地粗利"))).replace(/[▲\s]/g, "");
      expect(fcText, `${id} 着地粗利`).toBe(e.forecastGrossProfit === null ? "—" : yen(e.forecastGrossProfit));
      const status = await cellText(row, col(h, "状態"));
      if (e.isDeficit) expect(status, `${id} 状態`).toContain("赤字見込み");
      if (e.isOverBudget) expect(status, `${id} 状態`).toContain("予算超過");
      if (!e.isDeficit && !e.isOverBudget && e.includesPreliminary) expect(status, `${id} 状態`).toContain("速報含む");
      // 行の先頭セルに契約IDと顧客名
      const first = await cellText(row, 0);
      expect(first).toContain(id);
      expect(first).toContain(r.contract.customerName);
      // 赤字 or 超過の行は is-danger
      if (e.isDeficit || e.isOverBudget) await expect(row).toHaveClass(/is-danger/);
    }
    // 合計行
    const foot = table.locator("tfoot tr");
    await expect(foot).toHaveCount(1);
    expect(await cellText(foot, col(h, "予算"))).toBe(yen(sumBudget));
    expect(await cellText(foot, col(h, "原価"))).toBe(yen(sumCost));
    expect(await cellText(foot, col(h, "粗利"))).toBe(yen(sumBudget - sumCost));
    await expect(foot).toContainText(`合計（${expected.length}件）`);
    await expect(page.locator(".yn-table-count")).toHaveText(`${expected.length} 件`);
  });

  test("千円でも各行が一致", async ({ page }) => {
    await gotoPage(page, "/contracts?unit=k");
    const table = tableByCaption(page, "契約一覧");
    const h = await headerIndex(table);
    for (const r of contractsInPeriod(FY, undefined, model)) {
      const id = r.contract.contractId;
      const row = table.locator(`tbody tr[data-key="${id}"]`);
      const e = contractRowExpected(r, FY, "recent3", model);
      expect(await cellText(row, col(h, "予算")), `${id} 予算`).toBe(yen(e.totals.budget, "k"));
      expect(await cellText(row, col(h, "原価")), `${id} 原価`).toBe(yen(e.totals.cost, "k"));
    }
  });
});

test.describe("契約詳細", () => {
  test("C008: KPI と月ごとの予実が core の ContractMonth と一致", async ({ page }) => {
    await gotoPage(page, "/contract?id=C008");
    const r = contractResult("C008", model);
    const t = totalsFor(FY, ["C008"], model);
    const f = r.forecasts.recent3;
    await expect(page.locator("h1")).toContainText("C008");
    await expect(page.locator("h1")).toContainText(r.contract.customerName);
    await expect(kpiValue(page, 0)).toHaveText(yen(t.budget));
    await expect(kpiValue(page, 1)).toHaveText(yen(t.cost));
    await expect(kpiValue(page, 2)).toHaveText(yen(t.grossProfit));
    await expect(kpiValue(page, 3)).toHaveText(formatPercent(t.burnRate));
    await expect(kpiValue(page, 4)).toHaveText(yen(f.forecastGrossProfit));
    expect(f.isDeficit, "C008 はダミーデータ上は赤字見込み").toBe(true);
    await expect(page.locator(".yn-kpi").nth(4).locator(".yn-chip")).toContainText("赤字見込み");
    // 基本情報
    await expect(page.locator(".yn-facts")).toContainText(yen(r.contract.totalAmount));
    await expect(page.locator(".yn-facts")).toContainText(`${r.months.length}か月`);

    const table = tableByCaption(page, "月ごとの予実");
    await expect(table).toBeVisible();
    const h = await headerIndex(table);
    const months = r.months.filter((m) => FY.from <= m.month && m.month <= FY.to);
    const keys = (await dataRows(table).evaluateAll((trs) => trs.map((tr) => tr.getAttribute("data-key")))) as string[];
    expect(keys).toEqual(months.map((m) => m.month));
    const statusLabel = { final: "確定", preliminary: "速報", future: "予定", outside: "期間外" } as const;
    // 予定（未来）の月は選択中の方式の見込み原価（recent3/all: 平均 × 1 か月、analysis.forecastMonthlyCost と同じ）を「見込」として表示する
    const monthlyForecast = (month: string) => (f.breakdown.remainingMonths.includes(month) ? Math.round(f.breakdown.averageMonthlyCost) : null);
    let sumCost = 0;
    for (const m of months) {
      const row = table.locator(`tbody tr[data-key="${m.month}"]`);
      expect(await cellText(row, col(h, "予算")), `${m.month} 予算`).toBe(yen(m.budget));
      if (m.status === "future") {
        const fcCost = monthlyForecast(m.month);
        expect(fcCost, `${m.month} は残り月`).not.toBeNull();
        const costText = await cellText(row, col(h, "原価"));
        expect(costText, `${m.month} 原価（見込）`).toContain(yen(fcCost));
        expect(costText, `${m.month} 原価は見込と分かる`).toContain("見込");
        expect(await cellText(row, col(h, "粗利")), `${m.month} 粗利（見込）`).toBe(yen(m.budget - fcCost!));
        expect(await cellText(row, col(h, "粗利率")), `${m.month} 粗利率（見込）`).toBe(formatPercent(m.budget ? (m.budget - fcCost!) / m.budget : null));
        expect(m.cost, `core の未来月の原価は 0`).toBe(0);
      } else {
        sumCost += m.cost;
        expect(await cellText(row, col(h, "原価")), `${m.month} 原価`).toBe(yen(m.cost));
        expect(await cellText(row, col(h, "粗利")), `${m.month} 粗利`).toBe(yen(m.grossProfit));
        expect(await cellText(row, col(h, "粗利率")), `${m.month} 粗利率`).toBe(formatPercent(m.budget ? m.grossProfit / m.budget : null));
      }
      expect(await cellText(row, col(h, "時間")), `${m.month} 時間`).toBe(`${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 }).format(m.hours)}h`);
      expect(await cellText(row, col(h, "状態")), `${m.month} 状態`).toContain(statusLabel[m.status]);
      expect(await cellText(row, col(h, "作業者数")), `${m.month} 作業者数`).toContain(String(m.costLines.length));
      expect(await cellText(row, col(h, "営業日")), `${m.month} 営業日`).toBe(String(m.businessDays));
    }
    // 合計行: 予算は全月、原価は実績月（確定・速報）のみ
    const foot = table.locator("tfoot tr");
    expect(await cellText(foot, col(h, "予算"))).toBe(yen(t.budget));
    expect(await cellText(foot, col(h, "原価"))).toBe(yen(sumCost));
    expect(sumCost).toBe(t.cost);
    // 3 方式の着地カード: 選択中が強調され、値が core と一致
    for (const method of ["recent3", "all", "assignment"] as const) {
      const card = page.locator(".yn-forecast-card").filter({ hasText: { recent3: "直近実績", all: "全期間平均", assignment: "アサイン計画" }[method] });
      await expect(card.locator(".yn-kpi-value")).toHaveText(yen(r.forecasts[method].forecastGrossProfit));
    }
    await expect(page.locator(".yn-forecast-card.is-selected")).toHaveCount(1);
    await expect(page.locator(".yn-forecast-card.is-selected")).toContainText("直近実績");
    // カードのボタンで方式を切り替えると KPI が変わる
    await page.locator(".yn-forecast-card").filter({ hasText: "全期間平均" }).getByRole("button", { name: "この方式で表示" }).click();
    await expect(kpiValue(page, 4)).toHaveText(yen(r.forecasts.all.forecastGrossProfit));
    await expect(page.locator(".yn-forecast-card.is-selected")).toContainText("全期間平均");
    expect(query(page).get("method")).toBe("all");
  });

  test("期間を契約期間外にすると契約の全期間にフォールバックする（C003）", async ({ page }) => {
    // C003 は 2025-10〜2026-09。FY2026 の既定期間と重なるが、2027-01〜2027-03 にすると重ならない
    await gotoPage(page, "/contract?id=C003&from=2027-01&to=2027-03");
    await expect(page.locator(".yn-note-warn")).toContainText("重なりません");
    const r = contractResult("C003", model);
    const t = totalsFor({ from: r.contract.startMonth, to: r.contract.endMonth }, ["C003"], model);
    await expect(kpiValue(page, 0)).toHaveText(yen(t.budget));
    await expect(kpiValue(page, 1)).toHaveText(yen(t.cost));
  });
});
