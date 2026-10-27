/**
 * レビュー: SPEC §6/§7 単価と原価行の堅牢性（NaN/Infinity が集計に漏れない、teamId の空）
 */
import { describe, expect, it } from "vitest";
import { aggregate, forecastTotals, monthlySeries } from "../../src/core/aggregate.js";
import { createMasterIndex, rateFor } from "../../src/core/masters.js";
import { buildModel } from "../../src/core/model.js";
import { assignment, contract, dataset, member, rate, rule, worklog } from "./fixtures.js";

function allNumbers(value: unknown, path = "$", out: string[] = []): string[] {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) out.push(path);
  } else if (Array.isArray(value)) value.forEach((v, i) => allNumbers(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) allNumbers(v, `${path}.${k}`, out);
  return out;
}

describe("§6 単価レコードの hourlyRate が数値でない", () => {
  it("NaN の個人単価は「単価なし」（0・rateMissing）として扱い、NaN を返さない", () => {
    const idx = createMasterIndex({ members: [member({ memberId: "M1", title: "SE" })], rates: [rate("M1", Number.NaN)], teams: [] });
    const r = rateFor(idx, "M1", "2026-05");
    expect(r.rateMissing).toBe(true);
    expect(r.hourlyRate).toBe(0);
    expect(r.rateSource).toBeNull();
  });

  it("Infinity の役職単価も単価なし", () => {
    const idx = createMasterIndex({ members: [member({ memberId: "M1", title: "SE" })], rates: [rate("SE", Number.POSITIVE_INFINITY)], teams: [] });
    expect(rateFor(idx, "M1", "2026-05")).toMatchObject({ hourlyRate: 0, rateMissing: true, rateSource: null });
  });

  it("NaN 単価が Model・Totals・着地に漏れない（RATE_MISSING として警告）", () => {
    const ds = dataset({
      contracts: [contract({ contractId: "C1" })],
      mappings: [rule("ABC株式会社", "", "C1")],
      members: [member({ memberId: "M1", title: "SE" })],
      rates: [rate("M1", Number.NaN)],
      assignments: [assignment({ memberId: "M1", contractId: "C1" })],
      worklogs: [worklog({ date: "2026-05-11", memberId: "M1", hours: 2 })],
    });
    const model = buildModel(ds, { asOf: "2026-10-27", generatedAt: "t" });
    expect(allNumbers(model)).toEqual([]);
    const totals = aggregate(model, { period: { from: "2026-04", to: "2027-03" } });
    expect(allNumbers(totals)).toEqual([]);
    expect(totals.burnRate).toBe(0);
    expect(allNumbers(monthlySeries(model, { period: { from: "2026-04", to: "2027-03" } }))).toEqual([]);
    expect(allNumbers(forecastTotals(model, undefined, "assignment"))).toEqual([]);
    expect(model.warnings.some((w) => w.code === "RATE_MISSING" && w.ref?.memberId === "M1" && w.ref.month === "2026-05")).toBe(true);
  });
});

describe("§7 CostLine.memberTeamId", () => {
  it("メンバーの teamId が空文字なら null（空 = 非所属）", () => {
    const ds = dataset({
      contracts: [contract({ contractId: "C1" })],
      mappings: [rule("ABC株式会社", "", "C1")],
      members: [member({ memberId: "M1", title: "SE", teamId: "" })],
      rates: [rate("SE", 1000)],
      worklogs: [worklog({ date: "2026-05-11", memberId: "M1", hours: 1 })],
    });
    const model = buildModel(ds, { asOf: "2026-10-27", generatedAt: "t" });
    const line = model.contracts[0]!.months.find((m) => m.month === "2026-05")!.costLines[0]!;
    expect(line.memberTeamId).toBeNull();
  });
});
