/**
 * data/ 配下の CSV と config.json を読み、計算コアの parseDataset に渡す（Node 側専用）
 *
 * - 文字コードは自動判定（UTF-8 / UTF-8 BOM / Shift_JIS）
 * - data/worklogs/ が無い・空でも落とさず、作業実績 0 件として扱う
 * - data/worklogs/_meta.json の fetchedAt を worklogFetchedAt に入れる
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDataset, type DatasetFiles, type ParsedDataset } from "../../src/core/csv.js";
import type { Config } from "../../src/core/types.js";
import { readTextAuto } from "./encoding.js";

/** data/ 配下のファイル配置（docs/DATA.md） */
export const DATA_FILES = {
  contracts: "data/contracts.csv",
  mapping: "data/mapping.csv",
  assignments: "data/assignments.csv",
  teams: "data/masters/teams.csv",
  members: "data/masters/members.csv",
  rates: "data/masters/rates.csv",
  holidays: "data/holidays.csv",
  taskTypes: "data/task-types.csv",
  outsidePlans: "data/outside-plans.csv",
  targets: "data/targets.csv",
} as const;

export interface WorklogMeta {
  fetchedAt?: string;
  adapter?: string;
  [k: string]: unknown;
}

/** config.json を読む */
export function loadConfig(rootDir: string): Config {
  const text = readTextAuto(join(rootDir, "config.json"));
  return JSON.parse(text) as Config;
}

/** 作業実績ディレクトリ（config.worklogSource.csv.path、既定 data/worklogs） */
export function worklogDir(rootDir: string, config: Config): string {
  return join(rootDir, config.worklogSource.csv?.path || "data/worklogs");
}

/** data/worklogs/YYYY-MM.csv を月順に列挙する（ディレクトリが無ければ空）。拡張子の大文字小文字は問わない */
export function listWorklogFiles(dir: string): Array<{ month: string; path: string; name: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}\.csv$/i.test(f))
    .sort()
    .map((f) => ({ month: f.slice(0, 7), path: join(dir, f), name: f }));
}

/** 作業実績フォルダの CSV のうち、名前が YYYY-MM.csv でないため読まないもの（「2026-10 (1).csv」など） */
export function skippedWorklogFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.csv$/i.test(f) && !/^\d{4}-\d{2}\.csv$/i.test(f))
    .sort();
}

/** _meta.json を読む（無ければ空オブジェクト） */
export function readWorklogMeta(dir: string): WorklogMeta {
  const p = join(dir, "_meta.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as WorklogMeta;
  } catch {
    return {};
  }
}

/** 1ファイルを読む。無ければ空文字（parseDataset 側で列欠落エラーになる） */
function readOrEmpty(path: string): string {
  return existsSync(path) ? readTextAuto(path) : "";
}

/** data/ 一式を読み込んで DatasetFiles にする（parseDataset の入力） */
export function readDatasetFiles(rootDir: string): DatasetFiles {
  const config = loadConfig(rootDir);
  const dir = worklogDir(rootDir, config);
  const listed = listWorklogFiles(dir);
  const worklogs = listed.map((f) => readTextAuto(f.path));
  const meta = readWorklogMeta(dir);
  const files: DatasetFiles = {
    config,
    contracts: readOrEmpty(join(rootDir, DATA_FILES.contracts)),
    mapping: readOrEmpty(join(rootDir, DATA_FILES.mapping)),
    assignments: readOrEmpty(join(rootDir, DATA_FILES.assignments)),
    teams: readOrEmpty(join(rootDir, DATA_FILES.teams)),
    members: readOrEmpty(join(rootDir, DATA_FILES.members)),
    rates: readOrEmpty(join(rootDir, DATA_FILES.rates)),
    holidays: readOrEmpty(join(rootDir, DATA_FILES.holidays)),
    // 省略可（§30.1）。無ければ空 = 分類なし
    taskTypes: readOrEmpty(join(rootDir, DATA_FILES.taskTypes)),
    // 省略可（§36）。無ければ空 = 契約外予定なし
    outsidePlans: readOrEmpty(join(rootDir, DATA_FILES.outsidePlans)),
    // 省略可（§63）。無ければ空 = 目標なし
    targets: readOrEmpty(join(rootDir, DATA_FILES.targets)),
    worklogs,
    worklogNames: listed.map((f) => f.name),
    skippedWorklogFiles: skippedWorklogFiles(dir),
  };
  if (typeof meta.fetchedAt === "string" && meta.fetchedAt !== "") files.worklogFetchedAt = meta.fetchedAt;
  return files;
}

/** data/ 一式を読み込み、計算コアで Dataset に変換する */
export function loadDataset(rootDir: string): ParsedDataset {
  return parseDataset(readDatasetFiles(rootDir));
}
