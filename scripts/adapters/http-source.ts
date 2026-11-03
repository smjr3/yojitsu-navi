/**
 * http / csv 取得元の共通処理（作業実績 http アダプタとメンバー取り込みで共有）
 *
 * - 列の読み取り: ドット区切りの入れ子、配列の複数候補、列が無いときの案内（列名だけ。値は出さない）
 * - 日付・時間の変換
 * - filters（取り込まない行）
 * - HTTP 取得: 認証、再試行、ページング 5 種、query、文字コード
 *
 * トークンはログにも例外メッセージにも出さない（redact を全経路に通す）。
 */
import { createHash } from "node:crypto";
import { csvParse } from "d3-dsv";
import type { ColumnSpec, DateFormat, HttpSourceOptions, MemberTargetConfig, PaginationConfig, PaginationStopWhen, SourceFilter } from "../../src/core/types.js";
import { stripBom } from "../lib/csv.js";
import { decodeAuto } from "../lib/encoding.js";

export type RawRow = Record<string, unknown>;

// ---------------------------------------------------------------------------
// 列の読み取り
// ---------------------------------------------------------------------------

export function candidatesOf(spec: ColumnSpec | undefined): string[] {
  if (spec === undefined) return [];
  return (Array.isArray(spec) ? spec : [spec]).filter((c) => typeof c === "string" && c !== "");
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** 列名で値を引く。まず列名そのまま（"a.b" という名前の CSV 列）、無ければドット区切りで入れ子をたどる */
export function getByPath(row: RawRow, path: string): { found: boolean; value: unknown } {
  if (hasOwn(row, path)) return { found: true, value: row[path] };
  if (!path.includes(".")) return { found: false, value: undefined };
  let cur: unknown = row;
  for (const key of path.split(".")) {
    if (cur !== null && typeof cur === "object" && !Array.isArray(cur) && hasOwn(cur as object, key)) {
      cur = (cur as RawRow)[key];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: cur };
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/** 複数候補のうち、最初に値がある列の値。どれにも値が無ければ undefined */
export function pickValue(row: RawRow, spec: ColumnSpec | undefined): unknown {
  for (const c of candidatesOf(spec)) {
    const r = getByPath(row, c);
    if (r.found && !isBlank(r.value)) return r.value;
  }
  return undefined;
}

/** 1行の列名一覧（入れ子はドット区切りの葉まで）。値は含めない */
export function listColumnNames(row: RawRow, maxDepth = 4, limit = 200): string[] {
  const out: string[] = [];
  const walk = (o: RawRow, prefix: string, depth: number) => {
    for (const k of Object.keys(o)) {
      if (out.length >= limit) return;
      const v = o[k];
      const name = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === "object" && !Array.isArray(v) && depth < maxDepth) walk(v as RawRow, name, depth + 1);
      else out.push(name);
    }
  };
  walk(row, "", 1);
  return out;
}

export interface ColumnRequirement {
  field: string;
  spec: ColumnSpec | undefined;
}

export interface MappingEntry {
  field: string;
  candidates: string[];
  /** 応答の最初の行に実際にあった候補（無ければ null） */
  resolved: string | null;
}

export interface FetchReport {
  /** 応答の最初の1行の列名（値は含めない） */
  rawColumns: string[];
  mapping: MappingEntry[];
  rawRowCount: number;
  /** filters で除外した行数 */
  filteredOut: number;
}

/** 列の対応表を作る（最初の行に基づく） */
export function resolveMapping(first: RawRow | undefined, reqs: ColumnRequirement[]): MappingEntry[] {
  return reqs.map(({ field, spec }) => {
    const candidates = candidatesOf(spec);
    const resolved = first ? (candidates.find((c) => getByPath(first, c).found) ?? null) : null;
    return { field, candidates, resolved };
  });
}

/**
 * 設定した列が応答の最初の行に無ければ、列名の一覧つきのエラーで止める。
 * 候補が複数あるときは 1 つでも見つかればよい。応答が 0 行なら確かめようがないので通す。
 */
export function assertColumns(first: RawRow | undefined, reqs: ColumnRequirement[], filters: SourceFilter[] = []): void {
  if (!first) return;
  const all: ColumnRequirement[] = [...reqs, ...filters.map((f) => ({ field: `filters(${f.column})`, spec: f.column }))];
  const missing = resolveMapping(first, all).filter((m) => m.resolved === null);
  if (missing.length === 0) return;
  const list = missing.map((m) => `${m.field}（候補: ${m.candidates.join(" / ") || "未設定"}）`).join("、");
  throw new Error(`列が見つかりません: ${list}。応答の最初の1行の列名: ${listColumnNames(first).join(", ")}`);
}

// ---------------------------------------------------------------------------
// filters
// ---------------------------------------------------------------------------

function sameValue(v: unknown, expected: string | number | boolean): boolean {
  return String(v ?? "").trim() === String(expected);
}

/** すべての条件に合う行か */
export function passesFilters(row: RawRow, filters: SourceFilter[] | undefined): boolean {
  if (!filters) return true;
  for (const f of filters) {
    const v = getByPath(row, f.column).value;
    if (f.equals !== undefined && !sameValue(v, f.equals)) return false;
    if (f.notEquals !== undefined && sameValue(v, f.notEquals)) return false;
    if (f.in !== undefined && !f.in.some((e) => sameValue(v, e))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 日付・時間
// ---------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, "0");

function jstDate(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + 9 * 3600 * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function validYmd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
}

function epochToDate(v: unknown): string | null {
  const n = typeof v === "number" ? v : /^-?\d+$/.test(String(v).trim()) ? Number(String(v).trim()) : NaN;
  return jstDate(n);
}

/** 指定形式の日付を YYYY-MM-DD にする。読めなければ null */
export function parseDateWithFormat(v: unknown, fmt: DateFormat): string | null {
  if (fmt === "epochMillis") return epochToDate(v);
  const s = String(v ?? "").trim();
  if (fmt === "YYYY-MM-DD") {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    return m ? validYmd(Number(m[1]), Number(m[2]), Number(m[3])) : null;
  }
  if (fmt === "YYYY/MM/DD") {
    const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
    return m ? validYmd(Number(m[1]), Number(m[2]), Number(m[3])) : null;
  }
  if (fmt === "YYYYMMDD") {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    return m ? validYmd(Number(m[1]), Number(m[2]), Number(m[3])) : null;
  }
  // ISO8601: 時刻付き。タイムゾーン指定が無ければ JST とみなし、あれば JST に変換して日付を取る
  if (!/^\d{4}-\d{2}-\d{2}(T|\s)/.test(s) && !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const normalized = dateOnly ? `${s}T00:00:00+09:00` : hasZone ? s.replace(" ", "T") : `${s.replace(" ", "T")}+09:00`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : jstDate(ms);
}

/**
 * 日付を YYYY-MM-DD にする。
 * format 指定なし = 自動判定（左から順に試す）。従来どおり「先頭 10 文字、/ は -」も通るので既存設定は同じ結果になる。
 * 自動判定で読めなければ従来どおり先頭 10 文字をそのまま返す（validate が指摘する）。
 * format 指定ありで読めなければ null。
 */
export function parseDate(v: unknown, fmt?: DateFormat): string | null {
  if (fmt) return parseDateWithFormat(v, fmt);
  if (typeof v === "number") {
    if (Number.isFinite(v) && v >= 1e11) return epochToDate(v);
    // 20261027 のような 8 桁の整数は YYYYMMDD（文字列の "20261027" と同じ扱い）
    if (Number.isInteger(v) && v >= 10000101 && v <= 99991231) return parseDate(String(v));
    return String(v);
  }
  const s = String(v ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const slash = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(s);
  if (slash) return `${slash[1]}-${pad2(Number(slash[2]))}-${pad2(Number(slash[3]))}`;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{12,}$/.test(s)) return epochToDate(s);
  return s.slice(0, 10).replace(/\//g, "-");
}

/** 作業時間を「時間」に換算する */
export function toHours(v: unknown, unit: "hours" | "minutes" | "seconds" = "hours"): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  if (!Number.isFinite(n)) return NaN;
  return unit === "minutes" ? n / 60 : unit === "seconds" ? n / 3600 : n;
}

// ---------------------------------------------------------------------------
// HTTP 取得
// ---------------------------------------------------------------------------

/** 再試行すべきエラー */
export class RetryableError extends Error {
  override readonly name = "RetryableError";
}

export interface HttpAdapterDeps {
  fetchImpl?: typeof fetch;
  /** 再試行の待ち時間（テストでは 0 にする） */
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const DEFAULT_MAX_PAGES = 5000;
const MAX_REDIRECTS = 5;

/** 文字列からトークンを隠す */
export function redact(text: string, token: string): string {
  if (token === "") return text;
  let out = text.split(token).join("***");
  const enc = encodeURIComponent(token);
  if (enc !== token) out = out.split(enc).join("***");
  return out;
}

function decodeKey(kv: string): string {
  const k = kv.split("=")[0] ?? "";
  try {
    return decodeURIComponent(k.replace(/\+/g, " "));
  } catch {
    return k;
  }
}

/** JSON の中からドット区切りのパスで値を取り出す */
function digJson(json: unknown, path: string): { found: boolean; value: unknown; badKey?: string } {
  let cur: unknown = json;
  for (const key of path.split(".")) {
    if (cur !== null && typeof cur === "object" && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return { found: false, value: undefined, badKey: key };
    }
  }
  return { found: true, value: cur };
}

/** JSON の中から dataPath で配列を取り出す */
export function extractArray(json: unknown, dataPath: string | undefined): unknown[] {
  let cur: unknown = json;
  if (dataPath && dataPath.trim() !== "") {
    const r = digJson(json, dataPath);
    if (!r.found) throw new Error(`応答 JSON に dataPath "${dataPath}" が見つかりません（キー "${r.badKey}"）`);
    cur = r.value;
  }
  if (!Array.isArray(cur)) throw new Error(`応答 JSON が配列ではありません${dataPath ? `（dataPath=${dataPath}）` : ""}`);
  return cur;
}

function lastDayOfMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return `${ym}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

/** {from} {to} {fromDate} {toDate} を置換する（値は URL エンコード） */
export function expandPlaceholders(template: string, from: string, to: string): string {
  return template
    .replaceAll("{fromDate}", encodeURIComponent(`${from}-01`))
    .replaceAll("{toDate}", encodeURIComponent(lastDayOfMonth(to)))
    .replaceAll("{from}", encodeURIComponent(from))
    .replaceAll("{to}", encodeURIComponent(to));
}

/** 社員番号を渡す設定（§87）と、1 リクエスト分の社員番号 */
export interface MemberParam {
  config: MemberTargetConfig;
  ids: readonly string[];
}

const MEMBERS_PLACEHOLDER = "{members}";

/** {members} を使うか param を足すかを確かめる（設定の誤りは取得前に止める） */
export function checkMemberTarget(http: Pick<HttpSourceOptions, "url" | "query">, cfg: MemberTargetConfig): void {
  const placeholder = http.url.includes(MEMBERS_PLACEHOLDER) || (http.query ?? "").includes(MEMBERS_PLACEHOLDER);
  const param = (cfg.param ?? "").trim();
  if (!placeholder && param === "") throw new Error("members.param（社員番号を渡すパラメータ名）を設定するか、url / query に {members} を書いてください");
  if (placeholder && (cfg.style ?? "join") === "repeat") throw new Error("members.style が repeat のときは {members} ではなく members.param を使ってください");
  if (cfg.chunkSize !== undefined && !(Number.isInteger(cfg.chunkSize) && cfg.chunkSize >= 1)) throw new Error("members.chunkSize は 1 以上の整数にしてください");
}

/** url に query を足した最初のリクエスト URL。members があれば {members} を置換するか、param を末尾に足す */
export function buildRequestUrl(http: Pick<HttpSourceOptions, "url" | "query">, from: string, to: string, members?: MemberParam): string {
  const joined = members ? members.ids.join(members.config.separator ?? ",") : "";
  const expand = (t: string) => {
    const e = expandPlaceholders(t, from, to);
    return members ? e.replaceAll(MEMBERS_PLACEHOLDER, encodeURIComponent(joined)) : e;
  };
  let url = expand(http.url);
  const q = (http.query ?? "").trim().replace(/^[?&]+/, "");
  if (q !== "") url += (url.includes("?") ? "&" : "?") + expand(q);
  const placeholder = http.url.includes(MEMBERS_PLACEHOLDER) || (http.query ?? "").includes(MEMBERS_PLACEHOLDER);
  const param = (members?.config.param ?? "").trim();
  if (members && !placeholder && param !== "") {
    const key = encodeURIComponent(param);
    const kv = (members.config.style ?? "join") === "repeat" ? members.ids.map((id) => `${key}=${encodeURIComponent(id)}`) : [`${key}=${encodeURIComponent(joined)}`];
    url += (url.includes("?") ? "&" : "?") + kv.join("&");
  }
  return url;
}

/** Link ヘッダから rel="next" の URL を取り出す */
export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(/,\s*(?=<)/)) {
    const m = /^\s*<([^>]*)>(.*)$/.exec(part);
    const rel = /;\s*rel\s*=\s*"?([^";]*)"?/i.exec(m?.[2] ?? "");
    if (m && rel && (rel[1] ?? "").toLowerCase().split(/\s+/).includes("next")) return m[1] ?? null;
  }
  return null;
}

function decodeBody(bytes: Uint8Array, encoding: HttpSourceOptions["encoding"]): string {
  if (encoding === "utf-8") return new TextDecoder("utf-8").decode(bytes);
  if (encoding === "shift_jis") return new TextDecoder("shift_jis").decode(bytes);
  return decodeAuto(bytes).text;
}

/** CSV 文字列を行オブジェクトにする（空行は無視） */
export function parseCsvRows(text: string): RawRow[] {
  const body = stripBom(text);
  if (body.trim() === "") return [];
  return (csvParse(body) as unknown as RawRow[]).filter((r) => Object.values(r).some((v) => String(v ?? "").trim() !== ""));
}

export interface FetchRowsContext {
  from: string;
  to: string;
  /** 取得対象の社員番号（§87。作業実績で members を設定したときだけ） */
  members?: MemberParam;
  token: string;
  log: (m: string) => void;
  deps?: HttpAdapterDeps;
}

interface Page {
  rows: RawRow[];
  json: unknown;
  nextLink: string | null;
}

function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(invalid url)";
  }
}

function signature(rows: RawRow[]): string {
  return createHash("sha1").update(JSON.stringify(rows)).digest("hex");
}

interface PagingPlan {
  /** 件数のパラメータ名。null なら付けない */
  sizeParam: string | null;
  size: number;
  /** この行数のページで終わりか */
  isLast: (rows: number) => boolean;
}

/**
 * page / offset の件数パラメータと終了条件を決める。
 * 既定（stopWhen 省略・件数パラメータあり）は従来どおり「設定件数未満で終了」。
 */
export function pagingPlan(
  stopWhen: PaginationStopWhen | undefined,
  sizeParam: string | undefined,
  size: number | undefined,
  sizeKey: "size" | "limit",
  paramKey: "sizeParam" | "limitParam",
): PagingPlan {
  const mode = stopWhen ?? "short";
  if (mode !== "short" && mode !== "empty") throw new Error(`pagination.stopWhen は short か empty にしてください: ${String(mode)}`);
  const param = typeof sizeParam === "string" && sizeParam.trim() !== "" ? sizeParam : null;
  const n = size ?? NaN;
  if ((mode === "short" || param !== null) && !(Number.isInteger(n) && n > 0)) {
    const why = mode === "short" ? "stopWhen が short（設定件数未満で終了）" : `${paramKey} を付ける`;
    throw new Error(`pagination.${sizeKey} は 1 以上の整数にしてください（${why}ときは必須）`);
  }
  return {
    sizeParam: param,
    size: n,
    isLast: mode === "empty" ? (rows) => rows === 0 : (rows) => rows < n,
  };
}

/**
 * 設定どおりに HTTP で全ページを取得して、生の行（列名 → 値）を返す。
 * 例外メッセージ・ログからはトークンを必ず除く。
 */
export async function fetchRawRows(http: HttpSourceOptions, ctx: FetchRowsContext): Promise<RawRow[]> {
  const { token } = ctx;
  const log = (m: string) => ctx.log(redact(m, token));
  try {
    return await fetchRawRowsInner(http, { ...ctx, log });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const safe = new Error(redact(err.message, token));
    safe.name = err.name;
    throw safe;
  }
}

async function fetchRawRowsInner(http: HttpSourceOptions, ctx: FetchRowsContext): Promise<RawRow[]> {
  const { token, log, from, to } = ctx;
  const maxAttempts = ctx.deps?.maxAttempts ?? 3;
  const baseDelayMs = ctx.deps?.baseDelayMs ?? 1000;
  const sleep = ctx.deps?.sleep ?? defaultSleep;
  const headerName = http.authHeader || "Authorization";
  const scheme = http.authScheme ?? (headerName.toLowerCase() === "authorization" ? "Bearer" : "");
  const headers: Record<string, string> = {
    Accept: "application/json, text/csv;q=0.9, text/plain;q=0.8",
    [headerName]: scheme ? `${scheme} ${token}` : token,
  };
  const method = http.method ?? "GET";
  const pagination: PaginationConfig = http.pagination ?? { type: "none" };

  async function requestOnce(url: string): Promise<Response> {
    const fetchImpl = ctx.deps?.fetchImpl ?? globalThis.fetch;
    let res: Response;
    // リダイレクトは自分で追う。fetch 任せだと Authorization 以外の独自ヘッダ（X-API-Key 等）が別オリジンへ送られる
    let current = url;
    for (let hop = 0; ; hop++) {
      try {
        res = await fetchImpl(current, { method, headers, redirect: "manual" });
      } catch (e) {
        throw new RetryableError(`ネットワークエラー: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.status < 300 || res.status >= 400 || res.status === 304) break;
      const loc = res.headers.get("location");
      if (!loc) break;
      if (hop >= MAX_REDIRECTS) throw new Error(`リダイレクトが ${MAX_REDIRECTS} 回を超えました`);
      const next = new URL(loc, current);
      if (next.origin !== new URL(url).origin) throw new Error("リダイレクト先が別のサーバのため中止しました（トークン保護）");
      current = next.toString();
    }
    if (res.status >= 500) throw new RetryableError(`サーバエラー HTTP ${res.status}`);
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${body}`);
    }
    return res;
  }

  async function request(url: string): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await requestOnce(url);
      } catch (e) {
        lastError = e;
        if (!(e instanceof RetryableError) || attempt === maxAttempts) throw e;
        const delay = baseDelayMs * 2 ** (attempt - 1);
        log(`[http] ${e.message} — ${delay}ms 後に再試行 (${attempt}/${maxAttempts})`);
        await sleep(delay);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async function readPage(res: Response): Promise<Page> {
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const nextLink = parseNextLink(res.headers.get("link"));
    if (contentType.includes("json")) {
      const json: unknown = await res.json();
      const rows = extractArray(json, http.dataPath).map((r) => {
        if (r === null || typeof r !== "object" || Array.isArray(r)) throw new Error("応答 JSON の要素がオブジェクトではありません");
        return r as RawRow;
      });
      return { rows, json, nextLink };
    }
    if (contentType.includes("csv") || contentType.includes("text/plain") || contentType === "") {
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { rows: parseCsvRows(decodeBody(bytes, http.encoding)), json: undefined, nextLink };
    }
    throw new Error(`対応していない Content-Type: ${contentType}`);
  }

  const baseUrl = buildRequestUrl(http, from, to, ctx.members);
  try {
    new URL(baseUrl);
  } catch {
    throw new Error("config の url が URL として読めません");
  }
  const origin = new URL(baseUrl).origin;
  const maxPages = ("maxPages" in pagination ? pagination.maxPages : undefined) ?? DEFAULT_MAX_PAGES;
  if (!(Number.isInteger(maxPages) && maxPages > 0)) throw new Error("pagination.maxPages は 1 以上の整数にしてください");

  // 既存のクエリ文字列は書き換えず（, などの符号化を保つ）、同名があれば置き換え、無ければ末尾に足す
  const withParams = (params: Record<string, string>): string => {
    const u = new URL(baseUrl);
    const keep = u.search === "" ? [] : u.search.slice(1).split("&").filter((kv) => !(decodeKey(kv) in params));
    const add = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    u.search = [...keep, ...add].join("&");
    return u.toString();
  };

  log(`[http] ${from}〜${to} を取得: ${safeUrl(baseUrl)}${ctx.members ? `（${ctx.members.ids.length} 人分）` : ""}${pagination.type !== "none" ? `（ページング: ${pagination.type}）` : ""}`);

  const all: RawRow[] = [];
  const seenSignatures = new Set<string>();
  const seenKeys = new Set<string>();

  const guardRepeat = (rows: RawRow[], pageNo: number) => {
    if (rows.length < 2) return;
    const sig = signature(rows);
    if (seenSignatures.has(sig)) {
      throw new Error(`ページング設定を見直してください: ${pageNo} ページ目が以前のページと同じ内容です（ページ指定が効いていない可能性）`);
    }
    seenSignatures.add(sig);
  };
  const tooMany = () =>
    new Error(`ページ数が上限（${maxPages}）を超えました。ページングの設定（終了条件 stopWhen・maxPages）を確認してください。ファイルは書き換えていません`);

  switch (pagination.type) {
    case "none": {
      all.push(...(await readPage(await request(baseUrl))).rows);
      break;
    }
    case "page": {
      const pg = pagingPlan(pagination.stopWhen, pagination.sizeParam, pagination.size, "size", "sizeParam");
      let page = pagination.startPage ?? 1;
      for (let n = 1; ; n++) {
        if (n > maxPages) throw tooMany();
        const params: Record<string, string> = { [pagination.pageParam]: String(page) };
        if (pg.sizeParam !== null) params[pg.sizeParam] = String(pg.size);
        const p = await readPage(await request(withParams(params)));
        guardRepeat(p.rows, n);
        all.push(...p.rows);
        if (pg.isLast(p.rows.length)) break;
        page++;
      }
      break;
    }
    case "offset": {
      const pg = pagingPlan(pagination.stopWhen, pagination.limitParam, pagination.limit, "limit", "limitParam");
      let offset = 0;
      for (let n = 1; ; n++) {
        if (n > maxPages) throw tooMany();
        const params: Record<string, string> = { [pagination.offsetParam]: String(offset) };
        if (pg.sizeParam !== null) params[pg.sizeParam] = String(pg.size);
        const p = await readPage(await request(withParams(params)));
        guardRepeat(p.rows, n);
        all.push(...p.rows);
        if (pg.isLast(p.rows.length)) break;
        offset += p.rows.length;
      }
      break;
    }
    case "link": {
      let url: string | null = baseUrl;
      for (let n = 1; url !== null; n++) {
        if (n > maxPages) throw tooMany();
        if (seenKeys.has(url)) throw new Error("ページング設定を見直してください: Link ヘッダの next が同じ URL を繰り返しています");
        seenKeys.add(url);
        const p = await readPage(await request(url));
        all.push(...p.rows);
        if (p.nextLink === null) break;
        const next: URL = new URL(p.nextLink, url);
        // トークンを別のサーバへ送らない
        if (next.origin !== origin) throw new Error("Link ヘッダの next が別のサーバを指しているため中止しました（トークン保護）");
        url = next.toString();
      }
      break;
    }
    case "cursor": {
      let cursor: string | null = null;
      for (let n = 1; ; n++) {
        if (n > maxPages) throw tooMany();
        const p = await readPage(await request(cursor === null ? baseUrl : withParams({ [pagination.cursorParam]: cursor })));
        all.push(...p.rows);
        const c = digJson(p.json, pagination.cursorPath);
        const v = c.found ? c.value : null;
        if (v === null || v === undefined || v === "") break;
        const next = String(v);
        if (seenKeys.has(next)) throw new Error("ページング設定を見直してください: 同じカーソルが繰り返されました");
        seenKeys.add(next);
        cursor = next;
      }
      break;
    }
    default: {
      const t: never = pagination;
      throw new Error(`未対応の pagination.type: ${JSON.stringify(t)}`);
    }
  }
  log(`[http] 応答 ${all.length} 行`);
  return all;
}
