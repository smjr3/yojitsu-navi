/**
 * 着地見込み（SPEC §10）— 契約ごと・asOf の年度ごと、3 方式すべて
 */
import { fiscalYearMonths, fiscalYearOf } from "./calendar.js";
import { roundYen } from "./cost.js";
import { rateFor, type MasterIndex } from "./masters.js";
import type { Assignment, Config, Contract, ContractMonth, Forecast, ForecastBreakdown, ForecastMethod, YearMonth } from "./types.js";

export const FORECAST_METHODS: readonly ForecastMethod[] = ["recent3", "all", "assignment"];

export interface ForecastContext {
  asOfMonth: YearMonth;
  config: Pick<Config, "fiscalYearStartMonth" | "standardHoursPerMonth" | "forecastRecentMonths">;
  masters: MasterIndex;
  /** 全契約のアサイン（契約IDで絞って使う） */
  assignments: readonly Assignment[];
}

/** 契約の着地見込みを 1 方式ぶん計算する。months は契約の全月（期間外の月は含まない） */
export function forecastContract(
  ctx: ForecastContext,
  contract: Contract,
  months: readonly ContractMonth[],
  method: ForecastMethod,
): Forecast {
  const fiscalYear = fiscalYearOf(ctx.asOfMonth, ctx.config.fiscalYearStartMonth);
  const fyMonths = fiscalYearMonths(fiscalYear, ctx.config.fiscalYearStartMonth);
  const byMonth = new Map<YearMonth, ContractMonth>();
  for (const cm of months) byMonth.set(cm.month, cm);

  const contractMonthsInFY = fyMonths.filter((m) => contract.startMonth <= m && m <= contract.endMonth);
  const actualMonths = contractMonthsInFY.filter((m) => m < ctx.asOfMonth);
  const remainingMonths = contractMonthsInFY.filter((m) => m >= ctx.asOfMonth);
  const fyBudget = sum(contractMonthsInFY.map((m) => byMonth.get(m)?.budget ?? 0));
  const actualCost = sum(actualMonths.map((m) => byMonth.get(m)?.cost ?? 0));

  const breakdown: ForecastBreakdown = {
    method,
    fiscalYear,
    fiscalYearMonths: fyMonths,
    contractMonthsInFY,
    actualMonths,
    remainingMonths,
    actualCost,
    averageBasisMonths: [],
    averageMonthlyCost: 0,
    assignmentLines: [],
    remainingCost: 0,
    noActuals: false,
    noAssignments: false,
  };

  if (contractMonthsInFY.length > 0) {
    if (method === "assignment") {
      applyAssignmentMethod(ctx, contract, remainingMonths, breakdown);
    } else {
      applyAverageMethod(ctx, months, remainingMonths, method, breakdown);
    }
  }

  const forecastCost = actualCost + breakdown.remainingCost;
  const forecastGrossProfit = fyBudget - forecastCost;
  return {
    contractId: contract.contractId,
    fiscalYear,
    method,
    fyBudget,
    forecastCost,
    forecastGrossProfit,
    isDeficit: forecastGrossProfit < 0,
    breakdown,
  };
}

/**
 * recent3 / all: 契約期間内で asOf 月より前の月（年度をまたいでよい）の原価平均 × 残り月数。
 * recent3 は直近 forecastRecentMonths か月、all は契約開始からの全月。基礎月 0 → 平均 0・noActuals。
 */
function applyAverageMethod(
  ctx: ForecastContext,
  months: readonly ContractMonth[],
  remainingMonths: readonly YearMonth[],
  method: "recent3" | "all",
  breakdown: ForecastBreakdown,
): void {
  const past = months.filter((cm) => cm.month < ctx.asOfMonth).sort((a, b) => (a.month < b.month ? -1 : 1));
  const basis = method === "recent3" ? past.slice(Math.max(0, past.length - ctx.config.forecastRecentMonths)) : past;
  breakdown.averageBasisMonths = basis.map((cm) => cm.month);
  if (basis.length === 0) {
    breakdown.noActuals = true;
    breakdown.averageMonthlyCost = 0;
    breakdown.remainingCost = 0;
    return;
  }
  breakdown.averageMonthlyCost = sum(basis.map((cm) => cm.cost)) / basis.length;
  breakdown.remainingCost = roundYen(breakdown.averageMonthlyCost * remainingMonths.length);
}

/**
 * assignment: 残り月ごとに、該当アサインの allocation × standardHoursPerMonth × 当月単価 を合計。
 */
function applyAssignmentMethod(
  ctx: ForecastContext,
  contract: Contract,
  remainingMonths: readonly YearMonth[],
  breakdown: ForecastBreakdown,
): void {
  const assignments = ctx.assignments.filter((a) => a.contractId === contract.contractId);
  if (assignments.length === 0) {
    breakdown.noAssignments = true;
    breakdown.remainingCost = 0;
    return;
  }
  let remainingCost = 0;
  for (const month of remainingMonths) {
    for (const a of assignments) {
      if (!(a.startMonth <= month && month <= a.endMonth)) continue;
      if (!Number.isFinite(a.allocation)) continue;
      const rate = rateFor(ctx.masters, a.memberId, month);
      const hours = a.allocation * ctx.config.standardHoursPerMonth;
      const amount = roundYen(hours * rate.hourlyRate);
      breakdown.assignmentLines.push({ month, memberId: a.memberId, allocation: a.allocation, hours, hourlyRate: rate.hourlyRate, amount });
      remainingCost += amount;
    }
  }
  breakdown.remainingCost = remainingCost;
}

/** 3 方式すべての着地見込み */
export function forecastAllMethods(
  ctx: ForecastContext,
  contract: Contract,
  months: readonly ContractMonth[],
): Record<ForecastMethod, Forecast> {
  return {
    recent3: forecastContract(ctx, contract, months, "recent3"),
    all: forecastContract(ctx, contract, months, "all"),
    assignment: forecastContract(ctx, contract, months, "assignment"),
  };
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
