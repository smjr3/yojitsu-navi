import { describe, expect, it } from "vitest";
import { computeMonthCost, createLaborProvider, indexWorklogs, roundYen, type CostProvider } from "../../src/core/cost.js";
import { createMasterIndex } from "../../src/core/masters.js";
import { dataset, member, rate, worklog } from "./fixtures.js";

const masters = createMasterIndex(
  dataset({
    members: [member({ memberId: "M1", name: "山田", title: "SE", teamId: "T1" }), member({ memberId: "M2", name: "鈴木", title: "PG", kind: "partner", teamId: null })],
    rates: [rate("SE", 5000), rate("M2", 4000), rate("PG", 3000)],
  }),
);

function labor(logs: Parameters<typeof indexWorklogs>[0]): CostProvider {
  return createLaborProvider(masters, indexWorklogs(logs));
}

describe("月次原価 (SPEC §7)", () => {
  it("メンバーごとにまとめ、hours × 単価 を円に丸める", () => {
    const provider = labor([
      { contractId: "C1", month: "2026-05", worklog: worklog({ date: "2026-05-01", memberId: "M1", memberName: "yamada", hours: 1.5 }) },
      { contractId: "C1", month: "2026-05", worklog: worklog({ date: "2026-05-02", memberId: "M1", memberName: "yamada", hours: 2 }) },
      { contractId: "C1", month: "2026-05", worklog: worklog({ date: "2026-05-02", memberId: "M2", memberName: "suzuki", hours: 0.25 }) },
    ]);
    const r = computeMonthCost([provider], ["labor"], "C1", "2026-05");
    expect(r.costLines).toEqual([
      { costType: "labor", memberId: "M1", memberName: "山田", hours: 3.5, hourlyRate: 5000, rateSource: { key: "SE", effectiveFrom: "2000-01" }, rateMissing: false, amount: 17500, memberTeamId: "T1" },
      { costType: "labor", memberId: "M2", memberName: "鈴木", hours: 0.25, hourlyRate: 4000, rateSource: { key: "M2", effectiveFrom: "2000-01" }, rateMissing: false, amount: 1000, memberTeamId: null },
    ]);
    expect(r.costs).toEqual({ labor: 18500 });
    expect(r.cost).toBe(18500);
    expect(r.hours).toBe(3.75);
    expect(r.worklogs).toHaveLength(3);
    expect(r.worklogs[0]).toMatchObject({ contractId: "C1", memberId: "M1", hourlyRate: 5000, amount: 7500 });
  });

  it("丸めは行（メンバー×月）単位で Math.round", () => {
    // 0.25h × 3333 = 833.25 → 833。 3 件まとめて 0.75h × 3333 = 2499.75 → 2500
    const idx = createMasterIndex(dataset({ members: [member({ memberId: "M", title: "X" })], rates: [rate("X", 3333)] }));
    const provider = createLaborProvider(idx, indexWorklogs([1, 2, 3].map((d) => ({ contractId: "C", month: "2026-05", worklog: worklog({ date: `2026-05-0${d}`, memberId: "M", hours: 0.25 }) }))));
    const r = computeMonthCost([provider], ["labor"], "C", "2026-05");
    expect(r.costLines[0]?.amount).toBe(2500);
    expect(r.worklogs.map((w) => w.amount)).toEqual([833, 833, 833]);
    expect(roundYen(0.5)).toBe(1);
    expect(roundYen(-0.5)).toBe(-0);
    expect(roundYen(2.4999)).toBe(2);
  });

  it("単価なし → 金額 0・rateMissing", () => {
    const provider = labor([{ contractId: "C1", month: "2026-05", worklog: worklog({ date: "2026-05-01", memberId: "NOBODY", memberName: "誰か", hours: 8 }) }]);
    const r = computeMonthCost([provider], ["labor"], "C1", "2026-05");
    expect(r.costLines[0]).toMatchObject({ memberId: "NOBODY", memberName: "誰か", hourlyRate: 0, rateMissing: true, rateSource: null, amount: 0, memberTeamId: null });
    expect(r.cost).toBe(0);
    expect(r.hours).toBe(8);
  });

  it("該当する実績が無い契約・月は 0 行", () => {
    const r = computeMonthCost([labor([])], ["labor"], "C1", "2026-05");
    expect(r).toEqual({ costs: { labor: 0 }, cost: 0, hours: 0, costLines: [], worklogs: [] });
  });

  it("costs は config.costTypes の全IDを持ち、プロバイダの無い種類は 0", () => {
    const r = computeMonthCost([labor([])], ["labor", "outsourcing"], "C1", "2026-05");
    expect(r.costs).toEqual({ labor: 0, outsourcing: 0 });
  });

  it("別の原価種類のプロバイダを追加できる（外注費）", () => {
    const outsourcing: CostProvider = {
      costType: "outsourcing",
      compute: (contractId, month) =>
        contractId === "C1" && month === "2026-05"
          ? { lines: [{ costType: "outsourcing", memberId: "VENDOR", memberName: "外注先", hours: 0, hourlyRate: 0, rateSource: null, rateMissing: false, amount: 100000, memberTeamId: null }], worklogs: [] }
          : { lines: [], worklogs: [] },
    };
    const provider = labor([{ contractId: "C1", month: "2026-05", worklog: worklog({ date: "2026-05-01", memberId: "M1", hours: 2 }) }]);
    const r = computeMonthCost([provider, outsourcing], ["labor", "outsourcing"], "C1", "2026-05");
    expect(r.costs).toEqual({ labor: 10000, outsourcing: 100000 });
    expect(r.cost).toBe(110000);
    expect(r.hours).toBe(2);
    expect(r.costLines.map((l) => l.costType)).toEqual(["labor", "outsourcing"]);
  });

  it("月によって単価・所属が変わる（当時の値を使う）", () => {
    const idx = createMasterIndex(
      dataset({
        members: [member({ memberId: "M1", title: "SE", teamId: "T1", effectiveFrom: "2026-01" }), member({ memberId: "M1", title: "PM", teamId: "T2", effectiveFrom: "2026-07" })],
        rates: [rate("SE", 5000), rate("PM", 8000)],
      }),
    );
    const logs = indexWorklogs([
      { contractId: "C", month: "2026-06", worklog: worklog({ date: "2026-06-30", memberId: "M1", hours: 1 }) },
      { contractId: "C", month: "2026-07", worklog: worklog({ date: "2026-07-01", memberId: "M1", hours: 1 }) },
    ]);
    const p = createLaborProvider(idx, logs);
    expect(computeMonthCost([p], ["labor"], "C", "2026-06").costLines[0]).toMatchObject({ hourlyRate: 5000, memberTeamId: "T1" });
    expect(computeMonthCost([p], ["labor"], "C", "2026-07").costLines[0]).toMatchObject({ hourlyRate: 8000, memberTeamId: "T2" });
  });
});
