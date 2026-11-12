/**
 * 体制図（SPEC §76）: 月を指定して、組織の木にその月のメンバー・応援・ヘルプと負荷（計画・実績）を載せる
 *
 * 表示専用。マスタ・計画は変えない。純粋関数で、Model（model.json ＋ member-months.json の memberMonths）だけから求める。
 * - 所属: その月の有効レコードの team_id（§5）。不在の行は「不在した月に計画か実績があればその月だけ稼働」（§35、isWorkingAt）
 * - 前月との比較: 前月にその組織にいなかった人 = joined、前月にいて今月いない人 = left（移った先か不在かを持つ）
 * - 応援・ヘルプ（§72）: 案件の主担当チーム（配下・上位を含む）の外の人が、その月にその案件へ計画か実績を持つ。
 *   所属チームが無い人・マスタに無い人はヘルプ。主担当チームのノードに載せる
 */
import { addMonths } from "./calendar.js";
import { createEffectiveIndex, isLeftRecord, isWorkingAt, memberMonthKey, monthPresenceAt, teamTreeAt } from "./masters.js";
import { HolidaySet } from "./holidays.js";
import { ownTeamScope, workOriginOf, type WorkOrigin } from "./team-detail.js";
import type { MemberMonth, MemberRecord, Model, TeamNode, YearMonth } from "./types.js";

/** その月の負荷の 1 行（案件、または運用保守以外の種別） */
export interface OrgLoadLine {
  /** 案件ID。運用保守以外は outsideRowId */
  contractId: string;
  outsideType?: string;
  plannedHours: number;
  actualHours: number;
  /** 案件の主担当チーム（運用保守以外・不明は null） */
  contractTeamId: string | null;
  /** この人から見て応援先の案件（主担当チームが本人の所属の配下・上位の外） */
  support: boolean;
}

export type OrgChange = "joined" | "left" | null;

export interface OrgPerson {
  memberId: string;
  name: string;
  title: string;
  /** その月の所属チーム（無ければ null） */
  teamId: string | null;
  /** own = そのノードの所属、support = 応援、help = ヘルプ（§72） */
  origin: WorkOrigin;
  /** 前月との比較（own のときだけ）。left は今月はいない人（薄く出す） */
  change: OrgChange;
  /** joined: 前月の所属（null = 前月は在籍していない・新規）。left: 今月の所属（null = 不在・退任） */
  otherTeamId: string | null;
  /** 不在の行だが不在した月に計画・実績があるので稼働扱い（§35） */
  leaving: boolean;
  /** その月に稼働できる量（人月。§119）。在籍・不在が切り替わる日のある月は在籍の営業日の割合、他は 1 */
  capacity: number;
  memberUnknown: boolean;
  /** その月の計画・実績の時間（own は全案件＋運用保守以外、support/help はこのノードの案件だけ） */
  plannedHours: number;
  actualHours: number;
  lines: OrgLoadLine[];
}

export interface OrgChartNode {
  teamId: string;
  name: string;
  level: string;
  leaderMemberId: string | null;
  parentTeamId: string | null;
  depth: number;
  children: string[];
  descendantIds: string[];
  /** 直属のメンバー（今月いる人 → 抜けた人の順。それぞれ社員番号順） */
  members: OrgPerson[];
  /** このノードが主担当の案件に入った応援・ヘルプ */
  guests: OrgPerson[];
  /** このノードが主担当で、その月が契約期間内の案件 */
  contractIds: string[];
  /** 直属の人数（今月いる人）と前月の人数 */
  headcount: number;
  prevHeadcount: number;
  /** 配下を含む人数（今月は今月の組織、前月は前月の組織の配下で数える） */
  totalHeadcount: number;
  prevTotalHeadcount: number;
}

export interface OrgChart {
  month: YearMonth;
  prevMonth: YearMonth;
  rootTeamIds: string[];
  nodes: Record<string, OrgChartNode>;
  /** 所属チームがその月の組織に無い人（チームIDの誤り・発効前など） */
  unplaced: OrgPerson[];
}

type OrgSource = Pick<Model, "teams" | "members" | "memberMonths" | "contracts" | "worklogMonths"> & Partial<Pick<Model, "holidays">>;

const EPS = 1e-9;
const byId = (a: { memberId: string }, b: { memberId: string }) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0);

/** 月 month の体制図 */
export function orgChartAt(model: OrgSource, month: YearMonth): OrgChart {
  const prevMonth = addMonths(month, -1);
  const { tree, rootTeamIds } = teamTreeAt({ teams: model.teams }, month);
  const prevTree = teamTreeAt({ teams: model.teams }, prevMonth).tree;
  const idx = createEffectiveIndex(model.members, (m) => m.memberId, (m) => m.effectiveFrom);
  const at = (id: string, m: YearMonth): MemberRecord | null => idx.at(id, m);

  // 計画か実績がある「メンバー|月」（§35 の不在した月の稼働判定）
  const worked = new Set<string>(model.worklogMonths ?? []);
  const mmAt = new Map<string, MemberMonth>();
  for (const mm of model.memberMonths ?? []) {
    if (mm.byContract.some((c) => c.allocation > EPS || c.actualHours > EPS)) worked.add(memberMonthKey(mm.memberId, mm.month));
    if (mm.month === month) mmAt.set(mm.memberId, mm);
  }
  const working = (id: string, m: YearMonth) => isWorkingAt(at, id, m, (i, mo) => worked.has(memberMonthKey(i, mo)));
  const teamOf = (id: string, m: YearMonth, t: Record<string, TeamNode>): string | null => {
    if (!working(id, m)) return null;
    const tid = at(id, m)?.teamId ?? null;
    return tid && Object.hasOwn(t, tid) ? tid : null;
  };

  // 案件 → 主担当チーム。その月が契約期間内の案件をノードに載せる
  const contractTeam = new Map<string, string | null>();
  const nodeContracts = new Map<string, string[]>();
  for (const r of model.contracts) {
    const c = r.contract;
    contractTeam.set(c.contractId, c.teamId ?? null);
    if (c.teamId && Object.hasOwn(tree, c.teamId) && c.startMonth <= month && month <= c.endMonth) {
      const list = nodeContracts.get(c.teamId) ?? [];
      list.push(c.contractId);
      nodeContracts.set(c.teamId, list);
    }
  }
  const scopeCache = new Map<string, Set<string>>();
  const scopeOf = (teamId: string | null): Set<string> | null => {
    if (!teamId) return null;
    let s = scopeCache.get(teamId);
    if (!s) scopeCache.set(teamId, (s = ownTeamScope(tree, teamId)));
    return s;
  };

  const linesOf = (mm: MemberMonth | undefined, ownTeam: string | null): OrgLoadLine[] => {
    if (!mm) return [];
    const own = scopeOf(ownTeam);
    return mm.byContract
      .filter((c) => c.allocation > EPS || c.actualHours > EPS)
      .map((c) => {
        const ct = c.outsideType !== undefined ? null : (contractTeam.get(c.contractId) ?? null);
        // 自分の所属の配下・上位の外の主担当チーム = 応援先（担当組織が無い案件は判定しない）
        const support = !!ct && !!own && Object.hasOwn(tree, ct) && !own.has(ct);
        return { contractId: c.contractId, ...(c.outsideType !== undefined ? { outsideType: c.outsideType } : {}), plannedHours: c.plannedHours, actualHours: c.actualHours, contractTeamId: ct, support };
      });
  };
  const sum = (lines: readonly OrgLoadLine[]) => ({
    plannedHours: lines.reduce((s, l) => s + l.plannedHours, 0),
    actualHours: lines.reduce((s, l) => s + l.actualHours, 0),
  });
  const holidaySet = new HolidaySet(model.holidays ?? []);
  const presenceShare = (memberId: string): number => {
    const p = monthPresenceAt(at, memberId, month, holidaySet);
    return p ? p.present / p.total : 1;
  };
  const person = (memberId: string, teamId: string | null, origin: WorkOrigin, change: OrgChange, otherTeamId: string | null, lines: OrgLoadLine[]): OrgPerson => {
    const rec = at(memberId, month) ?? at(memberId, prevMonth);
    const mm = mmAt.get(memberId);
    return {
      memberId,
      name: rec?.name || mm?.memberName || memberId,
      title: rec?.title ?? "",
      teamId,
      origin,
      change,
      otherTeamId,
      leaving: change !== "left" && isLeftRecord(at(memberId, month)),
      capacity: presenceShare(memberId),
      memberUnknown: !idx.has(memberId),
      ...sum(lines),
      lines,
    };
  };

  const nodes: Record<string, OrgChartNode> = {};
  for (const id of Object.keys(tree)) {
    const n = tree[id]!;
    nodes[id] = { teamId: id, name: n.name, level: n.level, leaderMemberId: n.leaderMemberId, parentTeamId: n.parentTeamId, depth: n.depth, children: n.children.slice(), descendantIds: n.descendantIds.slice(), members: [], guests: [], contractIds: (nodeContracts.get(id) ?? []).sort(), headcount: 0, prevHeadcount: 0, totalHeadcount: 0, prevTotalHeadcount: 0 };
  }

  const unplaced: OrgPerson[] = [];
  // 前月の直属の人数（前月の組織。今月の木に無いチームも数えて、配下の合計は前月の木でまとめる）
  const prevDirect = new Map<string, number>();
  const ids = new Set<string>(idx.keys());
  for (const id of mmAt.keys()) ids.add(id);
  for (const memberId of [...ids].sort()) {
    const now = teamOf(memberId, month, tree);
    const before = teamOf(memberId, prevMonth, prevTree);
    if (now) {
      nodes[now]!.members.push(person(memberId, now, "own", before === now ? null : "joined", before === now ? null : before, linesOf(mmAt.get(memberId), now)));
      nodes[now]!.headcount += 1;
    } else if (working(memberId, month) && at(memberId, month)?.teamId) {
      // 所属チームがその月の組織に無い
      const tid = at(memberId, month)!.teamId;
      unplaced.push(person(memberId, tid, "own", null, null, linesOf(mmAt.get(memberId), null)));
    }
    if (before) prevDirect.set(before, (prevDirect.get(before) ?? 0) + 1);
    if (before && Object.hasOwn(nodes, before)) {
      nodes[before]!.prevHeadcount += 1;
      if (before !== now) nodes[before]!.members.push(person(memberId, now, "own", "left", now, []));
    }
    // 応援・ヘルプ: 主担当チームの外から、その月にその案件へ計画か実績がある
    const mm = mmAt.get(memberId);
    if (!mm) continue;
    const guestLines = new Map<string, OrgLoadLine[]>();
    const known = idx.has(memberId);
    const homeTeam = known ? (at(memberId, month)?.teamId ?? null) : null;
    for (const line of linesOf(mm, now)) {
      const ct = line.contractTeamId;
      if (!ct || !Object.hasOwn(nodes, ct) || line.outsideType !== undefined) continue;
      if (workOriginOf(homeTeam, scopeOf(ct)) === "own") continue;
      const list = guestLines.get(ct) ?? [];
      list.push(line);
      guestLines.set(ct, list);
    }
    for (const [ct, lines] of guestLines) {
      nodes[ct]!.guests.push(person(memberId, homeTeam, homeTeam ? "support" : "help", null, null, lines));
    }
  }

  for (const n of Object.values(nodes)) {
    n.members.sort((a, b) => Number(a.change === "left") - Number(b.change === "left") || byId(a, b));
    n.guests.sort((a, b) => (a.origin === b.origin ? byId(a, b) : a.origin === "support" ? -1 : 1));
  }
  // 配下を含む人数。前月は前月の組織の配下で数える（親の付け替えで増減が消えないように。前月に無かった組織は 0）
  for (const n of Object.values(nodes)) {
    for (const d of n.descendantIds) n.totalHeadcount += nodes[d]?.headcount ?? 0;
    for (const d of prevTree[n.teamId]?.descendantIds ?? []) n.prevTotalHeadcount += prevDirect.get(d) ?? 0;
  }
  return { month, prevMonth, rootTeamIds, nodes, unplaced };
}

/** 計画の負荷の色分け（§41・§58 と同じ）: 稼働できる量（通常 1.0。§119）超 = over、未満 = under、ちょうど = full、計画なし = none */
export type OrgLoadLevel = "over" | "full" | "under" | "none";
export function loadLevelOf(plannedPersonMonths: number, capacity = 1): OrgLoadLevel {
  if (plannedPersonMonths <= EPS) return "none";
  if (plannedPersonMonths > capacity + EPS) return "over";
  if (plannedPersonMonths < capacity - EPS) return "under";
  return "full";
}
