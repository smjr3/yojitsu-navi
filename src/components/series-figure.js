/**
 * 単位を切り替えられるグラフの枠（SPEC §130）。
 * - monthlyFigure: 月次推移（全体・チーム・顧客・案件の詳細）。日・週・月・四半期・年度
 * - memberHoursFigure: メンバー詳細の計画と実績の時間。日・週・月・四半期・年度
 * 月は今までと同じグラフ。四半期・年度は月の値を足す。日・週は日ごとの実績（data/daily-history.json・data/member-days.json）を
 * 選んだときに初めて読む。日は終わりの DAY_UNIT_MONTHS か月だけ出す。
 */
import { html } from "htl";
import { h } from "./dom.js";
import { T } from "../i18n/index.js";
import { chartFigure } from "./chart-zoom.js";
import { memberHoursChart, memberHoursLegend, monthlyChart, monthlyLegend, seriesTable } from "./charts.js";
import { bucketLabel, bucketTick, bucketTipValue, chartMessage, loadUnit, saveUnit, unitSwitch } from "./chart-units.js";
import { periodJa } from "./format.js";
import { CHART_UNITS, isOutsideRow, bucketDays, bucketMemberHours, bucketMonths, contractDailyActuals, dayUnitRange } from "../core/index.js";

/** 単位ごとに描き直す入れ物。build(unit) は { figure } を返すか、Promise で返す（読み込み中は loading を出す） */
function switchable(kind, render) {
  const host = h("div", { class: "yn-unit-figure" });
  let unit = loadUnit(kind, CHART_UNITS);
  let token = 0;
  const show = () => {
    const my = ++token;
    const controls = unitSwitch({
      units: CHART_UNITS,
      value: unit,
      onChange: (u) => {
        unit = u;
        saveUnit(kind, u);
        show();
        host.querySelector(`.yn-chart-unit [data-unit="${u}"]`)?.focus();
      },
    });
    const out = render(unit, controls);
    if (out instanceof Promise) {
      host.replaceChildren(out.placeholder ?? chartFigure({ title: "", controls, draw: () => chartMessage(T.charts.loading) }));
      out.then((fig) => {
        if (my === token) host.replaceChildren(fig);
      });
    } else host.replaceChildren(out);
  };
  show();
  return host;
}

const tableDetails = (table) => html`<details class="yn-details"><summary>${T.pages.showTable}</summary>${table}</details>`;

/**
 * 月次推移。series は analysis.seriesWithForecast（＋ withTargets）の出力、contractIds は対象の案件（null = すべて）。
 * history は lazyJson(FileAttachment("./data/daily-history.json"))
 */
export function monthlyFigure({ model, series, unit, dark, history, contractIds = null, period, exportName, title = T.charts.monthlyTitle, table = true }) {
  const startMonth = model.config.fiscalYearStartMonth;
  const asOfMonth = model.meta.asOfMonth;
  const figure = (u, controls, data, sub) => {
    const isMonth = u === "month";
    const opts = isMonth
      ? {}
      : { tick: (d, i) => bucketTick(d, i, startMonth), tipLabel: (d) => bucketTipValue(d, startMonth, d.isActual ? "" : T.charts.suffixForecast), tipName: T.charts.tipPeriod, minBar: 1, fitDots: true };
    return chartFigure({
      title,
      subtitle: sub,
      legend: monthlyLegend(dark, data),
      controls,
      draw: (width, height) => monthlyChart({ series: data, monthSeries: series, unit, dark, width, height, asOfMonth, title, ...opts }),
      after: table ? tableDetails(seriesTable(data, { unit, exportName: isMonth ? exportName : `${exportName}_${u}`, ...(isMonth ? {} : { label: (d) => bucketLabel(d, startMonth) }) })) : null,
    });
  };
  return switchable("monthly", (u, controls) => {
    if (u === "month") return figure(u, controls, series, periodJa(period));
    if (u === "quarter" || u === "year") return figure(u, controls, bucketMonths(series, u, startMonth), periodJa(period));
    const range = u === "day" ? dayUnitRange(period, asOfMonth) : period;
    const loading = chartFigure({ title, subtitle: periodJa(range), controls, draw: () => chartMessage(T.charts.loading) });
    const p = history().then((hist) => {
      if (!hist) return chartFigure({ title, subtitle: periodJa(range), controls, draw: () => chartMessage(T.charts.loadFailed) });
      const actuals = contractDailyActuals(model, hist, contractIds ?? undefined, range);
      const data = bucketDays(series, actuals, { unit: u, range, asOf: model.meta.asOf, holidays: model.holidays });
      return figure(u, controls, data, periodJa(range));
    });
    p.placeholder = loading;
    return p;
  });
}

/**
 * メンバー詳細の計画と実績の時間。series は core の memberMonthlySeries の出力、months はそのメンバーの MemberMonth（運用保守以外の内訳に使う）。
 * days は lazyJson(FileAttachment("./data/member-days.json"))
 */
export function memberHoursFigure({ model, series, memberId, memberMonths, includeOutside, dark, days, period, title = T.charts.memberHoursTitle }) {
  const startMonth = model.config.fiscalYearStartMonth;
  const asOf = model.meta.asOf;
  const asOfMonth = model.meta.asOfMonth;
  const figure = (u, controls, data, sub) => {
    const isMonth = u === "month";
    const isNow = (d) => d.months.includes(asOfMonth) && (u === "day" ? d.from <= asOf : true);
    const isFuture = (d) => (u === "day" || u === "week" ? d.to > asOf : d.months[d.months.length - 1] >= asOfMonth);
    const opts = isMonth
      ? {}
      : { tick: (d, i) => bucketTick(d, i, startMonth), tipLabel: (d) => bucketTipValue(d, startMonth), tipName: T.charts.tipPeriod, minBar: 1, isNow, isFuture, unitName: T.charts.unitLabels[u] };
    return chartFigure({
      title,
      subtitle: sub,
      legend: memberHoursLegend(dark, data, asOfMonth, isMonth ? null : isNow),
      controls,
      draw: (width, height) => memberHoursChart({ series: data, dark, width, height, asOfMonth, title, ...opts }),
    });
  };
  return switchable("memberHours", (u, controls) => {
    if (u === "month") return figure(u, controls, series, periodJa(period));
    if (u === "quarter" || u === "year") return figure(u, controls, bucketMemberHours(series, u, { startMonth }), periodJa(period));
    const range = u === "day" ? dayUnitRange(period, asOfMonth) : period;
    const loading = chartFigure({ title, subtitle: periodJa(range), controls, draw: () => chartMessage(T.charts.loading) });
    const p = days().then((file) => {
      if (!file) return chartFigure({ title, subtitle: periodJa(range), controls, draw: () => chartMessage(T.charts.loadFailed) });
      // 月ごとの運用保守以外の計画・実績（日に配るときに、運用保守と分けて配る）
      const parts = new Map();
      for (const mm of memberMonths) {
        if (mm.memberId !== memberId) continue;
        let plannedOutside = 0;
        let actualOutside = 0;
        for (const row of mm.byContract) {
          if (!isOutsideRow(row)) continue;
          plannedOutside += row.plannedHours;
          actualOutside += row.actualHours;
        }
        parts.set(mm.month, { plannedOutside, actualOutside });
      }
      const data = bucketMemberHours(series, u, { startMonth, range, days: file.members?.[memberId] ?? null, parts, includeOutside, holidays: model.holidays, asOf });
      return figure(u, controls, data, periodJa(range));
    });
    p.placeholder = loading;
    return p;
  });
}
