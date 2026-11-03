/**
 * http アダプタ: 社内の工数管理 API から JSON または CSV で作業実績を取得する（汎用）
 *
 * config.worklogSource.http:
 *   url          取得 URL。{from} {to}（YYYY-MM）、{fromDate} {toDate}（YYYY-MM-DD。月初・月末）に置換される
 *                例: https://worklog.example.local/api/export?from={from}&to={to}
 *   authHeader   トークンを載せるヘッダ名（既定 Authorization）
 *   authScheme   （任意）ヘッダ値の接頭辞。既定は Authorization のとき "Bearer"、それ以外は無し
 *   dataPath     （任意）JSON 応答で配列が入っているキー。"data.items" のようにドット区切り
 *   columns      予実ナビの項目名 → 取得元の列名。"member.id" のように入れ子、["a","b"] で複数候補。taskCode（作業コード。§92）は省略可
 *   dateFormat   （任意）YYYY-MM-DD / YYYY/MM/DD / YYYYMMDD / ISO8601 / epochMillis。既定は自動判定
 *   hoursUnit    （任意）hours（既定）/ minutes / seconds
 *   pagination   （任意）none / page / offset / link / cursor（src/core/types.ts の PaginationConfig）。
 *                page / offset は件数パラメータの省略・終了条件 stopWhen（short / empty）・maxPages を指定できる
 *   query        （任意）追加のクエリ文字列（固定値）
 *   filters      （任意）取り込まない行の条件 [{ column, equals | notEquals | in }]
 *   encoding     （任意）CSV 応答の文字コード auto / utf-8 / shift_jis
 *   refetchMonths 直近何か月を取り直すか（fetch-worklogs.ts が使う）
 *   members      （任意）取得対象の社員番号を渡す（§87）。{ param, style: join|repeat, separator, chunkSize }
 *                社員番号はメンバーマスタから作る（設定には書かない）。chunkSize 人（既定 50）ずつ分けて取得し、
 *                1 回でも失敗すれば全体を失敗にする（一部の人だけの結果で月ファイルを書き換えない）
 *
 * 環境変数:
 *   WORKLOG_API_TOKEN  認証トークン。ログ・例外メッセージには絶対に出さない
 *
 * 応答形式は Content-Type で判定する（application/json → JSON、text/csv 等 → CSV）。
 * 5xx とネットワークエラーは指数バックオフで最大 3 回再試行する。4xx は再試行しない。
 * 実処理は ./http-source.ts（メンバー取り込みと共有）。
 */
import type { DateFormat, Worklog, WorklogColumns, WorklogSourceConfig } from "../../src/core/types.js";
import { chunk } from "../lib/fetch-targets.js";
import {
  assertColumns,
  checkMemberTarget,
  fetchRawRows,
  passesFilters,
  parseDate,
  pickValue,
  resolveMapping,
  toHours,
  type ColumnRequirement,
  type HttpAdapterDeps,
  type RawRow,
} from "./http-source.js";
import type { FetchOptions, WorklogAdapter } from "./types.js";

export { RetryableError, extractArray, type HttpAdapterDeps } from "./http-source.js";

/** types.ts の http 設定（後方互換のための別名） */
export type HttpSourceConfig = WorklogSourceConfig["http"];

export interface MapRowOptions {
  dateFormat?: DateFormat | undefined;
  hoursUnit?: "hours" | "minutes" | "seconds" | undefined;
}

/** members.chunkSize の既定（1 リクエストにまとめる人数） */
export const DEFAULT_CHUNK_SIZE = 50;

const FIELDS: Array<Exclude<keyof Worklog, "taskCode">> = ["date", "memberId", "memberName", "customerName", "projectName", "task", "hours"];

/** 取得元の1行（列名 → 値）を Worklog にする */
export function mapRow(row: RawRow, columns: WorklogColumns, opts: MapRowOptions = {}): Worklog {
  const str = (k: keyof Worklog): string => {
    const v = pickValue(row, columns[k]);
    return v === null || v === undefined ? "" : String(v);
  };
  const dateRaw = pickValue(row, columns.date);
  let date = "";
  if (dateRaw !== undefined) {
    const d = parseDate(dateRaw, opts.dateFormat);
    if (d === null) throw new Error(`日付を ${opts.dateFormat} として読めません。dateFormat の設定を確認してください`);
    date = d;
  }
  // 時間が空のときは従来どおり 0 として扱う（validate や集計側で気づける）
  const hoursRaw = pickValue(row, columns.hours);
  const hours = hoursRaw === undefined ? 0 : toHours(hoursRaw, opts.hoursUnit);
  const code = columns.taskCode !== undefined ? str("taskCode").trim() : "";
  return {
    date,
    memberId: str("memberId").trim(),
    memberName: str("memberName").trim(),
    customerName: str("customerName"),
    projectName: str("projectName"),
    task: str("task"),
    hours: Number.isFinite(hours) ? hours : NaN,
    // 作業コード（§92）は columns.taskCode を設定したときだけ
    ...(code !== "" ? { taskCode: code } : {}),
  };
}

export function createHttpAdapter(deps: HttpAdapterDeps = {}): WorklogAdapter {
  return {
    name: "http",
    async fetch({ from, to, config, env, log, report, memberIds }: FetchOptions): Promise<Worklog[]> {
      const logFn = log ?? ((m: string) => console.error(m));
      const http = config.worklogSource.http;
      if (!http.url) throw new Error("config.worklogSource.http.url が設定されていません");
      const token = env.WORKLOG_API_TOKEN ?? "";
      if (token === "") throw new Error("環境変数 WORKLOG_API_TOKEN が設定されていません");

      const reqs: ColumnRequirement[] = FIELDS.map((field): ColumnRequirement => ({ field, spec: http.columns[field] }));
      let raw: RawRow[];
      if (http.members) {
        // 取得対象の社員番号を chunkSize 人ずつ渡す（§87）。どれか 1 回でも失敗したら例外 = 何も書かない
        checkMemberTarget(http, http.members);
        const ids = memberIds ?? [];
        if (ids.length === 0) throw new Error("取得対象の社員番号がありません（メンバーマスタに期間内に在籍している人がいません）");
        const size = http.members.chunkSize ?? DEFAULT_CHUNK_SIZE;
        const groups = chunk(ids, size);
        logFn(`[http] 取得対象 ${ids.length} 人を ${size} 人ずつ ${groups.length} 回に分けて取得`);
        raw = [];
        for (const [i, g] of groups.entries()) {
          try {
            const part = await fetchRawRows(http, { from, to, token, log: logFn, deps, members: { config: http.members, ids: g } });
            // 回ごとに列を確かめる（2 回目以降だけ列が欠けていても、時間 0 などで書き換えない）
            assertColumns(part[0], reqs, http.filters);
            raw.push(...part);
          } catch (e) {
            throw new Error(`${i + 1}/${groups.length} 回目（${g[0]}〜${g[g.length - 1]}）で失敗: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } else {
        raw = await fetchRawRows(http, { from, to, token, log: logFn, deps });
      }

      assertColumns(raw[0], reqs, http.filters);
      // 作業コード（§92）は設定したときだけ。値の無い行は列ごと省かれることがあるので、どれか 1 行にあればよい（列名の打ち間違いだけ止める）
      if (http.columns.taskCode !== undefined) {
        const codeReq: ColumnRequirement = { field: "taskCode", spec: http.columns.taskCode };
        const found = raw.find((r) => resolveMapping(r, [codeReq])[0]?.resolved != null);
        if (raw.length > 0 && !found) assertColumns(raw[0], [codeReq]);
        reqs.push(codeReq);
      }
      const rows = raw.filter((r) => passesFilters(r, http.filters));
      if (report) {
        report({
          rawColumns: raw[0] ? Object.keys(raw[0]) : [],
          mapping: resolveMapping(raw[0], reqs),
          rawRowCount: raw.length,
          filteredOut: raw.length - rows.length,
        });
      }

      const out: Worklog[] = [];
      let outOfRange = 0;
      let firstOut = "";
      let n = 0;
      for (const r of rows) {
        n++;
        let w: Worklog;
        try {
          w = mapRow(r, http.columns, { dateFormat: http.dateFormat, hoursUnit: http.hoursUnit });
        } catch (e) {
          throw new Error(`${n} 行目: ${e instanceof Error ? e.message : String(e)}`);
        }
        // 期間外の行は捨てる（API 側の仕様にかかわらず月ファイルの境界を守る）
        const ym = w.date.slice(0, 7);
        if (ym < from || ym > to) {
          outOfRange++;
          if (firstOut === "") firstOut = w.date;
          continue;
        }
        out.push(w);
      }
      if (outOfRange > 0) logFn(`[http] 期間外（${from}〜${to} 以外）の ${outOfRange} 行を除きました`);
      // 取得できたのに全行が期間外 = 日付の読み違いの可能性が高い。空で月ファイルを上書きさせない
      if (rows.length > 0 && out.length === 0) {
        throw new Error(
          `取得した ${rows.length} 行がすべて期間外（${from}〜${to} 以外）と判定されました。日付の形式（columns.date / dateFormat）を確認してください（変換後の日付の例: ${firstOut}）`,
        );
      }
      logFn(`[http] ${out.length} 行を取得`);
      return out;
    },
  };
}

export const httpAdapter: WorklogAdapter = createHttpAdapter();
