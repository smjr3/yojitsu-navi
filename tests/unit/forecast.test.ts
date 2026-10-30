import { describe, expect, it } from "vitest";
import { assignmentPlanOf, forecastAllMethods, forecastAllMethodsForMonths, forecastContract, forecastForMonths, type ForecastBasis, type ForecastContext } from "../../src/core/forecast.js";
import { createMasterIndex } from "../../src/core/masters.js";
import { monthRange } from "../../src/core/calendar.js";
import type { Contract, ContractMonth } from "../../src/core/types.js";
import { assignment, baseConfig, contract, dataset, member, rate } from "./fixtures.js";

/** 契約の各月に原価を与えた ContractMonth[] を作る（予算は均等） */
function months(c: Contract, costByMonth: Record<string, number>, budget = 100_000): ContractMonth[] {
  return monthRange(c.startMonth, c.endMonth).map((m) => ({
    contractId: c.contractId,
    month: m,
    status: "final",
    budget,
    budgetBreakdown: { totalAmount: 0, monthCount: 0, baseMonthly: budget, remainder: 0, isLastMonth: false },
    costs: { labor: costByMonth[m] ?? 0 },
    cost: costByMonth[m] ?? 0,
    grossProfit: budget - (costByMonth[m] ?? 0),
    hours: 0,
    costLines: [],
    worklogs: [],
    businessDays: 20,
  }));
}

const masters = createMasterIndex(dataset({ members: [member({ memberId: "M1", title: "SE" })], rates: [rate("SE", 5000), rate("SE", 6000, "2027-01")] }));

function ctx(overrides: Partial<ForecastContext> = {}): ForecastContext {
  return { asOfMonth: "2026-10", config: baseConfig, masters, assignments: [], ...overrides };
}

describe("着地見込み (SPEC §10)", () => {
  const C = contract({ contractId: "C1", startMonth: "2026-04", endMonth: "2027-03", totalAmount: 1_200_000 });

  it("年度・月の分割（asOf 月は残り月に含む）", () => {
    const f = forecastContract(ctx(), C, months(C, {}), "recent3");
    expect(f.fiscalYear).toBe(2026);
    expect(f.breakdown.targetMonths).toHaveLength(12);
    expect(f.breakdown.contractMonthsInTarget).toEqual(monthRange("2026-04", "2027-03"));
    expect(f.breakdown.actualMonths).toEqual(monthRange("2026-04", "2026-09"));
    expect(f.breakdown.remainingMonths).toEqual(monthRange("2026-10", "2027-03"));
    expect(f.targetBudget).toBe(1_200_000);
  });

  it("recent3: 直近 3 か月の平均 × 残り月数", () => {
    // 04:10, 05:20, 06:30, 07:40, 08:50, 09:60（09 は 2026-09 < asOf 2026-10 なので実績）
    const costs = { "2026-04": 10, "2026-05": 20, "2026-06": 30, "2026-07": 40, "2026-08": 50, "2026-09": 60, "2026-10": 999 };
    const f = forecastContract(ctx(), C, months(C, costs), "recent3");
    expect(f.breakdown.averageBasisMonths).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(f.breakdown.averageMonthlyCost).toBe(50);
    expect(f.breakdown.actualCost).toBe(210);
    expect(f.breakdown.remainingCost).toBe(300); // 50 × 6
    expect(f.forecastCost).toBe(510);
    expect(f.forecastGrossProfit).toBe(1_200_000 - 510);
    expect(f.isDeficit).toBe(false);
    expect(f.breakdown.noActuals).toBe(false);
  });

  it("all: 契約開始からの全月平均", () => {
    const costs = { "2026-04": 10, "2026-05": 20, "2026-06": 30, "2026-07": 40, "2026-08": 50, "2026-09": 60 };
    const f = forecastContract(ctx(), C, months(C, costs), "all");
    expect(f.breakdown.averageBasisMonths).toEqual(monthRange("2026-04", "2026-09"));
    expect(f.breakdown.averageMonthlyCost).toBe(35);
    expect(f.breakdown.remainingCost).toBe(210);
    expect(f.forecastCost).toBe(420);
  });

  it("残り原価は円に丸める（平均が割り切れない場合）", () => {
    const costs = { "2026-07": 1, "2026-08": 1, "2026-09": 2 }; // 平均 4/3
    const f = forecastContract(ctx(), C, months(C, costs), "recent3");
    expect(f.breakdown.averageMonthlyCost).toBeCloseTo(4 / 3);
    expect(f.breakdown.remainingCost).toBe(8); // 4/3 × 6 = 8
    const f2 = forecastContract(ctx({ asOfMonth: "2026-11" }), C, months(C, { "2026-08": 1, "2026-09": 1, "2026-10": 2 }), "recent3");
    expect(f2.breakdown.remainingCost).toBe(Math.round((4 / 3) * 5)); // 6.67 → 7
    expect(Number.isInteger(f2.forecastCost)).toBe(true);
  });

  it("recent3 の基礎月は年度をまたいでよい", () => {
    const old = contract({ contractId: "C1", startMonth: "2025-10", endMonth: "2026-09" });
    const costs = { "2026-01": 100, "2026-02": 200, "2026-03": 300, "2026-04": 400 };
    const f = forecastContract(ctx({ asOfMonth: "2026-05" }), old, months(old, costs), "recent3");
    expect(f.breakdown.averageBasisMonths).toEqual(["2026-02", "2026-03", "2026-04"]);
    expect(f.breakdown.averageMonthlyCost).toBe(300);
    expect(f.breakdown.contractMonthsInTarget).toEqual(monthRange("2026-04", "2026-09"));
    expect(f.breakdown.actualMonths).toEqual(["2026-04"]);
    expect(f.breakdown.actualCost).toBe(400);
    expect(f.breakdown.remainingMonths).toEqual(monthRange("2026-05", "2026-09"));
    expect(f.breakdown.remainingCost).toBe(1500);
    expect(f.targetBudget).toBe(600_000);
  });

  it("実績 0 か月（契約が asOf 月に開始）→ noActuals、残り原価 0", () => {
    const f = forecastContract(ctx({ asOfMonth: "2026-04" }), C, months(C, { "2026-04": 5 }), "recent3");
    expect(f.breakdown.noActuals).toBe(true);
    expect(f.breakdown.averageBasisMonths).toEqual([]);
    expect(f.breakdown.remainingCost).toBe(0);
    expect(f.forecastCost).toBe(0);
    expect(f.targetBudget).toBe(1_200_000);
    expect(forecastContract(ctx({ asOfMonth: "2026-04" }), C, months(C, {}), "all").breakdown.noActuals).toBe(true);
  });

  it("実績 1 か月・2 か月 → ある分で平均", () => {
    const f1 = forecastContract(ctx({ asOfMonth: "2026-05" }), C, months(C, { "2026-04": 30 }), "recent3");
    expect(f1.breakdown.averageBasisMonths).toEqual(["2026-04"]);
    expect(f1.breakdown.averageMonthlyCost).toBe(30);
    expect(f1.breakdown.remainingCost).toBe(30 * 11);
    const f2 = forecastContract(ctx({ asOfMonth: "2026-06" }), C, months(C, { "2026-04": 30, "2026-05": 50 }), "recent3");
    expect(f2.breakdown.averageBasisMonths).toEqual(["2026-04", "2026-05"]);
    expect(f2.breakdown.averageMonthlyCost).toBe(40);
    expect(f2.breakdown.remainingCost).toBe(40 * 10);
  });

  it("実績 5 か月 → recent3 は直近 3、all は 5", () => {
    const costs = { "2026-04": 1, "2026-05": 2, "2026-06": 3, "2026-07": 4, "2026-08": 5 };
    const r3 = forecastContract(ctx({ asOfMonth: "2026-09" }), C, months(C, costs), "recent3");
    const all = forecastContract(ctx({ asOfMonth: "2026-09" }), C, months(C, costs), "all");
    expect(r3.breakdown.averageBasisMonths).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(r3.breakdown.averageMonthlyCost).toBe(4);
    expect(all.breakdown.averageBasisMonths).toHaveLength(5);
    expect(all.breakdown.averageMonthlyCost).toBe(3);
  });

  it("forecastRecentMonths を変えられる", () => {
    const costs = { "2026-04": 1, "2026-05": 2, "2026-06": 3, "2026-07": 4, "2026-08": 5 };
    const f = forecastContract(ctx({ asOfMonth: "2026-09", config: { ...baseConfig, forecastRecentMonths: 2 } }), C, months(C, costs), "recent3");
    expect(f.breakdown.averageBasisMonths).toEqual(["2026-07", "2026-08"]);
  });

  it("年度途中で終わる契約: 残り月は終了月まで", () => {
    const short = contract({ contractId: "S", startMonth: "2026-04", endMonth: "2026-12", totalAmount: 900_000 });
    const f = forecastContract(ctx(), short, months(short, { "2026-09": 300 }), "recent3");
    expect(f.breakdown.contractMonthsInTarget).toEqual(monthRange("2026-04", "2026-12"));
    expect(f.breakdown.remainingMonths).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(f.breakdown.averageBasisMonths).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(f.breakdown.remainingCost).toBe(300); // 100 × 3
    expect(f.targetBudget).toBe(900_000);
  });

  it("年度に 1 か月も掛からない契約: すべて 0・赤字でない", () => {
    const past = contract({ contractId: "P", startMonth: "2025-04", endMonth: "2026-03", totalAmount: 1000 });
    for (const method of ["recent3", "all", "assignment"] as const) {
      const f = forecastContract(ctx({ assignments: [assignment({ memberId: "M1", contractId: "P", startMonth: "2025-04", endMonth: "2026-03" })] }), past, months(past, { "2026-03": 500 }), method);
      expect(f.targetBudget).toBe(0);
      expect(f.forecastCost).toBe(0);
      expect(f.forecastGrossProfit).toBe(0);
      expect(f.isDeficit).toBe(false);
      expect(f.breakdown.contractMonthsInTarget).toEqual([]);
      expect(f.breakdown.remainingCost).toBe(0);
    }
    const future = contract({ contractId: "F", startMonth: "2027-04", endMonth: "2028-03" });
    expect(forecastContract(ctx(), future, months(future, {}), "recent3").breakdown.contractMonthsInTarget).toEqual([]);
  });

  it("未来に始まる契約（年度内）: 実績なし、残り月は開始月から", () => {
    const fut = contract({ contractId: "F", startMonth: "2027-01", endMonth: "2027-12", totalAmount: 1_200_000 });
    const f = forecastContract(ctx(), fut, months(fut, {}), "recent3");
    expect(f.breakdown.contractMonthsInTarget).toEqual(["2027-01", "2027-02", "2027-03"]);
    expect(f.breakdown.actualMonths).toEqual([]);
    expect(f.breakdown.noActuals).toBe(true);
    expect(f.targetBudget).toBe(300_000);
    expect(f.forecastCost).toBe(0);
  });

  it("assignment: allocation × 標準時間 × 当月単価、月ごとの単価改定を反映", () => {
    const f = forecastContract(
      ctx({ assignments: [assignment({ memberId: "M1", contractId: "C1", startMonth: "2026-04", endMonth: "2027-03", allocation: 0.5 }), assignment({ memberId: "M1", contractId: "OTHER" })] }),
      C,
      months(C, { "2026-09": 100 }),
      "assignment",
    );
    // 2026-10..12: 0.5 × 160 × 5000 = 400,000 × 3 = 1,200,000
    // 2027-01..03: 0.5 × 160 × 6000 = 480,000 × 3 = 1,440,000
    expect(f.breakdown.assignmentLines).toHaveLength(6);
    expect(f.breakdown.assignmentLines[0]).toEqual({ month: "2026-10", memberId: "M1", allocation: 0.5, hours: 80, hourlyRate: 5000, amount: 400_000 });
    expect(f.breakdown.assignmentLines[5]).toEqual({ month: "2027-03", memberId: "M1", allocation: 0.5, hours: 80, hourlyRate: 6000, amount: 480_000 });
    expect(f.breakdown.remainingCost).toBe(2_640_000);
    expect(f.forecastCost).toBe(2_640_100);
    expect(f.isDeficit).toBe(true);
    expect(f.breakdown.noAssignments).toBe(false);
    expect(f.breakdown.averageBasisMonths).toEqual([]);
  });

  it("assignment: アサイン期間が残り月の一部だけ", () => {
    const f = forecastContract(ctx({ assignments: [assignment({ memberId: "M1", contractId: "C1", startMonth: "2026-11", endMonth: "2026-11", allocation: 1 })] }), C, months(C, {}), "assignment");
    expect(f.breakdown.assignmentLines.map((l) => l.month)).toEqual(["2026-11"]);
    expect(f.breakdown.remainingCost).toBe(800_000);
  });

  it("assignment: アサインが 0 件 → noAssignments、残り原価 0", () => {
    const f = forecastContract(ctx(), C, months(C, { "2026-09": 100 }), "assignment");
    expect(f.breakdown.noAssignments).toBe(true);
    expect(f.breakdown.remainingCost).toBe(0);
    expect(f.forecastCost).toBe(100);
  });

  it("assignment: 契約にアサインはあるが残り月に掛からない → 明細 0 件だが noAssignments ではない", () => {
    const f = forecastContract(ctx({ assignments: [assignment({ memberId: "M1", contractId: "C1", startMonth: "2026-04", endMonth: "2026-06" })] }), C, months(C, {}), "assignment");
    expect(f.breakdown.noAssignments).toBe(false);
    expect(f.breakdown.assignmentLines).toEqual([]);
    expect(f.breakdown.remainingCost).toBe(0);
  });

  it("assignment: 単価なしメンバーは 0 円", () => {
    const f = forecastContract(ctx({ assignments: [assignment({ memberId: "GHOST", contractId: "C1" })] }), C, months(C, {}), "assignment");
    expect(f.breakdown.assignmentLines.every((l) => l.hourlyRate === 0 && l.amount === 0)).toBe(true);
  });

  it("forecastAllMethods は 3 方式を返す", () => {
    const all = forecastAllMethods(ctx(), C, months(C, {}));
    expect(Object.keys(all).sort()).toEqual(["all", "assignment", "recent3"]);
    expect(all.recent3.method).toBe("recent3");
    expect(all.assignment.breakdown.noAssignments).toBe(true);
  });

  it("赤字判定は粗利 < 0（0 は赤字でない）", () => {
    const zero = contract({ contractId: "Z", startMonth: "2026-04", endMonth: "2027-03", totalAmount: 0 });
    const f = forecastContract(ctx(), zero, months(zero, {}, 0), "all");
    expect(f.forecastGrossProfit).toBe(0);
    expect(f.isDeficit).toBe(false);
    const f2 = forecastContract(ctx(), zero, months(zero, { "2026-09": 1 }, 0), "all");
    expect(f2.isDeficit).toBe(true);
  });
});

describe("着地見込みの対象の月を指定する (SPEC §54)", () => {
  // 年度をまたぐ契約: 2026-10 〜 2027-09（12 か月）。asOf = 2027-01
  const X = contract({ contractId: "X1", startMonth: "2026-10", endMonth: "2027-09", totalAmount: 1_200_000 });
  const basis: ForecastBasis = { asOfMonth: "2027-01", fiscalYear: 2026, forecastRecentMonths: 3 };
  const ms = months(X, { "2026-10": 30_000, "2026-11": 60_000, "2026-12": 90_000 });
  const c = ctx({ asOfMonth: "2027-01", assignments: [assignment({ memberId: "M1", contractId: "X1", startMonth: "2026-10", endMonth: "2027-09", allocation: 0.5 })] });
  const plan = assignmentPlanOf(c, X);

  it("リソース計画の明細は asOf 月から契約終了月まで（年度の外も）", () => {
    expect(plan.hasAssignments).toBe(true);
    expect(plan.lines.map((l) => l.month)).toEqual(monthRange("2027-01", "2027-09"));
  });

  it("対象 = 選んだ期間: 期間内の契約月だけで予算・実績・残りを数える", () => {
    const f = forecastForMonths(basis, X, ms, plan, "recent3", monthRange("2026-04", "2027-03"));
    expect(f.breakdown.contractMonthsInTarget).toEqual(monthRange("2026-10", "2027-03"));
    expect(f.breakdown.remainingMonths).toEqual(monthRange("2027-01", "2027-03"));
    expect(f.targetBudget).toBe(600_000);
    expect(f.forecastCost).toBe(180_000 + 60_000 * 3);
  });

  it("対象 = 契約の全期間（案件終了時点の着地）: 年度をまたいだ残り月も入る", () => {
    const f = forecastForMonths(basis, X, ms, plan, "recent3", monthRange(X.startMonth, X.endMonth));
    expect(f.breakdown.remainingMonths).toHaveLength(9);
    expect(f.targetBudget).toBe(1_200_000);
    expect(f.forecastCost).toBe(180_000 + 60_000 * 9);
    expect(f.isDeficit).toBe(false);
  });

  it("assignment: 明細は対象の残り月だけ。明細は元の plan と別のオブジェクト（JSON に出せる）", () => {
    const f = forecastForMonths(basis, X, ms, plan, "assignment", monthRange("2027-01", "2027-02"));
    expect(f.breakdown.assignmentLines.map((l) => l.month)).toEqual(["2027-01", "2027-02"]);
    expect(f.breakdown.assignmentLines[0]).not.toBe(plan.lines[0]);
    expect(f.breakdown.remainingCost).toBe(plan.lines[0]!.amount + plan.lines[1]!.amount);
    expect(() => JSON.stringify({ plan, f })).not.toThrow();
  });

  it("過去だけの期間: 残り月 0、着地差 = 期間の残予算", () => {
    const f = forecastForMonths(basis, X, ms, plan, "all", monthRange("2026-10", "2026-12"));
    expect(f.breakdown.remainingMonths).toEqual([]);
    expect(f.forecastGrossProfit).toBe(300_000 - 180_000);
  });

  it("契約に掛からない期間: すべて 0・超過でない", () => {
    const f = forecastForMonths(basis, X, ms, plan, "assignment", monthRange("2027-10", "2027-12"));
    expect(f.breakdown.contractMonthsInTarget).toEqual([]);
    expect(f.targetBudget).toBe(0);
    expect(f.forecastCost).toBe(0);
    expect(f.isDeficit).toBe(false);
  });

  it("forecastAllMethodsForMonths は 3 方式を返す", () => {
    expect(Object.keys(forecastAllMethodsForMonths(basis, X, ms, plan, monthRange("2026-04", "2027-03")))).toEqual(["assignment", "recent3", "all"]);
  });
});
