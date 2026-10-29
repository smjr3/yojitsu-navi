/**
 * 日本の国民の祝日（国民の祝日に関する法律に基づく）を計算で求める。
 *
 * 対応: 固定日の祝日、ハッピーマンデー、春分・秋分（簡易式）、振替休日、国民の休日。
 * 2000〜2099 年を想定。天体計算の簡易式は 2000〜2099 年で官報と一致することが知られている。
 *
 * holidays.csv に行がある運用で、ある年の行が 1 つも無いときは、その年をこの計算で補う
 * （年度が替わって祝日表を足し忘れても、締め日・営業日が土日だけで数えられないように）。
 * holidays.csv が空なら「祝日なし」の指定として補わない。SPEC §48
 */
import type { Holiday, ISODate } from "./types.js";

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

/** 計算で補える年の範囲（春分・秋分の簡易式が正しい範囲） */
const AUTO_FROM_YEAR = 2000;
const AUTO_TO_YEAR = 2099;

/**
 * 祝日の集合。holidays.csv の日付に加え、csv に 1 行も無い年は引かれた時点で国民の祝日を足す（csv が空なら足さない）。
 * 足した年は filledYears に残る（データ確認の警告に使う）。
 */
export class HolidaySet extends Set<ISODate> {
  /** 国民の祝日で補った年（昇順に並べて使う） */
  readonly filledYears = new Set<number>();
  private readonly csvYears = new Set<number>();
  private readonly seenYears = new Set<number>();

  constructor(rows: readonly Holiday[]) {
    super(rows.map((h) => h.date));
    for (const h of rows) {
      const y = Number(h.date.slice(0, 4));
      if (Number.isInteger(y)) this.csvYears.add(y);
    }
  }

  override has(date: ISODate): boolean {
    const y = Number(date.slice(0, 4));
    if (!this.seenYears.has(y)) {
      this.seenYears.add(y);
      if (this.csvYears.size > 0 && !this.csvYears.has(y) && Number.isInteger(y) && y >= AUTO_FROM_YEAR && y <= AUTO_TO_YEAR) {
        for (const h of nationalHolidays(y)) this.add(h.date);
        this.filledYears.add(y);
      }
    }
    return super.has(date);
  }
}
