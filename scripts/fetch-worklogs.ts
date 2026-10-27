/**
 * 作業実績の取得: 直近 N か月分を取り直して data/worklogs/YYYY-MM.csv を書き換える
 *
 *   npm run fetch                       # config.worklogSource.adapter で取得
 *   npx tsx scripts/fetch-worklogs.ts --months 3 --asOf 2026-10-27 --adapter http
 *
 * - 取り直す月数は config.worklogSource.http.refetchMonths（既定 3）。
 *   前月分の修正入力（締め後の訂正）を拾うため、毎回「今月を含む直近 N か月」を上書きする。
 * - 対象月のファイルだけを書き換え、それ以外の月は触らない。
 * - 同じ入力なら同じ出力（行は日付→メンバー→顧客順に並べる）。冪等。
 * - _meta.json に fetchedAt（ISO 8601）と adapter を書く。
 *
 * 環境変数: WORKLOG_API_TOKEN（http アダプタ）、WORKLOG_ADAPTER（アダプタ名の上書き）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Worklog, YearMonth } from "../src/core/types.js";
import { selectAdapter } from "./adapters/index.js";
import { formatWorklogCsv, sortWorklogs } from "./lib/csv.js";
import { loadConfig, readWorklogMeta, worklogDir } from "./lib/load.js";

interface CliOptions {
  rootDir: string;
  /** 取り直す月数（省略時は config の refetchMonths） */
  months?: number;
  /** 基準日（省略時は今日）。テストや再現用 */
  asOf?: string;
  /** アダプタ名の上書き */
  adapter?: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function addMonths(ym: YearMonth, n: number): YearMonth {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}`;
}

/** 基準日を含む直近 n か月（昇順） */
export function recentMonths(asOf: string, n: number): YearMonth[] {
  const last = asOf.slice(0, 7);
  const out: YearMonth[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addMonths(last, -i));
  return out;
}

/** 今日の日付（JST）を YYYY-MM-DD で返す */
function todayJst(): string {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export interface FetchResult {
  months: YearMonth[];
  rowsByMonth: Record<YearMonth, number>;
  adapter: string;
  fetchedAt: string;
}

export async function fetchWorklogs(opts: CliOptions, env: NodeJS.ProcessEnv = process.env, now: () => Date = () => new Date()): Promise<FetchResult> {
  const config = loadConfig(opts.rootDir);
  const adapter = selectAdapter(config, opts.adapter ? { ...env, WORKLOG_ADAPTER: opts.adapter } : env);
  const n = Math.max(1, opts.months ?? config.worklogSource.http?.refetchMonths ?? 3);
  const asOf = opts.asOf ?? todayJst();
  const months = recentMonths(asOf, n);
  const from = months[0];
  const to = months[months.length - 1];
  if (!from || !to) throw new Error("対象月がありません");

  const log = (m: string) => console.error(m);
  log(`[fetch] アダプタ=${adapter.name} 対象月=${from}〜${to}`);
  const rows = await adapter.fetch({ from, to, config, env, rootDir: opts.rootDir, log });

  // 月ごとに振り分け（期間外は捨てる。対象月でデータが 0 件でも空ファイルを書く＝取り消しを反映）
  const byMonth = new Map<YearMonth, Worklog[]>(months.map((m) => [m, []]));
  for (const w of rows) {
    const ym = w.date.slice(0, 7);
    const list = byMonth.get(ym);
    if (list) list.push(w);
  }

  const dir = worklogDir(opts.rootDir, config);
  mkdirSync(dir, { recursive: true });
  const rowsByMonth: Record<YearMonth, number> = {};
  for (const ym of months) {
    const list = sortWorklogs(byMonth.get(ym) ?? []);
    writeFileSync(join(dir, `${ym}.csv`), formatWorklogCsv(list));
    rowsByMonth[ym] = list.length;
    log(`[fetch] ${ym}.csv を書き込み (${list.length} 行)`);
  }

  const fetchedAt = now().toISOString();
  const prev = readWorklogMeta(dir);
  const meta = { ...prev, fetchedAt, adapter: adapter.name, refetchedMonths: months };
  writeFileSync(join(dir, "_meta.json"), JSON.stringify(meta, null, 2) + "\n");
  return { months, rowsByMonth, adapter: adapter.name, fetchedAt };
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { rootDir: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--months" && v !== undefined) {
      opts.months = Number(v);
      i++;
    } else if (a === "--asOf" && v !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--asOf は YYYY-MM-DD 形式で指定してください: ${v}`);
      opts.asOf = v;
      i++;
    } else if (a === "--adapter" && v !== undefined) {
      opts.adapter = v;
      i++;
    } else if (a === "--root" && v !== undefined) {
      opts.rootDir = v;
      i++;
    }
  }
  return opts;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  fetchWorklogs(parseArgs(process.argv.slice(2)))
    .then((r) => {
      console.log(`作業実績を更新しました: ${r.months.join(", ")} (adapter=${r.adapter}, fetchedAt=${r.fetchedAt})`);
    })
    .catch((e: unknown) => {
      console.error(`取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
