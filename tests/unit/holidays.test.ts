/**
 * 祝日（SPEC §49）: 国民の祝日の計算と、holidays.csv に無い年の自動補完
 */
import { describe, expect, it } from "vitest";
import { businessDaysInMonth, closingDateOf } from "../../src/core/calendar.js";
import { HolidaySet, nationalHolidays } from "../../src/core/holidays.js";
import { buildModel } from "../../src/core/model.js";
import type { Config, Dataset } from "../../src/core/types.js";

const config = { fiscalYearStartMonth: 4, standardHoursPerMonth: 160, hoursPerBusinessDay: 8, burnRateDangerThreshold: 1, closingBusinessDay: 3, forecastMethodDefault: "recent3", forecastRecentMonths: 3, currency: { code: "JPY", defaultUnit: "millionYen" }, labels: {}, worklogSource: { adapter: "csv" }, costTypes: [{ id: "labor", label: "工数" }] } as unknown as Config;

describe("nationalHolidays", () => {
  it("ハッピーマンデー・春分・秋分・振替休日を年ごとに計算する（2028 年）", () => {
    const d = new Map(nationalHolidays(2028).map((h) => [h.date, h.name]));
    expect(d.get("2028-01-10")).toBe("成人の日");
    expect(d.get("2028-03-20")).toBe("春分の日");
    expect(d.get("2028-09-22")).toBe("秋分の日");
    expect(d.get("2028-10-09")).toBe("スポーツの日");
  });
  it("振替休日（2029-02-12: 建国記念の日が日曜）", () => {
    expect(nationalHolidays(2029).find((h) => h.date === "2029-02-12")?.name).toBe("振替休日");
  });
});

describe("HolidaySet", () => {
  const csv = [{ date: "2026-12-29", name: "年末年始休暇" }, { date: "2026-11-03", name: "文化の日" }];

  it("csv にある年は csv のとおり（国民の祝日でも csv に無ければ休日にしない）", () => {
    const s = new HolidaySet(csv);
    expect(s.has("2026-12-29")).toBe(true);
    expect(s.has("2026-11-23")).toBe(false);
    expect(s.filledYears.size).toBe(0);
  });

  it("csv に 1 行も無い年は国民の祝日で補い、補った年を覚える", () => {
    const s = new HolidaySet(csv);
    expect(s.has("2027-01-01")).toBe(true);
    expect(s.has("2027-12-29")).toBe(false); // 会社休日は補わない
    expect([...s.filledYears]).toEqual([2027]);
    // 締め日（翌月第 3 営業日）: 2027-01 は 1/1 が祝日なので 1/6
    expect(closingDateOf("2026-12", config, s)).toBe("2027-01-06");
    expect(businessDaysInMonth("2027-05", s)).toBe(18); // 平日 21 日 − 5/3〜5/5
  });

  it("csv が空なら補わない（祝日なしの指定）", () => {
    const s = new HolidaySet([]);
    expect(s.has("2027-01-01")).toBe(false);
    expect(s.filledYears.size).toBe(0);
  });
});

describe("buildModel の HOLIDAYS_AUTO 警告", () => {
  const dataset = (holidays: Dataset["holidays"]): Dataset => ({
    config,
    contracts: [{ contractId: "C1", customerName: "A", projectName: "P", teamId: "", startMonth: "2027-04", endMonth: "2028-03", totalAmount: 1_200_000, note: "" }],
    mappings: [],
    assignments: [],
    teams: [],
    members: [],
    rates: [],
    holidays,
    worklogs: [],
  }) as unknown as Dataset;

  it("契約の月の年が holidays.csv に無ければ、その年を 1 件の警告で知らせる", () => {
    const m = buildModel(dataset([{ date: "2027-01-01", name: "元日" }]), { asOf: "2027-10-27", generatedAt: "2027-10-27T00:00:00Z" });
    const w = m.warnings.filter((x) => x.code === "HOLIDAYS_AUTO");
    expect(w).toHaveLength(1);
    expect(w[0]?.message).toContain("2028");
    expect(w[0]?.ref).toEqual({ years: "2028" });
  });

  it("足りていれば警告なし", () => {
    const rows = [2027, 2028].map((y) => ({ date: `${y}-01-01`, name: "元日" }));
    const m = buildModel(dataset(rows), { asOf: "2027-10-27", generatedAt: "2027-10-27T00:00:00Z" });
    expect(m.warnings.some((x) => x.code === "HOLIDAYS_AUTO")).toBe(false);
  });
});
