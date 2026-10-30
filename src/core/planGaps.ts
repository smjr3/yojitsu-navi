/**
 * 計画と実績のずれ（SPEC §64）
 *
 * メンバー × 案件（運用保守以外は種別）ごとに、確定した月だけで計画時間と実績時間を比べ、
 * アサイン漏れ・古いままの計画・大きなずれを拾う。計算は aggregateMembers（§18.1）の合計をそのまま使う。
 * 速報の月は実績が途中なので判定に入れない（「実績なし」「少ない」が誤って出るため）。
 */
import { aggregateMembers } from "./members.js";
import type { Model, Period, YearMonth } from "./types.js";

/** unplanned = 計画なしで実績あり、noActual = 計画ありで実績なし、over / under = 計画より多い / 少ない */
export type PlanGapKind = "unplanned" | "noActual" | "over" | "under";

/** ずれとみなす比率（|実績 ÷ 計画 − 1| がこれ以上） */
export const PLAN_GAP_RATIO = 0.3;
/** ずれとみなす最小の時間差（0.1 人月 = 16 時間。小さな応援・端数は拾わない） */
export const PLAN_GAP_MIN_HOURS = 16;

export interface PlanGapRow {
  memberId: string;
  memberName: string;
  memberUnknown: boolean;
  teamId: string | null;
  title: string | null;
  contractId: string;
  /** 運用保守以外の行だけ: 種別（§50.3） */
  outsideType?: string;
  kind: PlanGapKind;
  plannedHours: number;
  actualHours: number;
  /** 実績時間 − 計画時間（正 = 計画より多い） */
  diffHours: number;
  /** 実績時間 ÷ 計画時間（計画 0 → null） */
  utilization: number | null;
}

export interface PlanGapScope {
  period: Period;
  memberIds?: readonly string[];
  includeOutside?: boolean;
  ratio?: number;
  minHours?: number;
}

export interface PlanGapResult {
  /** 判定に使った期間（選んだ期間のうち確定した月）。確定した月が無ければ null */
  judgedPeriod: Period | null;
  /** |diffHours| の大きい順（同じなら社員番号・案件 ID 順） */
  rows: PlanGapRow[];
}

/** 選んだ期間のうち確定した月（meta.lastFinalMonth まで）。無ければ null */
export function confirmedPeriodOf(meta: Pick<Model["meta"], "lastFinalMonth">, period: Period): Period | null {
  const to: YearMonth = period.to < meta.lastFinalMonth ? period.to : meta.lastFinalMonth;
  return period.from <= to ? { from: period.from, to } : null;
}

/** ずれの種類。ずれていなければ null */
export function planGapKindOf(plannedHours: number, actualHours: number, ratio = PLAN_GAP_RATIO, minHours = PLAN_GAP_MIN_HOURS): PlanGapKind | null {
  const diff = actualHours - plannedHours;
  if (Math.abs(diff) < minHours) return null;
  if (plannedHours <= 0) return actualHours > 0 ? "unplanned" : null;
  if (actualHours <= 0) return "noActual";
  if (Math.abs(actualHours / plannedHours - 1) < ratio) return null;
  return diff > 0 ? "over" : "under";
}

export function planGaps(model: Pick<Model, "meta" | "members" | "memberMonths">, scope: PlanGapScope): PlanGapResult {
  const judgedPeriod = confirmedPeriodOf(model.meta, scope.period);
  if (!judgedPeriod) return { judgedPeriod, rows: [] };
  const agg = aggregateMembers(model, { period: judgedPeriod, ...(scope.memberIds ? { memberIds: scope.memberIds } : {}), includeOutside: scope.includeOutside === true });
  const rows: PlanGapRow[] = [];
  for (const m of agg.members) {
    for (const c of m.byContract) {
      const kind = planGapKindOf(c.plannedHours, c.actualHours, scope.ratio ?? PLAN_GAP_RATIO, scope.minHours ?? PLAN_GAP_MIN_HOURS);
      if (!kind) continue;
      rows.push({
        memberId: m.memberId,
        memberName: m.memberName,
        memberUnknown: m.memberUnknown,
        teamId: m.teamId,
        title: m.title,
        contractId: c.contractId,
        ...(c.outsideType !== undefined ? { outsideType: c.outsideType } : {}),
        kind,
        plannedHours: c.plannedHours,
        actualHours: c.actualHours,
        diffHours: c.actualHours - c.plannedHours,
        utilization: c.utilization,
      });
    }
  }
  rows.sort((a, b) => Math.abs(b.diffHours) - Math.abs(a.diffHours) || (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : a.contractId < b.contractId ? -1 : a.contractId > b.contractId ? 1 : 0));
  return { judgedPeriod, rows };
}
