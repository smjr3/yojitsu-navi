/**
 * メンバー（所属・役職）の取り込みアダプタ: config.memberSource
 *
 * 作業実績の http アダプタと同じ仕組み（./http-source.ts）で、人事系の元データから
 * memberId, name, kind, title, department, section を取得する。team_id は取り込まない。
 *
 *   adapter "csv"   人事の CSV を置く運用。memberSource.csv.path（rootDir 相対）、encoding 既定 auto
 *   adapter "http"  人事 API。memberSource.http は worklogSource.http と同じ設定項目
 *   adapter "none"  取り込まない（手入力。既定）
 *
 * 環境変数: MEMBER_API_TOKEN（http のみ。ログ・例外には出さない）
 *
 * columns の memberId と name は必須。kind / title / department / section は省略可で、
 * 省略した項目は「取り込まない」＝現在の値を引き継ぐ。
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Config, MemberImportField, MemberKind, MemberSourceConfig } from "../../src/core/types.js";
import {
  assertColumns,
  candidatesOf,
  fetchRawRows,
  parseCsvRows,
  passesFilters,
  pickValue,
  resolveMapping,
  type ColumnRequirement,
  type FetchReport,
  type HttpAdapterDeps,
  type RawRow,
} from "./http-source.js";
import { decodeAuto } from "../lib/encoding.js";

/** 取り込んだ 1 人分。undefined の項目は「取り込み元が持っていない」＝比較・上書きしない */
export interface MemberImport {
  memberId: string;
  /** 空・未指定のときは既存の氏名を残す */
  name?: string;
  kind?: MemberKind;
  title?: string;
  department?: string;
  section?: string;
}

export interface MemberFetchOptions {
  config: Config;
  env: NodeJS.ProcessEnv;
  rootDir?: string;
  /** 取り込み実行月（URL の {from} {to} に入る） */
  month: string;
  log?: (message: string) => void;
  report?: (r: FetchReport) => void;
}

export interface MemberAdapter {
  name: string;
  fetch(opts: MemberFetchOptions): Promise<MemberImport[]>;
}

const OPTIONAL_FIELDS: Array<Exclude<MemberImportField, "memberId" | "name">> = ["kind", "title", "department", "section"];

/** 1 行 → MemberImport（kindMap で区分を読み替え） */
export function mapMemberRow(row: RawRow, ms: MemberSourceConfig): MemberImport | null {
  const cols = ms.columns ?? {};
  const str = (f: MemberImportField): string | undefined => {
    if (candidatesOf(cols[f]).length === 0) return undefined;
    const v = pickValue(row, cols[f]);
    return v === undefined || v === null ? "" : String(v).trim();
  };
  const memberId = str("memberId") ?? "";
  if (memberId === "") return null;
  const out: MemberImport = { memberId };
  // 氏名が空 = 取り込まない（現在の値を引き継ぐ。空で上書きしない）
  const name = str("name");
  if (name !== undefined && name !== "") out.name = name;
  for (const f of OPTIONAL_FIELDS) {
    const v = str(f);
    if (v === undefined) continue;
    if (f === "kind") {
      if (v === "") continue; // 空 = 取り込まない（現在の値を引き継ぐ）
      const mapped = ms.kindMap?.[v] ?? (v === "employee" || v === "partner" ? v : undefined);
      if (!mapped) throw new Error(`区分（kind）の値 "${v}" を employee / partner に読み替えられません。memberSource.kindMap に追加してください`);
      out.kind = mapped;
    } else {
      out[f] = v;
    }
  }
  return out;
}

function requirements(ms: MemberSourceConfig): ColumnRequirement[] {
  const cols = ms.columns ?? {};
  const fields: MemberImportField[] = ["memberId", "name", ...OPTIONAL_FIELDS];
  for (const f of ["memberId", "name"] as const) {
    if (candidatesOf(cols[f]).length === 0) throw new Error(`config.memberSource.columns.${f} が設定されていません`);
  }
  return fields.filter((f) => candidatesOf(cols[f]).length > 0).map((field) => ({ field, spec: cols[field] }));
}

/** 取得済みの生の行から MemberImport[] を作る（csv / http 共通） */
export function importMembers(raw: RawRow[], ms: MemberSourceConfig, report?: (r: FetchReport) => void, log?: (m: string) => void): MemberImport[] {
  const reqs = requirements(ms);
  assertColumns(raw[0], reqs, ms.filters);
  const rows = raw.filter((r) => passesFilters(r, ms.filters));
  report?.({ rawColumns: raw[0] ? Object.keys(raw[0]) : [], mapping: resolveMapping(raw[0], reqs), rawRowCount: raw.length, filteredOut: raw.length - rows.length });
  const byId = new Map<string, MemberImport>();
  let dup = 0;
  let noId = 0;
  let noName = 0;
  for (const r of rows) {
    const m = mapMemberRow(r, ms);
    if (!m) {
      noId++;
      continue;
    }
    if (byId.has(m.memberId)) {
      dup++;
      continue; // 重複は先頭を採用
    }
    if (m.name === undefined) noName++;
    byId.set(m.memberId, m);
  }
  if (noName > 0) log?.(`[members] 氏名が空の ${noName} 人は、既存の氏名をそのまま残します（新しい人は氏名が空になります）`);
  if (noId > 0) log?.(`[members] メンバーIDが空の ${noId} 行を除きました`);
  if (dup > 0) log?.(`[members] メンバーIDが重複する ${dup} 行は先頭を採用しました`);
  return [...byId.values()];
}

export const memberCsvAdapter: MemberAdapter = {
  name: "csv",
  async fetch({ config, rootDir, report, log }): Promise<MemberImport[]> {
    const ms = config.memberSource;
    if (!ms?.csv?.path) throw new Error("config.memberSource.csv.path が設定されていません");
    const path = isAbsolute(ms.csv.path) ? ms.csv.path : join(rootDir ?? process.cwd(), ms.csv.path);
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new Error(`memberSource.csv.path のファイルを読めません: ${ms.csv.path}`);
    }
    const enc = ms.csv.encoding;
    const text = enc === "utf-8" ? new TextDecoder("utf-8").decode(bytes) : enc === "shift_jis" ? new TextDecoder("shift_jis").decode(bytes) : decodeAuto(bytes).text;
    return importMembers(parseCsvRows(text), ms, report, log);
  },
};

export function createMemberHttpAdapter(deps: HttpAdapterDeps = {}): MemberAdapter {
  return {
    name: "http",
    async fetch({ config, env, month, report, log }): Promise<MemberImport[]> {
      const logFn = log ?? ((m: string) => console.error(m));
      const ms = config.memberSource;
      const http = ms?.http;
      if (!ms || !http?.url) throw new Error("config.memberSource.http.url が設定されていません");
      const token = env.MEMBER_API_TOKEN ?? "";
      if (token === "") throw new Error("環境変数 MEMBER_API_TOKEN が設定されていません");
      requirements(ms); // 列の設定漏れは通信前に止める
      const raw = await fetchRawRows(http, { from: month, to: month, token, log: logFn, deps });
      return importMembers(raw, ms, report, logFn);
    },
  };
}

export const memberHttpAdapter: MemberAdapter = createMemberHttpAdapter();

export const MEMBER_ADAPTERS: Record<string, MemberAdapter> = {
  csv: memberCsvAdapter,
  http: memberHttpAdapter,
};

/** 設定からアダプタを選ぶ。none（または未設定）は null。環境変数 MEMBER_ADAPTER で上書き可 */
export function selectMemberAdapter(config: Config, env: NodeJS.ProcessEnv = process.env): MemberAdapter | null {
  const name = env.MEMBER_ADAPTER || config.memberSource?.adapter || "none";
  if (name === "none") return null;
  const a = MEMBER_ADAPTERS[name];
  if (!a) throw new Error(`不明なメンバーアダプタ "${name}"。使用可能: none, ${Object.keys(MEMBER_ADAPTERS).join(", ")}`);
  return a;
}
