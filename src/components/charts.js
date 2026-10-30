/**
 * グラフ（Observable Plot）。色は dataviz の既定パレット（3 系列: 予算=青、原価=橙、粗利=青緑）。
 * 実績月と見込み月は 塗りの濃さ ＋ 破線 で区別する（色だけに頼らない）。
 * すべてのグラフは表（seriesTable）で同じ値を読める。
 */
import * as Plot from "@observablehq/plot";
import { html } from "htl";
import { T, fmt } from "../i18n/index.js";
import { STATUS_LABELS, formatHours, formatPercent, millions, money, monthJa, monthShort } from "./format.js";
import { dataTable } from "./table.js";

export function chartColors(dark) {
  return dark
    ? { budget: "#3987e5", cost: "#d95926", gp: "#199e70", surface: "#1e2533", text: "#bfc6d2", muted: "#8b93a1", grid: "#2d3545", axis: "#3a4354", danger: "#d03b3b" }
    : { budget: "#2a78d6", cost: "#eb6834", gp: "#1baf7a", surface: "#fcfcfb", text: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7", danger: "#d03b3b" };
}

/** 凡例（HTML。グラフとは独立に読める） */
export function chartLegend(items) {
  return html`<ul class="yn-legend" aria-label=${T.charts.legend}>${items.map(
    (it) => html`<li><span class=${`yn-legend-swatch yn-legend-${it.shape ?? "rect"}`} style=${`--c:${it.color}`} aria-hidden="true"></span>${it.label}</li>`,
  )}</ul>`;
}

/**
 * 月次推移に目標（§63）を重ねる: 月を含む目標があれば targetCap = その月の予算 ×（1 − 目標の残予算率）。
 * targetOf(month) は core の targetForMonth を対象で包んだもの。無ければ series をそのまま返す
 */
export function withTargets(series, targetOf) {
  if (!targetOf) return series;
  return series.map((d) => {
    const t = targetOf(d.month);
    return t ? { ...d, targetCap: d.budget * (1 - t.remainingRate), targetRate: t.remainingRate } : d;
  });
}

const hasTarget = (series) => series.some((d) => d.targetCap != null);

/**
 * 月次推移: 予算と原価の棒 ＋ 粗利の折れ線。
 * series は analysis.seriesWithForecast() の出力（isActual, forecastCost, forecastGrossProfit を持つ。withTargets を通すと targetCap も）
 */
export function monthlyChart({ series, unit = "yen", dark = false, width = 640, height = 300, asOfMonth, title = T.charts.monthlyTitle }) {
  const c = chartColors(dark);
  const data = series.map((d, i) => ({ ...d, i }));
  const n = data.length;
  if (n === 0) return html`<div class="yn-chart-empty">${T.charts.noMonths}</div>`;
  const actual = data.filter((d) => d.isActual);
  const remaining = data.filter((d) => d.forecastCost !== null);
  // 見込みの折れ線は最後の実績点からつなぐ
  const lastActual = actual[actual.length - 1];
  const forecastLine = remaining.length
    ? [...(lastActual ? [{ ...lastActual, forecastGrossProfit: lastActual.grossProfit }] : []), ...remaining]
    : [];
  const hasForecast = remaining.length > 0;
  // 目盛りの間引き: 1 目盛りあたり 44px 以上（390px 幅で月ラベルが重ならないように。memberHoursChart と同じ）
  const every = Math.max(n > 14 ? 2 : 1, Math.ceil(n / Math.max(1, Math.floor((width - 76) / 44))));
  const ticks = data.filter((d) => d.i % every === 0).map((d) => d.i);
  const tickFormat = (i) => {
    const d = data[i];
    return d ? monthShort(d.month, i === 0) : "";
  };
  const targets = data.filter((d) => d.targetCap != null);
  const peak = Math.max(0, ...data.map((d) => Math.max(d.budget, d.cost, d.forecastCost ?? 0, d.targetCap ?? 0)));
  const axisUnit = peak >= 5e10 ? { label: T.charts.axisHundredMillionYen, div: 1e8 } : peak >= 5e6 ? { label: T.format.units.m, div: 1e6 } : peak >= 5e4 ? { label: T.charts.axisTenThousandYen, div: 1e4 } : { label: T.format.units.yen, div: 1 };
  const axisFormat = (v) => new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 }).format(v / axisUnit.div);
  // 左余白は最も長い目盛り（負の粗利を含む）に合わせる。固定だと桁が増えたとき符号が切れる
  const low = Math.min(0, ...data.map((d) => Math.min(d.grossProfit ?? 0, d.forecastGrossProfit ?? 0)));
  const marginLeft = Math.max(56, 12 + 7.5 * Math.max(axisFormat(peak).length, axisFormat(low).length + 1));
  const barW = Math.max(6, Math.min(24, ((width - 90) / n) * 0.42));
  const bw = barW / ((width - 90) / n); // 棒の幅（バンドの割合）
  const gap = 0.03;
  const yMax = (d) => Math.max(d.budget, d.cost, d.forecastCost ?? 0);

  const plot = Plot.plot({
    width,
    height,
    marginLeft,
    marginRight: 20,
    marginTop: 28,
    marginBottom: 32,
    style: { background: "transparent", color: c.text, fontSize: "12px", fontFamily: "inherit", overflow: "visible" },
    x: { domain: [-0.5, n - 0.5], ticks, tickFormat, tickSize: 0, label: null, line: false },
    // 値がすべて 0（契約 0 件など）だと y の domain が [0,0] になり棒が全高で描かれるので、範囲を与える
    y: { grid: true, label: axisUnit.label, labelAnchor: "top", labelArrow: "none", tickFormat: axisFormat, nice: true, zero: true, tickSize: 0, line: false, ...(peak === 0 && low === 0 ? { domain: [0, axisUnit.div] } : {}) },
    marks: [
      Plot.gridY({ stroke: c.grid, strokeOpacity: 1 }),
      Plot.ruleY([0], { stroke: c.axis }),
      // 基準月以降の背景（見込み領域）
      hasForecast && lastActual
        ? Plot.rectX([{ x1: lastActual.i + 0.5, x2: n - 0.5 }], { x1: "x1", x2: "x2", fill: c.muted, fillOpacity: 0.06 })
        : null,
      // 予算（左の棒）。見込み月は薄く
      Plot.rectY(data, { x1: (d) => d.i - gap - bw, x2: (d) => d.i - gap, y: "budget", fill: c.budget, fillOpacity: (d) => (d.isActual ? 1 : 0.55), ry2: 4, title: null }),
      // 原価（実績）
      Plot.rectY(actual, { x1: (d) => d.i + gap, x2: (d) => d.i + gap + bw, y: "cost", fill: c.cost, ry2: 4 }),
      // 原価（見込み）: 薄い塗り ＋ 破線の枠
      Plot.rectY(remaining, { x1: (d) => d.i + gap, x2: (d) => d.i + gap + bw, y: "forecastCost", fill: c.cost, fillOpacity: 0.35, stroke: c.cost, strokeWidth: 1, strokeDasharray: "3 2", ry2: 4 }),
      // 目標の上限（予算 ×（1 − 目標の残予算率））: 予算と実績の棒をまたぐ赤の破線。実績の棒が線を超えたら目標を外れている
      targets.length ? Plot.ruleY(targets, { y: "targetCap", x1: (d) => d.i - gap - bw - 0.06, x2: (d) => d.i + gap + bw + 0.06, stroke: c.danger, strokeWidth: 2, strokeDasharray: "4 2" }) : null,
      // 粗利（実績）
      Plot.line(actual, { x: "i", y: "grossProfit", stroke: c.gp, strokeWidth: 2, curve: "linear" }),
      Plot.dot(actual, { x: "i", y: "grossProfit", fill: c.gp, r: 4, stroke: c.surface, strokeWidth: 2 }),
      // 粗利（見込み）
      Plot.line(forecastLine, { x: "i", y: "forecastGrossProfit", stroke: c.gp, strokeWidth: 2, strokeDasharray: "5 4", curve: "linear" }),
      Plot.dot(remaining, { x: "i", y: "forecastGrossProfit", fill: c.surface, r: 4, stroke: c.gp, strokeWidth: 2 }),
      // クロスヘア ＋ ツールチップ
      Plot.ruleX(data, Plot.pointerX({ x: "i", stroke: c.muted, strokeOpacity: 0.6 })),
      Plot.tip(
        data,
        Plot.pointerX({
          x: "i",
          y: yMax,
          preferredAnchor: "bottom",
          dy: -6,
          fill: c.surface,
          stroke: c.axis,
          fontSize: 12,
          channels: {
            [T.charts.tipMonth]: (d) => fmt(T.charts.tipMonthValue, { month: monthJa(d.month), status: STATUS_LABELS[d.status], suffix: d.isActual ? "" : T.charts.suffixForecast }),
            [T.charts.tipBudget]: (d) => money(d.budget, unit),
            [T.charts.tipCost]: (d) => (d.isActual ? money(d.cost, unit) : fmt(T.charts.forecastValue, { value: money(d.forecastCost, unit) })),
            [T.charts.tipPrelim]: (d) => (!d.isActual && d.status === "preliminary" ? money(d.cost, unit) : null),
            [T.charts.tipGrossProfit]: (d) => (d.isActual ? money(d.grossProfit, unit) : fmt(T.charts.forecastValue, { value: money(d.forecastGrossProfit, unit) })),
            [T.charts.tipTarget]: (d) => (d.targetCap == null ? null : fmt(T.charts.targetValue, { value: money(d.targetCap, unit), rate: formatPercent(d.targetRate, Math.abs(Math.round(d.targetRate * 100) - d.targetRate * 100) < 1e-9 ? 0 : 1) })),
            [T.charts.tipHours]: (d) => (d.hours > 0 ? formatHours(d.hours) : null),
          },
          format: { x: false, y: false },
        }),
      ),
    ].filter(Boolean),
  });
  plot.setAttribute("role", "img");
  plot.setAttribute("aria-label", fmt(T.charts.monthlyAria, { title }));
  return plot;
}

export function monthlyLegend(dark, series = null) {
  const c = chartColors(dark);
  return chartLegend([
    { label: T.columns.budget, color: c.budget },
    { label: T.charts.costActual, color: c.cost },
    { label: T.charts.legendCostForecast, color: c.cost, shape: "rect-dashed" },
    { label: T.charts.gpActual, color: c.gp, shape: "line" },
    { label: T.charts.legendGpForecast, color: c.gp, shape: "line-dashed" },
    ...(series && hasTarget(series) ? [{ label: T.charts.legendTarget, color: c.danger, shape: "line-dashed" }] : []),
  ]);
}

/** グラフの双子の表。実績月は実績、基準月以降は見込み */
export function seriesTable(series, { unit = "yen", exportName = "monthly" } = {}) {
  const rows = series.map((d) => ({
    key: d.month,
    month: d.month,
    status: d.status,
    budget: d.budget,
    cost: d.isActual ? d.cost : null,
    forecastCost: d.forecastCost,
    grossProfit: d.isActual ? d.grossProfit : null,
    forecastGrossProfit: d.forecastGrossProfit,
    hours: d.hours,
    actualCostPrelim: !d.isActual && d.status === "preliminary" ? d.cost : null,
    targetCap: d.targetCap ?? null,
  }));
  const columns = [
    { key: "month", label: T.charts.colMonth, type: "text", render: (r) => monthJa(r.month), sortValue: (r) => r.month, exportValue: (r) => r.month },
    { key: "status", label: T.columns.status, type: "text", render: (r) => STATUS_LABELS[r.status], exportValue: (r) => STATUS_LABELS[r.status] },
    { key: "budget", label: T.columns.budget, type: "money" },
    { key: "cost", label: T.charts.costActual, type: "money", render: (r, u) => (r.cost === null ? (r.actualCostPrelim !== null && r.actualCostPrelim > 0 ? fmt(T.charts.prelimValue, { value: money(r.actualCostPrelim, u) }) : "—") : money(r.cost, u)), exportValue: (r) => r.cost ?? r.actualCostPrelim },
    { key: "forecastCost", label: T.charts.costForecast, type: "money", render: (r, u) => (r.forecastCost === null ? "—" : money(r.forecastCost, u)) },
    { key: "grossProfit", label: T.columns.grossProfit, type: "money", render: (r, u) => (r.grossProfit === null ? (r.forecastGrossProfit === null ? "—" : fmt(T.charts.forecastValue, { value: money(r.forecastGrossProfit, u) })) : money(r.grossProfit, u)), exportValue: (r) => r.grossProfit ?? r.forecastGrossProfit },
    ...(hasTarget(series) ? [{ key: "targetCap", label: T.charts.legendTarget, type: "money", render: (r, u) => (r.targetCap === null ? "—" : money(r.targetCap, u)) }] : []),
    { key: "hours", label: T.columns.hours, type: "hours", hideOnPhone: true, hideNarrow: true },
  ];
  return dataTable({ columns, rows, unit, caption: T.charts.monthlyTitle, exportName, sort: { key: "month", dir: "asc" } });
}

/**
 * メンバーの月次推移: 計画時間（青＝予）と実績時間（橙＝実）の棒を並べる。
 * series は core の memberMonthlySeries() の出力。基準月以降の月は背景を薄く塗り、実績がまだ無いことを示す。
 */
export function memberHoursChart({ series, dark = false, width = 640, height = 260, asOfMonth, title = T.charts.memberHoursTitle }) {
  const c = chartColors(dark);
  const data = series.map((d, i) => ({ ...d, i }));
  const n = data.length;
  if (n === 0) return html`<div class="yn-chart-empty">${T.charts.noMonths}</div>`;
  // 目盛りの間引き: 1 目盛りあたり 44px 以上（390px 幅で月ラベルが重ならないように）
  const every = Math.max(n > 14 ? 2 : 1, Math.ceil(n / Math.max(1, Math.floor((width - 64) / 44))));
  const ticks = data.filter((d) => d.i % every === 0).map((d) => d.i);
  const firstFuture = data.find((d) => d.month >= asOfMonth);
  const barW = Math.max(6, Math.min(22, ((width - 80) / n) * 0.4));
  const bw = barW / ((width - 80) / n);
  const gap = 0.03;
  const plot = Plot.plot({
    width,
    height,
    marginLeft: 48,
    marginRight: 16,
    marginTop: 24,
    marginBottom: 32,
    style: { background: "transparent", color: c.text, fontSize: "12px", fontFamily: "inherit", overflow: "visible" },
    x: { domain: [-0.5, n - 0.5], ticks, tickFormat: (i) => (data[i] ? monthShort(data[i].month, i === 0) : ""), tickSize: 0, label: null, line: false },
    // すべて 0h（退職・休職後の期間など）だと domain が [0,0] になり棒が全高で描かれるので、範囲を与える
    y: { grid: true, label: T.charts.hoursAxis, labelAnchor: "top", labelArrow: "none", nice: true, zero: true, tickSize: 0, line: false, ...(data.every((d) => !(d.plannedHours > 0) && !(d.actualHours > 0)) ? { domain: [0, 10] } : {}) },
    marks: [
      Plot.gridY({ stroke: c.grid, strokeOpacity: 1 }),
      Plot.ruleY([0], { stroke: c.axis }),
      firstFuture ? Plot.rectX([{ x1: firstFuture.i - 0.5, x2: n - 0.5 }], { x1: "x1", x2: "x2", fill: c.muted, fillOpacity: 0.06 }) : null,
      Plot.rectY(data, { x1: (d) => d.i - gap - bw, x2: (d) => d.i - gap, y: "plannedHours", fill: c.budget, ry2: 3 }),
      Plot.rectY(data, { x1: (d) => d.i + gap, x2: (d) => d.i + gap + bw, y: "actualHours", fill: c.cost, ry2: 3 }),
      Plot.ruleX(data, Plot.pointerX({ x: "i", stroke: c.muted, strokeOpacity: 0.6 })),
      Plot.tip(
        data,
        Plot.pointerX({
          x: "i",
          y: (d) => Math.max(d.plannedHours, d.actualHours),
          preferredAnchor: "bottom",
          dy: -6,
          fill: c.surface,
          stroke: c.axis,
          fontSize: 12,
          channels: {
            [T.charts.tipMonth]: (d) => fmt(T.charts.tipMonthValue, { month: monthJa(d.month), status: STATUS_LABELS[d.status], suffix: "" }),
            [T.charts.tipPlan]: (d) => formatHours(d.plannedHours),
            [T.charts.tipActual]: (d) => formatHours(d.actualHours),
            [T.charts.tipUtilization]: (d) => (d.utilization === null ? T.charts.noPlanDash : `${(d.utilization * 100).toFixed(1)}%`),
          },
          format: { x: false, y: false },
        }),
      ),
    ].filter(Boolean),
  });
  plot.setAttribute("role", "img");
  plot.setAttribute("aria-label", fmt(T.charts.memberHoursAria, { title }));
  return plot;
}

export function memberHoursLegend(dark) {
  const c = chartColors(dark);
  return chartLegend([
    { label: T.charts.legendPlanned, color: c.budget },
    { label: T.charts.legendActual, color: c.cost },
  ]);
}

/** 消化率メーター（0〜120% の目盛、100% に基準線） */
export function burnMeter(rate, threshold = 1) {
  const max = 1.2;
  const v = typeof rate === "number" && Number.isFinite(rate) ? Math.min(rate, max) : 0;
  const over = typeof rate === "number" && rate > threshold;
  return html`<div class=${`yn-meter${over ? " is-danger" : ""}`} role="img" aria-label=${fmt(T.charts.meterAria, { rate: rate === null ? T.charts.notComputable : `${(rate * 100).toFixed(1)}%`, threshold: `${(threshold * 100).toFixed(0)}%` })}>
    <div class="yn-meter-track"><div class="yn-meter-fill" style=${`width:${(v / max) * 100}%`}></div><div class="yn-meter-mark" style=${`left:${(threshold / max) * 100}%`}></div></div>
  </div>`;
}
