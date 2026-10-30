/**
 * 作業名のキーワードで運用保守を振り分ける（SPEC §62）
 */
import { describe, expect, it } from "vitest";
import { buildModel, createKeywordRouter, createTaskClassifier, parseDataset, splitKeywords, validateDataset, workByTask } from "../../src/core/index.js";
import type { MappingRule, TaskTypeRule } from "../../src/core/types.js";
import { baseConfig, contract, dataset, member, rate, rule, team, worklog } from "./fixtures.js";

const kwRule = (customer: string, project: string, contractId: string, include: string[], exclude: string[] = []): MappingRule => ({
  ...rule(customer, project, contractId),
  ...(include.length > 0 ? { taskInclude: include } : {}),
  ...(exclude.length > 0 ? { taskExclude: exclude } : {}),
});

const TYPES: TaskTypeRule[] = [
  { task: "定例", category: "contract", match: "contains" },
  { task: "障害", category: "contract", match: "contains" },
  { task: "導入", category: "outside", group: "構築", match: "contains" },
  { task: "提案", category: "outside" },
];

describe("splitKeywords", () => {
  it("| と全角の ｜ で分け、空白だけのキーワードは捨てる", () => {
    expect(splitKeywords("保守| 定例 ｜｜ ")).toEqual(["保守", "定例"]);
    expect(splitKeywords("")).toEqual([]);
    expect(splitKeywords(undefined)).toEqual([]);
  });
});

describe("createKeywordRouter", () => {
  const router = createKeywordRouter([kwRule("ABC株式会社", "基幹", "C1", ["【保守】", "ＨＤ"], ["導入"]), rule("XYZ", "", "C2")]);
  const w = (task: string, customerName = "ABC", projectName = "基幹") => ({ customerName, projectName, task });
  it("含むのどれかに合えば hit。全角半角・大小文字・空白を問わない", () => {
    expect(router.enabled).toBe(true);
    expect(router.match(w("【保守】月次 定例"))).toBe("hit");
    expect(router.match(w("hd 問い合わせ"))).toBe("hit");
  });
  it("除くは含むより優先。合わなければ miss", () => {
    expect(router.match(w("【保守】導入支援"))).toBe("miss");
    expect(router.match(w("設計レビュー"))).toBe("miss");
  });
  it("キーワードの無いルール・ルールなし・顧客名なしは none", () => {
    expect(router.match(w("何でも", "XYZ", "どれでも"))).toBe("none");
    expect(router.match(w("何でも", "未登録", "x"))).toBe("none");
    expect(router.match(w("【保守】", "", ""))).toBe("none");
  });
  it("キーワードが 1 行も無ければ無効", () => {
    expect(createKeywordRouter([rule("ABC", "基幹", "C1")]).enabled).toBe(false);
  });
});

describe("分類表の「含む」（§62.2）", () => {
  const c = createTaskClassifier(TYPES);
  it("完全一致を先に、無ければファイルの順で最初に含む行。内訳の表記は行の task", () => {
    expect(c.classify("【保守】月次定例")).toEqual({ category: "contract", group: "", label: "定例", unclassified: false });
    expect(c.classify("サーバ導入作業")).toEqual({ category: "outside", group: "構築", label: "導入", unclassified: false });
    expect(c.classify("障害対応（導入後）").label).toBe("障害");
    expect(c.classify("提案")).toMatchObject({ category: "outside", label: "提案" });
    // 完全一致の行（match なし）は部分一致しない
    expect(c.classify("追加提案")).toMatchObject({ category: "contract", unclassified: true, label: "追加提案" });
  });
});

describe("buildModel: 作業名のキーワードで運用保守を抜き出す（§62.1・§62.3）", () => {
  const data = dataset({
    contracts: [contract({ contractId: "C1", customerName: "ABC", projectName: "基幹", teamId: "T1" })],
    mappings: [kwRule("ABC", "基幹", "C1", ["【保守】"])],
    teams: [team("ROOT", null), team("T1", "ROOT")],
    members: [member({ memberId: "M1", teamId: "T1" })],
    rates: [rate("SE", 5000)],
    taskTypes: TYPES,
    worklogs: [
      worklog({ date: "2026-04-01", memberId: "M1", customerName: "ABC", projectName: "基幹", task: "【保守】月次定例", hours: 2 }),
      worklog({ date: "2026-04-02", memberId: "M1", customerName: "ABC", projectName: "基幹", task: "【保守】障害一次対応", hours: 1 }),
      // 分類表では運用保守以外でも、キーワードに合えば運用保守
      worklog({ date: "2026-04-03", memberId: "M1", customerName: "ABC", projectName: "基幹", task: "【保守】更改の提案", hours: 0.5 }),
      // キーワードに合わない → 運用保守以外（種別は分類表、無ければ「その他」）
      worklog({ date: "2026-04-04", memberId: "M1", customerName: "ABC", projectName: "基幹", task: "新拠点の導入", hours: 4 }),
      worklog({ date: "2026-04-05", memberId: "M1", customerName: "ABC", projectName: "基幹", task: "月次定例", hours: 1 }),
      worklog({ date: "2026-04-06", memberId: "M1", customerName: "ABC", projectName: "基幹", task: "設計レビュー", hours: 3 }),
      worklog({ date: "2026-04-20", memberId: "M1", customerName: "ABC", projectName: "基幹", task: "設計レビュー", hours: 1 }),
    ],
  });
  const model = buildModel(data, { asOf: "2026-05-20", generatedAt: "x" });
  const apr = model.contracts[0]!.months.find((m) => m.month === "2026-04")!;

  it("案件の実績はキーワードに合った作業だけ", () => {
    expect(apr.hours).toBe(3.5);
    expect(apr.cost).toBe(3.5 * 5000);
  });
  it("合わない作業は運用保守以外として稼働実績に残り、関連案件が付く", () => {
    const outside = model.workRows.filter((r) => r.category === "outside");
    expect(outside.reduce((s, r) => s + r.hours, 0)).toBe(9);
    expect(outside.every((r) => r.contractId === "C1" && r.amount === null)).toBe(true);
  });
  it("作業種別の内訳は分類表の表記でまとまる", () => {
    expect(workByTask(model.workRows).map((l) => [l.category, l.task, l.hours])).toEqual([
      ["contract", "定例", 2],
      ["contract", "障害", 1],
      ["contract", "【保守】更改の提案", 0.5],
      ["outside", "導入", 4],
      ["outside", "設計レビュー", 4],
      ["outside", "定例", 1],
    ]);
  });
  it("メンバー別の運用保守以外の種別は分類表の group、無ければ「その他」", () => {
    const m = model.memberMonths.find((x) => x.memberId === "M1" && x.month === "2026-04")!;
    const types = m.byContract.filter((r) => r.outsideType !== undefined).map((r) => [r.outsideType, r.actualHours]);
    expect(types.sort()).toEqual([["その他", 5], ["構築", 4]].sort());
  });
  it("キーワードに合わない作業の一覧（作業名ごと、時間の多い順）", () => {
    expect(model.keywordUnmatched.map((g) => [g.task, g.type, g.hours, g.count, g.firstDate, g.lastDate])).toEqual([
      ["新拠点の導入", "構築", 4, 1, "2026-04-04", "2026-04-04"],
      ["設計レビュー", "その他", 4, 2, "2026-04-06", "2026-04-20"],
      ["月次定例", "その他", 1, 1, "2026-04-05", "2026-04-05"],
    ]);
  });
  it("キーワードで決まった作業は未分類の警告を出さない", () => {
    expect(model.warnings.map((w) => w.code)).not.toContain("TASK_UNCLASSIFIED");
    expect(validateDataset(data).map((i) => i.code)).not.toContain("TASK_UNCLASSIFIED");
  });
  it("キーワードで同じ案件名の契約を分けられる", () => {
    const d = dataset({
      ...data,
      contracts: [contract({ contractId: "C1", customerName: "ABC", projectName: "基幹" }), contract({ contractId: "C2", customerName: "ABC", projectName: "基幹" })],
      mappings: [kwRule("ABC", "基幹", "C1", ["【保守】"]), kwRule("ABC", "基幹", "C2", ["【監視】"])],
      worklogs: [
        worklog({ date: "2026-04-01", memberId: "M1", customerName: "ABC", projectName: "基幹", task: "【保守】定例", hours: 2 }),
        worklog({ date: "2026-04-02", memberId: "M1", customerName: "ABC", projectName: "基幹", task: "【監視】日次", hours: 3 }),
      ],
    });
    const m = buildModel(d, { asOf: "2026-05-20", generatedAt: "x" });
    const hours = (id: string) => m.contracts.find((c) => c.contract.contractId === id)!.months.find((x) => x.month === "2026-04")!.hours;
    expect([hours("C1"), hours("C2")]).toEqual([2, 3]);
    expect(m.warnings.map((w) => w.code)).not.toContain("MAPPING_AMBIGUOUS");
  });
  it("合った行の契約が存在しないときは別の契約に回さず未紐付け", () => {
    const d = dataset({
      ...data,
      contracts: [contract({ contractId: "C1", customerName: "ABC", projectName: "基幹" })],
      mappings: [kwRule("ABC", "基幹", "C1", ["【保守】"]), kwRule("ABC", "基幹", "C9", ["【監視】"])],
      worklogs: [worklog({ date: "2026-04-02", memberId: "M1", customerName: "ABC", projectName: "基幹", task: "【監視】日次", hours: 8 })],
    });
    const m = buildModel(d, { asOf: "2026-05-20", generatedAt: "x" });
    expect(m.contracts[0]!.months.find((x) => x.month === "2026-04")!.hours).toBe(0);
    expect(m.unmapped).toMatchObject([{ reason: "UNKNOWN_CONTRACT", hours: 8 }]);
  });
  it("キーワードを使わなければ一覧は空（従来どおり）", () => {
    const m = buildModel({ ...data, mappings: [rule("ABC", "基幹", "C1")] }, { asOf: "2026-05-20", generatedAt: "x" });
    expect(m.keywordUnmatched).toEqual([]);
  });
});

describe("CSV の読み込み（§62）", () => {
  const files = (mapping: string, taskTypes?: string) => ({
    config: baseConfig,
    contracts: "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\n",
    mapping,
    assignments: "member_id,contract_id,start_month,end_month,allocation\n",
    teams: "team_id,name,parent_team_id,effective_from\n",
    members: "member_id,name,kind,title,department,section,team_id,effective_from\n",
    rates: "key,hourly_rate,effective_from\n",
    holidays: "date,name\n",
    worklogs: [],
    ...(taskTypes === undefined ? {} : { taskTypes }),
  });
  it("mapping.csv の task_include / task_exclude は省略可", () => {
    const r = parseDataset(files("worklog_customer_name,worklog_project_name,contract_id,task_include,task_exclude\nABC,基幹,C1,【保守】|定例,導入\nABC,,C2,,\n"));
    expect(r.dataset.mappings).toEqual([
      { worklogCustomerName: "ABC", worklogProjectName: "基幹", contractId: "C1", taskInclude: ["【保守】", "定例"], taskExclude: ["導入"] },
      { worklogCustomerName: "ABC", worklogProjectName: "", contractId: "C2" },
    ]);
    const old = parseDataset(files("worklog_customer_name,worklog_project_name,contract_id\nABC,基幹,C1\n"));
    expect(old.dataset.mappings).toEqual([{ worklogCustomerName: "ABC", worklogProjectName: "基幹", contractId: "C1" }]);
  });
  it("task-types.csv の match は 空・完全一致・含む。それ以外はエラーで除く", () => {
    const r = parseDataset(files("worklog_customer_name,worklog_project_name,contract_id\n", "task,category,match\n定例,運用保守,含む\n提案,運用保守以外,完全一致\n導入,運用保守以外,contains\n設計,運用保守以外,前方一致\n"));
    expect(r.dataset.taskTypes).toEqual([
      { task: "定例", category: "contract", match: "contains" },
      { task: "提案", category: "outside" },
      { task: "導入", category: "outside", match: "contains" },
    ]);
    expect(r.issues.filter((i) => i.file === "task-types.csv").map((i) => [i.code, i.row])).toEqual([["TASK_MATCH_INVALID", 5]]);
  });
});
