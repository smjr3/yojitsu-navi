import { describe, expect, it } from "vitest";
import { lastFinalMonth, monthStatus, monthStatusFromMeta } from "../../src/core/status.js";

const config = { closingBusinessDay: 3 };
const none = new Set<string>();

describe("月の状態 (SPEC §8)", () => {
  // 2026-09 の確定日 = 2026-10 の第3営業日 = 2026-10-05（1木, 2金, 5月）
  it("asOf 月より後は future、asOf 月は preliminary", () => {
    const ctx = { asOf: "2026-10-27", config, holidays: none };
    expect(monthStatus("2026-11", ctx)).toBe("future");
    expect(monthStatus("2027-03", ctx)).toBe("future");
    expect(monthStatus("2026-10", ctx)).toBe("preliminary");
  });

  it("前月: 確定日ちょうどなら final、前日なら preliminary", () => {
    expect(monthStatus("2026-09", { asOf: "2026-10-05", config, holidays: none })).toBe("final");
    expect(monthStatus("2026-09", { asOf: "2026-10-04", config, holidays: none })).toBe("preliminary");
    expect(monthStatus("2026-09", { asOf: "2026-10-01", config, holidays: none })).toBe("preliminary");
  });

  it("前々月は常に final", () => {
    expect(monthStatus("2026-08", { asOf: "2026-10-01", config, holidays: none })).toBe("final");
  });

  it("祝日で確定日がずれる", () => {
    // 2026-10-01(木) と 10-02(金) が祝日 → 5(月),6(火),7(水) → 確定日 10-07
    const holidays = new Set(["2026-10-01", "2026-10-02"]);
    expect(monthStatus("2026-09", { asOf: "2026-10-06", config, holidays })).toBe("preliminary");
    expect(monthStatus("2026-09", { asOf: "2026-10-07", config, holidays })).toBe("final");
  });

  it("1 日が土曜の月（2026-08）: 確定日は 08-05", () => {
    expect(monthStatus("2026-07", { asOf: "2026-08-04", config, holidays: none })).toBe("preliminary");
    expect(monthStatus("2026-07", { asOf: "2026-08-05", config, holidays: none })).toBe("final");
  });

  it("年をまたぐ: 2026-12 の確定日は 2027-01 の第3営業日（1日祝）= 01-06", () => {
    // 2027-01-01(金)祝, 4(月), 5(火), 6(水)
    const holidays = new Set(["2027-01-01"]);
    expect(monthStatus("2026-12", { asOf: "2027-01-05", config, holidays })).toBe("preliminary");
    expect(monthStatus("2026-12", { asOf: "2027-01-06", config, holidays })).toBe("final");
  });

  it("closingBusinessDay = 1", () => {
    expect(monthStatus("2026-09", { asOf: "2026-10-01", config: { closingBusinessDay: 1 }, holidays: none })).toBe("final");
  });
});

describe("lastFinalMonth", () => {
  it("前月分が確定していれば前月、していなければ前々月", () => {
    expect(lastFinalMonth({ asOf: "2026-10-27", config, holidays: none })).toBe("2026-09");
    expect(lastFinalMonth({ asOf: "2026-10-05", config, holidays: none })).toBe("2026-09");
    expect(lastFinalMonth({ asOf: "2026-10-04", config, holidays: none })).toBe("2026-08");
    expect(lastFinalMonth({ asOf: "2026-10-01", config, holidays: none })).toBe("2026-08");
  });

  it("1月の初めは前年の 11 月", () => {
    expect(lastFinalMonth({ asOf: "2027-01-02", config, holidays: new Set(["2027-01-01"]) })).toBe("2026-11");
  });
});

describe("monthStatusFromMeta（Model からの再構成）", () => {
  const meta = { asOfMonth: "2026-10", lastFinalMonth: "2026-09" };
  it("asOf と lastFinalMonth から同じ判定になる", () => {
    expect(monthStatusFromMeta("2026-11", meta)).toBe("future");
    expect(monthStatusFromMeta("2026-10", meta)).toBe("preliminary");
    expect(monthStatusFromMeta("2026-09", meta)).toBe("final");
    expect(monthStatusFromMeta("2020-01", meta)).toBe("final");
    expect(monthStatusFromMeta("2026-09", { asOfMonth: "2026-10", lastFinalMonth: "2026-08" })).toBe("preliminary");
  });
});
