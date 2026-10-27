import { describe, expect, it } from "vitest";
import { aggregate, monthlySeries } from "../../src/core/aggregate.js";
import { buildModel } from "../../src/core/model.js";
import type { Contract, MappingRule, MemberRecord, Worklog } from "../../src/core/types.js";
import { dataset, rate, team } from "./fixtures.js";

/** 決定的な擬似乱数（テストを再現可能にする） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function bigDataset(contractCount: number, worklogCount: number) {
  const rnd = lcg(42);
  const contracts: Contract[] = [];
  const mappings: MappingRule[] = [];
  for (let i = 0; i < contractCount; i++) {
    const id = `C${String(i).padStart(4, "0")}`;
    const startYear = 2025 + Math.floor(rnd() * 2);
    const startMonth = `${startYear}-${String(1 + Math.floor(rnd() * 12)).padStart(2, "0")}`;
    contracts.push({ contractId: id, customerName: `顧客${i}`, projectName: `案件${i}`, teamId: `T${i % 10}`, startMonth, endMonth: `${startYear + 1}-${startMonth.slice(5)}`, totalAmount: Math.floor(rnd() * 10_000_000) });
    mappings.push({ worklogCustomerName: `顧客${i}`, worklogProjectName: "", contractId: id });
  }
  const members: MemberRecord[] = Array.from({ length: 200 }, (_, i) => ({ memberId: `M${i}`, name: `名前${i}`, kind: "employee", title: `T${i % 5}`, department: "", section: "", teamId: `T${i % 10}`, effectiveFrom: "2000-01" }));
  const worklogs: Worklog[] = [];
  for (let i = 0; i < worklogCount; i++) {
    const c = Math.floor(rnd() * contractCount);
    const year = 2025 + Math.floor(rnd() * 3);
    const month = 1 + Math.floor(rnd() * 12);
    const day = 1 + Math.floor(rnd() * 28);
    worklogs.push({ date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, memberId: `M${Math.floor(rnd() * 200)}`, memberName: "", customerName: `顧客${c}`, projectName: "", task: "", hours: 0.25 * (1 + Math.floor(rnd() * 32)) });
  }
  return dataset({
    contracts,
    mappings,
    members,
    rates: Array.from({ length: 5 }, (_, i) => rate(`T${i}`, 3000 + i * 500)),
    teams: Array.from({ length: 10 }, (_, i) => team(`T${i}`, null)),
    worklogs,
  });
}

describe("性能", () => {
  it("作業ログ 5 万件 × 契約 100 件の Model 構築が 2 秒以内", () => {
    const ds = bigDataset(100, 50_000);
    const start = performance.now();
    const model = buildModel(ds, { asOf: "2026-10-27" });
    const elapsed = performance.now() - start;
    expect(model.contracts).toHaveLength(100);
    const assignedHours = model.contracts.reduce((a, c) => a + c.months.reduce((b, m) => b + m.hours, 0), 0);
    const unmappedHours = model.unmapped.reduce((a, g) => a + g.hours, 0);
    expect(assignedHours + unmappedHours).toBeCloseTo(ds.worklogs.reduce((a, w) => a + w.hours, 0), 6);
    expect(elapsed).toBeLessThan(2000);
  });

  it("集計は Model に対して高速（1000 回で 2 秒以内）", () => {
    const model = buildModel(bigDataset(100, 20_000), { asOf: "2026-10-27" });
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      aggregate(model, { period: { from: "2026-04", to: "2027-03" } });
      monthlySeries(model, { period: { from: "2026-04", to: "2027-03" } });
    }
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
