/**
 * メンバー別でチームを選んだときの応援・ヘルプ（SPEC §134）: teamGuests / teamGuestsOf / mergeMemberAggregates / planGaps の guests
 */
import { describe, expect, it } from "vitest";
import { buildModel } from "../../src/core/model.js";
import { aggregateMembers, mergeMemberAggregates, teamGuests, teamGuestsOf } from "../../src/core/members.js";
import { planGaps } from "../../src/core/planGaps.js";
import { ownTeamScope } from "../../src/core/team-detail.js";
import { teamTreeForMonth } from "../../src/core/index.js";
import type { Model } from "../../src/core/types.js";
import { assignment, contract, dataset, member, rate, rule, team, worklog } from "./fixtures.js";

const P = { from: "2026-04", to: "2026-09" } as const;

/** 部 D の下に T1・T2。C1 = T1 の案件、C2 = T2 の案件。M1（T1）・M2（T2・C1 に計画あり）・M3（T2・C1 は実績だけ）・M4（所属なし）・M9（マスタに無い）・L（部 D の部長） */
function model(): Model {
  return buildModel(
    dataset({
      contracts: [
        contract({ contractId: "C1", customerName: "ABC株式会社", startMonth: "2026-04", endMonth: "2027-03", teamId: "T1" }),
        contract({ contractId: "C2", customerName: "XYZ株式会社", startMonth: "2026-04", endMonth: "2027-03", teamId: "T2" }),
      ],
      mappings: [rule("ABC株式会社", "", "C1"), rule("XYZ株式会社", "", "C2")],
      teams: [team("D", null), team("T1", "D"), team("T2", "D")],
      members: [
        member({ memberId: "M1", teamId: "T1" }),
        member({ memberId: "M2", teamId: "T2" }),
        member({ memberId: "M3", teamId: "T2" }),
        member({ memberId: "M4", teamId: null }),
        member({ memberId: "L", teamId: "D" }),
      ],
      rates: [rate("SE", 5000)],
      assignments: [
        assignment({ memberId: "M1", contractId: "C1", allocation: 1 }),
        assignment({ memberId: "M2", contractId: "C1", allocation: 0.2 }),
        assignment({ memberId: "M2", contractId: "C2", allocation: 0.8 }),
        assignment({ memberId: "M3", contractId: "C2", allocation: 1 }),
      ],
      worklogs: [
        worklog({ date: "2026-05-11", memberId: "M1", hours: 100 }),
        worklog({ date: "2026-05-11", memberId: "M2", hours: 20 }),
        worklog({ date: "2026-05-12", memberId: "M2", hours: 80, customerName: "XYZ株式会社" }),
        worklog({ date: "2026-05-11", memberId: "M3", hours: 5 }),
        worklog({ date: "2026-05-12", memberId: "M3", hours: 100, customerName: "XYZ株式会社" }),
        worklog({ date: "2026-05-13", memberId: "M4", hours: 7 }),
        worklog({ date: "2026-05-13", memberId: "M9", hours: 3 }),
        worklog({ date: "2026-05-14", memberId: "L", hours: 4 }),
      ],
    }),
    { asOf: "2026-10-27", generatedAt: "x" },
  );
}

const tree = (m: Model) => teamTreeForMonth({ teams: m.teams }, "2026-09");

describe("teamGuests（§134）", () => {
  it("チームの案件に入った他チームの人は応援（計画の有無つき）、所属の無い人・マスタに無い人はヘルプ。上位の組織の人は対象外", () => {
    const m = model();
    const g = teamGuests(m, { period: P, contractIds: ["C1"], ownScope: ownTeamScope(tree(m), "T1") });
    expect(g).toEqual([
      { memberId: "M2", origin: "support", planned: true },
      { memberId: "M3", origin: "support", planned: false },
      { memberId: "M4", origin: "help", planned: false },
      { memberId: "M9", origin: "help", planned: false },
    ]);
  });

  it("担当組織が空（チームが組織に無い）・案件が無ければ空", () => {
    const m = model();
    expect(teamGuests(m, { period: P, contractIds: ["C1"], ownScope: new Set() })).toEqual([]);
    expect(teamGuests(m, { period: P, contractIds: [], ownScope: ownTeamScope(tree(m), "T1") })).toEqual([]);
    expect(teamGuestsOf([], ownTeamScope(tree(m), "T1"))).toEqual([]);
  });
});

describe("mergeMemberAggregates（§134）", () => {
  it("所属メンバーの全体＋応援の人のチームの案件の分。合計・人数・稼働率を合わせ直す", () => {
    const m = model();
    const own = aggregateMembers(m, { period: P, memberIds: ["M1"] });
    const guest = aggregateMembers(m, { period: P, memberIds: ["M2"], contractIds: ["C1"] });
    expect(guest.members[0]!.actualHours).toBe(20);
    const merged = mergeMemberAggregates(own, guest);
    expect(merged.members.map((x) => x.memberId)).toEqual(["M1", "M2"]);
    expect(merged.total.memberCount).toBe(2);
    expect(merged.total.actualHours).toBe(120);
    expect(merged.total.actualCost).toBe(own.total.actualCost + guest.total.actualCost);
    expect(merged.total.plannedHours).toBeCloseTo(own.total.plannedHours + guest.total.plannedHours, 6);
    expect(merged.total.variance).toBe(merged.total.plannedCost - merged.total.actualCost);
    expect(merged.total.utilization).toBeCloseTo(merged.total.actualHours / merged.total.plannedHours, 9);
  });

  it("b のうち a にいる人は足さない。足す人がいなければ a のまま", () => {
    const m = model();
    const own = aggregateMembers(m, { period: P, memberIds: ["M1"] });
    expect(mergeMemberAggregates(own, aggregateMembers(m, { period: P, memberIds: ["M1"], contractIds: ["C1"] }))).toBe(own);
  });
});

describe("planGaps の guests（§134）", () => {
  it("応援の人はチームの案件の分だけ判定する（所属チームの案件のずれは出さない）", () => {
    const m = model();
    const g = planGaps(m, { period: P, memberIds: ["M1"], guests: { memberIds: ["M2"], contractIds: ["C1"] } });
    const ids = new Set(g.rows.map((r) => `${r.memberId}/${r.contractId}`));
    for (const k of ids) expect(["M1/C1", "M2/C1"]).toContain(k);
    const all = planGaps(m, { period: P, memberIds: ["M1", "M2"] });
    expect(all.rows.some((r) => r.memberId === "M2" && r.contractId === "C2")).toBe(true);
  });
});
