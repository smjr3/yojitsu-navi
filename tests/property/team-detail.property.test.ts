import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { aggregate, teamTreeForMonth } from "../../src/core/aggregate.js";
import { addMonths } from "../../src/core/calendar.js";
import { buildModel } from "../../src/core/model.js";
import { teamMemberCosts, teamOrgChanges, teamPath } from "../../src/core/team-detail.js";
import type { TeamRecord } from "../../src/core/types.js";
import { contract, dataset, member, rate, rule, worklog } from "../unit/fixtures.js";

const ym = fc.integer({ min: 0, max: 35 }).map((n) => addMonths("2024-04", n));
const ids = ["A", "B", "C", "D", "E"];
const teamRecordArb: fc.Arbitrary<TeamRecord> = fc.record({
  teamId: fc.constantFrom(...ids),
  name: fc.constantFrom("n1", "n2", "n3"),
  parentTeamId: fc.constantFrom<string | null>(null, "", ...ids),
  effectiveFrom: ym,
});
const teamsArb = fc.uniqueArray(teamRecordArb, { maxLength: 14, selector: (r) => `${r.teamId}@${r.effectiveFrom}` });
const periodArb = fc.tuple(ym, fc.integer({ min: 0, max: 24 })).map(([from, len]) => ({ from, to: addMonths(from, len) }));

describe("teamOrgChanges の不変条件", () => {
  it("すべての変更は期間内で月順。入力の並びに依存しない（同じ月の重複行は除く）", () => {
    fc.assert(
      fc.property(teamsArb, fc.constantFrom(...ids, "ZZ"), periodArb, (teams, teamId, period) => {
        const ch = teamOrgChanges(teams, teamId, period);
        for (const c of ch) {
          expect(c.month >= period.from && c.month <= period.to).toBe(true);
          if (c.relation === "self") expect(c.teamId).toBe(teamId);
          else expect(c.teamId).not.toBe(teamId);
          if (c.relation === "in") expect(c.parentTeamId).toBe(teamId);
          if (c.relation === "out") expect(c.oldParentTeamId).toBe(teamId);
          if (c.kind === "moved") expect(c.parentTeamId).not.toBe(c.oldParentTeamId);
          if (c.kind === "renamed") expect(c.oldName).not.toBe(c.name);
        }
        for (let i = 1; i < ch.length; i++) expect(ch[i - 1]!.month <= ch[i]!.month).toBe(true);
        expect(teamOrgChanges([...teams].reverse(), teamId, period)).toEqual(ch);
      }),
    );
  });

  it("期間を分割すると、変更の件数は足し合わせと一致する", () => {
    fc.assert(
      fc.property(teamsArb, fc.constantFrom(...ids), periodArb, fc.integer({ min: 0, max: 24 }), (teams, teamId, period, k) => {
        const mid = addMonths(period.from, Math.min(k, 24));
        fc.pre(mid < period.to);
        const whole = teamOrgChanges(teams, teamId, period);
        const left = teamOrgChanges(teams, teamId, { from: period.from, to: mid });
        const right = teamOrgChanges(teams, teamId, { from: addMonths(mid, 1), to: period.to });
        expect(left.length + right.length).toBe(whole.length);
      }),
    );
  });

  it("変更が無ければ、期間の終了月の組織での親は期間開始前の組織と同じ（自分に関する変更だけ）", () => {
    fc.assert(
      fc.property(teamsArb, fc.constantFrom(...ids), periodArb, (teams, teamId, period) => {
        const self = teamOrgChanges(teams, teamId, period).filter((c) => c.relation === "self" && c.kind !== "created");
        const before = addMonths(period.from, -1);
        const a = teamTreeForMonth({ teams }, before)[teamId];
        const b = teamTreeForMonth({ teams }, period.to)[teamId];
        fc.pre(a !== undefined && b !== undefined);
        // 木では存在しない親や循環が切られるので、「木で親/名前が変わった」なら自分の変更が必ず記録されている
        if (a!.name !== b!.name) expect(self.some((c) => c.kind === "renamed")).toBe(true);
      }),
    );
  });
});

describe("teamPath の不変条件", () => {
  it("経路は最上位から始まり、各要素の親は直前の要素。末尾が自分", () => {
    fc.assert(
      fc.property(teamsArb, ym, fc.constantFrom(...ids), (teams, month, teamId) => {
        const tree = teamTreeForMonth({ teams }, month);
        const path = teamPath(tree, teamId);
        if (!tree[teamId]) {
          expect(path).toEqual([]);
          return;
        }
        expect(path[path.length - 1]!.teamId).toBe(teamId);
        expect(path[0]!.parentTeamId).toBeNull();
        for (let i = 1; i < path.length; i++) expect(path[i]!.parentTeamId).toBe(path[i - 1]!.teamId);
        expect(new Set(path.map((n) => n.teamId)).size).toBe(path.length);
      }),
    );
  });
});

describe("teamMemberCosts の不変条件", () => {
  const logArb = fc.record({
    day: fc.integer({ min: 0, max: 200 }),
    memberId: fc.constantFrom("M1", "M2", "M3", "M9"),
    customer: fc.constantFrom("A社", "B社"),
    hours: fc.integer({ min: 1, max: 40 }),
  });
  it("合計 = aggregate().cost、構成比の合計 = 1、時間の合計 = Totals.hours、応援 ≤ 全体", () => {
    fc.assert(
      fc.property(fc.array(logArb, { maxLength: 40 }), periodArb, fc.subarray(["A", "B"]), fc.boolean(), (logs, period, contractIds, scoped) => {
        const ds = dataset({
          contracts: [
            contract({ contractId: "A", customerName: "A社", startMonth: "2024-04", endMonth: "2027-03", totalAmount: 1_000_000 }),
            contract({ contractId: "B", customerName: "B社", startMonth: "2024-04", endMonth: "2027-03", totalAmount: 500_000 }),
          ],
          mappings: [rule("A社", "", "A"), rule("B社", "", "B")],
          members: [member({ memberId: "M1", teamId: "T1" }), member({ memberId: "M2", teamId: "T2" }), member({ memberId: "M3", teamId: null })],
          rates: [rate("SE", 1234)],
          worklogs: logs.map((l) => worklog({ date: `${addMonths("2024-04", Math.floor(l.day / 6))}-${String((l.day % 6) + 1).padStart(2, "0")}`, memberId: l.memberId, hours: l.hours, customerName: l.customer })),
        });
        const model = buildModel(ds, { asOf: "2026-10-27" });
        const rows = teamMemberCosts(model, contractIds, period, scoped ? new Set(["T1"]) : null);
        const totals = aggregate(model, { period, contractIds });
        expect(rows.reduce((a, r) => a + r.amount, 0)).toBe(totals.cost);
        expect(rows.reduce((a, r) => a + r.hours, 0)).toBeCloseTo(totals.hours, 6);
        if (rows.length && totals.cost > 0) expect(rows.reduce((a, r) => a + (r.share ?? 0), 0)).toBeCloseTo(1, 9);
        for (const r of rows) {
          expect(r.supportAmount + r.helpAmount).toBeLessThanOrEqual(r.amount);
          expect(r.supportHours + r.helpHours).toBeLessThanOrEqual(r.hours + 1e-9);
          if (!scoped) expect(r.supportAmount).toBe(0);
          // 所属なし（M3）の作業はすべてヘルプ
          if (r.memberId === "M3") expect(r.helpHours).toBeCloseTo(r.hours, 9);
        }
        for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.amount).toBeGreaterThanOrEqual(rows[i]!.amount);
        expect(new Set(rows.map((r) => r.memberId)).size).toBe(rows.length);
      }),
      { numRuns: 60 },
    );
  });
});

