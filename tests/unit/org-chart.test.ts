/**
 * 体制図（SPEC §76）の計算: orgChartAt / loadLevelOf
 */
import { describe, expect, it } from "vitest";
import { buildModel } from "../../src/core/model.js";
import { loadLevelOf, orgChartAt } from "../../src/core/orgChart.js";
import { assignment, contract, dataset, member, rate, rule, team, worklog } from "./fixtures.js";

const ds = dataset({
  contracts: [
    contract({ contractId: "A", customerName: "A社", teamId: "T1", startMonth: "2026-04", endMonth: "2027-03", totalAmount: 1_200_000 }),
    contract({ contractId: "B", customerName: "B社", teamId: "T2", startMonth: "2026-04", endMonth: "2027-03", totalAmount: 1_200_000 }),
    contract({ contractId: "C", customerName: "C社", teamId: "T1", startMonth: "2027-01", endMonth: "2027-03", totalAmount: 300_000 }),
  ],
  mappings: [rule("A社", "", "A"), rule("B社", "", "B")],
  teams: [team("R", null), team("T1", "R"), team("T2", "R")],
  members: [
    member({ memberId: "M1", title: "SE", teamId: "T1", effectiveFrom: "2026-04" }),
    member({ memberId: "M2", title: "SE", teamId: "T2", effectiveFrom: "2026-04" }),
    // M2 は 2026-08 から T1 へ異動
    member({ memberId: "M2", title: "SE", teamId: "T1", effectiveFrom: "2026-08" }),
    member({ memberId: "M3", title: "SE", teamId: null, effectiveFrom: "2026-04" }), // 他部署
    member({ memberId: "M4", title: "SE", teamId: "T2", effectiveFrom: "2026-04" }),
    member({ memberId: "M4", title: "SE", teamId: "T2", effectiveFrom: "2026-07", status: "left" }), // 7月から不在（7月は実績あり）
    member({ memberId: "M5", title: "課長", teamId: "R", effectiveFrom: "2026-04" }),
  ],
  rates: [rate("SE", 1000), rate("課長", 2000)],
  assignments: [
    assignment({ memberId: "M1", contractId: "A", startMonth: "2026-04", endMonth: "2027-03", allocation: 0.8 }),
    assignment({ memberId: "M1", contractId: "B", startMonth: "2026-05", endMonth: "2026-05", allocation: 0.5 }), // 応援の計画
    assignment({ memberId: "M2", contractId: "B", startMonth: "2026-04", endMonth: "2027-03", allocation: 1 }),
  ],
  worklogs: [
    worklog({ date: "2026-05-10", memberId: "M1", hours: 100, customerName: "A社" }),
    worklog({ date: "2026-05-11", memberId: "M1", hours: 40, customerName: "B社" }),
    worklog({ date: "2026-05-12", memberId: "M3", hours: 8, customerName: "A社" }), // ヘルプ
    worklog({ date: "2026-05-13", memberId: "M5", hours: 4, customerName: "A社" }), // 上位の課長は応援にしない
    worklog({ date: "2026-07-01", memberId: "M4", hours: 10, customerName: "B社" }),
    worklog({ date: "2026-05-14", memberId: "X9", memberName: "外部 太郎", hours: 3, customerName: "B社" }), // マスタに無い
  ],
});
const model = buildModel(ds, { asOf: "2026-10-27" });

describe("orgChartAt (SPEC §76 体制図)", () => {
  it("その月の所属で組織に載せ、配下を含む人数を数える", () => {
    const c = orgChartAt(model, "2026-05");
    expect(c.rootTeamIds).toEqual(["R"]);
    expect(c.nodes.T1!.members.map((p) => p.memberId)).toEqual(["M1"]);
    expect(c.nodes.T2!.members.map((p) => p.memberId)).toEqual(["M2", "M4"]);
    expect(c.nodes.R!.members.map((p) => p.memberId)).toEqual(["M5"]);
    expect(c.nodes.R!.totalHeadcount).toBe(4);
  });

  it("own の負荷は全案件の計画・実績（時間）。応援先の案件は support", () => {
    const m1 = orgChartAt(model, "2026-05").nodes.T1!.members[0]!;
    expect(m1.plannedHours).toBeCloseTo((0.8 + 0.5) * 168); // 2026-05 は営業日 21 日 = 168h（§114）;
    expect(m1.actualHours).toBe(140);
    expect(m1.lines.find((l) => l.contractId === "B")).toMatchObject({ support: true, contractTeamId: "T2" });
    expect(m1.lines.find((l) => l.contractId === "A")).toMatchObject({ support: false });
  });

  it("応援・ヘルプは案件の主担当チームのノードに、その案件の分だけ載る。上位の課長は応援にしない", () => {
    const c = orgChartAt(model, "2026-05");
    const t2 = c.nodes.T2!.guests;
    expect(t2.map((g) => [g.memberId, g.origin])).toEqual([["M1", "support"], ["X9", "help"]]);
    expect(t2[0]!.plannedHours).toBeCloseTo(0.5 * 168);
    expect(t2[0]!.actualHours).toBe(40);
    expect(t2[1]!.memberUnknown).toBe(true);
    const t1 = c.nodes.T1!.guests;
    expect(t1.map((g) => [g.memberId, g.origin])).toEqual([["M3", "help"]]);
  });

  it("前月との比較: 異動で加わった人は joined（前月の所属）、抜けた人は left（今月の所属）", () => {
    const c = orgChartAt(model, "2026-08");
    const inT1 = c.nodes.T1!.members.find((p) => p.memberId === "M2")!;
    expect(inT1).toMatchObject({ change: "joined", otherTeamId: "T2" });
    const ghost = c.nodes.T2!.members.find((p) => p.memberId === "M2")!;
    expect(ghost).toMatchObject({ change: "left", otherTeamId: "T1" });
    // 抜けた人は最後に並び、人数に数えない
    expect(c.nodes.T2!.members.at(-1)!.change).toBe("left");
    expect(c.nodes.T2!.headcount).toBe(0);
    expect(c.nodes.T2!.prevHeadcount).toBe(2); // M2（異動）と M4（7月は不在した月で稼働）
  });

  it("不在した月は計画・実績があれば稼働（leaving）、翌月は抜けた人（不在）", () => {
    const jul = orgChartAt(model, "2026-07").nodes.T2!.members.find((p) => p.memberId === "M4")!;
    expect(jul).toMatchObject({ change: null, leaving: true });
    const aug = orgChartAt(model, "2026-08").nodes.T2!.members.find((p) => p.memberId === "M4")!;
    expect(aug).toMatchObject({ change: "left", otherTeamId: null });
    expect(orgChartAt(model, "2026-09").nodes.T2!.members.find((p) => p.memberId === "M4")).toBeUndefined();
  });

  it("担当案件はその月が契約期間内のものだけ", () => {
    expect(orgChartAt(model, "2026-12").nodes.T1!.contractIds).toEqual(["A"]);
    expect(orgChartAt(model, "2027-01").nodes.T1!.contractIds).toEqual(["A", "C"]);
  });

  it("未来の月は計画だけ（実績 0）", () => {
    const m2 = orgChartAt(model, "2027-02").nodes.T1!.members.find((p) => p.memberId === "M2")!;
    expect(m2.plannedHours).toBe(160); // 2027-02 は営業日 20 日 = 160h
    expect(m2.actualHours).toBe(0);
  });
});

describe("loadLevelOf", () => {
  it("1.0 超・1.0・1.0 未満・計画なし", () => {
    expect(loadLevelOf(1.05)).toBe("over");
    expect(loadLevelOf(1)).toBe("full");
    expect(loadLevelOf(0.5)).toBe("under");
    expect(loadLevelOf(0)).toBe("none");
  });
});

describe("orgChartAt: 組織の付け替えとリーダー名（Codex レビュー）", () => {
  const ds2 = dataset({
    contracts: [contract({ contractId: "A", customerName: "A社", teamId: "T1", startMonth: "2026-04", endMonth: "2027-03", totalAmount: 1_200_000 })],
    mappings: [rule("A社", "", "A")],
    teams: [team("R", null), team("PA", "R"), team("PB", "R"), team("T1", "PA", "2000-01"), team("T1", "PB", "2026-09")],
    members: [member({ memberId: "M1", title: "SE", teamId: "T1", effectiveFrom: "2026-04" })],
    rates: [rate("SE", 1000)],
  });
  const m2 = buildModel(ds2, { asOf: "2026-10-27" });

  it("1 人のチームが PA から PB へ移ると、前月比は PA −1・PB +1（前月の木で数える）", () => {
    const c = orgChartAt(m2, "2026-09");
    expect([c.nodes.PA!.totalHeadcount, c.nodes.PA!.prevTotalHeadcount]).toEqual([0, 1]);
    expect([c.nodes.PB!.totalHeadcount, c.nodes.PB!.prevTotalHeadcount]).toEqual([1, 0]);
    expect([c.nodes.R!.totalHeadcount, c.nodes.R!.prevTotalHeadcount]).toEqual([1, 1]);
  });
});
