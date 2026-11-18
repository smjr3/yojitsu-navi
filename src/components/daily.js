/**
 * 今月の進捗（SPEC §61）: 今月の実績の累計（速報）を、月の上限を営業日で按分した目安と比べる。
 * 全体・チーム・顧客・案件の詳細で、選択中の期間が asOf の月を含むときだけ出す。
 * daily は data/daily.json（core の encodeDaily）。読めなければ何も出さない。
 */
import * as Plot from "@observablehq/plot";
import { html } from "htl";
import { scaledPx } from "./appearance.js";
import { dailyMembers, dailyProgress, fiscalQuarterOf, formatHours, formatPercent, progressOverRange, progressRangeOf } from "../core/index.js";
import { h } from "./dom.js";
import { chartMessage, loadUnit, saveUnit, unitSwitch, weekText } from "./chart-units.js";
import { maxFractionFormat } from "./format.js";
import { T, fmt } from "../i18n/index.js";
import { chartColors, chartLegend } from "./charts.js";
import { chartFigure } from "./chart-zoom.js";
import { memberInfoColumns } from "./analysis.js";
import { statTile } from "./kpi.js";
import { sectionTitle } from "./layout.js";
import { dataTable } from "./table.js";
import { dateJa, money as moneyBase, monthJa, toCoreUnit } from "./format.js";

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
 * 選択中の期間が今月（asOf の月 = 開いた人の今日の月。§75）を含み、今月の予算があるときだけ進みを返す。
 * daily.json が前の月のもの（月が替わってから取り込みが無い）なら、今月の実績は 0 として出す。
 * target（今月を含む目標。core の targetForMonth）があれば、今月の上限 = 予算 ×（1 − 目標の残予算率）
 */
export function dailyFor(model, daily, contractIds, period, target = null) {
  const month = model.meta.asOfMonth;
  if (!daily || !daily.month || daily.month > month) return null;
  const file = daily.month === month ? daily : { asOf: model.meta.asOf, month, lastDate: null, days: {}, members: {} };
  if (period.from > month || period.to < month) return null;
  const p = dailyProgress(model, file, contractIds, { today: model.meta.asOf, ...(target ? { capRatio: 1 - target.remainingRate } : {}) });
  // daily は実際に使ったファイル（メンバー×日の表も同じものを使う）
  return p && { ...p, target, daily: file };
}

/** 範囲の言葉（今月の進捗なら「今月」「月末」。§130） */
function spanOf(p) {
  const u = p.unit ?? "month";
  return { span: T.daily.spans[u], end: T.daily.ends[u] };
}

/** 範囲の表記（今月なら「2026年10月」、今週なら日付の範囲、今四半期なら「2026年度 第3四半期」、今年度なら「2026年度」） */
function rangeText(p, startMonth = 4) {
  if (!p.unit || p.unit === "month") return monthJa(p.month);
  if (p.unit === "week") return weekText(p.from, p.to);
  const q = fiscalQuarterOf(p.from.slice(0, 7), startMonth);
  return p.unit === "year" ? fmt(T.charts.yearTick, { fy: q.fiscalYear }) : fmt(T.charts.quarterShort, { fy: q.fiscalYear, q: q.quarter });
}

/** 目標の残予算率（整数なら小数なし） */
function ratePct(rate) {
  return formatPercent(rate, Math.abs(Math.round(rate * 100) - rate * 100) < 1e-9 ? 0 : 1);
}

/** 根拠（KPI の数字を押したとき） */
function progressSpec(p, unit, subtitle, emphasisKey) {
  const sp = spanOf(p);
  const rows = [
    ...(p.target
      ? [
          { key: "budget", label: fmt(T.daily.budgetLabel, sp), value: money(p.budget, unit) },
          { key: "target", label: T.daily.targetLabel, value: p.target.mixed ? T.daily.targetMixed : ratePct(p.target.remainingRate) },
        ]
      : []),
    { key: "cap", label: fmt(T.daily.capLabel, sp), value: money(p.cap, unit) },
    { key: "days", label: T.daily.bizDaysLabel, value: fmt(T.daily.bizDaysValue, { elapsed: p.elapsedBusinessDays, total: p.businessDays }) },
    { key: "pace", label: T.daily.paceLabel, value: money(p.paceToDate, unit) },
    { key: "actual", label: T.daily.actualLabel, value: money(p.actual, unit) },
    { key: "remaining", label: T.daily.remainingLabel, value: money(p.remaining, unit) },
    { key: "perDay", label: T.daily.perDayLabel, value: p.perDayRemaining === null ? "—" : money(p.perDayRemaining, unit) },
    { key: "average", label: T.daily.averageLabel, value: p.averagePerDay === null ? "—" : money(p.averagePerDay, unit) },
    { key: "projection", label: fmt(T.daily.projectionLabel, sp), value: money(p.projection, unit) },
  ].map((r) => ({ ...r, emphasis: r.key === emphasisKey }));
  const formulas = T.daily.formulas.map((f, i) => (i === 0 && p.unit && p.unit !== "month" ? T.daily.formulaRange : fmt(f, sp)));
  return {
    title: fmt(T.breakdown.labelTitle, { label: fmt(T.daily.title, sp) }),
    subtitle,
    formula: p.target ? [fmt(T.daily.capFormulaTarget, sp), ...formulas] : formulas,
    rows,
  };
}

/** KPI 4 枚 */
export function dailyKpis(p, { unit, subtitle, startMonth = 4 }) {
  const spec = (key) => () => progressSpec(p, unit, subtitle, key);
  const sp = spanOf(p);
  const overPace = p.actual > p.paceToDate;
  const overCap = p.projection > p.cap;
  // 予実の KPI（.yn-kpi-grid）とは別の行。幅が足りれば 4 列、足りなければ 2×2
  const capSub = p.target ? (p.target.mixed ? T.daily.capSubMixed : fmt(T.daily.capSubTarget, { rate: ratePct(p.target.remainingRate), cap: ratePct(1 - p.target.remainingRate) })) : fmt(T.daily.capSub, { month: rangeText(p, startMonth) });
  return html`<section class="yn-daily-kpis" aria-label=${fmt(T.daily.kpiLabel, sp)}>${[
      statTile({ label: fmt(T.daily.capLabel, sp), value: money(p.cap, unit), sub: capSub, breakdown: spec("cap"), id: "yn-daily-cap" }),
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
        label: fmt(T.daily.projectionLabel, sp),
        value: money(p.projection, unit),
        sub: fmt(T.daily.projectionSub, { diff: money(p.projection - p.cap, unit) }),
        status: overCap ? { kind: "danger", text: T.daily.overCap } : { kind: "ok", text: T.daily.withinCap },
        breakdown: spec("projection"),
        id: "yn-daily-projection",
        emphasis: true,
      }),
    ]}</section>`;
}

export function dailyLegend(dark, { target = false, end = T.daily.ends.month } = {}) {
  const c = chartColors(dark);
  return chartLegend([
    // 並びは他のグラフと同じ 予算 → 実績 → 見込み。予算は青の実線、目標の上限は赤の破線（§63.3・§131）
    target ? { label: T.daily.legendCapTarget, color: c.danger, shape: "line-dashed" } : { label: T.daily.legendCap, color: c.budget, shape: "line" },
    { label: T.daily.legendPace, color: c.budget, shape: "line-dashed" },
    { label: T.daily.legendActual, color: c.cost, shape: "line" },
    { label: fmt(T.daily.legendProjection, { end }), color: c.cost, shape: "line-dotted" },
  ]);
}

/** 累計の折れ線 ＋ 目安 ＋ 上限 ＋ このペースの月末 */
export function dailyChart(p, { unit = "yen", dark = false, width = 640, height = 280 }) {
  const c = chartColors(dark);
  const pts = p.points;
  const n = pts.length;
  const done = pts.filter((d) => d.cumulative !== null);
  const last = done[done.length - 1] ?? null;
  const isRange = !!p.unit && p.unit !== "month";
  const todayDay = p.today ? (isRange ? (pts.find((d) => d.date === p.today)?.day ?? null) : Number(p.today.slice(8, 10))) : null;
  const projLine = last && last.day < n ? [{ day: last.day, v: last.cumulative }, { day: n, v: p.projection }] : [];
  const peak = Math.max(p.cap, p.projection, last?.cumulative ?? 0, 1);
  const axisUnit = peak >= 5e6 ? { label: T.format.units.m, div: 1e6 } : peak >= 5e4 ? { label: T.charts.axisTenThousandYen, div: 1e4 } : { label: T.format.units.yen, div: 1 };
  const axisFormat = (v) => maxFractionFormat(1).format(v / axisUnit.div);
  // 目盛り: 1 日・5 日おき（狭い画面は 10 日おき）。今週は毎日、今四半期・今年度は月の初日（今年度の狭い画面は 1 か月おき）
  const step = width < 520 ? 10 : 5;
  const ticks = !isRange
    ? [1, ...Array.from({ length: Math.floor(n / step) }, (_, i) => (i + 1) * step).filter((d) => d <= n)]
    : p.unit === "week"
      ? pts.filter((d, i) => width >= 520 || i % 2 === 0).map((d) => d.day)
      : pts.filter((d) => d.date.endsWith("-01")).filter((_, i) => p.unit !== "year" || width >= 520 || i % 2 === 0).map((d) => d.day);
  const tickText = (d) => {
    if (!isRange) return fmt(T.daily.dayTick, { d });
    const pt = pts[d - 1];
    if (!pt) return "";
    return p.unit === "week" ? fmt(T.charts.dayTick, { m: Number(pt.date.slice(5, 7)), d: Number(pt.date.slice(8, 10)) }) : fmt(T.format.monthOnly, { month: Number(pt.date.slice(5, 7)) });
  };
  const off = pts.filter((d) => !d.businessDay);
  const plot = Plot.plot({
    width,
    height,
    marginLeft: scaledPx(Math.max(48, 12 + 7.5 * axisFormat(peak).length)),
    marginRight: scaledPx(20),
    marginTop: scaledPx(28),
    marginBottom: scaledPx(32),
    style: { background: "transparent", color: c.text, fontSize: `${scaledPx(12)}px`, fontFamily: "inherit", overflow: "visible" },
    x: { domain: [0.5, n + 0.5], ticks, tickFormat: tickText, tickSize: 0, label: null, line: false },
    y: { grid: true, label: axisUnit.label, labelAnchor: "top", labelArrow: "none", tickFormat: axisFormat, nice: true, zero: true, tickSize: 0, line: false, domain: [0, peak * 1.08] },
    marks: [
      // 土日・祝日
      Plot.rectX(off, { x1: (d) => d.day - 0.5, x2: (d) => d.day + 0.5, fill: c.muted, fillOpacity: 0.08 }),
      Plot.gridY({ stroke: c.grid, strokeOpacity: 1 }),
      Plot.ruleY([0], { stroke: c.axis }),
      p.target ? Plot.ruleY([p.cap], { stroke: c.danger, strokeDasharray: "6 4", strokeWidth: 1.5 }) : Plot.ruleY([p.cap], { stroke: c.budget, strokeWidth: 2 }),
      Plot.line(pts, { x: "day", y: "pace", stroke: c.budget, strokeWidth: 2, strokeDasharray: "4 3", curve: "linear" }),
      Plot.line(projLine, { x: "day", y: "v", stroke: c.cost, strokeWidth: 2, strokeDasharray: "2 3" }),
      Plot.line(done, { x: "day", y: "cumulative", stroke: c.cost, strokeWidth: 2.5, curve: "linear" }),
      last ? Plot.dot([last], { x: "day", y: "cumulative", fill: c.cost, r: 4, stroke: c.surface, strokeWidth: 2 }) : null,
      // 今日（§75）。取り込みが止まると、累計の線が今日の手前で終わって見分けられる
      todayDay ? Plot.ruleX([todayDay], { stroke: c.muted, strokeWidth: 1, strokeDasharray: "1 3" }) : null,
      todayDay ? Plot.text([todayDay], { x: (d) => d, frameAnchor: "top", dy: scaledPx(-14), text: () => T.daily.todayMark, fill: c.muted, fontSize: scaledPx(11) }) : null,
      Plot.ruleX(pts, Plot.pointerX({ x: "day", stroke: c.muted, strokeOpacity: 0.6 })),
      Plot.tip(
        pts,
        Plot.pointerX({
          x: "day",
          y: (d) => Math.max(d.cumulative ?? 0, d.pace),
          preferredAnchor: "bottom",
          dy: scaledPx(-6),
          fill: c.surface,
          stroke: c.axis,
          fontSize: scaledPx(12),
          channels: {
            [T.daily.tipDate]: (d) => (isRange ? `${dateJa(d.date)}${d.businessDay ? "" : T.daily.offDay}` : fmt(T.daily.tipDateValue, { month: monthJa(p.month), d: d.day, off: d.businessDay ? "" : T.daily.offDay })),
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
  plot.setAttribute("aria-label", fmt(T.daily.aria, spanOf(p)));
  return plot;
}

/** グラフの双子の表（経過した日だけ） */
export function dailyTable(p, { unit, exportName }) {
  const isRange = !!p.unit && p.unit !== "month";
  const rows = p.points
    .filter((d) => d.cumulative !== null)
    .map((d) => ({ key: d.date, date: d.date, day: d.day, off: !d.businessDay, amount: d.amount, hours: d.hours, cumulative: d.cumulative, pace: d.pace }));
  const columns = [
    { key: "date", label: T.daily.colDate, type: "text", render: (r) => (isRange ? `${dateJa(r.date)}${r.off ? T.daily.offDay : ""}` : fmt(T.daily.colDateValue, { d: r.day, off: r.off ? T.daily.offDay : "" })), sortValue: (r) => r.date, exportValue: (r) => r.date },
    { key: "amount", label: T.daily.colAmount, type: "money", render: (r, u) => money(r.amount, u) },
    { key: "hours", label: T.columns.hours, type: "hours" },
    { key: "cumulative", label: T.daily.colCumulative, type: "money", render: (r, u) => money(r.cumulative, u) },
    { key: "pace", label: T.daily.colPace, type: "money", render: (r, u) => money(r.pace, u) },
  ];
  return dataTable({ columns, rows, unit, caption: fmt(T.daily.title, spanOf(p)), exportName, sort: { key: "date", dir: "asc" } });
}

const h1 = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 });

/**
 * メンバー×日の時間（チーム詳細）。名前・役職・累計・計画・残りの 1 日あたりの右に今月の日の列。
 * 他の表と同じ dataTable（並べ替え・列の絞り込み・列の設定・Excel。§124）。日の列は「列」に出さず常に末尾（名前の列は横に送っても固定）。
 * 計画を超えた人は「超過」を赤で出す。
 */
export function dailyMemberTable(p, rows, { model, nameOf, hrefOf, exportName = null }) {
  if (rows.length === 0) return null;
  const month = p.month;
  const off = (d) => !p.points[d - 1].businessDay;
  const plan = (r) => (r.plan > 0 ? r.plan : null);
  const isOver = (r) => r.plan > 0 && r.remaining < 0;
  const perDay = (r) => (r.plan > 0 && r.perDayRemaining !== null ? Math.round(r.perDayRemaining * 10) / 10 : null);
  const data = rows.map((r) => ({ ...r, key: r.memberId, memberName: nameOf(r.memberId) }));
  const dayCols = p.points.map((x, i) => ({
    key: `d${x.day}`,
    label: String(x.day),
    exportLabel: fmt(T.table.exportHours, { label: fmt(T.daily.tipDateValue, { month: monthJa(month), d: x.day, off: "" }) }),
    type: "hours",
    menu: false,
    sortable: false,
    filter: false,
    headClass: `yn-dg-day${x.businessDay ? "" : " is-off"}`,
    headTitle: fmt(T.daily.tipDateValue, { month: monthJa(month), d: x.day, off: x.businessDay ? "" : T.daily.offDay }),
    get: (r) => r.hours[i],
    render: (r) => (r.hours[i] > 0 ? h1.format(r.hours[i]) : ""),
    cellClass: (r) => {
      const v = r.hours[i];
      if (v === null) return `yn-dg-day is-future${off(x.day) ? " is-off" : ""}`;
      const level = v <= 0 ? 0 : Math.min(4, Math.ceil(v / 2.5));
      return `yn-dg-day yn-dg-l${level}${off(x.day) ? " is-off" : ""}`;
    },
  }));
  const columns = [
    { key: "memberName", label: T.daily.colMember, type: "text" },
    ...memberInfoColumns(model, month, { shown: ["title"], team: true }),
    { key: "total", label: T.daily.colTotal, type: "hours" },
    { key: "plan", label: T.daily.colPlan, type: "hours", get: plan, summaryDash: true },
    { key: "remaining", label: T.daily.colRemaining, type: "hours", optional: true, get: (r) => (r.plan > 0 ? r.remaining : null) },
    {
      key: "perDay",
      label: T.daily.colPerDay,
      type: "hours",
      get: perDay,
      render: (r) => (perDay(r) === null ? "—" : isOver(r) ? T.daily.overPlan : formatHours(perDay(r))),
      cellClass: (r) => `yn-dg-last${isOver(r) ? " is-over" : ""}`,
      headClass: "yn-dg-last",
      summary: false,
    },
    ...dayCols,
  ];
  const summary = (shown) => {
    const hours = p.points.map((_, i) => {
      let any = false;
      let sum = 0;
      for (const r of shown) {
        if (r.hours[i] === null) continue;
        any = true;
        sum += r.hours[i];
      }
      return any ? Math.round(sum * 100) / 100 : null;
    });
    const total = Math.round(shown.reduce((a, r) => a + r.total, 0) * 100) / 100;
    const planSum = shown.reduce((a, r) => a + r.plan, 0);
    return { name: fmt(T.daily.totalRow, { n: shown.length }), total, plan: planSum, remaining: planSum > 0 ? planSum - total : null, hours };
  };
  return dataTable({
    columns,
    rows: data,
    caption: T.daily.membersTitle,
    exportName,
    className: "yn-dg-table",
    // 既定は計画の多い順、同じなら時間の多い順（dailyMembers の並び）
    sort: null,
    rowHref: (r) => hrefOf(r.memberId),
    summary,
  });
}

/** 進捗の範囲の単位（§130）。日は 1 日だけになるので出さない */
// 今週の進捗は出さない（予算管理は月次から。2026-11-17 依頼者。§130）。core の week は残す
const PROGRESS_UNITS = ["month", "quarter", "year"];

/** 見出し ＋ KPI ＋ グラフ（表つき） */
function progressBody(p, { unit, dark, subtitle, exportName, controls = null, startMonth = 4 }) {
  const sp = spanOf(p);
  const title = fmt(T.daily.sectionTitle, { span: sp.span, month: rangeText(p, startMonth) });
  const isRange = !!p.unit && p.unit !== "month";
  return html`${sectionTitle(title, fmt(T.daily.hint, { date: p.lastDate ?? "—" }))}
    ${dailyKpis(p, { unit, subtitle, startMonth })}
    ${chartFigure({
      title,
      subtitle: [rangeText(p, startMonth), subtitle].filter(Boolean).join(" ・ "),
      legend: dailyLegend(dark, { target: !!p.target, end: sp.end }),
      controls,
      draw: (width, height) => dailyChart(p, { unit, dark, width, height }),
      after: html`<details class="yn-details"><summary>${T.pages.showTable}</summary>${dailyTable(p, { unit, exportName: isRange && exportName ? `${exportName}_${p.unit}` : exportName })}</details>`,
    })}`;
}

/**
 * 範囲（今週・今四半期・今年度）の進捗（§130）。history は data/daily-history.json（lazyJson）、targetOf(month) は目標（core の targetForMonth を対象で包んだもの）
 */
export function rangeProgress(model, history, contractIds, unit, targetOf = null) {
  const startMonth = model.config.fiscalYearStartMonth;
  const { from, to } = progressRangeOf(unit, model.meta.asOf, startMonth);
  const capRatioOf = (m) => {
    const t = targetOf?.(m);
    return t ? 1 - t.remainingRate : 1;
  };
  const p = progressOverRange(model, history, contractIds, { unit, from, to, capRatioOf, today: model.meta.asOf });
  if (!p) return null;
  // 目標: 予算のある月すべてに同じ率の目標があればその率、月ごとに違えば「月ごと」、どの月にも無ければ出さない
  let target = null;
  if (targetOf) {
    const ids = new Set(contractIds);
    const months = new Set();
    for (const r of model.contracts) {
      if (!ids.has(r.contract.contractId)) continue;
      for (const cm of r.months) if (cm.budget !== 0 && cm.month >= from.slice(0, 7) && cm.month <= to.slice(0, 7)) months.add(cm.month);
    }
    const rates = [...months].map((m) => targetOf(m)?.remainingRate ?? null);
    if (rates.some((r) => r !== null)) target = rates.every((r) => r === rates[0]) ? { remainingRate: rates[0] } : { mixed: true };
  }
  return { ...p, target };
}

/** 選択中の期間が今月を含み、対象の案件に今年度の予算があるか（範囲の進捗を出せるか） */
function hasYearBudget({ model, contractIds, period }) {
  const month = model.meta.asOfMonth;
  if (!period || period.from > month || period.to < month) return false;
  const { from, to } = progressRangeOf("year", model.meta.asOf, model.config.fiscalYearStartMonth);
  return hasBudgetIn({ model, contractIds }, from.slice(0, 7), to.slice(0, 7));
}

function hasBudgetIn({ model, contractIds }, from, to) {
  const ids = new Set(contractIds);
  return model.contracts.some((r) => ids.has(r.contract.contractId) && r.months.some((cm) => cm.budget !== 0 && cm.month >= from && cm.month <= to));
}

/**
 * 見出し ＋ KPI ＋ グラフ（表つき）。p が null なら、範囲の切り替え（range）で今年度に予算があるときだけ出す。
 * members を渡すと（チーム詳細）、下にメンバー×日の表を足す（今月のまま）。
 * range を渡すと、グラフの上に 週・月・四半期・年度 の切り替えを出す（§130）: { model, history（lazyJson）, contractIds, targetOf, period（選択中の期間） }
 */
export function dailySection(p, { unit, dark, subtitle, exportName, members = null, range = null }) {
  // display(null) は「null」と表示されるので、出さないときは空の断片を返す
  // 今月の予算が無くても、今年度のどこかに予算があれば範囲の切り替えは出す（今月は「予算のある案件がありません」）
  if (!p && !(range && hasYearBudget(range))) return document.createDocumentFragment();
  const memberRows = p && members ? dailyMembers(members.model, p.daily ?? members.daily, p, members.contractIds) : [];
  const startMonth = range?.model.config.fiscalYearStartMonth ?? 4;
  const body = h("div", { class: "yn-daily-body" });
  let cur = range ? loadUnit("progress", PROGRESS_UNITS) : "month";
  let token = 0;
  const show = () => {
    const my = ++token;
    const controls = range
      ? unitSwitch({
          units: PROGRESS_UNITS,
          value: cur,
          labels: T.daily.unitLabels,
          groupLabel: T.daily.unitGroupLabel,
          onChange: (u) => {
            cur = u;
            saveUnit("progress", u);
            show();
            body.querySelector(`.yn-chart-unit [data-unit="${u}"]`)?.focus();
          },
        })
      : null;
    const opts = { unit, dark, subtitle, exportName, controls, startMonth };
    const sp = { span: T.daily.spans[cur] };
    const msg = (text) => html`${sectionTitle(fmt(T.daily.title, sp))}${chartFigure({ title: fmt(T.daily.title, sp), controls, draw: () => chartMessage(text) })}`;
    if (cur === "month") {
      // 今月の予算があるのに p が無い = data/daily.json が読めない
      body.replaceChildren(p ? progressBody(p, opts) : msg(hasBudgetIn(range, range.model.meta.asOfMonth, range.model.meta.asOfMonth) ? T.daily.loadFailed : T.daily.noBudget));
      return;
    }
    body.replaceChildren(msg(T.daily.loading));
    range.history().then((hist) => {
      if (my !== token) return;
      if (!hist) return body.replaceChildren(msg(T.daily.loadFailed));
      const rp = rangeProgress(range.model, hist, range.contractIds, cur, range.targetOf);
      // 範囲に予算が無い（今週に契約期間の案件が無いなど）。今月の進捗と同じく数字は出さない
      body.replaceChildren(rp ? progressBody(rp, opts) : msg(T.daily.noBudget));
    });
  };
  show();
  return html`<section class="yn-daily" id="yn-daily">
    ${body}
    ${memberRows.length > 0
      ? html`${sectionTitle(T.daily.membersTitle, fmt(T.daily.membersHint, { date: p?.lastDate ?? "—" }))}${dailyMemberTable(p, memberRows, { ...members, exportName: exportName ? `${exportName}_members` : null })}`
      : null}
  </section>`;
}
