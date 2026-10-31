import { describe, expect, it } from "vitest";
import { aggregate, teamTreeForMonth } from "../../src/core/aggregate.js";
import { buildModel } from "../../src/core/model.js";
import { contractOwnScopes, originTotals, ownTeamScope, teamMemberCosts, teamOrgChanges, teamPath, workOriginOf } from "../../src/core/team-detail.js";
import type { TeamRecord } from "../../src/core/types.js";
import { contract, dataset, member, rate, rule, team, worklog } from "./fixtures.js";

const rec = (teamId: string, name: string, parent: string | null, effectiveFrom: string): TeamRecord => ({ teamId, name, parentTeamId: parent, effectiveFrom });

describe("teamOrgChanges (SPEC §16 組織の変遷)", () => {
  const teams = [
    rec("HQ", "本部", null, "2025-04"),
    rec("D1", "第1事業部", "HQ", "2025-04"),
    rec("D2", "第2事業部", "HQ", "2025-04"),
    rec("T1", "Aチーム", "D1", "2025-04"),
    rec("T2", "Bチーム", "D1", "2025-04"),
    rec("T1", "Aチーム", "D2", "2026-10"), // T1 が D1 → D2 へ
    rec("T2", "Bチーム改", "D1", "2026-06"), // T2 の改名
    rec("T3", "Cチーム", "D1", "2026-08"), // 新設
  ];
  const period = { from: "2026-04", to: "2027-03" };

  it("自分の付け替え: 月・旧親・新親・名前を持つ", () => {
    const ch = teamOrgChanges(teams, "T1", period);
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ month: "2026-10", teamId: "T1", kind: "moved", relation: "self", parentTeamId: "D2", parentName: "第2事業部", oldParentTeamId: "D1", oldParentName: "第1事業部" });
  });

  it("自分の改名は旧名・新名", () => {
    const ch = teamOrgChanges(teams, "T2", period);
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ month: "2026-06", kind: "renamed", relation: "self", oldName: "Bチーム", name: "Bチーム改" });
  });

  it("配下に入った・出た・新設は relation で区別される。月順", () => {
    const d1 = teamOrgChanges(teams, "D1", period);
    expect(d1.map((c) => [c.month, c.teamId, c.kind, c.relation])).toEqual([
      ["2026-08", "T3", "created", "in"],
      ["2026-10", "T1", "moved", "out"],
    ]);
    const d2 = teamOrgChanges(teams, "D2", period);
    expect(d2.map((c) => [c.teamId, c.kind, c.relation])).toEqual([["T1", "moved", "in"]]);
  });

  it("期間外の変更・最初の登録・無関係なチームは出ない", () => {
    expect(teamOrgChanges(teams, "T1", { from: "2025-04", to: "2026-09" })).toEqual([]);
    expect(teamOrgChanges(teams, "HQ", period)).toEqual([]);
    expect(teamOrgChanges(teams, "NOPE", period)).toEqual([]);
    expect(teamOrgChanges([], "T1", period)).toEqual([]);
  });

  it("期間の端（from と to の月）の変更は含む", () => {
    expect(teamOrgChanges(teams, "T1", { from: "2026-10", to: "2026-10" })).toHaveLength(1);
    expect(teamOrgChanges(teams, "T1", { from: "2026-11", to: "2027-03" })).toHaveLength(0);
  });

  it("名前も親も同じ再登録は変更ではない。親 '' と null は同じ", () => {
    const t = [rec("A", "A", null, "2025-04"), rec("A", "A", null, "2026-05"), rec("B", "B", "", "2025-04"), rec("B", "B", null, "2026-05")];
    expect(teamOrgChanges(t, "A", period)).toEqual([]);
    expect(teamOrgChanges(t, "B", period)).toEqual([]);
  });

  it("改名と付け替えが同じ月なら 2 件（改名 → 付け替え）", () => {
    const t = [rec("P", "P", null, "2025-04"), rec("Q", "Q", null, "2025-04"), rec("X", "旧", "P", "2025-04"), rec("X", "新", "Q", "2026-07")];
    const ch = teamOrgChanges(t, "X", period);
    expect(ch.map((c) => c.kind)).toEqual(["renamed", "moved"]);
  });

  it("最上位に出た付け替えは親 null", () => {
    const t = [rec("P", "P", null, "2025-04"), rec("X", "X", "P", "2025-04"), rec("X", "X", null, "2026-07")];
    expect(teamOrgChanges(t, "X", period)[0]).toMatchObject({ kind: "moved", parentTeamId: null, parentName: null, oldParentTeamId: "P", oldParentName: "P" });
  });

  it("入力の並び順や同月の重複行に依存しない（同月は後の行が有効）", () => {
    const shuffled = [...teams].reverse();
    expect(teamOrgChanges(shuffled, "D1", period)).toEqual(teamOrgChanges(teams, "D1", period));
    const dup = [...teams, rec("T1", "Aチーム", "D1", "2026-10")]; // 同月の後ろの行で D1 に戻る → 変更なし
    expect(teamOrgChanges(dup, "T1", period)).toEqual([]);
  });
});

describe("teamPath", () => {
  const tree = teamTreeForMonth({ teams: [team("R", null), team("A", "R"), team("B", "A")] }, "2026-10");
  it("最上位から自分まで", () => {
    expect(teamPath(tree, "B").map((n) => n.teamId)).toEqual(["R", "A", "B"]);
    expect(teamPath(tree, "R").map((n) => n.teamId)).toEqual(["R"]);
  });
  it("木に無ければ空", () => {
    expect(teamPath(tree, "NOPE")).toEqual([]);
  });
  it("親リンクが循環していても止まる", () => {
    const loop = { A: { ...tree.A!, parentTeamId: "B" }, B: { ...tree.B!, parentTeamId: "A" } };
    expect(teamPath(loop, "A").map((n) => n.teamId).sort()).toEqual(["A", "B"]);
  });
});

describe("teamMemberCosts (作業実績軸)", () => {
  const ds = dataset({
    contracts: [
      contract({ contractId: "A", customerName: "A社", teamId: "T1", startMonth: "2026-04", endMonth: "2027-03", totalAmount: 1_200_000 }),
      contract({ contractId: "B", customerName: "B社", teamId: "T2", startMonth: "2026-04", endMonth: "2027-03", totalAmount: 1_200_000 }),
    ],
    mappings: [rule("A社", "", "A"), rule("B社", "", "B")],
    teams: [team("R", null), team("T1", "R"), team("T2", "R")],
    members: [member({ memberId: "M1", title: "SE", teamId: "T1" }), member({ memberId: "M2", title: "SE", teamId: "T2" }), member({ memberId: "M3", title: "SE", teamId: null })],
    rates: [rate("SE", 1000)],
    worklogs: [
      worklog({ date: "2026-05-10", memberId: "M1", hours: 10, customerName: "A社" }),
      worklog({ date: "2026-06-10", memberId: "M1", hours: 5, customerName: "A社" }),
      worklog({ date: "2026-05-11", memberId: "M2", hours: 20, customerName: "A社" }), // 他チームの応援
      worklog({ date: "2026-05-12", memberId: "M3", hours: 1, customerName: "A社" }), // 所属なし
      worklog({ date: "2026-05-12", memberId: "M1", hours: 100, customerName: "B社" }), // 別チームの契約
    ],
  });
  const model = buildModel(ds, { asOf: "2026-10-27" });
  const period = { from: "2026-04", to: "2026-09" };

  it("所属に関わらず契約に工数を付けた人を、原価の大きい順に返す", () => {
    const rows = teamMemberCosts(model, ["A"], period);
    expect(rows.map((r) => [r.memberId, r.hours, r.amount])).toEqual([
      ["M2", 20, 20_000],
      ["M1", 15, 15_000],
      ["M3", 1, 1_000],
    ]);
    expect(rows[1]).toMatchObject({ monthCount: 2, contractIds: ["A"], teamIds: ["T1"] });
    expect(rows[0]!.share).toBeCloseTo(20_000 / 36_000);
  });

  it("合計は aggregate().cost と一致する", () => {
    for (const ids of [["A"], ["B"], ["A", "B"], []]) {
      const sum = teamMemberCosts(model, ids, period).reduce((a, r) => a + r.amount, 0);
      expect(sum).toBe(aggregate(model, { period, contractIds: ids }).cost);
    }
  });

  it("teamScope を渡すと所属が外の作業を応援、所属なしをヘルプとして数える（§72）", () => {
    const rows = teamMemberCosts(model, ["A"], period, new Set(["T1"]));
    const by = Object.fromEntries(rows.map((r) => [r.memberId, r]));
    expect(by.M1).toMatchObject({ supportHours: 0, supportAmount: 0, helpHours: 0, helpAmount: 0 });
    expect(by.M2).toMatchObject({ supportHours: 20, supportAmount: 20_000, helpHours: 0 });
    expect(by.M3).toMatchObject({ supportHours: 0, helpHours: 1, helpAmount: 1_000, memberUnknown: false });
    // teamScope なし: 応援は判定しないが、所属なしはヘルプ
    const plain = Object.fromEntries(teamMemberCosts(model, ["A"], period).map((r) => [r.memberId, r]));
    expect(plain.M2!.supportHours).toBe(0);
    expect(plain.M3!.helpHours).toBe(1);
    expect(originTotals(rows)).toEqual({ supportHours: 20, supportAmount: 20_000, helpHours: 1, helpAmount: 1_000 });
  });

  it("契約ごとの担当組織で応援を判定できる（顧客詳細 §74）。合計は案件ごとの合計と一致", () => {
    const scopes = contractOwnScopes(model, model.teamTree);
    expect([...scopes("A")!].sort()).toEqual(["R", "T1"]);
    expect([...scopes("B")!].sort()).toEqual(["R", "T2"]);
    expect(scopes("ZZ")).toBeNull();
    const rows = teamMemberCosts(model, ["A", "B"], period, scopes);
    const by = Object.fromEntries(rows.map((r) => [r.memberId, r]));
    // M1 は A では自チーム、B では応援。M2 は A で応援
    expect(by.M1).toMatchObject({ hours: 115, contractIds: ["A", "B"], supportHours: 100, supportAmount: 100_000 });
    expect(by.M2).toMatchObject({ supportHours: 20 });
    const each = ["A", "B"].map((id) => originTotals(teamMemberCosts(model, [id], period, ownTeamScope(model.teamTree, model.contracts.find((r) => r.contract.contractId === id)!.contract.teamId))));
    const t = originTotals(rows);
    expect(t.supportAmount).toBe(each[0]!.supportAmount + each[1]!.supportAmount);
    expect(t.helpAmount).toBe(each[0]!.helpAmount + each[1]!.helpAmount);
    expect(rows.reduce((a, r) => a + r.amount, 0)).toBe(aggregate(model, { period, contractIds: ["A", "B"] }).cost);
  });

  it("使った単価と、ヘルプの人の部・課（当時）を返す。メンバーマスタに無い人もヘルプ", () => {
    const ds2 = dataset({
      contracts: [contract({ contractId: "A", customerName: "A社", teamId: "T1", startMonth: "2026-04", endMonth: "2027-03", totalAmount: 1_200_000 })],
      mappings: [rule("A社", "", "A")],
      teams: [team("R", null), team("T1", "R")],
      members: [
        member({ memberId: "H1", title: "SE", teamId: null, department: "構築部", section: "基盤課" }),
        member({ memberId: "H1", title: "SE", teamId: null, department: "構築部", section: "NW課", effectiveFrom: "2026-06" }),
      ],
      rates: [rate("SE", 1000)],
      worklogs: [
        worklog({ date: "2026-05-10", memberId: "H1", hours: 2, customerName: "A社" }),
        worklog({ date: "2026-06-10", memberId: "H1", hours: 3, customerName: "A社" }),
        worklog({ date: "2026-06-11", memberId: "X9", memberName: "臨時", hours: 4, customerName: "A社" }),
      ],
    });
    const m2 = buildModel(ds2, { asOf: "2026-10-27" });
    const rows = teamMemberCosts(m2, ["A"], period, ownTeamScope(m2.teamTree, "T1"));
    const by = Object.fromEntries(rows.map((r) => [r.memberId, r]));
    expect(by.H1).toMatchObject({ helpHours: 5, helpAmount: 5_000, rates: [1000], orgLabels: ["構築部 NW課", "構築部 基盤課"], memberUnknown: false });
    expect(by.X9).toMatchObject({ helpHours: 4, helpAmount: 0, memberUnknown: true, orgLabels: [] });
  });

  it("ownTeamScope は配下と上位を含む（課長・部長の作業を応援にしない）", () => {
    const tree = model.teamTree;
    expect([...ownTeamScope(tree, "T1")].sort()).toEqual(["R", "T1"]);
    expect([...ownTeamScope(tree, "R")].sort()).toEqual(["R", "T1", "T2"]);
    expect(ownTeamScope(tree, "").size).toBe(0);
    expect(ownTeamScope(tree, "ZZ").size).toBe(0);
    expect(workOriginOf(null, null)).toBe("help");
    expect(workOriginOf("T2", new Set(["T1"]))).toBe("support");
    expect(workOriginOf("T2", new Set())).toBe("own");
    expect(workOriginOf("T1", new Set(["T1"]))).toBe("own");
  });

  it("期間で絞る・契約が空・作業なしは空配列", () => {
    expect(teamMemberCosts(model, ["A"], { from: "2026-06", to: "2026-06" }).map((r) => r.memberId)).toEqual(["M1"]);
    expect(teamMemberCosts(model, [], period)).toEqual([]);
    expect(teamMemberCosts(model, ["A"], { from: "2027-01", to: "2027-02" })).toEqual([]);
  });

  it("単価なしのメンバーは rateMissing", () => {
    const m2 = buildModel(dataset({ ...ds, rates: [] }), { asOf: "2026-10-27" });
    expect(teamMemberCosts(m2, ["A"], period).every((r) => r.rateMissing)).toBe(true);
  });
});
