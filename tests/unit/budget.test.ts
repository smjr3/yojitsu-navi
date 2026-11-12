import { describe, expect, it } from "vitest";
import { budgetSchedule, contractInvalidReason, contractMonthCount, monthlyBudget, partitionContracts } from "../../src/core/budget.js";
import { businessDaysInMonth } from "../../src/core/calendar.js";
import { contract } from "./fixtures.js";

/** どの月も営業日 20 日（＝均等割りと同じ） */
const flat = () => 20;
/** 祝日なしの平日の数（2026-04 = 22、05 = 21、06 = 22 …） */
const weekdays = (m: string) => businessDaysInMonth(m, []);

describe("月次予算: 営業日数で按分（SPEC §3・§118）", () => {
  it("どの月も同じ営業日なら均等: 12 か月 ¥2,400,000 → 毎月 200,000、端数 0", () => {
    const c = contract({ contractId: "C1" });
    const first = monthlyBudget(c, "2026-04", flat);
    expect(first.budget).toBe(200_000);
    expect(first.breakdown).toEqual({ totalAmount: 2_400_000, monthCount: 12, businessDays: 20, totalBusinessDays: 240, byBusinessDays: true, baseAmount: 200_000, remainder: 0, isLastMonth: false });
    expect(monthlyBudget(c, "2027-03", flat).breakdown.isLastMonth).toBe(true);
  });

  it("営業日の多い月ほど多い: 4〜6 月（22・21・22 日）で ¥650,000 → 220,000・210,000・220,000", () => {
    const c = contract({ contractId: "C1", startMonth: "2026-04", endMonth: "2026-06", totalAmount: 650_000 });
    expect(budgetSchedule(c, weekdays).map((b) => b.budget)).toEqual([220_000, 210_000, 220_000]);
    expect(monthlyBudget(c, "2026-05", weekdays).breakdown).toMatchObject({ businessDays: 21, totalBusinessDays: 65, baseAmount: 210_000 });
  });

  it("祝日・会社の休日を足すと、その月が減ってほかの月に回る（合計は変わらない）", () => {
    const c = contract({ contractId: "C1", startMonth: "2026-04", endMonth: "2026-06", totalAmount: 640_000 });
    const off = new Set(["2026-05-04", "2026-05-05", "2026-05-06"]);
    const days = (m: string) => businessDaysInMonth(m, off);
    // 22・18・22 日 = 62 日
    const s = budgetSchedule(c, days);
    expect(s.map((b) => b.breakdown.businessDays)).toEqual([22, 18, 22]);
    // floor(640,000 × 22 ÷ 62) = 227,096、floor(640,000 × 18 ÷ 62) = 185,806、最終月 = 残り 227,098
    expect(s.map((b) => b.budget)).toEqual([227_096, 185_806, 227_098]);
    expect(s.reduce((a, b) => a + b.budget, 0)).toBe(640_000);
  });

  it("100 / 3（同じ営業日）→ 33, 33, 34。端数は最終月", () => {
    const c = contract({ contractId: "C1", startMonth: "2026-04", endMonth: "2026-06", totalAmount: 100 });
    expect(budgetSchedule(c, flat).map((b) => b.budget)).toEqual([33, 33, 34]);
    expect(monthlyBudget(c, "2026-06", flat).breakdown).toMatchObject({ baseAmount: 33, remainder: 1, isLastMonth: true });
  });

  it("端数は最終月にまとめて乗る（10 / 12）", () => {
    const c = contract({ contractId: "C1", totalAmount: 10 });
    const s = budgetSchedule(c, flat);
    expect(s.slice(0, 11).every((b) => b.budget === 0)).toBe(true);
    expect(s[11]?.budget).toBe(10);
  });

  it("1 か月契約（start == end）", () => {
    const c = contract({ contractId: "C1", startMonth: "2026-04", endMonth: "2026-04", totalAmount: 12345 });
    expect(contractMonthCount(c)).toBe(1);
    expect(monthlyBudget(c, "2026-04", weekdays)).toEqual({ budget: 12345, breakdown: { totalAmount: 12345, monthCount: 1, businessDays: 22, totalBusinessDays: 22, byBusinessDays: true, baseAmount: 12345, remainder: 0, isLastMonth: true } });
  });

  it("契約期間の営業日が 0 日なら月数で均等に割る", () => {
    const c = contract({ contractId: "C1", startMonth: "2026-04", endMonth: "2026-06", totalAmount: 100 });
    const s = budgetSchedule(c, () => 0);
    expect(s.map((b) => b.budget)).toEqual([33, 33, 34]);
    expect(s[0]!.breakdown.byBusinessDays).toBe(false);
  });

  it("総額 0 は有効（予算 0）", () => {
    const c = contract({ contractId: "C1", totalAmount: 0 });
    expect(budgetSchedule(c, weekdays).every((b) => b.budget === 0)).toBe(true);
    expect(contractInvalidReason(c)).toBeNull();
  });

  it("期間外の月は例外", () => {
    const c = contract({ contractId: "C1" });
    expect(() => monthlyBudget(c, "2026-03", flat)).toThrow(RangeError);
    expect(() => monthlyBudget(c, "2027-04", flat)).toThrow(RangeError);
  });

  it("年またぎ（2026-12〜2027-01）", () => {
    const c = contract({ contractId: "C1", startMonth: "2026-12", endMonth: "2027-01", totalAmount: 5 });
    expect(budgetSchedule(c, flat).map((b) => [b.month, b.budget])).toEqual([["2026-12", 2], ["2027-01", 3]]);
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
