/**
 * 金額・割合・時間の表示（SPEC §12）— ja-JP ロケール、null/NaN/Infinity は "—"
 */
import type { MoneyUnit } from "./types.js";
import { T, fmt } from "../i18n/index.js";

export const EMPTY_VALUE = "—";

const intFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });

// 書式は作るのが重いので桁数ごとに 1 回だけ作って使い回す（表の 1 マスごとに呼ばれる。SPEC §107）
const fractionFormats = new Map<number, Intl.NumberFormat>();
function fractionFormat(digits: number): Intl.NumberFormat {
  let f = fractionFormats.get(digits);
  if (!f) {
    f = new Intl.NumberFormat("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    fractionFormats.set(digits, f);
  }
  return f;
}

/** 小数を最大 digits 桁で出す書式（使い回す） */
const maxFractionFormats = new Map<number, Intl.NumberFormat>();
export function maxFractionFormat(digits: number): Intl.NumberFormat {
  let f = maxFractionFormats.get(digits);
  if (!f) {
    f = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: digits });
    maxFractionFormats.set(digits, f);
  }
  return f;
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
  if (unit === "millionYen") return fmt(T.numbers.millionYen, { value: fractionFormat(1).format(roundToUnit(yen, unit)) });
  if (unit === "thousandYen") return fmt(T.numbers.thousandYen, { value: intFormat.format(roundToUnit(yen, unit)) });
  return fmt(T.numbers.yen, { value: intFormat.format(roundToUnit(yen, unit)) });
}

/** 割合（1.034 → "103.4%"）。既定は小数 1 桁 */
export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (!isDisplayable(ratio)) return EMPTY_VALUE;
  return `${fractionFormat(digits).format(ratio * 100)}%`;
}

/** 時間（12.5 → "12.5h"）。小数は最大 2 桁 */
export function formatHours(hours: number | null | undefined): string {
  if (!isDisplayable(hours)) return EMPTY_VALUE;
  return `${maxFractionFormat(2).format(hours)}h`;
}

/** 人月（1.234 → "1.23人月"）。小数 2 桁 */
export function formatPersonMonths(personMonths: number | null | undefined, digits = 2): string {
  if (!isDisplayable(personMonths)) return EMPTY_VALUE;
  return fmt(T.numbers.personMonths, { value: fractionFormat(digits).format(personMonths) });
}
