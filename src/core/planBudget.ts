/**
 * リソース計画の金額と目標の上限（SPEC §122）— 計画を入れるときに、目標（§63）を超えないかを金額で見る
 *
 *   案件の目標   = その月を期間に含む目標のうち、いちばん細かいもの（案件 → 顧客 → チーム（担当チームから上位へ））
 *                  同じ対象に複数あれば期間の最も短いもの（targetForMonth。月ごとの目標があれば年度の目標より優先）
 *   案件の上限   = その月の予算 ×（1 − 目標の残予算率）（§63.3 のグラフの「目標の上限」と同じ目安）。目標が無ければ上限なし
 *   計画の額     = リソース計画の明細（assignmentPlanOf）の額。表示する月すべて（基準月より前の月も計画で数える。人月のグラフ §58 と同じ）
 *   余力         = 上限 − 計画の額（マイナス = 上限を超えている）
 *   組織の上限   = 組織の担当案件（配下込み）の上限の合計。目標の無い案件は予算で数える。どの案件にも目標が無い月は上限なし
 *
 * DOM にも fetch にも依存しない。
 */
import { assignmentPlanOf } from "./forecast.js";
import { customerKey } from "./customers.js";
import { holidaysOfInputs, monthHoursOfInputs, type PlanInputs } from "./planImpact.js";
import { targetForMonth } from "./targets.js";
import type { Assignment, ContractResult, Model, Target, TargetKind, TeamNode, YearMonth } from "./types.js";

export interface ContractCap {
  /** その月の予算（契約期間外は 0） */
  budget: number;
  /** 目標の上限（目標が無ければ null） */
  cap: number | null;
  /** 使った目標（無ければ null） */
  target: Target | null;
  kind: TargetKind | null;
}

/** 案件のその月の目標と上限 */
export function contractCapAt(model: Model, r: ContractResult, month: YearMonth, tree: Record<string, TeamNode> = model.teamTree): ContractCap {
  const c = r.contract;
  const budget = month < c.startMonth || month > c.endMonth ? 0 : (r.months.find((x) => x.month === month)?.budget ?? 0);
  let target: Target | null = targetForMonth(model, "project", c.contractId, month);
  let kind: TargetKind | null = target ? "project" : null;
  if (!target && c.customerName.trim() !== "") {
    target = targetForMonth(model, "customer", c.customerName, month);
    if (target) kind = "customer";
  }
  if (!target) {
    // 担当チームから上位の組織へ（チームの目標は配下の案件も対象。§63）
    const seen = new Set<string>();
    let tid: string | null | undefined = c.teamId;
    while (tid && !seen.has(tid)) {
      seen.add(tid);
      target = targetForMonth(model, "team", tid, month);
      if (target) {
        kind = "team";
        break;
      }
      tid = (tree[tid] ?? model.teamTree[tid])?.parentTeamId;
    }
  }
  return { budget, cap: target ? budget * (1 - target.remainingRate) : null, target: target ?? null, kind };
}

/** 案件ごとの月の計画の額（months のうち契約期間内の月）。inputs = 今の計画（編集中は編集後） */
export function contractPlanAmounts(model: Model, inputs: PlanInputs, contractIds: ReadonlySet<string>, months: readonly YearMonth[]): Map<string, Map<YearMonth, number>> {
  const out = new Map<string, Map<YearMonth, number>>();
  if (months.length === 0) return out;
  const want = new Set(months);
  const byContract = new Map<string, Assignment[]>();
  for (const a of inputs.assignments) {
    if (!contractIds.has(a.contractId)) continue;
    const arr = byContract.get(a.contractId);
    if (arr) arr.push(a);
    else byContract.set(a.contractId, [a]);
  }
  const monthHours = monthHoursOfInputs(model, inputs);
  // 月の途中から・途中までのアサインは端の月を営業日で日割り（§123）
  const holidays = holidaysOfInputs(model, inputs);
  // 基準月より前の月も計画で数える（表示する月の最初から）
  const from = months.reduce((a, b) => (a < b ? a : b));
  for (const r of model.contracts) {
    const id = r.contract.contractId;
    const list = byContract.get(id);
    if (!list) continue;
    const plan = assignmentPlanOf({ asOfMonth: from, config: model.config, masters: inputs.masters, assignments: list, monthHours, holidays }, r.contract);
    const x = new Map<YearMonth, number>();
    for (const l of plan.lines) if (want.has(l.month)) x.set(l.month, (x.get(l.month) ?? 0) + l.amount);
    out.set(id, x);
  }
  return out;
}

export interface PlanRoom extends ContractCap {
  /** 今の計画の額 */
  plan: number;
  /** 上限 − 計画の額（上限なしなら null） */
  room: number | null;
}

/** 案件のその月の余力（入力欄に出す。§122） */
export function planRoomAt(model: Model, inputs: PlanInputs, contractId: string, month: YearMonth, tree: Record<string, TeamNode> = model.teamTree): PlanRoom | null {
  const r = model.contracts.find((x) => x.contract.contractId === contractId);
  if (!r) return null;
  const cap = contractCapAt(model, r, month, tree);
  const plan = contractPlanAmounts(model, inputs, new Set([contractId]), [month]).get(contractId)?.get(month) ?? 0;
  return { ...cap, plan, room: cap.cap === null ? null : cap.cap - plan };
}

export interface PlanBudgetMonth {
  month: YearMonth;
  /** 担当案件の予算の合計 */
  budget: number;
  /** 組織の上限（どの案件にも目標が無ければ null） */
  cap: number | null;
  /** 計画の額の合計 */
  plan: number;
  /** 顧客ごとの計画の額（customers と同じ並び） */
  byCustomer: number[];
}

export interface PlanBudgetChart {
  /** 顧客（計画の額の多い順）。name は最初に見つかった顧客名 */
  customers: { key: string; name: string; total: number }[];
  months: PlanBudgetMonth[];
}

/**
 * 組織の担当案件（teamId = null なら全案件）の月ごとの計画の額（顧客ごと）・予算・上限。リソース計画のグラフ「金額」（§122）
 */
export function planBudgetChart(model: Model, inputs: PlanInputs, scope: { teamId: string | null; tree?: Record<string, TeamNode> }, months: readonly YearMonth[]): PlanBudgetChart {
  const tree = scope.tree ?? model.teamTree;
  const units = scope.teamId === null ? null : new Set(tree[scope.teamId]?.descendantIds ?? [scope.teamId]);
  const rows = model.contracts.filter((r) => units === null || (r.contract.teamId !== null && units.has(r.contract.teamId)));
  const amounts = contractPlanAmounts(model, inputs, new Set(rows.map((r) => r.contract.contractId)), months);
  const customers = new Map<string, { key: string; name: string; total: number; byMonth: number[] }>();
  const out: PlanBudgetMonth[] = months.map((month) => ({ month, budget: 0, cap: null, plan: 0, byCustomer: [] }));
  const capSum = months.map(() => 0);
  const hasCap = months.map(() => false);
  for (const r of rows) {
    const a = amounts.get(r.contract.contractId);
    const key = customerKey(r.contract.customerName);
    months.forEach((month, i) => {
      const c = contractCapAt(model, r, month, tree);
      const o = out[i] as PlanBudgetMonth;
      o.budget += c.budget;
      capSum[i] = (capSum[i] ?? 0) + (c.cap ?? c.budget);
      if (c.cap !== null && c.budget > 0) hasCap[i] = true;
      const v = a?.get(month) ?? 0;
      if (v === 0) return;
      o.plan += v;
      let cu = customers.get(key);
      if (!cu) {
        cu = { key, name: r.contract.customerName.trim(), total: 0, byMonth: months.map(() => 0) };
        customers.set(key, cu);
      }
      cu.total += v;
      cu.byMonth[i] = (cu.byMonth[i] ?? 0) + v;
    });
  }
  const list = [...customers.values()].sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  out.forEach((o, i) => {
    o.cap = hasCap[i] ? (capSum[i] ?? 0) : null;
    o.byCustomer = list.map((c) => c.byMonth[i] ?? 0);
  });
  return { customers: list.map(({ key, name, total }) => ({ key, name, total })), months: out };
}
