/**
 * グラフの単位の切り替え（SPEC §130）: 月ごとの値を 日・週・四半期・年度 にまとめ直す。
 *
 * - 四半期・年度: 月の値を足すだけ（年度の開始月から 3 か月ずつ・12 か月ずつ）
 * - 日・週: 実績（金額・時間）は作業実績の日ごとの値を、その月の実績に合うように割り振る（data/daily-history.json）。
 *   予算・見込み・計画は月の値を、その月の営業日（営業日の無い月は暦日。§118・§123 と同じ）に均等に配る。
 *   週は月曜始まり。期間の端の週は期間の中の日だけ数える
 * - どの単位でも、まとめた値を足せば月の値と同じになる（月の合計は変えない）
 */
import { addMonths, fiscalYearOf, isBusinessDay, monthOfDate, monthRange, parseYearMonth, type HolidayLookup } from "./calendar.js";
import { HolidaySet } from "./holidays.js";
import { firstDayOf, lastDayOf } from "./periodDates.js";
import { utilizationOf } from "./members.js";
import { endDateOf, startDateOf } from "./periodDates.js";
import type { Assignment, Holiday, ISODate, Model, MonthStatus, OutsidePlan, YearMonth } from "./types.js";

export type ChartUnit = "day" | "week" | "month" | "quarter" | "year";
export const CHART_UNITS: readonly ChartUnit[] = ["day", "week", "month", "quarter", "year"];

/** 日の単位で出す期間（月数）。棒が細かくなりすぎないよう、終わりの月から数えてこの月数だけ出す */
export const DAY_UNIT_MONTHS = 3;

// ---------------------------------------------------------------------------
// 暦
// ---------------------------------------------------------------------------

function toUtc(date: ISODate): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}

function fromUtc(t: number): ISODate {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function addDays(date: ISODate, n: number): ISODate {
  return fromUtc(toUtc(date) + n * 86400000);
}

/** その日を含む週の月曜日 */
export function weekStartOf(date: ISODate): ISODate {
  const dow = new Date(toUtc(date)).getUTCDay(); // 0 = 日
  return addDays(date, -((dow + 6) % 7));
}

/** from〜to（両端含む）の日付 */
export function datesBetween(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let t = toUtc(from), end = toUtc(to); t <= end; t += 86400000) out.push(fromUtc(t));
  return out;
}

/** 年度の四半期（1〜4）。startMonth は年度の開始月 */
export function fiscalQuarterOf(month: YearMonth, startMonth: number): { fiscalYear: number; quarter: number } {
  const { month: m } = parseYearMonth(month);
  const offset = (m - startMonth + 12) % 12;
  return { fiscalYear: fiscalYearOf(month, startMonth), quarter: Math.floor(offset / 3) + 1 };
}

/** 祝日の集合（行の無い年は国民の祝日で補う。buildModel と同じ HolidaySet。配列ごとに 1 回だけ作る） */
const setCache = new WeakMap<object, ReadonlySet<ISODate>>();
function holidaySetOf(holidays: HolidayLookup): ReadonlySet<ISODate> {
  if (holidays instanceof Set) return holidays;
  let set = setCache.get(holidays);
  if (!set) setCache.set(holidays, (set = new HolidaySet(holidays as readonly Holiday[])));
  return set;
}

/** 月の値を配る日（営業日。営業日の無い月は暦日）。periodDates の日割りと同じ考え方 */
const poolCache = new WeakMap<object, Map<YearMonth, ISODate[]>>();
export function monthDayPool(month: YearMonth, holidays: HolidayLookup): ISODate[] {
  const set = holidaySetOf(holidays);
  let byMonth = poolCache.get(set);
  if (!byMonth) poolCache.set(set, (byMonth = new Map()));
  let pool = byMonth.get(month);
  if (!pool) {
    const days = datesBetween(firstDayOf(month), lastDayOf(month));
    const biz = days.filter((d) => isBusinessDay(d, set));
    pool = biz.length > 0 ? biz : days;
    byMonth.set(month, pool);
  }
  return pool;
}

/** 日の単位で出す期間: 期間の終わり（今月より後なら今月）から DAY_UNIT_MONTHS か月。期間の始まりより前には出ない */
export function dayUnitRange(period: { from: YearMonth; to: YearMonth }, asOfMonth: YearMonth): { from: YearMonth; to: YearMonth } {
  let to = period.to < asOfMonth ? period.to : asOfMonth;
  if (to < period.from) to = period.to < addMonths(period.from, DAY_UNIT_MONTHS - 1) ? period.to : addMonths(period.from, DAY_UNIT_MONTHS - 1);
  const start = addMonths(to, -(DAY_UNIT_MONTHS - 1));
  return { from: start < period.from ? period.from : start, to };
}

// ---------------------------------------------------------------------------
// 日ごとの実績（data/daily-history.json）
// ---------------------------------------------------------------------------

/** data/daily-history.json。contracts[contractId][YYYY-MM] = [日, 実績額（円・小数）, 時間][]（作業実績のある日だけ） */
export interface DailyHistoryFile {
  asOf: ISODate;
  /** 作業ログがある最後の日（asOf を超えない） */
  lastDate: ISODate | null;
  contracts: Record<string, Record<YearMonth, Array<[number, number, number]>>>;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Model（作業ログ明細つき）から案件・月・日ごとの実績を詰める。asOf より後の日は入れない */
export function encodeDailyHistory(model: Model): DailyHistoryFile {
  const asOf = model.meta.asOf;
  const contracts: DailyHistoryFile["contracts"] = {};
  let lastDate: ISODate | null = null;
  for (const c of model.contracts) {
    const byMonth: Record<YearMonth, Array<[number, number, number]>> = {};
    for (const cm of c.months) {
      if (cm.worklogs.length === 0) continue;
      const byDay = new Map<number, [number, number, number]>();
      for (const w of cm.worklogs) {
        if (w.date.slice(0, 7) !== cm.month || w.date > asOf) continue;
        if (lastDate === null || w.date > lastDate) lastDate = w.date;
        const d = Number(w.date.slice(8, 10));
        const acc = byDay.get(d) ?? [d, 0, 0];
        acc[1] += w.hours * w.hourlyRate;
        acc[2] += w.hours;
        byDay.set(d, acc);
      }
      if (byDay.size > 0) byMonth[cm.month] = [...byDay.values()].sort((a, b) => a[0] - b[0]).map(([d, a, h]) => [d, r2(a), r2(h)]);
    }
    if (Object.keys(byMonth).length > 0) contracts[c.contract.contractId] = byMonth;
  }
  return { asOf, lastDate, contracts };
}

/**
 * 月の合計 total を日に割り振る。weights（日 → 重み）があれば重みの割合、無ければ fallback の日に均等。
 * 足せば total と同じになる（重みの合計が 0 なら fallback）
 */
export function spreadMonth(total: number, month: YearMonth, weights: ReadonlyArray<readonly [number, number]> | null, fallback: readonly ISODate[], add: (date: ISODate, v: number) => void): void {
  if (total === 0) return;
  let sum = 0;
  if (weights) for (const [, w] of weights) sum += w;
  if (weights && sum > 0) {
    for (const [d, w] of weights) if (w !== 0) add(`${month}-${String(d).padStart(2, "0")}`, (total * w) / sum);
    return;
  }
  if (fallback.length === 0) return;
  const each = total / fallback.length;
  for (const d of fallback) add(d, each);
}

/**
 * 対象の案件の日ごとの実績（金額・時間）。各案件・月の実績（ContractMonth.cost / hours）を作業実績の日ごとの割合で配る。
 * 日ごとの値が無い月（作業実績以外の原価だけなど）は、その月の営業日のうち asOf までの日に均等に配る
 */
export function contractDailyActuals(
  model: Pick<Model, "contracts" | "holidays" | "meta">,
  history: DailyHistoryFile | null,
  contractIds: readonly string[] | undefined,
  months: { from: YearMonth; to: YearMonth },
): Map<ISODate, { cost: number; hours: number }> {
  const ids = contractIds ? new Set(contractIds) : null;
  const asOf = model.meta.asOf;
  const out = new Map<ISODate, { cost: number; hours: number }>();
  const at = (d: ISODate) => {
    let v = out.get(d);
    if (!v) out.set(d, (v = { cost: 0, hours: 0 }));
    return v;
  };
  for (const r of model.contracts) {
    const id = r.contract.contractId;
    if (ids && !ids.has(id)) continue;
    const hist = history?.contracts[id];
    for (const cm of r.months) {
      if (cm.month < months.from || cm.month > months.to) continue;
      if (cm.cost === 0 && cm.hours === 0) continue;
      const rows = hist?.[cm.month] ?? null;
      const pool = monthDayPool(cm.month, model.holidays);
      const passed = pool.filter((d) => d <= asOf);
      const fallback = passed.length > 0 ? passed : pool;
      spreadMonth(cm.cost, cm.month, rows ? rows.map(([d, a]) => [d, a] as const) : null, fallback, (d, v) => (at(d).cost += v));
      spreadMonth(cm.hours, cm.month, rows ? rows.map(([d, , h]) => [d, h] as const) : null, fallback, (d, v) => (at(d).hours += v));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 月次推移（予算・実績・見込み・目標の上限）
// ---------------------------------------------------------------------------

/** analysis.seriesWithForecast（＋ withTargets）の 1 か月分のうち、まとめ直しに使う値 */
export interface SeriesMonth {
  month: YearMonth;
  status: MonthStatus;
  budget: number;
  cost: number;
  hours: number;
  isActual: boolean;
  forecastCost: number | null;
  targetCap?: number;
  targetRate?: number;
}

/** まとめた 1 本の棒 */
export interface SeriesBucket {
  key: string;
  unit: ChartUnit;
  /** 期間の最初の日・最後の日（期間の端で切れた分は切れたところまで） */
  from: ISODate;
  to: ISODate;
  /** 含む月 */
  months: YearMonth[];
  /** 含む月の状態がそろっていればその状態、混ざっていれば null */
  status: MonthStatus | null;
  budget: number;
  /** 実績（実績の月は実績、それ以外は今日までの実績） */
  cost: number;
  hours: number;
  /** すべて実績の月・日 */
  isActual: boolean;
  /** 実績と見込みが混ざる（今日を含む・見込みの月を含む）。速報・途中までの実績を斜線で出す */
  partial: boolean;
  /** 見込みを含むときの着地（実績の分 ＋ 見込みの分）。すべて実績なら null */
  forecastCost: number | null;
  grossProfit: number;
  forecastGrossProfit: number | null;
  /** 目標の上限（含むすべての月に目標があるときだけ） */
  targetCap?: number;
  /** 含む月の目標の残予算率がそろっていればその率 */
  targetRate?: number;
  /** 日の単位: 営業日か */
  businessDay?: boolean;
}

interface Acc {
  key: string;
  from: ISODate;
  to: ISODate;
  months: Set<YearMonth>;
  statuses: Set<MonthStatus>;
  budget: number;
  cost: number;
  hours: number;
  allActual: boolean;
  anyForecast: boolean;
  forecastPart: number;
  targetCap: number;
  targetAll: boolean;
  rates: Set<number>;
  businessDay?: boolean;
}

function finish(a: Acc, unit: ChartUnit): SeriesBucket {
  const forecastCost = a.allActual ? null : a.cost + a.forecastPart;
  const out: SeriesBucket = {
    key: a.key,
    unit,
    from: a.from,
    to: a.to,
    months: [...a.months].sort(),
    status: a.statuses.size === 1 ? [...a.statuses][0]! : null,
    budget: a.budget,
    cost: a.cost,
    hours: a.hours,
    isActual: a.allActual,
    partial: !a.allActual && a.cost !== 0,
    forecastCost,
    grossProfit: a.budget - a.cost,
    forecastGrossProfit: forecastCost === null ? null : a.budget - forecastCost,
  };
  if (a.targetAll && a.months.size > 0) {
    out.targetCap = a.targetCap;
    if (a.rates.size === 1) out.targetRate = [...a.rates][0]!;
  }
  if (a.businessDay !== undefined) out.businessDay = a.businessDay;
  return out;
}

function newAcc(key: string, from: ISODate, to: ISODate): Acc {
  return { key, from, to, months: new Set(), statuses: new Set(), budget: 0, cost: 0, hours: 0, allActual: true, anyForecast: false, forecastPart: 0, targetCap: 0, targetAll: true, rates: new Set() };
}

/**
 * 四半期・年度にまとめる（月の値を足す）。見込みの月の forecastCost は「その月の着地（今日までの実績を含む）」なので、
 * まとめた着地 = 実績の月の実績 ＋ 見込みの月の着地。今日までの実績（cost）は全部の月の実績の合計
 */
export function bucketMonths(series: readonly SeriesMonth[], unit: "quarter" | "year", startMonth: number): SeriesBucket[] {
  const accs = new Map<string, Acc>();
  for (const d of series) {
    const q = fiscalQuarterOf(d.month, startMonth);
    const key = unit === "year" ? `${q.fiscalYear}` : `${q.fiscalYear}-Q${q.quarter}`;
    let a = accs.get(key);
    if (!a) accs.set(key, (a = newAcc(key, firstDayOf(d.month), lastDayOf(d.month))));
    a.to = lastDayOf(d.month);
    a.months.add(d.month);
    a.statuses.add(d.status);
    a.budget += d.budget;
    a.cost += d.cost;
    a.hours += d.hours;
    if (!d.isActual) {
      a.allActual = false;
      a.anyForecast = true;
      // 見込みの月の着地のうち、今日までの実績（cost）を除いた分
      a.forecastPart += (d.forecastCost ?? 0) - d.cost;
    }
    if (d.targetCap == null) a.targetAll = false;
    else {
      a.targetCap += d.targetCap;
      if (d.targetRate != null) a.rates.add(d.targetRate);
    }
  }
  return [...accs.values()].map((a) => finish(a, unit));
}

/**
 * 日・週にまとめる。予算・見込み・目標の上限は月の値をその月の営業日に配り、実績は actuals（contractDailyActuals）を使う。
 * 今月の見込みは「月の着地 − 今日までの実績」を今日より後の営業日に配る（無ければ月末に寄せる。負なら今日に置く）。
 * range は出す月（両端含む）。asOf は今日（閲覧者の日本時間。§75）
 */
export function bucketDays(
  series: readonly SeriesMonth[],
  actuals: ReadonlyMap<ISODate, { cost: number; hours: number }>,
  { unit, range, asOf, holidays }: { unit: "day" | "week"; range: { from: YearMonth; to: YearMonth }; asOf: ISODate; holidays: HolidayLookup },
): SeriesBucket[] {
  const byMonth = new Map(series.map((d) => [d.month, d]));
  const set = holidaySetOf(holidays);
  const asOfMonth = monthOfDate(asOf);
  const accs = new Map<string, Acc>();
  const order: Acc[] = [];
  for (const month of monthRange(range.from, range.to)) {
    const d = byMonth.get(month);
    if (!d) continue;
    const pool = monthDayPool(month, holidays);
    const poolSet = new Set(pool);
    const share = pool.length > 0 ? 1 / pool.length : 0;
    // 見込みを配る日と額
    let fcDays: ISODate[] = [];
    let fcTotal = 0;
    if (!d.isActual) {
      if (month === asOfMonth) {
        // 着地 − 今日までの実績。実績が着地を超えていれば負のまま今日に置く（月・四半期の着地と同じ値になるように）
        fcTotal = (d.forecastCost ?? 0) - d.cost;
        fcDays = fcTotal < 0 ? [asOf] : pool.filter((x) => x > asOf);
        if (fcDays.length === 0) fcDays = [lastDayOf(month)];
      } else {
        fcTotal = d.forecastCost ?? 0;
        fcDays = pool;
      }
    }
    const fcSet = new Set(fcDays);
    const fcEach = fcDays.length > 0 ? fcTotal / fcDays.length : 0;
    const rate = d.targetCap != null && d.budget !== 0 ? 1 - d.targetCap / d.budget : null;
    for (const date of datesBetween(firstDayOf(month), lastDayOf(month))) {
      const key = unit === "day" ? date : weekStartOf(date);
      let a = accs.get(key);
      if (!a) {
        a = newAcc(key, date, date);
        if (unit === "day") a.businessDay = isBusinessDay(date, set);
        accs.set(key, a);
        order.push(a);
      }
      a.to = date;
      a.months.add(month);
      a.statuses.add(d.status);
      const budget = poolSet.has(date) ? d.budget * share : 0;
      a.budget += budget;
      const act = actuals.get(date);
      if (act) {
        a.cost += act.cost;
        a.hours += act.hours;
      }
      // 今日より後の日・見込みの月の日は見込み（今日までの実績は cost に入っている）
      if (!d.isActual) {
        a.allActual = false;
        if (fcSet.has(date)) a.forecastPart += fcEach;
      }
      if (d.targetCap == null) a.targetAll = false;
      else {
        a.targetCap += poolSet.has(date) ? d.targetCap * share : 0;
        if (d.targetRate != null) a.rates.add(d.targetRate);
        else if (rate !== null) a.rates.add(rate);
      }
    }
  }
  return order.map((a) => finish(a, unit));
}

// ---------------------------------------------------------------------------
// メンバーの計画と実績の時間
// ---------------------------------------------------------------------------

/** core の memberMonthlySeries の 1 か月分のうち、まとめ直しに使う値 */
export interface MemberSeriesMonth {
  month: YearMonth;
  status: MonthStatus;
  plannedHours: number;
  actualHours: number;
}

export interface MemberHoursBucket {
  key: string;
  unit: ChartUnit;
  from: ISODate;
  to: ISODate;
  months: YearMonth[];
  status: MonthStatus | null;
  plannedHours: number;
  actualHours: number;
  utilization: number | null;
  businessDay?: boolean;
}

/**
 * data/member-days.json。members[社員番号][YYYY-MM] = { a: [日, 運用保守の時間, 運用保守以外の時間][], p?: [日, 運用保守の計画の重み, 運用保守以外の計画の重み][] }
 * p は月の途中から・途中までの計画（§123）がある月だけ（無ければその月の営業日に均等）
 */
export interface MemberDaysFile {
  asOf: ISODate;
  members: Record<string, Record<YearMonth, { a?: Array<[number, number, number]>; p?: Array<[number, number, number]> }>>;
}

function bucketMeta(unit: ChartUnit, date: ISODate, startMonth: number): string {
  if (unit === "day") return date;
  if (unit === "week") return weekStartOf(date);
  const month = monthOfDate(date);
  if (unit === "month") return month;
  const q = fiscalQuarterOf(month, startMonth);
  return unit === "year" ? `${q.fiscalYear}` : `${q.fiscalYear}-Q${q.quarter}`;
}

/**
 * メンバーの時間を まとめ直す。四半期・年度は月を足す。日・週は、実績を作業実績の日ごとの割合で、計画を計画の日ごとの重み
 * （無ければ営業日に均等）で配る。月ごとの計画・実績の内訳（運用保守／運用保守以外）は parts で渡す
 */
export function bucketMemberHours(
  series: readonly MemberSeriesMonth[],
  unit: ChartUnit,
  {
    startMonth,
    range = null,
    days = null,
    parts = null,
    includeOutside = false,
    holidays = [],
    asOf = null,
  }: {
    startMonth: number;
    range?: { from: YearMonth; to: YearMonth } | null;
    days?: MemberDaysFile["members"][string] | null;
    /** 月 → 計画・実績の運用保守以外の分（includeOutside のときだけ使う） */
    parts?: ReadonlyMap<YearMonth, { plannedOutside: number; actualOutside: number }> | null;
    includeOutside?: boolean;
    holidays?: HolidayLookup;
    /** 今日。日ごとの値の無い月の実績は、今日までの営業日に均等に配る */
    asOf?: ISODate | null;
  },
): MemberHoursBucket[] {
  const accs = new Map<string, { b: MemberHoursBucket; statuses: Set<MonthStatus> }>();
  const order: Array<{ b: MemberHoursBucket; statuses: Set<MonthStatus> }> = [];
  const touch = (key: string, date: ISODate, month: YearMonth, status: MonthStatus) => {
    let a = accs.get(key);
    if (!a) {
      a = { b: { key, unit, from: date, to: date, months: [], status: null, plannedHours: 0, actualHours: 0, utilization: null }, statuses: new Set() };
      accs.set(key, a);
      order.push(a);
    }
    if (!a.b.months.includes(month)) a.b.months.push(month);
    a.statuses.add(status);
    if (date < a.b.from) a.b.from = date;
    if (date > a.b.to) a.b.to = date;
    return a.b;
  };
  if (unit === "day" || unit === "week") {
    const set = holidaySetOf(holidays);
    const inRange = range ? series.filter((d) => d.month >= range.from && d.month <= range.to) : series;
    for (const d of inRange) {
      const all = datesBetween(firstDayOf(d.month), lastDayOf(d.month));
      for (const date of all) {
        const b = touch(bucketMeta(unit, date, startMonth), date, d.month, d.status);
        if (unit === "day" && b.businessDay === undefined) b.businessDay = isBusinessDay(date, set);
      }
      const pool = monthDayPool(d.month, holidays);
      const md = days?.[d.month];
      const part = parts?.get(d.month) ?? { plannedOutside: 0, actualOutside: 0 };
      const outsideP = includeOutside ? part.plannedOutside : 0;
      const outsideA = includeOutside ? part.actualOutside : 0;
      const addPlan = (date: ISODate, v: number) => (accs.get(bucketMeta(unit, date, startMonth))!.b.plannedHours += v);
      const addActual = (date: ISODate, v: number) => (accs.get(bucketMeta(unit, date, startMonth))!.b.actualHours += v);
      const pw = md?.p ?? null;
      spreadMonth(d.plannedHours - outsideP, d.month, pw ? pw.map(([x, c]) => [x, c] as const) : null, pool, addPlan);
      spreadMonth(outsideP, d.month, pw ? pw.map(([x, , o]) => [x, o] as const) : null, pool, addPlan);
      const aw = md?.a ?? null;
      const upTo = pool.filter((x) => asOf === null || x <= asOf);
      const passed = upTo.length > 0 ? upTo : pool;
      spreadMonth(d.actualHours - outsideA, d.month, aw ? aw.map(([x, c]) => [x, c] as const) : null, passed, addActual);
      spreadMonth(outsideA, d.month, aw ? aw.map(([x, , o]) => [x, o] as const) : null, passed, addActual);
    }
  } else {
    for (const d of series) {
      const b = touch(bucketMeta(unit, firstDayOf(d.month), startMonth), firstDayOf(d.month), d.month, d.status);
      b.to = lastDayOf(d.month) > b.to ? lastDayOf(d.month) : b.to;
      b.plannedHours += d.plannedHours;
      b.actualHours += d.actualHours;
    }
  }
  return order.map(({ b, statuses }) => ({
    ...b,
    months: b.months.sort(),
    status: statuses.size === 1 ? [...statuses][0]! : null,
    utilization: utilizationOf(b.actualHours, b.plannedHours),
  }));
}

/** 期間の最初の日・最後の日（日付が無ければ月の初日・末日）。日付の誤りは月の端として扱う（月の計算と同じ） */
function spanOf(p: Pick<Assignment, "startMonth" | "endMonth" | "startDate" | "endDate">): { from: ISODate; to: ISODate } {
  return { from: startDateOf(p) ?? firstDayOf(p.startMonth), to: endDateOf(p) ?? lastDayOf(p.endMonth) };
}

/**
 * data/member-days.json を作る。a = 日ごとの実績の時間（運用保守＝案件に付いた作業、運用保守以外）、
 * p = 月の途中から・途中までの計画がある月だけ、営業日ごとの計画の重み（その日に有効な配分・人月の合計）
 */
export function encodeMemberDays(
  model: Pick<Model, "meta" | "contracts" | "holidays" | "outsideDays">,
  plans: { assignments: readonly Assignment[]; outsidePlans: readonly OutsidePlan[] },
): MemberDaysFile {
  const asOf = model.meta.asOf;
  const members: MemberDaysFile["members"] = {};
  const slot = (id: string, month: YearMonth) => ((members[id] ??= {})[month] ??= {});
  // 実績
  const acts = new Map<string, Map<ISODate, [number, number]>>();
  const add = (id: string, date: ISODate, i: 0 | 1, h: number) => {
    if (date > asOf || !(h > 0)) return;
    let m = acts.get(id);
    if (!m) acts.set(id, (m = new Map()));
    const v = m.get(date) ?? [0, 0];
    v[i] += h;
    m.set(date, v);
  };
  for (const c of model.contracts) for (const cm of c.months) for (const w of cm.worklogs) if (w.date.slice(0, 7) === cm.month) add(w.memberId, w.date, 0, w.hours);
  for (const [id, byDate] of Object.entries(model.outsideDays ?? {})) for (const [date, h] of Object.entries(byDate)) add(id, date, 1, h);
  for (const [id, m] of acts) {
    const byMonth = new Map<YearMonth, Array<[number, number, number]>>();
    for (const [date, [c, o]] of [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const month = date.slice(0, 7);
      const arr = byMonth.get(month) ?? [];
      arr.push([Number(date.slice(8, 10)), r2(c), r2(o)]);
      byMonth.set(month, arr);
    }
    for (const [month, arr] of byMonth) slot(id, month).a = arr;
  }
  // 計画の重み（日付のある端の月だけ）
  // アサインは月の計算（buildMemberMonths）と同じく、有効な案件の契約期間の月だけ数える
  type Row = { memberId: string; startMonth: YearMonth; endMonth: YearMonth; startDate?: string; endDate?: string; w: number; i: 0 | 1; within?: { startMonth: YearMonth; endMonth: YearMonth } };
  const contractPeriod = new Map(model.contracts.map((r) => [r.contract.contractId, r.contract]));
  const rows: Row[] = [
    ...plans.assignments.flatMap((a) => {
      const c = contractPeriod.get(a.contractId);
      return c ? [{ ...a, w: a.allocation, i: 0 as const, within: { startMonth: c.startMonth, endMonth: c.endMonth } }] : [];
    }),
    ...plans.outsidePlans.map((o) => ({ ...o, w: o.personMonths, i: 1 as const })),
  ].filter((r) => Number.isFinite(r.w) && r.w > 0 && r.startMonth <= r.endMonth);
  const byMember = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byMember.get(r.memberId) ?? [];
    list.push(r);
    byMember.set(r.memberId, list);
  }
  for (const [id, list] of byMember) {
    const edgeMonths = new Set<YearMonth>();
    const counts = (r: Row, month: YearMonth) => r.startMonth <= month && month <= r.endMonth && (!r.within || (r.within.startMonth <= month && month <= r.within.endMonth));
    for (const r of list) {
      if (startDateOf(r) && counts(r, r.startMonth)) edgeMonths.add(r.startMonth);
      if (endDateOf(r) && counts(r, r.endMonth)) edgeMonths.add(r.endMonth);
    }
    for (const month of [...edgeMonths].sort()) {
      const out: Array<[number, number, number]> = [];
      for (const date of monthDayPool(month, model.holidays)) {
        const w: [number, number] = [0, 0];
        for (const r of list) {
          if (!counts(r, month)) continue;
          const s = spanOf(r);
          if (date >= s.from && date <= s.to) w[r.i] += r.w;
        }
        out.push([Number(date.slice(8, 10)), r2(w[0]), r2(w[1])]);
      }
      slot(id, month).p = out;
    }
  }
  return { asOf, members };
}
