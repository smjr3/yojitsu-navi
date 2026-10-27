/**
 * レビュー: SPEC §8 月の状態・lastFinalMonth の境界
 */
import { describe, expect, it } from "vitest";
import { monthlySeries } from "../../src/core/aggregate.js";
import { closingDateOf, monthRange } from "../../src/core/calendar.js";
import { buildModel } from "../../src/core/model.js";
import { lastFinalMonth, monthStatus, monthStatusFromMeta } from "../../src/core/status.js";
import { baseConfig, contract, dataset } from "./fixtures.js";

const cfg = { closingBusinessDay: 3 };

/** 2026-05 の平日を全部祝日にした祝日集合（営業日 0 の月） */
function mayAllHolidays(): Set<string> {
  const set = new Set<string>();
  for (let d = 1; d <= 31; d++) set.add(`2026-05-${String(d).padStart(2, "0")}`);
  return set;
}

describe("§8 確定日が祝日で翌々月に繰り越す場合", () => {
  it("翌月の営業日が足りないと確定日は翌々月に繰り越す", () => {
    const hol = mayAllHolidays();
    expect(closingDateOf("2026-04", cfg, hol)).toBe("2026-06-03");
    expect(closingDateOf("2026-05", cfg, hol)).toBe("2026-06-03");
  });

  it("lastFinalMonth は状態が final の最大月（前々月も未確定なら更に遡る）", () => {
    const ctx = { asOf: "2026-06-01", config: cfg, holidays: mayAllHolidays() };
    expect(monthStatus("2026-05", ctx)).toBe("preliminary");
    expect(monthStatus("2026-04", ctx)).toBe("preliminary");
    expect(monthStatus("2026-03", ctx)).toBe("final");
    expect(lastFinalMonth(ctx)).toBe("2026-03");
  });

  it("closingBusinessDay が大きい設定でも lastFinalMonth は monthStatus と一致する", () => {
    const ctx = { asOf: "2026-06-01", config: { closingBusinessDay: 25 }, holidays: new Set<string>() };
    const lf = lastFinalMonth(ctx);
    expect(monthStatus(lf, ctx)).toBe("final");
    for (const m of monthRange("2025-06", "2026-07")) {
      expect(monthStatusFromMeta(m, { asOfMonth: "2026-06", lastFinalMonth: lf })).toBe(monthStatus(m, ctx));
    }
  });

  it("ContractMonth.status と monthlySeries().status が常に一致する", () => {
    const hol = [...mayAllHolidays()].map((date) => ({ date, name: "休" }));
    const ds = dataset({ contracts: [contract({ contractId: "C1", startMonth: "2026-01", endMonth: "2026-12", totalAmount: 1200 })], holidays: hol });
    const model = buildModel(ds, { asOf: "2026-06-01", generatedAt: "t" });
    const series = new Map(monthlySeries(model, { period: { from: "2026-01", to: "2026-12" } }).map((p) => [p.month, p.status]));
    for (const cm of model.contracts[0]!.months) expect(series.get(cm.month), cm.month).toBe(cm.status);
  });
});

describe("§8 年末年始・ゴールデンウィークの確定日", () => {
  const hol = new Set(["2026-01-01", "2026-01-02", "2026-01-03", "2026-05-04", "2026-05-05", "2026-05-06", "2027-01-01", "2027-01-02", "2027-01-03"]);
  it("2025-12 分は 2026-01-07（1〜3 日休み、3 日は土曜）に確定。前日は速報、当日は確定", () => {
    expect(closingDateOf("2025-12", cfg, hol)).toBe("2026-01-07");
    expect(monthStatus("2025-12", { asOf: "2026-01-06", config: cfg, holidays: hol })).toBe("preliminary");
    expect(monthStatus("2025-12", { asOf: "2026-01-07", config: cfg, holidays: hol })).toBe("final");
    expect(lastFinalMonth({ asOf: "2026-01-06", config: cfg, holidays: hol })).toBe("2025-11");
    expect(lastFinalMonth({ asOf: "2026-01-07", config: cfg, holidays: hol })).toBe("2025-12");
  });
  it("2026-04 分は GW 明け 2026-05-08 に確定（5/1 金が第1営業日）", () => {
    expect(closingDateOf("2026-04", cfg, hol)).toBe("2026-05-08");
    expect(monthStatus("2026-04", { asOf: "2026-05-07", config: cfg, holidays: hol })).toBe("preliminary");
    expect(monthStatus("2026-04", { asOf: "2026-05-08", config: cfg, holidays: hol })).toBe("final");
  });
  it("うるう年: 2028-02 分の確定日は 2028-03 の第3営業日、2028-02-29 は営業日", () => {
    expect(closingDateOf("2028-02", cfg, hol)).toBe("2028-03-03");
    expect(monthStatus("2028-02", { asOf: "2028-02-29", config: cfg, holidays: hol })).toBe("preliminary");
  });
  it("buildModel の meta.lastFinalMonth は asOf=確定日ちょうどで前月になる", () => {
    const ds = dataset({ holidays: [...hol].map((date) => ({ date, name: "休" })), config: baseConfig });
    expect(buildModel(ds, { asOf: "2026-01-07", generatedAt: "t" }).meta.lastFinalMonth).toBe("2025-12");
    expect(buildModel(ds, { asOf: "2026-01-06", generatedAt: "t" }).meta.lastFinalMonth).toBe("2025-11");
  });
});
