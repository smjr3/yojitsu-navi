/**
 * 計画と実績のずれ（SPEC §64）: 判定の境界・確定月だけで比べること・並び順
 * 年は直書きしない（今日から相対で作る。SPEC §49）
 */
import { describe, it, expect } from "vitest";
import { addMonths, confirmedPeriodOf, planGapKindOf, planGaps, PLAN_GAP_MIN_HOURS } from "../../src/core/index.js";

const now = new Date();
const asOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
const m = (offset: number) => addMonths(asOfMonth, offset);

type Row = { contractId: string; plannedHours: number; actualHours: number; assignmentCount?: number; outsideType?: string };
function mm(memberId: string, month: string, rows: Row[]) {
  return {
    memberId,
    month,
    memberName: `名前${memberId}`,
    memberUnknown: false,
    kind: "employee",
    title: null,
    teamId: "T1",
    hourlyRate: 0,
    rateSource: null,
    rateMissing: false,
    standardHoursPerMonth: 160,
    plannedHours: 0,
    plannedCost: 0,
    actualHours: 0,
    actualCost: 0,
    unplannedHours: 0,
    unplannedCost: 0,
    variance: 0,
    byContract: rows.map((r) => ({ allocation: r.plannedHours / 160, assignmentCount: r.assignmentCount ?? (r.plannedHours > 0 ? 1 : 0), plannedCost: 0, actualCost: 0, ...r })),
  };
}
function model(memberMonths: ReturnType<typeof mm>[], lastFinalMonth = m(-1)) {
  return { meta: { asOfMonth, lastFinalMonth }, members: [], memberMonths } as never;
}

describe("planGapKindOf", () => {
  it("差が最小時間に満たなければ出さない", () => {
    expect(planGapKindOf(0, PLAN_GAP_MIN_HOURS - 1)).toBeNull();
    expect(planGapKindOf(10, 0)).toBeNull();
    expect(planGapKindOf(0, 0)).toBeNull();
  });
  it("計画なし・実績なし", () => {
    expect(planGapKindOf(0, PLAN_GAP_MIN_HOURS)).toBe("unplanned");
    expect(planGapKindOf(80, 0)).toBe("noActual");
  });
  it("比率 30% が境界", () => {
    expect(planGapKindOf(160, 207)).toBeNull(); // +29%
    expect(planGapKindOf(160, 208)).toBe("over"); // +30%
    expect(planGapKindOf(160, 112)).toBe("under"); // −30%
    expect(planGapKindOf(160, 113)).toBeNull();
  });
  it("比率が大きくても時間差が小さければ出さない", () => {
    expect(planGapKindOf(8, 20)).toBeNull();
  });
});

describe("confirmedPeriodOf", () => {
  it("確定月で切る・確定月が無ければ null", () => {
    expect(confirmedPeriodOf({ lastFinalMonth: m(-1) }, { from: m(-6), to: m(3) })).toEqual({ from: m(-6), to: m(-1) });
    expect(confirmedPeriodOf({ lastFinalMonth: m(-1) }, { from: m(-6), to: m(-3) })).toEqual({ from: m(-6), to: m(-3) });
    expect(confirmedPeriodOf({ lastFinalMonth: m(-1) }, { from: m(0), to: m(0) })).toBeNull();
  });
});

describe("planGaps", () => {
  const data = model([
    mm("M1", m(-2), [{ contractId: "C1", plannedHours: 80, actualHours: 0 }, { contractId: "C2", plannedHours: 0, actualHours: 40 }]),
    mm("M1", m(-1), [{ contractId: "C1", plannedHours: 80, actualHours: 0 }]),
    // 速報の月（今月）の実績は判定に入れない
    mm("M1", m(0), [{ contractId: "C1", plannedHours: 80, actualHours: 160 }, { contractId: "C3", plannedHours: 0, actualHours: 100 }]),
    mm("M2", m(-1), [{ contractId: "C1", plannedHours: 160, actualHours: 150 }, { contractId: "X:提案", outsideType: "提案", plannedHours: 0, actualHours: 32 }]),
  ]);
  it("確定月だけで判定し、差の大きい順", () => {
    const r = planGaps(data, { period: { from: m(-3), to: m(2) } });
    expect(r.judgedPeriod).toEqual({ from: m(-3), to: m(-1) });
    expect(r.rows.map((x) => [x.memberId, x.contractId, x.kind, x.diffHours])).toEqual([
      ["M1", "C1", "noActual", -160],
      ["M1", "C2", "unplanned", 40],
    ]);
  });
  it("運用保守以外は includeOutside のときだけ", () => {
    const r = planGaps(data, { period: { from: m(-3), to: m(-1) }, includeOutside: true });
    expect(r.rows.find((x) => x.outsideType === "提案")?.kind).toBe("unplanned");
  });
  it("メンバーで絞る", () => {
    expect(planGaps(data, { period: { from: m(-3), to: m(-1) }, memberIds: ["M2"] }).rows).toEqual([]);
  });
  it("確定月が無い期間は空", () => {
    expect(planGaps(data, { period: { from: m(0), to: m(0) } })).toEqual({ judgedPeriod: null, rows: [] });
  });
});
