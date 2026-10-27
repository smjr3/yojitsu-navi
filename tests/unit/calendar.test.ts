import { describe, expect, it } from "vitest";
import {
  addMonths,
  businessDaysInMonth,
  closingDateOf,
  compareYearMonth,
  daysInMonth,
  fiscalYearMonths,
  fiscalYearOf,
  formatYearMonth,
  isBusinessDay,
  isMonthInRange,
  isValidISODate,
  isValidYearMonth,
  monthOfDate,
  monthRange,
  monthsBetween,
  nthBusinessDay,
  parseYearMonth,
  toHolidaySet,
} from "../../src/core/calendar.js";

describe("年月 (SPEC §2)", () => {
  it("isValidYearMonth", () => {
    expect(isValidYearMonth("2026-04")).toBe(true);
    expect(isValidYearMonth("2026-12")).toBe(true);
    expect(isValidYearMonth("2026-13")).toBe(false);
    expect(isValidYearMonth("2026-00")).toBe(false);
    expect(isValidYearMonth("2026-4")).toBe(false);
    expect(isValidYearMonth("2026/04")).toBe(false);
    expect(isValidYearMonth("2026-04-01")).toBe(false);
    expect(isValidYearMonth("")).toBe(false);
    expect(isValidYearMonth(202604)).toBe(false);
    expect(isValidYearMonth(null)).toBe(false);
  });

  it("parse / format", () => {
    expect(parseYearMonth("2026-04")).toEqual({ year: 2026, month: 4 });
    expect(formatYearMonth(2026, 4)).toBe("2026-04");
    expect(() => parseYearMonth("2026-4")).toThrow(RangeError);
  });

  it("compare は文字列比較", () => {
    expect(compareYearMonth("2026-04", "2026-05")).toBeLessThan(0);
    expect(compareYearMonth("2026-12", "2027-01")).toBeLessThan(0);
    expect(compareYearMonth("2026-04", "2026-04")).toBe(0);
    expect(compareYearMonth("2027-01", "2026-12")).toBeGreaterThan(0);
  });

  it("addMonths は年をまたぐ・負も可", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-04", 11)).toBe("2027-03");
    expect(addMonths("2026-04", -12)).toBe("2025-04");
    expect(addMonths("2026-04", 0)).toBe("2026-04");
    expect(addMonths("2026-03", 25)).toBe("2028-04");
  });

  it("monthsBetween は両端を含む", () => {
    expect(monthsBetween("2026-04", "2027-03")).toBe(12);
    expect(monthsBetween("2026-04", "2026-04")).toBe(1);
    expect(monthsBetween("2026-05", "2026-04")).toBe(0);
    expect(monthsBetween("2025-12", "2026-01")).toBe(2);
  });

  it("monthRange", () => {
    expect(monthRange("2026-11", "2027-02")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(monthRange("2026-04", "2026-04")).toEqual(["2026-04"]);
    expect(monthRange("2026-05", "2026-04")).toEqual([]);
  });

  it("isMonthInRange", () => {
    expect(isMonthInRange("2026-04", "2026-04", "2027-03")).toBe(true);
    expect(isMonthInRange("2027-03", "2026-04", "2027-03")).toBe(true);
    expect(isMonthInRange("2027-04", "2026-04", "2027-03")).toBe(false);
    expect(isMonthInRange("2026-03", "2026-04", "2027-03")).toBe(false);
  });
});

describe("日付", () => {
  it("isValidISODate は実在する日付のみ", () => {
    expect(isValidISODate("2026-10-27")).toBe(true);
    expect(isValidISODate("2028-02-29")).toBe(true); // うるう日
    expect(isValidISODate("2027-02-29")).toBe(false);
    expect(isValidISODate("2028-02-30")).toBe(false);
    expect(isValidISODate("2026-04-31")).toBe(false);
    expect(isValidISODate("2026-13-01")).toBe(false);
    expect(isValidISODate("2026-00-10")).toBe(false);
    expect(isValidISODate("2026-10-00")).toBe(false);
    expect(isValidISODate("2026/10/27")).toBe(false);
    expect(isValidISODate("2026-10-7")).toBe(false);
    expect(isValidISODate("20261027")).toBe(false);
    expect(isValidISODate("")).toBe(false);
    expect(isValidISODate(undefined)).toBe(false);
  });

  it("daysInMonth", () => {
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2027, 2)).toBe(28);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it("monthOfDate", () => {
    expect(monthOfDate("2026-10-27")).toBe("2026-10");
    expect(() => monthOfDate("2026-10-32")).toThrow(RangeError);
  });

  it("toHolidaySet は配列と Set の両方を受ける", () => {
    const set = toHolidaySet([{ date: "2026-01-01", name: "元日" }]);
    expect(set.has("2026-01-01")).toBe(true);
    expect(toHolidaySet(set)).toBe(set);
  });
});

describe("営業日 (SPEC §8, §9)", () => {
  const none = new Set<string>();

  it("isBusinessDay: 土日と祝日は営業日でない", () => {
    expect(isBusinessDay("2026-10-26", none)).toBe(true); // 月
    expect(isBusinessDay("2026-10-24", none)).toBe(false); // 土
    expect(isBusinessDay("2026-10-25", none)).toBe(false); // 日
    expect(isBusinessDay("2026-10-26", new Set(["2026-10-26"]))).toBe(false);
  });

  it("businessDaysInMonth: 2026-10 は 22 営業日（土日 9 日）", () => {
    // 2026-10-01 は木曜。土日: 3,4,10,11,17,18,24,25,31 → 9 日。31 - 9 = 22
    expect(businessDaysInMonth("2026-10", none)).toBe(22);
  });

  it("businessDaysInMonth: 祝日を除く（平日の祝日のみ減る）", () => {
    // 2026-10-12（月）は祝日、2026-10-10（土）は祝日でも減らない
    expect(businessDaysInMonth("2026-10", new Set(["2026-10-12", "2026-10-10"]))).toBe(21);
  });

  it("businessDaysInMonth: うるう月 2028-02（29日、1日は火曜）は 21 営業日", () => {
    // 土日: 5,6,12,13,19,20,26,27 → 8 日。29 - 8 = 21
    expect(businessDaysInMonth("2028-02", none)).toBe(21);
  });

  it("nthBusinessDay: 1日が平日", () => {
    // 2026-10: 1(木),2(金),5(月)
    expect(nthBusinessDay("2026-10", 1, none)).toBe("2026-10-01");
    expect(nthBusinessDay("2026-10", 3, none)).toBe("2026-10-05");
  });

  it("nthBusinessDay: 1日が土曜（2026-08）", () => {
    // 2026-08-01 は土曜。3(月),4(火),5(水)
    expect(nthBusinessDay("2026-08", 1, none)).toBe("2026-08-03");
    expect(nthBusinessDay("2026-08", 3, none)).toBe("2026-08-05");
  });

  it("nthBusinessDay: 1日が祝日（2026-01-01 木）", () => {
    // 1(木)祝, 2(金), 3-4 土日, 5(月), 6(火)
    const holidays = new Set(["2026-01-01"]);
    expect(nthBusinessDay("2026-01", 1, holidays)).toBe("2026-01-02");
    expect(nthBusinessDay("2026-01", 3, holidays)).toBe("2026-01-06");
  });

  it("nthBusinessDay: 月の営業日数を超えると翌月に繰り越す", () => {
    expect(nthBusinessDay("2026-10", 23, none)).toBe("2026-11-02");
  });

  it("nthBusinessDay: n < 1 は例外", () => {
    expect(() => nthBusinessDay("2026-10", 0, none)).toThrow(RangeError);
  });

  it("closingDateOf: 翌月の第 N 営業日", () => {
    const config = { closingBusinessDay: 3 };
    expect(closingDateOf("2026-09", config, none)).toBe("2026-10-05");
    expect(closingDateOf("2026-07", config, none)).toBe("2026-08-05");
    expect(closingDateOf("2026-07", config, new Set(["2026-08-03"]))).toBe("2026-08-06");
    expect(closingDateOf("2026-12", { closingBusinessDay: 1 }, new Set(["2027-01-01"]))).toBe("2027-01-04"); // 1(金)祝, 2-3 土日, 4(月)
  });
});

describe("年度", () => {
  it("4月始まり: 3月→前年度、4月→当年度", () => {
    expect(fiscalYearOf("2026-03", 4)).toBe(2025);
    expect(fiscalYearOf("2026-04", 4)).toBe(2026);
    expect(fiscalYearOf("2026-12", 4)).toBe(2026);
    expect(fiscalYearOf("2027-01", 4)).toBe(2026);
    expect(fiscalYearOf("2027-03", 4)).toBe(2026);
    expect(fiscalYearOf("2027-04", 4)).toBe(2027);
  });

  it("1月始まり: 12月→当年、1月→翌年", () => {
    expect(fiscalYearOf("2026-12", 1)).toBe(2026);
    expect(fiscalYearOf("2027-01", 1)).toBe(2027);
  });

  it("fiscalYearMonths は 12 か月", () => {
    const months = fiscalYearMonths(2026, 4);
    expect(months).toHaveLength(12);
    expect(months[0]).toBe("2026-04");
    expect(months[11]).toBe("2027-03");
    expect(fiscalYearMonths(2026, 1)).toEqual([
      "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
      "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12",
    ]);
  });
});
