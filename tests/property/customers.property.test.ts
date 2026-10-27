import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { aggregate } from "../../src/core/aggregate.js";
import { NONE_CUSTOMER_KEY, customerKey, groupByCustomer } from "../../src/core/customers.js";
import { buildModel } from "../../src/core/model.js";
import { normalizeName } from "../../src/core/normalize.js";
import { contract, dataset as makeDataset, member, rate, rule, worklog } from "../unit/fixtures.js";

// 揺れ（全角・法人格・空白）、日本語、記号、予約文字を意図的に混ぜた顧客名
const nameArb = fc.oneof(
  fc.constantFrom("", " ", "株式会社", "ABC商事", "ＡＢＣ商事", "(株)ABC商事", "A&B 100% #1", "x/y?z=1", "__none__", "___none__", "あ　い", "ＸＹＺ"),
  fc.string({ maxLength: 6 }),
  fc.fullUnicodeString({ maxLength: 6 }),
);
const contractsArb = fc.uniqueArray(fc.record({ contractId: fc.string({ minLength: 1, maxLength: 4 }), customerName: nameArb }), { selector: (c) => c.contractId, maxLength: 30 });

describe("顧客キー・グループ化の性質 (SPEC §17)", () => {
  it("キーは決定的で、normalizeName が同じなら同じ顧客", () => {
    fc.assert(
      fc.property(nameArb, nameArb, (a, b) => {
        expect(customerKey(a)).toBe(customerKey(a));
        if (normalizeName(a) === normalizeName(b)) expect(customerKey(a)).toBe(customerKey(b));
        else expect(customerKey(a)).not.toBe(customerKey(b));
      }),
    );
  });

  it("全契約がちょうど 1 つの顧客に属し、キーは重複しない", () => {
    fc.assert(
      fc.property(contractsArb, (contracts) => {
        const groups = groupByCustomer(contracts);
        const all = groups.flatMap((g) => g.contractIds);
        expect([...all].sort()).toEqual(contracts.map((c) => c.contractId).sort());
        expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length);
        for (const g of groups) {
          expect(g.contractIds.length).toBeGreaterThan(0);
          for (const id of g.contractIds) expect(customerKey(contracts.find((c) => c.contractId === id)!.customerName)).toBe(g.key);
        }
      }),
    );
  });

  it("入力の並び（順列）に依らない", () => {
    fc.assert(
      fc.property(contractsArb, fc.integer(), (contracts, seed) => {
        const shuffled = [...contracts].sort((a, b) => ((a.contractId.length * 31 + seed) % 7) - ((b.contractId.length * 17 + seed) % 7) || (a.contractId < b.contractId ? 1 : -1));
        expect(groupByCustomer(shuffled)).toEqual(groupByCustomer(contracts));
      }),
    );
  });

  it("表示名は契約ID昇順で最初の契約の顧客名・顧客名なしは末尾", () => {
    fc.assert(
      fc.property(contractsArb, (contracts) => {
        const groups = groupByCustomer(contracts);
        for (const g of groups) {
          if (g.key === NONE_CUSTOMER_KEY) continue;
          const first = contracts.filter((c) => customerKey(c.customerName) === g.key).sort((a, b) => (a.contractId < b.contractId ? -1 : 1))[0]!;
          expect(g.label).toBe(first.customerName);
        }
        const noneAt = groups.findIndex((g) => g.key === NONE_CUSTOMER_KEY);
        if (noneAt >= 0) expect(noneAt).toBe(groups.length - 1);
      }),
    );
  });

  it("顧客ごとの合計 = 全体の合計（予算・原価・粗利・時間・契約数）", () => {
    const customers = ["ABC商事", "ＡＢＣ商事", "株式会社", "", "Zeta"];
    fc.assert(
      fc.property(
        fc.array(fc.record({ customer: fc.constantFrom(...customers), total: fc.integer({ min: 0, max: 5_000_000 }), start: fc.constantFrom("2026-04", "2026-07", "2026-10"), hours: fc.integer({ min: 0, max: 60 }) }), { minLength: 1, maxLength: 8 }),
        (specs) => {
          const contracts = specs.map((s, i) => contract({ contractId: `K${i}`, customerName: s.customer, projectName: "P", startMonth: s.start, endMonth: "2027-03", totalAmount: s.total }));
          const worklogs = specs.map((s, i) => worklog({ date: "2026-10-05", memberId: "M1", hours: s.hours, customerName: `WL${i}`, projectName: "P" }));
          const mappings = contracts.map((c, i) => rule(`WL${i}`, "P", c.contractId));
          const ds = makeDataset({ contracts, members: [member({ memberId: "M1" })], rates: [rate("SE", 5000)], mappings, worklogs });
          const model = buildModel(ds, { asOf: "2026-10-27", generatedAt: "2026-10-27T00:00:00Z" });
          const period = { from: "2026-04", to: "2027-03" };
          const whole = aggregate(model, { period });
          const groups = groupByCustomer(model.contracts.map((r) => r.contract));
          const parts = groups.map((g) => aggregate(model, { period, contractIds: g.contractIds }));
          const sum = (f: (t: (typeof parts)[number]) => number) => parts.reduce((a, t) => a + f(t), 0);
          expect(sum((t) => t.budget)).toBe(whole.budget);
          expect(sum((t) => t.cost)).toBe(whole.cost);
          expect(sum((t) => t.grossProfit)).toBe(whole.grossProfit);
          expect(sum((t) => t.contractCount)).toBe(whole.contractCount);
        },
      ),
      { numRuns: 60 },
    );
  });
});
