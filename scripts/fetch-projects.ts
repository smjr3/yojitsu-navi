/**
 * 正式な案件の一覧の取り込み: 案件管理システムから data/projects.csv を作り、contracts.csv の顧客名・案件名をそろえる（SPEC §98）
 *
 *   npm run fetch:projects
 *   npm run fetch:projects -- --dry-run --sample=5          # ファイルを書かず、列の対応表と変更内容を表示
 *   npm run fetch:projects -- --id-from-note "ID:(\S+)"       # 移行: メモに書いていた案件IDを project_id に移す
 *   npm run fetch:projects -- --link-exact                   # 移行: 案件名が 1 件だけ同じ案件の ID を入れる
 *
 * - config.projectSource.adapter が none（既定）のときは何もしない。
 * - 顧客名・案件名は一覧が正。期間・金額・担当チームなどの手入力の列は触らない。契約の行は増やさない・消さない。
 * - project_id の無い契約は保留のまま（--id-from-note / --link-exact を付けたときだけ埋める）。
 * - 取り込みに失敗した・0 件だったときは projects.csv・contracts.csv を書き換えず、data/_projects-meta.json の lastFailure に記録する
 *   （データ確認画面に出る）。次に成功すると消える。
 *
 * 環境変数: PROJECT_API_TOKEN（http アダプタ）、PROJECT_ADAPTER（アダプタ名の上書き）
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { csvParse } from "d3-dsv";
import { selectProjectAdapter, type ProjectAdapter } from "./adapters/projects.js";
import type { FetchReport } from "./adapters/http-source.js";
import { checkProjects } from "../src/core/projects.js";
import type { Contract, Project } from "../src/core/types.js";
import { writeFilesAtomic } from "./lib/atomic.js";
import { stripBom } from "./lib/csv.js";
import { readTextAuto } from "./lib/encoding.js";
import { DATA_FILES, loadConfig } from "./lib/load.js";
import { formatMappingTable } from "./lib/dry-run.js";
import { PROJECTS_META, clearFailure, safeMessage, writeFailure } from "./lib/fetch-status.js";
import { diffProjects, formatContractsCsvKeeping, formatProjectsCsv, syncContracts, type ContractCsvRow, type SyncResult } from "./lib/projects-merge.js";

export interface FetchProjectsOptions {
  rootDir: string;
  asOf?: string;
  dryRun?: boolean;
  sample?: number;
  /** 移行: メモから案件IDを取り出す正規表現（取り出すのは 1 つ目のかっこ。無ければ一致した全体） */
  idFromNote?: string;
  /** 移行: 案件名が 1 件だけ同じ正式な案件の ID を入れる */
  linkExact?: boolean;
  adapter?: ProjectAdapter;
}

export interface FetchProjectsResult {
  skipped: boolean;
  adapter: string;
  imported: number;
  /** projects.csv の中身が変わったか */
  projectsChanged: boolean;
  /** 前回の projects.csv との違い（追加・削除・名前の変更の件数） */
  projectDiff?: { added: number; removed: number; renamed: number };
  sync?: SyncResult;
  written: string[];
  dryRun: boolean;
  report?: FetchReport;
  sample: Project[];
  /** 書いた後（dry-run は書いたとしたら）の照合の結果の件数 */
  check?: { linked: number; unlinked: number; unknown: number; unregistered: number };
}

function todayJst(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function readText(path: string): string {
  return existsSync(path) ? stripBom(readTextAuto(path)) : "";
}

function readContracts(path: string): { rows: ContractCsvRow[]; headers: string[]; text: string } {
  const text = readText(path);
  if (text.trim() === "") throw new Error(`${DATA_FILES.contracts} がありません（見出しの行も無い）`);
  const parsed = csvParse(text);
  // 見出しの前後の空白は、データの読み込み（parseCsvTable）と同じく除いて扱う（書き出す見出しも除いた名前にそろう）
  const headers = parsed.columns.map((h) => h.trim());
  const rows = (parsed as unknown as ContractCsvRow[])
    .filter((r) => Object.values(r).some((v) => (v ?? "").trim() !== ""))
    .map((r) => Object.fromEntries(parsed.columns.map((h, i) => [headers[i] as string, r[h] ?? ""])));
  return { rows, headers, text };
}

function compileNotePattern(src: string | undefined): RegExp | undefined {
  if (src === undefined || src === "") return undefined;
  try {
    return new RegExp(src, "u");
  } catch (e) {
    throw new Error(`--id-from-note の正規表現が読めません: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function fetchProjects(opts: FetchProjectsOptions, env: NodeJS.ProcessEnv = process.env, now: () => Date = () => new Date()): Promise<FetchProjectsResult> {
  const metaPath = join(opts.rootDir, PROJECTS_META);
  let result: FetchProjectsResult;
  try {
    result = await inner(opts, env);
  } catch (e) {
    const message = safeMessage(e instanceof Error ? e.message : String(e), [env.PROJECT_API_TOKEN]);
    if (!opts.dryRun) {
      try {
        writeFailure(metaPath, now().toISOString(), message);
      } catch {
        // 記録に失敗しても元のエラーを優先する
      }
    }
    throw new Error(message);
  }
  if (!result.dryRun && !result.skipped) clearFailure(metaPath);
  return result;
}

async function inner(opts: FetchProjectsOptions, env: NodeJS.ProcessEnv): Promise<FetchProjectsResult> {
  const config = loadConfig(opts.rootDir);
  const dryRun = opts.dryRun ?? false;
  const adapter = opts.adapter ?? selectProjectAdapter(config, env);
  if (!adapter) return { skipped: true, adapter: "none", imported: 0, projectsChanged: false, written: [], dryRun, sample: [] };
  const notePattern = compileNotePattern(opts.idFromNote);
  const log = (m: string) => console.error(m);
  log(`[projects] アダプタ=${adapter.name}`);
  let report: FetchReport | undefined;
  const month = (opts.asOf ?? todayJst()).slice(0, 7);
  const projects = await adapter.fetch({ config, env, rootDir: opts.rootDir, month, log, report: (r) => (report = r) });
  // 0 件は設定（filters・dataPath）の誤りか障害とみなし、今の一覧を消さない
  if (projects.length === 0) throw new Error("取り込める案件が 0 件でした（filters・dataPath を確認してください）。ファイルは書き換えていません");

  const projectsPath = join(opts.rootDir, DATA_FILES.projects);
  const contractsPath = join(opts.rootDir, DATA_FILES.contracts);
  const projectsText = formatProjectsCsv(projects);
  const previousProjects = readText(projectsPath);
  // 改行コードの違い（Windows の autocrlf）だけなら書き換えない。案件ID順で並びが決まるので、変わった案件の行だけが差分になる
  const projectsChanged = previousProjects.replace(/\r\n/g, "\n") !== projectsText;
  const projectDiff = diffProjects(previousProjects, projects);
  const { rows, headers, text: contractsText } = readContracts(contractsPath);
  const sync = syncContracts(rows, headers, projects, { ...(notePattern ? { idFromNote: notePattern } : {}), ...(opts.linkExact ? { linkExact: true } : {}) });
  const contractsChanged = sync.changes.length > 0 || sync.headers.length !== headers.length;

  const entries: Array<{ path: string; data: string }> = [];
  if (projectsChanged) entries.push({ path: projectsPath, data: projectsText });
  // 変わった行だけを書き換える（ほかの行は手で書いたときのまま。§101.4）
  if (contractsChanged) entries.push({ path: contractsPath, data: formatContractsCsvKeeping(contractsText, rows, sync.rows, headers, sync.headers) });
  if (!dryRun && entries.length > 0) writeFilesAtomic(entries); // 2 つとも書けたときだけ差し替える

  const after: Contract[] = sync.rows.map((r) => ({
    contractId: r.contract_id ?? "",
    customerName: r.customer_name ?? "",
    projectName: r.project_name ?? "",
    teamId: null,
    startMonth: r.start_month ?? "",
    endMonth: r.end_month ?? "",
    totalAmount: 0,
    ...((r.project_id ?? "").trim() !== "" ? { projectId: (r.project_id ?? "").trim() } : {}),
  }));
  const c = checkProjects(after, projects);
  const result: FetchProjectsResult = {
    skipped: false,
    adapter: adapter.name,
    imported: projects.length,
    projectsChanged,
    projectDiff,
    sync,
    written: dryRun ? [] : entries.map((e) => (e.path === projectsPath ? DATA_FILES.projects : DATA_FILES.contracts)),
    dryRun,
    sample: projects.slice(0, Math.max(0, opts.sample ?? 0)),
    check: { linked: c.linked, unlinked: c.unlinked.length, unknown: c.unknown.length, unregistered: c.unregistered.length },
  };
  if (report) result.report = report;
  return result;
}

const KIND_LABEL: Record<string, string> = { renamed: "名前", linkedFromNote: "メモから案件ID", linkedByName: "案件名で案件ID" };

export function summaryLines(r: FetchProjectsResult): string[] {
  if (r.skipped) return ["projectSource.adapter が none のため何もしません（契約の顧客名・案件名は contracts.csv の手入力のまま）"];
  const out: string[] = [];
  if (r.dryRun) {
    out.push("[dry-run] ファイルは書き込みません");
    if (r.report) out.push("", ...formatMappingTable(r.report));
    if (r.sample.length > 0) {
      out.push("", `取り込み結果の先頭 ${r.sample.length} 件:`);
      for (const s of r.sample) out.push(`  ${JSON.stringify(s)}`);
    }
    out.push("");
  }
  const d = r.projectDiff;
  out.push(`取り込み ${r.imported} 件（projects.csv ${r.projectsChanged ? `変更あり${d ? `: 追加 ${d.added} 件・削除 ${d.removed} 件・名前の変更 ${d.renamed} 件` : ""}` : "変化なし"}）`);
  const changes = r.sync?.changes ?? [];
  out.push(`contracts.csv の変更 ${changes.length} 件`);
  for (const c of changes.slice(0, 30)) out.push(`  ${c.contractId}: ${KIND_LABEL[c.kind] ?? c.kind} ${c.detail.join(", ")}`);
  if (changes.length > 30) out.push(`  …ほか ${changes.length - 30} 件`);
  for (const a of r.sync?.ambiguous ?? []) out.push(`  ${a.contractId}: 同じ案件名の案件が複数あるため入れていません（${a.candidates.join(", ")}）`);
  if (r.check) out.push(`照合: 案件IDあり ${r.check.linked} 件 / 未照合（保留）${r.check.unlinked} 件 / 一覧に無い案件ID ${r.check.unknown} 件 / 契約の無い案件 ${r.check.unregistered} 件`);
  out.push(r.written.length > 0 ? `${r.written.join("・")} を更新しました` : r.dryRun ? "（dry-run のため更新していません）" : "変更が無いためファイルは更新していません");
  return out;
}

export function parseArgs(argv: string[]): FetchProjectsOptions {
  const opts: FetchProjectsOptions = { rootDir: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const v = argv[i + 1];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--link-exact") opts.linkExact = true;
    else if (a.startsWith("--sample=")) opts.sample = Number(a.slice("--sample=".length));
    else if (a.startsWith("--id-from-note=")) opts.idFromNote = a.slice("--id-from-note=".length);
    else if (a === "--id-from-note" && v !== undefined) {
      opts.idFromNote = v;
      i++;
    } else if (a === "--asOf" && v !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--asOf は YYYY-MM-DD 形式で指定してください: ${v}`);
      opts.asOf = v;
      i++;
    } else if (a === "--root" && v !== undefined) {
      opts.rootDir = v;
      i++;
    } else {
      throw new Error(`知らないオプションです: ${a}`);
    }
  }
  return opts;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  Promise.resolve()
    .then(() => fetchProjects(parseArgs(process.argv.slice(2))))
    .then((r) => console.log(summaryLines(r).join("\n")))
    .catch((e: unknown) => {
      console.error(`正式な案件の一覧の取り込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
