/**
 * 組織の種別・リーダー（SPEC §21・§22）とリソース計画（§23）
 */
import { describe, expect, it } from "vitest";
import { parseDataset } from "../../src/core/csv.js";
import { parseMasterDoc, planSourcesFromDocs, validateEdited, addRow } from "../../src/core/masterEdit.js";
import { teamTreeAt } from "../../src/core/masters.js";
import { allocationFromInput, flattenTeamTree, formatAllocation, hoursFromAllocation, memberTeamAt, planView, type PlanSources } from "../../src/core/plan.js";
import { baseConfig } from "./fixtures.js";

const TEAMS = [
  "team_id,name,parent_team_id,effective_from,level,leader_member_id",
  "HQ,本部,,2026-04,本部,M1",
  "S1,第1課,HQ,2026-04,課,M2",
  "T1,保守チーム,S1,2026-04,チーム,M3",
  "G1,監視班,T1,2026-04,班,M4",
  "S2,第2課,HQ,2026-04,課,",
  // 2026-10 に監視班が第2課の直下へ（課の下に班が直接ある構造）
  "G1,監視班,S2,2026-10,班,M4",
].join("\n");
const MEMBERS = [
  "member_id,name,kind,title,department,section,team_id,effective_from",
  "M1,本部長,employee,本部長,,,HQ,2026-04",
  "M2,課長A,employee,課長,,,S1,2026-04",
  "M3,主任A,employee,主任,,,T1,2026-04",
  "M4,班長A,employee,主任,,,G1,2026-04",
  "M5,一般A,employee,一般,,,G1,2026-04",
  "M6,一般B,employee,一般,,,S2,2026-04",
].join("\n");
const ASSIGN = [
  "member_id,contract_id,start_month,end_month,allocation",
  "M3,C1,2026-04,2027-03,0.5",
  "M3,C2,2026-06,2026-08,0.6",
  "M5,C1,2026-04,2026-09,1",
  "M6,C1,2026-04,2026-05,0.2",
  "M6,C9,2025-01,2025-03,0.5",
].join("\n");
const CONTRACTS = "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\nC1,顧客,保守,T1,2026-04,2027-03,1200\nC2,顧客,開発,S2,2026-04,2027-03,1200\n";
const FY = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"];

function sources(assign = ASSIGN): PlanSources {
  const docs = { teams: parseMasterDoc("teams", TEAMS), members: parseMasterDoc("members", MEMBERS), assignments: parseMasterDoc("assignments", assign) };
  return planSourcesFromDocs(docs, CONTRACTS);
}

describe("組織の種別・リーダー（§21・§22）", () => {
  const files = { config: baseConfig, contracts: CONTRACTS, mapping: "worklog_customer_name,worklog_project_name,contract_id\n", assignments: ASSIGN, teams: TEAMS, members: MEMBERS, rates: "key,hourly_rate,effective_from\n", holidays: "date,name\n", worklogs: [] };

  it("TeamNode に種別とリーダーが入り、段数・種別の混在は自由（月ごとの当時の組織）", () => {
    const { dataset } = parseDataset(files);
    const before = teamTreeAt(dataset, "2026-09").tree;
    expect(before.G1).toMatchObject({ level: "班", leaderMemberId: "M4", parentTeamId: "T1", depth: 3 });
    expect(before.S2).toMatchObject({ level: "課", leaderMemberId: null });
    const after = teamTreeAt(dataset, "2026-10").tree;
    expect(after.G1).toMatchObject({ parentTeamId: "S2", depth: 2 });
    expect(flattenTeamTree(after).map((n) => n.teamId)).toEqual(["HQ", "S1", "T1", "S2", "G1"]);
  });

  it("種別・リーダーの列が無い古いファイルでも読める（空・null）", () => {
    const { dataset, issues } = parseDataset({ ...files, teams: "team_id,name,parent_team_id,effective_from\nHQ,本部,,2026-04\nS1,第1課,HQ,2026-04\nT1,保守チーム,S1,2026-04\nG1,監視班,T1,2026-04\nS2,第2課,HQ,2026-04\n" });
    expect(issues.filter((i) => i.severity === "error" && i.file === "masters/teams.csv")).toEqual([]);
    expect(teamTreeAt(dataset, "2026-04").tree.HQ).toMatchObject({ level: "", leaderMemberId: null });
  });

  it("存在しないリーダーは TEAM_UNKNOWN_LEADER（error）", () => {
    const { issues } = parseDataset({ ...files, teams: TEAMS.replace("S2,第2課,HQ,2026-04,課,", "S2,第2課,HQ,2026-04,課,MX") });
    const hit = issues.filter((i) => i.code === "TEAM_UNKNOWN_LEADER");
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ severity: "error", file: "masters/teams.csv", row: 6 });
  });

  it("マスタ編集の検証でもリーダーの誤りを行に結び付ける", () => {
    const docs = { teams: parseMasterDoc("teams", TEAMS), members: parseMasterDoc("members", MEMBERS), assignments: parseMasterDoc("assignments", ASSIGN), rates: parseMasterDoc("rates", "key,hourly_rate,effective_from\n"), outside: parseMasterDoc("outside", "member_id,start_month,end_month,person_months,note\n"), targets: parseMasterDoc("targets", "target_type,target_id,end_month,remaining_rate\n") };
    const { doc, rowId } = addRow(docs.teams, { team_id: "S3", name: "第3課", parent_team_id: "HQ", effective_from: "2026-11", level: "課", leader_member_id: "NOBODY" });
    const v = validateEdited({ ...docs, teams: doc }, { contracts: CONTRACTS, mapping: files.mapping, holidays: files.holidays }, baseConfig);
    expect(v.byRow.teams[rowId]?.map((i) => i.code)).toContain("TEAM_UNKNOWN_LEADER");
  });
});

describe("リソース計画 planView（§23.1）", () => {
  it("組織を選ぶと配下（班まで）の所属メンバーと、組織の契約に入る応援が並ぶ", () => {
    const v = planView(sources(), "S1", FY);
    expect(v.rows.map((r) => [r.memberId, r.support])).toEqual([
      ["M2", false],
      ["M3", false],
      ["M4", false],
      ["M5", false],
      // M6 は第2課の所属だが、保守チームの契約 C1 に計画がある → 応援
      ["M6", true],
    ]);
    const m3 = v.rows.find((r) => r.memberId === "M3")!;
    expect(m3.monthly.slice(0, 6)).toEqual([0.5, 0.5, 1.1, 1.1, 1.1, 0.5]);
    expect(m3.overMonths).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(m3.assignments.map((a) => a.contractId)).toEqual(["C1", "C2"]);
    // 年度に掛からない計画は出さない
    expect(v.rows.find((r) => r.memberId === "M6")!.assignments.map((a) => a.contractId)).toEqual(["C1"]);
    expect(v.totals[0]).toBeCloseTo(0.5 + 1 + 0.2);
  });

  it("組織変更後の月は当時の組織で判定する（監視班が第2課へ移っても、移る前の月の所属で第1課に出る）", () => {
    const s2 = planView(sources(), "S2", FY);
    expect(s2.rows.map((r) => r.memberId)).toEqual(["M4", "M5", "M6", "M3"]);
    expect(s2.rows.find((r) => r.memberId === "M3")!.support).toBe(true); // C2 は第2課の契約
    const s2Before = planView(sources(), "S2", FY.slice(0, 6));
    expect(s2Before.rows.map((r) => r.memberId)).toEqual(["M6", "M3"]);
  });

  it("すべて（null）は全員。応援の印は付けない。未登録のメンバーも計画があれば出す", () => {
    const v = planView(sources(ASSIGN + "\nMX,C1,2026-04,2026-04,0.1"), null, FY);
    expect(v.rows.map((r) => r.memberId)).toEqual(["M1", "M2", "M3", "M4", "M5", "M6", "MX"]);
    expect(v.rows.every((r) => !r.support)).toBe(true);
    expect(v.rows.find((r) => r.memberId === "MX")!.name).toBe("");
  });

  it("数値でない配分は合計に数えない。月が空なら空", () => {
    const v = planView(sources(ASSIGN + "\nM2,C1,2026-04,2026-04,abc"), "S1", FY);
    expect(v.rows.find((r) => r.memberId === "M2")!.monthly[0]).toBe(0);
    expect(planView(sources(), "S1", [])).toEqual({ months: [], rows: [], totals: [] });
  });

  it("メンバーの所属組織（初期表示の組織選択）", () => {
    expect(memberTeamAt(sources().members, "M5", "2026-10")).toBe("G1");
    expect(memberTeamAt(sources().members, "MX", "2026-10")).toBeNull();
  });
});

describe("人月と時間（§23.2: 入力だけ時間可、保存・表示は人月）", () => {
  it("時間は1人月の時間で人月に直し、小数 4 桁", () => {
    expect(allocationFromInput("16", "hours", 160)).toBe("0.1");
    expect(allocationFromInput("10", "hours", 160)).toBe("0.0625");
    expect(allocationFromInput("1", "hours", 160)).toBe("0.0063");
    expect(allocationFromInput("１６０", "hours", 160)).toBe("1");
  });
  it("人月は入力どおり。数値でない・空はそのまま（検証でエラー）", () => {
    expect(allocationFromInput("0.33333", "personMonth", 160)).toBe("0.33333");
    expect(allocationFromInput(" 0.5 ", "personMonth", 160)).toBe("0.5");
    expect(allocationFromInput("abc", "hours", 160)).toBe("abc");
    expect(allocationFromInput("", "hours", 160)).toBe("");
  });
  it("換算の往復と表示", () => {
    expect(hoursFromAllocation(0.1, 160)).toBe(16);
    expect(hoursFromAllocation(0.0625, 160)).toBe(10);
    expect(formatAllocation(0.30000000000000004)).toBe("0.3");
    expect(formatAllocation(Number.NaN)).toBe("");
  });
});
