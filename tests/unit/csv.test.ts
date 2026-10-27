import { describe, expect, it } from "vitest";
import { parseCsvTable, parseCsvText, parseDataset, parseNumberCell, type DatasetFiles } from "../../src/core/csv.js";
import { baseConfig } from "./fixtures.js";

describe("parseCsvText (RFC 4180)", () => {
  it("基本", () => {
    expect(parseCsvText("a,b,c\n1,2,3\n")).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });

  it("CRLF と末尾改行なし", () => {
    expect(parseCsvText("a,b\r\n1,2\r\n3,4")).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
  });

  it("BOM を除く", () => {
    expect(parseCsvText("﻿a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsvText("﻿")).toEqual([]);
  });

  it("引用符の中のカンマ・改行・二重引用符", () => {
    expect(parseCsvText('a,b\n"x, y","line1\nline2"\n"say ""hi""",z')).toEqual([["a", "b"], ["x, y", "line1\nline2"], ['say "hi"', "z"]]);
  });

  it("引用符の中の CRLF も保持", () => {
    expect(parseCsvText('a\r\n"1\r\n2"\r\n')).toEqual([["a"], ["1\r\n2"]]);
  });

  it("空行・空白だけの行を飛ばす", () => {
    expect(parseCsvText("a,b\n\n  \n1,2\n,\n\n")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("空セルと末尾カンマ", () => {
    expect(parseCsvText("a,b,c\n1,,\n")).toEqual([["a", "b", "c"], ["1", "", ""]]);
  });

  it("空文字列・改行だけ", () => {
    expect(parseCsvText("")).toEqual([]);
    expect(parseCsvText("\n\n")).toEqual([]);
  });

  it("日本語・全角", () => {
    expect(parseCsvText("顧客,案件\n株式会社ＡＢＣ,保守　業務")).toEqual([["顧客", "案件"], ["株式会社ＡＢＣ", "保守　業務"]]);
  });
});

describe("parseCsvTable", () => {
  it("ヘッダで引けて trim され、余分な列・無い列は空", () => {
    const t = parseCsvTable(" a , b \n 1 , 2 ,3\n");
    expect(t.header).toEqual(["a", "b"]);
    expect(t.rows[0]?.get("a")).toBe("1");
    expect(t.rows[0]?.get("b")).toBe("2");
    expect(t.rows[0]?.get("zzz")).toBe("");
    expect(t.rows[0]?.row).toBe(2);
  });

  it("列が足りない行は空文字", () => {
    const t = parseCsvTable("a,b,c\n1\n");
    expect(t.rows[0]?.get("c")).toBe("");
  });
});

describe("parseNumberCell", () => {
  it("数値・カンマ区切り・符号・小数・全角", () => {
    expect(parseNumberCell("1000")).toBe(1000);
    expect(parseNumberCell("1,000")).toBe(1000);
    expect(parseNumberCell("1,234,567.5")).toBe(1234567.5);
    expect(parseNumberCell("-5")).toBe(-5);
    expect(parseNumberCell("+5")).toBe(5);
    expect(parseNumberCell("0.25")).toBe(0.25);
    expect(parseNumberCell(".5")).toBe(0.5);
    expect(parseNumberCell("５０")).toBe(50);
    expect(parseNumberCell(" 7 ")).toBe(7);
    expect(parseNumberCell("0")).toBe(0);
  });

  it("不正は NaN", () => {
    for (const s of ["", "abc", "1e3", "1 000", "--1", "1.2.3", "Infinity", "NaN", "0x10", "1-"]) {
      expect(parseNumberCell(s), s).toBeNaN();
    }
  });
});

function files(overrides: Partial<DatasetFiles> = {}): DatasetFiles {
  return {
    config: baseConfig,
    contracts: "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount,note\nC1,ABC株式会社,保守,T1,2026-04,2027-03,\"2,400,000\",\"メモ, 改行\nあり\"\n",
    mapping: "worklog_customer_name,worklog_project_name,contract_id\n（株）ABC,,C1\n",
    assignments: "member_id,contract_id,start_month,end_month,allocation\nM1,C1,2026-04,2027-03,0.5\n",
    teams: "﻿team_id,name,parent_team_id,effective_from\r\nROOT,全社,,2000-01\r\nT1,開発,ROOT,2000-01\r\n",
    members: "member_id,name,kind,title,department,section,team_id,effective_from\nM1,山田 太郎,Employee,SE,開発部,1課,T1,2000-01\nM2,鈴木,partner,,,,,2000-01\n",
    rates: "key,hourly_rate,effective_from\nSE,5000,2000-01\nM2,\"4,000\",2000-01\n",
    holidays: "date,name\n2026-01-01,元日\n",
    worklogs: ["date,member_id,member_name,customer_name,project_name,task,hours\n2026-05-10,M1,山田,ABC株式会社,保守,作業,1.5\n", "date,member_id,member_name,customer_name,project_name,task,hours\n2026-06-10,M2,鈴木,ABC株式会社,保守,作業,0.25\n"],
    worklogFetchedAt: "2026-10-27T00:00:00Z",
    ...overrides,
  };
}

describe("parseDataset", () => {
  it("すべての CSV を Dataset に変換する", () => {
    const { dataset, issues } = parseDataset(files());
    expect(issues).toEqual([]);
    expect(dataset.contracts).toEqual([{ contractId: "C1", customerName: "ABC株式会社", projectName: "保守", teamId: "T1", startMonth: "2026-04", endMonth: "2027-03", totalAmount: 2_400_000, note: "メモ, 改行\nあり" }]);
    expect(dataset.mappings).toEqual([{ worklogCustomerName: "（株）ABC", worklogProjectName: "", contractId: "C1" }]);
    expect(dataset.assignments).toEqual([{ memberId: "M1", contractId: "C1", startMonth: "2026-04", endMonth: "2027-03", allocation: 0.5 }]);
    expect(dataset.teams).toEqual([{ teamId: "ROOT", name: "全社", parentTeamId: null, effectiveFrom: "2000-01" }, { teamId: "T1", name: "開発", parentTeamId: "ROOT", effectiveFrom: "2000-01" }]);
    expect(dataset.members[0]).toEqual({ memberId: "M1", name: "山田 太郎", kind: "employee", title: "SE", department: "開発部", section: "1課", teamId: "T1", effectiveFrom: "2000-01" });
    expect(dataset.members[1]?.teamId).toBeNull();
    expect(dataset.rates).toEqual([{ key: "SE", hourlyRate: 5000, effectiveFrom: "2000-01" }, { key: "M2", hourlyRate: 4000, effectiveFrom: "2000-01" }]);
    expect(dataset.holidays).toEqual([{ date: "2026-01-01", name: "元日" }]);
    expect(dataset.worklogs).toEqual([
      { date: "2026-05-10", memberId: "M1", memberName: "山田", customerName: "ABC株式会社", projectName: "保守", task: "作業", hours: 1.5 },
      { date: "2026-06-10", memberId: "M2", memberName: "鈴木", customerName: "ABC株式会社", projectName: "保守", task: "作業", hours: 0.25 },
    ]);
    expect(dataset.worklogFetchedAt).toBe("2026-10-27T00:00:00Z");
    expect(dataset.config).toBe(baseConfig);
  });

  it("note が空なら省略、worklogFetchedAt が無ければ undefined", () => {
    const f = files({ contracts: "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\nC1,A,P,,2026-04,2027-03,100\n" });
    delete f.worklogFetchedAt;
    const { dataset } = parseDataset(f);
    expect("note" in (dataset.contracts[0] ?? {})).toBe(false);
    expect(dataset.contracts[0]?.teamId).toBeNull();
    expect("worklogFetchedAt" in dataset).toBe(false);
  });

  it("列の順序が違っても・余分な列があっても読める", () => {
    const { dataset, issues } = parseDataset(files({ holidays: "extra,name,date\nx,元日,2026-01-01\n" }));
    expect(issues).toEqual([]);
    expect(dataset.holidays).toEqual([{ date: "2026-01-01", name: "元日" }]);
  });

  it("必須列が無ければ MISSING_COLUMN エラー", () => {
    const { issues } = parseDataset(files({ rates: "key,rate\nSE,1\n" }));
    expect(issues.some((i) => i.code === "MISSING_COLUMN" && i.severity === "error" && i.file === "masters/rates.csv")).toBe(true);
  });

  it("数値の不正は NaN になり検証でエラー", () => {
    const { dataset, issues } = parseDataset(files({ rates: "key,hourly_rate,effective_from\nSE,abc,2000-01\n" }));
    expect(dataset.rates[0]?.hourlyRate).toBeNaN();
    expect(issues.find((i) => i.code === "RATE_INVALID")).toMatchObject({ severity: "error", file: "masters/rates.csv", row: 2 });
  });

  it("空ファイル（ヘッダ無し）は列の欠落として報告し、データは 0 件", () => {
    const { dataset, issues } = parseDataset(files({ holidays: "" }));
    expect(dataset.holidays).toEqual([]);
    expect(issues.filter((i) => i.code === "MISSING_COLUMN").map((i) => i.ref?.column)).toEqual(["date", "name"]);
  });

  it("worklogs が 0 ファイルでも動く", () => {
    const { dataset, issues } = parseDataset(files({ worklogs: [] }));
    expect(dataset.worklogs).toEqual([]);
    expect(issues).toEqual([]);
  });
});
