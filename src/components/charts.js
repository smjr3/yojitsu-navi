/**
 * グラフ（Observable Plot）。色は dataviz の既定パレット（3 系列: 予算=青、原価=橙、粗利=青緑）。
 * 実績月と見込み月は 塗りの濃さ ＋ 破線 で区別する（色だけに頼らない）。
 * すべてのグラフは表（seriesTable）で同じ値を読める。
 */
import * as Plot from "@observablehq/plot";
import { html } from "htl";
import { STATUS_LABELS, formatHours, millions, money, monthJa, monthShort } from "./format.js";
import { dataTable } from "./table.js";

export function chartColors(dark) {
  return dark
    ? { budget: "#3987e5", cost: "#d95926", gp: "#199e70", surface: "#1a1a19", text: "#c3c2b7", muted: "#898781", grid: "#2c2c2a", axis: "#383835", danger: "#d03b3b" }
    : { budget: "#2a78d6", cost: "#eb6834", gp: "#1baf7a", surface: "#fcfcfb", text: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7", danger: "#d03b3b" };
}

/** 凡例（HTML。グラフとは独立に読める） */
export function chartLegend(items) {
  return html`<ul class="yn-legend" aria-label="凡例">${items.map(
    (it) => html`<li><span class=${`yn-legend-swatch yn-legend-${it.shape ?? "rect"}`} style=${`--c:${it.color}`} aria-hidden="true"></span>${it.label}</li>`,
  )}</ul>`;
}

/**
 * 月次推移: 予算と原価の棒 ＋ 粗利の折れ線。
 * series は analysis.seriesWithForecast() の出力（isActual, forecastCost, forecastGrossProfit を持つ）
 */
export function monthlyChart({ series, unit = "yen", dark = false, width = 640, height = 300, asOfMonth, title = "月次推移" }) {
  const c = chartColors(dark);
  const data = series.map((d, i) => ({ ...d, i }));
  const n = data.length;
  if (n === 0) return html`<div class="yn-chart-empty">表示する月がありません</div>`;
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
  const peak = Math.max(0, ...data.map((d) => Math.max(d.budget, d.cost, d.forecastCost ?? 0)));
  const axisUnit = peak >= 5e10 ? { label: "億円", div: 1e8 } : peak >= 5e6 ? { label: "百万円", div: 1e6 } : peak >= 5e4 ? { label: "万円", div: 1e4 } : { label: "円", div: 1 };
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
      // 予算（左の棒）。見込み月は薄く、年度外（見込み対象外）の月はさらに薄く
      Plot.rectY(data, { x1: (d) => d.i - gap - bw, x2: (d) => d.i - gap, y: "budget", fill: c.budget, fillOpacity: (d) => (d.isActual ? 1 : d.outsideFY ? 0.3 : 0.55), ry2: 4, title: null }),
      // 原価（実績）
      Plot.rectY(actual, { x1: (d) => d.i + gap, x2: (d) => d.i + gap + bw, y: "cost", fill: c.cost, ry2: 4 }),
      // 原価（見込み）: 薄い塗り ＋ 破線の枠
      Plot.rectY(remaining, { x1: (d) => d.i + gap, x2: (d) => d.i + gap + bw, y: "forecastCost", fill: c.cost, fillOpacity: 0.35, stroke: c.cost, strokeWidth: 1, strokeDasharray: "3 2", ry2: 4 }),
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
          anchor: "bottom",
          dy: -6,
          fill: c.surface,
          stroke: c.axis,
          fontSize: 12,
          channels: {
            月: (d) => `${monthJa(d.month)}（${STATUS_LABELS[d.status]}${d.isActual ? "" : d.outsideFY ? "・年度外" : "・見込み"}）`,
            予算: (d) => money(d.budget, unit),
            原価: (d) => (d.isActual ? money(d.cost, unit) : d.outsideFY ? "—（年度外のため見込み対象外）" : `${money(d.forecastCost, unit)}（見込み）`),
            速報実績: (d) => (!d.isActual && d.status === "preliminary" ? money(d.cost, unit) : null),
            粗利: (d) => (d.isActual ? money(d.grossProfit, unit) : d.outsideFY ? "—" : `${money(d.forecastGrossProfit, unit)}（見込み）`),
            時間: (d) => (d.hours > 0 ? formatHours(d.hours) : null),
          },
          format: { x: false, y: false },
        }),
      ),
    ].filter(Boolean),
  });
  plot.setAttribute("role", "img");
  plot.setAttribute("aria-label", `${title}。予算・原価の棒グラフと粗利の折れ線。値は下の表で確認できます。`);
  const outside = data.filter((d) => d.outsideFY);
  if (outside.length === 0) return plot;
  return html`<div>${plot}<p class="yn-chart-note">${monthShort(outside[0].month, true)}${outside.length > 1 ? `〜${monthShort(outside[outside.length - 1].month, true)}` : ""} は年度外のため見込み対象外（予算のみ表示）</p></div>`;
}

export function monthlyLegend(dark) {
  const c = chartColors(dark);
  return chartLegend([
    { label: "予算", color: c.budget },
    { label: "原価（実績）", color: c.cost },
    { label: "原価（見込み・破線枠）", color: c.cost, shape: "rect-dashed" },
    { label: "粗利（実績）", color: c.gp, shape: "line" },
    { label: "粗利（見込み・破線）", color: c.gp, shape: "line-dashed" },
  ]);
}

/** グラフの双子の表。実績月は実績、基準月以降は見込み、年度外の未来月は「年度外」（原価・粗利は無し） */
export function seriesTable(series, { unit = "yen", exportName = "monthly" } = {}) {
  const rows = series.map((d) => ({
    key: d.month,
    month: d.month,
    status: d.status,
    outsideFY: d.outsideFY === true,
    budget: d.budget,
    cost: d.isActual ? d.cost : null,
    forecastCost: d.forecastCost,
    grossProfit: d.isActual ? d.grossProfit : null,
    forecastGrossProfit: d.forecastGrossProfit,
    hours: d.hours,
    actualCostPrelim: !d.isActual && d.status === "preliminary" ? d.cost : null,
  }));
  const statusText = (r) => (r.outsideFY ? `${STATUS_LABELS[r.status]}・年度外` : STATUS_LABELS[r.status]);
  const columns = [
    { key: "month", label: "月", type: "text", render: (r) => monthJa(r.month), sortValue: (r) => r.month, exportValue: (r) => r.month },
    { key: "status", label: "状態", type: "text", render: (r) => (r.outsideFY ? html`<span title="年度外のため見込み対象外">${statusText(r)}</span>` : statusText(r)), exportValue: (r) => statusText(r) },
    { key: "budget", label: "予算", type: "money" },
    { key: "cost", label: "原価（実績）", type: "money", render: (r, u) => (r.cost === null ? (r.actualCostPrelim !== null && r.actualCostPrelim > 0 ? `${money(r.actualCostPrelim, u)}（速報）` : "—") : money(r.cost, u)), exportValue: (r) => r.cost ?? r.actualCostPrelim },
    { key: "forecastCost", label: "原価（見込み）", type: "money", render: (r, u) => (r.outsideFY ? "—" : money(r.forecastCost, u)) },
    { key: "grossProfit", label: "粗利", type: "money", render: (r, u) => (r.grossProfit === null ? (r.forecastGrossProfit === null ? "—" : `${money(r.forecastGrossProfit, u)}（見込み）`) : money(r.grossProfit, u)), exportValue: (r) => r.grossProfit ?? r.forecastGrossProfit },
    { key: "hours", label: "時間", type: "hours", hideOnPhone: true, hideNarrow: true },
  ];
  return dataTable({ columns, rows, unit, caption: "月次推移", exportName, sort: { key: "month", dir: "asc" } });
}

/**
 * メンバーの月次推移: 計画時間（青＝予）と実績時間（橙＝実）の棒を並べる。
 * series は core の memberMonthlySeries() の出力。基準月以降の月は背景を薄く塗り、実績がまだ無いことを示す。
 */
export function memberHoursChart({ series, dark = false, width = 640, height = 260, asOfMonth, title = "計画と実績の時間" }) {
  const c = chartColors(dark);
  const data = series.map((d, i) => ({ ...d, i }));
  const n = data.length;
  if (n === 0) return html`<div class="yn-chart-empty">表示する月がありません</div>`;
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
    y: { grid: true, label: "時間（h）", labelAnchor: "top", labelArrow: "none", nice: true, zero: true, tickSize: 0, line: false },
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
          anchor: "bottom",
          dy: -6,
          fill: c.surface,
          stroke: c.axis,
          fontSize: 12,
          channels: {
            月: (d) => `${monthJa(d.month)}（${STATUS_LABELS[d.status]}）`,
            計画: (d) => formatHours(d.plannedHours),
            実績: (d) => formatHours(d.actualHours),
            稼働率: (d) => (d.utilization === null ? "—（計画なし）" : `${(d.utilization * 100).toFixed(1)}%`),
          },
          format: { x: false, y: false },
        }),
      ),
    ].filter(Boolean),
  });
  plot.setAttribute("role", "img");
  plot.setAttribute("aria-label", `${title}。月ごとの計画時間と実績時間の棒グラフ。値は下の表で確認できます。`);
  return plot;
}

export function memberHoursLegend(dark) {
  const c = chartColors(dark);
  return chartLegend([
    { label: "計画時間（配分 × 基準時間）", color: c.budget },
    { label: "実績時間（作業実績）", color: c.cost },
  ]);
}

/** 消化率メーター（0〜120% の目盛、100% に基準線） */
export function burnMeter(rate, threshold = 1) {
  const max = 1.2;
  const v = typeof rate === "number" && Number.isFinite(rate) ? Math.min(rate, max) : 0;
  const over = typeof rate === "number" && rate > threshold;
  return html`<div class=${`yn-meter${over ? " is-danger" : ""}`} role="img" aria-label=${`消化率 ${rate === null ? "計算不可" : `${(rate * 100).toFixed(1)}%`}（基準 ${(threshold * 100).toFixed(0)}%）`}>
    <div class="yn-meter-track"><div class="yn-meter-fill" style=${`width:${(v / max) * 100}%`}></div><div class="yn-meter-mark" style=${`left:${(threshold / max) * 100}%`}></div></div>
  </div>`;
}
