/**
 * 作業実績の取得: 直近 N か月分を取り直して data/worklogs/YYYY-MM.csv を書き換える
 *
 *   npm run fetch                       # config.worklogSource.adapter で取得
 *   npm run fetch -- --dry-run --sample=5   # ファイルを書かず、列の対応表と変換結果の先頭 N 行を表示（本番での初回設定用）
 *   npx tsx scripts/fetch-worklogs.ts --months 3 --asOf 2026-10-27 --adapter http
 *   npm run fetch -- --from 2025-04 --to 2025-09                  # 過去の期間を取り直す（対象者はその期間の在籍者。§87）
 *   npm run fetch -- --from 2025-04 --to 2025-09 --members M050,M051   # 指定した人の行だけ取り直す（他の人の行は残す）
 *   npm run fetch -- --initial                                    # 初回の取り込み: 今年度の初め（config.fiscalYearStartMonth）から今月まで（§96）
 *
 * 取り込む期間は 3 とおり（§96）: 通常＝直近 refetchMonths か月（スケジュール実行）、初回＝今年度の初めから今月まで（--initial / FETCH_MODE=initial）、
 * 必要なとき＝任意の期間（--from / --to / FETCH_FROM・FETCH_TO）。
 *
 * - 取り直す月数は config.worklogSource.http.refetchMonths（既定 3）。
 *   前月分の修正入力（締め後の訂正）を拾うため、毎回「今月を含む直近 N か月」を上書きする。
 * - 対象月のファイルだけを書き換え、それ以外の月は触らない。
 * - 同じ入力なら同じ出力（行は日付→メンバー→顧客順に並べる）。冪等。
 * - _meta.json に fetchedAt（ISO 8601）と adapter を書く。
 * - worklogSource.http.members を設定すると、取得対象の社員番号をメンバーマスタから作って API に渡す（§87）。
 * - 取得に失敗したら月ファイルは 1 つも書き換えず、_meta.json の lastFailure に記録する（データ確認画面に出る）。
 *   次に成功すると lastFailure は消える。
 *
 * 環境変数: WORKLOG_API_TOKEN（http アダプタ）、WORKLOG_ADAPTER（アダプタ名の上書き）
 *           FETCH_FROM / FETCH_TO / FETCH_MEMBERS（CI の手動実行で --from / --to / --members の代わり。scripts/ci/fetch-data.mjs が渡す）
 *           FETCH_MODE=initial（--initial の代わり。CI の Run pipeline で入れる）
 *           FETCH_ACCEPT_TASK_CHANGES=1（--accept-task-changes。作業名の変更を確かめたので取り込む。§92）
 * - config.taskCodeCheck（§92）で作業コードを点検する。stop の設定なら、未登録の作業コード・新しい作業名の変更があるとき月ファイルを書かずに止める
 */
import { mkdirSync } from "node:fs";
import { writeFilesAtomic } from "./lib/atomic.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Worklog, YearMonth } from "../src/core/types.js";
import { selectAdapter } from "./adapters/index.js";
import type { FetchReport } from "./adapters/http-source.js";
import { formatMappingTable } from "./lib/dry-run.js";
import { formatWorklogCsv, parseWorklogCsv, sortWorklogs } from "./lib/csv.js";
import { readTextAuto } from "./lib/encoding.js";
import { clearFailure, safeMessage, writeFailure } from "./lib/fetch-status.js";
import { parseMemberList, readMemberRecords, targetMemberIds } from "./lib/fetch-targets.js";
import { listWorklogFiles, loadConfig, readWorklogMeta, worklogDir } from "./lib/load.js";
import { enforceTaskCodeGate, inspectTaskCodes, readCodeRules } from "./lib/task-code-gate.js";
import { taskCodeCheckEnabled } from "../src/core/taskCodes.js";
import { existsSync } from "node:fs";

interface CliOptions {
  rootDir: string;
  /** 取り直す月数（省略時は config の refetchMonths） */
  months?: number;
  /** 取り直す期間（YYYY-MM。指定すると months より優先。過去の再取得用。§87） */
  from?: YearMonth;
  to?: YearMonth;
  /** 初回の取り込み: 今年度の初めから今月まで（§96。--from / --to とは一緒に使えない） */
  initial?: boolean;
  /** 取り直す人を明示する（指定した人の行だけ差し替え、他の人の行は残す。§87） */
  members?: string[];
  /** 基準日（省略時は今日）。テストや再現用 */
  asOf?: string;
  /** アダプタ名の上書き */
  adapter?: string;
  /** ファイルを書かず、対応表と先頭 N 行を表示するための結果を返す */
  dryRun?: boolean;
  /** dry-run で表示する行数（既定 5） */
  sample?: number;
  /** 作業名の変更（§92）を確かめたので、onChange=stop でも取り込む */
  acceptTaskChanges?: boolean;
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
  /** 取得対象の人数（メンバーマスタから作った・--members で指定した。対象を絞らないときは undefined） */
  targetCount?: number;
  /** --members で人を指定したか（その人の行だけ差し替え） */
  partial?: boolean;
  rowsByMonth: Record<YearMonth, number>;
  adapter: string;
  fetchedAt: string;
  dryRun?: { total: number; sample: Worklog[]; report?: FetchReport };
  /** 作業コードの点検（§92）の警告（止めなかったもの） */
  taskCodeWarnings?: string[];
}

/** from〜to の月（昇順） */
function monthsBetween(from: YearMonth, to: YearMonth): YearMonth[] {
  const out: YearMonth[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

/** 基準日を含む年度の最初の月（年度は fiscalYearStartMonth 月に始まる。§96） */
export function fiscalYearStart(asOf: string, fiscalYearStartMonth = 4): YearMonth {
  const start = Number.isInteger(fiscalYearStartMonth) && fiscalYearStartMonth >= 1 && fiscalYearStartMonth <= 12 ? fiscalYearStartMonth : 4;
  const [y, m] = asOf.slice(0, 7).split("-").map(Number) as [number, number];
  return `${m >= start ? y : y - 1}-${pad2(start)}`;
}

/** 取り直す期間: 初回なら今年度の初めから今月、--from/--to があればそれ、無ければ基準日を含む直近 N か月（§96） */
export function targetMonths(opts: Pick<CliOptions, "from" | "to" | "months" | "initial">, asOf: string, refetchMonths: number | undefined, fiscalYearStartMonth?: number): YearMonth[] {
  if (opts.initial) {
    if (opts.from !== undefined || opts.to !== undefined) throw new Error("--initial（FETCH_MODE=initial）と --from / --to（FETCH_FROM / FETCH_TO）は一緒に使えません");
    return monthsBetween(fiscalYearStart(asOf, fiscalYearStartMonth), asOf.slice(0, 7));
  }
  if (opts.from !== undefined || opts.to !== undefined) {
    const from = opts.from ?? opts.to ?? "";
    const to = opts.to ?? asOf.slice(0, 7);
    if (from > to) throw new Error(`--from（${from}）が --to（${to}）より後です`);
    return monthsBetween(from, to);
  }
  return recentMonths(asOf, Math.max(1, opts.months ?? refetchMonths ?? 3));
}

export async function fetchWorklogs(opts: CliOptions, env: NodeJS.ProcessEnv = process.env, now: () => Date = () => new Date()): Promise<FetchResult> {
  const config = loadConfig(opts.rootDir);
  const dir = worklogDir(opts.rootDir, config);
  try {
    return await fetchWorklogsInner(opts, config, dir, env, now);
  } catch (e) {
    // 失敗: 月ファイルは書き換えていない。データ確認画面に出すため _meta.json に記録だけ残す（§87）
    const message = safeMessage(e instanceof Error ? e.message : String(e), [env.WORKLOG_API_TOKEN]);
    if (!opts.dryRun) {
      try {
        mkdirSync(dir, { recursive: true });
        writeFailure(join(dir, "_meta.json"), now().toISOString(), message);
      } catch {
        // 記録に失敗しても、元のエラーを優先して返す
      }
    }
    throw new Error(message);
  }
}

async function fetchWorklogsInner(opts: CliOptions, config: ReturnType<typeof loadConfig>, dir: string, env: NodeJS.ProcessEnv, now: () => Date): Promise<FetchResult> {
  const adapter = selectAdapter(config, opts.adapter ? { ...env, WORKLOG_ADAPTER: opts.adapter } : env);
  const asOf = opts.asOf ?? todayJst();
  const months = targetMonths(opts, asOf, config.worklogSource.http?.refetchMonths, config.fiscalYearStartMonth);
  const from = months[0];
  const to = months[months.length - 1];
  if (!from || !to) throw new Error("対象月がありません");

  const log = (m: string) => console.error(m);
  // 取得対象の人（§87）: --members で指定した人、無ければ http.members を設定したときだけメンバーマスタの在籍者
  // 人の指定が空（区切りだけ・空の変数）を「指定なし」と扱うと、全員分の書き直しに広がってしまうので止める
  if (opts.members !== undefined && opts.members.length === 0) throw new Error("--members（FETCH_MEMBERS）に社員番号がありません");
  const explicit = opts.members;
  let memberIds: string[] | undefined = explicit;
  if (!memberIds && adapter.name === "http" && config.worklogSource.http?.members) {
    memberIds = targetMemberIds(readMemberRecords(opts.rootDir, config), from, to);
  }
  log(`[fetch] アダプタ=${adapter.name} 対象月=${from}〜${to}${memberIds ? ` 対象者=${memberIds.length} 人${explicit ? "（指定。その人の行だけ差し替え）" : "（メンバーマスタから）"}` : ""}`);
  let report: FetchReport | undefined;
  const fetched = await adapter.fetch({ from, to, asOf, config, env, rootDir: opts.rootDir, log, report: (r) => (report = r), ...(memberIds ? { memberIds } : {}) });
  // 人を指定したときは、その人の行だけを使う（API が全員分を返す場合や csv・dummy アダプタでも同じ結果にする）
  const only = explicit ? new Set(explicit) : null;
  const rows = only ? fetched.filter((w) => only.has(w.memberId.trim())) : fetched;

  // 作業コードの点検（§92）: 取り込んだ後のデータで調べる。stop の設定なら書く前に止める
  // 人を指定したときは、既存の月ファイルのうち指定外の人の行を残す
  const mergeMonth = (ym: YearMonth, fresh: Worklog[]): Worklog[] => {
    const kept = only ? readMonthRows(join(dir, `${ym}.csv`)).filter((w) => !only.has(w.memberId.trim())) : [];
    return sortWorklogs([...kept, ...fresh]);
  };
  const gateFor = (fresh: ReadonlyMap<YearMonth, Worklog[]>) => {
    if (!taskCodeCheckEnabled(config.taskCodeCheck)) return null;
    const existing = listWorklogFiles(dir).map((f) => ({ month: f.month, rows: readMonthRows(f.path) }));
    const before = existing.flatMap((f) => f.rows);
    const after = [...existing.filter((f) => !fresh.has(f.month)).flatMap((f) => f.rows), ...[...fresh.values()].flat()];
    return inspectTaskCodes(config, readCodeRules(opts.rootDir), before, after);
  };

  if (opts.dryRun) {
    // 書き込むときと同じ（指定外の人の既存行を残した）月の一覧で点検する
    const dryGate = gateFor(new Map(months.map((ym) => [ym, mergeMonth(ym, rows.filter((w) => w.date.slice(0, 7) === ym))])));
    const sample = sortWorklogs(rows).slice(0, Math.max(0, opts.sample ?? 5));
    const dry: NonNullable<FetchResult["dryRun"]> = { total: rows.length, sample };
    if (report) dry.report = report;
    const rowsByMonth: Record<YearMonth, number> = {};
    for (const ym of months) rowsByMonth[ym] = rows.filter((w) => w.date.slice(0, 7) === ym).length;
    return { months, rowsByMonth, adapter: adapter.name, fetchedAt: now().toISOString(), dryRun: dry, ...(dryGate ? { taskCodeWarnings: dryGate.lines } : {}), ...(memberIds ? { targetCount: memberIds.length } : {}), ...(explicit ? { partial: true } : {}) };
  }

  // 月ごとに振り分け（期間外は捨てる。対象月でデータが 0 件でも空ファイルを書く＝取り消しを反映）
  const byMonth = new Map<YearMonth, Worklog[]>(months.map((m) => [m, []]));
  let outOfRange = 0;
  for (const w of rows) {
    const ym = w.date.slice(0, 7);
    const list = byMonth.get(ym);
    if (list) list.push(w);
    else outOfRange++;
  }
  if (outOfRange > 0) log(`[fetch] 対象月（${from}〜${to}）以外の ${outOfRange} 行を除きました`);
  // 取得行があるのに全て対象月外なら、日付の読み違いの可能性が高い。既存の月ファイルを空で上書きしない
  if (rows.length > 0 && outOfRange === rows.length) {
    throw new Error(`取得した ${rows.length} 行がすべて対象月（${from}〜${to}）の外でした。日付の形式を確認してください。月ファイルは書き換えていません`);
  }

  mkdirSync(dir, { recursive: true });
  const rowsByMonth: Record<YearMonth, number> = {};
  const outputs: Array<{ path: string; data: string }> = [];
  const lists = new Map<YearMonth, Worklog[]>();
  for (const ym of months) {
    const list = mergeMonth(ym, byMonth.get(ym) ?? []);
    lists.set(ym, list);
    outputs.push({ path: join(dir, `${ym}.csv`), data: formatWorklogCsv(list) });
    rowsByMonth[ym] = list.length;
  }
  const taskCodeLines = enforceTaskCodeGate(config, gateFor(lists), opts.acceptTaskChanges === true);
  for (const line of taskCodeLines) log(`[fetch] 警告: ${line}`);

  const fetchedAt = now().toISOString();
  const prev = readWorklogMeta(dir);
  // 成功したので前回の失敗の記録は消す。人を指定した取り直しは「全員分の取得日時」ではないので fetchedAt を変えない
  const { lastFailure: _lastFailure, ...rest } = prev;
  const meta = explicit ? { ...rest } : { ...rest, fetchedAt, adapter: adapter.name, refetchedMonths: months };
  outputs.push({ path: join(dir, "_meta.json"), data: JSON.stringify(meta, null, 2) + "\n" });
  // 全月を書けたときだけまとめて差し替える（途中で失敗しても、一部の月だけ新しい・空のファイルが残る状態にしない）
  writeFilesAtomic(outputs);
  for (const ym of months) log(`[fetch] ${ym}.csv を書き込み (${rowsByMonth[ym]} 行)`);
  return { months, rowsByMonth, adapter: adapter.name, fetchedAt, ...(taskCodeLines.length > 0 ? { taskCodeWarnings: taskCodeLines } : {}), ...(memberIds ? { targetCount: memberIds.length } : {}), ...(explicit ? { partial: true } : {}) };
}

/** 既存の月ファイルの行（無ければ空） */
function readMonthRows(path: string): Worklog[] {
  return existsSync(path) ? parseWorklogCsv(readTextAuto(path)) : [];
}

/** --dry-run の表示 */
export function formatDryRun(r: FetchResult): string[] {
  const d = r.dryRun;
  if (!d) return [];
  const out = [`[dry-run] ファイルは書き込みません（adapter=${r.adapter}、対象月 ${r.months.join(", ")}${r.targetCount !== undefined ? `、対象 ${r.targetCount} 人` : ""}）`, ""];
  if (d.report) out.push(...formatMappingTable(d.report), "");
  out.push(`変換後 ${d.total} 行（月別: ${r.months.map((m) => `${m}=${r.rowsByMonth[m] ?? 0}`).join(", ")}）。先頭 ${d.sample.length} 行:`);
  for (const w of d.sample) out.push(`  ${w.date}\t${w.memberId}\t${w.memberName}\t${w.customerName}\t${w.projectName}\t${w.task}\t${w.hours}${w.taskCode ? `\t${w.taskCode}` : ""}`);
  if (r.taskCodeWarnings && r.taskCodeWarnings.length > 0) out.push("", `作業コードの点検（${r.taskCodeWarnings.length} 件）:`, ...r.taskCodeWarnings.map((l) => `  ${l}`));
  return out;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = {}): CliOptions {
  const opts: CliOptions = { rootDir: process.cwd() };
  // CI の手動実行（Run pipeline の変数）。コマンドラインの指定があればそちらを優先する
  const fromEnv: string[] = [];
  if (env.FETCH_FROM?.trim()) fromEnv.push("--from", env.FETCH_FROM.trim());
  if (env.FETCH_TO?.trim()) fromEnv.push("--to", env.FETCH_TO.trim());
  if (env.FETCH_MEMBERS !== undefined && env.FETCH_MEMBERS !== "") fromEnv.push("--members", env.FETCH_MEMBERS);
  const mode = env.FETCH_MODE?.trim().toLowerCase() ?? "";
  if (mode === "initial") fromEnv.push("--initial");
  else if (mode && mode !== "recent") throw new Error(`FETCH_MODE は initial（今年度の初めから今月まで）か recent（直近。既定）にしてください: ${JSON.stringify(env.FETCH_MODE)}`);
  if (env.FETCH_ACCEPT_TASK_CHANGES === "1" || env.FETCH_ACCEPT_TASK_CHANGES === "true") fromEnv.push("--accept-task-changes");
  argv = [...fromEnv, ...argv];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const v = argv[i + 1];
    if (a === "--months" && v !== undefined) {
      opts.months = Number(v);
      i++;
    } else if (a === "--asOf" && v !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--asOf は YYYY-MM-DD 形式で指定してください: ${v}`);
      opts.asOf = v;
      i++;
    } else if ((a === "--from" || a === "--to") && v !== undefined) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) throw new Error(`${a} は YYYY-MM 形式で指定してください: ${v}`);
      opts[a === "--from" ? "from" : "to"] = v;
      i++;
    } else if (a === "--members" && v !== undefined) {
      opts.members = parseMemberList(v);
      if (opts.members.length === 0) throw new Error(`--members に社員番号がありません: ${JSON.stringify(v)}`);
      i++;
    } else if (a === "--adapter" && v !== undefined) {
      opts.adapter = v;
      i++;
    } else if (a === "--initial") {
      opts.initial = true;
    } else if (a === "--accept-task-changes") {
      opts.acceptTaskChanges = true;
    } else if (a === "--dry-run") {
      opts.dryRun = true;
    } else if (a.startsWith("--sample=")) {
      const n = Number(a.slice("--sample=".length));
      if (!Number.isInteger(n) || n < 0) throw new Error(`--sample は 0 以上の整数で指定してください: ${a}`);
      opts.sample = n;
    } else if (a === "--root" && v !== undefined) {
      opts.rootDir = v;
      i++;
    }
  }
  return opts;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  Promise.resolve()
    .then(() => fetchWorklogs(parseArgs(process.argv.slice(2), process.env)))
    .then((r) => {
      if (r.dryRun) {
        console.log(formatDryRun(r).join("\n"));
        return;
      }
      console.log(`作業実績を更新しました: ${r.months.join(", ")}${r.targetCount !== undefined ? `（対象 ${r.targetCount} 人${r.partial ? "。指定した人の行だけ差し替え" : ""}）` : ""} (adapter=${r.adapter}, fetchedAt=${r.fetchedAt})`);
    })
    .catch((e: unknown) => {
      console.error(`取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
