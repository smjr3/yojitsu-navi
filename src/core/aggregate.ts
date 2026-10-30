/**
 * 集計（SPEC §11）— 画面側で Model（プレーンな JSON）に対して実行する
 */
import { monthRange } from "./calendar.js";
import { monthStatusFromMeta } from "./status.js";
import { teamTreeAt } from "./masters.js";
import { forecastAllMethodsForMonths } from "./forecast.js";
import { T } from "../i18n/index.js";
import type {
  Contract,
  ContractMonth,
  ContractResult,
  CostTypeId,
  Dataset,
  Forecast,
  ForecastMethod,
  ForecastTotals,
  Model,
  MonthlyPoint,
  Period,
  TeamNode,
  Totals,
  YearMonth,
} from "./types.js";

export interface AggregateScope {
  period: Period;
  /** 省略 = 全契約 */
  contractIds?: readonly string[];
}

/** 主担当チームが空・未知の契約を入れる仮想グループのID */
export const UNASSIGNED_TEAM_ID = "__unassigned__";
export const UNASSIGNED_TEAM_LABEL = T.numbers.unassignedTeam;

function emptyCosts(model: Model): Record<CostTypeId, number> {
  const costs: Record<CostTypeId, number> = {};
  for (const t of model.config.costTypes) costs[t.id] = 0;
  return costs;
}

function selectContracts(model: Model, contractIds?: readonly string[]): ContractResult[] {
  if (!contractIds) return model.contracts;
  const set = new Set(contractIds);
  return model.contracts.filter((r) => set.has(r.contract.contractId));
}

function addCosts(target: Record<CostTypeId, number>, source: Record<CostTypeId, number>): void {
  for (const key of Object.keys(source)) target[key] = (target[key] ?? 0) + (source[key] ?? 0);
}

/** 期間内（両端含む）の ContractMonth を列挙 */
function monthsInPeriod(results: readonly ContractResult[], period: Period): ContractMonth[] {
  const out: ContractMonth[] = [];
  for (const r of results) {
    for (const cm of r.months) if (period.from <= cm.month && cm.month <= period.to) out.push(cm);
  }
  return out;
}

/** 期間・契約範囲の合計 */
export function aggregate(model: Model, scope: AggregateScope): Totals {
  const results = selectContracts(model, scope.contractIds);
  const months = monthsInPeriod(results, scope.period);
  const costs = emptyCosts(model);
  let budget = 0;
  let cost = 0;
  let hours = 0;
  let personMonthsCalendar = 0;
  let includesPreliminary = false;
  let cumulativeCost = 0;
  let cumulativeBudget = 0;
  const elapsedSet = new Set<YearMonth>();
  const contractSet = new Set<string>();
  for (const cm of months) {
    budget += cm.budget;
    cost += cm.cost;
    hours += cm.hours;
    addCosts(costs, cm.costs);
    contractSet.add(cm.contractId);
    const denom = cm.businessDays * model.config.hoursPerBusinessDay;
    if (denom > 0) personMonthsCalendar += cm.hours / denom;
    if (cm.status === "preliminary") includesPreliminary = true;
    if (cm.month <= model.meta.asOfMonth) {
      elapsedSet.add(cm.month);
      cumulativeCost += cm.cost;
      cumulativeBudget += cm.budget;
    }
  }
  const grossProfit = budget - cost;
  const burnRate = cumulativeBudget > 0 ? cumulativeCost / cumulativeBudget : null;
  return {
    budget,
    cost,
    costs,
    grossProfit,
    grossMargin: budget !== 0 ? grossProfit / budget : null,
    hours,
    burnRate,
    burnRateBreakdown: { elapsedMonths: [...elapsedSet].sort(), cumulativeCost, cumulativeBudget },
    isOverBudget: burnRate !== null && burnRate > model.config.burnRateDangerThreshold,
    personMonthsStandard: model.config.standardHoursPerMonth > 0 ? hours / model.config.standardHoursPerMonth : 0,
    personMonthsCalendar,
    includesPreliminary,
    contractCount: contractSet.size,
  };
}

/** 期間の全月の推移。契約の無い月は 0、状態は asOf 基準 */
export function monthlySeries(model: Model, scope: AggregateScope): MonthlyPoint[] {
  const results = selectContracts(model, scope.contractIds);
  const points = new Map<YearMonth, MonthlyPoint>();
  for (const month of monthRange(scope.period.from, scope.period.to)) {
    points.set(month, {
      month,
      status: monthStatusFromMeta(month, model.meta),
      budget: 0,
      cost: 0,
      costs: emptyCosts(model),
      grossProfit: 0,
      hours: 0,
    });
  }
  for (const cm of monthsInPeriod(results, scope.period)) {
    const p = points.get(cm.month);
    if (!p) continue;
    p.budget += cm.budget;
    p.cost += cm.cost;
    p.hours += cm.hours;
    addCosts(p.costs, cm.costs);
    p.grossProfit = p.budget - p.cost;
  }
  return [...points.values()];
}

/** 契約ごとの着地見込みを合算（対象の期間は setForecastPeriod で選んだもの） */
export function forecastTotals(model: Model, contractIds: readonly string[] | undefined, method: ForecastMethod): ForecastTotals {
  const results = selectContracts(model, contractIds);
  let targetBudget = 0;
  let forecastCost = 0;
  const deficitContractIds: string[] = [];
  for (const r of results) {
    const f = r.forecasts[method];
    targetBudget += f.targetBudget;
    forecastCost += f.forecastCost;
    if (f.isDeficit) deficitContractIds.push(r.contract.contractId);
  }
  return {
    method,
    fiscalYear: model.meta.fiscalYear,
    period: forecastPeriodOf(model),
    targetBudget,
    forecastCost,
    forecastGrossProfit: targetBudget - forecastCost,
    deficitContractIds,
    contractCount: results.length,
  };
}

const FORECAST_PERIOD = Symbol("forecastPeriod");
type WithForecastPeriod = Model & { [FORECAST_PERIOD]?: Period };

/** いま着地見込みが対象にしている期間（null = Model を作ったときの asOf の年度） */
export function forecastPeriodOf(model: Model): Period | null {
  return (model as WithForecastPeriod)[FORECAST_PERIOD] ?? null;
}

/**
 * 着地見込みの対象を期間に合わせる（§54）。契約ごとの forecasts を、期間内の契約月だけで計算し直して置き換える。
 * 画面は期間を変えるたびに呼ぶ（scopeFor が呼ぶ）。同じ期間なら何もしない。Model を書き換えるのはここだけ。
 */
export function setForecastPeriod(model: Model, period: Period): void {
  const cur = forecastPeriodOf(model);
  if (cur && cur.from === period.from && cur.to === period.to) return;
  const basis = { asOfMonth: model.meta.asOfMonth, fiscalYear: model.meta.fiscalYear, forecastRecentMonths: model.config.forecastRecentMonths };
  const target = period.from <= period.to ? monthRange(period.from, period.to) : [];
  for (const r of model.contracts) {
    r.forecasts = forecastAllMethodsForMonths(basis, r.contract, r.months, r.assignmentPlan, target);
  }
  Object.defineProperty(model, FORECAST_PERIOD, { value: { from: period.from, to: period.to }, configurable: true, enumerable: false, writable: true });
}

/** 契約の全期間（案件終了時点）の着地見込み（案件詳細で使う。§54） */
export function contractEndForecasts(model: Model, r: ContractResult): Record<ForecastMethod, Forecast> {
  const basis = { asOfMonth: model.meta.asOfMonth, fiscalYear: model.meta.fiscalYear, forecastRecentMonths: model.config.forecastRecentMonths };
  return forecastAllMethodsForMonths(basis, r.contract, r.months, r.assignmentPlan, monthRange(r.contract.startMonth, r.contract.endMonth));
}

/**
 * チーム（自分と配下）の契約。
 * teamId が UNASSIGNED_TEAM_ID のときは、主担当チームが空か木に無い契約を返す。
 * tree を省略すると model.teamTree（asOf 月の組織）を使う。
 */
export function contractsForTeam(model: Model, teamId: string, tree: Record<string, TeamNode> = model.teamTree): Contract[] {
  if (teamId === UNASSIGNED_TEAM_ID) {
    return model.contracts.map((r) => r.contract).filter((c) => c.teamId === null || c.teamId === "" || !(c.teamId in tree));
  }
  const node = tree[teamId];
  if (!node) return [];
  const ids = new Set(node.descendantIds);
  return model.contracts.map((r) => r.contract).filter((c) => c.teamId !== null && ids.has(c.teamId));
}

/** 指定月の組織で木を作る（期間の終了月で表示するときに使う）。Model には祝日や teams が無いので Dataset を渡す */
export function teamTreeForMonth(dataset: Pick<Dataset, "teams">, month: YearMonth): Record<string, TeamNode> {
  return teamTreeAt(dataset, month).tree;
}
