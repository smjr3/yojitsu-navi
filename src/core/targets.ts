/**
 * 目標（SPEC §63）: チーム・顧客・案件ごとに「終了月までに残予算率 ◯% 以上」を置き、達成状況を出す。
 *
 *   期間     = 開始月（空なら終了月を含む年度の最初の月）〜終了月
 *   残予算率 = (Σ予算 − Σ着地) ÷ Σ予算   … 期間内の案件の月の合計。着地 = 実績 ＋ 終了月までの見込み（§10 と同じ方式）
 *   判定     = 終了月 < 基準月 → 確定（達成 / 未達）、それ以外 → 見込み（達成見込み / 未達見込み）
 *
 * 対象の案件: チーム = 基準月の組織で配下を含む担当案件、顧客 = 顧客名が同じ（§4.1 の正規化）案件、案件 = 契約ID の 1 件。
 * DOM にも fetch にも依存しない。
 */
import { contractsForTeam } from "./aggregate.js";
import { fiscalYearOf, formatYearMonth, isValidYearMonth, monthRange } from "./calendar.js";
import { customerKey } from "./customers.js";
import { forecastForMonths } from "./forecast.js";
import type { ForecastMethod, Model, Target, TargetKind, TeamNode, YearMonth } from "./types.js";

export const TARGET_KINDS: readonly TargetKind[] = ["team", "customer", "project"];

export function isTargetKind(v: string): v is TargetKind {
  return (TARGET_KINDS as readonly string[]).includes(v);
}

/** 期間の開始月（空なら終了月を含む年度の最初の月） */
export function targetStartMonth(t: Pick<Target, "startMonth" | "endMonth">, fiscalYearStartMonth: number): YearMonth {
  const s = t.startMonth.trim();
  if (s !== "") return s;
  return formatYearMonth(fiscalYearOf(t.endMonth, fiscalYearStartMonth), fiscalYearStartMonth);
}

/** 計算できる目標か（種別・終了月・開始月・率が正しい）。検証エラーの行は画面に出さない */
export function isUsableTarget(t: Target, fiscalYearStartMonth: number): boolean {
  if (!isTargetKind(t.kind) || t.targetId.trim() === "" || !isValidYearMonth(t.endMonth)) return false;
  if (t.startMonth.trim() !== "" && !isValidYearMonth(t.startMonth.trim())) return false;
  if (targetStartMonth(t, fiscalYearStartMonth) > t.endMonth) return false;
  return Number.isFinite(t.remainingRate) && t.remainingRate <= 1;
}

/** 対象が同じか（顧客は顧客名の正規化で比べる） */
export function sameTargetId(kind: TargetKind, a: string, b: string): boolean {
  if (kind === "customer") return customerKey(a) === customerKey(b);
  return a.trim() === b.trim();
}

/** 対象の案件（契約ID） */
export function targetContractIds(model: Model, kind: TargetKind, targetId: string, tree: Record<string, TeamNode> = model.teamTree): string[] {
  const id = targetId.trim();
  if (kind === "team") return contractsForTeam(model, id, tree).map((c) => c.contractId);
  if (kind === "customer") return model.contracts.filter((r) => sameTargetId("customer", r.contract.customerName, id)).map((r) => r.contract.contractId);
  return model.contracts.some((r) => r.contract.contractId === id) ? [id] : [];
}

export type TargetStatus = "achieved" | "missed" | "onTrack" | "atRisk" | "noBudget";

export interface TargetEvaluation {
  target: Target;
  /** 期間（両端含む） */
  period: { from: YearMonth; to: YearMonth };
  /** 対象の案件のうち、期間に掛かるもの */
  contractIds: string[];
  /** 期間内の予算の合計（円） */
  budget: number;
  /** 期間内の実績（基準月より前の月） */
  actualCost: number;
  /** 着地 = 実績 ＋ 終了月までの見込み（終了月が過ぎていれば実績だけ） */
  forecastCost: number;
  /** 残予算率（予算 0 → null） */
  rate: number | null;
  /** 終了月が基準月より前（実績で確定） */
  settled: boolean;
  /** 目標との差（rate − 目標。rate が null なら null） */
  gap: number | null;
  status: TargetStatus;
}

const EPS = 1e-9;

/** 目標 1 件を評価する（method = 着地見込みの方式） */
export function evaluateTarget(model: Model, target: Target, method: ForecastMethod, tree: Record<string, TeamNode> = model.teamTree): TargetEvaluation {
  const kind = target.kind as TargetKind;
  const from = targetStartMonth(target, model.config.fiscalYearStartMonth);
  const to = target.endMonth;
  const months = from <= to ? monthRange(from, to) : [];
  const ids = new Set(targetContractIds(model, kind, target.targetId, tree));
  // 期間に 1 か月でも掛かる案件だけ（根拠に出す）
  const contractIds: string[] = [];
  const basis = { asOfMonth: model.meta.asOfMonth, fiscalYear: model.meta.fiscalYear, forecastRecentMonths: model.config.forecastRecentMonths };
  let budget = 0;
  let actualCost = 0;
  let forecastCost = 0;
  for (const r of model.contracts) {
    if (!ids.has(r.contract.contractId)) continue;
    const f = forecastForMonths(basis, r.contract, r.months, r.assignmentPlan, method, months);
    if (f.breakdown.contractMonthsInTarget.length === 0) continue;
    contractIds.push(r.contract.contractId);
    budget += f.targetBudget;
    actualCost += f.breakdown.actualCost;
    forecastCost += f.forecastCost;
  }
  const rate = budget > 0 ? (budget - forecastCost) / budget : null;
  const settled = to < model.meta.asOfMonth;
  const gap = rate === null ? null : rate - target.remainingRate;
  const ok = gap !== null && gap >= -EPS;
  const status: TargetStatus = rate === null ? "noBudget" : settled ? (ok ? "achieved" : "missed") : ok ? "onTrack" : "atRisk";
  return { target, period: { from, to }, contractIds, budget, actualCost, forecastCost, rate, settled, gap, status };
}

/** 対象の目標（計算できるものだけ、終了月の順） */
export function targetsOf(model: Model, kind: TargetKind, targetId: string): Target[] {
  return (model.targets ?? [])
    .filter((t) => t.kind === kind && sameTargetId(kind, t.targetId, targetId) && isUsableTarget(t, model.config.fiscalYearStartMonth))
    .sort((a, b) => (a.endMonth < b.endMonth ? -1 : a.endMonth > b.endMonth ? 1 : 0));
}

/**
 * 一覧に出す 1 件: 基準月以降で最も近い終了月の目標。無ければ最も新しい（過ぎた）目標。目標が無ければ null
 */
export function headlineTarget(targets: readonly Target[], asOfMonth: YearMonth): Target | null {
  if (targets.length === 0) return null;
  const sorted = [...targets].sort((a, b) => (a.endMonth < b.endMonth ? -1 : a.endMonth > b.endMonth ? 1 : 0));
  return sorted.find((t) => t.endMonth >= asOfMonth) ?? (sorted[sorted.length - 1] as Target);
}

