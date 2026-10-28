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
  fiscalYearMonths,
  forecastTotals,
  monthlySeries,
  teamTreeForMonth,
} from "../core/index.js";


/** 木からチームを引く（URL の team=constructor などで Object.prototype のプロパティを拾わない） */
export const ownNode = (tree, id) => (tree && id != null && Object.hasOwn(tree, id) ? tree[id] : undefined);

/** 粗利率（コアの aggregate() と同じ規則: 予算 0 は null）。Totals が無い場面（月ごと・見込み）だけで使う */
export function grossMarginOf(budget, cost) {
  if (typeof budget !== "number" || typeof cost !== "number" || !Number.isFinite(budget) || !Number.isFinite(cost)) return null;
  return budget !== 0 ? (budget - cost) / budget : null;
}

/**
 * メンバー別をチームで絞るときの対象メンバーID（上位チームは配下を含む。UNASSIGNED は所属が空か木に無い人）。
 * members は「期間全体」で集計した人の一覧にすること（経過月だけで作ると、未来月にだけアサインのある人が抜ける）。
 * team が空なら null（絞らない）。
 */
export function memberIdsInTeam(members, team, tree) {
  if (!team) return null;
  if (team === UNASSIGNED_TEAM_ID) return members.filter((m) => !m.teamId || !ownNode(tree, m.teamId)).map((m) => m.memberId);
  const ids = new Set(ownNode(tree, team)?.descendantIds ?? []);
  return members.filter((m) => m.teamId && ids.has(m.teamId)).map((m) => m.memberId);
}

/** 組織の基準月: 期間終了月、ただし未来の組織は使わない（min(period.to, asOfMonth)） */
export function treeMonthFor(model, period) {
  return period.to < model.meta.asOfMonth ? period.to : model.meta.asOfMonth;
}

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
  const node = ownNode(tree, teamId) ?? ownNode(model.teamTree, teamId);
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
  const treeMonth = treeMonthFor(model, period);
  const { tree } = treeAt(model, treeMonth);
  let contractIds;
  let label = "全体";
  let teamMissing = false;
  if (state.team) {
    contractIds = contractsForTeam(model, state.team, tree).map((c) => c.contractId);
    label = teamName(model, state.team, tree);
    teamMissing = state.team !== UNASSIGNED_TEAM_ID && !ownNode(tree, state.team);
  }
  return { period, contractIds, teamId: state.team, teamLabel: label, tree, treeMonth, teamMissing };
}

/** 集計一式（KPI 行で使う） */
export function summarize(model, scope, method) {
  const totals = aggregate(model, { period: scope.period, contractIds: scope.contractIds });
  const series = monthlySeries(model, { period: scope.period, contractIds: scope.contractIds });
  const forecast = forecastTotals(model, scope.contractIds, method);
  return { totals, series, forecast };
}

/**
 * 残り月ごとの見込み原価（グラフ・月表用）。年度外の月は無し。
 * 契約ごとの月割りの合計は必ずコアの remainingCost に一致させる:
 *   recent3/all   remainingCost を残り月で均等割り（端数は最終月）
 *   assignment    明細（assignmentLines）を月で合算（合計 = remainingCost）
 */
export function forecastMonthlyCost(model, contractIds, method) {
  const set = contractIds ? new Set(contractIds) : null;
  const byMonth = new Map();
  const add = (m, v) => byMonth.set(m, (byMonth.get(m) ?? 0) + v);
  for (const r of model.contracts) {
    if (set && !set.has(r.contract.contractId)) continue;
    const f = r.forecasts[method];
    if (!f) continue;
    const b = f.breakdown;
    const n = b.remainingMonths.length;
    if (n === 0) continue;
    if (method === "assignment") {
      for (const m of b.remainingMonths) {
        let v = 0;
        for (const line of b.assignmentLines) if (line.month === m) v += line.amount;
        add(m, v);
      }
    } else {
      const base = Math.floor(b.remainingCost / n);
      b.remainingMonths.forEach((m, i) => add(m, i === n - 1 ? b.remainingCost - base * (n - 1) : base));
    }
  }
  return byMonth;
}

/**
 * 月次推移に見込み原価を重ねる。
 *   isActual   基準月より前（実績）
 *   forecastCost  基準月以降で年度内の月: 見込み原価（見込みが無ければ 0）。年度外の月は null
 *   outsideFY  基準月以降で年度外の月（見込み対象外。原価・粗利は無し）
 */
export function seriesWithForecast(model, scope, method) {
  const series = monthlySeries(model, { period: scope.period, contractIds: scope.contractIds });
  const fc = forecastMonthlyCost(model, scope.contractIds, method);
  const fy = new Set(fiscalYearMonths(model.meta.fiscalYear, model.config.fiscalYearStartMonth));
  return series.map((p) => {
    const isActual = p.month < model.meta.asOfMonth;
    const inFY = fy.has(p.month);
    const forecastCost = isActual || !inFY ? null : (fc.get(p.month) ?? 0);
    return {
      ...p,
      isActual,
      outsideFY: !isActual && !inFY,
      forecastCost,
      forecastGrossProfit: forecastCost === null ? null : p.budget - forecastCost,
    };
  });
}

/**
 * 前年同期（経過月 = 期間開始〜基準月 の累計を、12 か月前の同じ月と比べる）。比較できなければ null。
 * 前年のデータが途中からしか無いときは、データのある月に両方を詰めて partial: true を返す。
 */
export function priorYearComparison(model, scope) {
  if (!model.meta.hasPriorYearData) return null;
  const asOf = model.meta.asOfMonth;
  const elapsedTo = scope.period.to < asOf ? scope.period.to : asOf;
  if (scope.period.from > elapsedTo) return null;
  const current = { from: scope.period.from, to: elapsedTo };
  const prior = { from: addMonths(current.from, -12), to: addMonths(current.to, -12) };
  let partial = false;
  if (prior.from < model.meta.minMonth) {
    prior.from = model.meta.minMonth;
    current.from = addMonths(model.meta.minMonth, 12);
    partial = true;
    if (prior.from > prior.to) return null;
  }
  const now = aggregate(model, { period: current, contractIds: scope.contractIds });
  const before = aggregate(model, { period: prior, contractIds: scope.contractIds });
  if (before.budget === 0 && before.cost === 0) return null;
  return { current, prior, now, before, partial };
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
  // 契約数は「期間内」、着地は「年度内」の契約が母集団（列ラベルで区別する）
  const fyContractCount = contracts.filter((c) => (model.contracts.find((r) => r.contract.contractId === c.contractId)?.forecasts[method]?.breakdown.contractMonthsInFY.length ?? 0) > 0).length;
  return {
    teamId,
    name,
    depth,
    contractIds: ids,
    contractCount: totals.contractCount,
    fyContractCount,
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
