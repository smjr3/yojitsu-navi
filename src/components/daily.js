/**
 * 今月の進捗（SPEC §61）: 今月の実績の累計（速報）を、月の上限を営業日で按分した目安と比べる。
 * 全体・チーム・顧客・案件の詳細で、選択中の期間が asOf の月を含むときだけ出す。
 * daily は data/daily.json（core の encodeDaily）。読めなければ何も出さない。
 */
import * as Plot from "@observablehq/plot";
import { html } from "htl";
import { dailyMembers, dailyProgress, formatHours, formatPercent } from "../core/index.js";
import { T, fmt } from "../i18n/index.js";
import { chartColors, chartLegend } from "./charts.js";
import { chartFigure } from "./chart-zoom.js";
import { statTile } from "./kpi.js";
import { sectionTitle } from "./layout.js";
import { dataTable } from "./table.js";
import { money as moneyBase, monthJa, toCoreUnit } from "./format.js";

/** 1 か月分は金額が小さいので、百万円のときだけ小数 2 桁にする（0.0百万円ばかりにならないように） */
const m2 = new Intl.NumberFormat("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function money(yen, unit) {
  if (toCoreUnit(unit) !== "millionYen" || typeof yen !== "number" || !Number.isFinite(yen)) return moneyBase(yen, unit);
  return fmt(T.numbers.millionYen, { value: m2.format(Math.round(yen / 1e4) / 100) });
}

/** data/daily.json を読む（無い・壊れているときは null。今月の進捗を出さないだけで画面は止めない） */
export function loadDaily(attachment) {
  return attachment.json().catch(() => null);
}

/**
 * 選択中の期間が今月（asOf の月）を含み、今月の予算があるときだけ進みを返す。
 * target（今月を含む目標。core の targetForMonth）があれば、今月の上限 = 予算 ×（1 − 目標の残予算率）
 */
export function dailyFor(model, daily, contractIds, period, target = null) {
  if (!daily || !daily.month || daily.month !== model.meta.asOfMonth) return null;
  if (period.from > daily.month || period.to < daily.month) return null;
  const p = dailyProgress(model, daily, contractIds, target ? { capRatio: 1 - target.remainingRate } : {});
  return p && { ...p, target };
}

/** 目標の残予算率（整数なら小数なし） */
function ratePct(rate) {
  return formatPercent(rate, Math.abs(Math.round(rate * 100) - rate * 100) < 1e-9 ? 0 : 1);
}

/** 根拠（KPI の数字を押したとき） */
function progressSpec(p, unit, subtitle, emphasisKey) {
  const rows = [
    ...(p.target
      ? [
          { key: "budget", label: T.daily.budgetLabel, value: money(p.budget, unit) },
          { key: "target", label: T.daily.targetLabel, value: ratePct(p.target.remainingRate) },
        ]
      : []),
    { key: "cap", label: T.daily.capLabel, value: money(p.cap, unit) },
    { key: "days", label: T.daily.bizDaysLabel, value: fmt(T.daily.bizDaysValue, { elapsed: p.elapsedBusinessDays, total: p.businessDays }) },
    { key: "pace", label: T.daily.paceLabel, value: money(p.paceToDate, unit) },
    { key: "actual", label: T.daily.actualLabel, value: money(p.actual, unit) },
    { key: "remaining", label: T.daily.remainingLabel, value: money(p.remaining, unit) },
    { key: "perDay", label: T.daily.perDayLabel, value: p.perDayRemaining === null ? "—" : money(p.perDayRemaining, unit) },
    { key: "average", label: T.daily.averageLabel, value: p.averagePerDay === null ? "—" : money(p.averagePerDay, unit) },
    { key: "projection", label: T.daily.projectionLabel, value: money(p.projection, unit) },
  ].map((r) => ({ ...r, emphasis: r.key === emphasisKey }));
  return {
    title: fmt(T.breakdown.labelTitle, { label: T.daily.title }),
    subtitle,
    formula: p.target ? [T.daily.capFormulaTarget, ...T.daily.formulas] : T.daily.formulas,
    rows,
  };
}

/** KPI 4 枚 */
export function dailyKpis(p, { unit, subtitle }) {
  const spec = (key) => () => progressSpec(p, unit, subtitle, key);
  const overPace = p.actual > p.paceToDate;
  const overCap = p.projection > p.cap;
  // 予実の KPI（.yn-kpi-grid）とは別の行。幅が足りれば 4 列、足りなければ 2×2
  return html`<section class="yn-daily-kpis" aria-label=${T.daily.kpiLabel}>${[
      statTile({ label: T.daily.capLabel, value: money(p.cap, unit), sub: p.target ? fmt(T.daily.capSubTarget, { rate: ratePct(p.target.remainingRate) }) : fmt(T.daily.capSub, { month: monthJa(p.month) }), breakdown: spec("cap"), id: "yn-daily-cap" }),
      statTile({
        label: T.daily.actualLabel,
        value: money(p.actual, unit),
        sub: fmt(T.daily.actualSub, { pace: money(p.paceToDate, unit), elapsed: p.elapsedBusinessDays, total: p.businessDays }),
        status: overPace ? { kind: "danger", text: T.daily.overPace } : { kind: "ok", text: T.daily.withinPace },
        breakdown: spec("actual"),
        id: "yn-daily-actual",
      }),
      statTile({
        label: fmt(T.daily.leftLabel, { n: p.remainingBusinessDays }),
        value: money(p.remaining, unit),
        sub: p.perDayRemaining === null ? T.daily.noDaysLeft : fmt(T.daily.leftSub, { perDay: money(p.perDayRemaining, unit), average: p.averagePerDay === null ? "—" : money(p.averagePerDay, unit) }),
        breakdown: spec("remaining"),
        id: "yn-daily-left",
      }),
      statTile({
        label: T.daily.projectionLabel,
        value: money(p.projection, unit),
        sub: fmt(T.daily.projectionSub, { diff: money(p.projection - p.cap, unit) }),
        status: overCap ? { kind: "danger", text: T.daily.overCap } : { kind: "ok", text: T.daily.withinCap },
        breakdown: spec("projection"),
        id: "yn-daily-projection",
        emphasis: true,
      }),
    ]}</section>`;
}

export function dailyLegend(dark, { target = false } = {}) {
  const c = chartColors(dark);
  return chartLegend([
    { label: T.daily.legendActual, color: c.cost, shape: "line" },
    { label: T.daily.legendProjection, color: c.cost, shape: "line-dotted" },
    { label: T.daily.legendPace, color: c.budget, shape: "line-dashed" },
    { label: target ? T.daily.legendCapTarget : T.daily.legendCap, color: c.danger, shape: "line-dashed" },
  ]);
}

/** 累計の折れ線 ＋ 目安 ＋ 上限 ＋ このペースの月末 */
export function dailyChart(p, { unit = "yen", dark = false, width = 640, height = 280 }) {
  const c = chartColors(dark);
  const pts = p.points;
  const n = pts.length;
  const done = pts.filter((d) => d.cumulative !== null);
  const last = done[done.length - 1] ?? null;
  const projLine = last && last.day < n ? [{ day: last.day, v: last.cumulative }, { day: n, v: p.projection }] : [];
  const peak = Math.max(p.cap, p.projection, last?.cumulative ?? 0, 1);
  const axisUnit = peak >= 5e6 ? { label: T.format.units.m, div: 1e6 } : peak >= 5e4 ? { label: T.charts.axisTenThousandYen, div: 1e4 } : { label: T.format.units.yen, div: 1 };
  const axisFormat = (v) => new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 }).format(v / axisUnit.div);
  // 目盛り: 1 日・5 日おき（狭い画面は 10 日おき）
  const step = width < 520 ? 10 : 5;
  const ticks = [1, ...Array.from({ length: Math.floor(n / step) }, (_, i) => (i + 1) * step).filter((d) => d <= n)];
  const off = pts.filter((d) => !d.businessDay);
  const plot = Plot.plot({
    width,
    height,
    marginLeft: Math.max(48, 12 + 7.5 * axisFormat(peak).length),
    marginRight: 20,
    marginTop: 28,
    marginBottom: 32,
    style: { background: "transparent", color: c.text, fontSize: "12px", fontFamily: "inherit", overflow: "visible" },
    x: { domain: [0.5, n + 0.5], ticks, tickFormat: (d) => fmt(T.daily.dayTick, { d }), tickSize: 0, label: null, line: false },
    y: { grid: true, label: axisUnit.label, labelAnchor: "top", labelArrow: "none", tickFormat: axisFormat, nice: true, zero: true, tickSize: 0, line: false, domain: [0, peak * 1.08] },
    marks: [
      // 土日・祝日
      Plot.rectX(off, { x1: (d) => d.day - 0.5, x2: (d) => d.day + 0.5, fill: c.muted, fillOpacity: 0.08 }),
      Plot.gridY({ stroke: c.grid, strokeOpacity: 1 }),
      Plot.ruleY([0], { stroke: c.axis }),
      Plot.ruleY([p.cap], { stroke: c.danger, strokeDasharray: "6 4", strokeWidth: 1.5 }),
      Plot.line(pts, { x: "day", y: "pace", stroke: c.budget, strokeWidth: 2, strokeDasharray: "4 3", curve: "linear" }),
      Plot.line(projLine, { x: "day", y: "v", stroke: c.cost, strokeWidth: 2, strokeDasharray: "2 3" }),
      Plot.line(done, { x: "day", y: "cumulative", stroke: c.cost, strokeWidth: 2.5, curve: "linear" }),
      last ? Plot.dot([last], { x: "day", y: "cumulative", fill: c.cost, r: 4, stroke: c.surface, strokeWidth: 2 }) : null,
      Plot.ruleX(pts, Plot.pointerX({ x: "day", stroke: c.muted, strokeOpacity: 0.6 })),
      Plot.tip(
        pts,
        Plot.pointerX({
          x: "day",
          y: (d) => Math.max(d.cumulative ?? 0, d.pace),
          preferredAnchor: "bottom",
          dy: -6,
          fill: c.surface,
          stroke: c.axis,
          fontSize: 12,
          channels: {
            [T.daily.tipDate]: (d) => fmt(T.daily.tipDateValue, { month: monthJa(p.month), d: d.day, off: d.businessDay ? "" : T.daily.offDay }),
            [T.daily.tipDay]: (d) => (d.amount === null ? null : money(d.amount, unit)),
            [T.daily.tipCumulative]: (d) => (d.cumulative === null ? null : money(d.cumulative, unit)),
            [T.daily.tipPace]: (d) => money(d.pace, unit),
          },
          format: { x: false, y: false },
        }),
      ),
    ].filter(Boolean),
  });
  plot.setAttribute("role", "img");
  plot.setAttribute("aria-label", T.daily.aria);
  return plot;
}

/** グラフの双子の表（経過した日だけ） */
export function dailyTable(p, { unit, exportName }) {
  const rows = p.points
    .filter((d) => d.cumulative !== null)
    .map((d) => ({ key: d.date, date: d.date, day: d.day, off: !d.businessDay, amount: d.amount, hours: d.hours, cumulative: d.cumulative, pace: d.pace }));
  const columns = [
    { key: "date", label: T.daily.colDate, type: "text", render: (r) => fmt(T.daily.colDateValue, { d: r.day, off: r.off ? T.daily.offDay : "" }), sortValue: (r) => r.date, exportValue: (r) => r.date },
    { key: "amount", label: T.daily.colAmount, type: "money", render: (r, u) => money(r.amount, u) },
    { key: "hours", label: T.columns.hours, type: "hours" },
    { key: "cumulative", label: T.daily.colCumulative, type: "money", render: (r, u) => money(r.cumulative, u) },
    { key: "pace", label: T.daily.colPace, type: "money", render: (r, u) => money(r.pace, u) },
  ];
  return dataTable({ columns, rows, unit, caption: T.daily.title, exportName, sort: { key: "date", dir: "asc" } });
}

const h1 = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 });

/**
 * メンバー×日の時間（チーム詳細）。名前・累計・計画・残りの 1 日あたりの右に今月の日の列。
 * 日の列は横に送れる（名前の列は固定）。計画を超えた人は「超過」を赤で出す。
 */
export function dailyMemberTable(p, rows, { nameOf, hrefOf }) {
  if (rows.length === 0) return null;
  const off = (d) => !p.points[d - 1].businessDay;
  const cell = (v, d) => {
    if (v === null) return html`<td class=${`yn-dg-day is-future${off(d) ? " is-off" : ""}`}></td>`;
    const level = v <= 0 ? 0 : Math.min(4, Math.ceil(v / 2.5));
    return html`<td class=${`yn-dg-day yn-dg-l${level}${off(d) ? " is-off" : ""}`}>${v > 0 ? h1.format(v) : ""}</td>`;
  };
  return html`<div class="yn-card yn-dg-wrap" tabindex="0" role="region" aria-label=${T.daily.membersTitle}>
    <table class="yn-dg">
      <thead><tr>
        <th scope="col" class="yn-dg-name">${T.daily.colMember}</th>
        <th scope="col" class="yn-dg-num">${T.daily.colTotal}</th>
        <th scope="col" class="yn-dg-num">${T.daily.colPlan}</th>
        <th scope="col" class="yn-dg-num yn-dg-last">${T.daily.colPerDay}</th>
        ${p.points.map((x) => html`<th scope="col" class=${`yn-dg-day${x.businessDay ? "" : " is-off"}`} title=${fmt(T.daily.tipDateValue, { month: monthJa(p.month), d: x.day, off: x.businessDay ? "" : T.daily.offDay })}>${x.day}</th>`)}
      </tr></thead>
      <tbody>${rows.map((r) => {
        const over = r.plan > 0 && r.remaining < 0;
        const href = hrefOf(r.memberId);
        return html`<tr>
          <th scope="row" class="yn-dg-name">${href ? html`<a href=${href}>${nameOf(r.memberId)}</a>` : nameOf(r.memberId)}</th>
          <td class="yn-dg-num">${formatHours(r.total)}</td>
          <td class="yn-dg-num">${r.plan > 0 ? formatHours(r.plan) : "—"}</td>
          <td class=${`yn-dg-num yn-dg-last${over ? " is-over" : ""}`}>${r.plan <= 0 || r.perDayRemaining === null ? "—" : over ? T.daily.overPlan : formatHours(Math.round(r.perDayRemaining * 10) / 10)}</td>
          ${r.hours.map((v, i) => cell(v, i + 1))}
        </tr>`;
      })}</tbody>
    </table>
  </div>`;
}

/**
 * 見出し ＋ KPI ＋ グラフ（表つき）。p が null なら何も出さない。
 * members を渡すと（チーム詳細）、下にメンバー×日の表を足す。
 */
export function dailySection(p, { unit, dark, subtitle, exportName, members = null }) {
  // display(null) は「null」と表示されるので、出さないときは空の断片を返す
  if (!p) return document.createDocumentFragment();
  const memberRows = members ? dailyMembers(members.model, members.daily, p, members.contractIds) : [];
  const title = fmt(T.daily.sectionTitle, { month: monthJa(p.month) });
  return html`<section class="yn-daily" id="yn-daily">
    ${sectionTitle(title, fmt(T.daily.hint, { date: p.lastDate ?? "—" }))}
    ${dailyKpis(p, { unit, subtitle })}
    ${chartFigure({
      title,
      subtitle: [monthJa(p.month), subtitle].filter(Boolean).join(" ・ "),
      legend: dailyLegend(dark, { target: !!p.target }),
      draw: (width, height) => dailyChart(p, { unit, dark, width, height }),
      after: html`<details class="yn-details"><summary>${T.pages.showTable}</summary>${dailyTable(p, { unit, exportName })}</details>`,
    })}
    ${memberRows.length > 0
      ? html`${sectionTitle(T.daily.membersTitle, fmt(T.daily.membersHint, { date: p.lastDate ?? "—" }))}${dailyMemberTable(p, memberRows, members)}`
      : null}
  </section>`;
}
