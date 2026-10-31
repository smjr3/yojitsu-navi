/**
 * チーム詳細（SPEC §16）の計算: 組織の変遷、上位チームの経路、作業実績軸のメンバー別原価
 *
 * いずれも純粋関数。組織の変遷は model.teams（履歴）だけから求める。
 */
import { addMonths } from "./calendar.js";
import type { ContractResult, MemberRecord, Model, Period, TeamNode, TeamRecord, YearMonth } from "./types.js";

// ---------------------------------------------------------------------------
// 組織の変遷
// ---------------------------------------------------------------------------

export type TeamOrgChangeKind = "created" | "renamed" | "moved";
/** 見ているチームとの関係: self = そのチーム自身、in = そのチームの直下に入った、out = そのチームの直下から出た */
export type TeamOrgChangeRelation = "self" | "in" | "out";

export interface TeamOrgChange {
  /** 変更が発効した月 */
  month: YearMonth;
  /** 変更されたチーム */
  teamId: string;
  kind: TeamOrgChangeKind;
  relation: TeamOrgChangeRelation;
  /** 変更後の名前（改名の旧名は oldName。それ以外の oldName は変更前の名前） */
  name: string;
  oldName: string | null;
  /** 変更後・変更前の親（最上位 = null）。created は oldParentTeamId = null */
  parentTeamId: string | null;
  oldParentTeamId: string | null;
  parentName: string | null;
  oldParentName: string | null;
}

function normParent(p: string | null | undefined): string | null {
  return p === null || p === undefined || p === "" ? null : p;
}

/** teamId ごとの履歴（effectiveFrom 昇順。同じ月が複数あれば後ろの行を採用） */
function historyByTeam(teams: readonly TeamRecord[]): Map<string, TeamRecord[]> {
  const map = new Map<string, TeamRecord[]>();
  for (const rec of teams) {
    const list = map.get(rec.teamId) ?? [];
    const same = list.findIndex((r) => r.effectiveFrom === rec.effectiveFrom);
    if (same >= 0) list[same] = rec;
    else list.push(rec);
    map.set(rec.teamId, list);
  }
  for (const list of map.values()) list.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0));
  return map;
}

function nameAt(history: Map<string, TeamRecord[]>, teamId: string | null, month: YearMonth): string | null {
  if (teamId === null) return null;
  const list = history.get(teamId);
  if (!list) return teamId;
  let found: TeamRecord | undefined;
  for (const r of list) if (r.effectiveFrom <= month) found = r;
  return (found ?? list[0])!.name;
}

/**
 * 期間内（両端含む）に起きた、そのチームに関わる組織の変更を月順に列挙する。
 *  - そのチーム自身の改名・親の付け替え・新設
 *  - 他のチームがそのチームの直下に入った／出た（付け替え・新設）
 * 新設は「全チーム履歴の最も古い effectiveFrom より後」に初めて現れた場合だけ（最初の登録は変更として数えない）。
 * 名前も親も変わらない行（同じ内容の再登録）は変更ではない。
 */
export function teamOrgChanges(teams: readonly TeamRecord[], teamId: string, period: Period): TeamOrgChange[] {
  const history = historyByTeam(teams);
  let baseline: YearMonth | null = null;
  for (const rec of teams) if (baseline === null || rec.effectiveFrom < baseline) baseline = rec.effectiveFrom;
  const out: TeamOrgChange[] = [];
  for (const [id, list] of history) {
    list.forEach((rec, i) => {
      const month = rec.effectiveFrom;
      if (month < period.from || month > period.to) return;
      const prev = i > 0 ? list[i - 1]! : null;
      const parent = normParent(rec.parentTeamId);
      const prevParent = prev ? normParent(prev.parentTeamId) : null;
      const before = addMonths(month, -1);
      const base = { month, teamId: id, name: rec.name, parentTeamId: parent, parentName: nameAt(history, parent, month) };
      const relationOf = (newParent: string | null, oldParent: string | null): TeamOrgChangeRelation | null =>
        id === teamId ? "self" : newParent === teamId ? "in" : oldParent === teamId ? "out" : null;
      if (prev === null) {
        if (baseline === null || month <= baseline) return;
        const relation = relationOf(parent, null);
        if (relation) out.push({ ...base, kind: "created", relation, oldName: null, oldParentTeamId: null, oldParentName: null });
        return;
      }
      const oldParentName = nameAt(history, prevParent, before);
      if (prev.name !== rec.name && id === teamId) {
        out.push({ ...base, kind: "renamed", relation: "self", oldName: prev.name, oldParentTeamId: prevParent, oldParentName });
      }
      if (prevParent !== parent) {
        const relation = relationOf(parent, prevParent);
        if (relation) out.push({ ...base, kind: "moved", relation, oldName: prev.name, oldParentTeamId: prevParent, oldParentName });
      }
    });
  }
  const order: Record<TeamOrgChangeKind, number> = { created: 0, renamed: 1, moved: 2 };
  return out.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : order[a.kind] - order[b.kind]));
}

// ---------------------------------------------------------------------------
// 上位チームの経路
// ---------------------------------------------------------------------------

/** 最上位から自分までのチーム（パンくず用）。木に無ければ空。親リンクが循環していても止まる */
export function teamPath(tree: Record<string, TeamNode>, teamId: string): TeamNode[] {
  const path: TeamNode[] = [];
  const seen = new Set<string>();
  let cur: string | null = teamId;
  while (cur !== null && tree[cur] && !seen.has(cur)) {
    seen.add(cur);
    path.push(tree[cur]!);
    cur = tree[cur]!.parentTeamId;
  }
  return path.reverse();
}

// ---------------------------------------------------------------------------
// メンバー別原価（作業実績軸）
// ---------------------------------------------------------------------------

/**
 * 作業した人と案件の担当組織の関係（§72）
 * - own: 担当組織（配下・上位を含む）に所属
 * - support: 応援。管理対象の組織に所属しているが、担当組織の外
 * - help: ヘルプ。所属チームが無い（他部署）か、メンバーマスタに無い人
 */
export type WorkOrigin = "own" | "support" | "help";

/** 担当組織とみなすチームID: 自分・配下・上位（課長・部長が配下チームの案件をしても応援にしない）。木に無ければ空 */
export function ownTeamScope(tree: Record<string, TeamNode>, teamId: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!teamId || !tree[teamId]) return out;
  for (const id of tree[teamId]!.descendantIds) out.add(id);
  for (const n of teamPath(tree, teamId)) out.add(n.teamId);
  return out;
}

/** 原価行の所属チーム（当時）から応援・ヘルプを判定する。teamScope が null（担当組織なし）のときは応援を判定しない */
export function workOriginOf(memberTeamId: string | null, teamScope: ReadonlySet<string> | null): WorkOrigin {
  if (!memberTeamId) return "help";
  if (teamScope && teamScope.size > 0 && !teamScope.has(memberTeamId)) return "support";
  return "own";
}

export interface TeamMemberCost {
  memberId: string;
  memberName: string;
  hours: number;
  /** 原価（CostLine.amount の合計） */
  amount: number;
  /** 作業した月の数（月の種類数） */
  monthCount: number;
  /** 作業した契約 */
  contractIds: string[];
  /** 当時の所属チーム（CostLine.memberTeamId の種類。空は含めない） */
  teamIds: string[];
  rateMissing: boolean;
  /** 使った時間単価（重複なし・昇順） */
  rates: number[];
  /** 応援（所属が teamScope の外）の時間・原価。teamScope を渡さなければ 0 */
  supportHours: number;
  supportAmount: number;
  /** ヘルプ（所属チームなし・メンバーマスタに無い人）の時間・原価 */
  helpHours: number;
  helpAmount: number;
  /** メンバーマスタに無い（ヘルプのうち、単価が引けない人） */
  memberUnknown: boolean;
  /** 所属チームが無い月の部・課（当時。メンバーマスタの department・section） */
  orgLabels: string[];
  /** 全体に対する構成比（合計 0 のとき null） */
  share: number | null;
}

/**
 * 契約 contractIds の期間内の CostLine を、作業した人ごとに合算する。
 * 所属チームがどこでも含める（作業実績軸）。所属チームの無い人の作業は help* に数える。
 * teamScope（ownTeamScope の結果）を渡すと、所属がその外の作業を support* に数える（§72）。
 * 並びは原価の大きい順、同額は memberId 順。合計は同じ契約・期間の aggregate().cost（labor のみのとき）と一致する。
 */
export function teamMemberCosts(model: Model, contractIds: readonly string[], period: Period, teamScope: ReadonlySet<string> | null = null): TeamMemberCost[] {
  const set = new Set(contractIds);
  const acc = new Map<string, TeamMemberCost & { months: Set<YearMonth>; contracts: Set<string>; teams: Set<string>; rateSet: Set<number>; orgs: Set<string> }>();
  const known = new Set(model.members.map((m) => m.memberId));
  let total = 0;
  for (const r of model.contracts as ContractResult[]) {
    if (!set.has(r.contract.contractId)) continue;
    for (const cm of r.months) {
      if (cm.month < period.from || cm.month > period.to) continue;
      for (const l of cm.costLines) {
        let a = acc.get(l.memberId);
        if (!a) {
          a = { memberId: l.memberId, memberName: l.memberName, hours: 0, amount: 0, monthCount: 0, contractIds: [], teamIds: [], rateMissing: false, rates: [], supportHours: 0, supportAmount: 0, helpHours: 0, helpAmount: 0, memberUnknown: !known.has(l.memberId), orgLabels: [], share: null, months: new Set(), contracts: new Set(), teams: new Set(), rateSet: new Set(), orgs: new Set() };
          acc.set(l.memberId, a);
        }
        a.hours += l.hours;
        a.amount += l.amount;
        a.rateMissing ||= l.rateMissing;
        a.months.add(cm.month);
        a.contracts.add(r.contract.contractId);
        a.rateSet.add(l.hourlyRate);
        if (l.memberTeamId) a.teams.add(l.memberTeamId);
        const origin = workOriginOf(l.memberTeamId, teamScope);
        if (origin === "help") {
          a.helpHours += l.hours;
          a.helpAmount += l.amount;
          const org = orgLabelAt(model.members, l.memberId, cm.month);
          if (org) a.orgs.add(org);
        } else if (origin === "support") {
          a.supportHours += l.hours;
          a.supportAmount += l.amount;
        }
        total += l.amount;
      }
    }
  }
  return [...acc.values()]
    .map(({ months, contracts, teams, rateSet, orgs, ...a }) => ({ ...a, monthCount: months.size, contractIds: [...contracts].sort(), teamIds: [...teams].sort(), rates: [...rateSet].sort((x, y) => x - y), orgLabels: [...orgs].sort(), share: total !== 0 ? a.amount / total : null }))
    .sort((a, b) => b.amount - a.amount || (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
}

/** その月のメンバーレコードの部・課（「部 課」。どちらも空なら事業本部、それも空なら空文字） */
function orgLabelAt(members: readonly MemberRecord[], memberId: string, month: YearMonth): string {
  let best: MemberRecord | null = null;
  for (const r of members) {
    if (r.memberId !== memberId || r.effectiveFrom > month) continue;
    if (!best || r.effectiveFrom >= best.effectiveFrom) best = r;
  }
  if (!best) return "";
  const dept = [best.department, best.section].filter((x) => x && x.trim() !== "").join(" ");
  return dept || (best.division ?? "");
}

export interface OriginTotals {
  supportHours: number;
  supportAmount: number;
  helpHours: number;
  helpAmount: number;
}

/** teamMemberCosts の応援・ヘルプの合計 */
export function originTotals(rows: readonly TeamMemberCost[]): OriginTotals {
  const t: OriginTotals = { supportHours: 0, supportAmount: 0, helpHours: 0, helpAmount: 0 };
  for (const r of rows) {
    t.supportHours += r.supportHours;
    t.supportAmount += r.supportAmount;
    t.helpHours += r.helpHours;
    t.helpAmount += r.helpAmount;
  }
  return t;
}
