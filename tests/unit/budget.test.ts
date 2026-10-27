import { describe, expect, it } from "vitest";
import { budgetSchedule, contractInvalidReason, contractMonthCount, monthlyBudget, partitionContracts } from "../../src/core/budget.js";
import { contract } from "./fixtures.js";

describe("月次予算 (SPEC §3)", () => {
  it("12 か月 ¥2,400,000 → 毎月 200,000、端数 0", () => {
    const c = contract({ contractId: "C1" });
    const first = monthlyBudget(c, "2026-04");
    expect(first.budget).toBe(200_000);
    expect(first.breakdown).toEqual({ totalAmount: 2_400_000, monthCount: 12, baseMonthly: 200_000, remainder: 0, isLastMonth: false });
    expect(monthlyBudget(c, "2027-03").breakdown.isLastMonth).toBe(true);
  });

  it("100 / 3 → 33, 33, 34", () => {
    const c = contract({ contractId: "C1", startMonth: "2026-04", endMonth: "2026-06", totalAmount: 100 });
    expect(budgetSchedule(c).map((b) => b.budget)).toEqual([33, 33, 34]);
    expect(monthlyBudget(c, "2026-06").breakdown).toEqual({ totalAmount: 100, monthCount: 3, baseMonthly: 33, remainder: 1, isLastMonth: true });
  });

  it("端数は最終月にまとめて乗る（10 / 12）", () => {
    const c = contract({ contractId: "C1", totalAmount: 10 });
    const s = budgetSchedule(c);
    expect(s.slice(0, 11).every((b) => b.budget === 0)).toBe(true);
    expect(s[11]?.budget).toBe(10);
    expect(s.reduce((a, b) => a + b.budget, 0)).toBe(10);
  });

  it("1 か月契約（start == end）", () => {
    const c = contract({ contractId: "C1", startMonth: "2026-04", endMonth: "2026-04", totalAmount: 12345 });
    expect(contractMonthCount(c)).toBe(1);
    expect(monthlyBudget(c, "2026-04")).toEqual({ budget: 12345, breakdown: { totalAmount: 12345, monthCount: 1, baseMonthly: 12345, remainder: 0, isLastMonth: true } });
  });

  it("総額 0 は有効（予算 0）", () => {
    const c = contract({ contractId: "C1", totalAmount: 0 });
    expect(budgetSchedule(c).every((b) => b.budget === 0)).toBe(true);
    expect(contractInvalidReason(c)).toBeNull();
  });

  it("期間外の月は例外", () => {
    const c = contract({ contractId: "C1" });
    expect(() => monthlyBudget(c, "2026-03")).toThrow(RangeError);
    expect(() => monthlyBudget(c, "2027-04")).toThrow(RangeError);
  });

  it("年またぎ（2026-12〜2027-01）", () => {
    const c = contract({ contractId: "C1", startMonth: "2026-12", endMonth: "2027-01", totalAmount: 5 });
    expect(budgetSchedule(c).map((b) => [b.month, b.budget])).toEqual([["2026-12", 2], ["2027-01", 3]]);
  });
});

describe("契約の妥当性 (SPEC §2)", () => {
  it("start > end は不正", () => {
    expect(contractInvalidReason(contract({ contractId: "C1", startMonth: "2027-03", endMonth: "2026-04" }))).toMatch(/より後/);
  });

  it("負の金額・NaN は不正", () => {
    expect(contractInvalidReason(contract({ contractId: "C1", totalAmount: -1 }))).toMatch(/負/);
    expect(contractInvalidReason(contract({ contractId: "C1", totalAmount: Number.NaN }))).toMatch(/数値/);
    expect(contractInvalidReason(contract({ contractId: "C1", totalAmount: Number.POSITIVE_INFINITY }))).toMatch(/数値/);
  });

  it("年月の形式不正", () => {
    expect(contractInvalidReason(contract({ contractId: "C1", startMonth: "2026-4" }))).toMatch(/開始月/);
    expect(contractInvalidReason(contract({ contractId: "C1", endMonth: "2027-13" }))).toMatch(/終了月/);
    expect(contractMonthCount(contract({ contractId: "C1", startMonth: "bad" }))).toBe(0);
  });

  it("partitionContracts: 重複は最初の行だけ採用、不正は除外", () => {
    const r = partitionContracts([
      contract({ contractId: "C1", totalAmount: 100 }),
      contract({ contractId: "C1", totalAmount: 999 }),
      contract({ contractId: "C2", totalAmount: -5 }),
      contract({ contractId: "C3" }),
    ]);
    expect(r.valid.map((c) => c.contractId)).toEqual(["C1", "C3"]);
    expect(r.valid[0]?.totalAmount).toBe(100);
    expect(r.warnings.map((w) => w.code)).toEqual(["DUPLICATE_CONTRACT_ID", "CONTRACT_INVALID"]);
    expect(r.excluded).toHaveLength(2);
  });

  it("partitionContracts: 最初の行が不正でも 2 行目の同じ ID は採用しない", () => {
    const r = partitionContracts([contract({ contractId: "C1", totalAmount: -1 }), contract({ contractId: "C1" })]);
    expect(r.valid).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual(["CONTRACT_INVALID", "DUPLICATE_CONTRACT_ID"]);
  });
});
