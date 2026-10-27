/**
 * 画面向けの集計補助（計算コアの aggregate / forecastTotals を組み合わせる）
 *
 * 計算そのものはコアに任せ、ここでは「どの契約を・どの期間で」を決めるだけ。
 */
import {
  UNASSIGNED_TEAM_ID,
  UNASSIGNED_TEAM_LABEL,
  addMonths,
  aggregate,
  contractsForTeam,
  forecastTotals,
  monthlySeries,
  teamTreeForMonth,
} from "../core/index.js";

/** 期間の終了月の組織（SPEC §11: チーム一覧は期間終了月の組織で表示） */
export function treeAt(model, month) {
  const tree = teamTreeForMonth({ teams: model.teams }, month);
  const rootTeamIds = Object.values(tree)
    .filter((n) => n.parentTeamId === null)
    .map((n) => n.teamId);
  return { tree, rootTeamIds };
}

/** チーム名（未設定・不明も含む） */
export function teamName(model, teamId, tree = model.teamTree) {
  if (teamId === UNASSIGNED_TEAM_ID) return UNASSIGNED_TEAM_LABEL;
  if (teamId === "" || teamId === null || teamId === undefined) return "全体";
  const node = tree[teamId] ?? model.teamTree[teamId];
  if (node) return node.name;
  const rec = model.teams.find((t) => t.teamId === teamId);
  return rec ? rec.name : teamId;
}

/** 契約の主担当チーム名（期間終了月の組織。木に無ければ最新の名前、空は未設定） */
export function contractTeamName(model, contract, tree) {
  if (!contract.teamId) return UNASSIGNED_TEAM_LABEL;
  return teamName(model, contract.teamId, tree);
}

/**
 * 状態（期間・チーム）から集計範囲を作る。
 * contractIds は選択チーム（配下含む）の契約。全体のときは undefined（= 全契約）。
 */
export function scopeFor(model, state) {
  const period = { from: state.from, to: state.to };
  const { tree } = treeAt(model, period.to);
  let contractIds;
  let label = "全体";
  if (state.team) {
    contractIds = contractsForTeam(model, state.team, tree).map((c) => c.contractId);
    label = teamName(model, state.team, tree);
  }
  return { period, contractIds, teamId: state.team, teamLabel: label, tree };
}

/** 集計一式（KPI 行で使う） */
export function summarize(model, scope, method) {
  const totals = aggregate(model, { period: scope.period, contractIds: scope.contractIds });
  const series = monthlySeries(model, { period: scope.period, contractIds: scope.contractIds });
  const forecast = forecastTotals(model, scope.contractIds, method);
  return { totals, series, forecast };
}

/**
 * 残り月ごとの見込み原価（グラフ用）。
 * recent3/all は平均 × 1 か月、assignment は明細を月で合算。年度外の月は無し。
 */
export function forecastMonthlyCost(model, contractIds, method) {
  const set = contractIds ? new Set(contractIds) : null;
  const byMonth = new Map();
  for (const r of model.contracts) {
    if (set && !set.has(r.contract.contractId)) continue;
    const f = r.forecasts[method];
    if (!f) continue;
    const b = f.breakdown;
    for (const m of b.remainingMonths) {
      let v = 0;
      if (method === "assignment") {
        for (const line of b.assignmentLines) if (line.month === m) v += line.amount;
      } else {
        v = b.averageMonthlyCost;
      }
      byMonth.set(m, (byMonth.get(m) ?? 0) + v);
    }
  }
  for (const [m, v] of byMonth) byMonth.set(m, Math.round(v));
  return byMonth;
}

/** 月次推移に見込み原価を重ねる（status が preliminary/future の月に forecastCost を持たせる） */
export function seriesWithForecast(model, scope, method) {
  const series = monthlySeries(model, { period: scope.period, contractIds: scope.contractIds });
  const fc = forecastMonthlyCost(model, scope.contractIds, method);
  return series.map((p) => {
    const isRemaining = p.month >= model.meta.asOfMonth && fc.has(p.month);
    const forecastCost = isRemaining ? fc.get(p.month) : null;
    return {
      ...p,
      isActual: p.month < model.meta.asOfMonth,
      forecastCost,
      forecastGrossProfit: forecastCost === null ? null : p.budget - forecastCost,
    };
  });
}

/** 前年同期（経過月だけを比べる）。比較できなければ null */
export function priorYearComparison(model, scope) {
  if (!model.meta.hasPriorYearData) return null;
  const asOf = model.meta.asOfMonth;
  const elapsedTo = scope.period.to < asOf ? scope.period.to : asOf;
  if (scope.period.from > elapsedTo) return null;
  const current = { from: scope.period.from, to: elapsedTo };
  const prior = { from: addMonths(current.from, -12), to: addMonths(current.to, -12) };
  if (prior.from < model.meta.minMonth) return null;
  const now = aggregate(model, { period: current, contractIds: scope.contractIds });
  const before = aggregate(model, { period: prior, contractIds: scope.contractIds });
  if (before.budget === 0 && before.cost === 0) return null;
  return { current, prior, now, before };
}

/** 契約1件の期間集計 ＋ 着地（契約一覧の行） */
export function contractRow(model, r, period, method, tree) {
  const totals = aggregate(model, { period, contractIds: [r.contract.contractId] });
  const f = r.forecasts[method];
  return {
    contractId: r.contract.contractId,
    contract: r.contract,
    customerName: r.contract.customerName,
    projectName: r.contract.projectName,
    teamId: r.contract.teamId,
    teamName: contractTeamName(model, r.contract, tree),
    startMonth: r.contract.startMonth,
    endMonth: r.contract.endMonth,
    totalAmount: r.contract.totalAmount,
    inPeriod: totals.contractCount > 0,
    totals,
    forecast: f,
    budget: totals.budget,
    cost: totals.cost,
    grossProfit: totals.grossProfit,
    grossMargin: totals.grossMargin,
    burnRate: totals.burnRate,
    isOverBudget: totals.isOverBudget,
    includesPreliminary: totals.includesPreliminary,
    forecastGrossProfit: f.fyBudget === 0 && f.breakdown.contractMonthsInFY.length === 0 ? null : f.forecastGrossProfit,
    isDeficit: f.isDeficit,
    hours: totals.hours,
  };
}

/** チーム（配下含む）の行 */
export function teamRow(model, teamId, name, depth, period, method, tree, extra = {}) {
  const contracts = contractsForTeam(model, teamId, tree);
  const ids = contracts.map((c) => c.contractId);
  const totals = aggregate(model, { period, contractIds: ids });
  const f = forecastTotals(model, ids, method);
  return {
    teamId,
    name,
    depth,
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
    forecastGrossProfit: f.forecastGrossProfit,
    deficitCount: f.deficitContractIds.length,
    isDeficit: f.deficitContractIds.length > 0,
    hours: totals.hours,
    ...extra,
  };
}

/** 組織木を DFS で平らにする（チーム一覧の行順） */
export function flattenTree(tree, rootTeamIds) {
  const out = [];
  const visit = (id, depth, parent) => {
    const node = tree[id];
    if (!node) return;
    out.push({ node, depth, parent, hasChildren: node.children.length > 0 });
    for (const child of node.children) visit(child, depth + 1, id);
  };
  for (const id of rootTeamIds) visit(id, 0, null);
  return out;
}

export { UNASSIGNED_TEAM_ID, UNASSIGNED_TEAM_LABEL };
