/**
 * リポジトリの data/（ダミーデータ, seed=42, asOf=2026-10-27）に計算コアをかけ、
 * docs/DUMMY_DATA.md の期待値と、手計算（独立に書いた素朴な再計算）で突き合わせる。
 */
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { aggregate, contractsForTeam, forecastTotals, teamTreeForMonth, UNASSIGNED_TEAM_ID } from "../../src/core/aggregate.js";
import { closingDateOf, isValidISODate, monthRange } from "../../src/core/calendar.js";
import { mapWorklogs } from "../../src/core/mapping.js";
import { buildModel } from "../../src/core/model.js";
import type { ContractResult, Dataset, Model, YearMonth } from "../../src/core/types.js";
import { hasErrors, validateDataset } from "../../src/core/validate.js";
import { loadDataset } from "../../scripts/lib/load.js";

const REPO = join(import.meta.dirname, "..", "..");
/** 手で作った基本シナリオの契約（DUMMY_DATA.md の前半）。実運用規模の部分は C101 から */
const BASE_IDS = new Set(Array.from({ length: 21 }, (_, i) => `C${String(i + 1).padStart(3, "0")}`));
const AS_OF = "2026-10-27";

let ds: Dataset;
let model: Model;
const byId = (id: string): ContractResult => {
  const r = model.contracts.find((c) => c.contract.contractId === id);
  if (!r) throw new Error(`契約 ${id} が無い`);
  return r;
};
const countBy = (codes: string[]): Record<string, number> => codes.reduce<Record<string, number>>((a, c) => ((a[c] = (a[c] ?? 0) + 1), a), {});

/** 素朴な単価検索（計算コアとは別実装）: 個人単価 → 当月の役職の単価 → 0 */
function naiveRate(memberId: string, month: YearMonth): number {
  const pick = (key: string) =>
    ds.rates
      .filter((r) => r.key === key && r.effectiveFrom <= month)
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0))
      .at(-1);
  const personal = pick(memberId);
  if (personal) return personal.hourlyRate;
  const member = ds.members
    .filter((m) => m.memberId === memberId && m.effectiveFrom <= month)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))
    .at(-1);
  if (!member || member.title === "") return 0;
  return pick(member.title)?.hourlyRate ?? 0;
}

/** 顧客名の正規表現で作業ログを拾い、月ごとの原価を素朴に再計算する（メンバーごとに round(Σhours × 単価)） */
const OUTSIDE_TASKS = new Set(["提案", "運用設計", "見積"]);

function naiveMonthlyCost(customer: RegExp, month: YearMonth): { cost: number; hours: number; rows: number } {
  // 契約外の作業種別（task-types.csv で「契約外」。SPEC §30）は契約の実績に入らない
  const rows = ds.worklogs.filter((w) => customer.test(w.customerName) && isValidISODate(w.date) && w.date.startsWith(month) && Number.isFinite(w.hours) && w.hours > 0 && !OUTSIDE_TASKS.has(w.task));
  const hoursByMember = new Map<string, number>();
  for (const w of rows) hoursByMember.set(w.memberId, (hoursByMember.get(w.memberId) ?? 0) + w.hours);
  let cost = 0;
  for (const [memberId, hours] of hoursByMember) cost += Math.round(hours * naiveRate(memberId, month));
  return { cost, hours: rows.reduce((a, w) => a + w.hours, 0), rows: rows.length };
}

beforeAll(() => {
  const loaded = loadDataset(REPO);
  ds = loaded.dataset;
  model = buildModel(ds, { asOf: AS_OF, generatedAt: "2026-10-27T00:00:00Z" });
});

describe("検証（DUMMY_DATA.md「検証結果の期待値」）", () => {
  it("エラー 0 件、警告の内訳が一致する", () => {
    const issues = validateDataset(ds);
    expect(hasErrors(issues)).toBe(false);
    expect(countBy(issues.map((i) => i.code))).toEqual({
      WORKLOG_INVALID_HOURS: 1,
      UNMAPPED_WORKLOG: 4,
      EXCLUDED_NO_CUSTOMER: 1,
      UNKNOWN_MEMBER: 1,
      RATE_MISSING: 19 * 3,
      MEMBER_RATE_UNDEFINED: 3,
      TASK_UNCLASSIFIED: 1,
      WORKLOG_AFTER_LEFT: 1,
      ASSIGNMENT_AFTER_LEFT: 1,
    });
    // 分類表に無い作業種別は「勉強会」だけ（わざと載せていない）
    expect(issues.find((i) => i.code === "TASK_UNCLASSIFIED")?.ref?.task).toBe("勉強会");
    // 単価の無い役職: 技術顧問（基本シナリオ M025）・専門職（実運用規模の 1 人）・パートナー（個人単価の無いパートナー 1 人）
    expect(issues.filter((i) => i.code === "MEMBER_RATE_UNDEFINED").map((i) => i.ref?.title).sort()).toEqual(["パートナー", "専門職", "技術顧問"]);
    expect(issues.find((i) => i.code === "UNKNOWN_MEMBER")?.ref?.memberId).toBe("M099");
    // 単価なしの 3 人は、どの人も全 19 か月
    const missing = issues.filter((i) => i.code === "RATE_MISSING");
    const byMember = new Map<string, string[]>();
    for (const i of missing) byMember.set(String(i.ref?.memberId), [...(byMember.get(String(i.ref?.memberId)) ?? []), String(i.ref?.month)]);
    expect(byMember.size).toBe(3);
    expect(byMember.has("M025")).toBe(true);
    for (const months of byMember.values()) expect(months.sort()).toEqual(monthRange("2025-04", "2026-10"));
    // 退職（§35）: 退職後の工数 1 人・退職後のアサイン 1 人。どちらも status=退職 の行を持つ人
    const left = new Set(ds.members.filter((m) => m.status === "left").map((m) => m.memberId));
    expect(left.size).toBeGreaterThanOrEqual(12);
    for (const code of ["WORKLOG_AFTER_LEFT", "ASSIGNMENT_AFTER_LEFT"]) expect(left.has(String(issues.find((i) => i.code === code)?.ref?.memberId))).toBe(true);
  });

  it("Model の警告も同じ内訳。除外時間は顧客名が空の行の合計と一致", () => {
    expect(countBy(model.warnings.map((w) => w.code))).toEqual({ EXCLUDED_NO_CUSTOMER: 1, UNMAPPED_WORKLOG: 4, UNKNOWN_MEMBER: 1, RATE_MISSING: 19 * 3, TASK_UNCLASSIFIED: 1 });
    const expected = ds.worklogs.filter((w) => w.customerName.trim() === "" && w.hours > 0 && isValidISODate(w.date)).reduce((a, w) => a + w.hours, 0);
    expect(expected).toBeGreaterThan(1000); // 基本シナリオ約 330 時間 ＋ 実運用規模の部分
    expect(model.excludedHours).toBe(expected);
    expect(model.warnings.find((w) => w.code === "EXCLUDED_NO_CUSTOMER")?.hours).toBe(expected);
  });

  it("未紐付けは 4 グループ（社内/勉強会、社内/技術ナレッジ共有会、もみじ不動産、やまびこ通信 = OUT_OF_PERIOD 2h × 1 件 @2026-10-21）", () => {
    const groups = model.unmapped.map((u) => [u.customerName, u.projectName, u.reason]).sort();
    expect(groups).toEqual([
      ["もみじ不動産", "営業支援ツール検討", "NO_RULE"],
      ["やまびこ通信株式会社", "ネットワーク監視", "OUT_OF_PERIOD"],
      ["社内", "勉強会", "NO_RULE"],
      ["社内", "技術ナレッジ共有会", "NO_RULE"],
    ]);
    const c010 = model.unmapped.find((u) => u.reason === "OUT_OF_PERIOD")!;
    expect(c010).toMatchObject({ hours: 2, count: 1, firstDate: "2026-10-21", lastDate: "2026-10-21" });
    // 2027-01 開始の C010 には 2026-10 の月が無い
    expect(byId("C010").months[0]!.month).toBe("2027-01");
  });

  it("hours = 0 の行（2026-05-12, M014, ひまわり食品）は無視され、どの契約にも載らない", () => {
    const zero = ds.worklogs.filter((w) => w.hours === 0);
    expect(zero).toHaveLength(1);
    expect(zero[0]).toMatchObject({ date: "2026-05-12", memberId: "M014" });
    const placed = model.contracts.flatMap((r) => r.months.flatMap((m) => m.worklogs)).filter((w) => w.date === "2026-05-12" && w.memberId === "M014" && w.hours === 0);
    expect(placed).toHaveLength(0);
  });
});

describe("C005: 38,000,000 円 / 12 か月（§3 手計算）", () => {
  it("基本額 3,166,666、端数 8 を最終月 2027-03 に乗せ、合計は総額に一致", () => {
    const r = byId("C005");
    expect(r.contract.totalAmount).toBe(38_000_000);
    expect(r.months).toHaveLength(12);
    const base = Math.floor(38_000_000 / 12); // 3,166,666.66… → 3,166,666
    expect(base).toBe(3_166_666);
    const remainder = 38_000_000 - base * 12; // 38,000,000 − 37,999,992 = 8
    expect(remainder).toBe(8);
    for (const m of r.months.slice(0, 11)) {
      expect(m.budget).toBe(3_166_666);
      expect(m.budgetBreakdown).toEqual({ totalAmount: 38_000_000, monthCount: 12, baseMonthly: 3_166_666, remainder: 8, isLastMonth: false });
    }
    const last = r.months[11]!;
    expect(last.month).toBe("2027-03");
    expect(last.budget).toBe(3_166_674);
    expect(last.budgetBreakdown.isLastMonth).toBe(true);
    expect(r.months.reduce((a, m) => a + m.budget, 0)).toBe(38_000_000);
    // FY2026 の着地予算も総額と一致（契約期間 = 年度）
    expect(r.forecasts.recent3.fyBudget).toBe(38_000_000);
  });
});

describe("C008: こもれび出版（赤字見込み）の手計算", () => {
  it("月次原価は作業ログ × 単価の素朴な再計算と一致する", () => {
    const r = byId("C008");
    for (const month of monthRange("2026-04", "2026-10")) {
      const naive = naiveMonthlyCost(/こもれび出版/, month);
      const cm = r.months.find((m) => m.month === month)!;
      expect(cm.cost, month).toBe(naive.cost);
      expect(cm.hours, month).toBeCloseTo(naive.hours, 9);
      expect(cm.worklogs, month).toHaveLength(naive.rows);
      expect(cm.cost).toBeGreaterThan(0);
    }
    for (const month of monthRange("2026-11", "2027-03")) expect(r.months.find((m) => m.month === month)!.cost).toBe(0);
  });

  it("recent3: 直近 3 か月（07〜09）平均 × 残り 6 か月。予算 6,000,000 を超えて赤字", () => {
    const r = byId("C008");
    const cost = (m: string) => r.months.find((x) => x.month === m)!.cost;
    const actual = cost("2026-04") + cost("2026-05") + cost("2026-06") + cost("2026-07") + cost("2026-08") + cost("2026-09");
    const avg = (cost("2026-07") + cost("2026-08") + cost("2026-09")) / 3;
    const remaining = Math.round(avg * 6); // 2026-10, 11, 12, 2027-01, 02, 03
    const f = r.forecasts.recent3;
    expect(f.breakdown.actualMonths).toEqual(monthRange("2026-04", "2026-09"));
    expect(f.breakdown.remainingMonths).toEqual(monthRange("2026-10", "2027-03"));
    expect(f.breakdown.averageBasisMonths).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(f.breakdown.actualCost).toBe(actual);
    expect(f.breakdown.averageMonthlyCost).toBe(avg);
    expect(f.breakdown.remainingCost).toBe(remaining);
    expect(f.fyBudget).toBe(6_000_000);
    expect(f.forecastCost).toBe(actual + remaining);
    expect(f.forecastGrossProfit).toBe(6_000_000 - actual - remaining);
    expect(f.forecastGrossProfit).toBeLessThan(0);
    expect(f.isDeficit).toBe(true);
    // 消化率も 100% 超（4〜10 月の累計原価 ÷ 累計予算 3,500,000）
    const t = aggregate(model, { period: { from: "2026-04", to: "2027-03" }, contractIds: ["C008"] });
    expect(t.burnRateBreakdown.cumulativeBudget).toBe(500_000 * 7);
    expect(t.burnRate).toBeCloseTo((actual + cost("2026-10")) / 3_500_000, 12);
    expect(t.isOverBudget).toBe(true);
  });

  it("all 方式は 04〜09 の 6 か月平均。forecastTotals の赤字契約は C008 のみ", () => {
    const r = byId("C008");
    const f = r.forecasts.all;
    expect(f.breakdown.averageBasisMonths).toEqual(monthRange("2026-04", "2026-09"));
    expect(f.breakdown.remainingCost).toBe(Math.round((f.breakdown.actualCost / 6) * 6));
    expect(f.isDeficit).toBe(true);
    // 基本シナリオ（C001〜C021）の超過は C008 だけ。実運用規模の部分は 3 割前後が超過（DUMMY_DATA.md）
    const base = (ids: string[]) => ids.filter((id) => BASE_IDS.has(id));
    expect(base(forecastTotals(model, undefined, "recent3").deficitContractIds)).toEqual(["C008"]);
    expect(base(forecastTotals(model, undefined, "all").deficitContractIds)).toEqual(["C008"]);
    // assignment 方式では C013（月 10,000 円の予算）も赤字: M016 の配分 0.05 × 160h = 8h × 一般 6,000 円 = 48,000 円/月 × 残り 6 か月
    expect(base(forecastTotals(model, undefined, "assignment").deficitContractIds)).toEqual(["C008", "C013"]);
    const fy = model.contracts.filter((r) => r.forecasts.recent3.fyBudget > 0);
    const deficit = forecastTotals(model, undefined, "recent3").deficitContractIds.length;
    expect(deficit / fy.length).toBeGreaterThan(0.2);
    expect(deficit / fy.length).toBeLessThan(0.5);
    const c013 = byId("C013").forecasts.assignment;
    expect(c013.breakdown.assignmentLines).toHaveLength(6);
    expect(c013.breakdown.assignmentLines.every((l) => l.memberId === "M016" && l.allocation === 0.05 && l.hours === 8 && l.hourlyRate === 6000 && l.amount === 48_000)).toBe(true);
    expect(c013.breakdown.remainingCost).toBe(48_000 * 6);
    expect(c013.fyBudget).toBe(120_000);
    // 前年度 C015（9,000,000）は黒字（FY2026 には掛からないので fyBudget 0）
    expect(byId("C015").forecasts.recent3).toMatchObject({ fyBudget: 0, forecastCost: 0, isDeficit: false });
  });
});

describe("C003 → C004 更新契約（同じ顧客・案件名、期間で振り分け）", () => {
  it("2026-09 のみなと銀行の作業ログは全部 C003、2026-10 は全部 C004", () => {
    const c003 = byId("C003");
    const c004 = byId("C004");
    expect(c003.contract.endMonth).toBe("2026-09");
    expect(c004.contract.startMonth).toBe("2026-10");
    const sep = naiveMonthlyCost(/みなと銀行/, "2026-09");
    const oct = naiveMonthlyCost(/みなと銀行/, "2026-10");
    expect(sep.rows).toBeGreaterThan(0);
    expect(oct.rows).toBeGreaterThan(0);
    const c003sep = c003.months.find((m) => m.month === "2026-09")!;
    const c004oct = c004.months.find((m) => m.month === "2026-10")!;
    expect(c003sep.worklogs).toHaveLength(sep.rows);
    expect(c003sep.hours).toBe(sep.hours);
    expect(c003sep.cost).toBe(sep.cost);
    expect(c004oct.worklogs).toHaveLength(oct.rows);
    expect(c004oct.hours).toBe(oct.hours);
    expect(c004oct.cost).toBe(oct.cost);
    // 境界: C003 に 2026-10 は無く、C004 に 2026-09 は無い
    expect(c003.months.some((m) => m.month === "2026-10")).toBe(false);
    expect(c004.months.some((m) => m.month === "2026-09")).toBe(false);
    // 曖昧警告は出ない（期間が重ならない）
    expect(model.warnings.some((w) => w.code === "MAPPING_AMBIGUOUS")).toBe(false);
  });

  it("mapWorklogs 単体でも 9/30 → C003、10/1 → C004（案件名が空のルールで顧客全体を拾う）", () => {
    const rows = ds.worklogs.filter((w) => /みなと銀行/.test(w.customerName) && (w.date === "2026-09-30" || w.date === "2026-10-01"));
    expect(rows.length).toBeGreaterThan(0);
    const res = mapWorklogs(rows, ds.mappings, ds.contracts);
    for (const m of res.mappings) {
      expect(m.kind).toBe("assigned");
      if (m.kind === "assigned") expect(m.contractId).toBe(m.worklog.date === "2026-09-30" ? "C003" : "C004");
    }
    // C004 は 2026-10 が最初の月なので recent3 の基礎月は無い（noActuals）
    expect(byId("C004").forecasts.recent3.breakdown).toMatchObject({ noActuals: true, averageBasisMonths: [], remainingCost: 0 });
  });
});

describe("マスタ履歴（DUMMY_DATA.md のエッジケース）", () => {
  const lineOf = (month: string, memberId: string) => {
    for (const r of model.contracts) for (const m of r.months) if (m.month === month) for (const l of m.costLines) if (l.memberId === memberId) return l;
    throw new Error(`${month} ${memberId} の原価行が無い`);
  };
  it("M011 は 2026-07 に昇格: 06 は一般 6,000、07 から主任 8,500（2026-04 改定後の単価）", () => {
    expect(lineOf("2026-06", "M011").hourlyRate).toBe(6000);
    expect(lineOf("2026-07", "M011")).toMatchObject({ hourlyRate: 8500, rateSource: { key: "主任", effectiveFrom: "2026-04" } });
    // 2025 年度の主任は 8,000
    const chief2025 = model.contracts.flatMap((r) => r.months).filter((m) => m.month === "2025-06").flatMap((m) => m.costLines).find((l) => l.rateSource?.key === "主任");
    expect(chief2025?.hourlyRate).toBe(8000);
  });
  it("M020 は 2026-10 に T211 → T212 へ異動（memberTeamId が変わる）", () => {
    expect(lineOf("2026-09", "M020").memberTeamId).toBe("T211");
    expect(lineOf("2026-10", "M020").memberTeamId).toBe("T212");
  });
  it("M025（技術顧問）は単価なし → 0 円、M099 は未知メンバー", () => {
    expect(lineOf("2026-10", "M025")).toMatchObject({ hourlyRate: 0, rateMissing: true, amount: 0 });
    expect(lineOf("2026-07", "M099")).toMatchObject({ hourlyRate: 0, rateMissing: true, amount: 0, memberTeamId: null, memberName: "臨時 太郎" });
    expect(model.warnings.find((w) => w.code === "UNKNOWN_MEMBER")?.ref?.memberId).toBe("M099");
  });
  it("T212 は asOf（2026-10）では S22 配下、2026-09 の組織では S21 配下", () => {
    expect(model.teamTree["T212"]?.parentTeamId).toBe("S22");
    expect(teamTreeForMonth(ds, "2026-09")["T212"]?.parentTeamId).toBe("S21");
    expect(model.rootTeamIds).toEqual(["HQ"]);
    expect(model.teamTree["HQ"]?.descendantIds).toHaveLength(Object.keys(model.teamTree).length);
    // 中間ノード S21 の契約 = T211 配下の契約（asOf の組織では T212 は含まない）
    expect(contractsForTeam(model, "S21").map((c) => c.contractId).sort()).toEqual(["C005", "C008", "C014", "C015"]);
    expect(contractsForTeam(model, "S22").map((c) => c.contractId)).toContain("C007");
    // 主担当チーム未設定は C009（基本シナリオ）と実運用規模の部分の 1 件
    const unassigned = contractsForTeam(model, UNASSIGNED_TEAM_ID).map((c) => c.contractId);
    expect(unassigned).toHaveLength(2);
    expect(unassigned[0]).toBe("C009");
    expect(contractsForTeam(model, "HQ")).toHaveLength(model.contracts.length - unassigned.length);
  });
});

describe("月の状態・年度（asOf = 2026-10-27）", () => {
  it("2026-09 の確定日は 2026-10-05（10/1 木・10/2 金・10/5 月）なので 09 は確定、10 は速報", () => {
    expect(closingDateOf("2026-09", ds.config, ds.holidays)).toBe("2026-10-05");
    expect(model.meta.lastFinalMonth).toBe("2026-09");
    expect(model.meta.asOfMonth).toBe("2026-10");
    expect(model.meta.fiscalYear).toBe(2026);
    expect(model.meta.fiscalYearMonths).toEqual(monthRange("2026-04", "2027-03"));
    const c007 = byId("C007");
    expect(c007.months.find((m) => m.month === "2026-09")!.status).toBe("final");
    expect(c007.months.find((m) => m.month === "2026-10")!.status).toBe("preliminary");
    expect(c007.months.find((m) => m.month === "2026-11")!.status).toBe("future");
  });
  it("C007（24 か月）の FY2026 予算は 4,000,000 × 12、C012（実績ゼロ）は基礎月があるので noActuals ではない", () => {
    const c007 = byId("C007");
    expect(c007.months.every((m) => m.budget === 4_000_000)).toBe(true);
    expect(c007.forecasts.recent3.fyBudget).toBe(48_000_000);
    expect(c007.forecasts.recent3.breakdown.averageBasisMonths).toEqual(["2026-07", "2026-08", "2026-09"]);
    const c012 = byId("C012");
    // SPEC §10: noActuals は「基礎月が 0 か月」。C012 は 2026-07〜09 が基礎月（原価 0）なので false、平均 0
    expect(c012.forecasts.recent3.breakdown).toMatchObject({ noActuals: false, averageMonthlyCost: 0, remainingCost: 0, averageBasisMonths: ["2026-07", "2026-08", "2026-09"] });
    expect(c012.forecasts.assignment.breakdown.noAssignments).toBe(false);
    expect(model.meta.hasPriorYearData).toBe(true);
  });
});
