/**
 * 稼働計画（SPEC §23）の純粋ロジック — マスタ編集画面の「稼働計画」タブから使う
 *
 * 稼働計画 = アサイン（assignments.csv）。組織を選び、その組織（配下を含む）のメンバーごとに
 * 月ごとの配分合計（人月）と、期間に掛かるアサイン行を返す。編集中（保存前）のデータで計算する。
 * 人月と時間の換算（§23.2。保存・表示は人月、時間は入力のときだけ）もここに置く。
 */
import { isValidYearMonth } from "./calendar.js";
import { createEffectiveIndex, teamTreeAt } from "./masters.js";
import type { MemberRecord, TeamNode, TeamRecord, YearMonth } from "./types.js";

/** 画面で編集中のアサイン 1 行（rowId はマスタ編集の行 id） */
export interface PlanAssignment {
  rowId: string;
  memberId: string;
  contractId: string;
  startMonth: YearMonth;
  endMonth: YearMonth;
  /** 数値でなければ NaN（合計には 0 として数える） */
  allocation: number;
}

export interface PlanSources {
  teams: readonly TeamRecord[];
  members: readonly MemberRecord[];
  assignments: readonly PlanAssignment[];
  /** 契約 → 担当組織（応援の判定に使う） */
  contractTeams: ReadonlyMap<string, string | null>;
}

export interface PlanMemberRow {
  memberId: string;
  /** members に無ければ "" */
  name: string;
  /** 期間内で最後に有効な所属組織（無ければ null） */
  teamId: string | null;
  /** 期間内に選んだ組織（配下を含む）に所属していない＝他組織からの応援 */
  support: boolean;
  /** months と同じ順の配分合計（人月） */
  monthly: number[];
  /** 合計が 1.0 を超える月 */
  overMonths: YearMonth[];
  /** 期間に掛かるアサイン行（契約ID・開始月の順） */
  assignments: PlanAssignment[];
}

export interface PlanView {
  months: YearMonth[];
  rows: PlanMemberRow[];
  /** 月ごとの組織合計（人月） */
  totals: number[];
}

const EPS = 1e-9;

function overlaps(a: Pick<PlanAssignment, "startMonth" | "endMonth">, from: YearMonth, to: YearMonth): boolean {
  return isValidYearMonth(a.startMonth) && isValidYearMonth(a.endMonth) && a.startMonth <= to && a.endMonth >= from;
}

/**
 * 組織 teamId（null = すべて）の稼働計画
 * - 対象: 期間のいずれかの月に組織か配下に所属していた人 ＋ 組織か配下が担当する契約に期間内の計画がある他組織の人（応援）
 * - 組織の木は月ごとに当時のもの（§5）で判定する
 */
export function planView(src: PlanSources, teamId: string | null, months: readonly YearMonth[]): PlanView {
  const ms = months.filter(isValidYearMonth);
  if (ms.length === 0) return { months: [], rows: [], totals: [] };
  const from = ms[0] as YearMonth;
  const to = ms[ms.length - 1] as YearMonth;
  const memberIdx = createEffectiveIndex(src.members, (m) => m.memberId, (m) => m.effectiveFrom);
  const scopeAt = new Map<YearMonth, Set<string> | null>();
  for (const m of ms) {
    if (teamId === null) scopeAt.set(m, null);
    else {
      const node = teamTreeAt({ teams: src.teams as TeamRecord[] }, m).tree[teamId];
      scopeAt.set(m, new Set(node ? node.descendantIds : []));
    }
  }
  const inScope = (tid: string | null | undefined, m: YearMonth): boolean => {
    const s = scopeAt.get(m);
    if (s === null) return true;
    return !!tid && !!s && s.has(tid);
  };

  const ids: string[] = [];
  const seen = new Set<string>();
  const support = new Set<string>();
  const add = (id: string) => {
    if (id === "" || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  // 所属メンバー（members ファイルの初出順）
  for (const id of memberIdx.keys()) {
    if (ms.some((m) => inScope(memberIdx.at(id, m)?.teamId, m))) add(id);
  }
  // 応援: 組織の契約に計画がある他組織の人（すべてのときは members に無い人も拾う）
  for (const a of src.assignments) {
    if (!overlaps(a, from, to) || seen.has(a.memberId)) continue;
    const ct = src.contractTeams.get(a.contractId) ?? null;
    const hit = ms.some((m) => a.startMonth <= m && m <= a.endMonth && inScope(ct, m));
    if (hit) {
      if (teamId !== null) support.add(a.memberId);
      add(a.memberId);
    }
  }

  const byMember = new Map<string, PlanAssignment[]>();
  for (const a of src.assignments) {
    if (!seen.has(a.memberId) || !overlaps(a, from, to)) continue;
    const list = byMember.get(a.memberId);
    if (list) list.push(a);
    else byMember.set(a.memberId, [a]);
  }

  const totals = ms.map(() => 0);
  const rows: PlanMemberRow[] = ids.map((memberId) => {
    const list = (byMember.get(memberId) ?? []).slice().sort((x, y) => (x.contractId < y.contractId ? -1 : x.contractId > y.contractId ? 1 : x.startMonth < y.startMonth ? -1 : x.startMonth > y.startMonth ? 1 : 0));
    const monthly = ms.map((m) => list.reduce((s, a) => (a.startMonth <= m && m <= a.endMonth && Number.isFinite(a.allocation) ? s + a.allocation : s), 0));
    monthly.forEach((v, i) => (totals[i] = (totals[i] as number) + v));
    let last: MemberRecord | null = null;
    for (const m of ms) last = memberIdx.at(memberId, m) ?? last;
    return {
      memberId,
      name: last?.name ?? memberIdx.at(memberId, "9999-12")?.name ?? "",
      teamId: last?.teamId ?? null,
      support: support.has(memberId),
      monthly,
      overMonths: ms.filter((_, i) => (monthly[i] as number) > 1 + EPS),
      assignments: list,
    };
  });
  return { months: ms, rows, totals };
}

/** 組織の木を表示順（親 → 子）に平らにする（組織の選択肢用） */
export function flattenTeamTree(tree: Readonly<Record<string, TeamNode>>): TeamNode[] {
  const out: TeamNode[] = [];
  const visit = (id: string) => {
    const n = tree[id];
    if (!n) return;
    out.push(n);
    for (const c of n.children) visit(c);
  };
  for (const n of Object.values(tree)) if (n.parentTeamId === null) visit(n.teamId);
  return out;
}

/** 月 m に有効なメンバーの所属組織（無ければ null） */
export function memberTeamAt(members: readonly MemberRecord[], memberId: string, month: YearMonth): string | null {
  return createEffectiveIndex(members, (m) => m.memberId, (m) => m.effectiveFrom).at(memberId, month)?.teamId ?? null;
}

// ---------------------------------------------------------------------------
// §23.2 人月と時間（保存・表示は人月。時間は入力のときだけ）
// ---------------------------------------------------------------------------

/** 小数 4 桁に四捨五入して、末尾の 0 を付けない文字列にする（CSV に書く値） */
export function formatAllocation(value: number): string {
  if (!Number.isFinite(value)) return "";
  const r = Math.round(value * 10000) / 10000;
  return String(Object.is(r, -0) ? 0 : r);
}

/**
 * 入力値（人月 or 時間）を CSV に書く人月の文字列にする。
 * 人月で入れた値はそのまま（入力どおり）。時間は人月に直して小数 4 桁。数値でなければ元の文字列のまま（検証でエラーにする）
 */
export function allocationFromInput(text: string, unit: "personMonth" | "hours", standardHoursPerMonth: number): string {
  const t = text.normalize("NFKC").trim();
  if (t === "") return "";
  const n = Number(t);
  if (!Number.isFinite(n)) return t;
  if (unit === "personMonth") return t;
  if (!(standardHoursPerMonth > 0)) return t;
  return formatAllocation(n / standardHoursPerMonth);
}

/** 人月 → 時間（入力欄の換算表示用。小数 1 桁） */
export function hoursFromAllocation(allocation: number, standardHoursPerMonth: number): number {
  return Math.round(allocation * standardHoursPerMonth * 10) / 10;
}
