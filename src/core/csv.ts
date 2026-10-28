/**
 * CSV の読み込み（SPEC §15, docs/DATA.md）
 *
 * RFC 4180 準拠のパーサ（引用符内のカンマ・改行・二重引用符、CRLF、BOM 除去、空行スキップ）と、
 * 各 CSV を Dataset に変換する parseDataset。文字コード変換（Shift_JIS）は scripts 側の責務。
 */
import { normalizeName } from "./normalize.js";
import type { Assignment, Config, Contract, Dataset, Holiday, MappingRule, MemberKind, MemberRecord, RateRecord, TeamRecord, Worklog } from "./types.js";
import { validateDataset, type ValidationIssue } from "./validate.js";
import { T, fmt } from "../i18n/index.js";

// ---------------------------------------------------------------------------
// 低レベル: テキスト → 行列
// ---------------------------------------------------------------------------

/** CSV テキストを行（セル配列）に分解する。BOM を除き、空行（空白だけの行）は捨てる */
export function parseCsvText(text: string): string[][] {
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  const n = src.length;
  const endRow = (): void => {
    row.push(cell);
    cell = "";
    if (row.some((c) => c.trim() !== "")) rows.push(row);
    row = [];
  };
  while (i < n) {
    const ch = src[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      if (src[i] === "\n") i++;
      endRow();
      continue;
    }
    if (ch === "\n") {
      i++;
      endRow();
      continue;
    }
    cell += ch;
    i++;
  }
  // 最終行（末尾改行なし）
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

export interface CsvTable {
  header: string[];
  /** ヘッダ名 → 値（trim 済み）。row はファイル内の行番号（ヘッダ = 1） */
  rows: Array<{ row: number; get(column: string): string }>;
}

/** 1 行目をヘッダとして各行を名前で引けるようにする。セルは trim 済み。余分な列は無視 */
export function parseCsvTable(text: string): CsvTable {
  const raw = parseCsvText(text);
  const header = (raw[0] ?? []).map((h) => h.trim());
  const colIndex = new Map<string, number>();
  header.forEach((h, i) => {
    if (!colIndex.has(h)) colIndex.set(h, i);
  });
  // 空行は parseCsvText で捨てられているので行番号は復元できない。ここでは「データ行の通し番号 + 1」を行番号とする
  const rows = raw.slice(1).map((cells, i) => ({
    row: i + 2,
    get(column: string): string {
      const idx = colIndex.get(column);
      if (idx === undefined) return "";
      return (cells[idx] ?? "").trim();
    },
  }));
  return { header, rows };
}

// ---------------------------------------------------------------------------
// セルの変換
// ---------------------------------------------------------------------------

/**
 * 数値セルの変換。"1,000" のカンマ・全角数字は受け付ける。
 * 空・"abc"・"1,0,0" のような不正値は NaN（検証でエラーにする）。
 */
export function parseNumberCell(cell: string): number {
  const s = cell.normalize("NFKC").replace(/,/g, "").trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return Number.NaN;
  return Number(s);
}

/** 空文字 → null */
function nullable(cell: string): string | null {
  return cell === "" ? null : cell;
}

// ---------------------------------------------------------------------------
// Dataset の組み立て
// ---------------------------------------------------------------------------

export interface DatasetFiles {
  config: Config;
  contracts: string;
  mapping: string;
  assignments: string;
  teams: string;
  members: string;
  rates: string;
  holidays: string;
  /** 月ごとのファイル内容（順不同） */
  worklogs: string[];
  worklogFetchedAt?: string;
}

export interface ParsedDataset {
  dataset: Dataset;
  /** 構造上の問題（必須列の欠落）＋ validateDataset の結果 */
  issues: ValidationIssue[];
}

const REQUIRED_COLUMNS: Record<Exclude<keyof DatasetFiles, "config" | "worklogs" | "worklogFetchedAt"> | "worklogs", readonly string[]> = {
  contracts: ["contract_id", "customer_name", "project_name", "team_id", "start_month", "end_month", "total_amount"],
  mapping: ["worklog_customer_name", "worklog_project_name", "contract_id"],
  assignments: ["member_id", "contract_id", "start_month", "end_month", "allocation"],
  teams: ["team_id", "name", "parent_team_id", "effective_from"],
  members: ["member_id", "name", "kind", "title", "department", "section", "team_id", "effective_from"],
  rates: ["key", "hourly_rate", "effective_from"],
  holidays: ["date", "name"],
  worklogs: ["date", "member_id", "member_name", "customer_name", "project_name", "task", "hours"],
};

function checkColumns(file: string, table: CsvTable, required: readonly string[], issues: ValidationIssue[]): void {
  const present = new Set(table.header);
  for (const col of required) {
    if (!present.has(col)) {
      issues.push({ severity: "error", code: "MISSING_COLUMN", message: fmt(T.checks.missingColumn, { file, column: col }), file, row: 1, ref: { column: col } });
    }
  }
}

function parseTable(file: string, text: string, required: readonly string[], issues: ValidationIssue[]): CsvTable {
  const table = parseCsvTable(text);
  // 空ファイルはヘッダ無しとみなし、列の欠落を報告する
  checkColumns(file, table, required, issues);
  return table;
}

/** 各 CSV テキストから Dataset を組み立てる。検証結果（§14）も issues に含める */
export function parseDataset(files: DatasetFiles): ParsedDataset {
  const issues: ValidationIssue[] = [];

  const contracts: Contract[] = parseTable("contracts.csv", files.contracts, REQUIRED_COLUMNS.contracts, issues).rows.map((r) => {
    const note = r.get("note");
    const c: Contract = {
      contractId: r.get("contract_id"),
      customerName: r.get("customer_name"),
      projectName: r.get("project_name"),
      teamId: nullable(r.get("team_id")),
      startMonth: r.get("start_month"),
      endMonth: r.get("end_month"),
      totalAmount: parseNumberCell(r.get("total_amount")),
    };
    if (note !== "") c.note = note;
    return c;
  });

  const mappings: MappingRule[] = parseTable("mapping.csv", files.mapping, REQUIRED_COLUMNS.mapping, issues).rows.map((r) => ({
    worklogCustomerName: r.get("worklog_customer_name"),
    worklogProjectName: r.get("worklog_project_name"),
    contractId: r.get("contract_id"),
  }));

  const assignments: Assignment[] = parseTable("assignments.csv", files.assignments, REQUIRED_COLUMNS.assignments, issues).rows.map((r) => ({
    memberId: r.get("member_id"),
    contractId: r.get("contract_id"),
    startMonth: r.get("start_month"),
    endMonth: r.get("end_month"),
    allocation: parseNumberCell(r.get("allocation")),
  }));

  const teams: TeamRecord[] = parseTable("masters/teams.csv", files.teams, REQUIRED_COLUMNS.teams, issues).rows.map((r) => ({
    teamId: r.get("team_id"),
    name: r.get("name"),
    parentTeamId: nullable(r.get("parent_team_id")),
    effectiveFrom: r.get("effective_from"),
    // 省略可の列（§21・§22）。列が無ければ空
    level: r.get("level"),
    leaderMemberId: nullable(r.get("leader_member_id")),
  }));

  const members: MemberRecord[] = parseTable("masters/members.csv", files.members, REQUIRED_COLUMNS.members, issues).rows.map((r) => ({
    memberId: r.get("member_id"),
    name: r.get("name"),
    // 区分の妥当性は validateDataset で検証する（ここでは文字列のまま通す）
    kind: r.get("kind").toLowerCase() as MemberKind,
    title: r.get("title"),
    department: r.get("department"),
    section: r.get("section"),
    teamId: nullable(r.get("team_id")),
    effectiveFrom: r.get("effective_from"),
  }));

  const rates: RateRecord[] = parseTable("masters/rates.csv", files.rates, REQUIRED_COLUMNS.rates, issues).rows.map((r) => ({
    key: r.get("key"),
    hourlyRate: parseNumberCell(r.get("hourly_rate")),
    effectiveFrom: r.get("effective_from"),
  }));

  const holidays: Holiday[] = parseTable("holidays.csv", files.holidays, REQUIRED_COLUMNS.holidays, issues).rows.map((r) => ({
    date: r.get("date"),
    name: r.get("name"),
  }));

  const worklogs: Worklog[] = [];
  files.worklogs.forEach((text, i) => {
    const table = parseTable(`worklogs[${i}]`, text, REQUIRED_COLUMNS.worklogs, issues);
    for (const r of table.rows) {
      worklogs.push({
        date: r.get("date"),
        memberId: r.get("member_id"),
        memberName: r.get("member_name"),
        customerName: r.get("customer_name"),
        projectName: r.get("project_name"),
        task: r.get("task"),
        hours: parseNumberCell(r.get("hours")),
      });
    }
  });

  const dataset: Dataset = { config: files.config, contracts, mappings, assignments, teams, members, rates, holidays, worklogs };
  if (files.worklogFetchedAt !== undefined) dataset.worklogFetchedAt = files.worklogFetchedAt;

  issues.push(...validateDataset(dataset));
  return { dataset, issues };
}

/** 参考: マッピング側の顧客名正規化（データ確認画面用） */
export { normalizeName };
