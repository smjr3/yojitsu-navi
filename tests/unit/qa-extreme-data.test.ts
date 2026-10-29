/**
 * 極端なデータでの QA で見つかった不具合の再発防止
 */
import { describe, expect, it } from "vitest";
import { parseNumberCell, unclosedQuoteLine } from "../../src/core/csv.js";
import { validateDataset } from "../../src/core/validate.js";
import { contractIdFromWorklogKey, worklogKey } from "../../src/components/worklog-key.js";
import { assignment, contract, dataset, member, rate, rule, team, worklog } from "./fixtures.js";

const codes = (d: ReturnType<typeof dataset>) => validateDataset(d).map((i) => i.code);

describe("parseNumberCell: カンマは 3 桁区切りだけ", () => {
  it("1,5 は 15 ではなく不正値", () => {
    expect(parseNumberCell("1,5")).toBeNaN();
    expect(parseNumberCell("1,0,0")).toBeNaN();
    expect(parseNumberCell("12,345")).toBe(12345);
    expect(parseNumberCell("１,２３４")).toBe(1234);
  });
  it("通貨記号つきの金額", () => {
    expect(parseNumberCell("¥1,200,000")).toBe(1200000);
    expect(parseNumberCell("￥1200000")).toBe(1200000);
    expect(parseNumberCell("1,200,000円")).toBe(1200000);
    expect(parseNumberCell("円")).toBeNaN();
  });
});

describe("unclosedQuoteLine", () => {
  it("閉じていない引用符の開始行を返す", () => {
    expect(unclosedQuoteLine('a,b\n1,"x\n2,y\n')).toBe(2);
    expect(unclosedQuoteLine('a,b\n1,"x ""q"" y"\n2,y\n')).toBeNull();
    expect(unclosedQuoteLine('a\n"改\n行"\n')).toBeNull();
  });
});

describe("validateDataset: 重複行・存在しないチーム・巨大な金額", () => {
  it("同じキー・同じ effective_from の重複は error", () => {
    const d = dataset({
      rates: [rate("一般", 6000, "2025-04"), rate("一般", 7000, "2025-04"), rate("一般", 7000, "2026-04")],
      members: [member({ memberId: "M1" }), member({ memberId: "M1", title: "課長" })],
      teams: [team("T1", null, "2025-04"), team("T1", null, "2025-04")],
    });
    const c = codes(d);
    expect(c.filter((x) => x === "DUPLICATE_RATE_ROW")).toHaveLength(1);
    expect(c).toContain("DUPLICATE_MEMBER_ROW");
    expect(c).toContain("DUPLICATE_TEAM_ROW");
  });
  it("契約のチームが teams.csv に無ければ error", () => {
    const d = dataset({ teams: [team("T1", null)], contracts: [contract({ contractId: "C1", teamId: "GHOST" }), contract({ contractId: "C2", teamId: "T1" })] });
    const issues = validateDataset(d).filter((i) => i.code === "CONTRACT_UNKNOWN_TEAM");
    expect(issues.map((i) => i.ref?.contractId)).toEqual(["C1"]);
  });
  it("2^53 を超える金額は error", () => {
    expect(codes(dataset({ contracts: [contract({ contractId: "C1", totalAmount: 2 ** 53 + 2 })] }))).toContain("CONTRACT_AMOUNT_INVALID");
  });
});

describe("worklogKey: 静的サーバで 404 にならないファイル名", () => {
  it("英数字はそのまま、それ以外は ~16進 で往復できる", () => {
    expect(worklogKey("C001")).toBe("C001");
    for (const id of ["契約十一", "N 06", "N/05", "N,10", 'N"12', "<i>N13</i>", "N%09", "~41"]) {
      const key = worklogKey(id);
      expect(key).toMatch(/^[A-Za-z0-9_~-]+$/);
      expect(contractIdFromWorklogKey(key)).toBe(id);
    }
  });
});

describe("validateDataset: 計算は止めないが気付きたいデータ（warning）", () => {
  const issuesOf = (d: ReturnType<typeof dataset>, code: string) => validateDataset(d).filter((i) => i.code === code);
  it("役職の単価が rates.csv に無いメンバーを役職ごとにまとめる。個人単価があれば出さない", () => {
    const d = dataset({
      rates: [rate("SE", 6000), rate("M3", 9000)],
      members: [member({ memberId: "M1", title: "顧問" }), member({ memberId: "M2", title: "顧問" }), member({ memberId: "M3", title: "顧問" }), member({ memberId: "M4", title: "SE" })],
    });
    const issues = issuesOf(d, "MEMBER_RATE_UNDEFINED");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("warning");
    expect(issues[0]!.message).toContain("顧問");
    expect(issues[0]!.message).toContain("M1, M2");
    expect(issues[0]!.message).not.toContain("M3");
  });
  it("契約期間の外にはみ出したアサイン", () => {
    const d = dataset({
      rates: [rate("SE", 6000)],
      members: [member({ memberId: "M1" })],
      contracts: [contract({ contractId: "C1", startMonth: "2026-04", endMonth: "2026-09" })],
      assignments: [assignment({ memberId: "M1", contractId: "C1", startMonth: "2026-04", endMonth: "2026-09" }), assignment({ memberId: "M1", contractId: "C1", startMonth: "2026-08", endMonth: "2026-12", allocation: 0.2 })],
    });
    expect(issuesOf(d, "ASSIGNMENT_OUTSIDE_CONTRACT").map((i) => [i.severity, i.row])).toEqual([["warning", 3]]);
  });
  it("1 人 1 日 24 時間超", () => {
    const d = dataset({
      rates: [rate("SE", 6000)],
      members: [member({ memberId: "M1" })],
      contracts: [contract({ contractId: "C1" })],
      mappings: [rule("ABC株式会社", "保守", "C1")],
      worklogs: [worklog({ date: "2026-05-01", memberId: "M1", hours: 20 }), worklog({ date: "2026-05-01", memberId: "M1", hours: 5 }), worklog({ date: "2026-05-02", memberId: "M1", hours: 24 })],
    });
    const issues = issuesOf(d, "WORKLOG_DAY_OVER_24H");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("M1 2026-05-01 25h");
  });
  it("メンバーの effective_from より前の作業は、原因の分かる単価なし警告にする", () => {
    const d = dataset({
      rates: [rate("SE", 6000)],
      members: [member({ memberId: "M1", effectiveFrom: "2026-06" })],
      contracts: [contract({ contractId: "C1" })],
      mappings: [rule("ABC株式会社", "保守", "C1")],
      worklogs: [worklog({ date: "2026-05-10", memberId: "M1", hours: 3 }), worklog({ date: "2026-06-10", memberId: "M1", hours: 3 })],
    });
    const issues = issuesOf(d, "RATE_MISSING");
    expect(issues.map((i) => i.ref?.month)).toEqual(["2026-05"]);
    expect(issues[0]!.message).toContain("effective_from より前");
  });
});

describe("validateDataset: 自分自身を親にしたチーム", () => {
  it("行番号つきの TEAM_SELF_PARENT だけを出し、行番号なしの循環エラーを重ねない", () => {
    const d = dataset({ teams: [team("T1", null), team("T2", "T2")] });
    const issues = validateDataset(d).filter((i) => i.severity === "error");
    expect(issues.map((i) => [i.code, i.row])).toEqual([["TEAM_SELF_PARENT", 3]]);
  });
});

describe("不備で除外した契約を指すマッピング", () => {
  it("「存在しない契約」ではなく「除外中」として扱う", async () => {
    const { buildModel } = await import("../../src/core/model.js");
    const d = dataset({
      rates: [rate("SE", 6000)],
      members: [member({ memberId: "M1" })],
      contracts: [contract({ contractId: "C1", startMonth: "2026-09", endMonth: "2026-04" })],
      mappings: [rule("ABC株式会社", "保守", "C1")],
      worklogs: [worklog({ date: "2026-05-10", memberId: "M1", hours: 3 })],
    });
    const model = buildModel(d, { asOf: "2026-10-27" });
    expect(model.unmapped.map((u) => u.reason)).toEqual(["EXCLUDED_CONTRACT"]);
    expect(model.warnings.map((w) => w.code)).toContain("MAPPING_EXCLUDED_CONTRACT");
    expect(model.warnings.map((w) => w.code)).not.toContain("MAPPING_UNKNOWN_CONTRACT");
  });
});

describe("parseDataset: 作業実績の取り込み", () => {
  const base = async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(__dirname, "../..");
    const read = (f: string) => readFileSync(join(root, f), "utf-8");
    return { config: JSON.parse(read("config.json")), contracts: read("data/contracts.csv"), mapping: read("data/mapping.csv"), assignments: read("data/assignments.csv"), teams: read("data/masters/teams.csv"), members: read("data/masters/members.csv"), rates: read("data/masters/rates.csv"), holidays: read("data/holidays.csv") };
  };
  const HEAD = "date,member_id,member_name,customer_name,project_name,task,hours\n";
  it("YYYY/MM/DD を受け付け、不正行はファイル名・行番号・値つきで示す。読まないファイル名も警告", async () => {
    const { parseDataset } = await import("../../src/core/csv.js");
    const files = { ...(await base()), worklogs: [`${HEAD}2026/5/1,M001,a,x,y,z,1\n2026-05-02,M001,a,x,y,z,0\n2026-13-01,M001,a,x,y,z,1\n`], worklogNames: ["2026-05.csv"], skippedWorklogFiles: ["2026-10 (1).csv"] };
    const r = parseDataset(files);
    expect(r.dataset.worklogs[0]!.date).toBe("2026-05-01");
    const msg = (code: string) => r.issues.find((i) => i.code === code)?.message ?? "";
    expect(msg("WORKLOG_INVALID_HOURS")).toContain("2026-05.csv 3 行目「0」");
    expect(msg("WORKLOG_INVALID_DATE")).toContain("2026-05.csv 4 行目「2026-13-01」");
    expect(msg("WORKLOG_FILE_SKIPPED")).toContain("2026-10 (1).csv");
  });
  it("列が欠けたファイルは列の欠落だけを出し、行ごとのエラーを重ねない", async () => {
    const { parseDataset } = await import("../../src/core/csv.js");
    const b = await base();
    const contracts = b.contracts.replace(/^contract_id,/, "id,");
    const r = parseDataset({ ...b, contracts, worklogs: [] });
    const fromContracts = r.issues.filter((i) => i.file === "contracts.csv");
    expect(fromContracts.map((i) => i.code)).toEqual(["MISSING_COLUMN"]);
  });
});

describe("リソース計画の入力: CSV と同じ数値規則", () => {
  it("0x10・1e-5・Infinity は数値として換算しない（検証でエラーになる文字列のまま）", async () => {
    const { allocationFromInput } = await import("../../src/core/plan.js");
    expect(allocationFromInput("0x10", "hours", 160)).toBe("0x10");
    expect(allocationFromInput("1e-5", "hours", 160)).toBe("1e-5");
    expect(allocationFromInput("Infinity", "hours", 160)).toBe("Infinity");
    expect(allocationFromInput("1,600", "hours", 160)).toBe("10");
  });
});
