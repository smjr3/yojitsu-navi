/**
 * 月次予算（SPEC §2, §3）と契約の妥当性判定
 */
import { isValidYearMonth, monthRange, monthsBetween } from "./calendar.js";
import type { BudgetBreakdown, Contract, Warning, YearMonth } from "./types.js";

export interface MonthlyBudget {
  budget: number;
  breakdown: BudgetBreakdown;
}

/** 契約の月数（両端含む）。不正な契約では 0 */
export function contractMonthCount(contract: Pick<Contract, "startMonth" | "endMonth">): number {
  if (!isValidYearMonth(contract.startMonth) || !isValidYearMonth(contract.endMonth)) return 0;
  return monthsBetween(contract.startMonth, contract.endMonth);
}

/**
 * 月 m の予算。均等割り（切り捨て）＋端数は最終月に乗せる。
 * 契約期間外の月を渡すと例外（呼び出し側のバグ）。
 */
export function monthlyBudget(contract: Contract, month: YearMonth): MonthlyBudget {
  const monthCount = contractMonthCount(contract);
  if (monthCount === 0 || month < contract.startMonth || month > contract.endMonth) {
    throw new RangeError(`契約 ${contract.contractId} の期間外の月です: ${month}`);
  }
  const totalAmount = contract.totalAmount;
  const baseMonthly = Math.floor(totalAmount / monthCount);
  const remainder = totalAmount - baseMonthly * monthCount;
  const isLastMonth = month === contract.endMonth;
  const budget = isLastMonth ? baseMonthly + remainder : baseMonthly;
  return { budget, breakdown: { totalAmount, monthCount, baseMonthly, remainder, isLastMonth } };
}

/** 契約の全月の予算一覧 */
export function budgetSchedule(contract: Contract): Array<{ month: YearMonth } & MonthlyBudget> {
  return monthRange(contract.startMonth, contract.endMonth).map((month) => ({ month, ...monthlyBudget(contract, month) }));
}

/** 契約が計算対象として妥当でない理由（妥当なら null） */
export function contractInvalidReason(contract: Contract): string | null {
  if (!isValidYearMonth(contract.startMonth)) return `開始月の形式が不正です: ${contract.startMonth}`;
  if (!isValidYearMonth(contract.endMonth)) return `終了月の形式が不正です: ${contract.endMonth}`;
  if (contract.startMonth > contract.endMonth) return `開始月 ${contract.startMonth} が終了月 ${contract.endMonth} より後です`;
  if (typeof contract.totalAmount !== "number" || !Number.isFinite(contract.totalAmount)) return "契約総額が数値ではありません";
  if (contract.totalAmount < 0) return `契約総額が負です: ${contract.totalAmount}`;
  if (!Number.isInteger(contract.totalAmount)) return `契約総額が整数ではありません: ${contract.totalAmount}`;
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
        message: `契約ID ${contract.contractId} が重複しています。最初の行のみ採用します`,
        ref: { contractId: contract.contractId },
      });
      excluded.push({ contract, reason: "契約IDの重複" });
      continue;
    }
    seen.add(contract.contractId);
    const reason = contractInvalidReason(contract);
    if (reason !== null) {
      warnings.push({
        code: "CONTRACT_INVALID",
        message: `契約 ${contract.contractId} を計算から除外しました: ${reason}`,
        ref: { contractId: contract.contractId },
      });
      excluded.push({ contract, reason });
      continue;
    }
    valid.push(contract);
  }
  return { valid, excluded, warnings };
}
