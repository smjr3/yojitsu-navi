/**
 * 月次予算（SPEC §2, §3）と契約の妥当性判定
 */
import { isValidYearMonth, monthRange, monthsBetween } from "./calendar.js";
import type { BudgetBreakdown, Contract, Warning, YearMonth } from "./types.js";
import { T, fmt } from "../i18n/index.js";

export interface MonthlyBudget {
  budget: number;
  breakdown: BudgetBreakdown;
}

/** 契約の月数（両端含む）。不正な契約では 0 */
export function contractMonthCount(contract: Pick<Contract, "startMonth" | "endMonth">): number {
  if (!isValidYearMonth(contract.startMonth) || !isValidYearMonth(contract.endMonth)) return 0;
  return monthsBetween(contract.startMonth, contract.endMonth);
}

/** 月 → 営業日数（土日と祝日を除いた日。§9） */
export type BusinessDaysOf = (month: YearMonth) => number;

/**
 * 契約の全月の予算一覧（SPEC §2・§118）。契約総額を契約期間の営業日数で按分する:
 * 月の予算 = floor(契約総額 × その月の営業日数 ÷ 契約期間の営業日数)。最終月は 契約総額 − ほかの月の合計（端数を乗せる）。
 * 契約期間の営業日が 0 日（祝日表の誤りなど）のときは月数で均等に割る。
 */
export function budgetSchedule(contract: Contract, businessDaysOf: BusinessDaysOf): Array<{ month: YearMonth } & MonthlyBudget> {
  const monthCount = contractMonthCount(contract);
  if (monthCount === 0) throw new RangeError(`契約 ${contract.contractId} の期間が不正です`);
  const months = monthRange(contract.startMonth, contract.endMonth);
  const days = months.map((m) => Math.max(0, businessDaysOf(m)));
  const totalBusinessDays = days.reduce((a, b) => a + b, 0);
  const totalAmount = contract.totalAmount;
  const byDays = totalBusinessDays > 0;
  const base = months.map((_, i) => (byDays ? Math.floor((totalAmount * days[i]!) / totalBusinessDays) : Math.floor(totalAmount / monthCount)));
  const remainder = totalAmount - base.reduce((a, b) => a + b, 0);
  return months.map((month, i) => {
    const isLastMonth = i === months.length - 1;
    const baseAmount = base[i]!;
    return {
      month,
      budget: isLastMonth ? baseAmount + remainder : baseAmount,
      breakdown: { totalAmount, monthCount, businessDays: days[i]!, totalBusinessDays, byBusinessDays: byDays, baseAmount, remainder, isLastMonth },
    };
  });
}

/** 月 m の予算（budgetSchedule の 1 か月分）。契約期間外の月を渡すと例外（呼び出し側のバグ） */
export function monthlyBudget(contract: Contract, month: YearMonth, businessDaysOf: BusinessDaysOf): MonthlyBudget {
  if (contractMonthCount(contract) === 0 || month < contract.startMonth || month > contract.endMonth) {
    throw new RangeError(`契約 ${contract.contractId} の期間外の月です: ${month}`);
  }
  const hit = budgetSchedule(contract, businessDaysOf).find((x) => x.month === month)!;
  return { budget: hit.budget, breakdown: hit.breakdown };
}

/** 契約が計算対象として妥当でない理由（妥当なら null） */
export function contractInvalidReason(contract: Contract): string | null {
  if (!isValidYearMonth(contract.startMonth)) return fmt(T.calcWarnings.contractStartMonthInvalid, { value: contract.startMonth });
  if (!isValidYearMonth(contract.endMonth)) return fmt(T.calcWarnings.contractEndMonthInvalid, { value: contract.endMonth });
  if (contract.startMonth > contract.endMonth) return fmt(T.calcWarnings.contractPeriodInverted, { from: contract.startMonth, to: contract.endMonth });
  if (typeof contract.totalAmount !== "number" || !Number.isFinite(contract.totalAmount)) return T.calcWarnings.contractAmountNotNumber;
  if (contract.totalAmount < 0) return fmt(T.calcWarnings.contractAmountNegative, { value: contract.totalAmount });
  if (!Number.isInteger(contract.totalAmount)) return fmt(T.calcWarnings.contractAmountNotInteger, { value: contract.totalAmount });
  return null;
}

export interface ContractPartition {
  /** 計算対象の契約（ファイル順） */
  valid: Contract[];
  /** 除外した契約と理由 */
  excluded: Array<{ contract: Contract; reason: string }>;
  warnings: Warning[];
}

/**
 * 重複ID（最初の行のみ採用・DUPLICATE_CONTRACT_ID）と不正契約（CONTRACT_INVALID）を除外する。
 * 重複の判定は妥当性より先に行う（最初の行が不正でも 2 行目は採用しない）。
 */
export function partitionContracts(contracts: readonly Contract[]): ContractPartition {
  const seen = new Set<string>();
  const valid: Contract[] = [];
  const excluded: ContractPartition["excluded"] = [];
  const warnings: Warning[] = [];
  for (const contract of contracts) {
    if (seen.has(contract.contractId)) {
      warnings.push({
        code: "DUPLICATE_CONTRACT_ID",
        message: fmt(T.calcWarnings.duplicateContractId, { contractId: contract.contractId }),
        ref: { contractId: contract.contractId },
      });
      excluded.push({ contract, reason: T.calcWarnings.duplicateReason });
      continue;
    }
    seen.add(contract.contractId);
    const reason = contractInvalidReason(contract);
    if (reason !== null) {
      warnings.push({
        code: "CONTRACT_INVALID",
        message: fmt(T.calcWarnings.contractExcluded, { contractId: contract.contractId, reason }),
        ref: { contractId: contract.contractId },
      });
      excluded.push({ contract, reason });
      continue;
    }
    valid.push(contract);
  }
  return { valid, excluded, warnings };
}
