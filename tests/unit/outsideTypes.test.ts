/**
 * 契約外の作業の計画と予実（SPEC §50）: 種別・顧客名なしの会社業務・メンバー別の「契約外を含む」
 * 月は基準月 BASE からの相対で作る（特定の年度に依存しない）
 */
import { describe, expect, it } from "vitest";
import {
  addMonths,
  aggregateMembers,
  buildModel,
  createTaskClassifier,
  isOutsideRow,
  memberMonthlySeries,
  outsideRowId,
  outsideTypes,
  parseDataset,
  validateDataset,
} from "../../src/core/index.js";
import type { TaskTypeRule } from "../../src/core/types.js";
import { baseConfig, contract, dataset, member, rate, rule, team, worklog } from "./fixtures.js";

const BASE = "2031-04";
const m = (n: number) => addMonths(BASE, n);
const day = (n: number, d = 10) => `${m(n)}-${String(d).padStart(2, "0")}`;

const TYPES: TaskTypeRule[] = [
  { task: "保守", category: "contract" },
  { task: "提案", category: "outside", group: "提案" },
  { task: "見積", category: "outside", group: "提案" },
  { task: "運用設計", category: "outside", group: "設計" },
  { task: "社内会議", category: "outside", group: "会社業務" },
  { task: "構築", category: "outside" },
];

function ds() {
  return dataset({
    contracts: [contract({ contractId: "C1", customerName: "ABC", projectName: "保守", teamId: "T1", startMonth: m(0), endMonth: m(11), totalAmount: 1_200_000 })],
    mappings: [rule("ABC", "保守", "C1")],
    teams: [team("T1", null)],
    members: [member({ memberId: "M1", teamId: "T1" }), member({ memberId: "M2", teamId: "T1" })],
    rates: [rate("SE", 5000)],
    assignments: [{ memberId: "M1", contractId: "C1", startMonth: m(0), endMonth: m(11), allocation: 0.5 }],
    taskTypes: TYPES,
    outsidePlans: [
      { memberId: "M1", type: "提案", startMonth: m(0), endMonth: m(1), personMonths: 0.2, note: "" },
      { memberId: "M1", type: "会社業務", startMonth: m(0), endMonth: m(0), personMonths: 0.1, note: "" },
      // 契約の計画も実績も無い人の契約外予定だけ
      { memberId: "M2", type: "設計", startMonth: m(1), endMonth: m(1), personMonths: 0.5, note: "" },
    ],
    worklogs: [
      worklog({ date: day(0, 1), memberId: "M1", customerName: "ABC", projectName: "保守", task: "保守", hours: 10 }),
      worklog({ date: day(0, 2), memberId: "M1", customerName: "ABC", projectName: "保守", task: "提案", hours: 4 }),
      worklog({ date: day(0, 3), memberId: "M1", customerName: "新規", projectName: "提案書", task: "見積", hours: 1.5 }),
      // 顧客名なしの契約外（会社業務）は残す。顧客名なしの契約内は従来どおり除外
      worklog({ date: day(0, 4), memberId: "M1", customerName: "", projectName: "", task: "社内会議", hours: 2 }),
      worklog({ date: day(0, 5), memberId: "M1", customerName: "", projectName: "", task: "保守", hours: 3 }),
    ],
  });
}

describe("契約外の種別（§50.1）", () => {
  it("group で束ね、無ければ task の表記。契約内は数えない・重複を除きファイルの順", () => {
    expect(outsideTypes(TYPES)).toEqual(["提案", "設計", "会社業務", "構築"]);
    expect(outsideTypes([{ task: "提案", category: "outside", group: " 提案 " }, { task: "見積", category: "outside", group: "提案" }])).toEqual(["提案"]);
    expect(outsideTypes(undefined)).toEqual([]);
    const c = createTaskClassifier(TYPES);
    expect(c.classify("見積")).toMatchObject({ category: "outside", group: "提案" });
    expect(c.classify("構築")).toMatchObject({ category: "outside", group: "構築" });
    expect(c.classify("保守")).toMatchObject({ category: "contract", group: "" });
  });

  it("task-types.csv の group 列は省略可（契約内の行の group は使わない）", () => {
    const files = {
      config: baseConfig,
      contracts: "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\n",
      mapping: "worklog_customer_name,worklog_project_name,contract_id\n",
      assignments: "member_id,contract_id,start_month,end_month,allocation\n",
      teams: "team_id,name,parent_team_id,effective_from\n",
      members: "member_id,name,kind,title,department,section,team_id,effective_from\n",
      rates: "key,hourly_rate,effective_from\n",
      holidays: "date,name\n",
      worklogs: [],
    };
    const withGroup = parseDataset({ ...files, taskTypes: "task,category,group,note\n保守,契約内,X,\n提案,契約外,営業,\n" });
    expect(withGroup.dataset.taskTypes).toEqual([{ task: "保守", category: "contract" }, { task: "提案", category: "outside", group: "営業" }]);
    const legacy = parseDataset({ ...files, taskTypes: "task,category,note\n提案,契約外,\n" });
    expect(legacy.dataset.taskTypes).toEqual([{ task: "提案", category: "outside" }]);
  });

  it("Model に種別の一覧が載る", () => {
    expect(buildModel(ds(), { asOf: day(2, 20), generatedAt: "x" }).outsideTypes).toEqual(["提案", "設計", "会社業務", "構築"]);
  });
});

describe("運用保守以外の実績がある「メンバー|月|種別」（§50.3。リソース計画で人ごとに出す種別）", () => {
  it("作業実績から種別（group）ごとに 1 つ。契約内・実績の無い種別は入らない", () => {
    expect(buildModel(ds(), { asOf: day(2, 20), generatedAt: "x" }).outsideWorkMonths).toEqual([`M1|${m(0)}|会社業務`, `M1|${m(0)}|提案`]);
  });
});

describe("顧客名なしの契約外（§50.2）", () => {
  const model = buildModel(ds(), { asOf: day(2, 20), generatedAt: "x" });
  it("契約外は工数の明細に残り、契約内の顧客名なしだけ除外", () => {
    expect(model.excludedHours).toBe(3);
    const meeting = model.workRows.filter((r) => r.task === "社内会議");
    expect(meeting).toHaveLength(1);
    expect(meeting[0]).toMatchObject({ category: "outside", hours: 2, contractId: null, amount: null });
    // 契約の実績には入らない
    expect(model.contracts[0]!.months[0]!.hours).toBe(10);
  });
});

describe("メンバー別の契約外（§50.3・§50.4）", () => {
  const model = buildModel(ds(), { asOf: day(2, 20), generatedAt: "x" });
  const mm = (id: string, n: number) => model.memberMonths.find((x) => x.memberId === id && x.month === m(n));

  it("種別ごとの行: 計画 = 人月 × 基準時間 × 単価、実績 = 時間 × 単価（月の合計には入れない）", () => {
    const a = mm("M1", 0)!;
    expect(a.plannedHours).toBe(80);
    expect(a.actualHours).toBe(10);
    const out = a.byContract.filter(isOutsideRow);
    expect(out.map((r) => [r.contractId, r.outsideType, r.plannedHours, r.plannedCost, r.actualHours, r.actualCost])).toEqual([
      [outsideRowId("会社業務"), "会社業務", 16, 80_000, 2, 10_000],
      [outsideRowId("提案"), "提案", 32, 160_000, 5.5, 27_500],
    ]);
    // 契約の行が先、契約外の行は末尾
    expect(isOutsideRow(a.byContract[0]!)).toBe(false);
    // 計画だけの月
    expect(mm("M1", 1)!.byContract.filter(isOutsideRow).map((r) => [r.outsideType, r.plannedHours, r.actualHours])).toEqual([["提案", 32, 0]]);
  });

  it("既定は契約外を数えない（従来どおり）。includeOutside で計画・実績の両方に足す", () => {
    const period = { from: m(0), to: m(1) };
    const off = aggregateMembers(model, { period });
    expect(off.members.map((x) => x.memberId)).toEqual(["M1"]);
    expect(off.total).toMatchObject({ plannedHours: 160, actualHours: 10, plannedCost: 800_000, actualCost: 50_000 });
    const on = aggregateMembers(model, { period, includeOutside: true });
    // 契約外予定だけの人も出る
    expect(on.members.map((x) => x.memberId)).toEqual(["M1", "M2"]);
    const m1 = on.members[0]!;
    expect(m1).toMatchObject({ plannedHours: 160 + 16 + 64, actualHours: 10 + 2 + 5.5, plannedCost: 800_000 + 80_000 + 320_000, actualCost: 50_000 + 10_000 + 27_500 });
    expect(m1.byContract.map((c) => c.outsideType ?? c.contractId)).toEqual(["C1", "会社業務", "提案"]);
    expect(on.members[1]!.byContract).toMatchObject([{ outsideType: "設計", plannedHours: 80, actualHours: 0, assignedMonths: 1 }]);
    expect(on.total.plannedCost).toBe(m1.plannedCost + on.members[1]!.plannedCost);
    // 契約で絞っても契約外は含めない（includeOutside なし）
    expect(aggregateMembers(model, { period, contractIds: ["C1"] }).total.plannedHours).toBe(160);
  });

  it("月次推移も同じ切替", () => {
    const period = { from: m(0), to: m(1) };
    const off = memberMonthlySeries(model, "M1", period);
    const on = memberMonthlySeries(model, "M1", period, undefined, { includeOutside: true });
    expect(off.map((p) => p.plannedHours)).toEqual([80, 80]);
    expect(on.map((p) => p.plannedHours)).toEqual([80 + 16 + 32, 80 + 32]);
    expect(on[0]!.actualCost).toBe(50_000 + 10_000 + 27_500);
  });

  it("契約外の実績で計画の無い種別は未計画（unplanned）に入る", () => {
    const d = ds();
    d.outsidePlans = [];
    const mdl = buildModel(d, { asOf: day(2, 20), generatedAt: "x" });
    const t = aggregateMembers(mdl, { period: { from: m(0), to: m(0) }, includeOutside: true }).members[0]!;
    expect(t.unplannedHours).toBe(7.5);
  });
});

describe("契約外予定の検証（§50.1）", () => {
  const codes = (plans: NonNullable<ReturnType<typeof ds>["outsidePlans"]>) => {
    const d = ds();
    d.outsidePlans = plans;
    return validateDataset(d)
      .filter((i) => i.file === "outside-plans.csv")
      .map((i) => `${i.severity}:${i.code}@${i.row}`);
  };
  it("同じ人・同じ月でも種別が違えば重ならない。同じ種別は重なり", () => {
    expect(codes([
      { memberId: "M1", type: "提案", startMonth: m(0), endMonth: m(2), personMonths: 0.1, note: "" },
      { memberId: "M1", type: "会社業務", startMonth: m(0), endMonth: m(2), personMonths: 0.1, note: "" },
    ])).toEqual([]);
    expect(codes([
      { memberId: "M1", type: "提案", startMonth: m(0), endMonth: m(2), personMonths: 0.1, note: "" },
      { memberId: "M1", type: " 提案", startMonth: m(1), endMonth: m(1), personMonths: 0.1, note: "" },
    ])).toEqual(["error:OUTSIDE_OVERLAP@3"]);
  });
  it("分類表に無い種別は警告（保存は止めない）。種別なしは問わない", () => {
    expect(codes([
      { memberId: "M1", type: "営業", startMonth: m(0), endMonth: m(0), personMonths: 0.1, note: "" },
      { memberId: "M1", type: "", startMonth: m(0), endMonth: m(0), personMonths: 0.1, note: "" },
    ])).toEqual(["warning:OUTSIDE_UNKNOWN_TYPE@2"]);
    // 分類表に契約外の種別が無ければ種別は問わない
    const d = ds();
    d.taskTypes = [{ task: "保守", category: "contract" }];
    d.outsidePlans = [{ memberId: "M1", type: "営業", startMonth: m(0), endMonth: m(0), personMonths: 0.1, note: "" }];
    expect(validateDataset(d).filter((i) => i.code === "OUTSIDE_UNKNOWN_TYPE")).toEqual([]);
  });
});

describe("Codex 指摘（#33）: 種別の表記ゆれ・契約の外の月", () => {
  const base = () =>
    dataset({
      contracts: [contract({ contractId: "C1", customerName: "ABC", projectName: "保守", teamId: "T1", startMonth: m(0), endMonth: m(8), totalAmount: 900_000 })],
      mappings: [rule("ABC", "保守", "C1")],
      teams: [team("T1", null)],
      members: [member({ memberId: "M1", teamId: "T1" })],
      rates: [rate("SE", 5000)],
      taskTypes: [
        { task: "保守", category: "contract" },
        { task: "提案", category: "outside", group: "Presales" },
      ],
      // 予定は全角の表記、分類表の種別は半角。契約が終わった後の月（m(9)〜m(11)）の予定もある
      outsidePlans: [{ memberId: "M1", type: "Ｐｒｅｓａｌｅｓ", startMonth: m(0), endMonth: m(11), personMonths: 0.2, note: "" }],
      worklogs: [worklog({ date: day(0, 2), memberId: "M1", customerName: "ABC", projectName: "保守", task: "提案", hours: 8 })],
    });

  it("全角・半角だけが違う種別は計画と実績が同じ 1 行になり、実績は計画外に数えない", () => {
    const model = buildModel(base(), { asOf: `${m(1)}-05` });
    const row = model.memberMonths.find((x) => x.memberId === "M1" && x.month === m(0))!;
    const out = row.byContract.filter(isOutsideRow);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ plannedHours: 32, actualHours: 8 });
    expect(out[0]!.contractId).toBe(outsideRowId("presales"));
    const on = aggregateMembers(model, { period: { from: m(0), to: m(0) }, includeOutside: true });
    expect(on.members[0]!.byContract.filter(isOutsideRow)).toMatchObject([{ plannedHours: 32, actualHours: 8, unplannedHours: 0 }]);
  });

  it("運用保守以外の予定が契約の期間の外にあっても、選べる期間（minMonth〜maxMonth）に入る", () => {
    const model = buildModel(base(), { asOf: `${m(1)}-05` });
    expect(model.meta.minMonth).toBe(m(0));
    expect(model.meta.maxMonth).toBe(m(11));
    expect(model.memberMonths.some((x) => x.month === m(11))).toBe(true);
  });

  it("運用保守以外の予定が無ければ、選べる期間は従来どおり契約の期間", () => {
    const d = base();
    d.outsidePlans = [];
    const model = buildModel(d, { asOf: `${m(1)}-05` });
    expect([model.meta.minMonth, model.meta.maxMonth]).toEqual([m(0), m(8)]);
  });
});
