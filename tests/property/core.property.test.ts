import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { aggregate, monthlySeries } from "../../src/core/aggregate.js";
import { budgetSchedule } from "../../src/core/budget.js";
import { addMonths, formatYearMonth, monthOfDate } from "../../src/core/calendar.js";
import { mapWorklogs } from "../../src/core/mapping.js";
import { teamTreeAt } from "../../src/core/masters.js";
import { buildModel } from "../../src/core/model.js";
import { normalizeName } from "../../src/core/normalize.js";
import type { Contract, Dataset, TeamRecord, Worklog } from "../../src/core/types.js";
import { baseConfig, dataset as makeDataset, member, rate, rule } from "../unit/fixtures.js";

const yearMonthArb = fc.tuple(fc.integer({ min: 2020, max: 2030 }), fc.integer({ min: 1, max: 12 })).map(([y, m]) => formatYearMonth(y, m));

const contractArb: fc.Arbitrary<Contract> = fc
  .record({
    contractId: fc.string({ minLength: 1, maxLength: 4 }),
    startMonth: yearMonthArb,
    length: fc.integer({ min: 0, max: 36 }),
    totalAmount: fc.integer({ min: 0, max: 100_000_000 }),
  })
  .map(({ contractId, startMonth, length, totalAmount }) => ({
    contractId,
    customerName: contractId,
    projectName: "",
    teamId: null,
    startMonth,
    endMonth: addMonths(startMonth, length),
    totalAmount,
  }));

describe("予算の不変条件 (SPEC §3)", () => {
  it("全月の合計 == totalAmount、最終月以外は営業日に比例（切り捨て）、端数は月数未満（§118）", () => {
    fc.assert(
      fc.property(contractArb, fc.array(fc.integer({ min: 0, max: 23 }), { minLength: 1, maxLength: 12 }), (c, pattern) => {
        const daysOf = (m: string) => pattern[Number(m.slice(5, 7)) % pattern.length]!;
        const s = budgetSchedule(c, daysOf);
        expect(s.reduce((a, b) => a + b.budget, 0)).toBe(c.totalAmount);
        expect(s.every((b) => Number.isInteger(b.budget) && b.budget >= 0)).toBe(true);
        const total = s.reduce((a, b) => a + b.breakdown.businessDays, 0);
        for (const b of s.slice(0, -1)) {
          expect(b.budget).toBe(total > 0 ? Math.floor((c.totalAmount * b.breakdown.businessDays) / total) : Math.floor(c.totalAmount / s.length));
        }
        expect(s.at(-1)?.breakdown.remainder).toBeLessThan(s.length);
        expect(s.at(-1)?.breakdown.remainder).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

describe("normalizeName", () => {
  it("冪等", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (s) => {
        const once = normalizeName(s);
        expect(normalizeName(once)).toBe(once);
      }),
    );
    // 日本語・法人格を含む文字列でも
    const pieces = ["株式会社", "（株）", "㈱", "ＡＢＣ", "abc", " ", "　", "Inc.", "Co., Ltd.", "合同会社", "ｱｲｳ", "ﾃｽﾄ"];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...pieces), { maxLength: 6 }), (parts) => {
        const s = parts.join("");
        const once = normalizeName(s);
        expect(normalizeName(once)).toBe(once);
      }),
    );
  });
});

/** ランダムな契約群と作業ログ、単価を持つ Dataset */
const datasetArb: fc.Arbitrary<Dataset> = fc
  .record({
    contracts: fc.array(contractArb, { minLength: 0, maxLength: 6 }),
    worklogs: fc.array(
      fc.record({
        contractIndex: fc.nat({ max: 7 }),
        year: fc.integer({ min: 2020, max: 2032 }),
        month: fc.integer({ min: 1, max: 12 }),
        day: fc.integer({ min: 1, max: 28 }),
        memberIndex: fc.nat({ max: 3 }),
        hours: fc.oneof(fc.double({ min: 0, max: 24, noNaN: true }), fc.constant(0), fc.constant(-1), fc.constant(Number.NaN)),
      }),
      { maxLength: 60 },
    ),
    rates: fc.array(fc.integer({ min: 0, max: 20_000 }), { minLength: 4, maxLength: 4 }),
  })
  .map(({ contracts, worklogs, rates }) => {
    const ids = contracts.map((c) => c.contractId);
    const logs: Worklog[] = worklogs.map((w) => ({
      date: `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`,
      memberId: `M${w.memberIndex}`,
      memberName: "",
      customerName: ids[w.contractIndex] ?? `nobody${w.contractIndex}`,
      projectName: "",
      task: "",
      hours: w.hours,
    }));
    return makeDataset({
      contracts,
      mappings: ids.map((id) => rule(id, "", id)),
      members: rates.map((_, i) => member({ memberId: `M${i}`, title: `T${i}` })),
      rates: rates.map((r, i) => rate(`T${i}`, r)),
      worklogs: logs,
    });
  });

const asOfArb = fc.tuple(fc.integer({ min: 2021, max: 2031 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 })).map(([y, m, d]) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);

describe("Model の不変条件", () => {
  it("aggregate(period) == Σ monthlySeries、cost == Σ costLines.amount == Σ worklogs.amount（整数単価×整数時間）", () => {
    fc.assert(
      fc.property(datasetArb, asOfArb, (ds, asOf) => {
        const model = buildModel(ds, { asOf, generatedAt: "x" });
        for (const r of model.contracts) {
          for (const cm of r.months) {
            expect(cm.cost).toBe(cm.costLines.reduce((a, l) => a + l.amount, 0));
            expect(cm.costs.labor).toBe(cm.cost);
            expect(cm.hours).toBeCloseTo(cm.worklogs.reduce((a, w) => a + w.hours, 0), 6);
            expect(Number.isInteger(cm.cost)).toBe(true);
            expect(cm.grossProfit).toBe(cm.budget - cm.cost);
            // 作業ログ単位の丸めは行単位の丸めと最大 0.5 円/件 ずれうる
            const entrySum = cm.worklogs.reduce((a, w) => a + w.amount, 0);
            expect(Math.abs(entrySum - cm.cost)).toBeLessThanOrEqual(0.5 * cm.worklogs.length + 0.5 * cm.costLines.length);
          }
        }
        const period = { from: model.meta.minMonth, to: model.meta.maxMonth };
        const totals = aggregate(model, { period });
        const series = monthlySeries(model, { period });
        expect(series.reduce((a, p) => a + p.budget, 0)).toBe(totals.budget);
        expect(series.reduce((a, p) => a + p.cost, 0)).toBe(totals.cost);
        expect(series.reduce((a, p) => a + p.grossProfit, 0)).toBe(totals.grossProfit);
        expect(series.reduce((a, p) => a + p.hours, 0)).toBeCloseTo(totals.hours, 6);
        expect(totals.budget).toBe(model.contracts.reduce((a, r) => a + r.contract.totalAmount, 0));
      }),
      { numRuns: 150 },
    );
  });

  it("整数時間なら作業ログ単位の金額合計も原価と一致", () => {
    const intDatasetArb = datasetArb.map((ds) => ({ ...ds, worklogs: ds.worklogs.map((w) => ({ ...w, hours: Number.isFinite(w.hours) ? Math.round(w.hours) : w.hours })) }));
    fc.assert(
      fc.property(intDatasetArb, asOfArb, (ds, asOf) => {
        const model = buildModel(ds, { asOf, generatedAt: "x" });
        for (const r of model.contracts) for (const cm of r.months) expect(cm.worklogs.reduce((a, w) => a + w.amount, 0)).toBe(cm.cost);
      }),
    );
  });

  it("forecastCost >= actualCost（原価がすべて 0 以上のとき）、targetBudget は年度内予算の合計", () => {
    fc.assert(
      fc.property(datasetArb, asOfArb, (ds, asOf) => {
        const model = buildModel(ds, { asOf, generatedAt: "x" });
        for (const r of model.contracts) {
          for (const f of Object.values(r.forecasts)) {
            expect(f.forecastCost).toBeGreaterThanOrEqual(f.breakdown.actualCost);
            expect(f.forecastGrossProfit).toBe(f.targetBudget - f.forecastCost);
            expect(f.isDeficit).toBe(f.forecastGrossProfit < 0);
            const inFY = r.months.filter((m) => model.meta.fiscalYearMonths.includes(m.month));
            expect(f.targetBudget).toBe(inFY.reduce((a, m) => a + m.budget, 0));
            expect(f.breakdown.contractMonthsInTarget).toEqual(inFY.map((m) => m.month));
            expect(f.breakdown.actualMonths.every((m) => m < model.meta.asOfMonth)).toBe(true);
            expect(f.breakdown.remainingMonths.every((m) => m >= model.meta.asOfMonth)).toBe(true);
          }
        }
      }),
    );
  });

  it("JSON で往復しても同じ（Map やクラスを含まない）", () => {
    fc.assert(
      fc.property(datasetArb, asOfArb, (ds, asOf) => {
        const model = buildModel(ds, { asOf, generatedAt: "x" });
        expect(JSON.parse(JSON.stringify(model))).toEqual(model);
      }),
      { numRuns: 30 },
    );
  });
});

describe("紐付けの不変条件 (SPEC §4.2)", () => {
  it("期間外の契約には決して紐付けない。hours <= 0 / NaN は無視。時間は保存される", () => {
    fc.assert(
      fc.property(datasetArb, (ds) => {
        const valid = ds.contracts.filter((c, i, all) => all.findIndex((x) => x.contractId === c.contractId) === i);
        const byId = new Map(valid.map((c) => [c.contractId, c]));
        const r = mapWorklogs(ds.worklogs, ds.mappings, valid);
        expect(r.mappings).toHaveLength(ds.worklogs.length);
        let total = 0;
        for (const m of r.mappings) {
          if (m.kind === "assigned") {
            const c = byId.get(m.contractId);
            expect(c).toBeDefined();
            expect(monthOfDate(m.worklog.date)).toBe(m.month);
            expect(c && c.startMonth <= m.month && m.month <= c.endMonth).toBe(true);
            expect(m.worklog.hours).toBeGreaterThan(0);
            total += m.worklog.hours;
          } else if (m.kind === "ignored") {
            expect(!(m.worklog.hours > 0) || m.reason === "INVALID_DATE").toBe(true);
          } else {
            expect(m.worklog.hours).toBeGreaterThan(0);
            total += m.worklog.hours;
          }
        }
        const unmappedHours = r.unmapped.reduce((a, g) => a + g.hours, 0);
        const assignedHours = r.assigned.reduce((a, m) => a + m.worklog.hours, 0);
        expect(assignedHours + unmappedHours + r.excludedHours).toBeCloseTo(total, 6);
      }),
    );
  });
});

describe("チーム階層の不変条件 (SPEC §11)", () => {
  const teamsArb: fc.Arbitrary<TeamRecord[]> = fc
    .array(fc.tuple(fc.integer({ min: 0, max: 9 }), fc.option(fc.integer({ min: 0, max: 11 }), { nil: null }), fc.constantFrom("2000-01", "2026-01", "2027-01")), { maxLength: 20 })
    .map((rows) => rows.map(([id, parent, from]) => ({ teamId: `T${id}`, name: `T${id}`, parentTeamId: parent === null ? null : `T${parent}`, effectiveFrom: from })));

  it("循環・未知の親があっても例外を投げず、木として整合する", () => {
    fc.assert(
      fc.property(teamsArb, fc.constantFrom("1999-12", "2026-06", "2027-06"), (teams, month) => {
        const { tree, rootTeamIds } = teamTreeAt({ teams }, month);
        const all = Object.values(tree);
        // 子孫IDに重複が無い
        for (const n of all) {
          expect(new Set(n.descendantIds).size).toBe(n.descendantIds.length);
          expect(n.descendantIds[0]).toBe(n.teamId);
          expect(n.descendantIds.length).toBeGreaterThanOrEqual(1 + n.children.length);
          if (n.parentTeamId !== null) {
            expect(tree[n.parentTeamId]?.children).toContain(n.teamId);
            expect(tree[n.parentTeamId]?.depth).toBe(n.depth - 1);
          } else {
            expect(n.depth).toBe(0);
            expect(rootTeamIds).toContain(n.teamId);
          }
        }
        // 最上位の子孫をすべて合わせると全ノードを 1 回ずつ含む（循環が切れている）
        const covered = rootTeamIds.flatMap((id) => tree[id]?.descendantIds ?? []);
        expect(covered.length).toBe(all.length);
        expect(new Set(covered).size).toBe(all.length);
        // 有効レコードが無い月は空
        const expectedIds = new Set(teams.filter((t) => t.effectiveFrom <= month).map((t) => t.teamId));
        expect(new Set(Object.keys(tree))).toEqual(expectedIds);
      }),
    );
  });
});

describe("設定", () => {
  it("baseConfig は仕様の既定値", () => {
    expect(baseConfig.fiscalYearStartMonth).toBe(4);
  });
});
