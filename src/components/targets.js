/**
 * 目標（SPEC §63）の見せ方: 詳細画面の「目標」の表、一覧の「目標」列、計算根拠。
 * 計算は core/targets.ts（evaluateTarget）に任せ、ここは見せ方だけ。目標が無い対象には何も出さない。
 */
import { html } from "htl";
import { T, fmt } from "../i18n/index.js";
import { evaluateTarget, headlineTarget, targetsOf } from "../core/index.js";
import { sectionTitle } from "./layout.js";
import { chipIcon, statusChip } from "./kpi.js";
import * as bd from "./breakdown.js";
import { formatPercent, money, monthJa, pointsSigned, METHOD_LABELS } from "./format.js";

/** 目標の率（入れた値どおり。20 → "20%"、12.5 → "12.5%"） */
function targetPct(rate) {
  return formatPercent(rate, Math.abs(Math.round(rate * 100) - rate * 100) < 1e-9 ? 0 : 1);
}

const STATUS_KIND = { achieved: "ok", onTrack: "ok", missed: "danger", atRisk: "danger", noBudget: "neutral" };

export function targetChip(ev) {
  return statusChip(STATUS_KIND[ev.status], T.targets.status[ev.status]);
}

/** 計算根拠（期間・予算・実績・見込み・着地・残予算率・目標との差） */
export function targetSpec({ model, ev, name, unit, detailHref = null }) {
  const contractNames = new Map(model.contracts.map((r) => [r.contract.contractId, `${r.contract.customerName} / ${r.contract.projectName}`]));
  return {
    title: fmt(T.targets.breakdownTitle, { due: monthJa(ev.period.to), name }),
    subtitle: fmt(T.targets.breakdownSubtitle, { from: monthJa(ev.period.from), to: monthJa(ev.period.to), method: METHOD_LABELS[ev.method] }),
    formula: [T.targets.formulaRate, T.targets.formulaLanding],
    rows: [
      { label: T.targets.rowBudget, value: money(ev.budget, unit) },
      { label: T.targets.rowActual, value: money(ev.actualCost, unit) },
      { label: T.targets.rowRemaining, value: money(ev.forecastCost - ev.actualCost, unit) },
      { label: T.targets.rowLanding, value: money(ev.forecastCost, unit) },
      { label: T.targets.rowRate, value: formatPercent(ev.rate), emphasis: true },
      { label: T.targets.rowTarget, value: targetPct(ev.target.remainingRate) },
      { label: T.targets.rowGap, value: pointsSigned(ev.gap) },
    ],
    sections: [
      {
        title: fmt(T.targets.contracts, { n: ev.contractIds.length }),
        table: {
          columns: [{ label: T.breakdown.colContract }],
          rows: ev.contractIds.map((id) => [detailHref ? html`<a href=${detailHref(id)}>${contractNames.get(id) ?? id}</a>` : (contractNames.get(id) ?? id)]),
        },
      },
    ],
  };
}

/** 対象の目標をすべて評価する（終了月の順） */
export function evaluateTargetsOf(model, kind, id, method) {
  return targetsOf(model, kind, id).map((t) => ({ ...evaluateTarget(model, t, method), method }));
}

/**
 * 詳細画面の「目標」: 終了月・目標・残予算率（実績 or 見込み）・差・状況。目標が無ければ null（何も出さない）
 */
export function targetSection({ model, kind, id, name, method, unit, detailHref = null }) {
  const list = evaluateTargetsOf(model, kind, id, method);
  if (list.length === 0) return null;
  const rows = list.map((ev) => {
    const rateText = `${formatPercent(ev.rate)}`;
    return html`<tr class=${ev.status === "missed" || ev.status === "atRisk" ? "is-danger" : null}>
      <th scope="row">${monthJa(ev.period.to)}${ev.target.note ? html`<span class="yn-cell-sub">${ev.target.note}</span>` : null}</th>
      <td class="hide-narrow">${monthJa(ev.period.from)}〜${monthJa(ev.period.to)}</td>
      <td class="num">${targetPct(ev.target.remainingRate)}</td>
      <td class="num">${bd.numberButton(rateText, () => targetSpec({ model, ev, name, unit, detailHref }), { ariaLabel: fmt(T.targets.listTitle, { month: monthJa(ev.period.to), target: targetPct(ev.target.remainingRate), kind: ev.settled ? T.targets.rateActual : T.targets.rateForecast, rate: rateText }) })}<span class="yn-cell-sub">${ev.settled ? T.targets.rateActual : T.targets.rateForecast}</span></td>
      <td class="num hide-phone">${pointsSigned(ev.gap)}</td>
      <td>${targetChip(ev)}</td>
    </tr>`;
  });
  return html`<section class="yn-targets" aria-label=${T.targets.title}>
    ${sectionTitle(T.targets.title, fmt(T.targets.tip, { method: METHOD_LABELS[method] }))}
    <div class="yn-table-wrap"><table class="yn-table yn-table-compact yn-targets-table">
      <thead><tr>
        <th scope="col">${T.targets.colEnd}</th>
        <th scope="col" class="hide-narrow">${T.targets.colPeriod}</th>
        <th scope="col" class="num">${T.targets.colTarget}</th>
        <th scope="col" class="num">${T.targets.colRate}</th>
        <th scope="col" class="num hide-phone">${T.targets.colGap}</th>
        <th scope="col">${T.targets.colStatus}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

/**
 * 一覧の「目標」列（基準月以降で最も近い終了月の目標。無ければ最後の目標）。
 * get = 目標との差（並べ替え用。目標なしは null）。目標が 1 件も無い一覧では列ごと出さない（hasTargets で判定）
 */
export function hasTargets(model, kind) {
  return (model.targets ?? []).some((t) => t.kind === kind);
}

export function targetColumn(model, kind, idOf, method) {
  const cache = new Map();
  const evalOf = (row) => {
    const id = idOf(row);
    if (id === null || id === undefined) return null;
    if (cache.has(id)) return cache.get(id);
    const t = headlineTarget(targetsOf(model, kind, id), model.meta.asOfMonth);
    const ev = t ? { ...evaluateTarget(model, t, method), method } : null;
    cache.set(id, ev);
    return ev;
  };
  const text = (ev) => (ev ? `${fmt(T.targets.listCell, { rate: formatPercent(ev.rate), target: targetPct(ev.target.remainingRate) })} ${T.targets.status[ev.status]}` : "");
  return {
    key: "target",
    label: T.targets.title,
    type: "text",
    hideNarrow: true,
    // 1024px 幅では列が収まらないので隠す（目標は各詳細の「目標」で見られる）
    hideMid: true,
    summary: false,
    get: (row) => evalOf(row)?.gap ?? null,
    sortValue: (row) => evalOf(row)?.gap ?? null,
    exportValue: (row) => text(evalOf(row)),
    render: (row) => {
      const ev = evalOf(row);
      if (!ev) return html`<span class="yn-muted">—</span>`;
      const title = fmt(T.targets.listTitle, { month: monthJa(ev.period.to), target: targetPct(ev.target.remainingRate), kind: ev.settled ? T.targets.rateActual : T.targets.rateForecast, rate: formatPercent(ev.rate) });
      // 一覧は幅が限られるので、チップではなく色付きの文字（記号つき。色だけに頼らない）
      const kind = STATUS_KIND[ev.status];
      return html`<span class="yn-target-cell" title=${title}><span class=${`yn-target-status is-${kind}`}><span aria-hidden="true">${chipIcon(kind)}</span>${T.targets.status[ev.status]}</span><span class="yn-cell-sub">${fmt(T.targets.listCell, { rate: formatPercent(ev.rate), target: targetPct(ev.target.remainingRate) })}</span></span>`;
    },
  };
}
