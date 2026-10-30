/**
 * リソース計画の変更の影響（SPEC §65）— 保存する前に、着地見込み（計画値）・残予算・目標がどう変わるか
 *
 * 前 = 編集前のマスタ、後 = 編集後のマスタで、それぞれリソース計画の明細（assignmentPlanOf）を作り直して比べる。
 * 実績・予算は変わらないので、変わるのは残り月の計画値だけ。方式は計画値（assignment）に固定（他の方式は計画を使わない）。
 */
import { assignmentPlanOf, forecastForMonths, type ForecastBasis } from "./forecast.js";
import { monthRange } from "./calendar.js";
import type { MasterIndex } from "./masters.js";
import { evaluateTarget, isUsableTarget, targetContractIds, type TargetEvaluation } from "./targets.js";
import type { Assignment, AssignmentPlan, ContractResult, Forecast, Model, TargetKind, YearMonth } from "./types.js";

/** 計画の明細を作る材料（マスタの索引とアサイン） */
export interface PlanInputs {
  masters: MasterIndex;
  assignments: readonly Assignment[];
}

export interface PlanImpactRow {
  contractId: string;
  customerName: string;
  projectName: string;
  /** 対象の月（期間）の着地見込み（計画値） */
  before: Forecast;
  after: Forecast;
  /** 案件終了時点の着地見込み（契約の全期間） */
  endBefore: Forecast;
  endAfter: Forecast;
}

export interface PlanImpactTarget {
  kind: TargetKind;
  before: TargetEvaluation;
  after: TargetEvaluation;
}

export interface PlanImpact {
  /** 対象の月 */
  targetMonths: YearMonth[];
  /** 計画の明細が変わった案件（期間・終了時点のどちらかの着地が変わったもの）。着地の増減の大きい順 */
  rows: PlanImpactRow[];
  /** 残予算率が変わる目標（終了月の順） */
  targets: PlanImpactTarget[];
}

const EPS = 1e-9;

/**
 * 変更の影響を計算する。targetMonths は画面の期間（§54）。
 * model の数値はそのまま使い、変わった案件だけ前後の計画で置き換えて比べる（前の値は画面の値と同じ）
 */
export function planImpact(model: Model, before: PlanInputs, after: PlanInputs, targetMonths: readonly YearMonth[]): PlanImpact {
  const ctx = (inputs: PlanInputs, assignments: readonly Assignment[]) => ({ asOfMonth: model.meta.asOfMonth, config: model.config, masters: inputs.masters, assignments });
  const byContract = (list: readonly Assignment[]) => {
    const m = new Map<string, Assignment[]>();
    for (const a of list) {
      const arr = m.get(a.contractId);
      if (arr) arr.push(a);
      else m.set(a.contractId, [a]);
    }
    return m;
  };
  const aBefore = byContract(before.assignments);
  const aAfter = byContract(after.assignments);
  const basis: ForecastBasis = { asOfMonth: model.meta.asOfMonth, fiscalYear: model.meta.fiscalYear, forecastRecentMonths: model.config.forecastRecentMonths };

  const plansBefore = new Map<string, AssignmentPlan>();
  const plansAfter = new Map<string, AssignmentPlan>();
  const rows: PlanImpactRow[] = [];
  for (const r of model.contracts) {
    const id = r.contract.contractId;
    const pb = assignmentPlanOf(ctx(before, aBefore.get(id) ?? []), r.contract);
    const pa = assignmentPlanOf(ctx(after, aAfter.get(id) ?? []), r.contract);
    if (samePlan(pb, pa)) continue;
    plansBefore.set(id, pb);
    plansAfter.set(id, pa);
    const f = (plan: AssignmentPlan, months: readonly YearMonth[]) => forecastForMonths(basis, r.contract, r.months, plan, "assignment", months);
    const all = monthRange(r.contract.startMonth, r.contract.endMonth);
    const row: PlanImpactRow = {
      contractId: id,
      customerName: r.contract.customerName,
      projectName: r.contract.projectName,
      before: f(pb, targetMonths),
      after: f(pa, targetMonths),
      endBefore: f(pb, all),
      endAfter: f(pa, all),
    };
    if (Math.abs(row.after.forecastCost - row.before.forecastCost) < EPS && Math.abs(row.endAfter.forecastCost - row.endBefore.forecastCost) < EPS) continue;
    rows.push(row);
  }
  const delta = (r: PlanImpactRow) => Math.abs(r.after.forecastCost - r.before.forecastCost);
  const endDelta = (r: PlanImpactRow) => Math.abs(r.endAfter.forecastCost - r.endBefore.forecastCost);
  rows.sort((a, b) => delta(b) - delta(a) || endDelta(b) - endDelta(a) || (a.contractId < b.contractId ? -1 : a.contractId > b.contractId ? 1 : 0));

  // 目標: 変わった案件を含む目標だけ評価し直す
  const targets: PlanImpactTarget[] = [];
  if (plansAfter.size > 0) {
    const withPlans = (plans: Map<string, AssignmentPlan>): Model => ({
      ...model,
      contracts: model.contracts.map((r): ContractResult => (plans.has(r.contract.contractId) ? { ...r, assignmentPlan: plans.get(r.contract.contractId)! } : r)),
    });
    const mBefore = withPlans(plansBefore);
    const mAfter = withPlans(plansAfter);
    const usable = (model.targets ?? []).filter((t) => isUsableTarget(t, model.config.fiscalYearStartMonth)).sort((a, b) => (a.endMonth < b.endMonth ? -1 : a.endMonth > b.endMonth ? 1 : 0));
    for (const t of usable) {
      const kind = t.kind as TargetKind;
      if (t.endMonth < model.meta.asOfMonth) continue;
      if (!targetContractIds(model, kind, t.targetId).some((id) => plansAfter.has(id))) continue;
      const b = evaluateTarget(mBefore, t, "assignment");
      const a = evaluateTarget(mAfter, t, "assignment");
      if (Math.abs(a.forecastCost - b.forecastCost) < EPS) continue;
      targets.push({ kind, before: b, after: a });
    }
  }
  return { targetMonths: [...targetMonths], rows, targets };
}

function samePlan(a: AssignmentPlan, b: AssignmentPlan): boolean {
  if (a.hasAssignments !== b.hasAssignments || a.lines.length !== b.lines.length) return false;
  const key = (p: AssignmentPlan) => {
    const m = new Map<YearMonth, number>();
    for (const l of p.lines) m.set(l.month, (m.get(l.month) ?? 0) + l.amount);
    return m;
  };
  const ka = key(a);
  const kb = key(b);
  if (ka.size !== kb.size) return false;
  for (const [month, v] of ka) {
    const w = kb.get(month);
    if (w === undefined || Math.abs(w - v) >= EPS) return false;
  }
  return true;
}
