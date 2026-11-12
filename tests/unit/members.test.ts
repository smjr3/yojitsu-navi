/**
 * メンバー別の計画と実績（SPEC §18.1）: buildMemberMonths / aggregateMembers / memberMonthlySeries / memberRateHistory
 */
import { describe, expect, it } from "vitest";
import { aggregate } from "../../src/core/aggregate.js";
import { buildModel } from "../../src/core/model.js";
import { aggregateMembers, memberBaseMonth, memberMonthlySeries, memberRateHistory, memberRecordsOf } from "../../src/core/members.js";
import type { Dataset, MemberMonth, Model } from "../../src/core/types.js";
import { assignment, contract, dataset, member, rate, rule, team, weekdayHours, worklog } from "./fixtures.js";

const AS_OF = "2026-10-27";

function build(ds: Dataset): Model {
  return buildModel(ds, { asOf: AS_OF, generatedAt: "x" });
}

function mmOf(model: Model, memberId: string, month: string): MemberMonth {
  const mm = model.memberMonths.find((m) => m.memberId === memberId && m.month === month);
  if (!mm) throw new Error(`MemberMonth ${memberId} ${month} が無い`);
  return mm;
}

/** 契約 C1（ABC 保守）に M1（SE・5,000円）が 0.5 でアサインされ、2026-05 に 70h 作業 */
function basic(overrides: Partial<Dataset> = {}): Dataset {
  return dataset({
    contracts: [contract({ contractId: "C1", customerName: "ABC株式会社", startMonth: "2026-04", endMonth: "2027-03" })],
    mappings: [rule("ABC株式会社", "", "C1")],
    members: [member({ memberId: "M1", name: "佐藤", title: "SE", teamId: "T1" })],
    rates: [rate("SE", 5000)],
    teams: [team("T1", null)],
    assignments: [assignment({ memberId: "M1", contractId: "C1", startMonth: "2026-05", endMonth: "2026-06", allocation: 0.5 })],
    worklogs: [worklog({ date: "2026-05-11", memberId: "M1", hours: 30 }), worklog({ date: "2026-05-12", memberId: "M1", hours: 40 })],
    ...overrides,
  });
}

describe("buildMemberMonths（§18.1）", () => {
  it("計画 = 配分 × 月の稼働時間（営業日 × 8h。§114）× 単価、実績 = CostLine、差額 = 計画 − 実績", () => {
    const model = build(basic());
    const may = mmOf(model, "M1", "2026-05");
    // 2026-05 は営業日 21 日（祝日なし）= 168h → 0.5 人月 = 84h
    expect(may.plannedHours).toBe(84);
    expect(may.plannedCost).toBe(420_000);
    expect(may.actualHours).toBe(70);
    expect(may.actualCost).toBe(350_000);
    expect(may.variance).toBe(70_000);
    expect(may.unplannedHours).toBe(0);
    expect(may).toMatchObject({ memberName: "佐藤", teamId: "T1", title: "SE", kind: "employee", hourlyRate: 5000, rateSource: { key: "SE", effectiveFrom: "2000-01" }, rateMissing: false, memberUnknown: false, monthHours: 168 });
    expect(may.byContract).toEqual([{ contractId: "C1", allocation: 0.5, assignmentCount: 1, plannedHours: 84, plannedCost: 420_000, actualHours: 70, actualCost: 350_000 }]);
    // 実績の無い計画だけの月も行になる
    const jun = mmOf(model, "M1", "2026-06");
    // 2026-06 は 22 日 = 176h（月ごとに営業日で変わる）
    expect(jun).toMatchObject({ monthHours: 176, plannedHours: 88, plannedCost: 440_000, actualHours: 0, actualCost: 0, variance: 440_000 });
    // アサインも実績も無い月は作らない
    expect(model.memberMonths.map((m) => m.month)).toEqual(["2026-05", "2026-06"]);
    // 実績は契約の CostLine と同じ
    const cm = model.contracts[0]!.months.find((m) => m.month === "2026-05")!;
    expect(cm.costLines[0]!.amount).toBe(may.actualCost);
  });

  it("契約期間外の月のアサインは数えない（plannedHours = 0、行も作らない）", () => {
    const model = build(
      basic({
        contracts: [contract({ contractId: "C1", customerName: "ABC株式会社", startMonth: "2026-04", endMonth: "2026-09" })],
        assignments: [assignment({ memberId: "M1", contractId: "C1", startMonth: "2026-01", endMonth: "2026-12", allocation: 0.5 })],
        worklogs: [],
      }),
    );
    expect(model.memberMonths.map((m) => m.month)).toEqual(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
    expect(model.memberMonths.map((m) => m.plannedHours)).toEqual(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"].map((m) => 0.5 * weekdayHours(m)));
  });

  it("CONTRACT_INVALID・重複で除外した契約、存在しない契約、allocation が数値でないアサインは数えない", () => {
    const model = build(
      basic({
        contracts: [
          contract({ contractId: "C1", customerName: "ABC株式会社", startMonth: "2026-04", endMonth: "2027-03" }),
          contract({ contractId: "BAD", customerName: "XYZ", startMonth: "2027-03", endMonth: "2026-04" }),
          contract({ contractId: "NEG", customerName: "XYZ", totalAmount: -1 }),
        ],
        assignments: [
          assignment({ memberId: "M1", contractId: "BAD", allocation: 0.5 }),
          assignment({ memberId: "M1", contractId: "NEG", allocation: 0.5 }),
          assignment({ memberId: "M1", contractId: "NOPE", allocation: 0.5 }),
          assignment({ memberId: "M1", contractId: "C1", allocation: Number.NaN }),
        ],
        worklogs: [],
      }),
    );
    expect(model.warnings.filter((w) => w.code === "CONTRACT_INVALID")).toHaveLength(2);
    expect(model.memberMonths).toEqual([]);
  });

  it("同じ（メンバー, 契約, 月）の配分は合計し、行ごとに 1 回だけ丸める。メンバー月の計画原価は行の丸めた額の合計", () => {
    const model = build(
      basic({
        contracts: [
          contract({ contractId: "C1", customerName: "ABC株式会社" }),
          contract({ contractId: "C2", customerName: "DEF" }),
        ],
        rates: [rate("SE", 1234)],
        assignments: [
          assignment({ memberId: "M1", contractId: "C1", startMonth: "2027-02", endMonth: "2027-02", allocation: 0.111 }),
          assignment({ memberId: "M1", contractId: "C1", startMonth: "2027-02", endMonth: "2027-02", allocation: 0.222 }),
          assignment({ memberId: "M1", contractId: "C2", startMonth: "2027-02", endMonth: "2027-02", allocation: 0.111 }),
        ],
        worklogs: [],
      }),
    );
    const mm = mmOf(model, "M1", "2027-02");
    const c1 = mm.byContract.find((r) => r.contractId === "C1")!;
    const c2 = mm.byContract.find((r) => r.contractId === "C2")!;
    expect(c1.allocation).toBeCloseTo(0.333, 10);
    expect(c1.assignmentCount).toBe(2);
    expect(c1.plannedCost).toBe(Math.round(c1.allocation * 160 * 1234)); // 2027-02 は営業日 20 日 = 160h。0.333 × 160 × 1,234 = 65,747.52 → 65,748（配分を合計してから 1 回だけ丸める）
    expect(c2.plannedCost).toBe(Math.round(0.111 * 160 * 1234)); // 21,915.84 → 21,916
    expect(mm.plannedCost).toBe(c1.plannedCost + c2.plannedCost); // 87,664（全体で丸めると 87,663）
    expect(mm.plannedCost).not.toBe(Math.round(mm.plannedHours * 1234));
  });

  it("allocation の合計が 1.0 を超えても（検証の警告のまま）そのまま計画に入る", () => {
    const model = build(
      basic({
        assignments: [
          assignment({ memberId: "M1", contractId: "C1", startMonth: "2026-05", endMonth: "2026-05", allocation: 0.8 }),
          assignment({ memberId: "M1", contractId: "C1", startMonth: "2026-05", endMonth: "2026-05", allocation: 0.7 }),
        ],
      }),
    );
    expect(mmOf(model, "M1", "2026-05").plannedHours).toBeCloseTo(1.5 * 168, 10);
  });

  it("単価改定月: 改定前の月は旧単価、改定月から新単価（計画・実績とも §6 の単価）", () => {
    const model = build(
      basic({
        rates: [rate("SE", 5000, "2025-04"), rate("SE", 5500, "2026-06")],
        assignments: [assignment({ memberId: "M1", contractId: "C1", startMonth: "2026-05", endMonth: "2026-06", allocation: 0.5 })],
        worklogs: [worklog({ date: "2026-05-11", memberId: "M1", hours: 10 }), worklog({ date: "2026-06-11", memberId: "M1", hours: 10 })],
      }),
    );
    const may = mmOf(model, "M1", "2026-05");
    const jun = mmOf(model, "M1", "2026-06");
    expect(may).toMatchObject({ hourlyRate: 5000, rateSource: { key: "SE", effectiveFrom: "2025-04" }, plannedCost: 420_000, actualCost: 50_000 });
    expect(jun).toMatchObject({ hourlyRate: 5500, rateSource: { key: "SE", effectiveFrom: "2026-06" }, plannedCost: 484_000, actualCost: 55_000 });
  });

  it("個人単価は役職単価より優先（パートナー）", () => {
    const model = build(basic({ members: [member({ memberId: "M1", kind: "partner", title: "SE" })], rates: [rate("SE", 5000), rate("M1", 7000)] }));
    expect(mmOf(model, "M1", "2026-05")).toMatchObject({ kind: "partner", hourlyRate: 7000, rateSource: { key: "M1" }, plannedCost: 588_000, actualCost: 490_000 });
  });

  it("未登録メンバー: 工数があれば行を作り、名前は作業ログの名前。個人単価が無ければ 0・rateMissing", () => {
    const model = build(basic({ worklogs: [worklog({ date: "2026-06-03", memberId: "M99", memberName: "臨時 太郎", hours: 4 })] }));
    const mm = mmOf(model, "M99", "2026-06");
    expect(mm).toMatchObject({ memberName: "臨時 太郎", memberUnknown: true, kind: null, title: null, teamId: null, hourlyRate: 0, rateMissing: true, actualHours: 4, actualCost: 0, plannedHours: 0, unplannedHours: 4 });
    expect(model.warnings.some((w) => w.code === "UNKNOWN_MEMBER" && w.ref?.memberId === "M99")).toBe(true);
    // 個人単価があればそれを使う
    const withRate = build(basic({ rates: [rate("SE", 5000), rate("M99", 3000)], worklogs: [worklog({ date: "2026-06-03", memberId: "M99", memberName: "臨時 太郎", hours: 4 })] }));
    expect(mmOf(withRate, "M99", "2026-06")).toMatchObject({ hourlyRate: 3000, rateMissing: false, actualCost: 12_000, memberUnknown: true });
  });

  it("アサインの無い契約・アサイン期間外の月の工数は unplanned（実績の内数）", () => {
    const model = build(
      basic({
        contracts: [contract({ contractId: "C1", customerName: "ABC株式会社" }), contract({ contractId: "C2", customerName: "DEF" })],
        mappings: [rule("ABC株式会社", "", "C1"), rule("DEF", "", "C2")],
        assignments: [assignment({ memberId: "M1", contractId: "C1", startMonth: "2026-05", endMonth: "2026-05", allocation: 0.5 })],
        worklogs: [
          worklog({ date: "2026-05-11", memberId: "M1", hours: 10 }),
          worklog({ date: "2026-05-11", memberId: "M1", customerName: "DEF", hours: 3 }),
          worklog({ date: "2026-07-11", memberId: "M1", hours: 2 }),
        ],
      }),
    );
    const may = mmOf(model, "M1", "2026-05");
    expect(may).toMatchObject({ actualHours: 13, unplannedHours: 3, unplannedCost: 15_000 });
    expect(may.byContract.map((r) => [r.contractId, r.assignmentCount])).toEqual([["C1", 1], ["C2", 0]]);
    expect(mmOf(model, "M1", "2026-07")).toMatchObject({ plannedHours: 0, actualHours: 2, unplannedHours: 2, unplannedCost: 10_000 });
  });

  it("配分 0 のアサインは「アサインあり」（計画 0）で、その実績は unplanned に入れない", () => {
    const model = build(basic({ assignments: [assignment({ memberId: "M1", contractId: "C1", startMonth: "2026-05", endMonth: "2026-05", allocation: 0 })] }));
    expect(mmOf(model, "M1", "2026-05")).toMatchObject({ plannedHours: 0, actualHours: 70, unplannedHours: 0 });
  });

  it("所属・役職は当月の有効レコード（異動・昇格の月で変わる）", () => {
    const model = build(
      basic({
        members: [member({ memberId: "M1", name: "佐藤", title: "SE", teamId: "T1", effectiveFrom: "2025-04" }), member({ memberId: "M1", name: "佐藤", title: "PL", teamId: "T2", effectiveFrom: "2026-06" })],
        rates: [rate("SE", 5000), rate("PL", 8000)],
      }),
    );
    expect(mmOf(model, "M1", "2026-05")).toMatchObject({ teamId: "T1", title: "SE", hourlyRate: 5000 });
    expect(mmOf(model, "M1", "2026-06")).toMatchObject({ teamId: "T2", title: "PL", hourlyRate: 8000, plannedCost: 704_000 });
  });

  it("並びは memberId → month、byContract は contractId 昇順（入力順に依らない）", () => {
    const ds = basic({
      contracts: [contract({ contractId: "C2", customerName: "DEF" }), contract({ contractId: "C1", customerName: "ABC株式会社" })],
      members: [member({ memberId: "M2" }), member({ memberId: "M1" })],
      assignments: [
        assignment({ memberId: "M2", contractId: "C2", startMonth: "2026-05", endMonth: "2026-05" }),
        assignment({ memberId: "M1", contractId: "C2", startMonth: "2026-06", endMonth: "2026-06" }),
        assignment({ memberId: "M1", contractId: "C1", startMonth: "2026-06", endMonth: "2026-06" }),
        assignment({ memberId: "M1", contractId: "C1", startMonth: "2026-05", endMonth: "2026-05" }),
      ],
      worklogs: [],
    });
    const model = build(ds);
    expect(model.memberMonths.map((m) => `${m.memberId}@${m.month}`)).toEqual(["M1@2026-05", "M1@2026-06", "M2@2026-05"]);
    expect(mmOf(model, "M1", "2026-06").byContract.map((r) => r.contractId)).toEqual(["C1", "C2"]);
  });
});

describe("aggregateMembers（期間・チームで合算）", () => {
  const ds = () =>
    basic({
      contracts: [contract({ contractId: "C1", customerName: "ABC株式会社" }), contract({ contractId: "C2", customerName: "DEF" })],
      mappings: [rule("ABC株式会社", "", "C1"), rule("DEF", "", "C2")],
      members: [
        member({ memberId: "M1", name: "佐藤", teamId: "T1" }),
        member({ memberId: "M2", name: "鈴木", teamId: "T2", effectiveFrom: "2025-04" }),
        member({ memberId: "M2", name: "鈴木", teamId: "T1", effectiveFrom: "2026-09" }),
      ],
      teams: [team("T0", null), team("T1", "T0"), team("T2", "T0")],
      assignments: [
        assignment({ memberId: "M1", contractId: "C1", startMonth: "2026-04", endMonth: "2026-09", allocation: 0.5 }),
        assignment({ memberId: "M2", contractId: "C2", startMonth: "2026-04", endMonth: "2026-09", allocation: 0.25 }),
      ],
      worklogs: [
        worklog({ date: "2026-05-11", memberId: "M1", hours: 70 }),
        worklog({ date: "2026-05-11", memberId: "M1", customerName: "DEF", hours: 10 }),
        worklog({ date: "2026-10-01", memberId: "M2", customerName: "DEF", hours: 8 }),
      ],
    });

  it("期間内の行を合算し、稼働率 = 実績時間 ÷ 計画時間", () => {
    const model = build(ds());
    const agg = aggregateMembers(model, { period: { from: "2026-04", to: "2026-06" } });
    expect(agg.members.map((m) => m.memberId)).toEqual(["M1", "M2"]);
    const m1 = agg.members[0]!;
    // 0.5 人月 × (176 + 168 + 176)h = 260h
    expect(m1).toMatchObject({ plannedHours: 260, plannedCost: 1_300_000, actualHours: 80, actualCost: 400_000, variance: 900_000, unplannedHours: 10, unplannedCost: 50_000, months: ["2026-04", "2026-05", "2026-06"] });
    expect(m1.utilization).toBeCloseTo(80 / 260, 12);
    expect(m1.byContract.map((c) => [c.contractId, c.assignedMonths, c.plannedHours, c.actualHours])).toEqual([["C1", 3, 260, 70], ["C2", 0, 0, 10]]);
    expect(m1.byContract[1]!.utilization).toBeNull();
    expect(agg.total).toMatchObject({ memberCount: 2, plannedHours: 260 + 130, actualHours: 80, actualCost: 400_000, plannedCost: 1_300_000 + 650_000 });
    expect(agg.total.variance).toBe(agg.total.plannedCost - agg.total.actualCost);
  });

  it("所属チームは基準月 = min(期間の終了月, asOf 月) の値。teamIds で絞る", () => {
    const model = build(ds());
    // 2026-04〜06: M2 は T2
    const early = aggregateMembers(model, { period: { from: "2026-04", to: "2026-06" }, teamIds: ["T1"] });
    expect(early.baseMonth).toBe("2026-06");
    expect(early.members.map((m) => m.memberId)).toEqual(["M1"]);
    // 2026-04〜2027-03: 基準月は asOf 月 2026-10、M2 は T1 に異動済み
    const fy = aggregateMembers(model, { period: { from: "2026-04", to: "2027-03" }, teamIds: ["T1"] });
    expect(fy.baseMonth).toBe("2026-10");
    expect(fy.members.map((m) => [m.memberId, m.teamId])).toEqual([["M1", "T1"], ["M2", "T1"]]);
    // 上位チーム（配下を含めて）
    expect(aggregateMembers(model, { period: { from: "2026-04", to: "2026-06" }, teamIds: ["T0", "T1", "T2"] }).members).toHaveLength(2);
    expect(memberBaseMonth(model, { from: "2025-01", to: "2025-03" })).toBe("2025-03");
  });

  it("未所属・未登録メンバーは includeNoTeam のときだけチーム絞り込みに入る", () => {
    const model = build(basic({ worklogs: [worklog({ date: "2026-06-03", memberId: "M99", hours: 4 })] }));
    const period = { from: "2026-04", to: "2027-03" };
    expect(aggregateMembers(model, { period, teamIds: ["T1"] }).members.map((m) => m.memberId)).toEqual(["M1"]);
    expect(aggregateMembers(model, { period, teamIds: [], includeNoTeam: true }).members.map((m) => m.memberId)).toEqual(["M99"]);
    const m99 = aggregateMembers(model, { period }).members.find((m) => m.memberId === "M99")!;
    expect(m99).toMatchObject({ memberUnknown: true, teamId: null, rateMissing: true, utilization: null });
  });

  it("contractIds で契約を絞ると、その契約の行だけで数える。memberIds でメンバーを絞る", () => {
    const model = build(ds());
    const period = { from: "2026-04", to: "2026-12" };
    const onlyC2 = aggregateMembers(model, { period, contractIds: ["C2"] });
    expect(onlyC2.members.map((m) => [m.memberId, m.actualHours, m.plannedHours])).toEqual([["M1", 10, 0], ["M2", 8, 0.25 * (176 + 168 + 176 + 184 + 168 + 176)]]);
    expect(aggregateMembers(model, { period, memberIds: ["M2"] }).members.map((m) => m.memberId)).toEqual(["M2"]);
  });

  it("実績に速報月を含むと includesPreliminary（asOf 2026-10-27 は 2026-10 が速報）", () => {
    const model = build(ds());
    const agg = aggregateMembers(model, { period: { from: "2026-04", to: "2027-03" } });
    expect(agg.members.find((m) => m.memberId === "M2")!.includesPreliminary).toBe(true);
    expect(agg.members.find((m) => m.memberId === "M1")!.includesPreliminary).toBe(false);
  });

  it("期間に何も無ければ空", () => {
    const model = build(ds());
    const agg = aggregateMembers(model, { period: { from: "2020-01", to: "2020-12" } });
    expect(agg.members).toEqual([]);
    expect(agg.total).toMatchObject({ memberCount: 0, plannedHours: 0, actualCost: 0, utilization: null });
  });

  it("Σ メンバーの実績原価 = 契約原価の合計（同じ期間・同じ契約集合）", () => {
    const model = build(ds());
    const period = { from: "2026-04", to: "2027-03" };
    expect(aggregateMembers(model, { period }).total.actualCost).toBe(aggregate(model, { period }).cost);
    expect(aggregateMembers(model, { period, contractIds: ["C2"] }).total.actualCost).toBe(aggregate(model, { period, contractIds: ["C2"] }).cost);
  });

  it("JSON で往復した Model（画面と同じ）でも同じ結果", () => {
    const model = build(ds());
    const plain = JSON.parse(JSON.stringify(model)) as Model;
    const period = { from: "2026-04", to: "2027-03" };
    expect(aggregateMembers(plain, { period, teamIds: ["T1"] })).toEqual(aggregateMembers(model, { period, teamIds: ["T1"] }));
  });
});

describe("memberMonthlySeries", () => {
  it("期間の全月（データの無い月は 0、状態は asOf 基準）", () => {
    const model = build(basic());
    const s = memberMonthlySeries(model, "M1", { from: "2026-04", to: "2026-07" });
    expect(s.map((p) => [p.month, p.plannedHours, p.actualHours, p.status])).toEqual([
      ["2026-04", 0, 0, "final"],
      ["2026-05", 84, 70, "final"],
      ["2026-06", 88, 0, "final"],
      ["2026-07", 0, 0, "final"],
    ]);
    expect(s[1]!.utilization).toBeCloseTo(70 / 84, 12);
    expect(s[0]!.utilization).toBeNull();
    const sum = s.reduce((a, p) => a + p.plannedCost - p.actualCost, 0);
    expect(sum).toBe(aggregateMembers(model, { period: { from: "2026-04", to: "2026-07" } }).members[0]!.variance);
  });
});

describe("memberRateHistory / memberRecordsOf", () => {
  it("同じ単価・出どころ・役職の月をまとめ、入社前の月は飛ばす", () => {
    const ds = basic({
      members: [member({ memberId: "M1", title: "SE", effectiveFrom: "2025-10" }), member({ memberId: "M1", title: "PL", effectiveFrom: "2026-07" })],
      rates: [rate("SE", 5000, "2025-04"), rate("SE", 5500, "2026-04"), rate("PL", 8000, "2025-04")],
    });
    const segs = memberRateHistory(ds, "M1", { from: "2025-04", to: "2026-12" });
    expect(segs.map((s) => [s.from, s.to, s.hourlyRate, s.title, s.rateSource?.effectiveFrom])).toEqual([
      ["2025-10", "2026-03", 5000, "SE", "2025-04"],
      ["2026-04", "2026-06", 5500, "SE", "2026-04"],
      ["2026-07", "2026-12", 8000, "PL", "2025-04"],
    ]);
    // 未登録メンバーは全期間（単価なし）
    expect(memberRateHistory(ds, "M99", { from: "2026-01", to: "2026-03" })).toEqual([{ from: "2026-01", to: "2026-03", hourlyRate: 0, rateSource: null, rateMissing: true, title: null }]);
    expect(memberRecordsOf(ds as unknown as Model, "M1").map((m) => m.effectiveFrom)).toEqual(["2025-10", "2026-07"]);
  });
});
