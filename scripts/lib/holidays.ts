/**
 * 日本の祝日（国民の祝日に関する法律に基づく）を計算で求める。
 *
 * 対応: 固定日の祝日、ハッピーマンデー、春分・秋分（簡易式）、振替休日、国民の休日。
 * 2000〜2099 年を想定。天体計算の簡易式は 2000〜2099 年で官報と一致することが知られている。
 */

export interface HolidayRow {
  date: string;
  name: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function ymd(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** UTC で日付を扱う（タイムゾーンの影響を受けない） */
function dateOf(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

function toYmd(dt: Date): string {
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function addDays(dt: Date, n: number): Date {
  return new Date(dt.getTime() + n * 86400000);
}

/** 第 n 月曜日の日 */
function nthMonday(y: number, m: number, n: number): number {
  const first = dateOf(y, m, 1).getUTCDay(); // 0=日
  const firstMonday = first <= 1 ? 1 + (1 - first) : 1 + (8 - first);
  return firstMonday + (n - 1) * 7;
}

/** 春分の日（2000〜2099 年の簡易式） */
function vernalEquinoxDay(y: number): number {
  return Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
}

/** 秋分の日（2000〜2099 年の簡易式） */
function autumnalEquinoxDay(y: number): number {
  return Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
}

/** 1年分の国民の祝日（振替休日・国民の休日を含む）。日付昇順 */
export function nationalHolidays(y: number): HolidayRow[] {
  const base: HolidayRow[] = [
    { date: ymd(y, 1, 1), name: "元日" },
    { date: ymd(y, 1, nthMonday(y, 1, 2)), name: "成人の日" },
    { date: ymd(y, 2, 11), name: "建国記念の日" },
    { date: ymd(y, 2, 23), name: "天皇誕生日" },
    { date: ymd(y, 3, vernalEquinoxDay(y)), name: "春分の日" },
    { date: ymd(y, 4, 29), name: "昭和の日" },
    { date: ymd(y, 5, 3), name: "憲法記念日" },
    { date: ymd(y, 5, 4), name: "みどりの日" },
    { date: ymd(y, 5, 5), name: "こどもの日" },
    { date: ymd(y, 7, nthMonday(y, 7, 3)), name: "海の日" },
    { date: ymd(y, 8, 11), name: "山の日" },
    { date: ymd(y, 9, nthMonday(y, 9, 3)), name: "敬老の日" },
    { date: ymd(y, 9, autumnalEquinoxDay(y)), name: "秋分の日" },
    { date: ymd(y, 10, nthMonday(y, 10, 2)), name: "スポーツの日" },
    { date: ymd(y, 11, 3), name: "文化の日" },
    { date: ymd(y, 11, 23), name: "勤労感謝の日" },
  ];
  const map = new Map<string, string>(base.map((h) => [h.date, h.name]));

  // 振替休日: 祝日が日曜なら、その後の最初の「祝日でない日」が休日
  for (const h of base) {
    const [yy, mm, dd] = h.date.split("-").map(Number) as [number, number, number];
    const dt = dateOf(yy, mm, dd);
    if (dt.getUTCDay() !== 0) continue;
    let next = addDays(dt, 1);
    while (map.has(toYmd(next))) next = addDays(next, 1);
    map.set(toYmd(next), "振替休日");
  }

  // 国民の休日: 前日と翌日が祝日である平日（敬老の日と秋分の日に挟まれる日など）
  for (const h of base) {
    const [yy, mm, dd] = h.date.split("-").map(Number) as [number, number, number];
    const dt = dateOf(yy, mm, dd);
    const mid = addDays(dt, 1);
    const after = addDays(dt, 2);
    const midKey = toYmd(mid);
    if (!map.has(midKey) && map.has(toYmd(after)) && mid.getUTCDay() !== 0) {
      map.set(midKey, "国民の休日");
    }
  }

  return [...map.entries()].map(([date, name]) => ({ date, name })).sort((a, b) => a.date.localeCompare(b.date));
}

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
