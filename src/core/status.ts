/**
 * 月の状態（確定・速報・未来）（SPEC §8）
 */
import { addMonths, closingDateOf, monthOfDate, todayJst, type HolidayLookup } from "./calendar.js";
import type { Config, ISODate, MonthStatus, YearMonth } from "./types.js";

export interface StatusContext {
  asOf: ISODate;
  config: Pick<Config, "closingBusinessDay">;
  holidays: HolidayLookup;
  /**
   * 作業実績を最後に取り込んだ日（日本時間）。確定日より前に取り込んだきりの月は、今日が確定日を過ぎても速報のまま（§8）。
   * 省略・null なら今日（asOf）だけで決める
   */
  dataThrough?: ISODate | null;
}

/** 作業実績の取得日時（ISO 8601）→ 日本時間の日付。読めなければ null */
export function dataThroughOf(worklogFetchedAt: string | null | undefined): ISODate | null {
  if (!worklogFetchedAt) return null;
  const at = new Date(worklogFetchedAt);
  return Number.isNaN(at.getTime()) ? null : todayJst(at);
}

/**
 * 月 m の状態。
 * - m > asOf月 → future
 * - m == asOf月 → preliminary
 * - m < asOf月 かつ asOf < 確定日(m) → preliminary
 * - m < asOf月 かつ 取り込んだ日 < 確定日(m) → preliminary（取り込みが止まって月の分を取りきれていない）
 * - それ以外 → final
 */
export function monthStatus(month: YearMonth, ctx: StatusContext): MonthStatus {
  const asOfMonth = monthOfDate(ctx.asOf);
  if (month > asOfMonth) return "future";
  if (month === asOfMonth) return "preliminary";
  const closing = closingDateOf(month, ctx.config, ctx.holidays);
  const through = ctx.dataThrough && ctx.dataThrough < ctx.asOf ? ctx.dataThrough : ctx.asOf;
  return through < closing ? "preliminary" : "final";
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
