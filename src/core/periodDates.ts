/**
 * 期間の開始日・終了日（SPEC §121）。アサイン・運用保守以外の予定の期間は月（start_month / end_month）で持ち、
 * 月の途中から・途中までのときだけ日付（任意の列 start_date / end_date）を足す。
 * 日付のある端の月は、その月の営業日（§9）のうち期間に入る日の割合だけ数える（日割り）。
 */
import { isBusinessDay, isValidISODate, isValidYearMonth, toHolidaySet, type HolidayLookup } from "./calendar.js";
import type { ISODate, YearMonth } from "./types.js";

/** 開始日・終了日を持てる期間 */
export interface DatedPeriod {
  startMonth: YearMonth;
  endMonth: YearMonth;
  /** 開始日（startMonth の月の中。省略 = 月の初めから） */
  startDate?: string;
  /** 終了日（endMonth の月の中。省略 = 月の終わりまで） */
  endDate?: string;
}

/** 月の初日 */
export function firstDayOf(month: YearMonth): ISODate {
  return `${month}-01`;
}

/** 月の末日 */
export function lastDayOf(month: YearMonth): ISODate {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(d).padStart(2, "0")}`;
}

/** 使える開始日（形式が正しく startMonth の月の中で、月の初日でない）。無ければ null */
export function startDateOf(p: Pick<DatedPeriod, "startMonth" | "startDate">): ISODate | null {
  const d = (p.startDate ?? "").trim();
  if (!isValidISODate(d) || d.slice(0, 7) !== p.startMonth || d === firstDayOf(p.startMonth)) return null;
  return d;
}

/** 使える終了日（形式が正しく endMonth の月の中で、月の末日でない）。無ければ null */
export function endDateOf(p: Pick<DatedPeriod, "endMonth" | "endDate">): ISODate | null {
  const d = (p.endDate ?? "").trim();
  if (!isValidISODate(d) || d.slice(0, 7) !== p.endMonth || d === lastDayOf(p.endMonth)) return null;
  return d;
}

/** 書いてある日付の誤り: 形式違い・月の外（"start" / "end"）、開始日が終了日より後（"inverted"） */
export function periodDateErrors(p: DatedPeriod): Array<"start" | "end" | "inverted"> {
  const out: Array<"start" | "end" | "inverted"> = [];
  const s = (p.startDate ?? "").trim();
  const e = (p.endDate ?? "").trim();
  if (s !== "" && (!isValidISODate(s) || s.slice(0, 7) !== p.startMonth)) out.push("start");
  if (e !== "" && (!isValidISODate(e) || e.slice(0, 7) !== p.endMonth)) out.push("end");
  if (out.length === 0 && isValidYearMonth(p.startMonth) && isValidYearMonth(p.endMonth)) {
    const from = startDateOf(p) ?? firstDayOf(p.startMonth);
    const to = endDateOf(p) ?? lastDayOf(p.endMonth);
    if (from > to) out.push("inverted");
  }
  return out;
}

/** 期間の最初の日・最後の日（画面の日付の欄に出す値。日付が無ければ月の初日・末日） */
export function periodBounds(p: DatedPeriod): { from: ISODate; to: ISODate } {
  return { from: startDateOf(p) ?? firstDayOf(p.startMonth), to: endDateOf(p) ?? lastDayOf(p.endMonth) };
}

/**
 * 画面の日付（YYYY-MM-DD か YYYY-MM）→ CSV の列の値。月だけ・月の初日（開始）・末日（終了）なら日付の列は空。
 * 形式が違えば null
 */
export function splitPeriodDate(value: string, side: "start" | "end"): { month: YearMonth; date: string } | null {
  const v: string = value.trim();
  if (/^\d{4}-\d{2}$/.test(v)) return isValidYearMonth(v) ? { month: v, date: "" } : null;
  if (!isValidISODate(v)) return null;
  const month = v.slice(0, 7);
  const edge = side === "start" ? firstDayOf(month) : lastDayOf(month);
  return { month, date: v === edge ? "" : v };
}

/** 月の営業日（営業日の無い月は暦日）。祝日の集合ごとにキャッシュ */
const poolCache = new WeakMap<object, Map<YearMonth, ISODate[]>>();
const EMPTY_KEY = {};
function poolOf(month: YearMonth, holidays: HolidayLookup): ISODate[] {
  const key = (holidays as object) ?? EMPTY_KEY;
  let byMonth = poolCache.get(key);
  if (!byMonth) poolCache.set(key, (byMonth = new Map()));
  let pool = byMonth.get(month);
  if (!pool) {
    const set = toHolidaySet(holidays);
    const last = Number(lastDayOf(month).slice(8, 10));
    const days = Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
    const biz = days.filter((d) => isBusinessDay(d, set));
    pool = biz.length > 0 ? biz : days;
    byMonth.set(month, pool);
  }
  return pool;
}

/** 日付のある端の月の、期間に入る営業日（日付の無い月・期間外の月は null） */
export function periodPresenceAt(p: DatedPeriod, month: YearMonth, holidays: HolidayLookup): { present: number; total: number } | null {
  if (!isValidYearMonth(month) || month < p.startMonth || month > p.endMonth) return null;
  const s = month === p.startMonth ? startDateOf(p) : null;
  const e = month === p.endMonth ? endDateOf(p) : null;
  if (!s && !e) return null;
  const pool = poolOf(month, holidays);
  const present = pool.filter((d) => (!s || d >= s) && (!e || d <= e)).length;
  return { present, total: pool.length };
}

/** 月 month に数える割合（期間外 0、日付のある端の月は営業日の割合、それ以外 1） */
export function periodShareAt(p: DatedPeriod, month: YearMonth, holidays: HolidayLookup): number {
  if (!isValidYearMonth(month) || month < p.startMonth || month > p.endMonth) return 0;
  const pr = periodPresenceAt(p, month, holidays);
  return pr ? (pr.total > 0 ? pr.present / pr.total : 0) : 1;
}
