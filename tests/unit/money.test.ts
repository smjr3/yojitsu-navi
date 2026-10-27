import { describe, expect, it } from "vitest";
import { EMPTY_VALUE, formatHours, formatPercent, formatPersonMonths, formatYen } from "../../src/core/money.js";

describe("表示 (SPEC §12)", () => {
  it("formatYen 円", () => {
    expect(formatYen(1_234_567)).toBe("1,234,567円");
    expect(formatYen(0)).toBe("0円");
    expect(formatYen(-30_000, "yen")).toBe("-30,000円");
    expect(formatYen(1.4)).toBe("1円");
  });

  it("formatYen 千円は Math.round(yen / 1000)", () => {
    expect(formatYen(1_234_567, "thousandYen")).toBe("1,235千円");
    expect(formatYen(1_234_499, "thousandYen")).toBe("1,234千円");
    expect(formatYen(500, "thousandYen")).toBe("1千円");
    expect(formatYen(499, "thousandYen")).toBe("0千円");
    expect(formatYen(-1_500, "thousandYen")).toBe("-1千円"); // Math.round(-1.5) = -1
  });

  it("formatPercent は小数 1 桁（既定）", () => {
    expect(formatPercent(1.034)).toBe("103.4%");
    expect(formatPercent(0.47375)).toBe("47.4%");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(-0.05)).toBe("-5.0%");
    expect(formatPercent(0.123456, 2)).toBe("12.35%");
    expect(formatPercent(1, 0)).toBe("100%");
  });

  it("formatHours / formatPersonMonths", () => {
    expect(formatHours(147.75)).toBe("147.75h");
    expect(formatHours(10)).toBe("10h");
    expect(formatHours(1234.5)).toBe("1,234.5h");
    expect(formatPersonMonths(0.9234375)).toBe("0.92人月");
    expect(formatPersonMonths(2)).toBe("2.00人月");
    expect(formatPersonMonths(1.2345, 1)).toBe("1.2人月");
  });

  it("null / undefined / NaN / Infinity は —", () => {
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(formatYen(v)).toBe(EMPTY_VALUE);
      expect(formatYen(v, "thousandYen")).toBe(EMPTY_VALUE);
      expect(formatPercent(v)).toBe(EMPTY_VALUE);
      expect(formatHours(v)).toBe(EMPTY_VALUE);
      expect(formatPersonMonths(v)).toBe(EMPTY_VALUE);
    }
    expect(EMPTY_VALUE).toBe("—");
  });
});
