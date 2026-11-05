/**
 * 正式な案件の一覧の取り込みアダプタ: config.projectSource（SPEC §98）
 *
 * 案件管理システムから、案件 ID・顧客名・案件名を取得する。作業実績・人事と同じ仕組み（./http-source.ts）。
 *
 *   adapter "csv"   書き出した CSV を置く運用。projectSource.csv.path（rootDir 相対）、encoding 既定 auto
 *   adapter "http"  API。projectSource.http は worklogSource.http と同じ設定項目。pagination を省略するとページングなし（1 回で全件）
 *   adapter "none"  取り込まない（既定）
 *
 * サーバー側の絞り込みが効かない API のために、取得した後で projectSource.filters（保守の属性・受注済みなど）で絞る。
 *
 * 環境変数: PROJECT_API_TOKEN（http のみ。ログ・例外には出さない）
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Config, Project, ProjectImportField, ProjectSourceConfig } from "../../src/core/types.js";
import { assertColumns, candidatesOf, fetchRawRows, parseCsvRows, passesFilters, pickValue, resolveMapping, type ColumnRequirement, type FetchReport, type HttpAdapterDeps, type RawRow } from "./http-source.js";
import { decodeAuto } from "../lib/encoding.js";

export interface ProjectFetchOptions {
  config: Config;
  env: NodeJS.ProcessEnv;
  rootDir?: string;
  /** 取り込み実行月（URL の {from} {to} に入る。ふつうは使わない） */
  month: string;
  log?: (message: string) => void;
  report?: (r: FetchReport) => void;
}

export interface ProjectAdapter {
  name: string;
  fetch(opts: ProjectFetchOptions): Promise<Project[]>;
}

const FIELDS: ProjectImportField[] = ["projectId", "customerName", "projectName"];

function requirements(ps: ProjectSourceConfig): ColumnRequirement[] {
  const cols = ps.columns ?? {};
  for (const f of FIELDS) {
    if (candidatesOf(cols[f]).length === 0) throw new Error(`config.projectSource.columns.${f} が設定されていません`);
  }
  return FIELDS.map((field) => ({ field, spec: cols[field] }));
}

function text(row: RawRow, ps: ProjectSourceConfig, f: ProjectImportField): string {
  const v = pickValue(row, ps.columns?.[f]);
  return v === undefined || v === null ? "" : String(v).trim();
}

/** 取得済みの生の行から Project[] を作る（csv / http 共通）。ID の空は除き、重複は先頭を採用する */
export function importProjects(raw: RawRow[], ps: ProjectSourceConfig, report?: (r: FetchReport) => void, log?: (m: string) => void): Project[] {
  const reqs = requirements(ps);
  assertColumns(raw[0], reqs, ps.filters);
  const rows = raw.filter((r) => passesFilters(r, ps.filters));
  report?.({ rawColumns: raw[0] ? Object.keys(raw[0]) : [], mapping: resolveMapping(raw[0], reqs), rawRowCount: raw.length, filteredOut: raw.length - rows.length });
  const byId = new Map<string, Project>();
  let noId = 0;
  let dup = 0;
  for (const r of rows) {
    const projectId = text(r, ps, "projectId");
    if (projectId === "") {
      noId++;
      continue;
    }
    if (byId.has(projectId)) {
      dup++;
      continue;
    }
    byId.set(projectId, { projectId, customerName: text(r, ps, "customerName"), projectName: text(r, ps, "projectName") });
  }
  if (raw.length !== rows.length) log?.(`[projects] 取得 ${raw.length} 件のうち、filters に合わない ${raw.length - rows.length} 件を除きました`);
  if (noId > 0) log?.(`[projects] 案件IDが空の ${noId} 件を除きました`);
  if (dup > 0) log?.(`[projects] 案件IDが重複する ${dup} 件は先頭を採用しました`);
  return [...byId.values()];
}

export const projectCsvAdapter: ProjectAdapter = {
  name: "csv",
  async fetch({ config, rootDir, report, log }): Promise<Project[]> {
    const ps = config.projectSource;
    if (!ps?.csv?.path) throw new Error("config.projectSource.csv.path が設定されていません");
    const path = isAbsolute(ps.csv.path) ? ps.csv.path : join(rootDir ?? process.cwd(), ps.csv.path);
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new Error(`projectSource.csv.path のファイルを読めません: ${ps.csv.path}`);
    }
    const enc = ps.csv.encoding;
    const t = enc === "utf-8" ? new TextDecoder("utf-8").decode(bytes) : enc === "shift_jis" ? new TextDecoder("shift_jis").decode(bytes) : decodeAuto(bytes).text;
    return importProjects(parseCsvRows(t), ps, report, log);
  },
};

export function createProjectHttpAdapter(deps: HttpAdapterDeps = {}): ProjectAdapter {
  return {
    name: "http",
    async fetch({ config, env, month, report, log }): Promise<Project[]> {
      const logFn = log ?? ((m: string) => console.error(m));
      const ps = config.projectSource;
      const http = ps?.http;
      if (!ps || !http?.url) throw new Error("config.projectSource.http.url が設定されていません");
      const token = env.PROJECT_API_TOKEN ?? "";
      if (token === "") throw new Error("環境変数 PROJECT_API_TOKEN が設定されていません");
      requirements(ps); // 列の設定漏れは通信前に止める
      const raw = await fetchRawRows(http, { from: month, to: month, token, log: logFn, deps });
      return importProjects(raw, ps, report, logFn);
    },
  };
}

export const PROJECT_ADAPTERS: Record<string, ProjectAdapter> = {
  csv: projectCsvAdapter,
  http: createProjectHttpAdapter(),
};

/** 設定からアダプタを選ぶ。none（または未設定）は null。環境変数 PROJECT_ADAPTER で上書き可 */
export function selectProjectAdapter(config: Config, env: NodeJS.ProcessEnv = process.env): ProjectAdapter | null {
  const name = env.PROJECT_ADAPTER || config.projectSource?.adapter || "none";
  if (name === "none") return null;
  const a = PROJECT_ADAPTERS[name];
  if (!a) throw new Error(`不明な案件の一覧のアダプタ "${name}"。使用可能: none, ${Object.keys(PROJECT_ADAPTERS).join(", ")}`);
  return a;
}
