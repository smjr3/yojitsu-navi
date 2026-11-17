/**
 * グラフの単位の切り替え（SPEC §130）: 四半期・年度・週・日へのまとめ直しと、今週・今四半期・今年度の進捗。
 * 年を固定しない（§49）: 年は今年から作る。どの単位でも、足せば月の値に戻ることを確かめる。
 */
import { describe, expect, it } from "vitest";
import {
  addDays,
  bucketDays,
  bucketMemberHours,
  bucketMonths,
  businessDaysInMonth,
  contractDailyActuals,
  datesBetween,
  dayUnitRange,
  encodeMemberDays,
  fiscalQuarterOf,
  isBusinessDay,
  monthDayPool,
  progressOverRange,
  progressRangeOf,
  spreadMonth,
  weekStartOf,
  type SeriesMonth,
} from "../../src/core/index.js";

const Y = new Date().getFullYear();
const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("暦", () => {
  it("週は月曜始まり、日付の足し引きは月・年をまたぐ", () => {
    for (const d of datesBetween(`${Y}-01-01`, `${Y}-01-31`)) {
      const w = weekStartOf(d);
      expect(new Date(`${w}T00:00:00Z`).getUTCDay()).toBe(1);
      expect(w <= d && addDays(w, 6) >= d).toBe(true);
    }
    expect(addDays(`${Y}-12-31`, 1)).toBe(`${Y + 1}-01-01`);
    expect(datesBetween(`${Y}-02-27`, `${Y}-03-02`).length).toBe(new Date(Date.UTC(Y, 2, 0)).getUTCDate() - 27 + 1 + 2);
  });

  it("四半期は年度の開始月から 3 か月ずつ", () => {
    expect(fiscalQuarterOf(ym(Y, 4), 4)).toEqual({ fiscalYear: Y, quarter: 1 });
    expect(fiscalQuarterOf(ym(Y, 12), 4)).toEqual({ fiscalYear: Y, quarter: 3 });
    expect(fiscalQuarterOf(ym(Y + 1, 3), 4)).toEqual({ fiscalYear: Y, quarter: 4 });
    expect(fiscalQuarterOf(ym(Y, 1), 1)).toEqual({ fiscalYear: Y, quarter: 1 });
  });

  it("日の単位は期間の終わり（今月より後なら今月）から 3 か月", () => {
    const period = { from: ym(Y, 4), to: ym(Y + 1, 3) };
    expect(dayUnitRange(period, ym(Y, 10))).toEqual({ from: ym(Y, 8), to: ym(Y, 10) });
    expect(dayUnitRange(period, ym(Y, 5))).toEqual({ from: ym(Y, 4), to: ym(Y, 5) });
    expect(dayUnitRange(period, ym(Y + 2, 1))).toEqual({ from: ym(Y + 1, 1), to: ym(Y + 1, 3) });
    // 期間がまるごと未来: 期間の初めから 3 か月
    expect(dayUnitRange(period, ym(Y - 1, 1))).toEqual({ from: ym(Y, 4), to: ym(Y, 6) });
  });

  it("月の値を配る日は営業日（祝日を除く）", () => {
    const m = ym(Y, 6);
    const pool = monthDayPool(m, []);
    expect(pool.length).toBe(businessDaysInMonth(m, []));
    expect(pool.every((d) => isBusinessDay(d, []))).toBe(true);
  });

  it("spreadMonth は重みの割合で配り、足すと元の値", () => {
    const m = ym(Y, 6);
    const got = new Map<string, number>();
    spreadMonth(1000, m, [[3, 1], [10, 3]], [], (d, v) => got.set(d, (got.get(d) ?? 0) + v));
    expect(got.get(`${m}-03`)).toBeCloseTo(250);
    expect(got.get(`${m}-10`)).toBeCloseTo(750);
    got.clear();
    // 重みが 0 なら fallback に均等
    spreadMonth(90, m, [[3, 0]], [`${m}-01`, `${m}-02`, `${m}-03`], (d, v) => got.set(d, v));
    expect([...got.values()]).toEqual([30, 30, 30]);
  });
});

const months = [ym(Y, 4), ym(Y, 5), ym(Y, 6), ym(Y, 7)];
const asOf = `${ym(Y, 6)}-15`;
const series: SeriesMonth[] = [
  { month: months[0]!, status: "final", budget: 300, cost: 200, hours: 20, isActual: true, forecastCost: null, targetCap: 270, targetRate: 0.1 },
  { month: months[1]!, status: "final", budget: 300, cost: 310, hours: 31, isActual: true, forecastCost: null, targetCap: 270, targetRate: 0.1 },
  { month: months[2]!, status: "preliminary", budget: 300, cost: 120, hours: 12, isActual: false, forecastCost: 280, targetCap: 270, targetRate: 0.1 },
  { month: months[3]!, status: "future", budget: 300, cost: 0, hours: 0, isActual: false, forecastCost: 250 },
];

describe("bucketMonths（四半期・年度）", () => {
  it("四半期: 月の値を足す。実績だけの四半期は実績、見込みを含む四半期の着地 = 実績 ＋ 見込み", () => {
    const q = bucketMonths(series, "quarter", 4);
    expect(q.map((b) => b.key)).toEqual([`${Y}-Q1`, `${Y}-Q2`]);
    const [q1, q2] = q;
    expect(q1!.budget).toBe(900);
    expect(q1!.cost).toBe(630);
    expect(q1!.isActual).toBe(false);
    expect(q1!.partial).toBe(true);
    // 4・5 月の実績 510 ＋ 6 月の着地 280
    expect(q1!.forecastCost).toBe(790);
    expect(q1!.forecastGrossProfit).toBe(110);
    expect(q1!.targetCap).toBe(810);
    expect(q1!.targetRate).toBe(0.1);
    expect(q1!.status).toBeNull();
    // 7 月は目標なし → 目標の上限は出さない
    expect(q2!.targetCap).toBeUndefined();
    expect(q2!.forecastCost).toBe(250);
    expect(q2!.partial).toBe(false);
    expect(q2!.status).toBe("future");
  });

  it("年度: 1 本。実績だけなら isActual", () => {
    const y = bucketMonths(series.slice(0, 2), "year", 4);
    expect(y).toHaveLength(1);
    expect(y[0]!.isActual).toBe(true);
    expect(y[0]!.forecastCost).toBeNull();
    expect(y[0]!.grossProfit).toBe(90);
    expect(y[0]!.from).toBe(`${months[0]}-01`);
  });
});

describe("contractDailyActuals と bucketDays（日・週）", () => {
  const holidays: never[] = [];
  const contracts = months.map((m, i) => ({ month: m, budget: 300, cost: series[i]!.cost, hours: series[i]!.hours }));
  const model = { holidays, meta: { asOf, asOfMonth: ym(Y, 6) }, contracts: [{ contract: { contractId: "A" }, months: contracts }] } as never;
  const firstBiz = (m: string) => monthDayPool(m, [])[0]!;
  const history = {
    asOf,
    lastDate: asOf,
    contracts: {
      A: {
        // 4 月は 2 日だけ作業（1:3）。5 月は日ごとの値なし（営業日に均等）
        [months[0]!]: [[Number(firstBiz(months[0]!).slice(8)), 10, 1], [20, 30, 3]],
        [months[2]!]: [[1, 5, 1], [10, 5, 1]],
      },
    },
  } as never;

  it("案件・月の実績を日ごとの割合で配り、月の合計は変わらない", () => {
    const act = contractDailyActuals(model, history, ["A"], { from: months[0]!, to: months[3]! });
    const monthSum = (m: string, k: "cost" | "hours") => sum([...act].filter(([d]) => d.startsWith(m)).map(([, v]) => v[k]));
    expect(monthSum(months[0]!, "cost")).toBeCloseTo(200);
    expect(act.get(firstBiz(months[0]!))?.cost).toBeCloseTo(50);
    expect(monthSum(months[1]!, "cost")).toBeCloseTo(310);
    expect(monthSum(months[2]!, "hours")).toBeCloseTo(12);
    expect(act.get(`${months[2]}-10`)?.cost).toBeCloseTo(60);
    // 対象外の案件は入れない
    expect(contractDailyActuals(model, history, ["B"], { from: months[0]!, to: months[3]! }).size).toBe(0);
  });

  it("日: 予算は営業日に配り、今月の見込みは今日より後の営業日に配る。足すと月の値", () => {
    const act = contractDailyActuals(model, history, ["A"], { from: months[0]!, to: months[3]! });
    const days = bucketDays(series, act, { unit: "day", range: { from: months[0]!, to: months[3]! }, asOf, holidays: [] });
    const inMonth = (m: string) => days.filter((d) => d.months[0] === m);
    for (let i = 0; i < 4; i++) {
      expect(sum(inMonth(months[i]!).map((d) => d.budget))).toBeCloseTo(300);
      expect(sum(inMonth(months[i]!).map((d) => d.cost))).toBeCloseTo(series[i]!.cost);
    }
    // 休日の予算は 0
    expect(days.filter((d) => d.businessDay === false).every((d) => d.budget === 0)).toBe(true);
    // 今月: 着地 280 = 今日までの実績 120 ＋ 今日より後の見込み 160
    const june = inMonth(months[2]!);
    expect(sum(june.map((d) => d.forecastCost ?? 0))).toBeCloseTo(280);
    expect(june.filter((d) => d.from <= asOf).every((d) => (d.forecastCost ?? 0) === d.cost)).toBe(true);
    expect(june.find((d) => d.from === `${months[2]}-10`)?.partial).toBe(true);
    // 実績の月は isActual、未来の月の見込みは 250
    expect(inMonth(months[0]!).every((d) => d.isActual)).toBe(true);
    expect(sum(inMonth(months[3]!).map((d) => d.forecastCost ?? 0))).toBeCloseTo(250);
    // 目標の上限は目標のある月の日だけ
    expect(sum(june.map((d) => d.targetCap ?? 0))).toBeCloseTo(270);
    expect(inMonth(months[3]!).every((d) => d.targetCap === undefined)).toBe(true);
  });

  it("週: 月曜始まり。月をまたぐ週は両方の月を含み、足すと期間の合計", () => {
    const act = contractDailyActuals(model, history, ["A"], { from: months[0]!, to: months[3]! });
    const weeks = bucketDays(series, act, { unit: "week", range: { from: months[0]!, to: months[3]! }, asOf, holidays: [] });
    expect(weeks.every((w) => w.key === weekStartOf(w.from) && new Date(`${w.key}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
    expect(weeks[0]!.from).toBe(`${months[0]}-01`);
    expect(weeks.at(-1)!.to).toBe(datesBetween(`${months[3]}-01`, `${months[3]}-31`).at(-1));
    expect(sum(weeks.map((w) => w.budget))).toBeCloseTo(1200);
    expect(sum(weeks.map((w) => w.cost))).toBeCloseTo(630);
    expect(weeks.some((w) => w.months.length === 2)).toBe(true);
  });
});

describe("bucketMemberHours（メンバーの時間）", () => {
  const m = ym(Y, 6);
  const s = [
    { month: ym(Y, 5), status: "final" as const, plannedHours: 160, actualHours: 150 },
    { month: m, status: "preliminary" as const, plannedHours: 80, actualHours: 30 },
  ];

  it("四半期・年度は月を足し、稼働率は足した時間で", () => {
    const q = bucketMemberHours(s, "quarter", { startMonth: 4 });
    expect(q).toHaveLength(1);
    expect(q[0]!.plannedHours).toBe(240);
    expect(q[0]!.actualHours).toBe(180);
    expect(q[0]!.utilization).toBeCloseTo(0.75);
  });

  it("日: 計画は計画の重み（月の途中からの計画）の日だけに配り、実績は日ごとの時間の割合で配る", () => {
    const pool = monthDayPool(m, []);
    const half = pool.slice(Math.floor(pool.length / 2));
    const days = {
      [m]: { a: [[Number(pool[0]!.slice(8)), 2, 0], [Number(pool[1]!.slice(8)), 1, 0]] as Array<[number, number, number]>, p: pool.map((d) => [Number(d.slice(8)), half.includes(d) ? 1 : 0, 0] as [number, number, number]) },
    };
    const out = bucketMemberHours(s, "day", { startMonth: 4, range: { from: m, to: m }, days, holidays: [], asOf: `${m}-28` });
    expect(sum(out.map((d) => d.plannedHours))).toBeCloseTo(80);
    expect(out.filter((d) => d.from < half[0]!).every((d) => d.plannedHours === 0)).toBe(true);
    expect(out.find((d) => d.from === half[0])?.plannedHours).toBeCloseTo(80 / half.length);
    expect(sum(out.map((d) => d.actualHours))).toBeCloseTo(30);
    expect(out.find((d) => d.from === pool[0])?.actualHours).toBeCloseTo(20);
  });

  it("運用保守以外を含むときは、運用保守以外の分を別の重みで配る", () => {
    const pool = monthDayPool(m, []);
    const days = { [m]: { a: [[Number(pool[0]!.slice(8)), 0, 4]] as Array<[number, number, number]> } };
    const parts = new Map([[m, { plannedOutside: 0, actualOutside: 10 }]]);
    const out = bucketMemberHours([{ ...s[1]!, actualHours: 10 }], "day", { startMonth: 4, range: { from: m, to: m }, days, parts, includeOutside: true, holidays: [], asOf: `${m}-28` });
    expect(out.find((d) => d.from === pool[0])?.actualHours).toBeCloseTo(10);
  });
});

describe("encodeMemberDays", () => {
  it("実績の時間を日ごとに、計画の重みは日付のある端の月だけ", () => {
    const m = ym(Y, 6);
    const pool = monthDayPool(m, []);
    const start = pool[5]!;
    const model = {
      meta: { asOf: `${m}-30` },
      holidays: [],
      contracts: [{ months: [{ month: m, worklogs: [{ memberId: "M1", date: pool[0], hours: 3 }, { memberId: "M1", date: pool[0], hours: 1 }] }] }],
      outsideDays: { M1: { [pool[1]!]: 2 } },
    } as never;
    const f = encodeMemberDays(model, {
      assignments: [
        { memberId: "M1", contractId: "A", startMonth: m, endMonth: ym(Y, 8), startDate: start, allocation: 0.5 },
        { memberId: "M2", contractId: "A", startMonth: m, endMonth: m, allocation: 1 },
      ],
      outsidePlans: [],
    });
    expect(f.members.M1![m]!.a).toEqual([[Number(pool[0]!.slice(8)), 4, 0], [Number(pool[1]!.slice(8)), 0, 2]]);
    const p = f.members.M1![m]!.p!;
    expect(p).toHaveLength(pool.length);
    expect(p.filter(([, c]) => c > 0).length).toBe(pool.length - 5);
    // 日付の無い月・人は重みを持たない（営業日に均等）
    expect(f.members.M1![ym(Y, 7)]).toBeUndefined();
    expect(f.members.M2).toBeUndefined();
  });
});

describe("progressRangeOf と progressOverRange（今週・今四半期・今年度）", () => {
  it("範囲: 週は月曜〜日曜、四半期・年度は年度の開始月から", () => {
    const today = `${ym(Y, 11)}-18`;
    const w = progressRangeOf("week", today, 4);
    expect(new Date(`${w.from}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(addDays(w.from, 6)).toBe(w.to);
    expect(progressRangeOf("quarter", today, 4)).toEqual({ from: `${ym(Y, 10)}-01`, to: `${ym(Y, 12)}-31` });
    expect(progressRangeOf("year", today, 4)).toEqual({ from: `${ym(Y, 4)}-01`, to: `${ym(Y + 1, 3)}-31` });
    expect(progressRangeOf("month", today, 4)).toEqual({ from: `${ym(Y, 11)}-01`, to: `${ym(Y, 11)}-30` });
  });

  it("上限 = 範囲の日の予算の合計 × 月ごとの割合、目安は日ごとに積み上げ、実績は月の実績を日に配る", () => {
    const q = [ym(Y, 4), ym(Y, 5), ym(Y, 6)];
    const today = `${q[1]}-15`;
    const model = {
      holidays: [],
      meta: { asOf: today, asOfMonth: q[1] },
      contracts: [{ contract: { contractId: "A" }, months: [{ month: q[0], budget: 300, cost: 300, hours: 30 }, { month: q[1], budget: 300, cost: 100, hours: 10 }, { month: q[2], budget: 600, cost: 0, hours: 0 }] }],
    } as never;
    const lastBiz = monthDayPool(q[1]!, []).filter((d) => d < today).at(-1)!;
    const history = { asOf: today, lastDate: lastBiz, contracts: { A: { [q[1]!]: [[Number(lastBiz.slice(8)), 1, 1]] } } } as never;
    const p = progressOverRange(model, history, ["A"], { unit: "quarter", from: `${q[0]}-01`, to: `${q[2]}-30`, capRatioOf: (m) => (m === q[2] ? 0.5 : 1), today })!;
    expect(p.unit).toBe("quarter");
    expect(p.budget).toBeCloseTo(1200);
    expect(p.cap).toBeCloseTo(900);
    expect(p.points.at(-1)!.pace).toBeCloseTo(900);
    expect(p.actual).toBeCloseTo(400);
    expect(p.points.find((d) => d.date === lastBiz)?.amount).toBeCloseTo(100);
    const biz = (from: string, to: string) => datesBetween(from, to).filter((d) => isBusinessDay(d, [])).length;
    expect(p.businessDays).toBe(biz(`${q[0]}-01`, `${q[2]}-30`));
    expect(p.elapsedBusinessDays).toBe(biz(`${q[0]}-01`, lastBiz));
    // 目安（今日まで）= 4 月の上限 ＋ 5 月の上限のうち経過した営業日の分
    const mayPool = monthDayPool(q[1]!, []);
    expect(p.paceToDate).toBeCloseTo(300 + (300 * mayPool.filter((d) => d <= lastBiz).length) / mayPool.length);
    expect(p.projection).toBeCloseTo(400 + (400 / p.elapsedBusinessDays) * (p.businessDays - p.elapsedBusinessDays));
    expect(p.today).toBe(today);
  });

  it("範囲に予算が無ければ null", () => {
    const model = { holidays: [], meta: { asOf: `${Y}-06-10` }, contracts: [] } as never;
    expect(progressOverRange(model, null, ["A"], { unit: "week", from: `${Y}-06-08`, to: `${Y}-06-14` })).toBeNull();
  });
});
