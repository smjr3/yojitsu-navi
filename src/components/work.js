/**
 * 作業種別と工数（SPEC §30）の画面部品
 *
 * - workTaskSpec:    作業種別ごとの内訳（根拠パネル）
 * - workTaskSection: 詳細画面の「作業種別の内訳」（表。契約内 → 契約外、月別の時間）
 * - workHoursChart:  月次推移（契約内・契約外の人月を積み上げ）
 * 工数の明細は data/work-hours.json（decodeWorkRows で WorkRow[] に戻したもの）を使う。
 */
import * as Plot from "@observablehq/plot";
import { html } from "htl";
import { T, fmt } from "../i18n/index.js";
import { personMonths, workByTask } from "../core/index.js";
import { EMPTY_VALUE, STATUS_LABELS, decimal, formatHours, formatPercent, money, monthJa, monthShort } from "./format.js";
import { chartColors, chartLegend } from "./charts.js";
import { dataTable } from "./table.js";
import { sectionTitle, note } from "./layout.js";

/** 人月の表示（小数 2 桁） */
export function pm(hours, config) {
  return fmt(T.numbers.personMonths, { value: decimal(personMonths(hours, config.standardHoursPerMonth), 2) });
}

export function categoryLabel(category) {
  return category === "outside" ? T.work.outside : T.work.contract;
}

function taskLabel(line) {
  return line.task === "" ? T.work.emptyTask : line.task;
}

/** 作業種別ごとの内訳（根拠パネル）。rows は対象の WorkRow[] */
export function workTaskSpec({ title, subtitle = null, rows, config }) {
  const lines = workByTask(rows);
  const contractHours = lines.filter((l) => l.category === "contract").reduce((s, l) => s + l.hours, 0);
  const outsideHours = lines.filter((l) => l.category === "outside").reduce((s, l) => s + l.hours, 0);
  const table = (category) => {
    const ls = lines.filter((l) => l.category === category);
    if (ls.length === 0) return null;
    return {
      title: categoryLabel(category),
      table: {
        columns: [{ label: T.work.colTask }, { label: T.work.colHours, align: "num" }, { label: T.work.colPm, align: "num" }, { label: T.work.colShare, align: "num" }],
        rows: ls.map((l) => [html`${taskLabel(l)}${l.unclassified ? html` <span class="yn-chip yn-chip-neutral" title=${T.work.unclassifiedTitle}>${T.work.unclassified}</span>` : null}`, formatHours(l.hours), pm(l.hours, config), formatPercent(l.share)]),
      },
    };
  };
  return {
    title,
    subtitle,
    formula: fmt(T.work.pmFormula, { hours: config.standardHoursPerMonth }),
    rows: [
      { label: T.work.contract, value: `${formatHours(contractHours)}（${pm(contractHours, config)}）` },
      { label: T.work.outside, value: `${formatHours(outsideHours)}（${pm(outsideHours, config)}）`, note: T.work.outsideNote },
      { label: T.work.total, value: `${formatHours(contractHours + outsideHours)}（${pm(contractHours + outsideHours, config)}）`, emphasis: true },
    ],
    sections: [table("contract"), table("outside")].filter(Boolean),
  };
}

/** 表に出す月（期間の最後の 12 か月まで。多いと横に長くなりすぎるため） */
const MAX_MONTH_COLUMNS = 12;

/**
 * 詳細画面の「作業種別の内訳」。
 * rows = 期間で絞った WorkRow[]。months = 期間の全月。showAmount = 実績額の列（契約内のみ）を出す
 */
export function workTaskSection({ rows, months, unit, config, title = T.work.sectionTitle, hint, exportName, showAmount = true, emptyText = T.work.empty }) {
  const lines = workByTask(rows);
  const shownMonths = months.slice(-MAX_MONTH_COLUMNS);
  const contract = lines.filter((l) => l.category === "contract");
  const outside = lines.filter((l) => l.category === "outside");
  const sumOf = (ls, f) => ls.reduce((s, l) => s + (f(l) ?? 0), 0);
  const columns = [
    { key: "category", label: T.work.colCategory, type: "text", get: (r) => (r.category ? categoryLabel(r.category) : ""), hideOnPhone: true },
    {
      key: "task",
      label: T.work.colTask,
      type: "text",
      render: (r) => html`<span><span class="yn-task-name" title=${taskLabel(r)}>${taskLabel(r)}</span>${r.unclassified ? html` <span class="yn-chip yn-chip-neutral" title=${T.work.unclassifiedTitle}>${T.work.unclassified}</span>` : null}${r.category === "outside" ? html` <span class="yn-chip yn-chip-neutral only-phone">${T.work.outside}</span>` : null}</span>`,
      sortValue: (r) => r.task,
      exportValue: (r) => taskLabel(r),
    },
    { key: "hours", label: T.work.colHours, type: "hours" },
    { key: "pm", label: T.work.colPm, type: "custom", align: "num", get: (r) => personMonths(r.hours, config.standardHoursPerMonth), render: (r) => pm(r.hours, config), exportLabel: T.work.colPm },
    { key: "share", label: T.work.colShare, sublabel: T.work.colShareSub, type: "percent", hideOnPhone: true },
    ...(showAmount ? [{ key: "amount", label: T.work.colAmount, type: "money", render: (r, u) => (r.amount === null ? T.work.notCounted : money(r.amount, u)), exportValue: (r) => (r.amount === null ? null : r.amount) }] : []),
    ...shownMonths.map((m) => ({ key: `m:${m}`, label: monthShort(m, m === shownMonths[0]), type: "hours", hideOnPhone: true, get: (r) => r.byMonth[m] ?? 0, render: (r) => (r.byMonth[m] ? formatHours(r.byMonth[m]) : EMPTY_VALUE), exportLabel: fmt(T.work.monthHours, { month: m }) })),
  ];
  const all = [...contract, ...outside].map((l) => ({ ...l, key: `${l.category}:${l.task}` }));
  // 合計行は運用保守の作業だけ（列の絞り込み後の行で作り直す）
  const summary = (shown) => {
    const cs = shown.filter((l) => l.category === "contract");
    return {
      category: null,
      task: fmt(T.work.contractTotal, { n: cs.length }),
      unclassified: false,
      hours: sumOf(cs, (l) => l.hours),
      share: null,
      amount: sumOf(cs, (l) => l.amount),
      byMonth: Object.fromEntries(shownMonths.map((m) => [m, sumOf(cs, (l) => l.byMonth[m])])),
    };
  };
  const section = html`<section class="yn-work-section">
    ${sectionTitle(title, outside.length ? `${hint ?? ""} ${T.work.outsideTip}`.trim() : hint)}
    ${all.length === 0
      ? note(emptyText)
      : html`${dataTable({ columns, rows: all, unit, caption: title, exportName, sort: null, summary, maxHeight: 520 })}
          ${months.length > shownMonths.length ? note(fmt(T.work.monthsTrimmed, { n: shownMonths.length })) : null}`}
  </section>`;
  return section;
}

export function workColors(dark) {
  const c = chartColors(dark);
  return { ...c, contract: c.budget, outside: dark ? "#a184e0" : "#7a5bc7" };
}

export function workHoursLegend(dark) {
  const c = workColors(dark);
  return chartLegend([
    { label: T.work.contract, color: c.contract },
    { label: T.work.outside, color: c.outside },
  ]);
}

/** 月次推移（契約内・契約外の人月を積み上げ）。series は core の workMonthlySeries() */
export function workHoursChart({ series, config, dark = false, width = 640, height = 260, asOfMonth }) {
  const c = workColors(dark);
  const n = series.length;
  if (n === 0) return html`<div class="yn-chart-empty">${T.charts.noMonths}</div>`;
  const std = config.standardHoursPerMonth;
  const data = [];
  series.forEach((p, i) => {
    data.push({ i, month: p.month, kind: "contract", pm: personMonths(p.contractHours, std), p });
    data.push({ i, month: p.month, kind: "outside", pm: personMonths(p.outsideHours, std), p });
  });
  const every = Math.max(n > 14 ? 2 : 1, Math.ceil(n / Math.max(1, Math.floor((width - 64) / 44))));
  const ticks = series.map((_, i) => i).filter((i) => i % every === 0);
  const firstFuture = series.findIndex((p) => p.month > asOfMonth);
  const half = Math.min(0.35, Math.max(0.12, 12 / Math.max(1, (width - 80) / n)));
  const plot = Plot.plot({
    width,
    height,
    marginLeft: 48,
    marginRight: 16,
    marginTop: 24,
    marginBottom: 32,
    style: { background: "transparent", color: c.text, fontSize: "12px", fontFamily: "inherit", overflow: "visible" },
    x: { domain: [-0.5, n - 0.5], ticks, tickFormat: (i) => (series[i] ? monthShort(series[i].month, i === 0) : ""), tickSize: 0, label: null, line: false },
    // すべて 0 人月だと domain が [0,0] になり棒が全高で描かれるので、範囲を与える
    y: { grid: true, label: T.work.pmAxis, labelAnchor: "top", labelArrow: "none", nice: true, zero: true, tickSize: 0, line: false, ...(data.every((d) => !(d.pm > 0)) ? { domain: [0, 1] } : {}) },
    color: { domain: ["contract", "outside"], range: [c.contract, c.outside] },
    marks: [
      Plot.gridY({ stroke: c.grid, strokeOpacity: 1 }),
      Plot.ruleY([0], { stroke: c.axis }),
      firstFuture >= 0 ? Plot.rectX([{ x1: firstFuture - 0.5, x2: n - 0.5 }], { x1: "x1", x2: "x2", fill: c.muted, fillOpacity: 0.06 }) : null,
      Plot.rectY(data, Plot.stackY({ x1: (d) => d.i - half, x2: (d) => d.i + half, y: "pm", fill: "kind", order: ["contract", "outside"] })),
      Plot.ruleX(series.map((_, i) => i), Plot.pointerX({ x: (i) => i, stroke: c.muted, strokeOpacity: 0.6 })),
      Plot.tip(
        series.map((p, i) => ({ ...p, i })),
        Plot.pointerX({
          x: "i",
          y: (d) => personMonths(d.contractHours + d.outsideHours, std),
          preferredAnchor: "bottom",
          dy: -6,
          fill: c.surface,
          stroke: c.axis,
          fontSize: 12,
          channels: {
            [T.charts.tipMonth]: (d) => fmt(T.charts.tipMonthValue, { month: monthJa(d.month), status: STATUS_LABELS[d.status], suffix: "" }),
            [T.work.contract]: (d) => pm(d.contractHours, config),
            [T.work.outside]: (d) => pm(d.outsideHours, config),
            [T.work.colMembers]: (d) => fmt(T.work.peopleValue, { n: d.memberCount }),
          },
          format: { x: false, y: false },
        }),
      ),
    ].filter(Boolean),
  });
  plot.setAttribute("role", "img");
  plot.setAttribute("aria-label", T.work.chartAria);
  return plot;
}

/** 月次推移の表（グラフと同じ値） */
export function workSeriesTable({ series, config, exportName }) {
  const columns = [
    { key: "month", label: T.charts.colMonth, type: "text", render: (r) => monthJa(r.month), sortValue: (r) => r.month, exportValue: (r) => r.month },
    { key: "contract", label: T.work.contract, type: "custom", align: "num", get: (r) => personMonths(r.contractHours, config.standardHoursPerMonth), render: (r) => pm(r.contractHours, config) },
    { key: "outside", label: T.work.outside, type: "custom", align: "num", get: (r) => personMonths(r.outsideHours, config.standardHoursPerMonth), render: (r) => pm(r.outsideHours, config) },
    { key: "total", label: T.work.total, type: "custom", align: "num", get: (r) => personMonths(r.contractHours + r.outsideHours, config.standardHoursPerMonth), render: (r) => pm(r.contractHours + r.outsideHours, config) },
    { key: "memberCount", label: T.work.colMembers, type: "int" },
  ];
  return dataTable({ columns, rows: series.map((p) => ({ ...p, key: p.month })), unit: "yen", caption: T.work.seriesCaption, exportName, sort: { key: "month", dir: "asc" } });
}

/**
 * 工数の分布（グループごとに契約内・契約外の人月を横に積み上げ）。groups は core の aggregateWork() の行。
 * チーム軸は末端の組織だけ（上位は配下の合計なので並べると二重になる）。行が多いときは上位 maxRows 件。
 */
/**
 * height を渡すと（拡大表示）、行の高さをその枠に合わせて広げる（28〜40px）。行が多くて収まらないときは 28px で縦に伸び、
 * 縦にスクロールしても目盛りを読めるように人月の軸を上に置く
 */
export function workGroupChart({ groups, config, dark = false, width = 640, height, maxRows = 20, ariaLabel }) {
  const c = workColors(dark);
  const std = config.standardHoursPerMonth;
  // 多いときは合計の多い上位 maxRows 件を選び、並びは元の順（チームは組織の木の順）のまま
  const total = (g) => g.totals.contractHours + g.totals.outsideHours;
  const keep = groups.length > maxRows ? new Set(groups.map((g, i) => [total(g), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, maxRows).map(([, i]) => i)) : null;
  const shown = keep ? groups.filter((_, i) => keep.has(i)) : groups;
  if (shown.length === 0) return html`<div class="yn-chart-empty">${T.work.empty}</div>`;
  const data = [];
  for (const g of shown) {
    data.push({ label: g.label, kind: "contract", pm: personMonths(g.totals.contractHours, std), g });
    data.push({ label: g.label, kind: "outside", pm: personMonths(g.totals.outsideHours, std), g });
  }
  const longest = Math.max(...shown.map((g) => [...g.label].length));
  const marginLeft = Math.min(Math.max(64, longest * 12 + 8), Math.round(width * 0.4));
  const plot = Plot.plot({
    width,
    height: shown.length * (height ? Math.min(40, Math.max(28, Math.floor((height - 48) / shown.length))) : 28) + 48,
    marginLeft,
    marginRight: 24,
    marginTop: height ? 32 : 24,
    marginBottom: height ? 8 : 24,
    style: { background: "transparent", color: c.text, fontSize: "12px", fontFamily: "inherit", overflow: "visible" },
    y: { domain: shown.map((g) => g.label), label: null, tickSize: 0, tickFormat: (s) => ([...s].length > Math.floor((marginLeft - 8) / 12) ? `${[...s].slice(0, Math.floor((marginLeft - 8) / 12) - 1).join("")}…` : s) },
    x: { axis: height ? "top" : "bottom", grid: true, label: T.work.pmAxis, labelAnchor: "right", labelArrow: "none", nice: true, zero: true, tickSize: 0, line: false, ...(data.every((d) => !(d.pm > 0)) ? { domain: [0, 1] } : {}) },
    color: { domain: ["contract", "outside"], range: [c.contract, c.outside] },
    marks: [
      Plot.gridX({ stroke: c.grid, strokeOpacity: 1 }),
      Plot.ruleX([0], { stroke: c.axis }),
      Plot.barX(data, Plot.stackX({ y: "label", x: "pm", fill: "kind", order: ["contract", "outside"], insetTop: 4, insetBottom: 4 })),
      Plot.tip(
        shown,
        Plot.pointerY({
          y: "label",
          x: (g) => personMonths(g.totals.totalHours, std),
          preferredAnchor: "left",
          dx: 6,
          fill: c.surface,
          stroke: c.axis,
          fontSize: 12,
          channels: {
            [T.work.contract]: (g) => pm(g.totals.contractHours, config),
            [T.work.outside]: (g) => pm(g.totals.outsideHours, config),
            [T.work.colOutsideShare]: (g) => formatPercent(g.totals.outsideShare),
            [T.work.colMembers]: (g) => fmt(T.work.peopleValue, { n: g.totals.memberCount }),
          },
          format: { x: false, y: false },
        }),
      ),
    ],
  });
  plot.setAttribute("role", "img");
  plot.setAttribute("aria-label", ariaLabel ?? T.work.distAria);
  return plot;
}

/**
 * リソース計画の月別の合計（SPEC §58）: 運用保守・運用保守以外の人月を積み上げ、人数 × 1.0 人月の破線と、
 * 1.0 人月を超える人がいる月の人数（「!n人」）を重ねる。data は [{ month, main, outside, capacity, over }]（人月）。
 */
export function planLoadChart({ data, dark = false, width = 640, height = 200 }) {
  const c = workColors(dark);
  const warn = dark ? "#fab219" : "#7a4a00";
  const n = data.length;
  if (n === 0) return html`<div class="yn-chart-empty">${T.charts.noMonths}</div>`;
  const rows = data.flatMap((d, i) => [
    { i, kind: "contract", pm: d.main },
    { i, kind: "outside", pm: d.outside },
  ]);
  const every = Math.max(n > 14 ? 2 : 1, Math.ceil(n / Math.max(1, Math.floor((width - 64) / 44))));
  const ticks = data.map((_, i) => i).filter((i) => i % every === 0);
  const half = Math.min(0.35, Math.max(0.12, 12 / Math.max(1, (width - 80) / n)));
  const pts = data.map((d, i) => ({ ...d, i, total: d.main + d.outside }));
  const top = Math.max(1, ...pts.map((d) => Math.max(d.total, d.capacity)));
  const fix = (v) => (Math.round(v * 100) / 100).toFixed(2);
  // 狭い画面（1 か月の幅が 40px 未満）は「!n」だけにして隣の月と重ねない
  const slot = (width - 52) / n;
  const plot = Plot.plot({
    width,
    height,
    marginLeft: 40,
    marginRight: 12,
    marginTop: 26,
    marginBottom: 28,
    style: { background: "transparent", color: c.text, fontSize: "12px", fontFamily: "inherit", overflow: "visible" },
    x: { domain: [-0.5, n - 0.5], ticks, tickFormat: (i) => (data[i] ? monthShort(data[i].month, i === 0) : ""), tickSize: 0, label: null, line: false },
    y: { grid: true, label: T.work.pmAxis, labelAnchor: "top", labelArrow: "none", domain: [0, top * 1.12], nice: true, tickSize: 0, line: false },
    color: { domain: ["contract", "outside"], range: [c.contract, c.outside] },
    marks: [
      Plot.gridY({ stroke: c.grid, strokeOpacity: 1 }),
      Plot.ruleY([0], { stroke: c.axis }),
      Plot.rectY(rows, Plot.stackY({ x1: (d) => d.i - half, x2: (d) => d.i + half, y: "pm", fill: "kind", order: ["contract", "outside"] })),
      // 人数 × 1.0 人月（不在した月より後は数えない）。月ごとの段で描く
      Plot.link(pts, { x1: (d) => d.i - 0.5, x2: (d) => d.i + 0.5, y1: "capacity", y2: "capacity", stroke: c.muted, strokeWidth: 1.5, strokeDasharray: "5 4" }),
      Plot.text(pts.filter((d) => d.over > 0), { x: "i", y: (d) => Math.max(d.total, d.capacity), dy: -9, text: (d) => fmt(slot < 40 ? T.plan.chartOverShort : T.plan.chartOver, { n: d.over }), fill: warn, fontWeight: 700, fontSize: 11 }),
      Plot.ruleX(pts, Plot.pointerX({ x: "i", stroke: c.muted, strokeOpacity: 0.6 })),
      Plot.tip(
        pts,
        Plot.pointerX({
          x: "i",
          y: "total",
          preferredAnchor: "bottom",
          dy: -6,
          fill: c.surface,
          stroke: c.axis,
          fontSize: 12,
          channels: {
            [T.charts.tipMonth]: (d) => monthJa(d.month),
            [T.work.contract]: (d) => fix(d.main),
            [T.work.outside]: (d) => fix(d.outside),
            [T.work.total]: (d) => fix(d.total),
            [T.plan.chartCapacity]: (d) => fix(d.capacity),
            [T.plan.chartOverTip]: (d) => fmt(T.work.peopleValue, { n: d.over }),
          },
          format: { x: false, y: false },
        }),
      ),
    ],
  });
  plot.setAttribute("role", "img");
  plot.setAttribute("aria-label", T.plan.chartAria);
  return plot;
}

export function planLoadLegend(dark) {
  const c = workColors(dark);
  return chartLegend([
    { label: T.work.contract, color: c.contract },
    { label: T.work.outside, color: c.outside },
    { label: T.plan.chartCapacity, color: c.muted, shape: "line-dashed" },
  ]);
}
