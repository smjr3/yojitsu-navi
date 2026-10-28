/**
 * 稼働計画（SPEC §23）の純粋ロジック — マスタ編集画面の「稼働計画」タブから使う
 *
 * 稼働計画 = アサイン（assignments.csv）。組織を選び、その組織（配下を含む）のメンバーごとに
 * 月ごとの配分合計（人月）と、期間に掛かるアサイン行を返す。編集中（保存前）のデータで計算する。
 * 人月と時間の換算（§23.2。保存・表示は人月、時間は入力のときだけ）もここに置く。
 */
import { addMonths, isValidYearMonth, monthRange } from "./calendar.js";
import { parseNumberCell } from "./csv.js";
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
  // CSV の読み込み（parseNumberCell）と同じ規則で数値にする。0x10・1e-5 などを画面だけ数値扱いしない
  const n = parseNumberCell(t);
  if (!Number.isFinite(n)) return t;
  if (unit === "personMonth") return t;
  if (!(standardHoursPerMonth > 0)) return t;
  return formatAllocation(n / standardHoursPerMonth);
}

/** 人月 → 時間（入力欄の換算表示用。小数 1 桁） */
export function hoursFromAllocation(allocation: number, standardHoursPerMonth: number): number {
  return Math.round(allocation * standardHoursPerMonth * 10) / 10;
}

// ---------------------------------------------------------------------------
// §31.3 案件を選んで契約へ割り当てる / §31.4 セルでの月ごとの修正
// ---------------------------------------------------------------------------

/** 案件のキー（顧客名 × 案件名）。画面の候補と保存時の割り当てで同じものを使う */
export function projectKey(customerName: string, projectName: string): string {
  return `${customerName.trim()}\u0001${projectName.trim()}`;
}

export interface ContractPeriod {
  contractId: string;
  startMonth: YearMonth;
  endMonth: YearMonth;
}

export interface MonthSegment {
  contractId: string;
  startMonth: YearMonth;
  endMonth: YearMonth;
}

/**
 * 期間 [from, to] の各月を、案件の契約（contracts）へ割り当てて、同じ契約が続く月をまとめる（§31.3）
 * - 月 m を含む契約（複数なら開始月が最も遅いもの）
 * - どれにも入らない月は、m より前に終わった最後の契約、無ければ m より後に始まる最初の契約
 * 契約が 0 件・月が不正・from > to なら []
 */
export function contractSegments(contracts: readonly ContractPeriod[], from: YearMonth, to: YearMonth): MonthSegment[] {
  const list = contracts.filter((c) => isValidYearMonth(c.startMonth) && isValidYearMonth(c.endMonth) && c.startMonth <= c.endMonth);
  if (list.length === 0 || !isValidYearMonth(from) || !isValidYearMonth(to) || from > to) return [];
  const byStart = list.slice().sort((a, b) => (a.startMonth < b.startMonth ? -1 : a.startMonth > b.startMonth ? 1 : a.contractId < b.contractId ? -1 : 1));
  const pick = (m: YearMonth): string => {
    let hit: ContractPeriod | null = null;
    for (const c of byStart) if (c.startMonth <= m && m <= c.endMonth) hit = c;
    if (hit) return hit.contractId;
    let before: ContractPeriod | null = null;
    for (const c of byStart) if (c.endMonth < m && (!before || c.endMonth >= before.endMonth)) before = c;
    if (before) return before.contractId;
    return (byStart.find((c) => c.startMonth > m) ?? (byStart[0] as ContractPeriod)).contractId;
  };
  const out: MonthSegment[] = [];
  for (const m of monthRange(from, to)) {
    const id = pick(m);
    const last = out[out.length - 1];
    if (last && last.contractId === id) last.endMonth = m;
    else out.push({ contractId: id, startMonth: m, endMonth: m });
  }
  return out;
}

export interface AllocationPiece {
  startMonth: YearMonth;
  endMonth: YearMonth;
  /** CSV に書く人月の文字列 */
  allocation: string;
}

/** 人月の文字列が 0 か空（その月は計画から外す） */
function isZeroAllocation(text: string): boolean {
  const t = text.trim();
  if (t === "") return true;
  const n = parseNumberCell(t);
  return Number.isFinite(n) && Math.abs(n) < EPS;
}

/**
 * 計画 1 行（[startMonth, endMonth]・配分 allocation）の月 month を value に変える（§31.4）
 * scope "month" = その月だけ、"after" = その月から行の終わりまで。
 * 返すのは書き直した後の行（期間の順）。0 か空の部分は返さない。month が行の外なら元の行のまま
 */
export function editMonthAllocation(row: AllocationPiece, month: YearMonth, value: string, scope: "month" | "after"): AllocationPiece[] {
  if (!isValidYearMonth(month) || month < row.startMonth || month > row.endMonth) return [row];
  const pieces: AllocationPiece[] = [];
  if (row.startMonth < month) pieces.push({ startMonth: row.startMonth, endMonth: addMonths(month, -1), allocation: row.allocation });
  const until = scope === "month" ? month : row.endMonth;
  pieces.push({ startMonth: month, endMonth: until, allocation: value.trim() });
  if (until < row.endMonth) pieces.push({ startMonth: addMonths(until, 1), endMonth: row.endMonth, allocation: row.allocation });
  return pieces.filter((p) => !isZeroAllocation(p.allocation));
}

/** 配分の文字列が同じ値か（"0.5" と "0.50" は同じ） */
function sameAllocation(a: string, b: string): boolean {
  const x = parseNumberCell(a.trim());
  const y = parseNumberCell(b.trim());
  return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) < EPS : a.trim() === b.trim();
}

/**
 * 隣り合い（前の行の終わりの翌月 = 次の行の開始月）、配分が同じ行を 1 行にまとめる（§31.4）
 * rows は同じメンバー・契約の行。返り値は keep（残す行 id → 新しい終了月）と drop（消す行 id）。
 * 残すのは各まとまりの最初の行（期間順）。preferIds にある行（元からある行）があればそちらを残す
 */
export function mergeAdjacent<T extends AllocationPiece & { id: string }>(rows: readonly T[], preferIds: ReadonlySet<string> = new Set()): { keep: Map<string, { startMonth: YearMonth; endMonth: YearMonth }>; drop: string[] } {
  const sorted = rows.filter((r) => isValidYearMonth(r.startMonth) && isValidYearMonth(r.endMonth) && r.startMonth <= r.endMonth).slice().sort((a, b) => (a.startMonth < b.startMonth ? -1 : a.startMonth > b.startMonth ? 1 : 0));
  const groups: T[][] = [];
  for (const r of sorted) {
    const g = groups[groups.length - 1];
    const prev = g?.[g.length - 1];
    if (g && prev && addMonths(prev.endMonth, 1) === r.startMonth && sameAllocation(prev.allocation, r.allocation)) g.push(r);
    else groups.push([r]);
  }
  const keep = new Map<string, { startMonth: YearMonth; endMonth: YearMonth }>();
  const drop: string[] = [];
  for (const g of groups) {
    if (g.length < 2) continue;
    const keeper = g.find((r) => preferIds.has(r.id)) ?? (g[0] as T);
    keep.set(keeper.id, { startMonth: (g[0] as T).startMonth, endMonth: (g[g.length - 1] as T).endMonth });
    for (const r of g) if (r !== keeper) drop.push(r.id);
  }
  return { keep, drop };
}
