import { describe, expect, it } from "vitest";
import { addMemberHours, memberHoursList, type MemberHoursAcc } from "../../src/core/worklogMembers.js";

describe("作業した人のまとめ（§100）", () => {
  it("社員番号の前後の空白は同じ人。名前は最初の空でない表記。時間の多い順・同じなら社員番号順", () => {
    const acc: MemberHoursAcc = new Map();
    addMemberHours(acc, { memberId: "M2", memberName: "", hours: 1, date: "2026-11-02" });
    addMemberHours(acc, { memberId: " M2 ", memberName: "鈴木", hours: 1, date: "2026-05-01" });
    addMemberHours(acc, { memberId: "M1", memberName: "佐藤", hours: 2, date: "2026-05-10" });
    addMemberHours(acc, { memberId: "", memberName: "不明", hours: 0.5, date: "2026-06-01" });
    // 最後の日は人ごと（まとまりの最後の日ではない）
    expect(memberHoursList(acc)).toEqual([
      { memberId: "M1", memberName: "佐藤", hours: 2, count: 1, lastDate: "2026-05-10" },
      { memberId: "M2", memberName: "鈴木", hours: 2, count: 2, lastDate: "2026-11-02" },
      { memberId: "", memberName: "不明", hours: 0.5, count: 1, lastDate: "2026-06-01" },
    ]);
  });
});
