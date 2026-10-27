/**
 * http アダプタ: 社内の工数管理 API から JSON または CSV で作業実績を取得する（汎用）
 *
 * config.worklogSource.http:
 *   url          取得 URL。{from} {to} が年月（YYYY-MM）に置換される
 *                例: https://worklog.example.local/api/export?from={from}&to={to}
 *   authHeader   トークンを載せるヘッダ名（既定 Authorization）
 *   authScheme   （任意）ヘッダ値の接頭辞。既定は Authorization のとき "Bearer"、それ以外は無し
 *   dataPath     （任意）JSON 応答で配列が入っているキー。"data.items" のようにドット区切り
 *   columns      取得元の列名 → 予実ナビの項目名（date, memberId, ...）
 *   refetchMonths 直近何か月を取り直すか（fetch-worklogs.ts が使う）
 *
 * 環境変数:
 *   WORKLOG_API_TOKEN  認証トークン。ログには絶対に出さない
 *
 * 応答形式は Content-Type で判定する（application/json → JSON、text/csv 等 → CSV）。
 * 5xx とネットワークエラーは指数バックオフで最大 3 回再試行する。4xx は再試行しない。
 */
import { csvParse } from "d3-dsv";
import type { Worklog, WorklogSourceConfig } from "../../src/core/types.js";
import { stripBom } from "../lib/csv.js";
import type { FetchOptions, WorklogAdapter } from "./types.js";

/** types.ts の http 設定に、任意の拡張項目を加えたもの */
export type HttpSourceConfig = WorklogSourceConfig["http"] & {
  authScheme?: string;
  dataPath?: string;
  method?: "GET" | "POST";
};

export interface HttpAdapterDeps {
  fetchImpl?: typeof fetch;
  /** 再試行の待ち時間（テストでは 0 にする） */
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
}

/** 再試行すべきエラー */
export class RetryableError extends Error {
  override readonly name = "RetryableError";
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** JSON の中から dataPath で配列を取り出す */
export function extractArray(json: unknown, dataPath: string | undefined): unknown[] {
  let cur: unknown = json;
  if (dataPath && dataPath.trim() !== "") {
    for (const key of dataPath.split(".")) {
      if (cur !== null && typeof cur === "object" && key in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[key];
      } else {
        throw new Error(`応答 JSON に dataPath "${dataPath}" が見つかりません（キー "${key}"）`);
      }
    }
  }
  if (!Array.isArray(cur)) throw new Error(`応答 JSON が配列ではありません${dataPath ? `（dataPath=${dataPath}）` : ""}`);
  return cur;
}

/** 取得元の1行（列名 → 値）を Worklog にする */
export function mapRow(row: Record<string, unknown>, columns: Record<keyof Worklog, string>): Worklog {
  const str = (k: keyof Worklog): string => {
    const v = row[columns[k]];
    return v === null || v === undefined ? "" : String(v);
  };
  const hoursRaw = row[columns.hours];
  const hours = typeof hoursRaw === "number" ? hoursRaw : Number(String(hoursRaw ?? "").trim());
  return {
    date: str("date").trim().slice(0, 10).replace(/\//g, "-"),
    memberId: str("memberId").trim(),
    memberName: str("memberName").trim(),
    customerName: str("customerName"),
    projectName: str("projectName"),
    task: str("task"),
    hours: Number.isFinite(hours) ? hours : NaN,
  };
}

function buildUrl(template: string, from: string, to: string): string {
  return template.replaceAll("{from}", encodeURIComponent(from)).replaceAll("{to}", encodeURIComponent(to));
}

export function createHttpAdapter(deps: HttpAdapterDeps = {}): WorklogAdapter {
  const maxAttempts = deps.maxAttempts ?? 3;
  const baseDelayMs = deps.baseDelayMs ?? 1000;
  const sleep = deps.sleep ?? defaultSleep;

  async function requestOnce(url: string, init: RequestInit, log: (m: string) => void): Promise<Response> {
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (e) {
      // ネットワークエラー（DNS、接続拒否、タイムアウト等）
      throw new RetryableError(`ネットワークエラー: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status >= 500) {
      throw new RetryableError(`サーバエラー HTTP ${res.status}`);
    }
    if (!res.ok) {
      // 4xx は設定・認証の問題なので再試行しない。本文の先頭だけ出す（トークンは含まれない）
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${body}`);
    }
    void log;
    return res;
  }

  return {
    name: "http",
    async fetch({ from, to, config, env, log }: FetchOptions): Promise<Worklog[]> {
      const logFn = log ?? ((m: string) => console.error(m));
      const http = config.worklogSource.http as HttpSourceConfig;
      if (!http.url) throw new Error("config.worklogSource.http.url が設定されていません");
      const token = env.WORKLOG_API_TOKEN ?? "";
      if (token === "") throw new Error("環境変数 WORKLOG_API_TOKEN が設定されていません");

      const headerName = http.authHeader || "Authorization";
      const scheme = http.authScheme ?? (headerName.toLowerCase() === "authorization" ? "Bearer" : "");
      const headers: Record<string, string> = {
        Accept: "application/json, text/csv;q=0.9, text/plain;q=0.8",
        [headerName]: scheme ? `${scheme} ${token}` : token,
      };
      const url = buildUrl(http.url, from, to);
      const init: RequestInit = { method: http.method ?? "GET", headers };
      // URL にトークンが含まれる設計は想定しないが、念のためログには URL のホストとパスだけ出す
      const safeUrl = (() => {
        try {
          const u = new URL(url);
          return `${u.origin}${u.pathname}`;
        } catch {
          return "(invalid url)";
        }
      })();
      logFn(`[http] ${from}〜${to} を取得: ${safeUrl}`);

      let res: Response | undefined;
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          res = await requestOnce(url, init, logFn);
          break;
        } catch (e) {
          lastError = e;
          if (!(e instanceof RetryableError) || attempt === maxAttempts) throw e;
          const delay = baseDelayMs * 2 ** (attempt - 1);
          logFn(`[http] ${e.message} — ${delay}ms 後に再試行 (${attempt}/${maxAttempts})`);
          await sleep(delay);
        }
      }
      if (!res) throw lastError instanceof Error ? lastError : new Error(String(lastError));

      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      const columns = http.columns;
      let rows: Record<string, unknown>[];
      if (contentType.includes("json")) {
        const json: unknown = await res.json();
        rows = extractArray(json, http.dataPath).map((r) => {
          if (r === null || typeof r !== "object") throw new Error("応答 JSON の要素がオブジェクトではありません");
          return r as Record<string, unknown>;
        });
      } else if (contentType.includes("csv") || contentType.includes("text/plain") || contentType === "") {
        const text = stripBom(await res.text());
        rows = text.trim() === "" ? [] : (csvParse(text) as unknown as Record<string, unknown>[]);
      } else {
        throw new Error(`対応していない Content-Type: ${contentType}`);
      }

      const out: Worklog[] = [];
      for (const r of rows) {
        const w = mapRow(r, columns);
        // 期間外の行は捨てる（API 側の仕様にかかわらず月ファイルの境界を守る）
        const ym = w.date.slice(0, 7);
        if (ym < from || ym > to) continue;
        out.push(w);
      }
      logFn(`[http] ${out.length} 行を取得`);
      return out;
    },
  };
}

export const httpAdapter: WorklogAdapter = createHttpAdapter();
