/**
 * 一時不在と終了の区別（SPEC §155）
 *   - members.csv の status の値で見分ける（「休」「一時」を含めば一時不在、ほかは終了）。値は書き換えない
 *   - メンバー別・リソース計画の行に leftKind、体制図は一時不在の人を元の所属に薄く残す（人数に数えない）
 */
import { describe, expect, it } from "vitest";
import { T } from "../../src/i18n/index.js";
import { memberStatus } from "../../src/core/csv.js";
import { leaveKindOf } from "../../src/core/masters.js";
import { parseMasterDoc, planSourcesFromDocs } from "../../src/core/masterEdit.js";
import { planView } from "../../src/core/plan.js";
import { buildModel } from "../../src/core/model.js";
import { aggregateMembers } from "../../src/core/members.js";
import { orgChartAt } from "../../src/core/orgChart.js";
import { memberLeaveKindAt } from "../../src/core/workTypes.js";
import { contract, dataset, member, rate, rule, team, worklog } from "./fixtures.js";

describe("memberStatus の種類（§155）", () => {
  it.each(["休職", "育休", "産休", "介護休業", "一時不在", "休み中", "ｷｭｳｼｮｸ休"])("%s は一時不在", (v) => {
    expect(memberStatus(v)).toEqual({ status: "left", leave: "temporary" });
  });
  it.each(["退職", "契約終了", "終了", "異動で外れた", "left", "x"])("%s は終了", (v) => {
    expect(memberStatus(v)).toEqual({ status: "left", leave: "permanent" });
  });
  it("空・在籍・active は在籍（種類なし）", () => {
    for (const v of ["", " ", "在籍", "ACTIVE"]) expect(memberStatus(v)).toEqual({});
  });
  it("画面で選ぶ値（言葉）は、そのまま書いても同じ種類に読める", () => {
    expect(memberStatus(T.members.leave.temporary).leave).toBe("temporary");
    expect(memberStatus(T.members.leave.permanent).leave).toBe("permanent");
    expect(T.members.leave).toEqual({ temporary: "一時不在", permanent: "終了" });
  });
  it("leaveKindOf: 種類の無い古い不在の行は終了、在籍の行は null", () => {
    expect(leaveKindOf({ status: "left" })).toBe("permanent");
    expect(leaveKindOf({ status: "left", leave: "temporary" })).toBe("temporary");
    expect(leaveKindOf({})).toBeNull();
    expect(leaveKindOf(null)).toBeNull();
  });
});

const ds = () =>
  dataset({
    teams: [team("R", null), team("T1", "R")],
    contracts: [contract({ contractId: "A", customerName: "A社", teamId: "T1", startMonth: "2026-04", endMonth: "2027-03" })],
    mappings: [rule("A社", "", "A")],
    members: [
      member({ memberId: "M1", title: "SE", teamId: "T1", effectiveFrom: "2026-04" }),
      member({ memberId: "M2", title: "SE", teamId: "T1", effectiveFrom: "2026-04" }),
      member({ memberId: "M2", title: "SE", teamId: "T1", effectiveFrom: "2026-06", ...memberStatus("育休") }),
      member({ memberId: "M3", title: "SE", teamId: "T1", effectiveFrom: "2026-04" }),
      member({ memberId: "M3", title: "SE", teamId: "T1", effectiveFrom: "2026-06", ...memberStatus("退職") }),
      // 一時不在の後に終了
      member({ memberId: "M4", title: "SE", teamId: "T1", effectiveFrom: "2026-04" }),
      member({ memberId: "M4", title: "SE", teamId: "T1", effectiveFrom: "2026-06", ...memberStatus("休職") }),
      member({ memberId: "M4", title: "SE", teamId: "T1", effectiveFrom: "2026-09", ...memberStatus("退職") }),
    ],
    rates: [rate("SE", 1000)],
    // メンバー別は実績のある人だけ
    worklogs: ["M1", "M2", "M3", "M4"].map((memberId) => worklog({ date: "2026-04-10", memberId, hours: 8, customerName: "A社" })),
  });

describe("メンバー別・稼働実績の種類（§155）", () => {
  const model = buildModel(ds(), { asOf: "2026-10-27" });
  const at = (to: string) => aggregateMembers(model, { period: { from: "2026-04", to } }).members;
  it("基準月の不在の行の種類を leftKind に。在籍なら null", () => {
    const rows = at("2026-07");
    expect(rows.find((r) => r.memberId === "M1")).toMatchObject({ leftFrom: null, leftKind: null });
    expect(rows.find((r) => r.memberId === "M2")).toMatchObject({ leftFrom: "2026-06", leftKind: "temporary" });
    expect(rows.find((r) => r.memberId === "M3")).toMatchObject({ leftFrom: "2026-06", leftKind: "permanent" });
    expect(rows.find((r) => r.memberId === "M4")).toMatchObject({ leftFrom: "2026-06", leftKind: "temporary" });
    // 一時不在の後に終了したら終了（不在になった月は最初の不在の月のまま）
    expect(at("2026-10").find((r) => r.memberId === "M4")).toMatchObject({ leftFrom: "2026-06", leftKind: "permanent" });
  });
  it("memberLeaveKindAt は基準月の種類", () => {
    expect(memberLeaveKindAt(model, "M4", "2026-07")).toBe("temporary");
    expect(memberLeaveKindAt(model, "M4", "2026-09")).toBe("permanent");
    expect(memberLeaveKindAt(model, "M1", "2026-07")).toBeNull();
  });
});

describe("体制図の一時不在（§155）", () => {
  const model = buildModel(ds(), { asOf: "2026-10-27" });
  it("一時不在の人は稼働しない月も元の所属に away で残る（人数に数えない）。終了した人は従来どおり翌月から出ない", () => {
    const jun = orgChartAt(model, "2026-06").nodes.T1!;
    expect(jun.members.find((p) => p.memberId === "M2")).toMatchObject({ change: "away", leave: "temporary", leaving: false });
    expect(jun.members.find((p) => p.memberId === "M3")).toMatchObject({ change: "left", leave: "permanent" });
    expect(jun.headcount).toBe(1);
    const aug = orgChartAt(model, "2026-08").nodes.T1!;
    expect(aug.members.find((p) => p.memberId === "M2")!.change).toBe("away");
    expect(aug.members.find((p) => p.memberId === "M3")).toBeUndefined();
    expect(aug.headcount).toBe(1);
    // 並びは 在籍 → 一時不在 → 抜けた人
    expect(jun.members.map((p) => p.change)).toEqual([null, "away", "away", "left"]);
  });
  it("一時不在の後に終了したら、その月から出ない", () => {
    expect(orgChartAt(model, "2026-09").nodes.T1!.members.find((p) => p.memberId === "M4")).toBeUndefined();
  });
});

describe("リソース計画の種類（§155）", () => {
  const MEMBERS = [
    "member_id,name,kind,title,department,section,team_id,effective_from,status",
    "M1,育休の人,employee,一般,,,T1,2026-04,",
    "M1,育休の人,employee,一般,,,T1,2026-07,育休",
    "M2,退職の人,employee,一般,,,T1,2026-04,",
    "M2,退職の人,employee,一般,,,T1,2026-07,退職",
    "M3,復帰した人,employee,一般,,,T1,2026-04,",
    "M3,復帰した人,employee,一般,,,T1,2026-06,一時不在",
    "M3,復帰した人,employee,一般,,,T1,2026-09,",
  ].join("\n");
  const CONTRACTS = "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\nC1,顧客,保守,T1,2026-04,2027-03,1200\n";
  const ASSIGN = ["member_id,contract_id,start_month,end_month,allocation", "M1,C1,2026-04,2026-06,0.5", "M2,C1,2026-04,2026-06,0.5", "M3,C1,2026-04,2027-03,0.5"].join("\n");
  const view = (months: string[]) => planView(planSourcesFromDocs({ teams: parseMasterDoc("teams", "team_id,name,parent_team_id,effective_from\nT1,保守,,2026-04\n"), members: parseMasterDoc("members", MEMBERS), assignments: parseMasterDoc("assignments", ASSIGN) }, CONTRACTS), "T1", months);
  it("行の leftKind は期間の最後の不在の種類。復帰したら null", () => {
    const v = view(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]);
    expect(v.rows.find((r) => r.memberId === "M1")).toMatchObject({ leftFrom: "2026-07", leftKind: "temporary" });
    expect(v.rows.find((r) => r.memberId === "M2")).toMatchObject({ leftFrom: "2026-07", leftKind: "permanent" });
    expect(v.rows.find((r) => r.memberId === "M3")).toMatchObject({ leftFrom: "2026-06", leftKind: "temporary" });
    const later = view(["2026-08", "2026-09", "2026-10"]);
    expect(later.rows.find((r) => r.memberId === "M3")).toMatchObject({ leftFrom: null, leftKind: null });
  });
});
