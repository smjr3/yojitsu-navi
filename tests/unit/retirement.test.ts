/**
 * 退職（SPEC §35）: members.csv の任意列 status
 *   - CSV の読み方（空・在籍 = 在籍、退職・left = 退職、それ以外はエラー）
 *   - 検証（退職後の作業実績・退職後のアサインは警告）
 *   - 実績の計算は変えない（退職後の作業も単価は退職の行の役職で数える）
 *   - リソース計画（退職した月から所属に数えない・退職後の配分を知らせる）
 *   - メンバー別（基準月で退職していれば leftFrom）
 *   - 人事データの取り込み（取り込み元に再び現れたら在籍に戻す。現れない人を退職にはしない）
 */
import { describe, expect, it } from "vitest";
import { memberStatus, parseDataset } from "../../src/core/csv.js";
import { createMasterIndex, isActiveAt, isLeftRecord, leftMonthOf } from "../../src/core/masters.js";
import { parseMasterDoc, planSourcesFromDocs } from "../../src/core/masterEdit.js";
import { planView } from "../../src/core/plan.js";
import { validateDataset } from "../../src/core/validate.js";
import { buildModel } from "../../src/core/model.js";
import { aggregateMembers } from "../../src/core/members.js";
import { mergeMembers } from "../../scripts/lib/members-merge.js";
import { assignment, baseConfig, contract, dataset, member, rate, rule, worklog } from "./fixtures.js";

describe("status 列の読み方", () => {
  it.each([
    ["", undefined],
    [" ", undefined],
    ["在籍", undefined],
    ["active", undefined],
    ["退職", "left"],
    [" 退職 ", "left"],
    ["LEFT", "left"],
    ["retired", "left"],
    ["休職", "休職"],
  ])("%j → %j", (raw, want) => {
    expect(memberStatus(raw).status).toBe(want);
  });

  it("列が無い CSV は全員在籍。列があれば行ごと", () => {
    const base = { config: baseConfig, contracts: "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\n", mapping: "worklog_customer_name,worklog_project_name,contract_id\n", assignments: "member_id,contract_id,start_month,end_month,allocation\n", teams: "team_id,name,parent_team_id,effective_from\nT1,T,,2025-04\n", rates: "key,hourly_rate,effective_from\n", holidays: "date,name\n", worklogs: [] };
    const without = parseDataset({ ...base, members: "member_id,name,kind,title,department,section,team_id,effective_from\nM1,A,employee,一般,,,T1,2025-04\n" });
    expect(without.dataset.members[0]!.status).toBeUndefined();
    const withCol = parseDataset({ ...base, members: "member_id,name,kind,title,department,section,team_id,effective_from,status\nM1,A,employee,一般,,,T1,2025-04,\nM1,A,employee,一般,,,T1,2026-04,退職\nM2,B,employee,一般,,,T1,2025-04,休職\n" });
    expect(withCol.dataset.members.map((m) => m.status)).toEqual([undefined, "left", "休職"]);
    expect(withCol.issues.filter((i) => i.code === "MEMBER_STATUS_INVALID").map((i) => i.row)).toEqual([4]);
  });
});

describe("在籍の判定", () => {
  const members = [member({ memberId: "M1", effectiveFrom: "2025-04" }), member({ memberId: "M1", effectiveFrom: "2026-04", status: "left" })];
  const idx = createMasterIndex({ members, rates: [], teams: [] });

  it("退職の行の月から在籍しない。前の月までは在籍", () => {
    expect(isActiveAt(idx, "M1", "2026-03")).toBe(true);
    expect(isActiveAt(idx, "M1", "2026-04")).toBe(false);
    expect(isActiveAt(idx, "M1", "2027-01")).toBe(false);
    expect(isActiveAt(idx, "M1", "2025-03")).toBe(false); // 入社前
    expect(isActiveAt(idx, "NONE", "2026-01")).toBe(false);
  });

  it("leftMonthOf: 最後が退職ならその月（退職の行が続けばいちばん早い月）。復職していれば null", () => {
    expect(leftMonthOf(members)).toBe("2026-04");
    expect(leftMonthOf([...members, member({ memberId: "M1", effectiveFrom: "2026-07", status: "left" })])).toBe("2026-04");
    expect(leftMonthOf([...members, member({ memberId: "M1", effectiveFrom: "2026-10" })])).toBeNull();
    expect(leftMonthOf([members[0]!])).toBeNull();
    expect(leftMonthOf([])).toBeNull();
    // 行の並びが逆でも同じ
    expect(leftMonthOf([...members].reverse())).toBe("2026-04");
    expect(isLeftRecord(null)).toBe(false);
  });
});

describe("検証と計算", () => {
  const ds = () =>
    dataset({
      contracts: [contract({ contractId: "C1", customerName: "顧客", projectName: "保守", startMonth: "2026-01", endMonth: "2026-12", totalAmount: 1_200_000 })],
      mappings: [rule("顧客", "保守", "C1")],
      members: [member({ memberId: "M1", title: "一般", effectiveFrom: "2025-04" }), member({ memberId: "M1", title: "一般", effectiveFrom: "2026-04", status: "left" })],
      rates: [rate("一般", 5000, "2025-04")],
      assignments: [assignment({ memberId: "M1", contractId: "C1", startMonth: "2026-01", endMonth: "2026-06", allocation: 0.5 })],
      worklogs: [
        worklog({ date: "2026-03-31", memberId: "M1", hours: 8, customerName: "顧客", projectName: "保守" }),
        worklog({ date: "2026-04-01", memberId: "M1", hours: 2, customerName: "顧客", projectName: "保守" }),
        worklog({ date: "2026-05-01", memberId: "M1", hours: 1.5, customerName: "顧客", projectName: "保守" }),
      ],
    });

  it("退職後の作業実績・アサインは警告（エラーにはしない）。場所と時間が分かる", () => {
    const issues = validateDataset(ds());
    const w = issues.find((i) => i.code === "WORKLOG_AFTER_LEFT")!;
    expect(w).toMatchObject({ severity: "warning", ref: { memberId: "M1", hours: 3.5 } });
    expect(w.message).toContain("2026-04-01〜2026-05-01");
    expect(w.message).toContain("2 件");
    const a = issues.find((i) => i.code === "ASSIGNMENT_AFTER_LEFT")!;
    expect(a).toMatchObject({ severity: "warning", row: 2, ref: { memberId: "M1" } });
    expect(a.message).toContain("2026-04〜2026-06");
    expect(issues.some((i) => i.severity === "error")).toBe(false);
  });

  it("退職前だけのデータなら警告は出ない", () => {
    const d = ds();
    d.worklogs = d.worklogs.slice(0, 1);
    d.assignments = [assignment({ memberId: "M1", contractId: "C1", startMonth: "2026-01", endMonth: "2026-03", allocation: 0.5 })];
    expect(validateDataset(d).filter((i) => i.code.endsWith("_AFTER_LEFT"))).toEqual([]);
  });

  it("実績は退職後の分も数える（単価は退職の行の役職。隠さない）", () => {
    const m = buildModel(ds(), { asOf: "2026-10-27" });
    const c1 = m.contracts[0]!;
    expect(c1.months.find((x) => x.month === "2026-04")!.cost).toBe(2 * 5000);
    expect(c1.months.find((x) => x.month === "2026-05")!.cost).toBe(1.5 * 5000);
  });

  it("メンバー別: 基準月で退職していれば leftFrom、退職前の期間なら null", () => {
    const m = buildModel(ds(), { asOf: "2026-10-27" });
    const after = aggregateMembers(m, { period: { from: "2026-01", to: "2026-12" } }).members.find((x) => x.memberId === "M1")!;
    expect(after.leftFrom).toBe("2026-04");
    const before = aggregateMembers(m, { period: { from: "2026-01", to: "2026-03" } }).members.find((x) => x.memberId === "M1")!;
    expect(before.leftFrom).toBeNull();
  });
});

describe("リソース計画（planView）", () => {
  const TEAMS = "team_id,name,parent_team_id,effective_from\nT1,保守,,2026-04\n";
  const MEMBERS = [
    "member_id,name,kind,title,department,section,team_id,effective_from,status",
    "M1,在籍,employee,一般,,,T1,2026-04,",
    "M2,7月退職,employee,一般,,,T1,2026-04,",
    "M2,7月退職,employee,一般,,,T1,2026-07,退職",
    "M3,前年度に退職,employee,一般,,,T1,2025-04,",
    "M3,前年度に退職,employee,一般,,,T1,2026-01,退職",
    "M4,退職後もアサイン,employee,一般,,,T1,2026-04,",
    "M4,退職後もアサイン,employee,一般,,,T1,2026-10,退職",
  ].join("\n");
  const ASSIGN = ["member_id,contract_id,start_month,end_month,allocation", "M1,C1,2026-04,2027-03,0.5", "M2,C1,2026-04,2026-06,0.8", "M4,C1,2026-04,2027-03,0.6"].join("\n");
  const CONTRACTS = "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\nC1,顧客,保守,T1,2026-04,2027-03,1200\n";
  const FY = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"];
  const view = (months = FY) => planView(planSourcesFromDocs({ teams: parseMasterDoc("teams", TEAMS), members: parseMasterDoc("members", MEMBERS), assignments: parseMasterDoc("assignments", ASSIGN) }, CONTRACTS), "T1", months);

  it("期間の前に退職した人は出ない。期間中に退職した人は退職月付きで出る", () => {
    const v = view();
    expect(v.rows.map((r) => r.memberId)).toEqual(["M1", "M2", "M4"]);
    expect(v.rows.find((r) => r.memberId === "M1")!.leftFrom).toBeNull();
    expect(v.rows.find((r) => r.memberId === "M2")!.leftFrom).toBe("2026-07");
    // 退職前の名前・所属はそのまま
    expect(v.rows.find((r) => r.memberId === "M2")).toMatchObject({ name: "7月退職", teamId: "T1", support: false });
  });

  it("退職後に残った配分は afterLeftMonths で分かる（終了し忘れ）", () => {
    const v = view();
    expect(v.rows.find((r) => r.memberId === "M2")!.afterLeftMonths).toEqual([]);
    expect(v.rows.find((r) => r.memberId === "M4")!.afterLeftMonths).toEqual(["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"]);
  });

  it("月ごとの在籍 activeMonths（§58 の人数 × 1.0）: 退職した月からは在籍しない。復職すれば戻る", () => {
    const v = view();
    const active = (id: string) => FY.filter((_, i) => v.rows.find((r) => r.memberId === id)!.activeMonths[i]);
    expect(active("M1")).toEqual(FY);
    expect(active("M2")).toEqual(["2026-04", "2026-05", "2026-06"]);
    // 6 月に退職し 10 月に復職: 6〜9 月は数えない（期間の最後の leftFrom は null になるので、それでは判定できない）
    const rejoin = planView(
      planSourcesFromDocs({ teams: parseMasterDoc("teams", TEAMS), members: parseMasterDoc("members", `${MEMBERS}\nM5,復職,employee,一般,,,T1,2026-04,\nM5,復職,employee,一般,,,T1,2026-06,退職\nM5,復職,employee,一般,,,T1,2026-10,`), assignments: parseMasterDoc("assignments", `${ASSIGN}\nM5,C1,2026-04,2027-03,0.5`) }, CONTRACTS),
      "T1",
      FY,
    ).rows.find((r) => r.memberId === "M5")!;
    expect(rejoin.leftFrom).toBeNull();
    expect(FY.filter((_, i) => !rejoin.activeMonths[i])).toEqual(["2026-06", "2026-07", "2026-08", "2026-09"]);
  });

  it("退職後の月だけを見ると、配分の残っている人だけが出る", () => {
    const v = view(["2026-11", "2026-12"]);
    expect(v.rows.map((r) => r.memberId)).toEqual(["M1", "M4"]);
    expect(v.rows.find((r) => r.memberId === "M4")!.leftFrom).toBe("2026-10");
  });
});

describe("人事データの取り込み（mergeMembers）", () => {
  const cols = { member_id: "", name: "", kind: "employee", title: "一般", department: "", section: "", team_id: "T1", effective_from: "", status: "" };
  const existing = [
    { ...cols, member_id: "M1", name: "A", effective_from: "2025-04" },
    { ...cols, member_id: "M2", name: "B", effective_from: "2025-04" },
    { ...cols, member_id: "M2", name: "B", effective_from: "2026-04", status: "退職" },
  ];

  it("取り込み元に無い人は退職にしない（残すだけ）", () => {
    const r = mergeMembers(existing, [{ memberId: "M1", name: "A", kind: "employee", title: "一般" }], "2026-10");
    expect(r.keptNotInSource).toBe(1);
    expect(r.rows).toHaveLength(3);
    expect(r.rows.filter((x) => x.status === "退職")).toHaveLength(1);
  });

  it("退職の人が取り込み元に再び現れたら、実行月の行で在籍に戻す（チームは引き継ぐ）", () => {
    const r = mergeMembers(existing, [{ memberId: "M2", name: "B", kind: "employee", title: "一般" }], "2026-10");
    expect(r.changed).toBe(1);
    expect(r.changes[0]).toEqual({ memberId: "M2", kind: "changed", fields: ["status"] });
    const added = r.rows.at(-1)!;
    expect(added).toMatchObject({ member_id: "M2", effective_from: "2026-10", status: "", team_id: "T1" });
    // 退職の行（履歴）は消さない
    expect(r.rows.filter((x) => x.member_id === "M2" && x.status === "退職")).toHaveLength(1);
    // もう一度流しても変わらない
    const again = mergeMembers(r.rows, [{ memberId: "M2", name: "B", kind: "employee", title: "一般" }], "2026-10");
    expect(again.changed + again.added).toBe(0);
  });
});
