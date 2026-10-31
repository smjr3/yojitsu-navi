/**
 * チーム詳細（/team）専用の部品: KPI 5 枚、メンバー別原価の根拠、組織の変遷の文言
 *
 * 計算は core/team-detail.ts（teamMemberCosts / teamOrgChanges / teamPath）に任せ、ここは見せ方だけ。
 */
import { html } from "htl";
import { T, fmt } from "../i18n/index.js";
import { statTile, kpiRow, forecastStatus } from "./kpi.js";
import { burnMeter } from "./charts.js";
import * as bd from "./breakdown.js";
import { money, moneySigned, pointsSigned, formatPercent, formatHours, monthJa, monthSpanJa, periodJa, METHOD_LABELS, fiscalYearLabel, integer } from "./format.js";

/**
 * 全体サマリーと同じ KPI 5 枚（年度予算・原価・粗利・消化率・着地見込み粗利）。
 * scope = {period, contractIds, teamLabel}、compare = priorYearComparison() の結果 or null。
 */
export function summaryKpis({ model, store, scope, totals, forecast, compare, fy, unit, origin = null }) {
  const asOfMonth = model.meta.asOfMonth;
  const subtitle = `${periodJa(scope.period)} ・ ${scope.teamLabel}`;
  const spanLabel = (p) => monthSpanJa([p.from, p.to]);
  const cmp = (key, { good = null, points = false } = {}) => {
    if (!compare) return { text: T.kpi.noCompare, direction: null, good: null };
    const a = compare.now[key];
    const b = compare.before[key];
    if (a === null || b === null || a === undefined || b === undefined) return { text: T.kpi.noCompare, direction: null, good: null };
    const d = a - b;
    const dir = d > 0 ? "up" : d < 0 ? "down" : "flat";
    const text = fmt(T.kpi.compareText, { diff: points ? pointsSigned(d) : moneySigned(d, unit), current: spanLabel(compare.current), prior: spanLabel(compare.prior), partial: compare.partial ? T.kpi.comparePartial : "" });
    return { text: fmt(T.kpi.compareShort, { diff: points ? pointsSigned(d) : moneySigned(d, unit) }), title: text, direction: dir, good: good === null ? null : good(d) };
  };
  const elapsedLabel = (months) => (months.length === 0 ? T.kpi.noElapsed : fmt(T.kpi.elapsed, { span: monthSpanJa(months), n: months.length, prelim: months[months.length - 1] > model.meta.lastFinalMonth ? T.kpi.elapsedPrelim : "" }));
  const detailHref = (id) => store.href("./contract", {}, { id });
  return kpiRow([
    statTile({
      label: fy ? fmt(T.kpi.budgetFy, { fy: fiscalYearLabel(fy) }) : T.kpi.budgetPeriod,
      value: money(totals.budget, unit),
      sub: fmt(T.kpi.contractCount, { n: totals.contractCount }),
      compare: cmp("budget"),
      breakdown: () => bd.budgetAggregateSpec({ model, contractIds: scope.contractIds, period: scope.period, unit, label: T.kpi.budgetBreakdownLabel }),
    }),
    statTile({
      label: T.kpi.cost,
      value: money(totals.cost, unit),
      sub: withOrigin(fmt(T.kpi.costSub, { costRatio: formatPercent(totals.grossMargin === null ? null : 1 - totals.grossMargin), hours: integer(Math.round(totals.hours)) }), origin, unit),
      compare: cmp("cost", { good: (d) => d <= 0 }),
      breakdown: () => bd.costAggregateSpec({ model, contractIds: scope.contractIds, period: scope.period, unit, detailHref }),
    }),
    statTile({
      label: T.kpi.grossProfit,
      value: money(totals.grossProfit, unit),
      sub: html`${T.kpi.marginPrefix} ${bd.numberButton(formatPercent(totals.grossMargin), () => bd.marginSpec({ totals, unit, subtitle }), { className: "yn-num-inline", ariaLabel: T.kpi.marginAria })}`,
      compare: cmp("grossProfit", { good: (d) => d >= 0 }),
      status: totals.grossProfit < 0 ? { kind: "danger", text: T.kpi.deficit } : null,
      breakdown: () => bd.grossProfitSpec({ budget: totals.budget, cost: totals.cost, unit, subtitle }),
    }),
    statTile({
      label: T.kpi.burnRate,
      value: formatPercent(totals.burnRate),
      sub: html`${burnMeter(totals.burnRate, model.config.burnRateDangerThreshold)}<span>${fmt(T.kpi.burnSub, { elapsed: elapsedLabel(totals.burnRateBreakdown.elapsedMonths), threshold: formatPercent(model.config.burnRateDangerThreshold, 0) })}</span>`,
      status: totals.isOverBudget ? { kind: "danger", text: T.kpi.overBudget } : totals.burnRate === null ? { kind: "neutral", text: T.kpi.noElapsed } : { kind: "ok", text: T.kpi.withinRange },
      breakdown: () => bd.burnRateSpec({ totals, unit, threshold: model.config.burnRateDangerThreshold, asOfMonth, subtitle }),
    }),
    statTile({
      label: fmt(T.kpi.forecast, { fy: fiscalYearLabel(forecast.fiscalYear), method: METHOD_LABELS[forecast.method] }),
      value: money(forecast.forecastGrossProfit, unit),
      sub: fmt(T.kpi.forecastSub, { budget: money(forecast.targetBudget, unit), cost: money(forecast.forecastCost, unit) }),
      status: forecastStatus(forecast),
      breakdown: () => bd.forecastTotalsSpec({ model, totals: forecast, unit, contractIds: scope.contractIds, detailHref }),
      emphasis: true,
    }),
  ]);
}

/** メンバー 1 人の原価の根拠: そのメンバーの原価行（月・契約ごと）を並べる */
export function memberCostSpec({ model, contractIds, period, unit, member, detailHref = null }) {
  const set = new Set(contractIds);
  const rows = [];
  const names = new Map(model.contracts.map((r) => [r.contract.contractId, `${r.contract.customerName} / ${r.contract.projectName}`]));
  const contractName = (id) => names.get(id) ?? id;
  for (const r of model.contracts) {
    if (!set.has(r.contract.contractId)) continue;
    for (const cm of r.months) {
      if (cm.month < period.from || cm.month > period.to) continue;
      for (const l of cm.costLines) {
        if (l.memberId !== member.memberId) continue;
        rows.push({ month: cm.month, id: r.contract.contractId, l });
      }
    }
  }
  rows.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    title: fmt(T.teamDetail.memberCostTitle, { name: member.memberName, id: member.memberId }),
    subtitle: fmt(T.teamDetail.memberCostSubtitle, { period: periodJa(period) }),
    formula: [T.teamDetail.memberCostFormulaLine, T.teamDetail.memberCostFormulaSum],
    rows: [
      { label: T.breakdown.workHours, value: formatHours(member.hours) },
      { label: T.breakdown.costLineCount, value: `${rows.length}` },
      { label: T.teamDetail.costTotal, value: money(member.amount, "yen"), emphasis: true },
    ],
    sections: [
      {
        title: T.teamDetail.costLinesMonthContract,
        table: {
          columns: [{ label: T.breakdown.colMonth }, { label: T.breakdown.colContract }, { label: T.breakdown.colHours, align: "num" }, { label: T.breakdown.colRate, align: "num" }, { label: T.breakdown.colAmount, align: "num" }],
          rows: rows.map(({ month, id, l }) => [
            monthJa(month),
            detailHref ? html`<a href=${detailHref(id)}>${contractName(id)}</a>` : contractName(id),
            formatHours(l.hours),
            l.rateMissing ? T.breakdown.rateMissing : money(l.hourlyRate, "yen"),
            money(l.amount, "yen"),
          ]),
          foot: [T.breakdown.total, "", formatHours(member.hours), "", money(member.amount, "yen")],
        },
      },
    ],
  };
}

/** 組織の変遷 1 件の説明文（見ているチームから見て何が起きたか） */
export function orgChangeText(c) {
  const parent = (name) => (name ? `「${name}」` : T.teamDetail.topLevel);
  if (c.relation === "self") {
    if (c.kind === "renamed") return fmt(T.teamDetail.selfRenamed, { oldName: c.oldName, name: c.name });
    if (c.kind === "created") return fmt(T.teamDetail.selfCreated, { parent: parent(c.parentName) });
    return fmt(T.teamDetail.selfMoved, { oldParent: parent(c.oldParentName), parent: parent(c.parentName) });
  }
  if (c.relation === "in") {
    return c.kind === "created" ? fmt(T.teamDetail.inCreated, { name: c.name }) : fmt(T.teamDetail.inMoved, { name: c.name, oldParent: parent(c.oldParentName) });
  }
  return fmt(T.teamDetail.outMoved, { name: c.name, parent: parent(c.parentName) });
}

export const ORG_CHANGE_LABELS = { created: T.teamDetail.kindCreated, renamed: T.teamDetail.kindRenamed, moved: T.teamDetail.kindMoved };


// ---------------------------------------------------------------------------
// 応援・ヘルプ（§71）: チーム詳細と案件詳細のメンバー表・実績の KPI で共通
// ---------------------------------------------------------------------------

/** 実績の KPI の下に「うち応援 ○・ヘルプ ○」を足す（どちらも 0 なら元のまま） */
export function withOrigin(sub, origin, unit) {
  const line = originLine(origin, unit);
  return line ? html.fragment`<span>${sub}</span>${line}` : sub;
}

/** 「うち応援 ○・ヘルプ ○」（時間のある方だけ）。どちらも 0 なら null */
export function originLine(origin, unit) {
  if (!origin) return null;
  const parts = [];
  if (origin.supportHours > 0) parts.push(fmt(T.team.originSupport, { amount: money(origin.supportAmount, unit) }));
  if (origin.helpHours > 0) parts.push(fmt(T.team.originHelp, { amount: money(origin.helpAmount, unit) }));
  if (parts.length === 0) return null;
  return html`<span class="yn-kpi-origin" data-origin>${fmt(T.team.originPrefix, { parts: parts.join(T.team.originSep) })}</span>`;
}

/** メンバー表の氏名の横のチップ（応援・ヘルプ）。supportTitle は画面ごとの説明 */
export function originChips(r, supportTitle) {
  const chips = [];
  if (r.supportHours > 0) chips.push(html` <span class="yn-chip yn-chip-neutral" data-origin="support" title=${supportTitle}>${T.team.support}</span>`);
  if (r.helpHours > 0) chips.push(html` <span class="yn-chip yn-chip-neutral yn-chip-help" data-origin="help" title=${r.memberUnknown ? T.team.helpUnknownTitle : T.team.helpTitle}>${T.team.help}</span>`);
  return chips;
}

/** 所属（当時）の列: チーム名。所属チームの無い月は部・課、メンバーマスタに無ければ「マスタ未登録」 */
export function originOrgText(r, teamName) {
  const parts = r.teamIds.map(teamName);
  for (const o of r.orgLabels ?? []) if (!parts.includes(o)) parts.push(o);
  if (r.memberUnknown) parts.push(T.team.unregistered);
  return parts.join("、") || "—";
}
