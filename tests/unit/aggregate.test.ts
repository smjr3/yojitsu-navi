import { describe, expect, it } from "vitest";
import { UNASSIGNED_TEAM_ID, aggregate, contractsForTeam, forecastTotals, monthlySeries, teamTreeForMonth } from "../../src/core/aggregate.js";
import { buildModel } from "../../src/core/model.js";
import { budgetIn, contract, dataset, member, rate, rule, team, worklog } from "./fixtures.js";

const A = contract({ contractId: "A", customerName: "A社", teamId: "T1", startMonth: "2026-04", endMonth: "2027-03", totalAmount: 1_200_000 });
const B = contract({ contractId: "B", customerName: "B社", teamId: "T2", startMonth: "2026-07", endMonth: "2026-09", totalAmount: 300_000 });
const Z = contract({ contractId: "Z", customerName: "Z社", teamId: null, startMonth: "2027-04", endMonth: "2028-03", totalAmount: 120 });
// 予算は契約期間の営業日（祝日なし = 平日）で按分する（§118）。期待値は budgetIn で出す
const ds = dataset({
  contracts: [
    A,
    B,
    Z,
    contract({ contractId: "U", customerName: "U社", teamId: "GONE", startMonth: "2026-04", endMonth: "2026-04", totalAmount: 0 }),
  ],
  mappings: [rule("A社", "", "A"), rule("B社", "", "B")],
  teams: [team("ROOT", null), team("T1", "ROOT"), team("T2", "ROOT"), team("T3", null)],
  members: [member({ memberId: "M1", title: "SE" })],
  rates: [rate("SE", 1000)],
  worklogs: [
    worklog({ date: "2026-05-10", memberId: "M1", hours: 10, customerName: "A社" }), // A 2026-05: 10,000
    worklog({ date: "2026-08-10", memberId: "M1", hours: 50, customerName: "A社" }), // A 2026-08: 50,000
    worklog({ date: "2026-08-20", memberId: "M1", hours: 120, customerName: "B社" }), // B 2026-08: 120,000
    worklog({ date: "2026-10-01", memberId: "M1", hours: 1, customerName: "A社" }), // A 2026-10: 1,000（速報）
  ],
});
const model = buildModel(ds, { asOf: "2026-10-27" });

describe("aggregate (SPEC §11)", () => {
  it("期間・全契約", () => {
    // A の 07〜09 ＋ B の全額（07,08,09）、U: 0
    const t = aggregate(model, { period: { from: "2026-07", to: "2026-09" } });
    const budget = budgetIn(A, "2026-07", "2026-09") + 300_000;
    expect(t.budget).toBe(budget);
    expect(t.cost).toBe(170_000);
    expect(t.grossProfit).toBe(budget - 170_000);
    expect(t.grossMargin).toBeCloseTo((budget - 170_000) / budget);
    expect(t.burnRate).toBeCloseTo(170_000 / budget);
    expect(t.burnRateBreakdown.elapsedMonths).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(t.hours).toBe(170);
    expect(t.contractCount).toBe(2);
    expect(t.includesPreliminary).toBe(false);
  });

  it("契約を絞る", () => {
    const t = aggregate(model, { period: { from: "2026-04", to: "2027-03" }, contractIds: ["B"] });
    expect(t.budget).toBe(300_000);
    expect(t.cost).toBe(120_000);
    expect(t.contractCount).toBe(1);
  });

  it("消化率は経過月（asOf 月まで）のみで計算。未来月は分母に入れない", () => {
    const t = aggregate(model, { period: { from: "2026-04", to: "2027-03" }, contractIds: ["A"] });
    expect(t.budget).toBe(1_200_000);
    expect(t.burnRateBreakdown).toEqual({ elapsedMonths: ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"], cumulativeCost: 61_000, cumulativeBudget: budgetIn(A, "2026-04", "2026-10") });
    expect(t.burnRate).toBeCloseTo(61_000 / budgetIn(A, "2026-04", "2026-10"));
    expect(t.includesPreliminary).toBe(true);
  });

  it("消化率 > 閾値 で isOverBudget", () => {
    const t = aggregate(model, { period: { from: "2026-08", to: "2026-08" }, contractIds: ["B"] });
    expect(t.burnRate).toBeCloseTo(120_000 / budgetIn(B, "2026-08"));
    expect(t.isOverBudget).toBe(true);
    const exact = buildModel(dataset({ contracts: [contract({ contractId: "E", startMonth: "2026-05", endMonth: "2026-05", totalAmount: 100 })], mappings: [rule("ABC株式会社", "", "E")], members: [member({ memberId: "M1" })], rates: [rate("SE", 100)], worklogs: [worklog({ date: "2026-05-01", memberId: "M1", hours: 1 })] }), { asOf: "2026-10-27" });
    const te = aggregate(exact, { period: { from: "2026-05", to: "2026-05" } });
    expect(te.burnRate).toBe(1);
    expect(te.isOverBudget).toBe(false); // ちょうど閾値は赤にしない
  });

  it("期間がすべて未来 → burnRate null、isOverBudget false", () => {
    const t = aggregate(model, { period: { from: "2026-11", to: "2027-03" } });
    expect(t.burnRate).toBeNull();
    expect(t.burnRateBreakdown).toEqual({ elapsedMonths: [], cumulativeCost: 0, cumulativeBudget: 0 });
    expect(t.isOverBudget).toBe(false);
    expect(t.budget).toBe(budgetIn(A, "2026-11", "2027-03"));
  });

  it("予算 0 → grossMargin null、burnRate null", () => {
    const t = aggregate(model, { period: { from: "2026-04", to: "2026-04" }, contractIds: ["U"] });
    expect(t.budget).toBe(0);
    expect(t.grossMargin).toBeNull();
    expect(t.burnRate).toBeNull();
    expect(t.contractCount).toBe(1);
  });

  it("契約の無い期間 → すべて 0 / null", () => {
    const t = aggregate(model, { period: { from: "2020-01", to: "2020-12" } });
    expect(t).toEqual({
      budget: 0, cost: 0, costs: { labor: 0 }, grossProfit: 0, grossMargin: null, hours: 0, burnRate: null,
      burnRateBreakdown: { elapsedMonths: [], cumulativeCost: 0, cumulativeBudget: 0 }, isOverBudget: false,
      personMonthsStandard: 0, personMonthsCalendar: 0, includesPreliminary: false, contractCount: 0,
    });
  });

  it("存在しない契約IDを指定 → 0 件", () => {
    expect(aggregate(model, { period: { from: "2026-04", to: "2027-03" }, contractIds: ["NOPE"] }).contractCount).toBe(0);
  });

  it("人月換算（標準・カレンダー）", () => {
    // 2026-08: 31 日、土日 10 日（1,2,8,9,15,16,22,23,29,30）→ 21 営業日 × 8h = 168h
    const t = aggregate(model, { period: { from: "2026-08", to: "2026-08" } });
    expect(t.hours).toBe(170);
    expect(t.personMonthsStandard).toBeCloseTo(170 / 160);
    expect(t.personMonthsCalendar).toBeCloseTo(50 / 168 + 120 / 168);
  });
});

describe("monthlySeries", () => {
  it("期間の全月を返し、契約の無い月は 0・状態は asOf 基準", () => {
    const s = monthlySeries(model, { period: { from: "2027-02", to: "2027-05" } });
    expect(s.map((p) => [p.month, p.status, p.budget])).toEqual([
      ["2027-02", "future", budgetIn(A, "2027-02")],
      ["2027-03", "future", budgetIn(A, "2027-03")],
      ["2027-04", "future", budgetIn(Z, "2027-04")],
      ["2027-05", "future", budgetIn(Z, "2027-05")],
    ]);
    const past = monthlySeries(model, { period: { from: "2026-02", to: "2026-04" } });
    expect(past.map((p) => [p.month, p.status, p.budget, p.cost])).toEqual([
      ["2026-02", "final", 0, 0],
      ["2026-03", "final", 0, 0],
      ["2026-04", "final", budgetIn(A, "2026-04"), 0],
    ]);
  });

  it("合計が aggregate と一致する", () => {
    const period = { from: "2026-04", to: "2027-03" };
    const s = monthlySeries(model, { period });
    const t = aggregate(model, { period });
    expect(s.reduce((a, p) => a + p.budget, 0)).toBe(t.budget);
    expect(s.reduce((a, p) => a + p.cost, 0)).toBe(t.cost);
    expect(s.reduce((a, p) => a + p.hours, 0)).toBe(t.hours);
    const aug = budgetIn(A, "2026-08") + budgetIn(B, "2026-08");
    expect(s.find((p) => p.month === "2026-08")).toEqual({ month: "2026-08", status: "final", budget: aug, cost: 170_000, costs: { labor: 170_000 }, grossProfit: aug - 170_000, hours: 170 });
  });

  it("from > to は空", () => {
    expect(monthlySeries(model, { period: { from: "2026-05", to: "2026-04" } })).toEqual([]);
  });
});

describe("forecastTotals", () => {
  it("契約ごとの着地を合算し、赤字契約を列挙", () => {
    const t = forecastTotals(model, undefined, "recent3");
    // A: 実績 04〜09 = 60,000、recent3 平均 (0+50,000+0)/3 = 16,666.67 × 6 = 100,000 → 160,000
    // B: 年度内 07〜09 すべて実績、残り 0 → 120,000
    // U: 2026-04 のみ、残り 0、予算 0 → 0
    // Z: 年度外 → 0
    expect(t.targetBudget).toBe(1_500_000);
    expect(t.forecastCost).toBe(280_000);
    expect(t.forecastGrossProfit).toBe(1_220_000);
    expect(t.deficitContractIds).toEqual([]);
    expect(t.contractCount).toBe(4);
    expect(t.fiscalYear).toBe(2026);
  });

  it("契約を絞る・赤字", () => {
    const t = forecastTotals(model, ["B"], "all");
    expect(t.targetBudget).toBe(300_000);
    expect(t.forecastCost).toBe(120_000);
    expect(t.contractCount).toBe(1);
    const u = forecastTotals(model, ["U"], "all");
    expect(u.deficitContractIds).toEqual([]);
  });

  it("契約 0 件", () => {
    expect(forecastTotals(model, [], "assignment")).toEqual({ method: "assignment", fiscalYear: 2026, period: null, targetBudget: 0, forecastCost: 0, forecastGrossProfit: 0, deficitContractIds: [], contractCount: 0 });
  });
});

describe("contractsForTeam", () => {
  it("自分と配下の契約", () => {
    expect(contractsForTeam(model, "ROOT").map((c) => c.contractId)).toEqual(["A", "B"]);
    expect(contractsForTeam(model, "T1").map((c) => c.contractId)).toEqual(["A"]);
    expect(contractsForTeam(model, "T3")).toEqual([]);
    expect(contractsForTeam(model, "NOPE")).toEqual([]);
  });

  it("未設定グループ: teamId が空か木に無い契約", () => {
    expect(contractsForTeam(model, UNASSIGNED_TEAM_ID).map((c) => c.contractId)).toEqual(["Z", "U"]);
  });

  it("別の月の組織で引ける", () => {
    const ds2 = dataset({ ...ds, teams: [...ds.teams, team("T1", "T3", "2026-12")] });
    const tree = teamTreeForMonth(ds2, "2026-12");
    expect(contractsForTeam(model, "T3", tree).map((c) => c.contractId)).toEqual(["A"]);
    expect(contractsForTeam(model, "ROOT", tree).map((c) => c.contractId)).toEqual(["B"]);
  });
});
