/**
 * 今月の残り時間（SPEC §113）
 *
 * 残り = リソース計画の今月の時間（アサイン＋運用保守以外の予定）− 今月の実績（作業実績の速報）。
 *  - メンバー詳細（C）: その人の今月の行を出す（GitLab の接続は要らない）
 *  - ヘッダー右上（B）: GitLab のトークンの持ち主（GET /user の username）を members.csv の gitlab_username で探し、本人の行を出す
 * どちらも行は案件（契約）と運用保守以外の種別ごと。計画も実績も無い行は出さない
 */
import { T } from "../i18n/index.js";
import { addMonths } from "./calendar.js";
import type { MemberContractMonth, MemberMonth, MemberRecord, YearMonth } from "./types.js";

/** 1 行（案件 または 運用保守以外の種別） */
export interface MyHoursRow {
  /** 案件名（運用保守以外は種別。種別なしは「運用保守以外の予定」） */
  label: string;
  /** 名前の下に小さく出す: 案件は顧客名、運用保守以外は「運用保守以外」（リソース計画の作業の行と同じ） */
  sub: string;
  /** 案件の行だけ: 契約ID（運用保守以外は null） */
  contractId: string | null;
  plannedHours: number;
  actualHours: number;
}

/** ヘッダー右上（B）が読むデータ（data/my-month.json） */
export interface MyHoursPayload {
  asOf: string;
  asOfFixed: boolean;
  /** 月 → GitLab のユーザー名（normalizeGitlabUsername 済み）→ 社員番号。月ごとの有効な行（§5）で引く（月が替わってユーザー名が付け替わっても合わせる） */
  users: Record<YearMonth, Record<string, string>>;
  /** 社員番号 → 名前と月ごとの行（ビルドの基準月と翌月。翌月は月が替わってから次の取り込みまでの間に使う） */
  members: Record<string, { name: string; months: Record<YearMonth, MyHoursRow[]> }>;
}

/** メンバーごとの month 時点の有効な行（effective_from <= month で最新。同じ月なら後の行。無ければいちばん早い行） */
function currentRecords(members: readonly MemberRecord[], month: YearMonth): Map<string, MemberRecord> {
  const out = new Map<string, MemberRecord>();
  const sorted = members.map((m, i) => ({ m, i })).sort((a, b) => a.m.effectiveFrom.localeCompare(b.m.effectiveFrom) || a.i - b.i);
  for (const { m } of sorted) {
    const prev = out.get(m.memberId);
    if (!prev || m.effectiveFrom <= month) out.set(m.memberId, m);
  }
  return out;
}

/** GitLab のユーザー名の比べ方: 前後の空白と先頭の @ を除き、小文字にする */
export function normalizeGitlabUsername(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 案件の名前（契約ID → 案件名・顧客名。無ければ契約ID だけ） */
export type MyHoursContractOf = (contractId: string) => { projectName: string; customerName: string } | undefined;

/**
 * メンバーの 1 か月の行。計画も実績も無い行は除く。並びは計画の多い順（同じなら名前順）。
 * 名前はリソース計画の作業の行と同じ書き方（案件 = 案件名＋顧客名、運用保守以外 = 種別＋「運用保守以外」）
 */
export function myHoursRows(mm: MemberMonth | null | undefined, contractOf: MyHoursContractOf): MyHoursRow[] {
  if (!mm) return [];
  const rows: MyHoursRow[] = [];
  for (const c of mm.byContract as MemberContractMonth[]) {
    if (!(c.plannedHours > 0) && !(c.actualHours > 0)) continue;
    const outside = typeof c.outsideType === "string";
    const k = outside ? undefined : contractOf(c.contractId);
    const type = c.outsideType ?? "";
    rows.push({
      label: outside ? type || T.masterFiles.outside : k?.projectName || c.contractId,
      sub: outside ? (type ? T.planEdit.outsideTypeSub : T.planEdit.outsideSub) : (k?.customerName ?? ""),
      contractId: outside ? null : c.contractId,
      plannedHours: round2(c.plannedHours),
      actualHours: round2(c.actualHours),
    });
  }
  return rows.sort((a, b) => b.plannedHours - a.plannedHours || b.actualHours - a.actualHours || a.label.localeCompare(b.label, "ja"));
}

/** 行の合計と残り（残り < 0 = 計画を超えた） */
export function myHoursTotals(rows: readonly MyHoursRow[]): { plannedHours: number; actualHours: number; remainingHours: number } {
  const plannedHours = round2(rows.reduce((s, r) => s + r.plannedHours, 0));
  const actualHours = round2(rows.reduce((s, r) => s + r.actualHours, 0));
  return { plannedHours, actualHours, remainingHours: round2(plannedHours - actualHours) };
}

/**
 * GitLab のユーザー名 → 社員番号。各メンバーの month 時点の有効な行（無ければいちばん早い行）の gitlab_username を使う。
 * 同じユーザー名が複数の人に付いていたら、どの人か決められないので出さない（データ確認の警告 GITLAB_USERNAME_DUPLICATE）
 */
export function gitlabUsernameIndex(members: readonly MemberRecord[], month: YearMonth): Map<string, string> {
  const current = currentRecords(members, month);
  const owners = new Map<string, Set<string>>();
  for (const [id, rec] of current) {
    const u = normalizeGitlabUsername(rec.gitlabUsername);
    if (u === "") continue;
    if (!owners.has(u)) owners.set(u, new Set());
    owners.get(u)!.add(id);
  }
  const out = new Map<string, string>();
  for (const [u, ids] of [...owners].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) if (ids.size === 1) out.set(u, [...ids][0]!);
  return out;
}

/** 同じ GitLab のユーザー名が複数の人（社員番号）に付いている組（データ確認の警告用。どの月の行でも） */
export function duplicateGitlabUsernames(members: readonly MemberRecord[]): Array<{ username: string; memberIds: string[] }> {
  const owners = new Map<string, Set<string>>();
  for (const m of members) {
    const u = normalizeGitlabUsername(m.gitlabUsername);
    if (u === "") continue;
    if (!owners.has(u)) owners.set(u, new Set());
    owners.get(u)!.add(m.memberId);
  }
  return [...owners]
    .filter(([, ids]) => ids.size > 1)
    .map(([username, ids]) => ({ username, memberIds: [...ids].sort() }))
    .sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));
}

/** data/my-month.json の中身。ユーザー名のある人だけ */
export function buildMyHoursPayload(input: {
  asOf: string;
  asOfFixed: boolean;
  asOfMonth: YearMonth;
  members: readonly MemberRecord[];
  memberMonths: readonly MemberMonth[];
  contractOf: MyHoursContractOf;
}): MyHoursPayload {
  const months = [input.asOfMonth, addMonths(input.asOfMonth, 1)];
  const users: MyHoursPayload["users"] = {};
  const ids = new Set<string>();
  for (const month of months) {
    const index = gitlabUsernameIndex(input.members, month);
    users[month] = Object.fromEntries(index);
    for (const id of index.values()) ids.add(id);
  }
  const current = currentRecords(input.members, input.asOfMonth);
  const members: MyHoursPayload["members"] = {};
  for (const id of [...ids].sort()) {
    const name = current.get(id)?.name || id;
    const byMonth: Record<YearMonth, MyHoursRow[]> = {};
    for (const month of months) {
      const mm = input.memberMonths.find((x) => x.memberId === id && x.month === month);
      byMonth[month] = myHoursRows(mm, input.contractOf);
    }
    members[id] = { name, months: byMonth };
  }
  return { asOf: input.asOf, asOfFixed: input.asOfFixed, users, members };
}
