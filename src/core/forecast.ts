/**
 * 着地見込み（SPEC §10・§54）— 契約ごと、3 方式すべて
 *
 * 対象の月（target）は既定で asOf の年度。画面では選択中の期間（§54）、案件詳細では契約の全期間（案件終了時点の着地）。
 * 見積りの材料（平均の基礎・リソース計画の明細）は対象の月に依らないので、Model に持たせて画面で対象を変えて計算し直す。
 */
import { fiscalYearMonths, fiscalYearOf, monthRange } from "./calendar.js";
import { roundYen } from "./cost.js";
import { rateFor, type MasterIndex } from "./masters.js";
import type { Assignment, AssignmentForecastLine, AssignmentPlan, Config, Contract, ContractMonth, Forecast, ForecastBreakdown, ForecastMethod, YearMonth } from "./types.js";

export const FORECAST_METHODS: readonly ForecastMethod[] = ["assignment", "recent3", "all"];

export interface ForecastContext {
  asOfMonth: YearMonth;
  config: Pick<Config, "fiscalYearStartMonth" | "standardHoursPerMonth" | "forecastRecentMonths">;
  masters: MasterIndex;
  /** 全契約のアサイン（契約IDで絞って使う） */
  assignments: readonly Assignment[];
}

/** 対象の月を変えて計算し直すのに要る設定（Model の meta・config から取れる） */
export interface ForecastBasis {
  asOfMonth: YearMonth;
  fiscalYear: number;
  forecastRecentMonths: number;
}

/**
 * リソース計画（assignment 方式）の明細を、asOf 月から契約の終了月まで前もって作る。
 * 月ごとに、該当アサインの allocation × standardHoursPerMonth × 当月単価（円に丸める）。
 */
export function assignmentPlanOf(ctx: ForecastContext, contract: Contract): AssignmentPlan {
  const assignments = ctx.assignments.filter((a) => a.contractId === contract.contractId);
  const lines: AssignmentForecastLine[] = [];
  const from = ctx.asOfMonth > contract.startMonth ? ctx.asOfMonth : contract.startMonth;
  if (assignments.length > 0 && from <= contract.endMonth) {
    for (const month of monthRange(from, contract.endMonth)) {
      for (const a of assignments) {
        if (!(a.startMonth <= month && month <= a.endMonth)) continue;
        if (!Number.isFinite(a.allocation)) continue;
        const rate = rateFor(ctx.masters, a.memberId, month);
        const hours = a.allocation * ctx.config.standardHoursPerMonth;
        lines.push({ month, memberId: a.memberId, allocation: a.allocation, hours, hourlyRate: rate.hourlyRate, amount: roundYen(hours * rate.hourlyRate) });
      }
    }
  }
  return { hasAssignments: assignments.length > 0, lines };
}

/**
 * 対象の月（targetMonths）を指定した着地見込み。Model だけで計算できる（画面で期間を変えたときに使う）。
 * months は契約の全月、plan は assignmentPlanOf の結果。対象のうち契約期間内の月だけを数える。
 */
export function forecastForMonths(
  basis: ForecastBasis,
  contract: Contract,
  months: readonly ContractMonth[],
  plan: AssignmentPlan,
  method: ForecastMethod,
  targetMonths: readonly YearMonth[],
): Forecast {
  const byMonth = new Map<YearMonth, ContractMonth>();
  for (const cm of months) byMonth.set(cm.month, cm);

  const contractMonthsInTarget = targetMonths.filter((m) => contract.startMonth <= m && m <= contract.endMonth);
  const actualMonths = contractMonthsInTarget.filter((m) => m < basis.asOfMonth);
  const remainingMonths = contractMonthsInTarget.filter((m) => m >= basis.asOfMonth);
  const targetBudget = sum(contractMonthsInTarget.map((m) => byMonth.get(m)?.budget ?? 0));
  const actualCost = sum(actualMonths.map((m) => byMonth.get(m)?.cost ?? 0));

  const breakdown: ForecastBreakdown = {
    method,
    fiscalYear: basis.fiscalYear,
    targetMonths: [...targetMonths],
    contractMonthsInTarget,
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

  if (contractMonthsInTarget.length > 0) {
    if (method === "assignment") {
      applyAssignmentMethod(plan, remainingMonths, breakdown);
    } else {
      applyAverageMethod(basis, months, remainingMonths, method, breakdown);
    }
  }

  const forecastCost = actualCost + breakdown.remainingCost;
  const forecastGrossProfit = targetBudget - forecastCost;
  return {
    contractId: contract.contractId,
    fiscalYear: basis.fiscalYear,
    method,
    targetBudget,
    forecastCost,
    forecastGrossProfit,
    isDeficit: forecastGrossProfit < 0,
    breakdown,
  };
}

/** 3 方式すべての着地見込み（対象の月を指定） */
export function forecastAllMethodsForMonths(
  basis: ForecastBasis,
  contract: Contract,
  months: readonly ContractMonth[],
  plan: AssignmentPlan,
  targetMonths: readonly YearMonth[],
): Record<ForecastMethod, Forecast> {
  return {
    assignment: forecastForMonths(basis, contract, months, plan, "assignment", targetMonths),
    recent3: forecastForMonths(basis, contract, months, plan, "recent3", targetMonths),
    all: forecastForMonths(basis, contract, months, plan, "all", targetMonths),
  };
}

/** 契約の着地見込みを 1 方式ぶん計算する（対象 = asOf の年度）。months は契約の全月（期間外の月は含まない） */
export function forecastContract(ctx: ForecastContext, contract: Contract, months: readonly ContractMonth[], method: ForecastMethod): Forecast {
  const fiscalYear = fiscalYearOf(ctx.asOfMonth, ctx.config.fiscalYearStartMonth);
  const basis: ForecastBasis = { asOfMonth: ctx.asOfMonth, fiscalYear, forecastRecentMonths: ctx.config.forecastRecentMonths };
  return forecastForMonths(basis, contract, months, assignmentPlanOf(ctx, contract), method, fiscalYearMonths(fiscalYear, ctx.config.fiscalYearStartMonth));
}

/**
 * recent3 / all: 契約期間内で asOf 月より前の月（年度をまたいでよい）の原価平均 × 残り月数。
 * recent3 は直近 forecastRecentMonths か月、all は契約開始からの全月。基礎月 0 → 平均 0・noActuals。
 */
function applyAverageMethod(
  basis: ForecastBasis,
  months: readonly ContractMonth[],
  remainingMonths: readonly YearMonth[],
  method: "recent3" | "all",
  breakdown: ForecastBreakdown,
): void {
  const past = months.filter((cm) => cm.month < basis.asOfMonth).sort((a, b) => (a.month < b.month ? -1 : 1));
  const used = method === "recent3" ? past.slice(Math.max(0, past.length - basis.forecastRecentMonths)) : past;
  breakdown.averageBasisMonths = used.map((cm) => cm.month);
  if (used.length === 0) {
    breakdown.noActuals = true;
    breakdown.averageMonthlyCost = 0;
    breakdown.remainingCost = 0;
    return;
  }
  breakdown.averageMonthlyCost = sum(used.map((cm) => cm.cost)) / used.length;
  breakdown.remainingCost = roundYen(breakdown.averageMonthlyCost * remainingMonths.length);
}

/** assignment: 残り月のリソース計画の明細（前もって作ったもの）を合計 */
function applyAssignmentMethod(plan: AssignmentPlan, remainingMonths: readonly YearMonth[], breakdown: ForecastBreakdown): void {
  if (!plan.hasAssignments) {
    breakdown.noAssignments = true;
    breakdown.remainingCost = 0;
    return;
  }
  const remaining = new Set(remainingMonths);
  breakdown.assignmentLines = plan.lines.filter((l) => remaining.has(l.month)).map((l) => ({ ...l }));
  breakdown.remainingCost = sum(breakdown.assignmentLines.map((l) => l.amount));
}

/** 3 方式すべての着地見込み（対象 = asOf の年度） */
export function forecastAllMethods(ctx: ForecastContext, contract: Contract, months: readonly ContractMonth[]): Record<ForecastMethod, Forecast> {
  return {
    assignment: forecastContract(ctx, contract, months, "assignment"),
    recent3: forecastContract(ctx, contract, months, "recent3"),
    all: forecastContract(ctx, contract, months, "all"),
  };
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
