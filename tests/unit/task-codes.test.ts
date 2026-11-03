/**
 * 作業コードでの紐付け・行の期間・未登録の作業コードと作業名の変更の点検（SPEC §92）
 */
import { describe, expect, it } from "vitest";
import {
  buildModel,
  createKeywordRouter,
  createTaskClassifier,
  findTaskCodeIssues,
  mapWorklogs,
  parseDataset,
  validateDataset,
  validateMappingPeriods,
} from "../../src/core/index.js";
import type { MappingRule, TaskCodeCheckConfig, Worklog } from "../../src/core/types.js";
import { baseConfig, contract, dataset, member, rate, rule, team, worklog } from "./fixtures.js";

const codeRule = (code: string, contractId: string, startMonth?: string, endMonth?: string): MappingRule => ({
  worklogCustomerName: "",
  worklogProjectName: "",
  contractId,
  taskCode: code,
  ...(startMonth ? { startMonth } : {}),
  ...(endMonth ? { endMonth } : {}),
});
const wl = (date: string, task: string, taskCode: string | undefined, hours = 1, extra: Partial<Worklog> = {}): Worklog =>
  worklog({ date, memberId: "M1", customerName: "ABC", projectName: "基幹", task, hours, ...(taskCode !== undefined ? { taskCode } : {}), ...extra });

// 旧契約（〜2026-03）と更新後の契約（2026-04〜）
const OLD = contract({ contractId: "C1", startMonth: "2025-04", endMonth: "2026-03" });
const NEW = contract({ contractId: "C2", startMonth: "2026-04", endMonth: "2027-03" });
const CHECK: TaskCodeCheckConfig = { include: ["_保守対応"] };

describe("作業コードでの紐付け（mapWorklogs）", () => {
  it("同じ作業コードを期間の違う案件に対応付け、作業日の月で決める（契約の更新）", () => {
    const r = mapWorklogs(
      [wl("2026-03-31", "問い合わせ_保守対応", "W-01"), wl("2026-04-01", "問い合わせ_保守対応", "W-01")],
      [codeRule("W-01", "C1", "", "2026-03"), codeRule("W-01", "C2", "2026-04")],
      [OLD, NEW],
    );
    expect(r.assigned.map((a) => a.contractId)).toEqual(["C1", "C2"]);
    expect(r.warnings).toEqual([]);
  });

  it("作業コードの行は顧客名・案件名の行より先。顧客名が空でも紐付く。コードは全角・小文字の違いを無視する", () => {
    const r = mapWorklogs([wl("2026-05-01", "問い合わせ", "ｗ－01", 2, { customerName: "" })], [rule("ABC", "基幹", "C1"), codeRule("W-01", "C2")], [OLD, NEW]);
    expect(r.assigned.map((a) => a.contractId)).toEqual(["C2"]);
  });

  it("行の期間に入らない作業は「対応表の期間外」で未紐付け。名前の行には回さない", () => {
    const r = mapWorklogs([wl("2027-04-01", "問い合わせ", "W-01", 3)], [rule("ABC", "基幹", "C2"), codeRule("W-01", "C2", "2026-04", "2027-03")], [OLD, NEW]);
    expect(r.assigned).toEqual([]);
    expect(r.unmapped).toMatchObject([{ reason: "RULE_OUT_OF_PERIOD", taskCode: "W-01", hours: 3 }]);
    expect(r.warnings[0]!.message).toContain("作業コード W-01");
  });

  it("作業コードの行が無いコードは、従来どおり顧客名・案件名で紐付ける", () => {
    const r = mapWorklogs([wl("2026-05-01", "問い合わせ", "W-99")], [rule("ABC", "基幹", "C2"), codeRule("W-01", "C1")], [OLD, NEW]);
    expect(r.assigned.map((a) => a.contractId)).toEqual(["C2"]);
  });

  it("名前の行にも期間を書ける。期間の外は未紐付け（契約期間の内でも）", () => {
    const rules: MappingRule[] = [{ ...rule("ABC", "基幹", "C2"), startMonth: "2026-06" }];
    const r = mapWorklogs([wl("2026-05-01", "問い合わせ", undefined), wl("2026-06-01", "問い合わせ", undefined)], rules, [OLD, NEW]);
    expect(r.assigned.map((a) => a.worklog.date)).toEqual(["2026-06-01"]);
    expect(r.unmapped).toMatchObject([{ reason: "RULE_OUT_OF_PERIOD", count: 1 }]);
    expect(r.unmapped[0]!.taskCode).toBeUndefined();
  });

  it("同じ作業コードが同じ月に 2 つの案件を指すと、契約ID昇順の先頭にして MAPPING_AMBIGUOUS", () => {
    const both = contract({ contractId: "C3", startMonth: "2026-04", endMonth: "2027-03" });
    const r = mapWorklogs([wl("2026-05-01", "x", "W-01")], [codeRule("W-01", "C3"), codeRule("W-01", "C2")], [NEW, both]);
    expect(r.assigned.map((a) => a.contractId)).toEqual(["C2"]);
    expect(r.warnings).toMatchObject([{ code: "MAPPING_AMBIGUOUS", ref: { candidates: "C2,C3", projectName: "作業コード W-01" } }]);
  });

  it("期間の列が無い mapping（従来）は結果が変わらない", () => {
    const logs = [wl("2026-03-01", "a", "W-01"), wl("2026-04-01", "a", "W-01")];
    const r = mapWorklogs(logs, [rule("ABC", "基幹", "C1"), rule("ABC", "基幹", "C2")], [OLD, NEW]);
    expect(r.assigned.map((a) => a.contractId)).toEqual(["C1", "C2"]);
  });
});

describe("キーワードの振り分けと作業コード", () => {
  it("作業コードの行がある作業は、名前の行のキーワードに合わなくても運用保守（人が割り当てたもの）", () => {
    const router = createKeywordRouter([{ ...rule("ABC", "基幹", "C2"), taskInclude: ["_保守対応"] }, codeRule("W-01", "C2")]);
    expect(router.match(wl("2026-05-01", "調査", "W-01"))).toBe("hit");
    expect(router.match(wl("2026-05-01", "調査", "W-02"))).toBe("miss");
    expect(router.match(wl("2026-05-01", "調査_保守対応", undefined))).toBe("hit");
  });

  it("作業コードの行だけ（キーワードの行なし）でも、分類表で運用保守以外の作業を運用保守にする", () => {
    const c = createTaskClassifier([{ task: "調査", category: "outside" }], [codeRule("W-01", "C2")]);
    expect(c.classifyWorklog(wl("2026-05-01", "調査", "W-01")).category).toBe("contract");
    expect(c.classifyWorklog(wl("2026-05-01", "調査", "W-02")).category).toBe("outside");
  });

  it("同じ顧客・案件・作業名でも作業コードで分類が変わる（処理の順に左右されない）", () => {
    const rules = [{ ...rule("ABC", "基幹", "C2"), taskInclude: ["_保守対応"] }, codeRule("W-01", "C2")];
    for (const order of [["W-02", "W-01"], ["W-01", "W-02"]]) {
      const c = createTaskClassifier([], rules);
      const got = Object.fromEntries(order.map((code) => [code, c.classifyWorklog(wl("2026-05-01", "調査", code)).category]));
      expect(got).toEqual({ "W-01": "contract", "W-02": "outside" });
    }
  });

  it("名前の行のキーワードは、作業日の月に掛かる行のものだけを使う", () => {
    const rules = [
      { ...rule("ABC", "基幹", "C1"), taskInclude: ["旧保守"], endMonth: "2026-03" },
      { ...rule("ABC", "基幹", "C2"), taskInclude: ["_保守対応"], startMonth: "2026-04" },
    ];
    const router = createKeywordRouter(rules);
    expect(router.match(wl("2026-03-10", "旧保守の作業", undefined))).toBe("hit");
    expect(router.match(wl("2026-05-10", "旧保守の作業", undefined))).toBe("miss");
    expect(router.match(wl("2026-05-10", "障害_保守対応", undefined))).toBe("hit");
    const c = createTaskClassifier([], rules);
    expect(c.classifyWorklog(wl("2026-03-10", "旧保守の作業", undefined)).category).toBe("contract");
    expect(c.classifyWorklog(wl("2026-05-10", "旧保守の作業", undefined)).category).toBe("outside");
  });
});

describe("未登録の作業コード・作業名の変更（findTaskCodeIssues）", () => {
  const logs = [
    wl("2026-04-01", "障害対応_保守対応", "W-01", 2),
    wl("2026-06-10", "障害対応（夜間含む）_保守対応", "W-01", 1),
    wl("2026-05-01", "問い合わせ_保守対応", "W-02", 3),
    wl("2026-05-20", "問い合わせ_保守対応", "W-02", 1),
    wl("2026-04-01", "調査_保守対応", "W-03", 1),
    wl("2026-07-01", "調査（次期更改）", "W-03", 1),
    wl("2026-04-01", "提案", "W-04", 5),
    wl("2026-08-01", "提案_保守対応", "W-04", 1),
    wl("2027-04-01", "問い合わせ_保守対応", "W-05", 4),
    wl("2026-04-01", "定例_保守対応", undefined, 9),
    wl("2026-04-01", "定例_保守対応", "W-06", 0),
  ];
  const rules = [codeRule("W-01", "C2"), codeRule("W-03", "C2"), codeRule("W-04", "C2"), codeRule("W-05", "C2", "2026-04", "2027-03")];

  it("キーワードに合う作業のうち、作業コードの行が無い（未登録）・行の期間に入らない（期間外）ものをコードごとに出す", () => {
    const f = findTaskCodeIssues(logs, rules, CHECK);
    expect(f.unregistered).toEqual([
      { taskCode: "W-02", task: "問い合わせ_保守対応", customerName: "ABC", projectName: "基幹", hours: 4, count: 2, firstDate: "2026-05-01", lastDate: "2026-05-20", status: "none" },
      { taskCode: "W-05", task: "問い合わせ_保守対応", customerName: "ABC", projectName: "基幹", hours: 4, count: 1, firstDate: "2027-04-01", lastDate: "2027-04-01", status: "period" },
    ]);
  });

  it("同じ作業コードの作業名の変更と、キーワードの一致の変化（合わなくなった・合うようになった）を出す", () => {
    const f = findTaskCodeIssues(logs, rules, CHECK);
    expect(f.changes).toEqual([
      { taskCode: "W-04", before: "提案", after: "提案_保守対応", changedOn: "2026-08-01", matchBefore: false, matchAfter: true },
      { taskCode: "W-03", before: "調査_保守対応", after: "調査（次期更改）", changedOn: "2026-07-01", matchBefore: true, matchAfter: false },
      { taskCode: "W-01", before: "障害対応_保守対応", after: "障害対応（夜間含む）_保守対応", changedOn: "2026-06-10", matchBefore: true, matchAfter: true },
    ]);
  });

  it("除くキーワードが優先。点検の設定が無ければ未登録は出さず、作業名の変更だけ（一致は null）", () => {
    const ex = findTaskCodeIssues(logs, rules, { include: ["_保守対応"], exclude: ["問い合わせ"] });
    expect(ex.unregistered).toEqual([]);
    const none = findTaskCodeIssues(logs, rules, undefined);
    expect(none.unregistered).toEqual([]);
    expect(none.changes.map((c) => [c.taskCode, c.matchBefore, c.matchAfter])).toEqual([
      ["W-04", null, null],
      ["W-03", null, null],
      ["W-01", null, null],
    ]);
    expect(findTaskCodeIssues(logs, rules, { include: [" "] }).unregistered).toEqual([]);
  });
});

describe("mapping.csv の行の期間の検証（validateMappingPeriods）", () => {
  it("期間の重なり（同じ作業が同じ月に別の案件）・逆転・形式・契約期間の外", () => {
    const issues = validateMappingPeriods(
      [
        codeRule("W-01", "C1", "", "2026-04"), // 2 行目: C1 の契約は 2026-03 まで → 実効は 〜2026-03
        codeRule("W-01", "C2", "2026-04"), // 3 行目: 重ならない
        codeRule("W-02", "C1"), // 4 行目
        codeRule("W-02", "C2", "2026-03"), // 5 行目: C2 の契約は 2026-04 から → 重ならない
        codeRule("W-03", "C2", "2026-04"), // 6 行目
        { ...codeRule("W-03", "C3", "2026-06", "2026-07") }, // 7 行目: C3 と 2026-06〜07 で重なる
        codeRule("W-04", "C2", "2026-13"), // 8 行目: 形式
        codeRule("W-04", "C2", "2026-09", "2026-05"), // 9 行目: 逆転
        codeRule("W-05", "C1", "2026-05"), // 10 行目: 契約期間の外
        { ...rule("ABC", "基幹", "C1") }, // 11 行目
        { ...rule("ABC", "基幹", "C2") }, // 12 行目: 契約期間が重ならないので警告なし
      ],
      [OLD, NEW, contract({ contractId: "C3", startMonth: "2026-04", endMonth: "2027-03" })],
    );
    expect(issues.map((i) => [i.code, i.row, i.severity])).toEqual([
      ["MAPPING_MONTH_INVALID", 8, "error"],
      ["MAPPING_PERIOD_INVERTED", 9, "error"],
      ["MAPPING_OUTSIDE_CONTRACT", 10, "warning"],
      ["MAPPING_PERIOD_OVERLAP", 7, "warning"],
    ]);
    expect(issues[3]!.message).toBe("mapping.csv 7 行目: 6 行目と同じ作業が 2026-06〜2026-07 に別の案件（C2 と C3）を指しています。どちらか一方の期間にしてください");
  });

  it("キーワードの違う名前の行は、同じ月に別の案件を指してもよい（キーワードで分ける。§62）", () => {
    const issues = validateMappingPeriods(
      [
        { ...rule("ABC", "基幹", "C2"), taskInclude: ["【保守】"] },
        { ...rule("ABC", "基幹", "C3"), taskInclude: ["【監視】"] },
      ],
      [NEW, contract({ contractId: "C3" })],
    );
    expect(issues).toEqual([]);
  });
});

describe("Dataset・Model（§92）", () => {
  const files = (mapping: string, worklogs: string) => ({
    config: { ...baseConfig, taskCodeCheck: CHECK },
    contracts: "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\nC1,ABC,基幹,,2025-04,2026-03,1200000\nC2,ABC,基幹,,2026-04,2027-03,1200000\n",
    mapping,
    assignments: "member_id,contract_id,start_month,end_month,allocation\n",
    teams: "team_id,name,parent_team_id,effective_from\n",
    members: "member_id,name,kind,title,department,section,team_id,effective_from\n",
    rates: "key,hourly_rate,effective_from\n",
    holidays: "date,name\n",
    worklogs: [worklogs],
    worklogNames: ["2026-04.csv"],
  });

  it("作業実績の task_code、mapping.csv の task_code・start_month・end_month を読む（どれも省略可）", () => {
    const r = parseDataset(
      files(
        "worklog_customer_name,worklog_project_name,contract_id,task_code,start_month,end_month\n,,C1,W-01,,2026-03\n,,C2,W-01,2026-04,\nABC,基幹,C2,,,\n",
        "date,member_id,member_name,customer_name,project_name,task,hours,task_code\n2026-04-01,M1,a,ABC,基幹,問い合わせ_保守対応,1,W-01\n2026-04-02,M1,a,ABC,基幹,定例,1,\n",
      ),
    );
    expect(r.dataset.mappings).toEqual([
      { worklogCustomerName: "", worklogProjectName: "", contractId: "C1", taskCode: "W-01", endMonth: "2026-03" },
      { worklogCustomerName: "", worklogProjectName: "", contractId: "C2", taskCode: "W-01", startMonth: "2026-04" },
      { worklogCustomerName: "ABC", worklogProjectName: "基幹", contractId: "C2" },
    ]);
    expect(r.dataset.worklogs.map((w) => w.taskCode)).toEqual(["W-01", undefined]);
  });

  it("Model に未登録の作業コード・作業名の変更、検証に警告（エラーにはしない）", () => {
    const ds = dataset({
      config: { ...baseConfig, taskCodeCheck: CHECK },
      contracts: [OLD, NEW],
      teams: [team("T1", null)],
      members: [member({ memberId: "M1", teamId: "T1" })],
      rates: [rate("一般", 5000)],
      mappings: [rule("ABC", "基幹", "C2"), codeRule("W-01", "C2")],
      worklogs: [wl("2026-04-01", "障害_保守対応", "W-01"), wl("2026-05-01", "障害（夜間）_保守対応", "W-01"), wl("2026-05-01", "新しい監視_保守対応", "W-09", 2)],
    });
    const m = buildModel(ds, { asOf: "2026-05-20", generatedAt: "x" });
    expect(m.unregisteredTaskCodes).toMatchObject([{ taskCode: "W-09", status: "none", hours: 2 }]);
    expect(m.taskCodeChanges).toMatchObject([{ taskCode: "W-01", before: "障害_保守対応", after: "障害（夜間）_保守対応" }]);
    expect(m.warnings.filter((w) => w.code.startsWith("TASK_CODE")).map((w) => w.code)).toEqual(["TASK_CODE_UNREGISTERED", "TASK_CODE_RENAMED"]);
    // 未登録でも名前の行で紐付く（案件は人が決める。ここでは見つけるだけ）
    expect(m.contracts.find((c) => c.contract.contractId === "C2")!.months.find((x) => x.month === "2026-05")!.hours).toBe(3);
    const issues = validateDataset(ds);
    expect(issues.filter((i) => i.code.startsWith("TASK_CODE")).map((i) => [i.code, i.severity])).toEqual([
      ["TASK_CODE_UNREGISTERED", "warning"],
      ["TASK_CODE_RENAMED", "warning"],
    ]);
  });

  it("点検の設定が無ければ未登録は出さない（従来の config のまま動く）", () => {
    const ds = dataset({ contracts: [NEW], mappings: [rule("ABC", "基幹", "C2")], worklogs: [wl("2026-05-01", "新しい監視_保守対応", "W-09", 2)] });
    const m = buildModel(ds, { asOf: "2026-05-20", generatedAt: "x" });
    expect(m.unregisteredTaskCodes).toEqual([]);
    expect(m.taskCodeChanges).toEqual([]);
  });
});
