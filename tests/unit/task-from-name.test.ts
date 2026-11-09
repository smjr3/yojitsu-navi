/**
 * 作業名の括弧内を作業種別（タスク）として扱う（SPEC §101）
 */
import { describe, expect, it } from "vitest";
import { buildModel, createTaskClassifier, createTaskNameExtractor, extractProjectName, extractTaskFromName, isPeriodText, taskMarkers, validateDataset } from "../../src/core/index.js";
import type { Config, TaskTypeRule } from "../../src/core/types.js";
import { T } from "../../src/i18n/index.js";
import { baseConfig, contract, dataset, member, rate, rule, team, worklog } from "./fixtures.js";

// 目印は架空の例（導入先の実際の値は config.json に書く）
const MARKS = ["_保守対応", "保守_ヘルプデスク", "トラブル対応"];
const cfg = (extra: Partial<Config> = {}): Config => ({ ...baseConfig, taskFromName: { markers: MARKS }, ...extra });

describe("extractTaskFromName", () => {
  it("目印の直後の括弧内をタスクにする（全角半角の括弧・空白・ほかの括弧）", () => {
    expect(extractTaskFromName("架空 受発注保守_保守対応(問い合わせ)", MARKS)).toEqual({ task: "問い合わせ" });
    expect(extractTaskFromName("架空 受発注保守_保守対応（ 障害  調査 ）", MARKS)).toEqual({ task: "障害 調査" });
    expect(extractTaskFromName("架空 受発注保守＿保守対応 【定例】", MARKS)).toEqual({ task: "定例" });
    expect(extractTaskFromName("見本 保守_ヘルプデスク(電話)", MARKS)).toEqual({ task: "電話" });
    expect(extractTaskFromName("トラブル対応（夜間(臨時)）", MARKS)).toEqual({ task: "夜間(臨時)" });
    expect(extractTaskFromName("架空_保守対応(閉じない", MARKS)).toEqual({ task: "閉じない" });
  });

  it("複数の目印は作業名の中で最も前のもの", () => {
    expect(extractTaskFromName("架空_保守対応(A)トラブル対応(B)", MARKS)).toEqual({ task: "A" });
    expect(extractTaskFromName("架空トラブル対応(B)_保守対応(A)", MARKS)).toEqual({ task: "B" });
  });

  it("括弧が無い・空・期間の表記だけならタスク分類なし（task: null）", () => {
    for (const name of ["架空_保守対応", "架空_保守対応 定例", "架空_保守対応()", "架空_保守対応（2026年6月〜7月）", "架空_保守対応(2026/06-2026/07)", "架空_保守対応(6月分)", "架空_保守対応(令和8年度上期)"]) {
      expect(extractTaskFromName(name, MARKS)).toEqual({ task: null });
    }
  });

  it("目印が無ければ undefined（従来どおり作業名で分類する）", () => {
    expect(extractTaskFromName("提案(新規)", MARKS)).toBeUndefined();
    expect(extractTaskFromName("", MARKS)).toBeUndefined();
  });

  it("期間の表記の判定", () => {
    expect(isPeriodText("2026年6月〜7月")).toBe(true);
    expect(isPeriodText("FY2026 Q1")).toBe(true);
    expect(isPeriodText("6月")).toBe(true);
    expect(isPeriodText("定例")).toBe(false);
    expect(isPeriodText("年月")).toBe(false);
    expect(isPeriodText("v2 移行")).toBe(false);
  });

  it("案件名の抜き出し（§97）は従来どおり", () => {
    expect(extractProjectName("見本 生産管理保守 _ 保守 対応(夜間)", "_保守対応")).toBe("見本 生産管理保守");
  });
});

describe("設定", () => {
  it("markers が無ければ projectFromTask.marker。enabled: false・設定なしは使わない", () => {
    expect(taskMarkers(cfg())).toEqual(MARKS);
    expect(taskMarkers({ ...baseConfig, taskFromName: {}, projectFromTask: { marker: "_保守対応" } })).toEqual(["_保守対応"]);
    expect(taskMarkers({ ...baseConfig, taskFromName: { markers: MARKS, enabled: false } })).toEqual([]);
    expect(taskMarkers({ ...baseConfig, projectFromTask: { marker: "_保守対応" } })).toEqual([]);
    expect(taskMarkers({ ...baseConfig, taskFromName: { markers: [" ", ""] } })).toEqual([]);
    expect(createTaskNameExtractor(baseConfig).enabled).toBe(false);
  });
});

describe("分類（createTaskClassifier）", () => {
  const TYPES: TaskTypeRule[] = [
    { task: "問い合わせ", category: "contract" },
    { task: "提案", category: "outside", group: "提案活動" },
    { task: "障害", category: "contract", match: "contains" },
  ];
  const c = createTaskClassifier(TYPES, [], undefined, createTaskNameExtractor(cfg()));

  it("括弧内で分類表を引く（完全一致・含む）", () => {
    expect(c.classify("架空_保守対応(問い合わせ)")).toMatchObject({ category: "contract", label: "問い合わせ", unclassified: false });
    expect(c.classify("架空_保守対応(提案)")).toMatchObject({ category: "outside", group: "提案活動", label: "提案" });
    expect(c.classify("架空_保守対応(夜間障害の調査)")).toMatchObject({ category: "contract", label: "障害", unclassified: false });
  });

  it("括弧内が分類表に無くても未分類にしない（運用保守のタスクとして括弧内の表記で数える）", () => {
    expect(c.classify("架空_保守対応(棚卸し)")).toMatchObject({ category: "contract", label: "棚卸し", unclassified: false });
  });

  it("タスク分類なしは運用保守として時間を数え、未分類にしない", () => {
    expect(c.classify("架空_保守対応")).toMatchObject({ category: "contract", label: T.work.noTask, unclassified: false, noTask: true });
    expect(c.classify("架空_保守対応（2026年6月〜7月）")).toMatchObject({ label: T.work.noTask, noTask: true });
  });

  it("目印の無い作業名は従来どおり（分類表に無ければ未分類）", () => {
    expect(c.classify("勉強会")).toMatchObject({ category: "contract", label: "勉強会", unclassified: true });
  });

  it("分類表が無くても括弧内を作業種別の表記にする", () => {
    const only = createTaskClassifier(undefined, [], undefined, createTaskNameExtractor(cfg()));
    expect(only.enabled).toBe(true);
    expect(only.classify("架空_保守対応(定例)")).toMatchObject({ category: "contract", label: "定例", unclassified: false });
    expect(only.classify("勉強会")).toMatchObject({ unclassified: false });
  });
});

describe("buildModel・validateDataset", () => {
  const data = dataset({
    config: cfg(),
    contracts: [contract({ contractId: "C1", customerName: "ABC", projectName: "保守", teamId: "T1" })],
    mappings: [rule("ABC", "保守", "C1")],
    teams: [team("ROOT", null), team("T1", "ROOT")],
    members: [member({ memberId: "M1", teamId: "T1" })],
    rates: [rate("SE", 5000)],
    taskTypes: [{ task: "定例", category: "contract" }],
    worklogs: [
      worklog({ date: "2026-04-01", memberId: "M1", customerName: "ABC", projectName: "保守", task: "架空_保守対応(定例)", hours: 2 }),
      worklog({ date: "2026-04-02", memberId: "M1", customerName: "ABC", projectName: "保守", task: "架空_保守対応", hours: 3 }),
      worklog({ date: "2026-04-03", memberId: "M1", customerName: "ABC", projectName: "保守", task: "架空_保守対応(2026年4月〜5月)", hours: 1 }),
      worklog({ date: "2026-04-04", memberId: "M1", customerName: "ABC", projectName: "保守", task: "架空_保守対応（棚卸し）", hours: 1 }),
    ],
  });
  const model = buildModel(data, { asOf: "2026-05-20", generatedAt: "x" });

  it("タスク分類なしも契約の実績に入る（時間・金額）", () => {
    const apr = model.contracts[0]!.months.find((m) => m.month === "2026-04")!;
    expect(apr.hours).toBe(7);
  });

  it("作業種別の内訳: 括弧内の表記と「タスク分類なし」。未分類は無い", () => {
    const byTask = new Map<string, number>();
    for (const r of model.workRows) byTask.set(r.task, (byTask.get(r.task) ?? 0) + r.hours);
    expect(Object.fromEntries(byTask)).toEqual({ 定例: 2, 棚卸し: 1, [T.work.noTask]: 4 });
    expect(model.workRows.some((r) => r.unclassified)).toBe(false);
  });

  it("未分類の警告（TASK_UNCLASSIFIED）を出さない", () => {
    expect(model.warnings.map((w) => w.code)).not.toContain("TASK_UNCLASSIFIED");
    expect(validateDataset(data).map((i) => i.code)).not.toContain("TASK_UNCLASSIFIED");
  });

  it("設定が無ければ従来どおり（作業名そのまま・未分類の警告）", () => {
    const old = buildModel({ ...data, config: baseConfig }, { asOf: "2026-05-20", generatedAt: "x" });
    expect(old.warnings.filter((w) => w.code === "TASK_UNCLASSIFIED")).toHaveLength(4);
  });
});
