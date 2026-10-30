/**
 * 着地見込みは選んだ期間の終わりまで（SPEC §53）。案件詳細には案件終了時点の着地も出す。
 * 期待値は計算コア（setForecastPeriod / contractEndForecasts）で作る。
 */
import { test, expect, gotoPage, kpiValue, tableByCaption, headerIndex, col, cellText } from "./helpers/app.js";
import { DEFAULT_UNIT, contractRowExpected, contractsInPeriod, fiscalPeriod, forecastFor, getModel, yen, type ForecastMethod } from "./helpers/core.js";
import { contractEndForecasts, setForecastPeriod } from "../../src/core/index.js";

const model = getModel();
const FY = fiscalPeriod(model);
const DEFAULT_METHOD = model.config.forecastMethodDefault as ForecastMethod;
/** 今年度の途中で終わらず、来年度へまたぐ案件（今年度に 1 か月以上掛かるもの） */
const crossing = model.contracts.find((r) => r.contract.startMonth <= FY.to && r.contract.endMonth > FY.to && r.contract.startMonth >= FY.from)!;

test("案件詳細: 年度をまたぐ案件は、期間の終わりの着地と案件終了時点の着地を並べる", async ({ page }) => {
  expect(crossing, "年度をまたぐ案件がダミーデータにある").toBeTruthy();
  const c = crossing.contract;
  await gotoPage(page, `/contract?id=${c.contractId}&unit=yen`);
  await expect(page.locator(".yn-kpi-grid").first().locator(".yn-kpi")).toHaveCount(6);
  setForecastPeriod(model, { from: c.startMonth > FY.from ? c.startMonth : FY.from, to: FY.to });
  await expect(kpiValue(page, 4)).toHaveText(yen(crossing.forecasts[DEFAULT_METHOD].forecastGrossProfit, "yen"));
  const end = contractEndForecasts(model, crossing);
  await expect(kpiValue(page, 5)).toHaveText(yen(end[DEFAULT_METHOD].forecastGrossProfit, "yen"));
  await expect(page.locator(".yn-kpi").nth(5)).toContainText("案件終了時点の着地");
  // 3 方式のカードにも案件終了時点の行
  const rows = page.locator(".yn-forecast-card .yn-forecast-end");
  await expect(rows).toHaveCount(3);
  await expect(rows.first().locator("button")).toHaveText(yen(end.assignment.forecastGrossProfit, "yen"));
  // 計算根拠: 対象の月は案件の全期間
  await kpiValue(page, 5).click();
  const d = page.locator("dialog.yn-dialog[open]");
  await expect(d).toBeVisible();
  await expect(d.locator(".yn-bd-rows")).toContainText(`${end[DEFAULT_METHOD].breakdown.contractMonthsInTarget.length}か月`);
});

test("案件詳細: 期間が案件の全期間なら、案件終了時点の着地は重複するので出さない", async ({ page }) => {
  const c = crossing.contract;
  await gotoPage(page, `/contract?id=${c.contractId}&from=${c.startMonth}&to=${c.endMonth}&unit=yen`);
  await expect(page.locator(".yn-kpi-grid").first().locator(".yn-kpi")).toHaveCount(5);
  await expect(page.locator(".yn-forecast-end")).toHaveCount(0);
  await expect(kpiValue(page, 4)).toHaveText(yen(contractEndForecasts(model, crossing)[DEFAULT_METHOD].forecastGrossProfit, "yen"));
});

test("全体・案件一覧: 期間を変えると着地見込みもその期間の終わりまでになる", async ({ page }) => {
  const period = { from: FY.from, to: model.meta.asOfMonth };
  await gotoPage(page, `/?from=${period.from}&to=${period.to}&unit=yen`);
  const fp = forecastFor(DEFAULT_METHOD, undefined, model, period);
  await expect(kpiValue(page, 4)).toHaveText(yen(fp.forecastGrossProfit, "yen"));
  expect(fp.forecastGrossProfit, "年度末とは違う値になる").not.toBe(forecastFor(DEFAULT_METHOD, undefined, model, FY).forecastGrossProfit);

  await gotoPage(page, `/contracts?from=${period.from}&to=${period.to}&unit=yen`);
  const table = tableByCaption(page, "案件一覧");
  const h = await headerIndex(table);
  for (const r of contractsInPeriod(period, undefined, model).slice(0, 8)) {
    const e = contractRowExpected(r, period, DEFAULT_METHOD, model);
    const row = table.locator(`tbody tr[data-key="${r.contract.contractId}"]`);
    expect((await cellText(row, col(h, "着地差"))).replace(/[▲\s]/g, ""), r.contract.contractId).toBe(e.forecastGrossProfit === null ? "—" : yen(e.forecastGrossProfit, "yen"));
  }
});

test("使い方: 着地見込みは選んだ期間の終わりまでと書き、年度末固定の説明が残っていない", async ({ page }) => {
  await gotoPage(page, "/guide");
  const main = page.locator("#observablehq-main");
  await expect(main).toContainText("選んだ期間の終わり");
  await expect(main).not.toContainText("今年度末");
  await expect(main).not.toContainText("左右されません");
  await gotoPage(page, "/rules");
  await expect(page.locator("#observablehq-main")).toContainText("期間の予算");
  await expect(page.locator("#observablehq-main")).not.toContainText("年度予算");
});
