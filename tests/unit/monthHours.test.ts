/**
 * 月の稼働時間（1.0 人月の時間 = その月の営業日 × 1 日の時間。SPEC §114）と、それを使う計画の時間・計画額・計画方式の着地
 */
import { describe, expect, it } from "vitest";
import { buildModel } from "../../src/core/model.js";
import { createMonthHours } from "../../src/core/monthHours.js";
import { HolidaySet } from "../../src/core/holidays.js";
import { assignmentPlanOf } from "../../src/core/forecast.js";
import { createMasterIndex } from "../../src/core/masters.js";
import { allocationFromInput, hoursFromAllocation } from "../../src/core/plan.js";
import { assignment, baseConfig, contract, dataset, member, rate, rule, team } from "./fixtures.js";

describe("createMonthHours（§114）", () => {
  it("営業日 = 土日と祝日を除いた日。× 1 日の時間", () => {
    const f = createMonthHours([], 8);
    // 2026-05 は平日 21 日、2027-02 は 20 日、2026-12 は 23 日
    expect(f("2026-05")).toBe(168);
    expect(f("2027-02")).toBe(160);
    expect(f("2026-12")).toBe(184);
    // 祝日（平日）は減る。土日の祝日は変わらない
    const g = createMonthHours(
      [
        { date: "2026-05-04", name: "みどりの日" },
        { date: "2026-05-05", name: "こどもの日" },
        { date: "2026-05-06", name: "振替休日" },
        { date: "2026-05-03", name: "憲法記念日" },
      ],
      8,
    );
    expect(g("2026-05")).toBe(144);
  });

  it("1 日の時間を変えるとその分だけ変わる。0・負・数値でなければ 0", () => {
    expect(createMonthHours([], 7.5)("2026-05")).toBe(157.5);
    expect(createMonthHours([], 0)("2026-05")).toBe(0);
    expect(createMonthHours([], -8)("2026-05")).toBe(0);
    expect(createMonthHours([], Number.NaN)("2026-05")).toBe(0);
  });

  it("祝日表に行の無い年は国民の祝日で補う（§49）。祝日表が空なら補わない", () => {
    // 2026 年の行だけある → 2027 年は国民の祝日で補う（2027-01: 元日・成人の日で 2 日減る）
    const only2026 = createMonthHours([{ date: "2026-11-03", name: "文化の日" }], 8);
    expect(only2026("2027-01")).toBe((21 - 2) * 8);
    expect(createMonthHours([], 8)("2027-01")).toBe(21 * 8);
  });

  it("作成済みの祝日の集合もそのまま使える（Model と同じ数え方）", () => {
    const rows = [{ date: "2026-11-03", name: "文化の日" }, { date: "2026-11-23", name: "勤労感謝の日" }];
    expect(createMonthHours(new HolidaySet(rows), 8)("2026-11")).toBe(createMonthHours(rows, 8)("2026-11"));
    expect(createMonthHours(rows, 8)("2026-11")).toBe((21 - 2) * 8);
  });
});

describe("計画の時間・計画額・計画方式の着地は月の営業日で変わる（§114）", () => {
  const ds = () =>
    dataset({
      contracts: [contract({ contractId: "C1", customerName: "ABC", startMonth: "2026-04", endMonth: "2027-03" })],
      mappings: [rule("ABC", "", "C1")],
      members: [member({ memberId: "M1", title: "SE", teamId: "T1" })],
      rates: [rate("SE", 5000)],
      teams: [team("T1", null)],
      assignments: [assignment({ memberId: "M1", contractId: "C1", startMonth: "2026-04", endMonth: "2027-03", allocation: 1 })],
      // 11 月に平日の祝日 2 日（文化の日・勤労感謝の日）、12 月に会社の休日 3 日
      holidays: [
        { date: "2026-11-03", name: "文化の日" },
        { date: "2026-11-23", name: "勤労感謝の日" },
        { date: "2026-12-29", name: "年末休暇" },
        { date: "2026-12-30", name: "年末休暇" },
        { date: "2026-12-31", name: "年末休暇" },
      ],
    });

  it("同じ 1.0 人月でも、営業日の少ない月は計画の時間・計画額が少ない", () => {
    const model = buildModel(ds(), { asOf: "2026-10-27", generatedAt: "x" });
    const mm = (m: string) => model.memberMonths.find((x) => x.memberId === "M1" && x.month === m)!;
    // 10 月 22 日、11 月 21 − 2 = 19 日、12 月 23 − 3 = 20 日
    expect([mm("2026-10").monthHours, mm("2026-11").monthHours, mm("2026-12").monthHours]).toEqual([176, 152, 160]);
    expect(mm("2026-11")).toMatchObject({ plannedHours: 152, plannedCost: 760_000 });
    expect(mm("2026-12")).toMatchObject({ plannedHours: 160, plannedCost: 800_000 });
    // 計画方式の着地の明細も同じ時間
    const lines = model.contracts[0]!.forecasts.assignment.breakdown.assignmentLines;
    expect(lines.find((l) => l.month === "2026-11")).toMatchObject({ hours: 152, amount: 760_000 });
    expect(lines.find((l) => l.month === "2026-12")).toMatchObject({ hours: 160, amount: 800_000 });
  });

  it("祝日を足すと、その月の計画方式の着地だけが 1 日 × 8h × 単価 減る", () => {
    const before = buildModel(ds(), { asOf: "2026-10-27", generatedAt: "x" });
    const d = ds();
    // 同じ年に足す（祝日表に行のある年が増えると、その年は国民の祝日で補わなくなる。§49）
    d.holidays = [...d.holidays, { date: "2026-12-28", name: "年末休暇" }];
    const after = buildModel(d, { asOf: "2026-10-27", generatedAt: "x" });
    const amount = (m: ReturnType<typeof buildModel>, month: string) => m.contracts[0]!.forecasts.assignment.breakdown.assignmentLines.find((l) => l.month === month)!.amount;
    expect(amount(before, "2026-12") - amount(after, "2026-12")).toBe(8 * 5000);
    expect(amount(after, "2027-01")).toBe(amount(before, "2027-01"));
    expect(before.contracts[0]!.forecasts.assignment.forecastCost - after.contracts[0]!.forecasts.assignment.forecastCost).toBe(8 * 5000);
  });

  it("assignmentPlanOf は渡した月の稼働時間で時間を出す", () => {
    const d = ds();
    const masters = createMasterIndex(d);
    const plan = assignmentPlanOf({ asOfMonth: "2027-01", config: baseConfig, masters, assignments: d.assignments, monthHours: (m) => (m === "2027-02" ? 100 : 200) }, d.contracts[0]!);
    expect(plan.lines.map((l) => [l.month, l.hours, l.amount])).toEqual([
      ["2027-01", 200, 1_000_000],
      ["2027-02", 100, 500_000],
      ["2027-03", 200, 1_000_000],
    ]);
  });

  it("時間で入れた計画は、その月の稼働時間で人月に直す（往復で同じ時間）", () => {
    const f = createMonthHours([], 8);
    // 2027-02 = 160h、2026-12 = 184h
    expect(allocationFromInput("80", "hours", f("2027-02"))).toBe("0.5");
    expect(allocationFromInput("92", "hours", f("2026-12"))).toBe("0.5");
    expect(hoursFromAllocation(0.5, f("2026-12"))).toBe(92);
  });
});
