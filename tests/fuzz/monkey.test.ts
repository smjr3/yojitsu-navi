/**
 * モンキーテスト: 乱数で生成した（壊れたデータを含む）Dataset に対して計算コア一式を走らせ、
 * 不変条件だけを検査する。失敗したら seed を出すので、同じ seed で再現できる。
 */
import { describe, expect, it } from "vitest";
import { aggregate, forecastTotals, monthlySeries } from "../../src/core/aggregate.js";
import { addMonths, formatYearMonth, isValidISODate, monthRange } from "../../src/core/calendar.js";
import { buildModel } from "../../src/core/model.js";
import { monthStatusFromMeta } from "../../src/core/status.js";
import type { Assignment, Config, Contract, Dataset, ForecastMethod, Holiday, MappingRule, MemberRecord, Model, RateRecord, TeamRecord, Worklog } from "../../src/core/types.js";
import { validateDataset } from "../../src/core/validate.js";
import { baseConfig } from "../unit/fixtures.js";

const SEEDS = 300;
const METHODS: ForecastMethod[] = ["recent3", "all", "assignment"];

// ---------------------------------------------------------------------------
// 乱数（mulberry32）
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)] as T;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  month(): string {
    return formatYearMonth(this.int(2024, 2027), this.int(1, 12));
  }
  date(): string {
    const d = `${this.month()}-${String(this.int(1, 31)).padStart(2, "0")}`;
    return isValidISODate(d) || this.chance(0.5) ? d : `${this.month()}-${String(this.int(1, 28)).padStart(2, "0")}`;
  }
}

// ---------------------------------------------------------------------------
// データ生成
// ---------------------------------------------------------------------------
const CUSTOMERS = ["青葉物流", "さくら製菓", "Minato Bank", "ABC", "北斗 建設"];
const PROJECTS = ["保守", "運用", "ＥＣサイト保守", "", "障害対応"];

function customerVariant(rng: Rng, base: string): string {
  return rng.pick([
    base,
    `株式会社${base}`,
    `${base}株式会社`,
    `（株）${base}`,
    `㈱${base}`,
    ` ${base}  `,
    base.normalize("NFKC").toUpperCase(),
    `${base} Co., Ltd.`,
    `${base}　株式会社`,
  ]);
}

function projectVariant(rng: Rng, base: string): string {
  if (base === "") return rng.pick(["", " ", "　"]);
  return rng.pick([base, base.toLowerCase(), `${base} `, base.normalize("NFKC"), `${base}　`]);
}

function genConfig(rng: Rng): Config {
  return {
    ...baseConfig,
    fiscalYearStartMonth: rng.chance(0.7) ? 4 : rng.int(1, 12),
    closingBusinessDay: rng.int(1, 5),
    forecastRecentMonths: rng.int(1, 4),
    burnRateDangerThreshold: rng.pick([1, 0.9, 1.1]),
  };
}

function genTeams(rng: Rng): TeamRecord[] {
  const n = rng.int(0, 7);
  const ids = Array.from({ length: n }, (_, i) => `T${i}`);
  const out: TeamRecord[] = [];
  for (const teamId of ids) {
    const rows = rng.int(1, 2);
    for (let r = 0; r < rows; r++) {
      const parent = rng.chance(0.25) ? null : rng.chance(0.1) ? teamId : rng.chance(0.1) ? "T_unknown" : rng.pick(ids);
      out.push({ teamId, name: `チーム${teamId}`, parentTeamId: parent, effectiveFrom: rng.chance(0.7) ? "2024-01" : rng.month() });
    }
  }
  // 順序をシャッフル（ファイル順に依存しない）
  return out.sort(() => rng.next() - 0.5);
}

function genMembers(rng: Rng, teams: TeamRecord[]): MemberRecord[] {
  const n = rng.int(0, 8);
  const teamIds = [...new Set(teams.map((t) => t.teamId))];
  const out: MemberRecord[] = [];
  for (let i = 0; i < n; i++) {
    const rows = rng.int(1, 3);
    for (let r = 0; r < rows; r++) {
      out.push({
        memberId: `M${i}`,
        name: `メンバー${i}`,
        kind: rng.chance(0.9) ? rng.pick(["employee", "partner"]) : ("ghost" as MemberRecord["kind"]),
        title: rng.pick(["SE", "PM", "", "顧問"]),
        department: "開発",
        section: "1課",
        teamId: teamIds.length === 0 || rng.chance(0.15) ? (rng.chance(0.5) ? null : "") : rng.chance(0.1) ? "T_unknown" : rng.pick(teamIds),
        effectiveFrom: rng.chance(0.6) ? "2024-01" : rng.month(),
      });
    }
  }
  return out.sort(() => rng.next() - 0.5);
}

function genRates(rng: Rng, members: MemberRecord[]): RateRecord[] {
  const keys = ["SE", "PM", "顧問", ...new Set(members.map((m) => m.memberId))];
  const out: RateRecord[] = [];
  for (const key of keys) {
    if (rng.chance(0.25)) continue;
    const rows = rng.int(1, 3);
    for (let r = 0; r < rows; r++) {
      out.push({ key, hourlyRate: rng.chance(0.05) ? Number.NaN : rng.int(0, 20000), effectiveFrom: rng.chance(0.6) ? "2024-01" : rng.month() });
    }
  }
  return out.sort(() => rng.next() - 0.5);
}

function genContracts(rng: Rng, teams: TeamRecord[]): Contract[] {
  const n = rng.int(0, 8);
  const teamIds = [...new Set(teams.map((t) => t.teamId))];
  const out: Contract[] = [];
  for (let i = 0; i < n; i++) {
    const startMonth = rng.month();
    const length = rng.int(-2, 24);
    const c: Contract = {
      contractId: rng.chance(0.1) && i > 0 ? `C${i - 1}` : `C${i}`,
      customerName: rng.pick(CUSTOMERS),
      projectName: rng.pick(PROJECTS),
      teamId: teamIds.length === 0 || rng.chance(0.2) ? (rng.chance(0.5) ? null : "") : rng.chance(0.1) ? "T_unknown" : rng.pick(teamIds),
      startMonth,
      endMonth: rng.chance(0.05) ? "2026-13" : addMonths(startMonth, length),
      totalAmount: rng.chance(0.05) ? Number.NaN : rng.chance(0.05) ? -100 : rng.chance(0.1) ? 0 : rng.int(0, 100_000_000),
    };
    if (rng.chance(0.3)) c.note = "メモ";
    out.push(c);
  }
  return out;
}

function genMappings(rng: Rng, contracts: Contract[]): MappingRule[] {
  const out: MappingRule[] = [];
  for (const c of contracts) {
    const rows = rng.int(0, 2);
    for (let r = 0; r < rows; r++) {
      out.push({
        worklogCustomerName: customerVariant(rng, c.customerName),
        worklogProjectName: rng.chance(0.4) ? "" : projectVariant(rng, c.projectName),
        contractId: rng.chance(0.1) ? "C_unknown" : c.contractId,
      });
    }
  }
  if (rng.chance(0.3)) out.push({ worklogCustomerName: rng.pick(CUSTOMERS), worklogProjectName: "", contractId: "C_unknown" });
  if (rng.chance(0.1)) out.push({ worklogCustomerName: "株式会社", worklogProjectName: "", contractId: contracts[0]?.contractId ?? "C0" });
  return out;
}

function genAssignments(rng: Rng, members: MemberRecord[], contracts: Contract[]): Assignment[] {
  const n = rng.int(0, 8);
  const memberIds = [...new Set(members.map((m) => m.memberId))];
  const out: Assignment[] = [];
  for (let i = 0; i < n; i++) {
    const startMonth = rng.month();
    out.push({
      memberId: memberIds.length === 0 || rng.chance(0.1) ? "M_ghost" : rng.pick(memberIds),
      contractId: contracts.length === 0 || rng.chance(0.1) ? "C_unknown" : rng.pick(contracts).contractId,
      startMonth,
      endMonth: addMonths(startMonth, rng.int(-1, 12)),
      allocation: rng.chance(0.05) ? Number.NaN : Math.round(rng.next() * 130) / 100,
    });
  }
  return out;
}

function genHolidays(rng: Rng): Holiday[] {
  const n = rng.int(0, 40);
  return Array.from({ length: n }, () => ({ date: rng.chance(0.05) ? "bad-date" : rng.date(), name: "休" }));
}

function genWorklogs(rng: Rng, members: MemberRecord[], contracts: Contract[]): Worklog[] {
  const n = rng.int(0, 250);
  const memberIds = [...new Set(members.map((m) => m.memberId))];
  const out: Worklog[] = [];
  for (let i = 0; i < n; i++) {
    const c = contracts.length > 0 && rng.chance(0.8) ? rng.pick(contracts) : null;
    const customer = rng.chance(0.05) ? rng.pick(["", " ", "株式会社", "（株）"]) : customerVariant(rng, c?.customerName ?? rng.pick(CUSTOMERS));
    const project = projectVariant(rng, c?.projectName ?? rng.pick(PROJECTS));
    const date = rng.chance(0.05) ? rng.pick(["", "2026-02-30", "garbage", "2026/05/01", "2026-5-1"]) : rng.date();
    const memberId = memberIds.length === 0 || rng.chance(0.1) ? "M_ghost" : rng.pick(memberIds);
    const hours = rng.chance(0.05) ? rng.pick([0, -1, Number.NaN, Number.POSITIVE_INFINITY]) : rng.int(1, 40) / 4;
    out.push({ date, memberId, memberName: memberId, customerName: customer, projectName: project, task: "作業", hours });
  }
  return out;
}

export function genDataset(seed: number): { dataset: Dataset; asOf: string } {
  const rng = new Rng(seed);
  const teams = genTeams(rng);
  const members = genMembers(rng, teams);
  const contracts = genContracts(rng, teams);
  const dataset: Dataset = {
    config: genConfig(rng),
    contracts,
    mappings: genMappings(rng, contracts),
    assignments: genAssignments(rng, members, contracts),
    teams,
    members,
    rates: genRates(rng, members),
    holidays: genHolidays(rng),
    worklogs: genWorklogs(rng, members, contracts),
  };
  if (rng.chance(0.5)) dataset.worklogFetchedAt = "2026-10-27T09:00:00+09:00";
  let asOf = rng.date();
  if (!isValidISODate(asOf)) asOf = "2026-10-27";
  return { dataset, asOf };
}

// ---------------------------------------------------------------------------
// 不変条件
// ---------------------------------------------------------------------------
function nonFinitePaths(value: unknown, path = "$", out: string[] = []): string[] {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) out.push(path);
  } else if (Array.isArray(value)) value.forEach((v, i) => nonFinitePaths(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) nonFinitePaths(v, `${path}.${k}`, out);
  return out;
}

function checkInvariants(seed: number, dataset: Dataset, asOf: string, model: Model): void {
  const tag = `seed=${seed} asOf=${asOf}`;
  // 全数値が有限
  expect(nonFinitePaths(model), tag).toEqual([]);

  const validIds = new Set<string>();
  for (const r of model.contracts) {
    const c = r.contract;
    expect(validIds.has(c.contractId), `${tag} 契約IDが重複`).toBe(false);
    validIds.add(c.contractId);
    expect(c.startMonth <= c.endMonth, tag).toBe(true);
    expect(Number.isFinite(c.totalAmount) && c.totalAmount >= 0, tag).toBe(true);
    // 契約の全月が揃っている
    expect(r.months.map((m) => m.month), tag).toEqual(monthRange(c.startMonth, c.endMonth));
    // 予算の合計 == 総額
    expect(r.months.reduce((a, m) => a + m.budget, 0), tag).toBe(c.totalAmount);
    for (const cm of r.months) {
      expect(cm.cost, `${tag} cost == Σamount ${cm.contractId} ${cm.month}`).toBe(cm.costLines.reduce((a, l) => a + l.amount, 0));
      expect(cm.costs["labor"], tag).toBe(cm.cost);
      expect(cm.grossProfit, tag).toBe(cm.budget - cm.cost);
      expect(Math.abs(cm.hours - cm.costLines.reduce((a, l) => a + l.hours, 0)), tag).toBeLessThan(1e-9);
      expect(Math.abs(cm.hours - cm.worklogs.reduce((a, w) => a + w.hours, 0)), tag).toBeLessThan(1e-9);
      expect(cm.status, `${tag} status ${cm.month}`).toBe(monthStatusFromMeta(cm.month, model.meta));
      expect(cm.businessDays >= 0 && cm.businessDays <= 23, tag).toBe(true);
      for (const w of cm.worklogs) {
        expect(w.contractId, tag).toBe(c.contractId);
        expect(w.date.slice(0, 7), `${tag} 作業ログの月 ${w.date} が ${cm.month} に入っている`).toBe(cm.month);
        expect(cm.month >= c.startMonth && cm.month <= c.endMonth, tag).toBe(true);
        expect(w.hours > 0, tag).toBe(true);
      }
      for (const line of cm.costLines) {
        expect(line.amount, tag).toBe(Math.round(line.hours * line.hourlyRate));
        if (line.rateMissing) expect(line.hourlyRate, tag).toBe(0);
        expect(line.memberTeamId === null || line.memberTeamId.length > 0, tag).toBe(true);
      }
    }
    // 着地見込み
    for (const method of METHODS) {
      const f = r.forecasts[method];
      expect(f.method, tag).toBe(method);
      expect(f.fiscalYear, tag).toBe(model.meta.fiscalYear);
      expect(f.forecastCost >= f.breakdown.actualCost, `${tag} forecastCost >= actualCost ${c.contractId} ${method}`).toBe(true);
      expect(f.forecastGrossProfit, tag).toBe(f.targetBudget - f.forecastCost);
      expect(f.isDeficit, tag).toBe(f.forecastGrossProfit < 0);
      expect(f.breakdown.contractMonthsInTarget, tag).toEqual(model.meta.fiscalYearMonths.filter((m) => m >= c.startMonth && m <= c.endMonth));
      expect([...f.breakdown.actualMonths, ...f.breakdown.remainingMonths], tag).toEqual(f.breakdown.contractMonthsInTarget);
      expect(f.breakdown.actualMonths.every((m) => m < model.meta.asOfMonth), tag).toBe(true);
      expect(f.breakdown.remainingMonths.every((m) => m >= model.meta.asOfMonth), tag).toBe(true);
      expect(f.targetBudget, tag).toBe(r.months.filter((m) => f.breakdown.contractMonthsInTarget.includes(m.month)).reduce((a, m) => a + m.budget, 0));
      if (f.breakdown.contractMonthsInTarget.length === 0) {
        expect(f.targetBudget, tag).toBe(0);
        expect(f.forecastCost, tag).toBe(0);
        expect(f.isDeficit, tag).toBe(false);
      }
      if (method !== "assignment") expect(f.breakdown.noActuals, tag).toBe(f.breakdown.averageBasisMonths.length === 0 && f.breakdown.contractMonthsInTarget.length > 0);
    }
  }

  // 紐付いた作業ログの総数 = 契約月に載った作業ログの総数（二重計上・取りこぼし無し）
  const placed = model.contracts.reduce((a, r) => a + r.months.reduce((b, m) => b + m.worklogs.length, 0), 0);
  const unmappedCount = model.unmapped.reduce((a, g) => a + g.count, 0);
  const excludedCount = model.warnings.find((w) => w.code === "EXCLUDED_NO_CUSTOMER")?.count ?? 0;
  const ignored = dataset.worklogs.filter((w) => !(typeof w.hours === "number" && Number.isFinite(w.hours) && w.hours > 0) || !isValidISODate(w.date)).length;
  expect(placed + unmappedCount + excludedCount + ignored, `${tag} 作業ログの行数が保存される`).toBe(dataset.worklogs.length);

  // チーム階層
  for (const [id, node] of Object.entries(model.teamTree)) {
    expect(node.teamId, tag).toBe(id);
    expect(node.descendantIds[0], tag).toBe(id);
    expect(new Set(node.descendantIds).size, `${tag} descendantIds unique ${id}`).toBe(node.descendantIds.length);
    for (const child of node.children) {
      expect(model.teamTree[child]?.parentTeamId, tag).toBe(id);
      for (const d of model.teamTree[child]!.descendantIds) expect(node.descendantIds, tag).toContain(d);
    }
    // 親をたどって必ず最上位に着く（循環なし）
    let cur: string | null = id;
    let hops = 0;
    while (cur !== null) {
      cur = model.teamTree[cur]!.parentTeamId;
      expect(++hops, `${tag} 循環 ${id}`).toBeLessThan(100);
    }
    if (node.parentTeamId === null) expect(model.rootTeamIds, tag).toContain(id);
  }
  expect(new Set(model.rootTeamIds).size, tag).toBe(model.rootTeamIds.length);
  const allDesc = model.rootTeamIds.flatMap((r) => model.teamTree[r]!.descendantIds).sort();
  expect(allDesc, `${tag} 全チームがどれかの最上位の配下`).toEqual(Object.keys(model.teamTree).sort());

  // meta
  expect(model.meta.lastFinalMonth < model.meta.asOfMonth, tag).toBe(true);
  expect(model.meta.fiscalYearMonths.length, tag).toBe(12);
  expect(model.meta.fiscalYearMonths, tag).toContain(model.meta.asOfMonth);
  expect(model.meta.minMonth <= model.meta.maxMonth, tag).toBe(true);

  // 集計
  const rng = new Rng(seed ^ 0x5eed);
  const periods = [
    { from: model.meta.minMonth, to: model.meta.maxMonth },
    { from: model.meta.fiscalYearMonths[0]!, to: model.meta.fiscalYearMonths[11]! },
    { from: rng.month(), to: rng.month() },
    { from: "2030-01", to: "2030-12" },
  ];
  const subsets = [undefined, [], model.contracts.slice(0, 2).map((r) => r.contract.contractId), ["C_unknown"]];
  for (const period of periods) {
    for (const contractIds of subsets) {
      const scope = contractIds === undefined ? { period } : { period, contractIds };
      const totals = aggregate(model, scope);
      const series = monthlySeries(model, scope);
      expect(nonFinitePaths(totals), tag).toEqual([]);
      expect(nonFinitePaths(series), tag).toEqual([]);
      expect(series.map((p) => p.month), tag).toEqual(monthRange(period.from, period.to));
      expect(totals.budget, tag).toBe(series.reduce((a, p) => a + p.budget, 0));
      expect(totals.cost, tag).toBe(series.reduce((a, p) => a + p.cost, 0));
      expect(Math.abs(totals.hours - series.reduce((a, p) => a + p.hours, 0)), tag).toBeLessThan(1e-9);
      expect(totals.grossProfit, tag).toBe(totals.budget - totals.cost);
      expect(totals.costs["labor"], tag).toBe(totals.cost);
      expect(totals.burnRate === null, `${tag} burnRate null iff 累計予算 0`).toBe(totals.burnRateBreakdown.cumulativeBudget === 0);
      expect(totals.grossMargin === null, tag).toBe(totals.budget === 0);
      expect(totals.burnRateBreakdown.elapsedMonths.every((m) => m <= model.meta.asOfMonth && m >= period.from && m <= period.to), tag).toBe(true);
      expect(totals.isOverBudget, tag).toBe(totals.burnRate !== null && totals.burnRate > model.config.burnRateDangerThreshold);
      expect(totals.includesPreliminary, tag).toBe(series.some((p) => p.status === "preliminary" && p.budget + p.cost + p.hours > 0) || totals.includesPreliminary);
      for (const p of series) expect(p.status, tag).toBe(monthStatusFromMeta(p.month, model.meta));
    }
    for (const method of METHODS) {
      const ft = forecastTotals(model, undefined, method);
      expect(nonFinitePaths(ft), tag).toEqual([]);
      expect(ft.forecastGrossProfit, tag).toBe(ft.targetBudget - ft.forecastCost);
      expect(ft.targetBudget, tag).toBe(model.contracts.reduce((a, r) => a + r.forecasts[method].targetBudget, 0));
      expect(ft.deficitContractIds, tag).toEqual(model.contracts.filter((r) => r.forecasts[method].isDeficit).map((r) => r.contract.contractId));
    }
  }
}

describe(`モンキーテスト（${SEEDS} seeds）`, () => {
  it("乱数データで例外を出さず、不変条件を満たす", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { dataset, asOf } = genDataset(seed);
      let model: Model;
      try {
        model = buildModel(dataset, { asOf, generatedAt: "2026-10-27T00:00:00Z" });
        validateDataset(dataset);
      } catch (e) {
        throw new Error(`seed=${seed} asOf=${asOf} で例外: ${String(e)}`);
      }
      checkInvariants(seed, dataset, asOf, model);
      // JSON 往復・決定性
      const json = JSON.stringify(model);
      expect(JSON.parse(json), `seed=${seed} JSON 往復`).toEqual(model);
      const again = buildModel(dataset, { asOf, generatedAt: "2026-10-27T00:00:00Z" });
      expect(JSON.stringify(again), `seed=${seed} 決定性`).toBe(json);
      // 入力順序に依存しない: 契約以外のマスタを逆順にしても同じ結果（§5 の同値は後の行が勝つので、同じ effectiveFrom が無いときのみ）
      const hasDupEff = (rows: { effectiveFrom: string }[], key: (r: { effectiveFrom: string }) => string) =>
        new Set(rows.map((r) => `${key(r)}|${r.effectiveFrom}`)).size !== rows.length;
      if (
        !hasDupEff(dataset.rates, (r) => (r as RateRecord).key) &&
        !hasDupEff(dataset.members, (r) => (r as MemberRecord).memberId)
      ) {
        const reversed: Dataset = { ...dataset, rates: [...dataset.rates].reverse(), members: [...dataset.members].reverse() };
        const m2 = buildModel(reversed, { asOf, generatedAt: "2026-10-27T00:00:00Z" });
        const strip = (m: Model) => JSON.stringify({ ...m, members: [], warnings: [] });
        expect(strip(m2), `seed=${seed} マスタの行順に依存しない`).toBe(strip(model));
      }
    }
  }, 60_000);
});
