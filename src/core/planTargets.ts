/**
 * リソース計画の目標の警告（SPEC §110）— 今の計画（編集中なら編集後）のままだと目標（§63）を下回る見込みの目標を出す
 *
 *   対象の目標 = 終了月が基準月以降（見込みで判定するもの）で、選んだ組織に関わるもの
 *                全組織 → すべて / チーム → そのチームと配下のチームの目標、担当案件（配下込み）を含む顧客・案件の目標
 *   判定       = evaluateTarget を計画値（assignment）で。状況が未達見込み（atRisk）のものだけ
 *   超える月   = 目標の期間のうち基準月以降で、その月の計画の実績見込み > その月の予算 ×（1 − 目標の残予算率）の月
 *                （月次推移の「目標の上限」§63.3 と同じ目安）
 *
 * 方式は計画値に固定（他の方式は計画を使わないので、計画を変えても判定が動かない）。DOM にも fetch にも依存しない。
 */
import { assignmentPlanOf } from "./forecast.js";
import { monthRange } from "./calendar.js";
import type { PlanInputs } from "./planImpact.js";
import { evaluateTarget, isUsableTarget, targetContractIds, targetStartMonth, type TargetEvaluation } from "./targets.js";
import type { Assignment, AssignmentPlan, ContractResult, Model, TargetKind, TeamNode, YearMonth } from "./types.js";

export interface PlanTargetAlert {
  kind: TargetKind;
  evaluation: TargetEvaluation;
  /** 目安の上限を超える月（基準月以降、昇順） */
  overMonths: YearMonth[];
}

export interface PlanTargetScope {
  /** 選んだ組織（null = 全組織） */
  teamId: string | null;
  /** 組織の木（リソース計画の画面の木。省略時は model.teamTree） */
  tree?: Record<string, TeamNode>;
}

const EPS = 1e-6;

/**
 * 警告する目標（終了月の順）。after を渡すと、その計画（編集後のマスタ）で計算する。null なら model の計画のまま
 */
export function planTargetAlerts(model: Model, after: PlanInputs | null, scope: PlanTargetScope): PlanTargetAlert[] {
  const asOf = model.meta.asOfMonth;
  const fy = model.config.fiscalYearStartMonth;
  const tree = scope.tree ?? model.teamTree;
  const unitTeams = scope.teamId === null ? null : new Set(tree[scope.teamId]?.descendantIds ?? [scope.teamId]);
  const unitContracts =
    unitTeams === null ? null : new Set(model.contracts.filter((r) => r.contract.teamId !== null && unitTeams.has(r.contract.teamId)).map((r) => r.contract.contractId));

  const candidates: { kind: TargetKind; target: (typeof model.targets)[number]; ids: string[] }[] = [];
  for (const t of model.targets ?? []) {
    if (!isUsableTarget(t, fy) || t.endMonth < asOf) continue;
    const kind = t.kind as TargetKind;
    const ids = targetContractIds(model, kind, t.targetId);
    if (unitTeams !== null && unitContracts !== null) {
      const related = kind === "team" ? unitTeams.has(t.targetId.trim()) : ids.some((id) => unitContracts.has(id));
      if (!related) continue;
    }
    candidates.push({ kind, target: t, ids });
  }
  if (candidates.length === 0) return [];

  // 編集後の計画: 候補の目標に入る案件だけ作り直す
  let m: Model = model;
  if (after) {
    const need = new Set(candidates.flatMap((c) => c.ids));
    const byContract = new Map<string, Assignment[]>();
    for (const a of after.assignments) {
      if (!need.has(a.contractId)) continue;
      const arr = byContract.get(a.contractId);
      if (arr) arr.push(a);
      else byContract.set(a.contractId, [a]);
    }
    const ctx = (list: Assignment[]) => ({ asOfMonth: asOf, config: model.config, masters: after.masters, assignments: list });
    m = {
      ...model,
      contracts: model.contracts.map((r): ContractResult =>
        need.has(r.contract.contractId) ? { ...r, assignmentPlan: assignmentPlanOf(ctx(byContract.get(r.contract.contractId) ?? []), r.contract) } : r,
      ),
    };
  }
  const byId = new Map(m.contracts.map((r) => [r.contract.contractId, r]));
  /** 案件の月ごとの計画の額（基準月以降） */
  const planByMonth = new Map<string, Map<YearMonth, number>>();
  const planOf = (r: ContractResult): Map<YearMonth, number> => {
    let x = planByMonth.get(r.contract.contractId);
    if (x) return x;
    x = new Map();
    const plan: AssignmentPlan = r.assignmentPlan;
    if (plan.hasAssignments) for (const l of plan.lines) if (l.month >= asOf) x.set(l.month, (x.get(l.month) ?? 0) + l.amount);
    planByMonth.set(r.contract.contractId, x);
    return x;
  };

  const alerts: PlanTargetAlert[] = [];
  for (const c of candidates) {
    const ev = evaluateTarget(m, c.target, "assignment");
    if (ev.status !== "atRisk") continue;
    const from = targetStartMonth(c.target, fy);
    const months = monthRange(from < asOf ? asOf : from, c.target.endMonth);
    const overMonths = months.filter((month) => {
      let budget = 0;
      let cost = 0;
      for (const id of ev.contractIds) {
        const r = byId.get(id);
        if (!r || month < r.contract.startMonth || month > r.contract.endMonth) continue;
        budget += r.months.find((x) => x.month === month)?.budget ?? 0;
        cost += planOf(r).get(month) ?? 0;
      }
      return cost > budget * (1 - c.target.remainingRate) + EPS;
    });
    alerts.push({ kind: c.kind, evaluation: ev, overMonths });
  }
  return alerts.sort((a, b) => (a.evaluation.target.endMonth < b.evaluation.target.endMonth ? -1 : a.evaluation.target.endMonth > b.evaluation.target.endMonth ? 1 : 0));
}
