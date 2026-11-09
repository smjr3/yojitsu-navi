/**
 * データ確認の作業実績のまとまりに「誰の作業か」を付ける（SPEC §100）。
 * まとまりごとに社員番号 → 時間・件数を足し、最後に時間の多い順の配列にする。
 */
import type { ISODate, WorklogMemberHours } from "./types.js";

/** まとまり 1 つ分の集計 */
export type MemberHoursAcc = Map<string, WorklogMemberHours>;

/** 作業 1 行を足す。社員番号は前後の空白を除いて比べる（空なら空のまま 1 人として数える） */
export function addMemberHours(acc: MemberHoursAcc, w: { memberId: string; memberName: string; hours: number; date: string }): void {
  const id = (w.memberId ?? "").trim();
  const hit = acc.get(id);
  if (hit) {
    hit.hours += w.hours;
    hit.count += 1;
    if (hit.memberName === "" && w.memberName) hit.memberName = w.memberName.trim();
    if (w.date > hit.lastDate) hit.lastDate = w.date as ISODate;
  } else acc.set(id, { memberId: id, memberName: (w.memberName ?? "").trim(), hours: w.hours, count: 1, lastDate: w.date as ISODate });
}

/** 時間の多い順（同じなら社員番号の昇順。ロケール非依存） */
export function memberHoursList(acc: MemberHoursAcc): WorklogMemberHours[] {
  return [...acc.values()].sort((a, b) => b.hours - a.hours || (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
}
