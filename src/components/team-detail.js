/**
 * チーム詳細（/team）専用の部品: KPI 5 枚、メンバー別原価の根拠、組織の変遷の文言
 *
 * 計算は core/team-detail.ts（teamMemberCosts / teamOrgChanges / teamPath）に任せ、ここは見せ方だけ。
 */
import { html } from "htl";
import { statTile, kpiRow } from "./kpi.js";
import { burnMeter } from "./charts.js";
import * as bd from "./breakdown.js";
import { money, moneySigned, pointsSigned, formatPercent, formatHours, monthJa, monthSpanJa, periodJa, METHOD_LABELS, fiscalYearLabel, integer } from "./format.js";

/**
 * 全体サマリーと同じ KPI 5 枚（年度予算・原価・粗利・消化率・着地見込み粗利）。
 * scope = {period, contractIds, teamLabel}、compare = priorYearComparison() の結果 or null。
 */
export function summaryKpis({ model, store, scope, totals, forecast, compare, fy, unit }) {
  const asOfMonth = model.meta.asOfMonth;
  const subtitle = `${periodJa(scope.period)} ・ ${scope.teamLabel}`;
  const spanLabel = (p) => (p.from === p.to ? monthJa(p.from) : p.from.slice(0, 4) === p.to.slice(0, 4) ? `${monthJa(p.from)}〜${Number(p.to.slice(5, 7))}月` : `${monthJa(p.from)}〜${monthJa(p.to)}`);
  const cmp = (key, { good = null, points = false } = {}) => {
    if (!compare) return { text: "前年同期の比較データなし", direction: null, good: null };
    const a = compare.now[key];
    const b = compare.before[key];
    if (a === null || b === null || a === undefined || b === undefined) return { text: "前年同期の比較データなし", direction: null, good: null };
    const d = a - b;
    const dir = d > 0 ? "up" : d < 0 ? "down" : "flat";
    const text = `${points ? pointsSigned(d) : moneySigned(d, unit)} ・ ${spanLabel(compare.current)}の累計を前年同期（${spanLabel(compare.prior)}）と比較${compare.partial ? "。前年はデータのある月のみ" : ""}`;
    return { text, direction: dir, good: good === null ? null : good(d) };
  };
  const elapsedLabel = (months) => (months.length === 0 ? "経過月なし" : `${monthSpanJa(months)}の${months.length}か月${months[months.length - 1] > model.meta.lastFinalMonth ? "（速報含む）" : ""}`);
  const detailHref = (id) => store.href("./contract", {}, { id });
  const deficitCount = forecast.deficitContractIds.length;
  return kpiRow([
    statTile({
      label: fy ? `年度予算（${fiscalYearLabel(fy)}）` : "期間の予算",
      value: money(totals.budget, unit),
      sub: `${totals.contractCount}件の契約`,
      compare: cmp("budget"),
      breakdown: () => bd.budgetAggregateSpec({ model, contractIds: scope.contractIds, period: scope.period, unit, label: "予算" }),
    }),
    statTile({
      label: "原価（工数原価）",
      value: money(totals.cost, unit),
      sub: `原価率 ${formatPercent(totals.grossMargin === null ? null : 1 - totals.grossMargin)} ・ ${integer(Math.round(totals.hours))}h`,
      compare: cmp("cost", { good: (d) => d <= 0 }),
      breakdown: () => bd.costAggregateSpec({ model, contractIds: scope.contractIds, period: scope.period, unit, detailHref }),
    }),
    statTile({
      label: "粗利",
      value: money(totals.grossProfit, unit),
      sub: html`粗利率 ${bd.numberButton(formatPercent(totals.grossMargin), () => bd.marginSpec({ totals, unit, subtitle }), { className: "yn-num-inline", ariaLabel: "粗利率の計算根拠を表示" })}`,
      compare: cmp("grossProfit", { good: (d) => d >= 0 }),
      status: totals.grossProfit < 0 ? { kind: "danger", text: "赤字" } : null,
      breakdown: () => bd.grossProfitSpec({ budget: totals.budget, cost: totals.cost, unit, subtitle }),
    }),
    statTile({
      label: "消化率（経過月の累計）",
      value: formatPercent(totals.burnRate),
      sub: html`${burnMeter(totals.burnRate, model.config.burnRateDangerThreshold)}<span>${elapsedLabel(totals.burnRateBreakdown.elapsedMonths)} ・ 基準 ${formatPercent(model.config.burnRateDangerThreshold, 0)}</span>`,
      status: totals.isOverBudget ? { kind: "danger", text: "予算超過" } : totals.burnRate === null ? { kind: "neutral", text: "経過月なし" } : { kind: "ok", text: "範囲内" },
      breakdown: () => bd.burnRateSpec({ totals, unit, threshold: model.config.burnRateDangerThreshold, asOfMonth, subtitle }),
    }),
    statTile({
      label: `着地見込み粗利（${fiscalYearLabel(forecast.fiscalYear)}・${METHOD_LABELS[forecast.method]}）`,
      value: money(forecast.forecastGrossProfit, unit),
      sub: `年度予算 ${money(forecast.fyBudget, unit)} − 着地原価 ${money(forecast.forecastCost, unit)}`,
      status: deficitCount > 0 ? { kind: "danger", text: `赤字見込み ${deficitCount}件` } : { kind: "ok", text: "赤字見込みなし" },
      breakdown: () => bd.forecastTotalsSpec({ model, totals: forecast, unit, contractIds: scope.contractIds, detailHref }),
      emphasis: true,
    }),
  ]);
}

/** メンバー 1 人の原価の根拠: そのメンバーの原価行（月・契約ごと）を並べる */
export function memberCostSpec({ model, contractIds, period, unit, member, detailHref = null }) {
  const set = new Set(contractIds);
  const rows = [];
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
    title: `メンバー別原価の計算根拠 — ${member.memberName}（${member.memberId}）`,
    subtitle: `${periodJa(period)} ・ このチームの契約に付いた作業（所属チームは問いません）`,
    formula: ["行の原価 = round(作業時間 × その月に有効な時間単価)", "メンバーの原価 = Σ 期間内・対象契約の原価行"],
    rows: [
      { label: "作業時間", value: formatHours(member.hours) },
      { label: "原価行の数", value: `${rows.length}` },
      { label: "原価合計", value: money(member.amount, unit), emphasis: true },
    ],
    sections: [
      {
        title: "原価行（月 × 契約）",
        table: {
          columns: [{ label: "月" }, { label: "契約ID" }, { label: "時間", align: "num" }, { label: "単価", align: "num" }, { label: "金額", align: "num" }],
          rows: rows.map(({ month, id, l }) => [
            monthJa(month),
            detailHref ? html`<a href=${detailHref(id)}>${id}</a>` : id,
            formatHours(l.hours),
            l.rateMissing ? "単価なし" : money(l.hourlyRate, "yen"),
            money(l.amount, unit),
          ]),
          foot: ["合計", "", formatHours(member.hours), "", money(member.amount, unit)],
        },
      },
    ],
  };
}

/** 組織の変遷 1 件の説明文（見ているチームから見て何が起きたか） */
export function orgChangeText(c) {
  const parent = (name) => (name ? `「${name}」` : "最上位");
  if (c.relation === "self") {
    if (c.kind === "renamed") return `名称を「${c.oldName}」から「${c.name}」に変更`;
    if (c.kind === "created") return `新設（上位: ${parent(c.parentName)}）`;
    return `上位チームを ${parent(c.oldParentName)} から ${parent(c.parentName)} に変更`;
  }
  if (c.relation === "in") {
    return c.kind === "created" ? `「${c.name}」が新設され、このチームの配下に入りました` : `「${c.name}」が ${parent(c.oldParentName)} からこのチームの配下に移りました`;
  }
  return `「${c.name}」がこのチームの配下から ${parent(c.parentName)} に移りました`;
}

export const ORG_CHANGE_LABELS = { created: "新設", renamed: "名称変更", moved: "付け替え" };

