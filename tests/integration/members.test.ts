/**
 * メンバー別（SPEC §18）をダミーデータ全体（data/, asOf=2026-10-27）で確かめる。
 * 期待値は docs/DUMMY_DATA.md のエッジケースと、計算コアとは別に書いた素朴な再計算。
 */
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { aggregate, contractsForTeam, teamTreeForMonth } from "../../src/core/aggregate.js";
import { monthRange } from "../../src/core/calendar.js";
import { aggregateMembers, memberMonthlySeries, memberRateHistory } from "../../src/core/members.js";
import { buildModel } from "../../src/core/model.js";
import { HolidaySet } from "../../src/core/holidays.js";
import type { Dataset, MemberMonth, Model, YearMonth } from "../../src/core/types.js";
import { loadDataset } from "../../scripts/lib/load.js";

const REPO = join(import.meta.dirname, "..", "..");
const AS_OF = "2026-10-27";
const FY2026 = { from: "2026-04", to: "2027-03" };
const FY2025 = { from: "2025-04", to: "2026-03" };

let ds: Dataset;
let model: Model;

const mm = (memberId: string, month: YearMonth): MemberMonth | undefined => model.memberMonths.find((m) => m.memberId === memberId && m.month === month);

/** 素朴な単価検索（計算コアとは別実装） */
function naiveRate(memberId: string, month: YearMonth): number {
  const pick = (key: string) => ds.rates.filter((r) => r.key === key && r.effectiveFrom <= month).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0)).at(-1);
  const personal = pick(memberId);
  if (personal) return personal.hourlyRate;
  const m = ds.members.filter((x) => x.memberId === memberId && x.effectiveFrom <= month).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1)).at(-1);
  return m && m.title ? (pick(m.title)?.hourlyRate ?? 0) : 0;
}

beforeAll(() => {
  ds = loadDataset(REPO).dataset;
  model = buildModel(ds, { asOf: AS_OF, generatedAt: "2026-10-27T00:00:00Z" });
});

describe("メンバー別: ダミーデータ全体", () => {
  it("Σ メンバー実績原価 = Σ 契約原価（年度・全期間・チームの契約）", () => {
    for (const period of [FY2026, FY2025, { from: model.meta.minMonth, to: model.meta.maxMonth }, { from: "2026-10", to: "2026-10" }]) {
      const agg = aggregateMembers(model, { period });
      const totals = aggregate(model, { period });
      expect(agg.total.actualCost, `${period.from}〜${period.to}`).toBe(totals.cost);
      expect(agg.total.actualHours).toBeCloseTo(totals.hours, 6);
    }
    const tree = teamTreeForMonth({ teams: model.teams }, "2026-10");
    for (const teamId of Object.keys(tree)) {
      const ids = contractsForTeam(model, teamId, tree).map((c) => c.contractId);
      expect(aggregateMembers(model, { period: FY2026, contractIds: ids }).total.actualCost, teamId).toBe(aggregate(model, { period: FY2026, contractIds: ids }).cost);
    }
  });

  it("計画は素朴な再計算（アサイン × 月の稼働時間 × 当月単価、契約期間内）と一致", () => {
    const contracts = new Map(ds.contracts.map((c) => [c.contractId, c]));
    // 月の稼働時間 = 土日と祝日を除いた日数 × 8h（§114。日付を 1 日ずつ数える素朴な実装）
    const holidays = new HolidaySet(ds.holidays);
    const naiveHours = (m: YearMonth) => {
      const [y, mo] = m.split("-").map(Number) as [number, number];
      let n = 0;
      for (let d = new Date(Date.UTC(y, mo - 1, 1)); d.getUTCMonth() === mo - 1; d = new Date(d.getTime() + 86_400_000)) {
        const dow = d.getUTCDay();
        if (dow !== 0 && dow !== 6 && !holidays.has(d.toISOString().slice(0, 10))) n++;
      }
      return n * 8;
    };
    const expected = new Map<string, number>();
    for (const a of ds.assignments) {
      const c = contracts.get(a.contractId)!;
      for (const m of monthRange(a.startMonth, a.endMonth)) {
        if (m < c.startMonth || m > c.endMonth) continue;
        const key = `${a.memberId}|${m}`;
        expected.set(key, (expected.get(key) ?? 0) + Math.round(a.allocation * naiveHours(m) * naiveRate(a.memberId, m)));
      }
    }
    let checked = 0;
    for (const x of model.memberMonths) {
      expect(x.plannedCost, `${x.memberId} ${x.month}`).toBe(expected.get(`${x.memberId}|${x.month}`) ?? 0);
      if (x.plannedCost > 0) checked++;
    }
    expect(checked).toBeGreaterThan(200);
    // 実績も素朴な単価で: メンバー・契約・月ごとに round(Σh × 単価)
    for (const x of model.memberMonths.slice(0, 200)) {
      for (const row of x.byContract) expect(row.actualCost).toBe(Math.round(row.actualHours * naiveRate(x.memberId, x.month)));
    }
  });

  it("計画値方式の残り原価 = 残り月のメンバー計画原価の合計（ダミーデータは同じメンバー×契約のアサインが 1 行ずつ）", () => {
    for (const r of model.contracts) {
      const f = r.forecasts.assignment;
      const remaining = new Set(f.breakdown.remainingMonths);
      let planned = 0;
      for (const x of model.memberMonths) {
        if (!remaining.has(x.month)) continue;
        for (const row of x.byContract) if (row.contractId === r.contract.contractId) planned += row.plannedCost;
      }
      expect(planned, r.contract.contractId).toBe(f.breakdown.remainingCost);
    }
  });

  it("M011 小林: 一般 → 主任 @2026-07 で単価 6,000 → 8,500（主任は 2026-04 改定後の単価）", () => {
    expect(mm("M011", "2026-06")).toMatchObject({ title: "一般", hourlyRate: 6000 });
    expect(mm("M011", "2026-07")).toMatchObject({ title: "主任", hourlyRate: 8500, rateSource: { key: "主任", effectiveFrom: "2026-04" } });
    const segs = memberRateHistory(ds, "M011", { from: "2025-04", to: "2027-03" });
    expect(segs.map((s) => [s.from, s.to, s.hourlyRate])).toEqual([["2025-04", "2026-06", 6000], ["2026-07", "2027-03", 8500]]);
  });

  it("主任の単価改定（8,000 → 8,500 @2026-04）: M010 の 2026-03 と 2026-04", () => {
    expect(mm("M010", "2026-03")?.hourlyRate).toBe(8000);
    expect(mm("M010", "2026-04")?.hourlyRate).toBe(8500);
  });

  it("M020 斎藤: T211 → T212 @2026-10。月ごとの所属と、基準月で決まる一覧の所属", () => {
    expect(mm("M020", "2026-09")?.teamId).toBe("T211");
    expect(mm("M020", "2026-10")?.teamId).toBe("T212");
    expect(aggregateMembers(model, { period: { from: "2026-04", to: "2026-09" }, memberIds: ["M020"] }).members[0]?.teamId).toBe("T211");
    expect(aggregateMembers(model, { period: FY2026, memberIds: ["M020"] }).members[0]?.teamId).toBe("T212");
  });

  it("M099（未登録）: 2026-06〜08 の工数が行に出る。単価 0・未登録・アサインなし", () => {
    const rows = model.memberMonths.filter((x) => x.memberId === "M099");
    expect(rows.map((x) => x.month)).toEqual(["2026-06", "2026-07", "2026-08"]);
    for (const x of rows) expect(x).toMatchObject({ memberUnknown: true, hourlyRate: 0, rateMissing: true, actualCost: 0, plannedHours: 0, teamId: null, memberName: "臨時 太郎" });
    const t = aggregateMembers(model, { period: FY2026, memberIds: ["M099"] }).members[0]!;
    expect(t.actualHours).toBeGreaterThan(0);
    expect(t.unplannedHours).toBe(t.actualHours);
    expect(t.utilization).toBeNull();
  });

  it("M025（技術顧問・単価なし）: rateMissing、原価 0", () => {
    const rows = model.memberMonths.filter((x) => x.memberId === "M025" && x.actualHours > 0);
    expect(rows.length).toBe(19);
    expect(rows.every((x) => x.rateMissing && x.actualCost === 0)).toBe(true);
    expect(aggregateMembers(model, { period: FY2026, memberIds: ["M025"] }).members[0]?.rateMissing).toBe(true);
  });

  it("C012（実績ゼロ）の M024 0.1 = 17.6h（2026-07 は営業日 22 日 = 176h）、C010（将来開始）の M013 は 2027-01〜03 の計画だけ", () => {
    const row = mm("M024", "2026-07")?.byContract.find((r) => r.contractId === "C012");
    expect(row).toMatchObject({ allocation: 0.1, plannedHours: 0.1 * 176, plannedCost: Math.round(0.1 * 176 * 6000), actualHours: 0 });
    const s = memberMonthlySeries(model, "M013", FY2026, ["C010"]);
    expect(s.filter((p) => p.plannedHours > 0).map((p) => p.month)).toEqual(["2027-01", "2027-02", "2027-03"]);
    expect(s.every((p) => p.actualHours === 0)).toBe(true);
  });

  it("他チームへの応援など、アサインの無い契約に付けた工数は未アサインとして別に出る", () => {
    const agg = aggregateMembers(model, { period: FY2026 });
    const helpers = agg.members.filter((m) => m.unplannedHours > 0 && m.plannedHours > 0);
    expect(helpers.length).toBeGreaterThan(3);
    for (const m of agg.members) {
      const viaContracts = m.byContract.filter((c) => c.assignedMonths === 0).reduce((a, c) => a + c.actualCost, 0);
      expect(m.unplannedCost).toBeGreaterThanOrEqual(viaContracts);
      expect(m.unplannedCost).toBeLessThanOrEqual(m.actualCost);
    }
    expect(agg.total.unplannedCost).toBeGreaterThan(0);
  });

  it("規模: 行数とメンバー数（model.json から外して別ファイルにする理由の記録）", () => {
    const people = new Set(model.memberMonths.map((x) => x.memberId));
    // 実運用規模のダミーデータ（約 160 人 × 19 か月）。model.json に入れると全ページが重くなるので別ファイル
    expect(people.size).toBeGreaterThanOrEqual(140);
    expect(model.memberMonths.length).toBeLessThan(5000);
  });
});
