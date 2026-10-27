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
 * 確定済みの最新月。asOf が前月分の確定日以降なら前月、そうでなければ前々月。
 * （前々月の確定日は前月中にあるので必ず確定している）
 */
export function lastFinalMonth(ctx: StatusContext): YearMonth {
  const asOfMonth = monthOfDate(ctx.asOf);
  const prev = addMonths(asOfMonth, -1);
  return monthStatus(prev, ctx) === "final" ? prev : addMonths(asOfMonth, -2);
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
