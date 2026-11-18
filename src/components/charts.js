/**
 * グラフ（Observable Plot）。色は dataviz の既定パレット（3 系列: 予算=青、原価=橙、粗利=青緑）。
 * 実績月と見込み月は 塗りの濃さ ＋ 破線 で区別する（色だけに頼らない）。
 * すべてのグラフは表（seriesTable）で同じ値を読める。
 */
import * as Plot from "@observablehq/plot";
import { html } from "htl";
import { scaledPx } from "./appearance.js";
import { T, fmt } from "../i18n/index.js";
import { STATUS_LABELS, formatHours, formatPercent, maxFractionFormat, millions, money, monthJa, monthShort } from "./format.js";
import { dataTable } from "./table.js";

/** 予算の線の太さ（月次推移・今月の進捗・リソース計画の金額のグラフで同じ。§147） */
export const BUDGET_LINE_WIDTH = 3.5;

export function chartColors(dark) {
  return dark
    ? { budget: "#3987e5", cost: "#d95926", gp: "#199e70", surface: "#1e2533", text: "#bfc6d2", muted: "#8b93a1", grid: "#2d3545", axis: "#3a4354", danger: "#d03b3b", target: "#b38cf6" }
    : { budget: "#2a78d6", cost: "#eb6834", gp: "#1baf7a", surface: "#fcfcfb", text: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7", danger: "#d03b3b", target: "#7b3fd1" };
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
 * 日・週の単位（§130）は予算を出さない（2026-11-17 依頼者「日次で予算は設定しなくていい」「予算管理は月次から」）。実績・見込み・速報の棒だけで、
 * 予算の線・予算超過の赤・残予算・目標の上限は、グラフ・凡例・ツールチップ・表（Excel）のどれにも出さない。予算との比較は月以上で見る
 */
const isDaySeries = (series) => series.length > 0 && (series[0].unit === "day" || series[0].unit === "week");
/** 予算を超えた実績・見込みがあるか（§130 の赤い部分の凡例を出すか） */
const hasOverBudget = (series) => !isDaySeries(series) && series.some((d) => (d.isActual ? d.cost : (d.forecastCost ?? 0)) > d.budget);

/** 今月（月の途中）の速報の実績（§125）。基準月以降で実績が入っている月だけ */
// 日・週・四半期・年度（§130）は、今日を含む・見込みの月を含む棒（partial）の今日までの実績も斜線
const isPrelimNow = (d) => !d.isActual && (d.status === "preliminary" || d.partial === true) && d.cost > 0;
const hasPrelimValue = (d) => !d.isActual && (d.status === "preliminary" || d.partial === true);
const hasPrelimNow = (series) => series.some(isPrelimNow);

/**
 * 斜線の塗り（今月の速報の実績）。Plot の fill に url(#id) を渡し、描いた svg に pattern を足す。
 * 色だけに頼らず、確定・速報済みの月の実線の棒と見分けられるようにする。
 * id は色で決める（描き直し・テーマの往復で同じ値になる。同じ id の pattern が複数あっても中身は同じ）
 */
function hatchFill(color) {
  const id = `yn-hatch-${color.replace(/[^0-9a-z]/gi, "")}`;
  const attach = (plot) => {
    const svg = plot.tagName?.toLowerCase() === "svg" ? plot : plot.querySelector("svg");
    if (!svg) return;
    const ns = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(ns, "defs");
    const pat = document.createElementNS(ns, "pattern");
    pat.setAttribute("id", id);
    pat.setAttribute("width", "6");
    pat.setAttribute("height", "6");
    pat.setAttribute("patternUnits", "userSpaceOnUse");
    pat.setAttribute("patternTransform", "rotate(45)");
    const bg = document.createElementNS(ns, "rect");
    bg.setAttribute("width", "6");
    bg.setAttribute("height", "6");
    bg.setAttribute("fill", color);
    bg.setAttribute("fill-opacity", "0.45");
    const line = document.createElementNS(ns, "rect");
    line.setAttribute("width", "3");
    line.setAttribute("height", "6");
    line.setAttribute("fill", color);
    pat.append(bg, line);
    defs.append(pat);
    svg.prepend(defs);
  };
  return { fill: `url(#${id})`, attach };
}

/**
 * 月次推移: 予算と原価の棒 ＋ 粗利の折れ線。
 * series は analysis.seriesWithForecast() の出力（isActual, forecastCost, forecastGrossProfit を持つ。withTargets を通すと targetCap も）。
 * 日・週・四半期・年度（§130）は core の bucketMonths / bucketDays の出力を渡し、tick（目盛り）・tipLabel（ツールチップの 1 行目）を渡す
 */
/**
 * 予算の消化率の帯（§130。2026-11-17 依頼者が C＋D 案を選択）: 横軸のすぐ下に期間ごとの極細のバー（消化した分を実績の橙、超えたら赤。消化率メーターと同じ §131）、その下に消化率。
 * どの単位でも同じ位置・同じ見た目にして、単位を切り替えても見方が変わらないようにする。
 * 日・週は予算を棒に配らない（予算管理は月次から）ので、月ごとにまとめて「10月 139%」と出す（monthSeries = 月の単位の series）。
 * 月・四半期・年度は棒ごと。消化率 = 実績（今の期間は今日までの速報）÷ 期間の予算。実績のない未来の期間はバーの地だけ
 */
function budgetSegments(data, { noBudget, monthSeries, asOfMonth, nameOf }) {
  const segs = [];
  if (noBudget) {
    if (!monthSeries) return [];
    const byMonth = new Map(monthSeries.map((m) => [m.month, m]));
    for (const d of data) {
      const month = d.months[0];
      const last = segs[segs.length - 1];
      if (last && last.month === month) last.i1 = d.i;
      else segs.push({ month, i0: d.i, i1: d.i });
    }
    for (const g of segs) {
      const m = byMonth.get(g.month);
      g.budget = m?.budget ?? 0;
      g.cost = m?.cost ?? 0;
      g.has = !!m && (m.isActual || g.month === asOfMonth);
      g.label = fmt(T.charts.stripMonth, { month: Number(g.month.slice(5)) });
      g.name = monthJa(g.month);
    }
  } else {
    for (const d of data) {
      const months = d.months ?? [d.month];
      segs.push({ i0: d.i, i1: d.i, budget: d.budget, cost: d.cost, has: d.isActual || months.includes(asOfMonth), label: "", name: nameOf(d) });
    }
  }
  for (const g of segs) {
    g.rate = g.has && g.budget > 0 ? g.cost / g.budget : null;
    g.over = g.rate != null && g.rate > 1;
  }
  return segs;
}

/** 帯を描く Plot の関数マーク。文字が期間の幅に収まらないときは全期間で「月」を省き、それでも収まらなければ文字を出さない（バーとホバーは残る） */
function budgetStripMark(segs, { c, unit }) {
  const NS = "http://www.w3.org/2000/svg";
  const el = (name, attrs) => {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  };
  return (_index, scales, _values, dimensions) => {
    const g = el("g", { class: "yn-budget-strip" });
    const base = dimensions.height - dimensions.marginBottom;
    const barY = base + scaledPx(3);
    const barH = scaledPx(5);
    // 消化率の文字はバーのすぐ下（目盛りの文字はその下。バーと % が離れないように。2026-11-18 依頼者）
    // 文字の幅の目安: 全角は 1 文字ぶん、半角は 0.62 文字ぶん
    const textW = (t, size) => [...t].reduce((w, ch) => w + (/[\x20-\x7e]/.test(ch) ? 0.62 : 1), 0) * size;
    const pctOf = (s) => (s.rate == null ? "" : formatPercent(s.rate, 0));
    const numOf = (s) => (s.rate == null ? "" : String(Math.round(s.rate * 100)));
    const fullOf = (s) => [s.label, pctOf(s)].filter(Boolean).join(" ");
    const room = (s) => scales.x(s.i1 + 0.5) - scales.x(s.i0 - 0.5) - 4;
    // 出し方は全期間でそろえる（ばらばらに欠けないように）。狭い画面（スマートフォン）でも % が出るよう、
    // 「10月 139%」→「139%」→ 文字を小さく →「139」（% は左端に 1 つ）の順に詰める。それでも無理なら文字なし
    const LEVELS = [
      { text: fullOf, size: 11 },
      { text: pctOf, size: 11 },
      { text: pctOf, size: 10 },
      { text: pctOf, size: 9 },
      { text: numOf, size: 9, unit: true },
    ];
    const level = LEVELS.find((lv) => segs.every((s) => textW(lv.text(s), scaledPx(lv.size)) <= room(s))) ?? null;
    const fontSize = scaledPx(level?.size ?? 11);
    const textY = barY + barH + fontSize + scaledPx(2);
    // 帯の名前を左（縦軸の文字の列）に出し、何のバーかを読めるようにする（§146。2026-11-18 依頼者）。数字だけに詰めたときは「消化率%」
    const name = el("text", { x: dimensions.marginLeft - scaledPx(6), y: textY, "text-anchor": "end", "font-size": fontSize, fill: c.muted, class: "yn-budget-strip-name" });
    name.textContent = level?.unit ? T.charts.stripNameUnit : T.charts.stripName;
    g.append(name);
    for (const s of segs) {
      const x1 = scales.x(s.i0 - 0.5);
      const x2 = scales.x(s.i1 + 0.5);
      const pad = Math.min(2, (x2 - x1) * 0.1);
      const w = Math.max(0, x2 - x1 - pad * 2);
      const seg = el("g", { class: s.over ? "yn-budget-strip-seg is-over" : "yn-budget-strip-seg" });
      seg.append(el("rect", { x: x1 + pad, y: barY, width: w, height: barH, rx: barH / 2, fill: c.budget, "fill-opacity": 0.18 }));
      if (s.rate != null && s.rate > 0) seg.append(el("rect", { x: x1 + pad, y: barY, width: w * Math.min(1, s.rate), height: barH, rx: barH / 2, fill: s.over ? c.danger : c.cost }));
      const pct = pctOf(s);
      const text = level ? level.text(s) : "";
      if (text) {
        const t = el("text", { x: (x1 + x2) / 2, y: textY, "text-anchor": "middle", "font-size": fontSize, fill: s.over ? c.danger : c.muted, "font-weight": s.over ? 700 : 400 });
        t.textContent = text;
        seg.append(t);
      }
      const title = el("title", {});
      title.textContent = s.rate == null ? s.name : fmt(T.charts.stripTip, { name: s.name, cost: money(s.cost, unit), budget: money(s.budget, unit), rate: pct });
      seg.append(title);
      g.append(seg);
    }
    return g;
  };
}

export function monthlyChart({ series, unit = "yen", dark = false, width = 640, height = 300, asOfMonth, title = T.charts.monthlyTitle, tick = null, tipLabel = null, tipName = T.charts.tipMonth, minBar = 6, fitDots = false, monthSeries = null }) {
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
    return d ? (tick ? tick(d, i) : monthShort(d.month, i === 0)) : "";
  };
  const noBudget = isDaySeries(data);
  const targets = noBudget ? [] : data.filter((d) => d.targetCap != null);
  const peak = Math.max(0, ...data.map((d) => Math.max(noBudget ? 0 : d.budget, d.cost, d.forecastCost ?? 0, noBudget ? 0 : d.targetCap ?? 0)));
  const axisUnit = peak >= 5e10 ? { label: T.charts.axisHundredMillionYen, div: 1e8 } : peak >= 5e6 ? { label: T.format.units.m, div: 1e6 } : peak >= 5e4 ? { label: T.charts.axisTenThousandYen, div: 1e4 } : { label: T.format.units.yen, div: 1 };
  const axisFormat = (v) => maxFractionFormat(1).format(v / axisUnit.div);
  // 左余白は最も長い目盛り（負の粗利を含む）に合わせる。固定だと桁が増えたとき符号が切れる
  const low = noBudget ? 0 : Math.min(0, ...data.map((d) => Math.min(d.grossProfit ?? 0, d.forecastGrossProfit ?? 0)));
  const marginLeft = scaledPx(Math.max(56, 12 + 7.5 * Math.max(axisFormat(peak).length, axisFormat(low).length + 1)));
  const barW = Math.max(minBar, Math.min(24, ((width - 90) / n) * 0.42));
  const bw = barW / ((width - 90) / n); // 棒の幅（バンドの割合）
  const gap = 0.03;
  // 実績の棒の半幅: 以前の予算・実績 2 本ぶんの幅を 1 本で使う
  const half = Math.min(0.36, bw + gap);
  // 予算の段の線: 各期間の幅いっぱいの水平線をつなぐ。見込みの期間は別の線（薄く）にし、境目は縦につなぐ
  const step = (d) => [{ x: d.i - 0.5, y: d.budget }, { x: d.i + 0.5, y: d.budget }];
  const budgetPast = data.filter((d) => d.isActual).flatMap(step);
  const budgetFuture = data.filter((d) => !d.isActual).flatMap(step);
  if (budgetPast.length && budgetFuture.length) budgetFuture.unshift(budgetPast[budgetPast.length - 1]);
  const yMax = (d) => Math.max(noBudget ? 0 : d.budget, d.cost, d.forecastCost ?? 0);
  // 棒が細かいとき（日・週。§130）は残予算の点を小さくする（月は今までどおり）
  const band = (width - 90) / n;
  const dotR = fitDots ? Math.max(1.5, Math.min(4, band * 0.25)) : 4;
  const dotStroke = fitDots && dotR < 4 ? 1 : 2;
  // 今月の速報の実績（§125）: 見込みの破線枠の中に、入っている分を斜線で描く
  const prelim = data.filter(isPrelimNow);
  const hatch = prelim.length ? hatchFill(c.cost) : null;

  const segs = budgetSegments(data, { noBudget, monthSeries, asOfMonth, nameOf: (d) => (tipLabel ? tipLabel(d) : monthJa(d.month)) });
  const strip = segs.length > 0;

  const plot = Plot.plot({
    width,
    height,
    marginLeft,
    marginRight: scaledPx(20),
    marginTop: scaledPx(28),
    // 消化率の帯（§130）の分だけ下を広げる。グラフ全体の高さは変えない
    marginBottom: scaledPx(strip ? 56 : 32),
    style: { background: "transparent", color: c.text, fontSize: `${scaledPx(12)}px`, fontFamily: "inherit", overflow: "visible" },
    x: { domain: [-0.5, n - 0.5], ticks, tickFormat, tickSize: 0, tickPadding: scaledPx(strip ? 28 : 3), label: null, line: false },
    // 値がすべて 0（契約 0 件など）だと y の domain が [0,0] になり棒が全高で描かれるので、範囲を与える
    y: { grid: true, label: axisUnit.label, labelAnchor: "top", labelArrow: "none", tickFormat: axisFormat, nice: true, zero: true, tickSize: 0, line: false, ...(peak === 0 && low === 0 ? { domain: [0, axisUnit.div] } : {}) },
    marks: [
      Plot.gridY({ stroke: c.grid, strokeOpacity: 1 }),
      Plot.ruleY([0], { stroke: c.axis }),
      // 基準月以降の背景（見込み領域）
      hasForecast && lastActual
        ? Plot.rectX([{ x1: lastActual.i + 0.5, x2: n - 0.5 }], { x1: "x1", x2: "x2", fill: c.muted, fillOpacity: 0.06 })
        : null,
      // 実績（§130: 予算は棒にせず段の線。棒は実績だけにして本数を半分にする）
      Plot.rectY(actual, { x1: (d) => d.i - half, x2: (d) => d.i + half, y: "cost", fill: c.cost, ry2: 4 }),
      // 実績のうち予算を超えた分は赤
      noBudget ? null : Plot.rectY(actual.filter((d) => d.cost > d.budget), { x1: (d) => d.i - half, x2: (d) => d.i + half, y1: "budget", y2: "cost", fill: c.danger }),
      // 実績（見込み）: 薄い塗り ＋ 破線の枠
      Plot.rectY(remaining, { x1: (d) => d.i - half, x2: (d) => d.i + half, y: "forecastCost", fill: c.cost, fillOpacity: 0.35, stroke: c.cost, strokeWidth: 1, strokeDasharray: "3 2", ry2: 4 }),
      // 実績（今月の速報）: 斜線
      hatch ? Plot.rectY(prelim, { x1: (d) => d.i - half, x2: (d) => d.i + half, y: "cost", fill: hatch.fill, stroke: c.cost, strokeWidth: 1, ry2: 4 }) : null,
      // 見込みのうち予算を超える分は薄い赤（速報の斜線の上に重ねても斜線が透けて見える）
      noBudget ? null : Plot.rectY(remaining.filter((d) => d.forecastCost > d.budget), { x1: (d) => d.i - half, x2: (d) => d.i + half, y1: "budget", y2: "forecastCost", fill: c.danger, fillOpacity: 0.35, stroke: c.danger, strokeWidth: 1, strokeDasharray: "3 2" }),
      // 予算の線は棒より前に出す（超えた分の境目が見えるように）
      noBudget ? null : Plot.line(budgetPast, { x: "x", y: "y", stroke: c.budget, strokeWidth: BUDGET_LINE_WIDTH }),
      !noBudget && budgetFuture.length ? Plot.line(budgetFuture, { x: "x", y: "y", stroke: c.budget, strokeWidth: BUDGET_LINE_WIDTH, strokeOpacity: 0.55 }) : null,
      // 目標の上限（予算 ×（1 − 目標の残予算率））: 予算と実績の棒をまたぐ紫の破線（§140）。実績の棒が線を超えたら目標を外れている
      !noBudget && targets.length ? Plot.ruleY(targets, { y: "targetCap", x1: (d) => d.i - half - 0.06, x2: (d) => d.i + half + 0.06, stroke: c.target, strokeWidth: 2, strokeDasharray: "4 2" }) : null,
      // 粗利（実績）
      noBudget ? null : Plot.line(actual, { x: "i", y: "grossProfit", stroke: c.gp, strokeWidth: 2, curve: "linear" }),
      noBudget ? null : Plot.dot(actual, { x: "i", y: "grossProfit", fill: c.gp, r: dotR, stroke: c.surface, strokeWidth: dotStroke }),
      // 粗利（見込み）
      noBudget ? null : Plot.line(forecastLine, { x: "i", y: "forecastGrossProfit", stroke: c.gp, strokeWidth: 2, strokeDasharray: "5 4", curve: "linear" }),
      noBudget ? null : Plot.dot(remaining, { x: "i", y: "forecastGrossProfit", fill: c.surface, r: dotR, stroke: c.gp, strokeWidth: dotStroke }),
      // 予算の消化率の帯（§130）
      strip ? budgetStripMark(segs, { c, unit }) : null,
      // 日・週は月の境目に点線（帯の月と棒の対応が分かるように）
      strip && noBudget && segs.length > 1 ? Plot.ruleX(segs.slice(1), { x: (g) => g.i0 - 0.5, stroke: c.axis, strokeDasharray: "2 3" }) : null,
      // クロスヘア ＋ ツールチップ
      Plot.ruleX(data, Plot.pointerX({ x: "i", stroke: c.muted, strokeOpacity: 0.6 })),
      Plot.tip(
        data,
        Plot.pointerX({
          x: "i",
          y: yMax,
          preferredAnchor: "bottom",
          dy: scaledPx(-6),
          fill: c.surface,
          stroke: c.axis,
          fontSize: scaledPx(12),
          channels: {
            [tipName]: (d) => (tipLabel ? tipLabel(d) : fmt(T.charts.tipMonthValue, { month: monthJa(d.month), status: STATUS_LABELS[d.status], suffix: d.isActual ? "" : T.charts.suffixForecast })),
            [T.charts.tipBudget]: (d) => (noBudget ? null : money(d.budget, unit)),
            [T.charts.tipCost]: (d) => (d.isActual ? money(d.cost, unit) : fmt(T.charts.forecastValue, { value: money(d.forecastCost, unit) })),
            [T.charts.tipPrelim]: (d) => (hasPrelimValue(d) && d.cost !== 0 ? money(d.cost, unit) : null),
            [T.charts.tipGrossProfit]: (d) => (noBudget ? null : d.isActual ? money(d.grossProfit, unit) : fmt(T.charts.forecastValue, { value: money(d.forecastGrossProfit, unit) })),
            [T.charts.tipTarget]: (d) => (noBudget || d.targetCap == null ? null : fmt(T.charts.targetValue, { value: money(d.targetCap, unit), rate: formatPercent(d.targetRate, Math.abs(Math.round(d.targetRate * 100) - d.targetRate * 100) < 1e-9 ? 0 : 1) })),
            [T.charts.tipHours]: (d) => (d.hours > 0 ? formatHours(d.hours) : null),
          },
          format: { x: false, y: false },
        }),
      ),
    ].filter(Boolean),
  });
  plot.setAttribute("role", "img");
  plot.setAttribute("aria-label", fmt(noBudget ? T.charts.monthlyAriaDay : T.charts.monthlyAria, { title }));
  hatch?.attach(plot);
  return plot;
}

export function monthlyLegend(dark, series = null) {
  const c = chartColors(dark);
  return chartLegend([
    ...(series && isDaySeries(series) ? [] : [{ label: T.columns.budget, color: c.budget, shape: "line" }]),
    { label: T.charts.costActual, color: c.cost },
    ...(series && hasOverBudget(series) ? [{ label: T.charts.legendOverBudget, color: c.danger }] : []),
    { label: T.charts.legendCostForecast, color: c.cost, shape: "rect-dashed" },
    ...(series && hasPrelimNow(series) ? [{ label: T.charts.legendCostPrelim, color: c.cost, shape: "rect-hatched" }] : []),
    ...(series && isDaySeries(series)
      ? []
      : [
          { label: T.charts.gpActual, color: c.gp, shape: "line" },
          { label: T.charts.legendGpForecast, color: c.gp, shape: "line-dashed" },
        ]),
    ...(series && !isDaySeries(series) && hasTarget(series) ? [{ label: T.charts.legendTarget, color: c.target, shape: "line-dashed" }] : []),
  ]);
}

/** グラフの双子の表。実績月は実績、基準月以降は見込み。日・週・四半期・年度（§130）は label（期間の表記）を渡す */
export function seriesTable(series, { unit = "yen", exportName = "monthly", label = null } = {}) {
  const rows = series.map((d) => ({
    key: d.key ?? d.month,
    month: d.month ?? null,
    from: d.from ?? null,
    label: label ? label(d) : null,
    status: d.status,
    budget: d.budget,
    cost: d.isActual ? d.cost : null,
    forecastCost: d.forecastCost,
    grossProfit: d.isActual ? d.grossProfit : null,
    forecastGrossProfit: d.forecastGrossProfit,
    hours: d.hours,
    actualCostPrelim: hasPrelimValue(d) ? d.cost : null,
    targetCap: d.targetCap ?? null,
  }));
  const noBudget = isDaySeries(series);
  const columns = [
    label
      ? { key: "month", label: T.charts.colPeriod, type: "text", render: (r) => r.label, sortValue: (r) => r.from, exportValue: (r) => r.label }
      : { key: "month", label: T.charts.colMonth, type: "text", render: (r) => monthJa(r.month), sortValue: (r) => r.month, exportValue: (r) => r.month },
    { key: "status", label: T.columns.status, type: "text", render: (r) => (r.status ? STATUS_LABELS[r.status] : "—"), exportValue: (r) => (r.status ? STATUS_LABELS[r.status] : "") },
    ...(noBudget ? [] : [{ key: "budget", label: T.columns.budget, type: "money" }]),
    { key: "cost", label: T.charts.costActual, type: "money", render: (r, u) => (r.cost === null ? (r.actualCostPrelim !== null && r.actualCostPrelim > 0 ? fmt(T.charts.prelimValue, { value: money(r.actualCostPrelim, u) }) : "—") : money(r.cost, u)), exportValue: (r) => r.cost ?? r.actualCostPrelim },
    { key: "forecastCost", label: T.charts.costForecast, type: "money", render: (r, u) => (r.forecastCost === null ? "—" : money(r.forecastCost, u)) },
    ...(noBudget ? [] : [{ key: "grossProfit", label: T.columns.grossProfit, type: "money", render: (r, u) => (r.grossProfit === null ? (r.forecastGrossProfit === null ? "—" : fmt(T.charts.forecastValue, { value: money(r.forecastGrossProfit, u) })) : money(r.grossProfit, u)), exportValue: (r) => r.grossProfit ?? r.forecastGrossProfit }]),
    ...(!noBudget && hasTarget(series) ? [{ key: "targetCap", label: T.charts.legendTarget, type: "money", render: (r, u) => (r.targetCap === null ? "—" : money(r.targetCap, u)) }] : []),
    { key: "hours", label: T.columns.hours, type: "hours", hideOnPhone: true, hideNarrow: true },
  ];
  return dataTable({ columns, rows, unit, caption: T.charts.monthlyTitle, exportName, sort: { key: "month", dir: "asc" } });
}

/**
 * メンバーの月次推移: 計画時間（青＝予）と実績時間（橙＝実）の棒を並べる。
 * series は core の memberMonthlySeries() の出力。基準月以降の月は背景を薄く塗り、実績がまだ無いことを示す。
 * 日・週・四半期・年度（§130）は core の bucketMemberHours の出力と、tick・tipLabel・isFuture（背景を塗る最初の棒）・isNow（斜線）を渡す
 */
export function memberHoursChart({ series, dark = false, width = 640, height = 260, asOfMonth, title = T.charts.memberHoursTitle, tick = null, tipLabel = null, tipName = T.charts.tipMonth, isFuture = null, isNow: isNowOpt = null, minBar = 6, unitName = T.charts.unitLabels.month, onPick = null }) {
  const c = chartColors(dark);
  const data = series.map((d, i) => ({ ...d, i }));
  const n = data.length;
  if (n === 0) return html`<div class="yn-chart-empty">${T.charts.noMonths}</div>`;
  // 目盛りの間引き: 1 目盛りあたり 44px 以上（390px 幅で月ラベルが重ならないように）
  const every = Math.max(n > 14 ? 2 : 1, Math.ceil(n / Math.max(1, Math.floor((width - 64) / 44))));
  const ticks = data.filter((d) => d.i % every === 0).map((d) => d.i);
  const firstFuture = data.find((d) => (isFuture ? isFuture(d) : d.month >= asOfMonth));
  const barW = Math.max(minBar, Math.min(22, ((width - 80) / n) * 0.4));
  const bw = barW / ((width - 80) / n);
  const gap = 0.03;
  // 今月（月の途中）の実績時間は速報なので斜線（§125）
  const isNow = (d) => (isNowOpt ? isNowOpt(d) : d.month === asOfMonth) && d.actualHours > 0;
  const hatch = data.some(isNow) ? hatchFill(c.cost) : null;
  const plot = Plot.plot({
    width,
    height,
    marginLeft: scaledPx(48),
    marginRight: scaledPx(16),
    marginTop: scaledPx(24),
    marginBottom: scaledPx(32),
    style: { background: "transparent", color: c.text, fontSize: `${scaledPx(12)}px`, fontFamily: "inherit", overflow: "visible" },
    x: { domain: [-0.5, n - 0.5], ticks, tickFormat: (i) => (data[i] ? (tick ? tick(data[i], i) : monthShort(data[i].month, i === 0)) : ""), tickSize: 0, label: null, line: false },
    // すべて 0h（不在の期間など）だと domain が [0,0] になり棒が全高で描かれるので、範囲を与える
    y: { grid: true, label: T.charts.hoursAxis, labelAnchor: "top", labelArrow: "none", nice: true, zero: true, tickSize: 0, line: false, ...(data.every((d) => !(d.plannedHours > 0) && !(d.actualHours > 0)) ? { domain: [0, 10] } : {}) },
    marks: [
      Plot.gridY({ stroke: c.grid, strokeOpacity: 1 }),
      Plot.ruleY([0], { stroke: c.axis }),
      firstFuture ? Plot.rectX([{ x1: firstFuture.i - 0.5, x2: n - 0.5 }], { x1: "x1", x2: "x2", fill: c.muted, fillOpacity: 0.06 }) : null,
      Plot.rectY(data, { x1: (d) => d.i - gap - bw, x2: (d) => d.i - gap, y: "plannedHours", fill: c.budget, ry2: 3 }),
      Plot.rectY(data.filter((d) => !isNow(d)), { x1: (d) => d.i + gap, x2: (d) => d.i + gap + bw, y: "actualHours", fill: c.cost, ry2: 3 }),
      hatch ? Plot.rectY(data.filter(isNow), { x1: (d) => d.i + gap, x2: (d) => d.i + gap + bw, y: "actualHours", fill: hatch.fill, stroke: c.cost, strokeWidth: 1, ry2: 3 }) : null,
      Plot.ruleX(data, Plot.pointerX({ x: "i", stroke: c.muted, strokeOpacity: 0.6 })),
      Plot.tip(
        data,
        Plot.pointerX({
          x: "i",
          y: (d) => Math.max(d.plannedHours, d.actualHours),
          preferredAnchor: "bottom",
          dy: scaledPx(-6),
          fill: c.surface,
          stroke: c.axis,
          fontSize: scaledPx(12),
          channels: {
            [tipName]: (d) => (tipLabel ? tipLabel(d) : fmt(T.charts.tipMonthValue, { month: monthJa(d.month), status: STATUS_LABELS[d.status], suffix: "" })),
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
  plot.setAttribute("aria-label", fmt(T.charts.memberHoursAria, { title, unit: unitName }));
  hatch?.attach(plot);
  if (onPick) {
    // 棒を押す（タップ）と、その期間の内訳（計算根拠）を開く。どの棒かは吹き出しと同じ pointer の値
    plot.classList.add("yn-chart-pickable");
    plot.addEventListener("click", () => {
      const d = plot.value;
      if (d) onPick(series[d.i], plot);
    });
  }
  return plot;
}

export function memberHoursLegend(dark, series = null, asOfMonth = null, isNow = null) {
  const c = chartColors(dark);
  return chartLegend([
    { label: T.charts.legendPlanned, color: c.budget },
    { label: T.charts.legendActual, color: c.cost },
    ...(series && series.some((d) => (isNow ? isNow(d) : d.month === asOfMonth) && d.actualHours > 0) ? [{ label: T.charts.legendActualPrelim, color: c.cost, shape: "rect-hatched" }] : []),
  ]);
}

/**
 * 消化率メーター（0〜120% の目盛、基準（既定 100%）に縦線）。地＝予算（薄い青）、塗り＝実績（橙）、超過は赤（§131）。
 * 縦線のすぐ下に基準の % を書き、縦線が何かを読めるようにする（§146。2026-11-18 依頼者）
 */
export function burnMeter(rate, threshold = 1) {
  const max = 1.2;
  const v = typeof rate === "number" && Number.isFinite(rate) ? Math.min(rate, max) : 0;
  const over = typeof rate === "number" && rate > threshold;
  const markLeft = `left:${(Math.min(threshold, max) / max) * 100}%`;
  return html`<div class=${`yn-meter${over ? " is-danger" : ""}`} role="img" aria-label=${fmt(T.charts.meterAria, { rate: rate === null ? T.charts.notComputable : `${(rate * 100).toFixed(1)}%`, threshold: `${(threshold * 100).toFixed(0)}%` })}>
    <div class="yn-meter-track"><div class="yn-meter-fill" style=${`width:${(v / max) * 100}%`}></div><div class="yn-meter-mark" style=${markLeft}></div><span class="yn-meter-scale" style=${markLeft} aria-hidden="true">${formatPercent(threshold, 0)}</span></div>
  </div>`;
}
