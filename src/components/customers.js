/**
 * 顧客別画面（/customers, /customer）の共通部品。
 * 顧客キー・表示名の決定はコア（core/customers.ts）。ここでは「選んだ契約ID集合を 1 行にする」だけ。
 */
import { aggregate, forecastTotals, groupByCustomer } from "../core/index.js";
import { standardColumns, rowStatus, statusSortValue, contractNameCell, contractInfoColumns } from "./table.js";
import * as bd from "./breakdown.js";
import { T } from "../i18n/index.js";

/** 画面が使う顧客グループ（全契約 → コアの groupByCustomer）。model ごとに 1 回だけ作る */
export function customerGroups(model) {
  return groupByCustomer(model.contracts.map((r) => r.contract));
}

/**
 * 顧客詳細へのリンク。key は encodeURIComponent（日本語・記号・空白・/ ・# ・% を含んでも往復できる）。
 * 状態（期間・単位・方式）は store.href が付けるクエリを引き継ぐ。
 */
export function customerHref(store, key, patch = {}) {
  const base = store.href("./customer", patch);
  const k = `key=${encodeURIComponent(key)}`;
  return base.includes("?") ? base.replace("?", `?${k}&`) : `${base}?${k}`;
}

/** 契約ID集合を 1 行にする（チーム行 teamRow と同じ項目。期間内の契約が無ければ着地は null） */
export function idsRow(model, ids, period, method, extra = {}) {
  const set = new Set(ids);
  const results = model.contracts.filter((r) => set.has(r.contract.contractId));
  const totals = aggregate(model, { period, contractIds: ids });
  const f = forecastTotals(model, ids, method);
  return {
    contractIds: ids,
    contractCount: totals.contractCount,
    totals,
    forecast: f,
    budget: totals.budget,
    cost: totals.cost,
    grossProfit: totals.grossProfit,
    grossMargin: totals.grossMargin,
    burnRate: totals.burnRate,
    isOverBudget: totals.isOverBudget,
    includesPreliminary: totals.includesPreliminary,
    forecastGrossProfit: totals.contractCount === 0 ? null : f.forecastGrossProfit,
    deficitCount: f.deficitContractIds.length,
    isDeficit: f.deficitContractIds.length > 0,
    hours: totals.hours,
    ...extra,
  };
}

/** 契約ID集合を母集団にした標準列の根拠（顧客行・担当チーム行で共通） */
export function groupBreakdowns({ model, store, period, unit }) {
  const detailHref = (id) => store.href("./contract", {}, { id });
  const threshold = model.config.burnRateDangerThreshold;
  return {
    budget: (r) => bd.budgetAggregateSpec({ model, contractIds: r.contractIds, period, unit }),
    cost: (r) => bd.costAggregateSpec({ model, contractIds: r.contractIds, period, unit, detailHref }),
    grossProfit: (r) => bd.grossProfitSpec({ budget: r.budget, cost: r.cost, unit, subtitle: r.name }),
    margin: (r) => bd.marginSpec({ totals: r.totals, unit, subtitle: r.name }),
    burnRate: (r) => bd.burnRateSpec({ totals: r.totals, unit, threshold, asOfMonth: model.meta.asOfMonth, subtitle: r.name }),
    forecast: (r) => bd.forecastTotalsSpec({ model, totals: r.forecast, unit, contractIds: r.contractIds, detailHref }),
  };
}

/** 契約 1 件の標準列の根拠（顧客詳細の契約一覧。契約一覧と同じ） */
export function contractBreakdowns({ model, store, period, unit }) {
  const detailHref = (id) => store.href("./contract", {}, { id });
  const threshold = model.config.burnRateDangerThreshold;
  const sub = (r) => `${r.customerName} / ${r.projectName}`;
  return {
    budget: (r) => bd.budgetAggregateSpec({ model, contractIds: [r.contractId], period, unit }),
    cost: (r) => bd.costAggregateSpec({ model, contractIds: [r.contractId], period, unit, detailHref }),
    grossProfit: (r) => bd.grossProfitSpec({ budget: r.budget, cost: r.cost, unit, subtitle: sub(r) }),
    margin: (r) => bd.marginSpec({ totals: r.totals, unit, subtitle: sub(r) }),
    burnRate: (r) => bd.burnRateSpec({ totals: r.totals, unit, threshold, asOfMonth: model.meta.asOfMonth, subtitle: sub(r) }),
    forecast: (r) => bd.forecastSpec({ forecast: r.forecast, contract: r.contract, unit, config: model.config, model }),
  };
}

/** 顧客詳細の契約一覧の列（契約一覧 /contracts と同じ並び） */
export function contractListColumns({ model, store, period, unit }) {
  return [
    { key: "name", label: T.columns.contract, type: "text", render: (r) => contractNameCell(r), sortValue: (r) => `${r.customerName} ${r.projectName}`, exportValue: (r) => `${r.customerName} / ${r.projectName}` },
    { key: "contractId", label: T.columns.contractId, type: "text", exportOnly: true },
    ...contractInfoColumns(),
    ...standardColumns({ costTypes: model.config.costTypes, breakdowns: contractBreakdowns({ model, store, period, unit }) }),
    { key: "status", label: T.columns.status, type: "status", get: (r) => rowStatus(r), sortValue: (r) => statusSortValue(r), hideNarrow: true },
  ];
}
