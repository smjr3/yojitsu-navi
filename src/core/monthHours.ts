/**
 * 月の稼働時間（1.0 人月の時間）= その月の営業日数 × 1 日の時間（SPEC §9・§114）。
 * リソース計画の人月を時間・金額に直すとき（計画の時間・計画額・計画方式の着地見込み）と、時間で入れた計画を人月に直すときに使う。
 * 営業日は土日と祝日（holidays.csv。行の無い年は国民の祝日で補う。§49）を除いた日。
 */
import { businessDaysInMonth, type HolidayLookup } from "./calendar.js";
import { HolidaySet } from "./holidays.js";
import type { Holiday, YearMonth } from "./types.js";

export type MonthHours = (month: YearMonth) => number;

/** 月 → 稼働時間 の関数（月ごとにキャッシュ）。祝日は Holiday[]（csv の行）か、作成済みの集合 */
export function createMonthHours(holidays: readonly Holiday[] | HolidayLookup, hoursPerBusinessDay: number): MonthHours {
  const set: HolidayLookup = Array.isArray(holidays) ? new HolidaySet(holidays as readonly Holiday[]) : holidays;
  const cache = new Map<YearMonth, number>();
  const perDay = Number.isFinite(hoursPerBusinessDay) && hoursPerBusinessDay > 0 ? hoursPerBusinessDay : 0;
  return (month) => {
    let h = cache.get(month);
    if (h === undefined) {
      h = businessDaysInMonth(month, set) * perDay;
      cache.set(month, h);
    }
    return h;
  };
}
