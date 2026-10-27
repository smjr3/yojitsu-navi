/**
 * 月の状態（確定・速報・未来）（SPEC §8）
 */
import { addMonths, closingDateOf, monthOfDate, type HolidayLookup } from "./calendar.js";
import type { Config, ISODate, MonthStatus, YearMonth } from "./types.js";

export interface StatusContext {
  asOf: ISODate;
  config: Pick<Config, "closingBusinessDay">;
  holidays: HolidayLookup;
}

/**
 * 月 m の状態。
 * - m > asOf月 → future
 * - m == asOf月 → preliminary
 * - m < asOf月 かつ asOf < 確定日(m) → preliminary
 * - それ以外 → final
 */
export function monthStatus(month: YearMonth, ctx: StatusContext): MonthStatus {
  const asOfMonth = monthOfDate(ctx.asOf);
  if (month > asOfMonth) return "future";
  if (month === asOfMonth) return "preliminary";
  const closing = closingDateOf(month, ctx.config, ctx.holidays);
  return ctx.asOf < closing ? "preliminary" : "final";
}

/**
 * 確定済みの最新月 = 状態が final の最大月。通常は asOf が前月分の確定日以降なら前月、そうでなければ前々月。
 * 確定日は翌月の営業日が足りないと翌々月以降に繰り越す（nthBusinessDay）ので、前々月も未確定なら更に遡る。
 * 確定日は月に対して単調（m1 < m2 なら closing(m1) < closing(m2)）なので、最初に final になった月が最大の final 月。
 */
export function lastFinalMonth(ctx: StatusContext): YearMonth {
  const asOfMonth = monthOfDate(ctx.asOf);
  let month = addMonths(asOfMonth, -1);
  // 上限は安全のため 10 年分（nthBusinessDay の繰り越し上限と同じ）
  for (let guard = 0; guard < 120; guard++) {
    if (monthStatus(month, ctx) === "final") return month;
    month = addMonths(month, -1);
  }
  return month;
}

/**
 * Model（祝日を持たない）だけから状態を引く。
 * meta.lastFinalMonth 以下は final、asOf 月以下は preliminary、それより先は future。
 */
export function monthStatusFromMeta(month: YearMonth, meta: { asOfMonth: YearMonth; lastFinalMonth: YearMonth }): MonthStatus {
  if (month > meta.asOfMonth) return "future";
  if (month <= meta.lastFinalMonth) return "final";
  return "preliminary";
}
