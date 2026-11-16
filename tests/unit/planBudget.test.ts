/**
 * リソース計画の金額と目標の上限（SPEC §122）: 案件の目標（いちばん細かいもの）・上限・余力、組織の顧客ごとの計画の額
 */
import { describe, expect, it } from "vitest";
import { buildModel } from "../../src/core/model.js";
import { parseDataset, type DatasetFiles } from "../../src/core/csv.js";
import { createMasterIndex } from "../../src/core/masters.js";
import { createMonthHours } from "../../src/core/monthHours.js";
import { contractCapAt, planBudgetChart, planRoomAt } from "../../src/core/planBudget.js";
import type { PlanInputs } from "../../src/core/planImpact.js";
import { baseConfig } from "./fixtures.js";

const A_HEADER = "member_id,contract_id,start_month,end_month,allocation\n";
const T_HEADER = "target_type,target_id,end_month,remaining_rate,start_month,note\n";

/** C1（A社・T11）・C2（A社・T12）・C3（Ｂ商事・T12）。T11・T12 は D1 の配下。M1 = SE 5,000 円、M2 = PM 8,000 円。基準日 2026-10-15 */
function files(assignments: string, targets = ""): DatasetFiles {
  return {
    config: baseConfig,
    contracts:
      "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\n" +
      "C1,A社,保守,T11,2026-04,2027-03,12000000\n" +
      "C2,Ａ社,運用,T12,2026-04,2027-03,12000000\n" +
      "C3,Ｂ商事,運用,T12,2026-10,2026-12,3000000\n" +
      "C9,Ｃ社,運用,T99,2026-04,2027-03,12000000\n",
    mapping: "worklog_customer_name,worklog_project_name,contract_id\n",
    assignments: A_HEADER + assignments,
    teams: "team_id,name,parent_team_id,effective_from\nD1,事業部,,2025-04\nT11,開発,D1,2025-04\nT12,運用,D1,2025-04\nT99,別,,2025-04\n",
    members: "member_id,name,kind,title,department,section,team_id,effective_from\nM1,山田,employee,SE,,,T11,2025-04\nM2,佐藤,employee,PM,,,T12,2025-04\n",
    rates: "key,hourly_rate,effective_from\nSE,5000,2025-04\nPM,8000,2025-04\n",
    holidays: "date,name\n",
    worklogs: [],
    targets: T_HEADER + targets,
  };
}
const BASE = "M1,C1,2026-04,2027-03,0.5\nM2,C2,2026-04,2027-03,0.5\nM2,C3,2026-10,2026-12,0.2\nM1,C9,2026-04,2027-03,1.0\n";
const setup = (targets = "", assignments = BASE) => {
  const ds = parseDataset(files(assignments, targets)).dataset;
  const model = buildModel(ds, { asOf: "2026-10-15", generatedAt: "t" });
  const inputs: PlanInputs = { masters: createMasterIndex(ds), assignments: ds.assignments };
  const hours = createMonthHours([], model.config.hoursPerBusinessDay);
  return { model, inputs, hours, row: (id: string) => model.contracts.find((r) => r.contract.contractId === id)! };
};
const budgetOf = (m: ReturnType<typeof setup>, id: string, month: string) => m.row(id).months.find((x) => x.month === month)!.budget;

describe("contractCapAt", () => {
  it("目標が無ければ上限なし", () => {
    const m = setup();
    const c = contractCapAt(m.model, m.row("C1"), "2026-11");
    expect(c.cap).toBeNull();
    expect(c.target).toBeNull();
    expect(c.budget).toBe(budgetOf(m, "C1", "2026-11"));
  });

  it("いちばん細かい目標を使う（案件 → 顧客 → チーム → 上位の組織）", () => {
    const t = "team,D1,2027-03,10,,\nteam,T12,2027-03,20,,\ncustomer,A社,2027-03,30,,\nproject,C1,2027-03,40,,\n";
    const m = setup(t);
    expect(contractCapAt(m.model, m.row("C1"), "2026-11").kind).toBe("project");
    expect(contractCapAt(m.model, m.row("C1"), "2026-11").cap).toBeCloseTo(budgetOf(m, "C1", "2026-11") * 0.6, 6);
    // 顧客名は正規化して比べる（Ａ社 = A社）
    expect(contractCapAt(m.model, m.row("C2"), "2026-11").kind).toBe("customer");
    expect(contractCapAt(m.model, m.row("C3"), "2026-11").target?.targetId).toBe("T12");
    const up = setup("team,D1,2027-03,10,,\n");
    expect(contractCapAt(up.model, up.row("C3"), "2026-11").target?.targetId).toBe("D1");
    expect(contractCapAt(up.model, up.row("C9"), "2026-11").cap).toBeNull();
  });

  it("月ごとの目標は年度の目標より優先し、期間外の月には効かない", () => {
    const m = setup("team,T12,2027-03,10,,\nteam,T12,2026-11,50,2026-11,\n");
    expect(contractCapAt(m.model, m.row("C2"), "2026-11").target?.remainingRate).toBe(0.5);
    expect(contractCapAt(m.model, m.row("C2"), "2026-12").target?.remainingRate).toBe(0.1);
    expect(contractCapAt(m.model, m.row("C2"), "2027-04").cap).toBeNull();
  });

  it("マイナスの目標は予算を超える上限、契約期間外は予算 0", () => {
    const m = setup("project,C3,2027-03,-50,,\n");
    expect(contractCapAt(m.model, m.row("C3"), "2026-11").cap).toBeCloseTo(budgetOf(m, "C3", "2026-11") * 1.5, 6);
    expect(contractCapAt(m.model, m.row("C3"), "2027-01")).toMatchObject({ budget: 0, cap: 0 });
  });
});

describe("planRoomAt", () => {
  it("余力 = 上限 − 今の計画の額（編集後の計画で）", () => {
    const m = setup("project,C1,2027-03,40,,\n");
    const r = planRoomAt(m.model, m.inputs, "C1", "2026-11")!;
    const plan = 0.5 * m.hours("2026-11") * 5000;
    expect(r.plan).toBeCloseTo(plan, 0);
    expect(r.room).toBeCloseTo(budgetOf(m, "C1", "2026-11") * 0.6 - plan, 0);
    const edited = setup("project,C1,2027-03,40,,\n", BASE.replace("M1,C1,2026-04,2027-03,0.5", "M1,C1,2026-04,2027-03,1.5"));
    expect(planRoomAt(m.model, edited.inputs, "C1", "2026-11")!.room).toBeCloseTo(r.room! - plan * 2, 0);
  });

  it("目標の無い案件は余力なし（null）、無い案件は null", () => {
    const m = setup();
    expect(planRoomAt(m.model, m.inputs, "C1", "2026-11")!.room).toBeNull();
    expect(planRoomAt(m.model, m.inputs, "NONE", "2026-11")).toBeNull();
  });
});

describe("planBudgetChart", () => {
  const months = ["2026-09", "2026-10", "2026-11", "2027-04"];

  it("組織の担当案件（配下込み）を顧客ごとに、計画の額の多い順で。基準月より前の月も計画で数える", () => {
    const m = setup("team,D1,2027-03,10,,\n");
    const ch = planBudgetChart(m.model, m.inputs, { teamId: "D1" }, months);
    expect(ch.customers.map((c) => c.name)).toEqual(["A社", "Ｂ商事"]);
    const sep = ch.months[0]!;
    expect(sep.byCustomer[0]).toBeCloseTo((0.5 * 5000 + 0.5 * 8000) * m.hours("2026-09"), 0);
    expect(sep.byCustomer[1]).toBe(0);
    const nov = ch.months[2]!;
    expect(nov.plan).toBeCloseTo((0.5 * 5000 + 0.5 * 8000 + 0.2 * 8000) * m.hours("2026-11"), 0);
    expect(nov.budget).toBeCloseTo(["C1", "C2", "C3"].reduce((s, id) => s + budgetOf(m, id, "2026-11"), 0), 6);
    expect(nov.cap).toBeCloseTo(nov.budget * 0.9, 6);
    // 契約が無く目標の期間外の月は上限なし
    expect(ch.months[3]).toMatchObject({ budget: 0, cap: null, plan: 0 });
  });

  it("目標の無い案件は予算で上限に数える。どの案件にも目標が無ければ上限なし", () => {
    const m = setup("project,C1,2027-03,50,,\n");
    const nov = planBudgetChart(m.model, m.inputs, { teamId: "D1" }, ["2026-11"]).months[0]!;
    expect(nov.cap).toBeCloseTo(budgetOf(m, "C1", "2026-11") * 0.5 + budgetOf(m, "C2", "2026-11") + budgetOf(m, "C3", "2026-11"), 6);
    expect(planBudgetChart(setup().model, setup().inputs, { teamId: "D1" }, ["2026-11"]).months[0]!.cap).toBeNull();
  });

  it("すべての組織は全案件", () => {
    const m = setup();
    const ch = planBudgetChart(m.model, m.inputs, { teamId: null }, ["2026-11"]);
    expect(ch.customers.map((c) => c.name)).toEqual(["A社", "Ｃ社", "Ｂ商事"]);
  });
});
