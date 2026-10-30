/**
 * 作業種別と契約外の工数（SPEC §30）
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  UNASSIGNED_WORK_KEY,
  aggregateWork,
  apportion,
  buildModel,
  createTaskClassifier,
  decodeWorkRows,
  elapsedMonthCount,
  encodeWorkRows,
  filterWorkRows,
  parseDataset,
  parseTaskCategory,
  teamTreeAt,
  validateDataset,
  workByTask,
  workMonthlySeries,
  workTotals,
} from "../../src/core/index.js";
import type { TaskTypeRule } from "../../src/core/types.js";
import { baseConfig, contract, dataset, member, rate, rule, team, worklog } from "./fixtures.js";

const TYPES: TaskTypeRule[] = [
  { task: "保守", category: "contract" },
  { task: "障害対応", category: "contract" },
  { task: "提案", category: "outside" },
  { task: "運用設計", category: "outside" },
];

function ds(extra: Parameters<typeof dataset>[0] = {}) {
  return dataset({
    contracts: [contract({ contractId: "C1", customerName: "ABC", projectName: "保守", teamId: "T1" })],
    mappings: [rule("ABC", "保守", "C1")],
    teams: [team("ROOT", null), team("T1", "ROOT"), team("T2", "ROOT")],
    members: [member({ memberId: "M1", teamId: "T1" }), member({ memberId: "M2", teamId: "T2" })],
    rates: [rate("SE", 5000)],
    taskTypes: TYPES,
    ...extra,
  });
}

describe("parseTaskCategory", () => {
  it("契約内／契約外と英字を受け付け、それ以外は null", () => {
    expect(parseTaskCategory("契約内")).toBe("contract");
    expect(parseTaskCategory(" 契約外 ")).toBe("outside");
    // 画面の呼び名（§50）も受け付ける
    expect(parseTaskCategory("運用保守")).toBe("contract");
    expect(parseTaskCategory("運用保守以外")).toBe("outside");
    expect(parseTaskCategory("CONTRACT")).toBe("contract");
    expect(parseTaskCategory("outside")).toBe("outside");
    expect(parseTaskCategory("保守")).toBeNull();
    expect(parseTaskCategory("")).toBeNull();
    expect(parseTaskCategory(undefined)).toBeNull();
  });
});

describe("createTaskClassifier", () => {
  it("分類表が空なら無効（すべて契約内・未分類にしない）", () => {
    const c = createTaskClassifier([]);
    expect(c.enabled).toBe(false);
    expect(c.classify("提案")).toEqual({ category: "contract", group: "", label: "提案", unclassified: false });
  });
  it("正規化して照合し、無い作業種別は契約内＋未分類", () => {
    const c = createTaskClassifier(TYPES);
    expect(c.classify("提案")).toEqual({ category: "outside", group: "提案", label: "提案", unclassified: false });
    expect(c.classify("　提案 ")).toEqual({ category: "outside", group: "提案", label: "　提案 ", unclassified: false });
    expect(c.classify("勉強会")).toEqual({ category: "contract", group: "", label: "勉強会", unclassified: true });
    expect(c.classify("")).toEqual({ category: "contract", group: "", label: "", unclassified: true });
  });
  it("同じ作業種別が複数あれば先の行", () => {
    const c = createTaskClassifier([{ task: "提案", category: "contract" }, { task: "提案", category: "outside" }]);
    expect(c.classify("提案").category).toBe("contract");
  });
});

describe("apportion（最大剰余法）", () => {
  it("合計が必ず一致し、比に近い", () => {
    expect(apportion(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(apportion(10, [0, 0])).toEqual([10, 0]);
    expect(apportion(0, [3, 1])).toEqual([0, 0]);
    expect(apportion(-7, [1, 1])).toEqual([-4, -3]);
    expect(apportion(5, [])).toEqual([]);
  });
  it("性質: 合計一致・各値は floor/ceil", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), fc.array(fc.double({ min: 0.01, max: 1000, noNaN: true }), { minLength: 1, maxLength: 12 }), (total, weights) => {
        const out = apportion(total, weights);
        expect(out.reduce((s, v) => s + v, 0)).toBe(total);
        const sum = weights.reduce((s, w) => s + w, 0);
        out.forEach((v, i) => {
          const exact = (total * (weights[i] as number)) / sum;
          expect(v).toBeGreaterThanOrEqual(Math.floor(exact) - 1e-9);
          expect(v).toBeLessThanOrEqual(Math.ceil(exact) + 1e-9);
        });
      }),
    );
  });
});

describe("buildModel: 契約外は契約の実績に入れない", () => {
  const data = ds({
    worklogs: [
      worklog({ date: "2026-04-01", memberId: "M1", customerName: "ABC", projectName: "保守", task: "保守", hours: 3 }),
      worklog({ date: "2026-04-02", memberId: "M1", customerName: "ABC", projectName: "保守", task: "障害対応", hours: 1.5 }),
      worklog({ date: "2026-04-03", memberId: "M1", customerName: "ABC", projectName: "保守", task: "提案", hours: 2 }),
      // 紐付けルールの無い顧客への契約外 → 未紐付け警告を出さない
      worklog({ date: "2026-04-04", memberId: "M2", customerName: "新規見込み", projectName: "提案書", task: "運用設計", hours: 4 }),
      // 未分類（契約内として数える）
      worklog({ date: "2026-04-05", memberId: "M2", customerName: "ABC", projectName: "保守", task: "勉強会", hours: 1 }),
      // 顧客名なしの契約内は除外（顧客名なしの契約外は残す。§50.2 は別の describe）
      worklog({ date: "2026-04-06", memberId: "M2", customerName: "", projectName: "", task: "保守", hours: 5 }),
    ],
  });
  const model = buildModel(data, { asOf: "2026-05-20", generatedAt: "x" });
  const apr = model.contracts[0]!.months.find((m) => m.month === "2026-04")!;

  it("契約の実績は契約内の作業だけ", () => {
    expect(apr.hours).toBe(5.5);
    expect(apr.cost).toBe(5.5 * 5000);
    expect(apr.worklogs.map((w) => w.task).sort()).toEqual(["保守", "勉強会", "障害対応"].sort());
  });
  it("メンバー別の実績にも入らない", () => {
    const m1 = model.memberMonths.find((m) => m.memberId === "M1" && m.month === "2026-04")!;
    expect(m1.actualHours).toBe(4.5);
  });
  it("警告: 未紐付けは出さず、未分類と顧客名なしは出す", () => {
    const codes = model.warnings.map((w) => w.code);
    expect(codes).not.toContain("UNMAPPED_WORKLOG");
    expect(model.warnings.filter((w) => w.code === "TASK_UNCLASSIFIED")).toMatchObject([{ ref: { task: "勉強会" }, hours: 1, count: 1 }]);
    expect(model.excludedHours).toBe(5);
  });
  it("validateDataset も同じ（未紐付けなし・未分類 1 件）", () => {
    const issues = validateDataset(data);
    expect(issues.map((i) => i.code)).not.toContain("UNMAPPED_WORKLOG");
    expect(issues.filter((i) => i.code === "TASK_UNCLASSIFIED")).toHaveLength(1);
  });
  it("工数の明細: 契約内の金額の合計 = 契約の実績、契約外は金額なし・関連契約つき", () => {
    const rows = model.workRows;
    const contractRows = rows.filter((r) => r.category === "contract");
    expect(contractRows.reduce((s, r) => s + (r.amount ?? 0), 0)).toBe(apr.cost);
    expect(contractRows.reduce((s, r) => s + r.hours, 0)).toBe(apr.hours);
    expect(contractRows.find((r) => r.task === "勉強会")?.unclassified).toBe(true);
    const outside = rows.filter((r) => r.category === "outside");
    expect(outside).toHaveLength(2);
    expect(outside.find((r) => r.memberId === "M1")).toMatchObject({ contractId: "C1", customerName: "ABC", task: "提案", hours: 2, amount: null, teamId: "T1" });
    expect(outside.find((r) => r.memberId === "M2")).toMatchObject({ contractId: null, customerName: "新規見込み", hours: 4, teamId: "T2" });
  });
  it("分類表が無ければ従来どおり（すべて契約内）", () => {
    const { taskTypes: _unused, ...withoutTypes } = data;
    const m = buildModel(withoutTypes, { asOf: "2026-05-20", generatedAt: "x" });
    expect(m.contracts[0]!.months[0]!.hours).toBe(7.5);
    expect(m.warnings.map((w) => w.code)).toContain("UNMAPPED_WORKLOG");
    expect(m.warnings.map((w) => w.code)).not.toContain("TASK_UNCLASSIFIED");
    expect(m.workRows.every((r) => r.category === "contract" && !r.unclassified)).toBe(true);
  });

  it("集計: 合計・作業種別・月次・軸", () => {
    const period = { from: "2026-04", to: "2026-06" };
    const rows = filterWorkRows(model.workRows, { period });
    const t = workTotals(rows, elapsedMonthCount(period, model.meta.asOfMonth));
    expect(t).toMatchObject({ contractHours: 5.5, outsideHours: 6, totalHours: 11.5, memberCount: 2, elapsedMonths: 2 });
    expect(t.outsideShare).toBeCloseTo(6 / 11.5, 12);
    expect(t.hoursPerMemberMonth).toBeCloseTo(11.5 / 2 / 2, 12);

    const tasks = workByTask(rows);
    expect(tasks.map((l) => `${l.category}:${l.task}`)).toEqual(["contract:保守", "contract:障害対応", "contract:勉強会", "outside:運用設計", "outside:提案"]);
    expect(tasks.filter((l) => l.category === "contract").reduce((s, l) => s + (l.share ?? 0), 0)).toBeCloseTo(1, 12);

    const series = workMonthlySeries(rows, period, model.meta);
    expect(series.map((p) => [p.month, p.contractHours, p.outsideHours, p.memberCount, p.status])).toEqual([
      ["2026-04", 5.5, 6, 2, "final"],
      ["2026-05", 0, 0, 0, "preliminary"],
      ["2026-06", 0, 0, 0, "future"],
    ]);

    const { tree } = teamTreeAt({ teams: data.teams }, "2026-05");
    const byTeam = aggregateWork(model, rows, { period, axis: "team", tree, rootTeamIds: ["ROOT"], unassignedLabel: "未所属" });
    expect(byTeam.map((g) => [g.key, g.depth, g.totals.contractHours, g.totals.outsideHours])).toEqual([
      ["ROOT", 0, 5.5, 6],
      ["T1", 1, 4.5, 2],
      ["T2", 1, 1, 4],
    ]);
    const byCustomer = aggregateWork(model, rows, { period, axis: "customer", unassignedLabel: "-" });
    expect(byCustomer.map((g) => [g.label, g.totals.totalHours])).toEqual([
      ["ABC", 7.5],
      ["新規見込み", 4],
    ]);
    const byMember = aggregateWork(model, rows, { period, axis: "member", unassignedLabel: "-" });
    expect(byMember.map((g) => [g.key, g.teamId, g.totals.totalHours])).toEqual([
      ["M1", "T1", 6.5],
      ["M2", "T2", 5],
    ]);
    // 絞り込み: 契約・顧客・メンバー
    expect(filterWorkRows(model.workRows, { period, contractIds: ["C1"] }).reduce((s, r) => s + r.hours, 0)).toBe(7.5);
    expect(filterWorkRows(model.workRows, { period, memberIds: ["M2"] }).reduce((s, r) => s + r.hours, 0)).toBe(5);
  });

  it("所属の無い人は「未設定」にまとめる", () => {
    const m = buildModel({ ...data, members: [member({ memberId: "M1", teamId: "T1" })] }, { asOf: "2026-05-20", generatedAt: "x" });
    const { tree } = teamTreeAt({ teams: data.teams }, "2026-05");
    const groups = aggregateWork(m, m.workRows, { period: { from: "2026-04", to: "2026-04" }, axis: "team", tree, unassignedLabel: "未所属" });
    expect(groups[groups.length - 1]).toMatchObject({ key: UNASSIGNED_WORK_KEY, label: "未所属" });
    expect(groups[groups.length - 1]!.totals.totalHours).toBe(5);
  });

  it("配布用の詰め方は元に戻せる", () => {
    const enc = JSON.parse(JSON.stringify(encodeWorkRows(model.workRows)));
    expect(decodeWorkRows(enc)).toEqual(model.workRows);
  });
});

describe("task-types.csv の読み込み", () => {
  const files = (taskTypes: string | undefined) => ({
    config: baseConfig,
    contracts: "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\n",
    mapping: "worklog_customer_name,worklog_project_name,contract_id\n",
    assignments: "member_id,contract_id,start_month,end_month,allocation\n",
    teams: "team_id,name,parent_team_id,effective_from\n",
    members: "member_id,name,kind,title,department,section,team_id,effective_from\n",
    rates: "key,hourly_rate,effective_from\n",
    holidays: "date,name\n",
    worklogs: [],
    ...(taskTypes === undefined ? {} : { taskTypes }),
  });
  it("無い・空なら分類なし（エラーも出さない）", () => {
    for (const t of [undefined, "", "﻿"]) {
      const r = parseDataset(files(t));
      expect(r.dataset.taskTypes).toBeUndefined();
      expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    }
  });
  it("区分の表記ゆれを受け付け、不正・空・重複はエラーで除く", () => {
    const r = parseDataset(files("task,category,note\n提案,契約外,メモ\n保守,contract,\n,契約内,\n設計,どちらでも,\n提案,契約内,\n"));
    expect(r.dataset.taskTypes).toEqual([
      { task: "提案", category: "outside", note: "メモ" },
      { task: "保守", category: "contract" },
    ]);
    expect(r.issues.filter((i) => i.file === "task-types.csv").map((i) => [i.code, i.row])).toEqual([
      ["TASK_TYPE_EMPTY", 4],
      ["TASK_CATEGORY_INVALID", 5],
      ["DUPLICATE_TASK_TYPE", 6],
    ]);
  });
  it("列が無ければ MISSING_COLUMN", () => {
    const r = parseDataset(files("task\n提案\n"));
    expect(r.issues.map((i) => i.code)).toContain("MISSING_COLUMN");
  });
});
