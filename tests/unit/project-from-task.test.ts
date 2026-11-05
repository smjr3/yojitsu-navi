/**
 * 作業名から案件名を抜き出して紐付ける（SPEC §97）
 */
import { describe, expect, it } from "vitest";
import {
  buildModel,
  createProjectMatcher,
  createTaskClassifier,
  extractProjectName,
  findTaskCodeIssues,
  mapWorklogs,
  parseDataset,
  projectFromTaskEnabled,
  validateDataset,
  validateProjectAliases,
} from "../../src/core/index.js";
import type { Config, MappingRule, ProjectAlias, Worklog } from "../../src/core/types.js";
import { baseConfig, contract, dataset, member, rate, rule, team, worklog } from "./fixtures.js";

const MARK = "_保守対応";
const CFG = { marker: MARK };
const wl = (date: string, task: string, hours = 1, extra: Partial<Worklog> = {}): Worklog => worklog({ date, memberId: "M1", customerName: "", projectName: "", task, hours, ...extra });

// 架空の案件。同じ案件名の契約が更新で 2 つ（期間で分かれる）
const OLD = contract({ contractId: "C1", customerName: "架空商事", projectName: "2026-04 架空 受発注システム保守", startMonth: "2025-04", endMonth: "2026-03" });
const NEW = contract({ contractId: "C2", customerName: "架空商事", projectName: "2026-04 架空 受発注システム保守", startMonth: "2026-04", endMonth: "2027-03" });
const OTHER = contract({ contractId: "C3", customerName: "見本工業", projectName: "見本 生産管理保守", startMonth: "2026-04", endMonth: "2027-03" });
const CONTRACTS = [OLD, NEW, OTHER];

describe("extractProjectName", () => {
  it("最初の目印より前を返す。後ろの括弧内の表記は使わない", () => {
    expect(extractProjectName("2026-04 架空 受発注システム保守_保守対応（問い合わせ）", MARK)).toBe("2026-04 架空 受発注システム保守");
    expect(extractProjectName("見本 生産管理保守_保守対応_保守対応(夜間)", MARK)).toBe("見本 生産管理保守");
    expect(extractProjectName("見本 生産管理保守_保守対応 定例 [臨時]", MARK)).toBe("見本 生産管理保守");
  });

  it("目印は全角半角・空白を区別しない。目印が無ければ null", () => {
    expect(extractProjectName("見本 生産管理保守＿保守対応", MARK)).toBe("見本 生産管理保守");
    expect(extractProjectName("見本 生産管理保守 _ 保守 対応", MARK)).toBe("見本 生産管理保守");
    expect(extractProjectName("ＡＢＣ保守_保守対応", MARK)).toBe("ABC保守");
    expect(extractProjectName("見本 生産管理保守_導入", MARK)).toBeNull();
    expect(extractProjectName("_保守対応", MARK)).toBe("");
  });

  it("設定が無い・目印が空・enabled: false なら使わない", () => {
    expect(projectFromTaskEnabled(undefined)).toBe(false);
    expect(projectFromTaskEnabled({ marker: " " })).toBe(false);
    expect(projectFromTaskEnabled({ marker: MARK, enabled: false })).toBe(false);
    expect(projectFromTaskEnabled({ marker: MARK })).toBe(true);
  });
});

describe("案件名での紐付け（mapWorklogs）", () => {
  const projects = (aliases: ProjectAlias[] = []) => createProjectMatcher(CFG, CONTRACTS, aliases);

  it("案件名が完全一致する契約へ、作業日の月で紐付く（顧客名が空でもよい・作業コードの事前登録は要らない）", () => {
    const r = mapWorklogs(
      [wl("2026-03-31", "2026-04 架空 受発注システム保守_保守対応（障害）", 2), wl("2026-04-01", "２０２６－０４ 架空 受発注システム保守_保守対応", 3, { taskCode: "X-1" })],
      [],
      CONTRACTS,
      new Map(),
      projects(),
    );
    expect(r.assigned.map((a) => a.contractId)).toEqual(["C1", "C2"]);
    expect(r.warnings).toEqual([]);
  });

  it("曖昧一致はしない: 一部だけ同じ名前は「未登録の案件」で未紐付け（抜き出した名前でまとめる）", () => {
    const r = mapWorklogs([wl("2026-05-01", "架空 受発注システム保守_保守対応", 2), wl("2026-05-02", "架空 受発注システム保守_保守対応（定例）", 1)], [], CONTRACTS, new Map(), projects());
    expect(r.assigned).toEqual([]);
    expect(r.unmapped).toMatchObject([{ reason: "UNREGISTERED_PROJECT", projectName: "架空 受発注システム保守", fromTask: true, hours: 3, count: 2 }]);
    expect(r.warnings.map((w) => w.message)).toEqual([expect.stringContaining("未登録の案件")]);
  });

  it("別名を明示的に登録したものだけ紐付く", () => {
    const r = mapWorklogs([wl("2026-05-01", "架空 受発注システム保守_保守対応")], [], CONTRACTS, new Map(), projects([{ alias: "架空 受発注システム保守", projectName: "2026-04 架空 受発注システム保守" }]));
    expect(r.assigned.map((a) => a.contractId)).toEqual(["C2"]);
  });

  it("mapping.csv の行（作業コード・名前）が先。人が書いた行を優先する", () => {
    const rules: MappingRule[] = [{ worklogCustomerName: "", worklogProjectName: "", contractId: "C3", taskCode: "K-1" }, rule("架空商事", "", "C3")];
    const r = mapWorklogs(
      [wl("2026-05-01", "2026-04 架空 受発注システム保守_保守対応", 1, { taskCode: "K-1" }), wl("2026-05-01", "2026-04 架空 受発注システム保守_保守対応", 1, { customerName: "架空商事" }), wl("2026-05-01", "2026-04 架空 受発注システム保守_保守対応", 1, { customerName: "別の顧客" })],
      rules,
      CONTRACTS,
      new Map(),
      projects(),
    );
    expect(r.assigned.map((a) => a.contractId)).toEqual(["C3", "C3", "C2"]);
  });

  it("契約期間外・除外中の契約は従来の理由で未紐付け", () => {
    const r = mapWorklogs([wl("2027-04-01", "見本 生産管理保守_保守対応")], [], CONTRACTS, new Map(), projects());
    expect(r.unmapped).toMatchObject([{ reason: "OUT_OF_PERIOD", projectName: "見本 生産管理保守", fromTask: true }]);
    const ex = mapWorklogs([wl("2026-05-01", "見本 生産管理保守_保守対応")], [], [OLD, NEW], new Map([["C3", "金額が不正"]]), projects());
    expect(ex.unmapped).toMatchObject([{ reason: "EXCLUDED_CONTRACT" }]);
  });

  it("目印の無い作業は従来どおり（顧客名なしは除外、ルールなしは未紐付け）", () => {
    const r = mapWorklogs([wl("2026-05-01", "会議"), wl("2026-05-01", "会議", 1, { customerName: "見本工業" })], [], CONTRACTS, new Map(), projects());
    expect(r.excludedHours).toBe(1);
    expect(r.unmapped).toMatchObject([{ reason: "NO_RULE", customerName: "見本工業" }]);
  });

  it("設定が無ければ作業名は見ない（従来どおり）", () => {
    const r = mapWorklogs([wl("2026-05-01", "見本 生産管理保守_保守対応", 1, { customerName: "見本工業" })], [], CONTRACTS, new Map(), createProjectMatcher(undefined, CONTRACTS));
    expect(r.unmapped).toMatchObject([{ reason: "NO_RULE" }]);
  });
});

describe("運用保守かどうか（分類）", () => {
  const projects = createProjectMatcher(CFG, CONTRACTS);
  it("目印があれば運用保守、目印も紐付けの行も無ければ運用保守以外（キーワードに合致しない一覧には出さない）", () => {
    const c = createTaskClassifier([], [rule("見本工業", "", "C3")], projects);
    expect(c.classifyWorklog(wl("2026-05-01", "見本 生産管理保守_保守対応")).category).toBe("contract");
    const other = c.classifyWorklog(wl("2026-05-01", "社内研修"));
    expect(other.category).toBe("outside");
    expect(other.keywordMiss).toBeUndefined();
    // 名前の行がある作業は分類表で決める（従来どおり）
    expect(c.classifyWorklog(wl("2026-05-01", "社内研修", 1, { customerName: "見本工業" })).category).toBe("contract");
  });
});

describe("Model・検証", () => {
  const cfg: Config = { ...baseConfig, projectFromTask: CFG, taskCodeCheck: { include: [MARK] } };
  const base = {
    config: cfg,
    contracts: CONTRACTS,
    teams: [team("T1", null)],
    members: [member({ memberId: "M1", teamId: "T1" })],
    rates: [rate("一般", 5000)],
  };

  it("案件名で紐付いた作業の作業コードは未登録に数えない。未登録の案件は未紐付けの一覧に出る", () => {
    const ds = dataset({
      ...base,
      worklogs: [wl("2026-05-01", "見本 生産管理保守_保守対応", 2, { taskCode: "N-1" }), wl("2026-05-01", "見本 未知の保守_保守対応", 1, { taskCode: "N-2" }), wl("2026-05-01", "社内研修", 4)],
    });
    const m = buildModel(ds, { asOf: "2026-05-20", generatedAt: "x" });
    expect(m.contracts.find((c) => c.contract.contractId === "C3")!.months.find((x) => x.month === "2026-05")!.hours).toBe(2);
    expect(m.unmapped).toMatchObject([{ reason: "UNREGISTERED_PROJECT", projectName: "見本 未知の保守", hours: 1 }]);
    expect(m.unregisteredTaskCodes!.map((u) => u.taskCode)).toEqual(["N-2"]);
    expect(m.keywordUnmatched).toEqual([]);
    const issues = validateDataset(ds);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(issues.filter((i) => i.code === "TASK_CODE_UNREGISTERED").map((i) => i.severity)).toEqual(["warning"]);
  });

  it("findTaskCodeIssues: 案件名で契約が見つかるコードは未登録にしない", () => {
    const projects = createProjectMatcher(CFG, CONTRACTS);
    const f = findTaskCodeIssues([wl("2026-05-01", "見本 生産管理保守_保守対応", 1, { taskCode: "N-1" })], [], { include: [MARK] }, projects);
    expect(f.unregistered).toEqual([]);
  });

  it("project-aliases.csv を読み、別名の不備を検証する", () => {
    const files = {
      config: cfg,
      contracts: "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\nC3,見本工業,見本 生産管理保守,,2026-04,2027-03,1200000\n",
      mapping: "worklog_customer_name,worklog_project_name,contract_id\n",
      assignments: "member_id,contract_id,start_month,end_month,allocation\n",
      teams: "team_id,name,parent_team_id,effective_from\n",
      members: "member_id,name,kind,team_id,title,effective_from\n",
      rates: "key,hourly_rate,effective_from\n",
      holidays: "date,name\n",
      projectAliases: "alias,project_name\n見本生産管理,見本 生産管理保守\n見本生産管理,別の案件\n見本 生産管理保守,見本 生産管理保守\n,見本 生産管理保守\n存在しない別名,存在しない案件\n",
      worklogs: [],
    };
    const r = parseDataset(files);
    expect(r.dataset.projectAliases).toHaveLength(5);
    const codes = r.issues.filter((i) => i.file === "project-aliases.csv").map((i) => [i.code, i.severity, i.row]);
    expect(codes).toEqual([
      ["ALIAS_UNKNOWN_PROJECT", "warning", 3],
      ["ALIAS_DUPLICATE", "error", 3],
      ["ALIAS_SHADOWED", "warning", 4],
      ["ALIAS_EMPTY", "error", 5],
      ["ALIAS_UNKNOWN_PROJECT", "warning", 6],
    ]);
  });

  it("validateProjectAliases: 複数の案件名を指す別名は照合に使わない", () => {
    const aliases = [
      { alias: "見本", projectName: "見本 生産管理保守" },
      { alias: "見本", projectName: "2026-04 架空 受発注システム保守" },
    ];
    expect(validateProjectAliases(aliases, CONTRACTS).map((i) => i.code)).toEqual(["ALIAS_DUPLICATE"]);
    expect(createProjectMatcher(CFG, CONTRACTS, aliases).contractIdsFor("見本")).toBeNull();
  });
});
