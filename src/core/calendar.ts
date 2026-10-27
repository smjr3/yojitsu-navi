/**
 * 年月・日付・営業日・年度のユーティリティ（SPEC §2, §8, §9）
 *
 * 年月は "YYYY-MM"、日付は "YYYY-MM-DD" の文字列。タイムゾーンに依存しないよう
 * 曜日計算は UTC で行い、Date オブジェクトは外に出さない。
 */
import type { Config, Holiday, ISODate, YearMonth } from "./types.js";

const YEAR_MONTH_RE = /^(\d{4})-(\d{2})$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---------------------------------------------------------------------------
// 年月
// ---------------------------------------------------------------------------

/** "YYYY-MM" 形式で、月が 01〜12 であること */
export function isValidYearMonth(value: unknown): value is YearMonth {
  if (typeof value !== "string") return false;
  const m = YEAR_MONTH_RE.exec(value);
  if (!m) return false;
  const month = Number(m[2]);
  return month >= 1 && month <= 12;
}

/** 年月を {year, month} に分解する。不正なら例外 */
export function parseYearMonth(ym: YearMonth): { year: number; month: number } {
  if (!isValidYearMonth(ym)) throw new RangeError(`年月の形式が不正です: ${String(ym)}`);
  return { year: Number(ym.slice(0, 4)), month: Number(ym.slice(5, 7)) };
}

/** {year, month} → "YYYY-MM" */
export function formatYearMonth(year: number, month: number): YearMonth {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/** 文字列比較で正しい（ゼロ埋め前提）。負=a<b, 0=同じ, 正=a>b */
export function compareYearMonth(a: YearMonth, b: YearMonth): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 年月に n か月を加える（負も可） */
export function addMonths(ym: YearMonth, n: number): YearMonth {
  const { year, month } = parseYearMonth(ym);
  const index = year * 12 + (month - 1) + n;
  return formatYearMonth(Math.floor(index / 12), (index % 12) + 1);
}

/** 年月の通し番号（year*12 + month-1）。差分計算用 */
function monthIndex(ym: YearMonth): number {
  const { year, month } = parseYearMonth(ym);
  return year * 12 + (month - 1);
}

/** from〜to を両端含む月数。from > to なら 0 */
export function monthsBetween(from: YearMonth, to: YearMonth): number {
  const diff = monthIndex(to) - monthIndex(from);
  return diff < 0 ? 0 : diff + 1;
}

/** from〜to を両端含む年月の配列。from > to なら空配列 */
export function monthRange(from: YearMonth, to: YearMonth): YearMonth[] {
  const count = monthsBetween(from, to);
  const result: YearMonth[] = [];
  for (let i = 0; i < count; i++) result.push(addMonths(from, i));
  return result;
}

/** 年月 m が from〜to（両端含む）に含まれるか */
export function isMonthInRange(m: YearMonth, from: YearMonth, to: YearMonth): boolean {
  return from <= m && m <= to;
}

// ---------------------------------------------------------------------------
// 日付
// ---------------------------------------------------------------------------

/** うるう年を考慮した月の日数 */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** "YYYY-MM-DD" 形式で、実在する日付であること（2027-02-29 は不可） */
export function isValidISODate(value: unknown): value is ISODate {
  if (typeof value !== "string") return false;
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

/** 日付の年月部分 */
export function monthOfDate(date: ISODate): YearMonth {
  if (!isValidISODate(date)) throw new RangeError(`日付の形式が不正です: ${String(date)}`);
  return date.slice(0, 7);
}

function formatISODate(year: number, month: number, day: number): ISODate {
  return `${formatYearMonth(year, month)}-${String(day).padStart(2, "0")}`;
}

/** 0=日曜 … 6=土曜 */
function dayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** 祝日の集合。Holiday[] または日付文字列の Set を受け付ける */
export type HolidayLookup = ReadonlySet<ISODate> | readonly Holiday[];

/** 祝日を Set に変換する（既に Set ならそのまま） */
export function toHolidaySet(holidays: HolidayLookup): ReadonlySet<ISODate> {
  if (holidays instanceof Set) return holidays;
  const set = new Set<ISODate>();
  for (const h of holidays as readonly Holiday[]) set.add(h.date);
  return set;
}

/** 営業日 = 土日でも祝日でもない日 */
export function isBusinessDay(date: ISODate, holidays: HolidayLookup): boolean {
  const { year, month } = parseYearMonth(date.slice(0, 7));
  const day = Number(date.slice(8, 10));
  const dow = dayOfWeek(year, month, day);
  if (dow === 0 || dow === 6) return false;
  return !toHolidaySet(holidays).has(date);
}

/** 月の営業日数（SPEC §9） */
export function businessDaysInMonth(ym: YearMonth, holidays: HolidayLookup): number {
  const { year, month } = parseYearMonth(ym);
  const set = toHolidaySet(holidays);
  const total = daysInMonth(year, month);
  let count = 0;
  for (let day = 1; day <= total; day++) {
    const dow = dayOfWeek(year, month, day);
    if (dow === 0 || dow === 6) continue;
    if (set.has(formatISODate(year, month, day))) continue;
    count++;
  }
  return count;
}

/**
 * 月の第 n 営業日の日付。n が月の営業日数を超える場合は翌月以降に繰り越して探す
 * （営業日が 0 の月でも必ず日付を返す）。n < 1 は例外。
 */
export function nthBusinessDay(ym: YearMonth, n: number, holidays: HolidayLookup): ISODate {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`営業日の序数が不正です: ${String(n)}`);
  const set = toHolidaySet(holidays);
  let { year, month } = parseYearMonth(ym);
  let remaining = n;
  // 上限は安全のため 10 年分
  for (let guard = 0; guard < 120; guard++) {
    const total = daysInMonth(year, month);
    for (let day = 1; day <= total; day++) {
      const dow = dayOfWeek(year, month, day);
      if (dow === 0 || dow === 6) continue;
      const date = formatISODate(year, month, day);
      if (set.has(date)) continue;
      remaining--;
      if (remaining === 0) return date;
    }
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  throw new RangeError(`第 ${n} 営業日が見つかりません: ${ym}`);
}

/** 月 m の確定日 = m の翌月の第 closingBusinessDay 営業日（SPEC §8） */
export function closingDateOf(
  ym: YearMonth,
  config: Pick<Config, "closingBusinessDay">,
  holidays: HolidayLookup,
): ISODate {
  return nthBusinessDay(addMonths(ym, 1), config.closingBusinessDay, holidays);
}

// ---------------------------------------------------------------------------
// 年度
// ---------------------------------------------------------------------------

/** 年月が属する年度（年度番号は開始年）。startMonth=4 なら 2026-03 → 2025 */
export function fiscalYearOf(ym: YearMonth, startMonth: number): number {
  const { year, month } = parseYearMonth(ym);
  return month >= startMonth ? year : year - 1;
}

/** 年度の 12 か月 */
export function fiscalYearMonths(fiscalYear: number, startMonth: number): YearMonth[] {
  return monthRange(formatYearMonth(fiscalYear, startMonth), addMonths(formatYearMonth(fiscalYear, startMonth), 11));
}
