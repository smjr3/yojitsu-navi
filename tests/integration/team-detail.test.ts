/**
 * チーム詳細: ダミーデータ全体（data/, asOf=2026-10-27）で、組織の変遷・メンバー別原価・上位チームの経路の整合を確かめる
 */
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { UNASSIGNED_TEAM_ID, aggregate, contractsForTeam, teamTreeForMonth } from "../../src/core/aggregate.js";
import { buildModel } from "../../src/core/model.js";
import { teamMemberCosts, teamOrgChanges, teamPath } from "../../src/core/team-detail.js";
import type { Model, Period } from "../../src/core/types.js";
import { loadDataset } from "../../scripts/lib/load.js";

const REPO = join(import.meta.dirname, "..", "..");
const FY: Period = { from: "2026-04", to: "2027-03" };
let model: Model;

beforeAll(() => {
  model = buildModel(loadDataset(REPO).dataset, { asOf: "2026-10-27" });
});

describe("ダミーデータのチーム詳細", () => {
  it("T212 は 2026-10 に S21 から S22 へ移り、S21 は out、S22 は in として現れる", () => {
    const self = teamOrgChanges(model.teams, "T212", FY);
    expect(self).toHaveLength(1);
    expect(self[0]).toMatchObject({ month: "2026-10", kind: "moved", relation: "self", oldParentTeamId: "S21", parentTeamId: "S22" });
    expect(teamOrgChanges(model.teams, "S21", FY).map((c) => [c.teamId, c.relation])).toEqual([["T212", "out"]]);
    expect(teamOrgChanges(model.teams, "S22", FY).map((c) => [c.teamId, c.relation])).toEqual([["T212", "in"]]);
    expect(teamOrgChanges(model.teams, "T111", FY)).toEqual([]);
    expect(teamOrgChanges(model.teams, "T212", { from: "2025-04", to: "2026-09" })).toEqual([]);
  });

  it("変更の前後の組織木（teamTreeForMonth）と変遷の記録が一致する", () => {
    const before = teamTreeForMonth({ teams: model.teams }, "2026-09");
    const after = teamTreeForMonth({ teams: model.teams }, "2026-10");
    expect(before.T212!.parentTeamId).toBe("S21");
    expect(after.T212!.parentTeamId).toBe("S22");
    expect(teamPath(after, "T212").map((n) => n.teamId)).toEqual(["HQ", "D2", "S22", "T212"]);
    expect(teamPath(before, "T212").map((n) => n.teamId)).toEqual(["HQ", "D2", "S21", "T212"]);
  });

  it("全チーム・未設定・全体でメンバー別原価の合計が集計の原価と一致する", () => {
    const tree = teamTreeForMonth({ teams: model.teams }, "2026-10");
    for (const id of [...Object.keys(tree), UNASSIGNED_TEAM_ID]) {
      const ids = contractsForTeam(model, id, tree).map((c) => c.contractId);
      const rows = teamMemberCosts(model, ids, FY, tree[id] ? new Set(tree[id]!.descendantIds) : null);
      expect(rows.reduce((a, r) => a + r.amount, 0), id).toBe(aggregate(model, { period: FY, contractIds: ids }).cost);
      expect(rows.reduce((a, r) => a + r.hours, 0)).toBeCloseTo(aggregate(model, { period: FY, contractIds: ids }).hours, 6);
    }
  });

  it("上位チームのメンバー別原価は、直下の子の人の原価を含む（作業実績の和集合）", () => {
    const tree = teamTreeForMonth({ teams: model.teams }, "2026-10");
    const ids = (id: string) => contractsForTeam(model, id, tree).map((c) => c.contractId);
    const parent = new Map(teamMemberCosts(model, ids("D2"), FY).map((r) => [r.memberId, r.amount]));
    for (const child of tree.D2!.children) {
      for (const r of teamMemberCosts(model, ids(child), FY)) expect(parent.get(r.memberId) ?? 0).toBeGreaterThanOrEqual(r.amount);
    }
  });
});
