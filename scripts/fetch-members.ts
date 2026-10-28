/**
 * メンバー（所属・役職）の取り込み: 人事系の元データから data/masters/members.csv を更新する
 *
 *   npm run fetch:members
 *   npm run fetch:members -- --dry-run --sample=5     # ファイルを書かず、対応表と変更内容を表示
 *   npx tsx scripts/fetch-members.ts --asOf 2026-10-27 --root .
 *
 * - config.memberSource.adapter が none（既定）のときは何もしない（手入力運用）。
 * - 変化した人だけ effective_from = 実行月の行を追加する。team_id は直前の有効レコードを引き継ぐ。
 *   変化が無ければファイルを書かない（冪等）。取り込み元に無い既存メンバーは削除しない。
 *
 * 環境変数: MEMBER_API_TOKEN（http アダプタ）、MEMBER_ADAPTER（アダプタ名の上書き）
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { csvParse } from "d3-dsv";
import { selectMemberAdapter, type MemberAdapter, type MemberImport } from "./adapters/members.js";
import type { FetchReport } from "./adapters/http-source.js";
import { stripBom } from "./lib/csv.js";
import { readTextAuto } from "./lib/encoding.js";
import { DATA_FILES, loadConfig } from "./lib/load.js";
import { MEMBER_CSV_COLUMNS, formatMembersCsv, mergeMembers, type MemberCsvRow, type MergeResult } from "./lib/members-merge.js";
import { formatMappingTable } from "./lib/dry-run.js";

export interface FetchMembersOptions {
  rootDir: string;
  /** 基準日（省略時は今日 JST）。実行月はここから決まる */
  asOf?: string;
  dryRun?: boolean;
  sample?: number;
  /** テスト用: アダプタを差し替える */
  adapter?: MemberAdapter;
}

export interface FetchMembersResult {
  skipped: boolean;
  month: string;
  adapter: string;
  imported: number;
  merge?: MergeResult;
  written: boolean;
  dryRun: boolean;
  report?: FetchReport;
  sample: MemberImport[];
}

function todayJst(): string {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function readMembersCsv(path: string): { rows: MemberCsvRow[]; headers: string[] } {
  if (!existsSync(path)) return { rows: [], headers: [...MEMBER_CSV_COLUMNS] };
  const text = stripBom(readTextAuto(path));
  if (text.trim() === "") return { rows: [], headers: [...MEMBER_CSV_COLUMNS] };
  const parsed = csvParse(text);
  const rows = (parsed as unknown as MemberCsvRow[]).filter((r) => Object.values(r).some((v) => (v ?? "").trim() !== ""));
  return { rows: rows.map((r) => ({ ...r })), headers: parsed.columns };
}

export async function fetchMembers(opts: FetchMembersOptions, env: NodeJS.ProcessEnv = process.env): Promise<FetchMembersResult> {
  const config = loadConfig(opts.rootDir);
  const month = (opts.asOf ?? todayJst()).slice(0, 7);
  const adapter = opts.adapter ?? selectMemberAdapter(config, env);
  const dryRun = opts.dryRun ?? false;
  if (!adapter) {
    return { skipped: true, month, adapter: "none", imported: 0, written: false, dryRun, sample: [] };
  }
  const log = (m: string) => console.error(m);
  log(`[members] アダプタ=${adapter.name} 実行月=${month}`);
  let report: FetchReport | undefined;
  const imported = await adapter.fetch({ config, env, rootDir: opts.rootDir, month, log, report: (r) => (report = r) });

  const path = join(opts.rootDir, DATA_FILES.members);
  const { rows, headers } = readMembersCsv(path);
  const merge = mergeMembers(rows, imported, month);
  const dirty = merge.added + merge.changed > 0;
  let written = false;
  if (dirty && !dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, formatMembersCsv(merge.rows, headers));
    written = true;
  }
  const result: FetchMembersResult = {
    skipped: false,
    month,
    adapter: adapter.name,
    imported: imported.length,
    merge,
    written,
    dryRun,
    sample: imported.slice(0, Math.max(0, opts.sample ?? 0)),
  };
  if (report) result.report = report;
  return result;
}

export function summaryLines(r: FetchMembersResult): string[] {
  if (r.skipped) return ["memberSource.adapter が none のため何もしません（メンバーは data/masters/members.csv に手入力）"];
  const m = r.merge;
  const out: string[] = [];
  if (r.dryRun) {
    out.push("[dry-run] ファイルは書き込みません");
    if (r.report) out.push("", ...formatMappingTable(r.report));
    if (r.sample.length > 0) {
      out.push("", `取り込み結果の先頭 ${r.sample.length} 人:`);
      for (const s of r.sample) out.push(`  ${JSON.stringify(s)}`);
    }
    out.push("");
  }
  if (!m) return out;
  out.push(`取り込み ${r.imported} 人 / 新規 ${m.added} 人 / 変更 ${m.changed} 人 / 変化なし ${m.unchanged} 人 / 取り込み元に無く据え置き ${m.keptNotInSource} 人（実行月 ${r.month}）`);
  for (const c of m.changes.slice(0, 20)) out.push(`  ${c.kind === "added" ? "新規" : "変更"} ${c.memberId}${c.fields.length > 0 ? `: ${c.fields.join(", ")}` : ""}`);
  if (m.changes.length > 20) out.push(`  …ほか ${m.changes.length - 20} 人`);
  out.push(r.written ? "data/masters/members.csv を更新しました" : r.dryRun && m.added + m.changed > 0 ? "（dry-run のため更新していません）" : "変更が無いため members.csv は更新していません");
  return out;
}

export function parseArgs(argv: string[]): FetchMembersOptions {
  const opts: FetchMembersOptions = { rootDir: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const v = argv[i + 1];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a.startsWith("--sample=")) opts.sample = Number(a.slice("--sample=".length));
    else if (a === "--asOf" && v !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--asOf は YYYY-MM-DD 形式で指定してください: ${v}`);
      opts.asOf = v;
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
  fetchMembers(parseArgs(process.argv.slice(2)))
    .then((r) => console.log(summaryLines(r).join("\n")))
    .catch((e: unknown) => {
      console.error(`メンバーの取り込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
