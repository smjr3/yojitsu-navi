/**
 * 今月の進捗（SPEC §61）: 営業日按分の目安・残り・このペースの月末
 * 年を固定しない（§49）: 月は今年から作り、営業日の数は calendar の関数で数えて比べる。
 */
import { describe, expect, it } from "vitest";
import { businessDaysInMonth, dailyMembers, dailyProgress, isBusinessDay, progressFromDays, targetForMonth, type DailyFile } from "../../src/core/index.js";

const YEAR = new Date().getFullYear();
const MONTH = `${YEAR}-06`;
const date = (d: number) => `${MONTH}-${String(d).padStart(2, "0")}`;
const bizDays = (upTo: number, holidays: string[] = []) => Array.from({ length: upTo }, (_, i) => date(i + 1)).filter((d) => isBusinessDay(d, new Set(holidays)));

describe("progressFromDays", () => {
  it("目安は上限を営業日で按分し、休日は増えない。月末の目安は上限", () => {
    const p = progressFromDays(MONTH, null, 1000, 1000, new Map(), []);
    const total = businessDaysInMonth(MONTH, []);
    expect(p.businessDays).toBe(total);
    expect(p.points.at(-1)?.pace).toBeCloseTo(1000);
    for (let i = 1; i < p.points.length; i++) {
      const pt = p.points[i]!;
      const prev = p.points[i - 1]!;
      if (!pt.businessDay) expect(pt.pace).toBe(prev.pace);
      else expect(pt.pace - prev.pace).toBeCloseTo(1000 / total);
    }
    // 実績のある日が無い = 経過 0 日
    expect(p.elapsedBusinessDays).toBe(0);
    expect(p.actual).toBe(0);
    expect(p.averagePerDay).toBeNull();
    expect(p.projection).toBe(0);
    expect(p.perDayRemaining).toBeCloseTo(1000 / total);
    expect(p.points.every((x) => x.cumulative === null)).toBe(true);
  });

  it("経過日・累計・残り・このペースの月末", () => {
    const biz = bizDays(15);
    const byDay = new Map(biz.map((d) => [Number(d.slice(8)), { amount: 100, hours: 1 }]));
    // 休日の作業も実績に入る
    const off = Array.from({ length: 15 }, (_, i) => date(i + 1)).find((d) => !isBusinessDay(d, []));
    if (off) byDay.set(Number(off.slice(8)), { amount: 50, hours: 0.5 });
    const p = progressFromDays(MONTH, date(15), 2000, 1600, byDay, []);
    const total = businessDaysInMonth(MONTH, []);
    const actual = biz.length * 100 + (off ? 50 : 0);
    expect(p.elapsedBusinessDays).toBe(biz.length);
    expect(p.remainingBusinessDays).toBe(total - biz.length);
    expect(p.actual).toBeCloseTo(actual);
    expect(p.hours).toBeCloseTo(biz.length + (off ? 0.5 : 0));
    expect(p.paceToDate).toBeCloseTo((1600 * biz.length) / total);
    expect(p.remaining).toBeCloseTo(1600 - actual);
    expect(p.averagePerDay).toBeCloseTo(actual / biz.length);
    expect(p.projection).toBeCloseTo(actual + (actual / biz.length) * (total - biz.length));
    expect(p.perDayRemaining).toBeCloseTo((1600 - actual) / (total - biz.length));
    expect(p.points[14]!.cumulative).toBeCloseTo(actual);
    expect(p.points[15]!.cumulative).toBeNull();
    expect(p.lastDate).toBe(date(15));
  });

  it("祝日は営業日から外す", () => {
    const first = bizDays(30)[0]!;
    const p = progressFromDays(MONTH, null, 100, 100, new Map(), new Set([first]));
    expect(p.businessDays).toBe(businessDaysInMonth(MONTH, new Set([first])));
    expect(p.points.find((x) => x.date === first)?.businessDay).toBe(false);
  });

  it("月末まで経過すると残りの 1 日あたりは null（0 で割らない）", () => {
    const last = date(30);
    const p = progressFromDays(MONTH, last, 100, 100, new Map([[1, { amount: 130, hours: 1 }]]), []);
    expect(p.remainingBusinessDays).toBe(0);
    expect(p.perDayRemaining).toBeNull();
    expect(p.projection).toBeCloseTo(130);
    expect(p.remaining).toBeCloseTo(-30);
  });

  it("別の月の lastDate は経過 0 日として扱う", () => {
    const p = progressFromDays(MONTH, `${YEAR}-05-31`, 100, 100, new Map([[1, { amount: 10, hours: 1 }]]), []);
    expect(p.elapsedBusinessDays).toBe(0);
    expect(p.actual).toBe(0);
  });
});

describe("dailyProgress", () => {
  const model = {
    holidays: [],
    contracts: [
      { contract: { contractId: "A" }, months: [{ month: MONTH, budget: 600 }] },
      { contract: { contractId: "B" }, months: [{ month: MONTH, budget: 400 }] },
      { contract: { contractId: "C" }, months: [] },
    ],
  } as never;
  const first = Number(bizDays(30)[0]!.slice(8));
  const daily: DailyFile = { asOf: date(first), month: MONTH, lastDate: date(first), days: { A: [[first, 30, 1]], B: [[first, 20, 2]] }, members: { A: { M1: [[first, 1]] }, B: { M1: [[first, 0.5]], M2: [[first, 1.5], [30, 9]] } } };

  it("対象の案件の予算と日別の実績を合算する", () => {
    const p = dailyProgress(model, daily, ["A", "B"]);
    expect(p?.budget).toBe(1000);
    expect(p?.cap).toBe(1000);
    expect(p?.actual).toBeCloseTo(50);
    expect(p?.hours).toBeCloseTo(3);
    expect(dailyProgress(model, daily, ["A"])?.actual).toBeCloseTo(30);
  });

  it("上限の割合（目標の残予算率 r → 1 − r）", () => {
    expect(dailyProgress(model, daily, ["A", "B"], { capRatio: 0.8 })?.cap).toBeCloseTo(800);
  });

  it("今月の予算が 0 なら出さない", () => {
    expect(dailyProgress(model, daily, ["C"])).toBeNull();
    expect(dailyProgress(model, daily, [])).toBeNull();
  });

  it("メンバー×日: 対象の案件の時間と今月の計画を合算し、残りを残りの営業日で割る", () => {
    const withPlan = {
      contracts: [
        { contract: { contractId: "A" }, months: [{ month: MONTH, budget: 600 }], assignmentPlan: { hasAssignments: true, lines: [{ month: MONTH, memberId: "M1", hours: 80 }, { month: `${YEAR}-07`, memberId: "M1", hours: 999 }, { month: MONTH, memberId: "M3", hours: 16 }] } },
        { contract: { contractId: "B" }, months: [{ month: MONTH, budget: 400 }], assignmentPlan: { hasAssignments: false, lines: [] } },
      ],
    } as never;
    const p = dailyProgress({ ...(withPlan as object), holidays: [] } as never, daily, ["A", "B"])!;
    const rows = dailyMembers(withPlan, daily, p, ["A", "B"]);
    expect(rows.map((r) => r.memberId)).toEqual(["M1", "M3", "M2"]);
    const m1 = rows[0]!;
    expect(m1.total).toBeCloseTo(1.5);
    expect(m1.plan).toBe(80);
    expect(m1.hours[first - 1]).toBeCloseTo(1.5);
    expect(m1.remaining).toBeCloseTo(78.5);
    expect(m1.perDayRemaining).toBeCloseTo(78.5 / p.remainingBusinessDays);
    // lastDate より後の日（経過前）の時間は数えない
    const m2 = rows[2]!;
    expect(m2.total).toBeCloseTo(1.5);
    expect(m2.hours[29]).toBeNull();
    expect(rows[1]!.total).toBe(0);
    // 対象外の案件は入らない
    expect(dailyMembers(withPlan, daily, p, ["B"]).map((r) => r.memberId)).toEqual(["M2", "M1"]);
  });
});

describe("祝日の補完（§49）", () => {
  it("holidays.csv に今年の行が無ければ国民の祝日で補う（buildModel と同じ）", () => {
    // 1 月は元日が必ず祝日。前年の行だけを渡す
    const month = `${YEAR}-01`;
    const p = progressFromDays(month, null, 100, 100, new Map(), [{ date: `${YEAR - 1}-05-03`, name: "前年" }] as never);
    expect(p.points[0]!.businessDay).toBe(false);
  });
});

describe("targetForMonth（今月の上限に使う目標）", () => {
  const t = (targetId: string, startMonth: string, endMonth: string, remainingRate: number) => ({ kind: "team", targetId, startMonth, endMonth, remainingRate, note: "" });
  const model = {
    config: { fiscalYearStartMonth: 4 },
    targets: [
      t("T1", "", `${YEAR + 1}-03`, 0.12),
      t("T1", "", `${YEAR}-09`, 0.25),
      t("T1", `${YEAR}-10`, `${YEAR}-10`, 0.2),
      t("T2", "", `${YEAR + 1}-03`, 0.1),
    ],
  } as never;

  it("月を含む目標のうち期間の最も短いもの（月ごとの目標を優先）", () => {
    expect(targetForMonth(model, "team", "T1", `${YEAR}-10`)?.remainingRate).toBe(0.2);
    expect(targetForMonth(model, "team", "T1", `${YEAR}-11`)?.remainingRate).toBe(0.12);
    // 上期（開始月が空 = 年度の最初の月から）
    expect(targetForMonth(model, "team", "T1", `${YEAR}-06`)?.remainingRate).toBe(0.25);
    expect(targetForMonth(model, "team", "T2", `${YEAR}-06`)?.remainingRate).toBe(0.1);
  });

  it("月を含む目標が無ければ null（期間外・対象違い）", () => {
    expect(targetForMonth(model, "team", "T1", `${YEAR + 1}-04`)).toBeNull();
    expect(targetForMonth(model, "team", "T9", `${YEAR}-10`)).toBeNull();
    expect(targetForMonth(model, "customer", "T1", `${YEAR}-10`)).toBeNull();
  });
});
