import { describe, expect, it } from "vitest";
import { aggregate, contractEndForecasts, forecastPeriodOf, forecastTotals, monthlySeries, setForecastPeriod } from "../../src/core/aggregate.js";
import { buildModel } from "../../src/core/model.js";
import type { Dataset } from "../../src/core/types.js";
import { assignment, contract, dataset, member, rate, rule, team, worklog } from "./fixtures.js";

/**
 * 手計算の例（SPEC 全体の通し）
 *
 * 契約 C1: 2026-04〜2027-03（12 か月）、総額 ¥2,400,000 → 月次予算 200,000（端数 0）
 * メンバー:
 *   M1 社員 役職 SE、単価 SE = 5,000 円/h
 *   M2 パートナー 個人単価 M2 = 4,000 円/h（役職 PG = 3,000 は使われない）
 * 作業実績（契約に紐付くもの）:
 *   2026-04: M1 10h → 50,000 / M2 20h → 80,000    → 原価 130,000  粗利  70,000
 *   2026-05: M1 30h → 150,000 / M2 20h → 80,000   → 原価 230,000  粗利 -30,000
 *   2026-06: M2 10.5h → 42,000                     → 原価  42,000  粗利 158,000
 *   2026-07: M1 16h → 80,000                       → 原価  80,000  粗利 120,000
 *   2026-08: M1 12.25h → 61,250                    → 原価  61,250  粗利 138,750
 *   2026-09: M2 25h → 100,000                      → 原価 100,000  粗利 100,000
 *   2026-10: M1 4h → 20,000（asOf 月・速報）        → 原価  20,000  粗利 180,000
 *   2026-11 以降: 0
 * asOf = 2026-10-27。2026-09 の確定日 = 2026-10 の第 3 営業日 = 10-05 → 2026-09 は final、lastFinalMonth = 2026-09
 *
 * 年度（2026-04〜2027-03）集計:
 *   予算 2,400,000
 *   原価 130,000+230,000+42,000+80,000+61,250+100,000+20,000 = 663,250
 *   粗利 1,736,750、粗利率 1,736,750 / 2,400,000 = 0.72364583…
 *   経過月 04〜10 の 7 か月: 累計予算 1,400,000、累計原価 663,250 → 消化率 0.47375
 *   時間 10+20+30+20+10.5+16+12.25+25+4 = 147.75h → 標準人月 147.75/160 = 0.9234375
 *
 * 着地（FY2026）: 実績月 04〜09、actualCost = 643,250、残り月 10〜03 の 6 か月
 *   recent3: (80,000 + 61,250 + 100,000) / 3 = 80,416.666… × 6 = 482,500
 *            forecastCost = 643,250 + 482,500 = 1,125,750、粗利 1,274,250
 *   all:     643,250 / 6 = 107,208.333… × 6 = 643,250
 *            forecastCost = 1,286,500、粗利 1,113,500
 *   assignment: M1 0.5 人月 (2026-10〜2027-03) = 0.5×160×5,000 = 400,000/月
 *               M2 0.25 人月 (2026-10〜2026-12) = 0.25×160×4,000 = 160,000/月
 *               10,11,12: 560,000 × 3 = 1,680,000、01,02,03: 400,000 × 3 = 1,200,000 → 残り 2,880,000
 *               forecastCost = 643,250 + 2,880,000 = 3,523,250、粗利 -1,123,250 → 赤字
 */
function workedExample(): Dataset {
  const C = "ABC株式会社";
  const P = "保守";
  return dataset({
    contracts: [contract({ contractId: "C1", customerName: C, projectName: P, teamId: "T1" })],
    mappings: [rule(C, P, "C1")],
    teams: [team("T1", null)],
    members: [member({ memberId: "M1", name: "山田", title: "SE", teamId: "T1" }), member({ memberId: "M2", name: "鈴木", kind: "partner", title: "PG", teamId: "T1" })],
    rates: [rate("SE", 5000), rate("PG", 3000), rate("M2", 4000)],
    assignments: [
      assignment({ memberId: "M1", contractId: "C1", startMonth: "2026-10", endMonth: "2027-03", allocation: 0.5 }),
      assignment({ memberId: "M2", contractId: "C1", startMonth: "2026-10", endMonth: "2026-12", allocation: 0.25 }),
    ],
    worklogs: [
      worklog({ date: "2026-04-01", memberId: "M1", hours: 10 }),
      worklog({ date: "2026-04-15", memberId: "M2", hours: 20 }),
      worklog({ date: "2026-05-01", memberId: "M1", hours: 30 }),
      worklog({ date: "2026-05-31", memberId: "M2", hours: 20 }),
      worklog({ date: "2026-06-10", memberId: "M2", hours: 10.5 }),
      worklog({ date: "2026-07-10", memberId: "M1", hours: 16 }),
      worklog({ date: "2026-08-10", memberId: "M1", hours: 12.25 }),
      worklog({ date: "2026-09-10", memberId: "M2", hours: 25 }),
      worklog({ date: "2026-10-26", memberId: "M1", hours: 4 }),
    ],
    worklogFetchedAt: "2026-10-27T01:00:00Z",
  });
}

describe("buildModel — 手計算の例", () => {
  const model = buildModel(workedExample(), { asOf: "2026-10-27", generatedAt: "2026-10-27T02:00:00Z" });
  const c1 = model.contracts[0];
  if (!c1) throw new Error("契約が無い");

  it("メタ情報", () => {
    expect(model.meta).toEqual({
      asOf: "2026-10-27",
      asOfMonth: "2026-10",
      lastFinalMonth: "2026-09",
      fiscalYear: 2026,
      fiscalYearMonths: ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"],
      minMonth: "2026-04",
      maxMonth: "2027-03",
      worklogFetchedAt: "2026-10-27T01:00:00Z",
      hasPriorYearData: false,
      generatedAt: "2026-10-27T02:00:00Z",
    });
    expect(model.warnings).toEqual([]);
    expect(model.unmapped).toEqual([]);
    expect(model.excludedHours).toBe(0);
  });

  it("月ごとの予算・原価・粗利・状態", () => {
    const rows = c1.months.map((m) => [m.month, m.budget, m.cost, m.grossProfit, m.status]);
    expect(rows).toEqual([
      ["2026-04", 200_000, 130_000, 70_000, "final"],
      ["2026-05", 200_000, 230_000, -30_000, "final"],
      ["2026-06", 200_000, 42_000, 158_000, "final"],
      ["2026-07", 200_000, 80_000, 120_000, "final"],
      ["2026-08", 200_000, 61_250, 138_750, "final"],
      ["2026-09", 200_000, 100_000, 100_000, "final"],
      ["2026-10", 200_000, 20_000, 180_000, "preliminary"],
      ["2026-11", 200_000, 0, 200_000, "future"],
      ["2026-12", 200_000, 0, 200_000, "future"],
      ["2027-01", 200_000, 0, 200_000, "future"],
      ["2027-02", 200_000, 0, 200_000, "future"],
      ["2027-03", 200_000, 0, 200_000, "future"],
    ]);
  });

  it("原価行と作業ログまで辿れる", () => {
    const apr = c1.months[0];
    expect(apr?.costLines).toEqual([
      { costType: "labor", memberId: "M1", memberName: "山田", hours: 10, hourlyRate: 5000, rateSource: { key: "SE", effectiveFrom: "2000-01" }, rateMissing: false, amount: 50_000, memberTeamId: "T1" },
      { costType: "labor", memberId: "M2", memberName: "鈴木", hours: 20, hourlyRate: 4000, rateSource: { key: "M2", effectiveFrom: "2000-01" }, rateMissing: false, amount: 80_000, memberTeamId: "T1" },
    ]);
    expect(apr?.worklogs.map((w) => [w.memberId, w.hourlyRate, w.amount])).toEqual([["M1", 5000, 50_000], ["M2", 4000, 80_000]]);
    expect(apr?.costs).toEqual({ labor: 130_000 });
    expect(apr?.hours).toBe(30);
    expect(apr?.budgetBreakdown).toEqual({ totalAmount: 2_400_000, monthCount: 12, baseMonthly: 200_000, remainder: 0, isLastMonth: false });
    expect(apr?.businessDays).toBe(22); // 2026-04: 30 日、土日 8 日（4,5,11,12,18,19,25,26）
  });

  it("年度集計: 予算・原価・粗利・粗利率・消化率・時間・人月", () => {
    const t = aggregate(model, { period: { from: "2026-04", to: "2027-03" } });
    expect(t.budget).toBe(2_400_000);
    expect(t.cost).toBe(663_250);
    expect(t.costs).toEqual({ labor: 663_250 });
    expect(t.grossProfit).toBe(1_736_750);
    expect(t.grossMargin).toBeCloseTo(1_736_750 / 2_400_000, 10);
    expect(t.burnRateBreakdown).toEqual({ elapsedMonths: ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"], cumulativeCost: 663_250, cumulativeBudget: 1_400_000 });
    expect(t.burnRate).toBeCloseTo(0.47375, 10);
    expect(t.isOverBudget).toBe(false);
    expect(t.hours).toBe(147.75);
    expect(t.personMonthsStandard).toBeCloseTo(0.9234375, 10);
    expect(t.includesPreliminary).toBe(true);
    expect(t.contractCount).toBe(1);
  });

  it("着地見込み 3 方式", () => {
    const { recent3, all, assignment: asg } = c1.forecasts;
    expect(recent3.targetBudget).toBe(2_400_000);
    expect(recent3.breakdown.actualCost).toBe(643_250);
    expect(recent3.breakdown.averageBasisMonths).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(recent3.breakdown.averageMonthlyCost).toBeCloseTo(241_250 / 3, 6);
    expect(recent3.breakdown.remainingCost).toBe(482_500);
    expect(recent3.forecastCost).toBe(1_125_750);
    expect(recent3.forecastGrossProfit).toBe(1_274_250);
    expect(recent3.isDeficit).toBe(false);

    expect(all.breakdown.averageBasisMonths).toHaveLength(6);
    expect(all.breakdown.remainingCost).toBe(643_250);
    expect(all.forecastCost).toBe(1_286_500);
    expect(all.forecastGrossProfit).toBe(1_113_500);

    expect(asg.breakdown.assignmentLines).toHaveLength(9); // M1 × 6 か月 + M2 × 3 か月
    expect(asg.breakdown.remainingCost).toBe(2_880_000);
    expect(asg.forecastCost).toBe(3_523_250);
    expect(asg.forecastGrossProfit).toBe(-1_123_250);
    expect(asg.isDeficit).toBe(true);

    const totals = forecastTotals(model, undefined, "assignment");
    expect(totals).toEqual({ method: "assignment", fiscalYear: 2026, period: null, targetBudget: 2_400_000, forecastCost: 3_523_250, forecastGrossProfit: -1_123_250, deficitContractIds: ["C1"], contractCount: 1 });
  });

  it("月次推移", () => {
    const series = monthlySeries(model, { period: { from: "2026-09", to: "2026-11" } });
    expect(series).toEqual([
      { month: "2026-09", status: "final", budget: 200_000, cost: 100_000, costs: { labor: 100_000 }, grossProfit: 100_000, hours: 25 },
      { month: "2026-10", status: "preliminary", budget: 200_000, cost: 20_000, costs: { labor: 20_000 }, grossProfit: 180_000, hours: 4 },
      { month: "2026-11", status: "future", budget: 200_000, cost: 0, costs: { labor: 0 }, grossProfit: 200_000, hours: 0 },
    ]);
  });

  it("チーム階層", () => {
    expect(model.rootTeamIds).toEqual(["T1"]);
    expect(model.teamTree.T1).toEqual({ teamId: "T1", name: "T1", parentTeamId: null, level: "", leaderMemberId: null, depth: 0, children: [], descendantIds: ["T1"] });
  });

  it("決定的（同じ入力から同じ出力）・JSON で往復できる", () => {
    const again = buildModel(workedExample(), { asOf: "2026-10-27", generatedAt: "2026-10-27T02:00:00Z" });
    expect(again).toEqual(model);
    expect(JSON.parse(JSON.stringify(model))).toEqual(model);
  });
});

describe("buildModel — 境界・警告", () => {
  it("asOf が確定日の前日なら前月は速報、当日なら確定", () => {
    const before = buildModel(workedExample(), { asOf: "2026-10-04" });
    const on = buildModel(workedExample(), { asOf: "2026-10-05" });
    expect(before.contracts[0]?.months[5]?.status).toBe("preliminary");
    expect(before.meta.lastFinalMonth).toBe("2026-08");
    expect(on.contracts[0]?.months[5]?.status).toBe("final");
    expect(on.meta.lastFinalMonth).toBe("2026-09");
  });

  it("asOf が不正なら例外", () => {
    expect(() => buildModel(dataset(), { asOf: "2026-13-01" })).toThrow(RangeError);
  });

  it("契約が 0 件でも動く", () => {
    const model = buildModel(dataset(), { asOf: "2026-10-27" });
    expect(model.contracts).toEqual([]);
    expect(model.meta.minMonth).toBe("2026-10");
    expect(model.meta.maxMonth).toBe("2026-10");
    expect(model.meta.hasPriorYearData).toBe(false);
    expect(typeof model.meta.generatedAt).toBe("string");
  });

  it("不正契約・重複契約は除外され警告になる。その契約を指すマッピングは「除外中」", () => {
    const ds = dataset({
      contracts: [contract({ contractId: "BAD", startMonth: "2027-01", endMonth: "2026-01" }), contract({ contractId: "C1" }), contract({ contractId: "C1", totalAmount: 1 }), contract({ contractId: "NEG", totalAmount: -1 })],
      mappings: [rule("ABC株式会社", "", "BAD")],
      worklogs: [worklog({ date: "2026-05-01", memberId: "M1", hours: 1 })],
    });
    const model = buildModel(ds, { asOf: "2026-10-27" });
    expect(model.contracts.map((c) => c.contract.contractId)).toEqual(["C1"]);
    expect(model.contracts[0]?.contract.totalAmount).toBe(2_400_000);
    expect(model.warnings.map((w) => w.code)).toEqual(["CONTRACT_INVALID", "DUPLICATE_CONTRACT_ID", "CONTRACT_INVALID", "MAPPING_EXCLUDED_CONTRACT", "UNMAPPED_WORKLOG"]);
    expect(model.unmapped[0]?.reason).toBe("EXCLUDED_CONTRACT");
  });

  it("minMonth / maxMonth は契約の最小開始月〜最大終了月", () => {
    const model = buildModel(dataset({ contracts: [contract({ contractId: "A", startMonth: "2026-06", endMonth: "2026-08" }), contract({ contractId: "B", startMonth: "2025-01", endMonth: "2025-02" }), contract({ contractId: "C", startMonth: "2027-01", endMonth: "2028-05" })] }), { asOf: "2026-10-27" });
    expect(model.meta.minMonth).toBe("2025-01");
    expect(model.meta.maxMonth).toBe("2028-05");
  });

  it("hasPriorYearData: 12 か月以上前の確定月に予算か原価があれば true", () => {
    const old = contract({ contractId: "OLD", startMonth: "2025-04", endMonth: "2026-03", totalAmount: 12 });
    expect(buildModel(dataset({ contracts: [old] }), { asOf: "2026-10-27" }).meta.hasPriorYearData).toBe(true);
    // 2025-11〜 は asOf-12 = 2025-10 より後なので対象外
    const recent = contract({ contractId: "R", startMonth: "2025-11", endMonth: "2026-10", totalAmount: 12 });
    expect(buildModel(dataset({ contracts: [recent] }), { asOf: "2026-10-27" }).meta.hasPriorYearData).toBe(false);
    // ちょうど 12 か月前（2025-10）は対象
    const edge = contract({ contractId: "E", startMonth: "2025-10", endMonth: "2025-10", totalAmount: 1 });
    expect(buildModel(dataset({ contracts: [edge] }), { asOf: "2026-10-27" }).meta.hasPriorYearData).toBe(true);
    // 予算 0・原価 0 なら false
    const zero = contract({ contractId: "Z", startMonth: "2025-04", endMonth: "2026-03", totalAmount: 0 });
    expect(buildModel(dataset({ contracts: [zero] }), { asOf: "2026-10-27" }).meta.hasPriorYearData).toBe(false);
  });

  it("単価なし → RATE_MISSING（メンバー・月ごとに 1 件、時間合算）", () => {
    const ds = dataset({
      contracts: [contract({ contractId: "C1" })],
      mappings: [rule("ABC株式会社", "", "C1")],
      members: [member({ memberId: "M1", title: "NOPE" })],
      worklogs: [worklog({ date: "2026-05-01", memberId: "M1", hours: 1 }), worklog({ date: "2026-05-02", memberId: "M1", hours: 2 }), worklog({ date: "2026-06-02", memberId: "M1", hours: 4 })],
    });
    const model = buildModel(ds, { asOf: "2026-10-27" });
    const rm = model.warnings.filter((w) => w.code === "RATE_MISSING");
    expect(rm).toHaveLength(2);
    expect(rm[0]).toMatchObject({ ref: { memberId: "M1", month: "2026-05" }, hours: 3 });
    expect(rm[1]).toMatchObject({ ref: { memberId: "M1", month: "2026-06" }, hours: 4 });
    expect(model.contracts[0]?.months[1]?.cost).toBe(0);
  });

  it("未知メンバー → UNKNOWN_MEMBER（メンバーごとに 1 件）、個人単価があれば使う", () => {
    const ds = dataset({
      contracts: [contract({ contractId: "C1" })],
      mappings: [rule("ABC株式会社", "", "C1")],
      rates: [rate("GHOST", 1000)],
      worklogs: [worklog({ date: "2026-05-01", memberId: "GHOST", hours: 1 }), worklog({ date: "2026-06-01", memberId: "GHOST", hours: 1 }), worklog({ date: "2026-06-01", memberId: "NOBODY", hours: 2 })],
    });
    const model = buildModel(ds, { asOf: "2026-10-27" });
    const codes = model.warnings.map((w) => w.code);
    expect(codes.filter((c) => c === "UNKNOWN_MEMBER")).toHaveLength(2);
    expect(codes).not.toContain("RATE_MISSING");
    expect(model.contracts[0]?.months[1]?.cost).toBe(1000);
    expect(model.contracts[0]?.months[2]?.cost).toBe(1000);
  });

  it("マスタに無い人の作業を人ごとにまとめる（§100）: 時間は案件の実績に含め、運用保守以外・未紐付けも数える", () => {
    const ds = dataset({
      contracts: [contract({ contractId: "C1", customerName: "ABC" })],
      mappings: [rule("ABC", "", "C1")],
      members: [member({ memberId: "M1" })],
      worklogs: [
        worklog({ date: "2026-05-01", memberId: "GHOST", memberName: "臨時 太郎", hours: 2, customerName: "ABC株式会社" }),
        worklog({ date: "2026-06-03", memberId: " GHOST ", memberName: "臨時 太郎", hours: 1, customerName: "XYZ", projectName: "未登録" }),
        worklog({ date: "2026-05-02", memberId: "M1", hours: 5, customerName: "ABC" }),
        worklog({ date: "2026-05-03", memberId: "NOBODY", hours: 1, customerName: "" }), // 顧客名なしは除外なので数えない
        worklog({ date: "2026-05-04", memberId: "ZERO", hours: 0 }), // 不正な時間は数えない
      ],
    });
    const model = buildModel(ds, { asOf: "2026-10-27" });
    expect(model.unknownMembers).toEqual([
      { memberId: "GHOST", memberName: "臨時 太郎", hours: 3, contractHours: 2, count: 2, firstDate: "2026-05-01", lastDate: "2026-06-03", customers: [{ name: "ABC", hours: 2 }, { name: "XYZ", hours: 1 }] },
    ]);
    // 案件の時間に入っている（単価が無いので 0 円）
    expect(model.contracts[0]?.months[1]?.hours).toBe(7);
    expect(model.contracts[0]?.months[1]?.costLines.find((l) => l.memberId === "GHOST")?.amount).toBe(0);
    expect(model.unmapped[0]?.members).toEqual([{ memberId: "GHOST", memberName: "臨時 太郎", hours: 1, count: 1 }]);
  });

  it("マスタに無い人がいなければ unknownMembers は空", () => {
    const model = buildModel(dataset({ contracts: [contract({ contractId: "C1" })], mappings: [rule("ABC株式会社", "", "C1")], members: [member({ memberId: "M1" })], worklogs: [worklog({ date: "2026-05-01", memberId: "M1", hours: 1 })] }), { asOf: "2026-10-27" });
    expect(model.unknownMembers).toEqual([]);
  });

  it("追加の原価プロバイダを差し込める", () => {
    const ds = dataset({ config: { ...workedExample().config, costTypes: [{ id: "labor", label: "工数" }, { id: "outsourcing", label: "外注費" }] }, contracts: [contract({ contractId: "C1" })] });
    const model = buildModel(ds, {
      asOf: "2026-10-27",
      extraProviders: () => [
        {
          costType: "outsourcing",
          compute: (_c, month) => ({ lines: month === "2026-05" ? [{ costType: "outsourcing", memberId: "V", memberName: "外注", hours: 0, hourlyRate: 0, rateSource: null, rateMissing: false, amount: 5000, memberTeamId: null }] : [], worklogs: [] }),
        },
      ],
    });
    const may = model.contracts[0]?.months[1];
    expect(may?.costs).toEqual({ labor: 0, outsourcing: 5000 });
    expect(may?.cost).toBe(5000);
    expect(aggregate(model, { period: { from: "2026-04", to: "2027-03" } }).costs).toEqual({ labor: 0, outsourcing: 5000 });
  });

  it("チームの警告は model.warnings に入る", () => {
    const model = buildModel(dataset({ teams: [team("A", "B"), team("B", "A")] }), { asOf: "2026-10-27" });
    expect(model.warnings.map((w) => w.code)).toEqual(["UNKNOWN_TEAM"]);
    expect(model.rootTeamIds).toEqual(["A"]);
  });
});

describe("着地見込みの対象を期間に合わせる (SPEC §54)", () => {
  it("setForecastPeriod は forecasts を期間で計算し直し、forecastTotals に期間が出る。同じ期間なら何もしない", () => {
    const model = buildModel(workedExample(), { asOf: "2026-10-27", generatedAt: "2026-10-27T02:00:00Z" });
    const fy = forecastTotals(model, undefined, "recent3");
    setForecastPeriod(model, { from: "2026-04", to: "2026-12" });
    const t = forecastTotals(model, undefined, "recent3");
    expect(t.period).toEqual({ from: "2026-04", to: "2026-12" });
    expect(forecastPeriodOf(model)).toEqual({ from: "2026-04", to: "2026-12" });
    expect(t.targetBudget).toBeLessThan(fy.targetBudget);
    const before = model.contracts[0]!.forecasts;
    setForecastPeriod(model, { from: "2026-04", to: "2026-12" });
    expect(model.contracts[0]!.forecasts).toBe(before);
    expect(Object.keys(model), "期間は JSON に出さない").not.toContain("forecastPeriod");
  });

  it("contractEndForecasts は契約の全期間を対象にする", () => {
    const model = buildModel(workedExample(), { asOf: "2026-10-27", generatedAt: "2026-10-27T02:00:00Z" });
    const r = model.contracts[0]!;
    const end = contractEndForecasts(model, r);
    expect(end.recent3.breakdown.contractMonthsInTarget[0]).toBe(r.contract.startMonth);
    expect(end.recent3.breakdown.contractMonthsInTarget.at(-1)).toBe(r.contract.endMonth);
  });
});
