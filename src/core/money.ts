/**
 * 金額・割合・時間の表示（SPEC §12）— ja-JP ロケール、null/NaN/Infinity は "—"
 */
import type { MoneyUnit } from "./types.js";

export const EMPTY_VALUE = "—";

const intFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });

function fractionFormat(digits: number): Intl.NumberFormat {
  return new Intl.NumberFormat("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function isDisplayable(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 表示単位に丸めた値（百万円は小数1桁、千円・円は整数） */
export function roundToUnit(yen: number, unit: MoneyUnit = "yen"): number {
  const v = unit === "millionYen" ? Math.round(yen / 100_000) / 10 : unit === "thousandYen" ? Math.round(yen / 1000) : Math.round(yen);
  return v === 0 ? 0 : v; // -0 を 0 にする（"-0.0百万円" と出さない）
}

/** 円の整数を "1,234,567円"、"1,235千円"（Math.round(yen/1000)）、"1.2百万円"（小数1桁）で表示 */
export function formatYen(yen: number | null | undefined, unit: MoneyUnit = "yen"): string {
  if (!isDisplayable(yen)) return EMPTY_VALUE;
  if (unit === "millionYen") return `${fractionFormat(1).format(roundToUnit(yen, unit))}百万円`;
  if (unit === "thousandYen") return `${intFormat.format(roundToUnit(yen, unit))}千円`;
  return `${intFormat.format(roundToUnit(yen, unit))}円`;
}

/** 割合（1.034 → "103.4%"）。既定は小数 1 桁 */
export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (!isDisplayable(ratio)) return EMPTY_VALUE;
  return `${fractionFormat(digits).format(ratio * 100)}%`;
}

/** 時間（12.5 → "12.5h"）。小数は最大 2 桁 */
export function formatHours(hours: number | null | undefined): string {
  if (!isDisplayable(hours)) return EMPTY_VALUE;
  return `${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 }).format(hours)}h`;
}

/** 人月（1.234 → "1.23人月"）。小数 2 桁 */
export function formatPersonMonths(personMonths: number | null | undefined, digits = 2): string {
  if (!isDisplayable(personMonths)) return EMPTY_VALUE;
  return `${fractionFormat(digits).format(personMonths)}人月`;
}
