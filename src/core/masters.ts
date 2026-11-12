/**
 * 履歴マスタの有効レコード検索（SPEC §5）、時間単価（§6）、チーム階層（§11）
 */
import type { Assignment, Dataset, MemberRecord, OutsidePlan, Worklog, RateRecord, TeamNode, TeamRecord, Warning, YearMonth } from "./types.js";
import { T, fmt } from "../i18n/index.js";
import { addMonths, isBusinessDay, isValidISODate, isValidYearMonth, monthOfDate, monthRange, toHolidaySet, type HolidayLookup } from "./calendar.js";

// ---------------------------------------------------------------------------
// §5 有効レコード（汎用）
// ---------------------------------------------------------------------------

export interface EffectiveIndex<T> {
  /** 月 m に有効なレコード。無ければ null */
  at(key: string, month: YearMonth): T | null;
  /** キーが 1 件でも存在するか（effectiveFrom を問わない） */
  has(key: string): boolean;
  /** 全キー（最初に現れた順） */
  keys(): string[];
}

/**
 * 同じキーのレコードを effectiveFrom 昇順（同値は元の並び順を保つ）に並べ、
 * `effectiveFrom <= m` の最大のものを返す索引を作る。
 * 同じ effectiveFrom が複数あれば後の行（ファイル末尾側）を採用する。
 */
export function createEffectiveIndex<T>(
  records: readonly T[],
  keyOf: (r: T) => string,
  effectiveFromOf: (r: T) => YearMonth,
): EffectiveIndex<T> {
  const groups = new Map<string, T[]>();
  for (const r of records) {
    const key = keyOf(r);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  for (const list of groups.values()) {
    // Array.prototype.sort は安定なので、同じ effectiveFrom は元の順序を保つ
    list.sort((a, b) => (effectiveFromOf(a) < effectiveFromOf(b) ? -1 : effectiveFromOf(a) > effectiveFromOf(b) ? 1 : 0));
  }
  return {
    at(key, month) {
      const list = groups.get(key);
      if (!list) return null;
      return effectiveRecordAt(list, month, effectiveFromOf);
    },
    has(key) {
      return groups.has(key);
    },
    keys() {
      return [...groups.keys()];
    },
  };
}

/**
 * effectiveFrom 昇順に並んだ同一キーのレコードから、月 m に有効なものを二分探索で返す。
 * 「effectiveFrom <= m の最後の要素」= 同じ effectiveFrom なら後の行を採用。
 */
export function effectiveRecordAt<T>(
  sortedRecords: readonly T[],
  month: YearMonth,
  effectiveFromOf: (r: T) => YearMonth,
): T | null {
  let lo = 0;
  let hi = sortedRecords.length; // [lo, hi) の範囲に答えがある
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const r = sortedRecords[mid] as T;
    if (effectiveFromOf(r) <= month) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? null : (sortedRecords[lo - 1] as T);
}

// ---------------------------------------------------------------------------
// §6 時間単価
// ---------------------------------------------------------------------------

export interface RateResolution {
  hourlyRate: number;
  /** 使った単価レコードの出どころ。rateMissing の場合は null */
  rateSource: { key: string; effectiveFrom: YearMonth } | null;
  rateMissing: boolean;
  /** メンバーが members に（どの月にも）存在しない */
  memberUnknown: boolean;
}

export interface MasterIndex {
  members: EffectiveIndex<MemberRecord>;
  rates: EffectiveIndex<RateRecord>;
  teams: EffectiveIndex<TeamRecord>;
}

/** データセットから履歴マスタの索引をまとめて作る */
export function createMasterIndex(
  dataset: Pick<Dataset, "members" | "rates" | "teams">,
): MasterIndex {
  return {
    members: createEffectiveIndex(dataset.members, (m) => m.memberId, (m) => m.effectiveFrom),
    rates: createEffectiveIndex(dataset.rates, (r) => r.key, (r) => r.effectiveFrom),
    teams: createEffectiveIndex(dataset.teams, (t) => t.teamId, (t) => t.effectiveFrom),
  };
}

/** 不在の行か（SPEC §35。members.csv の status 列に退職・休職など何か書いてある） */
export function isLeftRecord(m: Pick<MemberRecord, "status"> | null | undefined): boolean {
  return m?.status === "left";
}

/** 月 m に在籍しているか（その月の有効レコードがあり、不在の行でない） */
export function isActiveAt(index: MasterIndex, memberId: string, month: YearMonth): boolean {
  const rec = memberAt(index, memberId, month);
  return rec !== null && !isLeftRecord(rec);
}

/**
 * 月 m に稼働しているとみなすか（§35）。在籍していれば稼働。
 * 不在した月（前月は在籍）は、その月に計画か実績があれば（worked）稼働とみなす。翌月からは稼働しない。
 * 不在になる日（status_date。§119）を書いた月は、計画・実績に関係なく、その日が月の 2 日以降なら稼働
 */
export function isWorkingAt(
  at: (memberId: string, month: YearMonth) => MemberRecord | null | undefined,
  memberId: string,
  month: YearMonth,
  worked: (memberId: string, month: YearMonth) => boolean,
): boolean {
  const rec = at(memberId, month);
  if (!rec) return false;
  if (!isLeftRecord(rec)) return true;
  if (rec.effectiveFrom !== month) return false;
  const prev = at(memberId, addMonths(month, -1));
  if (!prev || isLeftRecord(prev)) return false;
  // 不在になる日を書いた月（§119）: その日より前に在籍していれば稼働。月の初日からなら計画・実績があっても稼働しない
  const date = statusDateOf(rec);
  if (date) return date > `${month}-01`;
  return worked(memberId, month);
}

/** 行の在籍・不在が切り替わる日（§119。status_date）。適用開始月の中の正しい日付だけ。それ以外（空・形式違い・別の月）は null（月の初めから） */
export function statusDateOf(rec: Pick<MemberRecord, "statusDate" | "effectiveFrom"> | null | undefined): string | null {
  const d = rec?.statusDate;
  return d && isValidISODate(d) && monthOfDate(d) === rec!.effectiveFrom ? d : null;
}

/** 月の在籍日数（§119）。present = 在籍している営業日、total = 月の営業日（営業日が無い月は暦日で数える） */
export interface MonthPresence {
  present: number;
  total: number;
}

/**
 * 月 m に在籍している営業日（§119）。在籍・不在が切り替わる日（status_date）のある月だけ日割りし、それ以外は null（月の全部か 0）。
 * 切り替わる日より前は前月の状態、その日からはこの行の状態。祝日は HolidaySet（§49 の国民の祝日の補完込み）を渡す
 */
export function monthPresenceAt(
  at: (memberId: string, month: YearMonth) => MemberRecord | null | undefined,
  memberId: string,
  month: YearMonth,
  holidays: HolidayLookup,
): MonthPresence | null {
  const rec = at(memberId, month);
  if (!rec || rec.effectiveFrom !== month) return null;
  const date = statusDateOf(rec);
  if (!date) return null;
  const prev = at(memberId, addMonths(month, -1));
  const before = !!prev && !isLeftRecord(prev);
  const after = !isLeftRecord(rec);
  if (before === after) return null;
  const set = toHolidaySet(holidays);
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const days = Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
  const biz = days.filter((d) => isBusinessDay(d, set));
  const pool = biz.length > 0 ? biz : days;
  const present = pool.filter((d) => (d < date ? before : after)).length;
  return { present, total: pool.length };
}

/**
 * 月 m に稼働できる量（人月。§58・§119）。稼働しない月（isWorkingAt）は 0、在籍・不在が切り替わる日のある月は在籍の営業日の割合、それ以外は 1
 */
export function workingShareAt(
  at: (memberId: string, month: YearMonth) => MemberRecord | null | undefined,
  memberId: string,
  month: YearMonth,
  worked: (memberId: string, month: YearMonth) => boolean,
  holidays: HolidayLookup,
): number {
  if (!isWorkingAt(at, memberId, month, worked)) return 0;
  const p = monthPresenceAt(at, memberId, month, holidays);
  return p ? p.present / p.total : 1;
}

/** 「メンバー|月」のキー（§35 の不在した月の稼働判定で使う） */
export function memberMonthKey(memberId: string, month: YearMonth): string {
  return `${memberId}|${month}`;
}

/** 計画（アサイン・運用保守以外の予定）か作業実績がある「メンバー|月」（§35） */
export function workedMonthKeys(dataset: {
  assignments?: readonly Pick<Assignment, "memberId" | "startMonth" | "endMonth" | "allocation">[];
  outsidePlans?: readonly Pick<OutsidePlan, "memberId" | "startMonth" | "endMonth" | "personMonths">[];
  worklogs?: readonly Pick<Worklog, "memberId" | "date" | "hours">[];
}): Set<string> {
  const keys = new Set<string>();
  const plans = [
    ...(dataset.assignments ?? []).map((a) => ({ memberId: a.memberId, startMonth: a.startMonth, endMonth: a.endMonth, value: a.allocation })),
    ...(dataset.outsidePlans ?? []).map((o) => ({ memberId: o.memberId, startMonth: o.startMonth, endMonth: o.endMonth, value: o.personMonths })),
  ];
  for (const p of plans) {
    if (!(p.value > 0) || !isValidYearMonth(p.startMonth) || !isValidYearMonth(p.endMonth) || p.startMonth > p.endMonth) continue;
    for (const m of monthRange(p.startMonth, p.endMonth)) keys.add(memberMonthKey(p.memberId, m));
  }
  for (const w of dataset.worklogs ?? []) {
    if (isValidISODate(w.date) && Number.isFinite(w.hours) && w.hours > 0) keys.add(memberMonthKey(w.memberId, monthOfDate(w.date)));
  }
  return keys;
}

/** 不在した月（不在の行の effective_from）。不在していなければ null。復職（不在の後に在籍の行）があれば最後の不在以降に在籍の行が無いときだけ */
export function leftMonthOf(records: readonly Pick<MemberRecord, "status" | "effectiveFrom">[]): YearMonth | null {
  const sorted = [...records].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0));
  const last = sorted[sorted.length - 1];
  if (!last || !isLeftRecord(last)) return null;
  // 不在の行が続いていればいちばん早いもの
  let from = last.effectiveFrom;
  for (let i = sorted.length - 2; i >= 0 && isLeftRecord(sorted[i]); i--) from = (sorted[i] as MemberRecord).effectiveFrom;
  return from;
}

/** 不在になった日（§119）。leftMonthOf の月の不在の行に status_date があればその日、無ければ null（月の初めから） */
export function leftDateOf(records: readonly Pick<MemberRecord, "status" | "effectiveFrom" | "statusDate">[]): string | null {
  const month = leftMonthOf(records);
  if (!month) return null;
  return statusDateOf(records.find((r) => r.effectiveFrom === month && isLeftRecord(r)) ?? null);
}

/** 月 m に有効なメンバーレコード */
export function memberAt(index: MasterIndex, memberId: string, month: YearMonth): MemberRecord | null {
  return index.members.at(memberId, month);
}

/**
 * 月 m のメンバーの時間単価（SPEC §6）
 * 1. key == memberId の単価（個人単価）
 * 2. 無ければ、その月のメンバーレコードの title で検索
 * 3. 無ければ 0・rateMissing
 * 4. メンバー未登録なら 1 のみ試す
 */
export function rateFor(index: MasterIndex, memberId: string, month: YearMonth): RateResolution {
  const personal = index.rates.at(memberId, month);
  const member = memberAt(index, memberId, month);
  const memberUnknown = !index.members.has(memberId);
  // hourlyRate が数値でない（NaN/Infinity: validateDataset では RATE_INVALID）レコードは「単価なし」として扱い、NaN を集計に漏らさない
  if (personal && !Number.isFinite(personal.hourlyRate)) {
    return { hourlyRate: 0, rateSource: null, rateMissing: true, memberUnknown };
  }
  if (personal) {
    return {
      hourlyRate: personal.hourlyRate,
      rateSource: { key: personal.key, effectiveFrom: personal.effectiveFrom },
      rateMissing: false,
      memberUnknown,
    };
  }
  if (member && member.title !== "") {
    const byTitle = index.rates.at(member.title, month);
    if (byTitle && Number.isFinite(byTitle.hourlyRate)) {
      return {
        hourlyRate: byTitle.hourlyRate,
        rateSource: { key: byTitle.key, effectiveFrom: byTitle.effectiveFrom },
        rateMissing: false,
        memberUnknown,
      };
    }
  }
  return { hourlyRate: 0, rateSource: null, rateMissing: true, memberUnknown };
}

// ---------------------------------------------------------------------------
// §11 チーム階層
// ---------------------------------------------------------------------------

export interface TeamTreeResult {
  tree: Record<string, TeamNode>;
  /** 最上位チームID（teams ファイルでの初出順） */
  rootTeamIds: string[];
  warnings: Warning[];
}

/**
 * 月 m に有効な teams レコードで木を作る。
 * - 親が存在しない → UNKNOWN_TEAM 警告、最上位扱い
 * - 循環参照 → 循環に含まれるチームのうち ID が最小のものを最上位にして切る（UNKNOWN_TEAM 警告）
 * - 表示順は teams ファイルでの初出順
 */
export function teamTreeAt(dataset: Pick<Dataset, "teams">, month: YearMonth): TeamTreeResult {
  const index = createEffectiveIndex(dataset.teams, (t) => t.teamId, (t) => t.effectiveFrom);
  const warnings: Warning[] = [];
  const active = new Map<string, TeamRecord>();
  for (const teamId of index.keys()) {
    const rec = index.at(teamId, month);
    if (rec) active.set(teamId, rec);
  }

  // 親リンク（存在しない親は切る）
  const parentOf = new Map<string, string | null>();
  for (const [teamId, rec] of active) {
    let parent = rec.parentTeamId;
    if (parent !== null && parent !== "" && !active.has(parent)) {
      warnings.push({
        code: "UNKNOWN_TEAM",
        message: fmt(T.calcWarnings.teamParentMissing, { name: rec.name, teamId, parentTeamId: parent, month }),
        ref: { teamId, parentTeamId: parent, month },
      });
      parent = null;
    }
    if (parent === "") parent = null;
    parentOf.set(teamId, parent);
  }

  // 循環検出: 各ノードから親をたどり、戻ってきたら循環。最小IDの親リンクを切る
  const resolved = new Set<string>();
  for (const start of [...parentOf.keys()].sort()) {
    if (resolved.has(start)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur: string | null = start;
    while (cur !== null && !resolved.has(cur)) {
      if (onPath.has(cur)) {
        const cycle = path.slice(path.indexOf(cur));
        const cut = [...cycle].sort()[0] as string;
        const cutRec = active.get(cut) as TeamRecord;
        warnings.push({
          code: "UNKNOWN_TEAM",
          message: fmt(T.calcWarnings.teamCycle, { cycle: cycle.join(" → "), current: cur, cutId: cut, cutName: cutRec.name }),
          ref: { teamId: cut, cycle: cycle.join(">"), month },
        });
        parentOf.set(cut, null);
        break;
      }
      onPath.add(cur);
      path.push(cur);
      cur = parentOf.get(cur) ?? null;
    }
    for (const id of path) resolved.add(id);
  }

  // ノード作成（ファイル初出順）
  const order = index.keys().filter((id) => active.has(id));
  const tree: Record<string, TeamNode> = {};
  for (const teamId of order) {
    const rec = active.get(teamId) as TeamRecord;
    tree[teamId] = { teamId, name: rec.name, parentTeamId: parentOf.get(teamId) ?? null, level: rec.level ?? "", leaderMemberId: rec.leaderMemberId ?? null, depth: 0, children: [], descendantIds: [] };
  }
  const rootTeamIds: string[] = [];
  for (const teamId of order) {
    const node = tree[teamId] as TeamNode;
    if (node.parentTeamId === null) rootTeamIds.push(teamId);
    else (tree[node.parentTeamId] as TeamNode).children.push(teamId);
  }
  // 深さと子孫（親から順に）
  const visit = (teamId: string, depth: number): string[] => {
    const node = tree[teamId] as TeamNode;
    node.depth = depth;
    const ids = [teamId];
    for (const child of node.children) ids.push(...visit(child, depth + 1));
    node.descendantIds = ids;
    return ids;
  };
  for (const root of rootTeamIds) visit(root, 0);
  return { tree, rootTeamIds, warnings };
}
