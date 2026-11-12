/**
 * 今月の進捗（日別の速報。SPEC §61）
 *
 * - 対象の月 = asOf の月。作業ログの日付ごとに、案件ごとの実績額・時間を持つ（速報。確定を待たない）
 * - 月の上限 = 月の予算（目標があれば呼び出し側で予算 ×（1 − 目標の残予算率）にして渡す）
 * - 目安 = 月の上限を営業日で按分した累計（土日・祝日は増えない）
 * - 経過した営業日 = 「実績のある最終日」（データ全体で作業ログがある最後の日。asOf を超えない）までの営業日
 * - 残りの営業日 = 今日（画面を開いた人の今日。§75）から月末までの営業日。ただし実績のある最終日より後だけ数える
 *   （取り込みが止まっても、残りの日数は今日で数える）
 * - このペースの月末 = 実績 + これまでの営業日 1 日あたりの平均 × 実績がまだ無い営業日（実績のある最終日より後）
 *
 * 画面用には data/daily.json（encodeDaily）で配り、dailyProgress で対象の案件を合算する。
 */
import { daysInMonth, isBusinessDay, parseYearMonth, type HolidayLookup } from "./calendar.js";
import { HolidaySet } from "./holidays.js";
import type { Holiday, ISODate, Model, YearMonth } from "./types.js";

/** data/daily.json の中身。days[contractId] = [日, 実績額（円・小数）, 時間][] */
export interface DailyFile {
  asOf: ISODate;
  month: YearMonth;
  /** 作業ログがある最後の日（月内。無ければ null） */
  lastDate: ISODate | null;
  days: Record<string, Array<[number, number, number]>>;
  /** members[contractId][memberId] = [日, 時間][]（チーム詳細のメンバー×日の表） */
  members: Record<string, Record<string, Array<[number, number]>>>;
}

export interface DailyPoint {
  date: ISODate;
  day: number;
  businessDay: boolean;
  /** その日の実績（経過前は null） */
  amount: number | null;
  hours: number | null;
  /** 実績の累計（経過前は null） */
  cumulative: number | null;
  /** 目安の累計 */
  pace: number;
}

export interface DailyProgress {
  month: YearMonth;
  lastDate: ISODate | null;
  budget: number;
  cap: number;
  businessDays: number;
  elapsedBusinessDays: number;
  /** 今日から月末までの営業日（実績のある最終日より後だけ。§75） */
  remainingBusinessDays: number;
  /** 今日（月の外なら null） */
  today: ISODate | null;
  actual: number;
  hours: number;
  /** 今日までの目安 */
  paceToDate: number;
  /** 上限までの残り（負 = 超過） */
  remaining: number;
  /** 残りの営業日 1 日あたりで使える額（残りの営業日が 0 なら null） */
  perDayRemaining: number | null;
  /** これまでの営業日 1 日あたりの平均（経過 0 日なら null） */
  averagePerDay: number | null;
  /** このペースの月末 */
  projection: number;
  points: DailyPoint[];
}

/** Model（作業ログ明細つき）から asOf の月の日別実績を詰める。金額は丸める前の hours × 単価（合計は月の実績と丸めの差だけずれる） */
export function encodeDaily(model: Model): DailyFile {
  const month = model.meta.asOfMonth;
  const asOf = model.meta.asOf;
  const days: DailyFile["days"] = {};
  const members: DailyFile["members"] = {};
  let lastDate: ISODate | null = null;
  for (const c of model.contracts) {
    const cm = c.months.find((m) => m.month === month);
    if (!cm || cm.worklogs.length === 0) continue;
    const byDay = new Map<number, [number, number, number]>();
    const byMember = new Map<string, Map<number, number>>();
    for (const w of cm.worklogs) {
      if (w.date.slice(0, 7) !== month || w.date > asOf) continue;
      if (lastDate === null || w.date > lastDate) lastDate = w.date;
      const d = Number(w.date.slice(8, 10));
      const acc = byDay.get(d) ?? [d, 0, 0];
      acc[1] += w.hours * w.hourlyRate;
      acc[2] += w.hours;
      byDay.set(d, acc);
      const mm = byMember.get(w.memberId) ?? new Map<number, number>();
      mm.set(d, (mm.get(d) ?? 0) + w.hours);
      byMember.set(w.memberId, mm);
    }
    if (byMember.size > 0) {
      const out: Record<string, Array<[number, number]>> = {};
      for (const [id, mm] of byMember) out[id] = [...mm].sort((a, b) => a[0] - b[0]).map(([d, h]) => [d, Math.round(h * 100) / 100]);
      members[c.contract.contractId] = out;
    }
    if (byDay.size > 0) days[c.contract.contractId] = [...byDay.values()].sort((a, b) => a[0] - b[0]).map(([d, a, h]) => [d, Math.round(a * 100) / 100, Math.round(h * 100) / 100]);
  }
  return { asOf, month, lastDate, days, members };
}

/**
 * 対象の案件の今月の進捗。月の予算が 0（今月に契約期間の案件が無い）なら null。
 * capRatio は上限の割合（目標の残予算率 r なら 1 − r。既定 1 = 予算そのもの）。
 */
export function dailyProgress(
  model: Pick<Model, "contracts" | "holidays">,
  daily: DailyFile,
  contractIds: readonly string[],
  { capRatio = 1, today = null }: { capRatio?: number; today?: ISODate | null } = {},
): DailyProgress | null {
  const ids = new Set(contractIds);
  let budget = 0;
  for (const c of model.contracts) {
    if (!ids.has(c.contract.contractId)) continue;
    const cm = c.months.find((m) => m.month === daily.month);
    if (cm) budget += cm.budget;
  }
  if (budget <= 0) return null;
  const cap = budget * Math.max(0, capRatio);
  const byDay = new Map<number, { amount: number; hours: number }>();
  for (const id of ids) {
    for (const [d, a, h] of daily.days[id] ?? []) {
      const acc = byDay.get(d) ?? { amount: 0, hours: 0 };
      acc.amount += a;
      acc.hours += h;
      byDay.set(d, acc);
    }
  }
  return progressFromDays(daily.month, daily.lastDate, budget, cap, byDay, model.holidays, today);
}

/** 日ごとの実績から進みを計算する（dailyProgress の本体。テストしやすいよう分けてある） */
export function progressFromDays(
  month: YearMonth,
  lastDate: ISODate | null,
  budget: number,
  cap: number,
  byDay: ReadonlyMap<number, { amount: number; hours: number }>,
  holidays: HolidayLookup,
  today: ISODate | null = null,
): DailyProgress {
  const { year, month: mm } = parseYearMonth(month);
  const total = daysInMonth(year, mm);
  // 行の無い年は国民の祝日で補う（§49。buildModel と同じ HolidaySet）。Set を渡されたらそのまま使う
  const set = holidays instanceof Set ? holidays : new HolidaySet(holidays as readonly Holiday[]);
  const lastDay = lastDate && lastDate.slice(0, 7) === month ? Number(lastDate.slice(8, 10)) : 0;
  // 今日（月の外なら null）。今日の分はまだ実績に入っていないものとして、今日も残りの営業日に数える
  const todayDay = today && today.slice(0, 7) === month ? Number(today.slice(8, 10)) : null;
  const restFrom = Math.max(lastDay, todayDay === null ? 0 : todayDay - 1);
  const dates = Array.from({ length: total }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
  const bizFlags = dates.map((d) => isBusinessDay(d, set));
  const businessDays = bizFlags.filter(Boolean).length;
  let elapsedBusinessDays = 0;
  let biz = 0;
  let cumulative = 0;
  let hours = 0;
  const points: DailyPoint[] = dates.map((date, i) => {
    const day = i + 1;
    const isBiz = bizFlags[i] === true;
    if (isBiz) biz++;
    const elapsed = day <= lastDay;
    if (elapsed && isBiz) elapsedBusinessDays++;
    const v = byDay.get(day);
    if (elapsed) {
      cumulative += v?.amount ?? 0;
      hours += v?.hours ?? 0;
    }
    return {
      date,
      day,
      businessDay: isBiz,
      amount: elapsed ? (v?.amount ?? 0) : null,
      hours: elapsed ? (v?.hours ?? 0) : null,
      cumulative: elapsed ? cumulative : null,
      // 営業日が 0 の月は月初から上限（按分できない）
      pace: businessDays > 0 ? (cap * biz) / businessDays : cap,
    };
  });
  const actual = cumulative;
  const unrecordedBusinessDays = businessDays - elapsedBusinessDays;
  const remainingBusinessDays = bizFlags.filter((b, i) => b && i + 1 > restFrom).length;
  const paceToDate = businessDays > 0 ? (cap * elapsedBusinessDays) / businessDays : cap;
  const remaining = cap - actual;
  const averagePerDay = elapsedBusinessDays > 0 ? actual / elapsedBusinessDays : null;
  return {
    month,
    lastDate: lastDay > 0 ? (dates[lastDay - 1] ?? null) : null,
    budget,
    cap,
    businessDays,
    elapsedBusinessDays,
    remainingBusinessDays,
    today: todayDay === null ? null : (dates[todayDay - 1] ?? null),
    actual,
    hours,
    paceToDate,
    remaining,
    perDayRemaining: remainingBusinessDays > 0 ? remaining / remainingBusinessDays : null,
    averagePerDay,
    projection: actual + (averagePerDay ?? 0) * unrecordedBusinessDays,
    points,
  };
}

export interface DailyMemberRow {
  memberId: string;
  /** hours[日 - 1] = その日の時間（経過前は null） */
  hours: Array<number | null>;
  total: number;
  /** 今月のリソース計画の時間（配分 × 1人月の時間。§114。対象の案件の合計） */
  plan: number;
  /** 計画までの残り時間（負 = 超過） */
  remaining: number;
  /** 残りの営業日 1 日あたりの時間（残りの営業日が 0 なら null） */
  perDayRemaining: number | null;
}

/**
 * 対象の案件の、メンバーごとの今月の日別の時間と計画（チーム詳細のメンバー×日の表）。
 * 作業実績か今月の計画がある人を、計画の多い順（同じなら時間の多い順）に返す。
 */
export function dailyMembers(
  model: Pick<Model, "contracts">,
  daily: DailyFile,
  progress: Pick<DailyProgress, "points" | "remainingBusinessDays">,
  contractIds: readonly string[],
): DailyMemberRow[] {
  const ids = new Set(contractIds);
  const n = progress.points.length;
  const elapsed = progress.points.map((p) => p.cumulative !== null);
  const rows = new Map<string, DailyMemberRow>();
  const row = (memberId: string) => {
    let r = rows.get(memberId);
    if (!r) {
      r = { memberId, hours: elapsed.map((e) => (e ? 0 : null)), total: 0, plan: 0, remaining: 0, perDayRemaining: null };
      rows.set(memberId, r);
    }
    return r;
  };
  for (const id of ids) {
    for (const [memberId, list] of Object.entries(daily.members?.[id] ?? {})) {
      const r = row(memberId);
      for (const [d, h] of list) {
        if (d < 1 || d > n || !elapsed[d - 1]) continue;
        r.hours[d - 1] = (r.hours[d - 1] ?? 0) + h;
        r.total += h;
      }
    }
  }
  for (const c of model.contracts) {
    if (!ids.has(c.contract.contractId)) continue;
    for (const l of c.assignmentPlan?.lines ?? []) if (l.month === daily.month) row(l.memberId).plan += l.hours;
  }
  const rest = progress.remainingBusinessDays;
  for (const r of rows.values()) {
    r.remaining = r.plan - r.total;
    r.perDayRemaining = rest > 0 ? r.remaining / rest : null;
  }
  return [...rows.values()].sort((a, b) => b.plan - a.plan || b.total - a.total || a.memberId.localeCompare(b.memberId));
}
