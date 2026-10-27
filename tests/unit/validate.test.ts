import { describe, expect, it } from "vitest";
import { hasErrors, validateDataset } from "../../src/core/validate.js";
import { assignment, contract, dataset, member, rate, rule, team, worklog } from "./fixtures.js";

const codes = (ds: Parameters<typeof validateDataset>[0]): string[] => validateDataset(ds).map((i) => i.code);
const errors = (ds: Parameters<typeof validateDataset>[0]): string[] => validateDataset(ds).filter((i) => i.severity === "error").map((i) => i.code);

describe("validateDataset (SPEC §14) — エラー", () => {
  it("正しいデータは問題なし", () => {
    const ds = dataset({
      contracts: [contract({ contractId: "C1", teamId: "T1" })],
      mappings: [rule("ABC株式会社", "", "C1")],
      assignments: [assignment({ memberId: "M1", contractId: "C1", allocation: 0.6 }), assignment({ memberId: "M1", contractId: "C1", allocation: 0.4 })],
      teams: [team("T1", null)],
      members: [member({ memberId: "M1", teamId: "T1" })],
      rates: [rate("SE", 5000)],
      holidays: [{ date: "2026-01-01", name: "元日" }],
      worklogs: [worklog({ date: "2026-05-01", memberId: "M1", hours: 1 })],
    });
    expect(validateDataset(ds)).toEqual([]);
    expect(hasErrors([])).toBe(false);
  });

  it("契約: 重複・期間逆転・金額", () => {
    const issues = validateDataset(dataset({ contracts: [contract({ contractId: "C1" }), contract({ contractId: "C1" }), contract({ contractId: "C2", startMonth: "2027-01", endMonth: "2026-01" }), contract({ contractId: "C3", totalAmount: Number.NaN }), contract({ contractId: "C4", totalAmount: -1 }), contract({ contractId: "" })] }));
    expect(issues.map((i) => [i.code, i.row])).toEqual([
      ["DUPLICATE_CONTRACT_ID", 3],
      ["CONTRACT_PERIOD_INVERTED", 4],
      ["CONTRACT_AMOUNT_INVALID", 5],
      ["CONTRACT_AMOUNT_INVALID", 6],
      ["CONTRACT_ID_EMPTY", 7],
    ]);
    expect(issues.every((i) => i.severity === "error" && i.file === "contracts.csv")).toBe(true);
    expect(hasErrors(issues)).toBe(true);
  });

  it("契約: 年月の形式", () => {
    expect(errors(dataset({ contracts: [contract({ contractId: "C1", startMonth: "2026/04" })] }))).toEqual(["INVALID_MONTH"]);
  });

  it("マッピング: 存在しない契約ID", () => {
    const issues = validateDataset(dataset({ contracts: [contract({ contractId: "C1" })], mappings: [rule("A", "", "C1"), rule("B", "", "NOPE")] }));
    expect(issues).toEqual([{ severity: "error", code: "MAPPING_UNKNOWN_CONTRACT", message: expect.stringContaining("NOPE"), file: "mapping.csv", row: 3, ref: { contractId: "NOPE" } }]);
  });

  it("アサイン: 未知のメンバー・契約、allocation の範囲、月合計 > 1", () => {
    const ds = dataset({
      contracts: [contract({ contractId: "C1" }), contract({ contractId: "C2" })],
      members: [member({ memberId: "M1" })],
      assignments: [
        assignment({ memberId: "GHOST", contractId: "C1" }),
        assignment({ memberId: "M1", contractId: "NOPE", startMonth: "2020-01", endMonth: "2020-01" }),
        assignment({ memberId: "M1", contractId: "C1", allocation: 1.5 }),
        assignment({ memberId: "M1", contractId: "C1", allocation: -0.1 }),
        assignment({ memberId: "M1", contractId: "C1", allocation: Number.NaN }),
        assignment({ memberId: "M1", contractId: "C1", allocation: 0.7, startMonth: "2026-04", endMonth: "2026-06" }),
        assignment({ memberId: "M1", contractId: "C2", allocation: 0.4, startMonth: "2026-06", endMonth: "2026-08" }),
        assignment({ memberId: "M1", contractId: "C2", allocation: 0.4, startMonth: "2026-09", endMonth: "2026-08" }),
      ],
    });
    const issues = validateDataset(ds);
    expect(issues.map((i) => [i.code, i.row])).toEqual([
      ["ASSIGNMENT_UNKNOWN_MEMBER", 2],
      ["ASSIGNMENT_UNKNOWN_CONTRACT", 3],
      ["ALLOCATION_OUT_OF_RANGE", 4],
      ["ALLOCATION_OUT_OF_RANGE", 5],
      ["ALLOCATION_OUT_OF_RANGE", 6],
      ["ASSIGNMENT_PERIOD_INVERTED", 9],
      ["ALLOCATION_OVER_1", 7], // 2026-06 に 0.7 + 0.4 = 1.1
    ]);
    expect(issues.find((i) => i.code === "ALLOCATION_OVER_1")?.ref).toMatchObject({ memberId: "M1", month: "2026-06" });
  });

  it("アサイン: 合計ちょうど 1.0（0.3+0.7 の浮動小数）はエラーにしない", () => {
    const ds = dataset({ contracts: [contract({ contractId: "C1" })], members: [member({ memberId: "M1" })], assignments: [assignment({ memberId: "M1", contractId: "C1", allocation: 0.3 }), assignment({ memberId: "M1", contractId: "C1", allocation: 0.7 })] });
    expect(validateDataset(ds)).toEqual([]);
  });

  it("チーム: 未知の親、循環、形式", () => {
    expect(errors(dataset({ teams: [team("A", "NOPE")] }))).toEqual(["TEAM_UNKNOWN_PARENT"]);
    expect(errors(dataset({ teams: [team("A", "B"), team("B", "A")] }))).toEqual(["TEAM_CYCLE"]);
    expect(errors(dataset({ teams: [team("A", "A")] }))).toEqual(["TEAM_CYCLE"]);
    expect(errors(dataset({ teams: [team("A", null, "2026-1")] }))).toEqual(["INVALID_MONTH"]);
    expect(errors(dataset({ teams: [team("", null)] }))).toEqual(["TEAM_ID_EMPTY"]);
  });

  it("チーム: 過去の時点で循環していれば検出する", () => {
    // 2026-01 時点: A→B, B→A（循環）。2026-07 からは B が最上位
    const ds = dataset({ teams: [team("A", "B", "2026-01"), team("B", "A", "2026-01"), team("B", null, "2026-07")] });
    expect(errors(ds)).toEqual(["TEAM_CYCLE"]);
  });

  it("メンバー: 未知のチーム、区分", () => {
    const ds = dataset({ teams: [team("T1", null)], members: [member({ memberId: "M1", teamId: "NOPE" }), member({ memberId: "M2", kind: "contractor" as never }), member({ memberId: "", effectiveFrom: "x" })] });
    expect(validateDataset(ds).map((i) => [i.code, i.row])).toEqual([["MEMBER_UNKNOWN_TEAM", 2], ["MEMBER_KIND_INVALID", 3], ["MEMBER_ID_EMPTY", 4], ["INVALID_MONTH", 4]]);
  });

  it("単価: 数値でない・負・形式", () => {
    const ds = dataset({ rates: [rate("SE", Number.NaN), rate("PG", -1), rate("PM", 1, "2026"), rate("", 1)] });
    expect(validateDataset(ds).map((i) => [i.code, i.row])).toEqual([["RATE_INVALID", 2], ["RATE_INVALID", 3], ["INVALID_MONTH", 4], ["RATE_KEY_EMPTY", 5]]);
  });

  it("祝日: 日付形式", () => {
    expect(validateDataset(dataset({ holidays: [{ date: "2026-02-30", name: "x" }] })).map((i) => [i.code, i.row])).toEqual([["INVALID_DATE", 2]]);
  });
});

describe("validateDataset — 警告", () => {
  it("未紐付け工数・単価なし・未知メンバー・日付不正・hours 不正は warning（止めない）", () => {
    const ds = dataset({
      contracts: [contract({ contractId: "C1" })],
      mappings: [rule("ABC株式会社", "", "C1")],
      members: [member({ memberId: "M1", title: "NOPE" })],
      worklogs: [
        worklog({ date: "2026-05-01", memberId: "M1", hours: 1 }), // RATE_MISSING
        worklog({ date: "2026-05-01", memberId: "GHOST", hours: 1 }), // UNKNOWN_MEMBER
        worklog({ date: "2026-05-01", memberId: "M1", hours: 1, customerName: "XYZ" }), // UNMAPPED
        worklog({ date: "2026-05-01", memberId: "M1", hours: 1, customerName: "" }), // EXCLUDED
        worklog({ date: "2026-05-32", memberId: "M1", hours: 1 }), // invalid date
        worklog({ date: "2026-05-01", memberId: "M1", hours: 0 }), // invalid hours
      ],
    });
    const issues = validateDataset(ds);
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
    expect(hasErrors(issues)).toBe(false);
    expect(issues.map((i) => i.code).sort()).toEqual(["EXCLUDED_NO_CUSTOMER", "RATE_MISSING", "UNKNOWN_MEMBER", "UNMAPPED_WORKLOG", "WORKLOG_INVALID_DATE", "WORKLOG_INVALID_HOURS"]);
  });

  it("警告の紐付けは不正・重複契約を除いて行う（落ちない）", () => {
    const ds = dataset({
      contracts: [contract({ contractId: "C1", startMonth: "2027-01", endMonth: "2026-01" }), contract({ contractId: "C1" })],
      mappings: [rule("ABC株式会社", "", "C1")],
      worklogs: [worklog({ date: "2026-05-01", memberId: "M1", hours: 1 })],
    });
    const c = codes(ds);
    expect(c).toContain("CONTRACT_PERIOD_INVERTED");
    expect(c).toContain("DUPLICATE_CONTRACT_ID");
    expect(c).toContain("UNMAPPED_WORKLOG");
  });
});
