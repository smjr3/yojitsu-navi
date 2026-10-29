/**
 * 祝日・会社休日（ダミーデータの holidays.csv 用）。国民の祝日の計算は計算コア（src/core/holidays.ts）にある。
 */
import { nationalHolidays, ymd, type HolidayRow } from "../../src/core/holidays.js";

export { nationalHolidays, ymd, type HolidayRow };

/** 会社休日（年末年始 12/29〜1/3、夏季 8/13〜8/15）。国民の祝日と重なる日は祝日名を優先 */
export function companyHolidays(y: number): HolidayRow[] {
  const rows: HolidayRow[] = [];
  for (const d of [1, 2, 3]) rows.push({ date: ymd(y, 1, d), name: "年末年始休暇" });
  for (const d of [13, 14, 15]) rows.push({ date: ymd(y, 8, d), name: "夏季休暇" });
  for (const d of [29, 30, 31]) rows.push({ date: ymd(y, 12, d), name: "年末年始休暇" });
  return rows;
}

/** 指定年範囲の祝日＋会社休日。日付でユニーク、昇順 */
export function allHolidays(fromYear: number, toYear: number): HolidayRow[] {
  const map = new Map<string, string>();
  for (let y = fromYear; y <= toYear; y++) {
    for (const h of companyHolidays(y)) map.set(h.date, h.name);
    for (const h of nationalHolidays(y)) map.set(h.date, h.name); // 祝日名を優先
  }
  return [...map.entries()].map(([date, name]) => ({ date, name })).sort((a, b) => a.date.localeCompare(b.date));
}
