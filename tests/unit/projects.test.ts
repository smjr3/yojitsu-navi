/**
 * 正式な案件の一覧と契約の照合（SPEC §98）: src/core/projects.ts・scripts/lib/projects-merge.ts・contracts.csv の project_id
 */
import { describe, expect, it } from "vitest";
import { checkProjects, validateProjects } from "../../src/core/projects.js";
import { parseDataset } from "../../src/core/csv.js";
import type { Contract, Project } from "../../src/core/types.js";
import { formatProjectsCsv, syncContracts } from "../../scripts/lib/projects-merge.js";
import { testConfig } from "../fixtures/project.js";

const c = (contractId: string, projectName: string, projectId?: string, customerName = "顧客A"): Contract => ({
  contractId,
  customerName,
  projectName,
  teamId: null,
  startMonth: "2026-04",
  endMonth: "2027-03",
  totalAmount: 1200000,
  ...(projectId ? { projectId } : {}),
});
const P: Project[] = [
  { projectId: "P2", customerName: "顧客A", projectName: "基幹保守" },
  { projectId: "P1", customerName: "顧客B", projectName: "ＥＣサイト保守" },
  { projectId: "P3", customerName: "顧客C", projectName: "新規案件" },
];

describe("checkProjects", () => {
  it("一覧が無ければ照合しない", () => {
    expect(checkProjects([c("C1", "x")], undefined).enabled).toBe(false);
    expect(validateProjects({ contracts: [c("C1", "x", "NONE")] })).toEqual([]);
  });

  it("未照合・一覧に無いID・名前の違い・契約の無い案件を分ける", () => {
    const r = checkProjects([c("C1", "基幹保守", "P2"), c("C2", "基幹保守", "P2", "顧客A2"), c("C3", "ECサイト保守"), c("C4", "なにか", "P9")], P);
    expect(r.linked).toBe(3);
    // 候補は案件名の正規化（全角・半角）で同じもの。自動では入れない
    expect(r.unlinked).toEqual([expect.objectContaining({ contractId: "C3", candidates: ["P1"] })]);
    expect(r.unknown.map((u) => u.contractId)).toEqual(["C4"]);
    expect(r.mismatched).toEqual([{ contractId: "C2", projectId: "P2", field: "customer_name", current: "顧客A2", official: "顧客A" }]);
    // 更新前後で同じ案件ID を使う契約があっても、その案件は「契約の無い案件」にならない
    expect(r.unregistered.map((p) => p.projectId)).toEqual(["P1", "P3"]);
  });

  it("検証: 一覧の ID の空・重複は error、契約側は warning", () => {
    const issues = validateProjects({ contracts: [c("C1", "基幹保守", "P2", "古い顧客名"), c("C4", "なにか", "P9")], projects: [...P, { projectId: "P2", customerName: "x", projectName: "y" }, { projectId: "", customerName: "", projectName: "" }] });
    expect(issues.map((i) => [i.severity, i.code, i.row])).toEqual([
      ["error", "DUPLICATE_PROJECT_ID", 5],
      ["error", "PROJECT_ID_EMPTY", 6],
      ["warning", "PROJECT_ID_UNKNOWN", 3],
      ["warning", "PROJECT_NAME_MISMATCH", 2],
    ]);
  });
});

describe("contracts.csv の project_id・projects.csv の読み込み", () => {
  const base = { config: testConfig() as never, mapping: "worklog_customer_name,worklog_project_name,contract_id\n", assignments: "member_id,contract_id,start_month,end_month,allocation\n", teams: "team_id,name,parent_team_id,effective_from\n", members: "member_id,name,kind,title,department,section,team_id,effective_from\n", rates: "key,hourly_rate,effective_from\n", holidays: "date,name\n", worklogs: [] };
  it("project_id の列は省略できる。空白は除く。projects.csv が無ければ照合しない", () => {
    const old = parseDataset({ ...base, contracts: "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\nC1,A,B,,2026-04,2027-03,100\n" });
    expect(old.dataset.contracts[0]?.projectId).toBeUndefined();
    expect(old.dataset.projects).toBeUndefined();
    expect(old.issues.filter((i) => i.severity === "error")).toEqual([]);
    const next = parseDataset({ ...base, contracts: "contract_id,project_id,customer_name,project_name,team_id,start_month,end_month,total_amount\nC1, P1 ,A,B,,2026-04,2027-03,100\n", projects: "project_id,customer_name,project_name\nP1,A,B\n" });
    expect(next.dataset.contracts[0]?.projectId).toBe("P1");
    expect(next.dataset.projects).toEqual([{ projectId: "P1", customerName: "A", projectName: "B" }]);
    expect(next.issues.filter((i) => i.code.startsWith("PROJECT"))).toEqual([]);
  });
  it("projects.csv の列が欠けていればエラー", () => {
    const r = parseDataset({ ...base, contracts: "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\n", projects: "id,name\nP1,A\n" });
    expect(r.issues.some((i) => i.code === "MISSING_COLUMN" && i.file === "projects.csv")).toBe(true);
  });
});

describe("syncContracts", () => {
  const headers = ["contract_id", "customer_name", "project_name", "team_id", "start_month", "end_month", "total_amount", "note"];
  const row = (id: string, name: string, extra: Record<string, string> = {}) => ({ contract_id: id, customer_name: "旧", project_name: name, team_id: "T1", start_month: "2026-04", end_month: "2027-03", total_amount: "100", note: "", ...extra });

  it("指示が無ければ案件ID の無い行を埋めず、列も足さない", () => {
    const r = syncContracts([row("C1", "基幹保守")], headers, P);
    expect(r.changes).toEqual([]);
    expect(r.headers).toEqual(headers);
  });

  it("linkExact: 1 件だけ同じ案件名なら入れて名前をそろえ、列は contract_id の次", () => {
    const r = syncContracts([row("C1", "基幹保守"), row("C2", "EC サイト保守")], headers, P, { linkExact: true });
    expect(r.headers.slice(0, 2)).toEqual(["contract_id", "project_id"]);
    expect(r.rows[0]).toMatchObject({ project_id: "P2", customer_name: "顧客A", project_name: "基幹保守", team_id: "T1", total_amount: "100" });
    // 空白の違いは同じとみなさない（§4.1 は空白を 1 つにまとめるだけ）
    expect(r.rows[1]?.project_id).toBeUndefined();
  });

  it("idFromNote: メモの ID を移す。一覧に無い ID でも移すが名前は変えない", () => {
    const r = syncContracts([row("C1", "x", { note: "FY2026 [P3] 更新" }), row("C2", "y", { note: "[P404]" })], headers, P, { idFromNote: /\[(P\d+)\]/u });
    expect(r.rows[0]).toMatchObject({ project_id: "P3", note: "FY2026 更新", project_name: "新規案件" });
    expect(r.rows[1]).toMatchObject({ project_id: "P404", note: "", project_name: "y", customer_name: "旧" });
  });

  it("projects.csv は案件ID順（言語に依らない）", () => {
    expect(formatProjectsCsv(P).split("\n").slice(1, 4).map((l) => l.split(",")[0])).toEqual(["P1", "P2", "P3"]);
  });
});
