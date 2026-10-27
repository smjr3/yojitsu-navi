/**
 * 月次原価（SPEC §7）
 *
 * 原価の種類ごとに「プロバイダ」を用意し、契約・月ごとに CostLine[] を返す。
 * 当面は labor（作業実績 × 単価）のみ。将来の外注費などは CostProvider を追加する。
 */
import { memberAt, rateFor, type MasterIndex } from "./masters.js";
import type { CostLine, CostTypeId, Worklog, WorklogEntry, YearMonth } from "./types.js";

export interface CostProviderResult {
  lines: CostLine[];
  /** この原価に対応する元の作業ログ（labor 以外は空でよい） */
  worklogs: WorklogEntry[];
}

/** 原価の種類ごとの計算器。契約・月を受け取り原価行を返す純粋関数 */
export interface CostProvider {
  costType: CostTypeId;
  compute(contractId: string, month: YearMonth): CostProviderResult;
}

export interface MonthCost {
  costs: Record<CostTypeId, number>;
  cost: number;
  hours: number;
  costLines: CostLine[];
  worklogs: WorklogEntry[];
}

/** 契約・月をキーにした作業ログの索引 */
export type WorklogIndex = ReadonlyMap<string, readonly Worklog[]>;

export function worklogIndexKey(contractId: string, month: YearMonth): string {
  return `${contractId}\u0000${month}`;
}

/** 紐付け済み作業ログを (契約, 月) で索引化する（入力順を保つ） */
export function indexWorklogs(
  assigned: ReadonlyArray<{ worklog: Worklog; month: YearMonth; contractId: string }>,
): WorklogIndex {
  const index = new Map<string, Worklog[]>();
  for (const a of assigned) {
    const key = worklogIndexKey(a.contractId, a.month);
    const list = index.get(key);
    if (list) list.push(a.worklog);
    else index.set(key, [a.worklog]);
  }
  return index;
}

/** 円に丸める（Math.round） */
export function roundYen(amount: number): number {
  return Math.round(amount);
}

/**
 * labor 原価: 作業ログをメンバーでまとめ、hours × 当月単価 を円に丸める。
 * メンバー名は当月のマスタ名を優先し、無ければ作業ログの名前。
 */
export function createLaborProvider(
  masters: MasterIndex,
  worklogs: WorklogIndex,
  costType: CostTypeId = "labor",
): CostProvider {
  return {
    costType,
    compute(contractId, month) {
      const logs = worklogs.get(worklogIndexKey(contractId, month)) ?? [];
      const byMember = new Map<string, { hours: number; memberName: string }>();
      const entries: WorklogEntry[] = [];
      const rateCache = new Map<string, ReturnType<typeof rateFor>>();
      for (const w of logs) {
        let rate = rateCache.get(w.memberId);
        if (!rate) {
          rate = rateFor(masters, w.memberId, month);
          rateCache.set(w.memberId, rate);
        }
        entries.push({ ...w, contractId, hourlyRate: rate.hourlyRate, amount: roundYen(w.hours * rate.hourlyRate) });
        const acc = byMember.get(w.memberId);
        if (acc) acc.hours += w.hours;
        else byMember.set(w.memberId, { hours: w.hours, memberName: w.memberName });
      }
      const lines: CostLine[] = [];
      for (const [memberId, acc] of byMember) {
        const rate = rateCache.get(memberId) as ReturnType<typeof rateFor>;
        const member = memberAt(masters, memberId, month);
        lines.push({
          costType,
          memberId,
          memberName: member?.name ?? acc.memberName,
          hours: acc.hours,
          hourlyRate: rate.hourlyRate,
          rateSource: rate.rateSource,
          rateMissing: rate.rateMissing,
          amount: roundYen(acc.hours * rate.hourlyRate),
          // 空文字のチームIDは「非所属」= null に揃える（CSV 以外の入力でも null になる）
          memberTeamId: member?.teamId ? member.teamId : null,
        });
      }
      return { lines, worklogs: entries };
    },
  };
}

/**
 * 契約・月の原価をプロバイダ横断で合計する。
 * costs は config.costTypes の全IDをキーに持ち、プロバイダの無い種類は 0。
 */
export function computeMonthCost(
  providers: readonly CostProvider[],
  costTypeIds: readonly CostTypeId[],
  contractId: string,
  month: YearMonth,
): MonthCost {
  const costs: Record<CostTypeId, number> = {};
  for (const id of costTypeIds) costs[id] = 0;
  const costLines: CostLine[] = [];
  const worklogs: WorklogEntry[] = [];
  let hours = 0;
  for (const provider of providers) {
    const result = provider.compute(contractId, month);
    let subtotal = 0;
    for (const line of result.lines) {
      subtotal += line.amount;
      hours += line.hours;
    }
    costs[provider.costType] = (costs[provider.costType] ?? 0) + subtotal;
    costLines.push(...result.lines);
    worklogs.push(...result.worklogs);
  }
  let cost = 0;
  for (const id of Object.keys(costs)) cost += costs[id] ?? 0;
  return { costs, cost, hours, costLines, worklogs };
}
