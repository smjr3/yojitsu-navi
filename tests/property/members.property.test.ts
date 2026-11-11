/**
 * メンバー別（SPEC §18.1）の不変条件
 *   - Σ メンバー実績原価 = Σ 契約原価（同じ期間・同じ契約集合）。時間も同じ
 *   - plannedCost は行（x, c, m）ごとに round(配分 × 基準時間 × 単価)、メンバー月はその合計
 *   - 計画は契約期間内・アサイン期間内の月だけ
 *   - 決定性（同じ入力 → 同じ出力、JSON 往復でも集計が同じ）
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { aggregate } from "../../src/core/aggregate.js";
import { addMonths, businessDaysInMonth, formatYearMonth } from "../../src/core/calendar.js";
import { HolidaySet } from "../../src/core/holidays.js";
import { createMasterIndex, rateFor } from "../../src/core/masters.js";
import { aggregateMembers, memberMonthlySeries } from "../../src/core/members.js";
import { buildModel } from "../../src/core/model.js";
import type { Assignment, Contract, Dataset, Model, Worklog } from "../../src/core/types.js";
import { dataset as makeDataset, member, rate, rule } from "../unit/fixtures.js";

const yearMonthArb = fc.tuple(fc.integer({ min: 2025, max: 2027 }), fc.integer({ min: 1, max: 12 })).map(([y, m]) => formatYearMonth(y, m));

const contractArb: fc.Arbitrary<Contract> = fc
  .record({
    contractId: fc.constantFrom("C0", "C1", "C2", "C3", "C4"),
    startMonth: yearMonthArb,
    length: fc.integer({ min: -2, max: 18 }), // 負 = 期間逆転（CONTRACT_INVALID）
    totalAmount: fc.oneof(fc.integer({ min: 0, max: 50_000_000 }), fc.constant(-1)),
  })
  .map(({ contractId, startMonth, length, totalAmount }) => ({ contractId, customerName: contractId, projectName: "", teamId: null, startMonth, endMonth: addMonths(startMonth, length), totalAmount }));

const MEMBER_COUNT = 4;

const datasetArb: fc.Arbitrary<Dataset> = fc
  .record({
    contracts: fc.array(contractArb, { maxLength: 5 }),
    worklogs: fc.array(
      fc.record({
        contractIndex: fc.nat({ max: 5 }),
        ym: yearMonthArb,
        day: fc.integer({ min: 1, max: 28 }),
        memberIndex: fc.nat({ max: MEMBER_COUNT }), // MEMBER_COUNT = 未登録メンバー
        hours: fc.oneof(fc.double({ min: 0.25, max: 12, noNaN: true }), fc.integer({ min: 1, max: 8 })),
      }),
      { maxLength: 60 },
    ),
    assignments: fc.array(
      fc.record({
        memberIndex: fc.nat({ max: MEMBER_COUNT }),
        contractIndex: fc.nat({ max: 5 }),
        start: yearMonthArb,
        length: fc.integer({ min: 0, max: 14 }),
        allocation: fc.oneof(fc.double({ min: 0, max: 1, noNaN: true }), fc.constantFrom(0, 0.1, 0.25, 0.333, 0.5, 1)),
      }),
      { maxLength: 12 },
    ),
    rates: fc.array(fc.oneof(fc.integer({ min: 0, max: 15_000 }), fc.double({ min: 1000, max: 9999, noNaN: true })), { minLength: MEMBER_COUNT, maxLength: MEMBER_COUNT }),
    revisedRate: fc.option(fc.tuple(fc.nat({ max: MEMBER_COUNT - 1 }), yearMonthArb, fc.integer({ min: 1000, max: 20_000 })), { nil: null }),
    personalRate: fc.option(fc.integer({ min: 1000, max: 9000 }), { nil: null }),
  })
  .map(({ contracts, worklogs, assignments, rates, revisedRate, personalRate }) => {
    const ids = ["C0", "C1", "C2", "C3", "C4"];
    const logs: Worklog[] = worklogs.map((w) => ({
      date: `${w.ym}-${String(w.day).padStart(2, "0")}`,
      memberId: `M${w.memberIndex}`,
      memberName: `名前${w.memberIndex}`,
      customerName: ids[w.contractIndex] ?? "nobody",
      projectName: "",
      task: "",
      hours: w.hours,
    }));
    const as: Assignment[] = assignments.map((a) => ({ memberId: `M${a.memberIndex}`, contractId: ids[a.contractIndex] ?? "NOPE", startMonth: a.start, endMonth: addMonths(a.start, a.length), allocation: a.allocation }));
    const rateRows = rates.map((r, i) => rate(`T${i}`, r, "2000-01"));
    if (revisedRate) rateRows.push(rate(`T${revisedRate[0]}`, revisedRate[2], revisedRate[1]));
    if (personalRate !== null) rateRows.push(rate(`M${MEMBER_COUNT}`, personalRate, "2026-01"));
    return makeDataset({
      contracts,
      mappings: ids.map((id) => rule(id, "", id)),
      members: Array.from({ length: MEMBER_COUNT }, (_, i) => member({ memberId: `M${i}`, title: `T${i}`, teamId: `G${i % 2}` })),
      rates: rateRows,
      assignments: as,
      worklogs: logs,
    });
  });

const periodArb = fc.tuple(yearMonthArb, yearMonthArb).map(([a, b]) => (a <= b ? { from: a, to: b } : { from: b, to: a }));
const asOfArb = fc.constantFrom("2025-06-15", "2026-10-27", "2027-02-03");

function contractSubset(model: Model, mask: number): string[] {
  return model.contracts.map((r) => r.contract.contractId).filter((_, i) => (mask >> i) & 1);
}

describe("メンバー別の不変条件 (SPEC §18.1)", () => {
  it("Σ メンバー実績原価・時間 = Σ 契約原価・時間（同じ期間・同じ契約集合）", () => {
    fc.assert(
      fc.property(datasetArb, asOfArb, periodArb, fc.nat({ max: 31 }), (ds, asOf, period, mask) => {
        const model = buildModel(ds, { asOf, generatedAt: "x" });
        // 全契約
        const all = aggregateMembers(model, { period });
        const totals = aggregate(model, { period });
        expect(all.total.actualCost).toBe(totals.cost);
        expect(all.total.actualHours).toBeCloseTo(totals.hours, 6);
        // 契約の部分集合
        const ids = contractSubset(model, mask);
        const sub = aggregateMembers(model, { period, contractIds: ids });
        const subTotals = aggregate(model, { period, contractIds: ids });
        expect(sub.total.actualCost).toBe(subTotals.cost);
        expect(sub.total.actualHours).toBeCloseTo(subTotals.hours, 6);
        // メンバー・契約別の行の合計 = メンバーの合計
        for (const m of sub.members) {
          expect(m.byContract.reduce((a, c) => a + c.actualCost, 0)).toBe(m.actualCost);
          expect(m.byContract.reduce((a, c) => a + c.plannedCost, 0)).toBe(m.plannedCost);
          expect(m.byContract.reduce((a, c) => a + c.unplannedCost, 0)).toBe(m.unplannedCost);
          expect(m.variance).toBe(m.plannedCost - m.actualCost);
          expect(m.unplannedCost).toBeLessThanOrEqual(m.actualCost);
          // 月次推移の合計も一致
          const s = memberMonthlySeries(model, m.memberId, period, ids);
          expect(s.reduce((a, p) => a + p.plannedCost, 0)).toBe(m.plannedCost);
          expect(s.reduce((a, p) => a + p.actualCost, 0)).toBe(m.actualCost);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("plannedCost は行ごとに round(配分 × 月の稼働時間 × §6 の単価)。計画は契約期間内かつアサイン期間内の月だけ", () => {
    fc.assert(
      fc.property(datasetArb, (ds) => {
        const model = buildModel(ds, { asOf: "2026-10-27", generatedAt: "x" });
        const masters = createMasterIndex(ds);
        const contracts = new Map(model.contracts.map((r) => [r.contract.contractId, r.contract]));
        for (const mm of model.memberMonths) {
          const rateRes = rateFor(masters, mm.memberId, mm.month);
          expect(mm.hourlyRate).toBe(rateRes.hourlyRate);
          expect(mm.rateMissing).toBe(rateRes.rateMissing);
          let planned = 0;
          let plannedHours = 0;
          for (const row of mm.byContract) {
            const c = contracts.get(row.contractId);
            expect(c, "計算対象の契約だけ").toBeDefined();
            // 素朴な再計算: 期間内のアサインの配分合計
            const hits = ds.assignments.filter((a) => a.memberId === mm.memberId && a.contractId === row.contractId && a.startMonth <= mm.month && mm.month <= a.endMonth && Number.isFinite(a.allocation));
            const inContract = c!.startMonth <= mm.month && mm.month <= c!.endMonth;
            expect(row.assignmentCount).toBe(inContract ? hits.length : 0);
            const alloc = hits.reduce((s, a) => s + a.allocation, 0);
            expect(row.allocation).toBeCloseTo(inContract ? alloc : 0, 12);
            // 月の稼働時間 = その月の営業日（土日・祝日を除く）× 1 日の時間（§114）
            expect(mm.monthHours).toBe(businessDaysInMonth(mm.month, new HolidaySet(ds.holidays)) * ds.config.hoursPerBusinessDay);
            expect(row.plannedHours).toBe(row.allocation * mm.monthHours);
            expect(row.plannedCost).toBe(Math.round(row.plannedHours * mm.hourlyRate));
            expect(Number.isInteger(row.plannedCost)).toBe(true);
            planned += row.plannedCost;
            plannedHours += row.plannedHours;
            // 実績は CostLine と同じ
            const cm = model.contracts.find((r) => r.contract.contractId === row.contractId)?.months.find((m) => m.month === mm.month);
            const line = cm?.costLines.find((l) => l.memberId === mm.memberId);
            expect(row.actualCost).toBe(line?.amount ?? 0);
            expect(row.actualHours).toBe(line?.hours ?? 0);
          }
          expect(mm.plannedCost).toBe(planned);
          expect(mm.plannedHours).toBeCloseTo(plannedHours, 9);
          expect(mm.variance).toBe(mm.plannedCost - mm.actualCost);
          expect(mm.byContract.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("決定的: 同じ入力から同じ memberMonths。JSON 往復しても集計は同じ。並びは memberId → month", () => {
    fc.assert(
      fc.property(datasetArb, asOfArb, periodArb, (ds, asOf, period) => {
        const a = buildModel(ds, { asOf, generatedAt: "x" });
        const b = buildModel(structuredClone(ds), { asOf, generatedAt: "y" });
        expect(b.memberMonths).toEqual(a.memberMonths);
        const keys = a.memberMonths.map((m) => `${m.memberId}\u0000${m.month}`);
        expect([...keys].sort()).toEqual(keys);
        expect(new Set(keys).size).toBe(keys.length);
        for (const mm of a.memberMonths) {
          const ids = mm.byContract.map((r) => r.contractId);
          expect([...ids].sort()).toEqual(ids);
        }
        const plain = JSON.parse(JSON.stringify(a)) as Model;
        expect(aggregateMembers(plain, { period, teamIds: ["G0"] })).toEqual(aggregateMembers(a, { period, teamIds: ["G0"] }));
      }),
      { numRuns: 100 },
    );
  });
});
