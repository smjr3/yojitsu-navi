/**
 * ローダの出力の中身（Node 側専用。画面からは import しない）
 *
 * 各ローダ（src/data/*.json.ts）は、ここの関数で中身を作って emitJson で出すだけにする。
 * `npm run build` は先にここの関数を 1 つのプロセスでまとめて呼び（scripts/prebuild-data.ts。データの読み込みと
 * Model の計算は 1 回だけ）、結果を Framework のキャッシュに置く。ローダを個別に動かしても、まとめて作っても同じ中身になる
 * （docs/DATA_LOADERS.md「6. 増分ビルド」、SPEC §102）。
 */
import { checkProjects, encodeDaily, findUnsetItems, encodeWorkRows, memberRateHistory, type Model, type ValidationIssue } from "../core/index.js";
import type { ParsedDataset } from "../core/csv.js";
import { buildMastersPayload } from "./_masters.js";
import { loadDataset } from "../../scripts/lib/load.js";
import { ROOT_DIR, buildModelFromData, buildStamp, resolveAsOf, stripWorklogs } from "./_shared.js";

/** データの読み込みと Model の計算を 1 回にまとめる入れ物（使うときに初めて作る） */
export interface OutputContext {
  root: string;
  parsed(): ParsedDataset;
  model(): Model;
}

export function createContext(root: string = ROOT_DIR): OutputContext {
  let parsed: ParsedDataset | null = null;
  let model: Model | null = null;
  const ctx: OutputContext = {
    root,
    parsed: () => (parsed ??= loadDataset(root)),
    model: () => (model ??= buildModelFromData(ctx.parsed())),
  };
  return ctx;
}

/** 画面が読む Model（作業ログ明細は除く。明細は data/worklogs/[contractId].json で遅延取得） */
function modelOutput(ctx: OutputContext) {
  const model = ctx.model();
  return {
    ...model,
    contracts: model.contracts.map(stripWorklogs),
    // メンバー別（§18）は data/member-months.json で別に配る（メンバー別の画面だけが読む）
    memberMonths: [],
    // 工数の明細（§30）は data/work-hours.json で別に配る（工数・詳細画面の作業種別の内訳だけが読む）
    workRows: [],
    /** 作業ログ明細の取得先（契約IDごと）。画面側は相対パスで fetch する */
    worklogDetailPath: "data/worklogs/{contractId}.json",
    /** 入力の指紋（ビルド後の検証と、作業ログ明細の取得でブラウザの古いキャッシュを避けるのに使う） */
    _build: buildStamp(),
  };
}

/** メンバー別の画面（/members, /member）が読むデータ（SPEC §18） */
function memberMonthsOutput(ctx: OutputContext) {
  const parsed = ctx.parsed();
  const model = ctx.model();
  const ids = new Set<string>();
  for (const mm of model.memberMonths) ids.add(mm.memberId);
  for (const m of parsed.dataset.members) ids.add(m.memberId);
  const period = { from: model.meta.minMonth, to: model.meta.maxMonth };
  const rateHistory: Record<string, ReturnType<typeof memberRateHistory>> = {};
  for (const id of [...ids].sort()) rateHistory[id] = memberRateHistory(parsed.dataset, id, period);
  return { asOf: model.meta.asOf, memberMonths: model.memberMonths, rateHistory, _build: buildStamp() };
}

/** 今月の進捗（SPEC §61） */
function dailyOutput(ctx: OutputContext) {
  return { ...encodeDaily(ctx.model()), _build: buildStamp() };
}

/** 工数の明細（SPEC §30.2） */
function workHoursOutput(ctx: OutputContext) {
  const model = ctx.model();
  return { asOf: model.meta.asOf, ...encodeWorkRows(model.workRows), _build: buildStamp() };
}

/** データ確認ページ用: CSV 読み込み時の問題 ＋ validateDataset の結果（scripts/validate-data.ts と同じ内容） */
function datasetIssuesOutput(ctx: OutputContext) {
  const parsed = ctx.parsed();
  // parsed.issues は validateDataset の結果も含む（もう一度かけると同じ問題が文面違いで二重に出る）
  const seen = new Set<string>();
  const issues: ValidationIssue[] = [];
  for (const i of parsed.issues) {
    const key = `${i.severity}|${i.code}|${i.file ?? ""}|${i.row ?? ""}|${i.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(i);
  }
  const order = { error: 0, warning: 1 } as const;
  issues.sort((a, b) => order[a.severity] - order[b.severity] || (a.file ?? "").localeCompare(b.file ?? "") || (a.row ?? 0) - (b.row ?? 0));
  return {
    asOf: resolveAsOf(),
    issues,
    summary: {
      contracts: parsed.dataset.contracts.length,
      members: parsed.dataset.members.length,
      worklogs: parsed.dataset.worklogs.length,
      errors: issues.filter((i) => i.severity === "error").length,
      warnings: issues.filter((i) => i.severity === "warning").length,
    },
    // 正式な案件の一覧との照合（§98）。一覧が無ければ enabled: false
    projects: checkProjects(parsed.dataset.contracts, parsed.dataset.projects),
    // 未設定・仮の値（§103）。マスタ編集の該当箇所へ移るための一覧
    unset: findUnsetItems(parsed.dataset),
    // 正式な案件の一覧（§98）。未登録の案件の「案件に登録」で、案件名が同じ正式な案件の ID・顧客名を入れるのに使う
    officialProjects: (parsed.dataset.projects ?? []).filter((p) => p.projectId !== "").map((p) => ({ projectId: p.projectId, customerName: p.customerName, projectName: p.projectName })),
    _build: buildStamp(),
  };
}

/** マスタ編集画面用（SPEC §19.2） */
function mastersOutput(ctx: OutputContext) {
  return { ...buildMastersPayload(ctx.root), _build: buildStamp() };
}

/**
 * 集計の出力（ローダ src/data/<名前>.json.ts → data/<名前>.json）。どれも data/ 全体から作るので、データが 1 行でも変われば作り直す。
 * ローダを足したらここにも足す（tests/unit/incremental-build.test.ts が src/data のローダと突き合わせる）
 */
export const AGGREGATE_OUTPUTS = {
  model: modelOutput,
  "member-months": memberMonthsOutput,
  daily: dailyOutput,
  "work-hours": workHoursOutput,
  "dataset-issues": datasetIssuesOutput,
  masters: mastersOutput,
} as const satisfies Record<string, (ctx: OutputContext) => unknown>;

export type AggregateName = keyof typeof AGGREGATE_OUTPUTS;

export { worklogDetailOf } from "./_shared.js";
