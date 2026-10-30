/**
 * CSV の読み込み（SPEC §15, docs/DATA.md）
 *
 * RFC 4180 準拠のパーサ（引用符内のカンマ・改行・二重引用符、CRLF、BOM 除去、空行スキップ）と、
 * 各 CSV を Dataset に変換する parseDataset。文字コード変換（Shift_JIS）は scripts 側の責務。
 */
import { isValidISODate } from "./calendar.js";
import { normalizeName, splitKeywords } from "./normalize.js";
import type { Assignment, OutsidePlan, Target, Config, Contract, Dataset, Holiday, MappingRule, MemberKind, MemberRecord, RateRecord, TaskTypeRule, TeamRecord, Worklog } from "./types.js";
import { parseTaskCategory } from "./workTypes.js";
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
  // 金額の「¥1,200,000」「1200000円」も受け付ける（Excel の通貨書式のまま貼られることがある）
  const t = cell.normalize("NFKC").trim().replace(/^([+-]?)[¥\\]\s*/, "$1").replace(/\s*円$/, "");
  // カンマは 3 桁区切りとしてだけ受け付ける（"1,5" を 15 と読まない。小数のつもりの入力を 10 倍にしないため）
  if (t.includes(",") && !/^[+-]?\d{1,3}(,\d{3})+(\.\d*)?$/.test(t)) return Number.NaN;
  const s = t.replace(/,/g, "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return Number.NaN;
  return Number(s);
}

/** 割合のセル（§63）: "20" / "20%" / "２０％" → 0.2、"-50" / "▲50" → -0.5。空・数値でない → NaN */
export function parsePercentCell(cell: string): number {
  // 負の数は「-50」のほか、数学のマイナス「−50」・会計の「▲50」「△50」も受け付ける（超過を減らす目標）
  const t = cell.normalize("NFKC").trim().replace(/\s*%$/, "").replace(/^[\u2212▲△]\s*/, "-");
  if (t === "" || t.includes(",")) return Number.NaN;
  const n = parseNumberCell(t);
  return Number.isFinite(n) ? n / 100 : Number.NaN;
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
  /** 作業種別の分類表（§30.1）。省略・空 = 分類なし（すべて契約内） */
  taskTypes?: string;
  /** 契約外予定（§36）。省略・空 = なし */
  outsidePlans?: string;
  /** 目標（§63）。省略・空 = なし */
  targets?: string;
  /** 月ごとのファイル内容（順不同） */
  worklogs: string[];
  /** worklogs と同じ順のファイル名（警告にファイル名・行番号を出すため。無ければ worklogs[i]） */
  worklogNames?: string[];
  /** 作業実績フォルダにあったが、ファイル名が YYYY-MM.csv でないため読まなかったファイル */
  skippedWorklogFiles?: string[];
  worklogFetchedAt?: string;
}

export interface ParsedDataset {
  dataset: Dataset;
  /** 構造上の問題（必須列の欠落）＋ validateDataset の結果 */
  issues: ValidationIssue[];
}

const REQUIRED_COLUMNS: Record<Exclude<keyof DatasetFiles, "config" | "worklogs" | "worklogFetchedAt" | "worklogNames" | "skippedWorklogFiles"> | "worklogs", readonly string[]> = {
  taskTypes: ["task", "category"],
  outsidePlans: ["member_id", "start_month", "end_month", "person_months"],
  targets: ["target_type", "target_id", "end_month", "remaining_rate"],
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

/** 引用符が閉じないまま終わる CSV なら、その引用符が始まった物理行（1 始まり）。閉じていれば null */
export function unclosedQuoteLine(text: string): number | null {
  let line = 1;
  let openedAt: number | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") line++;
    else if (ch === '"') {
      if (openedAt === null) openedAt = line;
      else if (text[i + 1] === '"') i++;
      else openedAt = null;
    }
  }
  return openedAt;
}

function parseTable(file: string, text: string, required: readonly string[], issues: ValidationIssue[]): CsvTable {
  const table = parseCsvTable(text);
  // 引用符の閉じ忘れは以降の行がすべて 1 セルに飲み込まれ、別の行のエラーとして現れるので、原因の行を示す
  const unclosed = unclosedQuoteLine(text);
  if (unclosed !== null) {
    issues.push({ severity: "error", code: "UNCLOSED_QUOTE", message: fmt(T.checks.unclosedQuote, { file, row: unclosed }), file, row: unclosed });
  }
  // 空ファイルはヘッダ無しとみなし、列の欠落を報告する
  checkColumns(file, table, required, issues);
  return table;
}

/** members.csv の status 列（§35）: 空・「在籍」・active = 在籍、「退職」・left・retired = 退職。それ以外はそのまま（検証でエラー） */
export function memberStatus(raw: string): { status?: string } {
  const v = raw.normalize("NFKC").trim();
  if (v === "" || v === "在籍" || v.toLowerCase() === "active") return {};
  if (v === "退職" || v.toLowerCase() === "left" || v.toLowerCase() === "retired") return { status: "left" };
  return { status: v };
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

  const mappings: MappingRule[] = parseTable("mapping.csv", files.mapping, REQUIRED_COLUMNS.mapping, issues).rows.map((r) => {
    // 作業名のキーワード（§62.1）は省略可の列。無ければ条件なし
    const include = splitKeywords(r.get("task_include"));
    const exclude = splitKeywords(r.get("task_exclude"));
    return {
      worklogCustomerName: r.get("worklog_customer_name"),
      worklogProjectName: r.get("worklog_project_name"),
      contractId: r.get("contract_id"),
      ...(include.length > 0 ? { taskInclude: include } : {}),
      ...(exclude.length > 0 ? { taskExclude: exclude } : {}),
    };
  });

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
    // 事業本部（省略可の列。§60）。空なら項目を持たない
    ...(r.get("division") ? { division: r.get("division") } : {}),
    department: r.get("department"),
    section: r.get("section"),
    teamId: nullable(r.get("team_id")),
    effectiveFrom: r.get("effective_from"),
    // 省略可の列（§35）。空・「在籍」は在籍（項目を持たない）
    ...memberStatus(r.get("status")),
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
  // 不正行の場所（先頭数件）。validateDataset の件数だけの警告に添える
  const badDates: string[] = [];
  const badHours: string[] = [];
  files.worklogs.forEach((text, i) => {
    const file = files.worklogNames?.[i] ?? `worklogs[${i}]`;
    const table = parseTable(file, text, REQUIRED_COLUMNS.worklogs, issues);
    table.rows.forEach((r, j) => {
      const w: Worklog = {
        date: normalizeWorklogDate(r.get("date")),
        memberId: r.get("member_id"),
        memberName: r.get("member_name"),
        customerName: r.get("customer_name"),
        projectName: r.get("project_name"),
        task: r.get("task"),
        hours: parseNumberCell(r.get("hours")),
      };
      const where = fmt(T.checks.worklogRowAt, { file, row: j + 2 });
      if (!isValidISODate(w.date) && badDates.length < WORKLOG_EXAMPLES) badDates.push(fmt(T.checks.worklogRowValue, { where, value: r.get("date") }));
      if ((!Number.isFinite(w.hours) || w.hours <= 0) && badHours.length < WORKLOG_EXAMPLES) badHours.push(fmt(T.checks.worklogRowValue, { where, value: r.get("hours") }));
      worklogs.push(w);
    });
  });
  for (const f of files.skippedWorklogFiles ?? []) {
    issues.push({ severity: "warning", code: "WORKLOG_FILE_SKIPPED", message: fmt(T.checks.worklogFileSkipped, { file: f }), file: f });
  }

  const taskTypes = parseTaskTypes(files.taskTypes, issues);
  // 契約外予定（§36）: 省略可。空なら読まない（列の欠落も問わない）
  const outsidePlans: OutsidePlan[] =
    (files.outsidePlans ?? "").trim() === ""
      ? []
      : parseTable("outside-plans.csv", files.outsidePlans as string, REQUIRED_COLUMNS.outsidePlans, issues).rows.map((r) => ({
          memberId: r.get("member_id"),
          type: r.get("type"),
          startMonth: r.get("start_month"),
          endMonth: r.get("end_month"),
          personMonths: parseNumberCell(r.get("person_months")),
          note: r.get("note"),
        }));

  // 目標（§63）: 省略可。残予算率は % の数値（20 = 20%。末尾の % は付けても付けなくてもよい）
  const targets: Target[] =
    (files.targets ?? "").trim() === ""
      ? []
      : parseTable("targets.csv", files.targets as string, REQUIRED_COLUMNS.targets, issues).rows.map((r) => ({
          kind: r.get("target_type"),
          targetId: r.get("target_id"),
          startMonth: r.get("start_month"),
          endMonth: r.get("end_month"),
          remainingRate: parsePercentCell(r.get("remaining_rate")),
          note: r.get("note"),
        }));

  const dataset: Dataset = { config: files.config, contracts, mappings, assignments, teams, members, rates, holidays, worklogs };
  if (taskTypes.length > 0) dataset.taskTypes = taskTypes;
  if (outsidePlans.length > 0) dataset.outsidePlans = outsidePlans;
  if (targets.length > 0) dataset.targets = targets;
  if (files.worklogFetchedAt !== undefined) dataset.worklogFetchedAt = files.worklogFetchedAt;

  // 列の欠落・引用符の閉じ忘れがあるファイルは、行ごとのエラーが同じ原因で大量に出るだけなので、元のエラーだけを残す
  const broken = new Set(issues.filter((i) => i.severity === "error" && (i.code === "MISSING_COLUMN" || i.code === "UNCLOSED_QUOTE")).map((i) => i.file));
  const worklogNames = new Set(files.worklogs.map((_, i) => files.worklogNames?.[i] ?? `worklogs[${i}]`));
  if ([...broken].some((f) => f !== undefined && worklogNames.has(f))) broken.add("worklogs");
  for (const issue of validateDataset(dataset)) {
    if (issue.file !== undefined && broken.has(issue.file)) continue;
    const examples = issue.code === "WORKLOG_INVALID_DATE" ? badDates : issue.code === "WORKLOG_INVALID_HOURS" ? badHours : [];
    issues.push(examples.length > 0 ? { ...issue, message: `${issue.message}${fmt(T.checks.worklogExamples, { examples: examples.join("、") })}` } : issue);
  }
  return { dataset, issues };
}

const WORKLOG_EXAMPLES = 5;

/**
 * task-types.csv（§30.1）。ファイルが無い・空なら分類なし。
 * 区分が不正・作業種別が空の行は使わない（error）。同じ作業種別（正規化後）の 2 行目以降も使わない（error）。
 */
function parseTaskTypes(text: string | undefined, issues: ValidationIssue[]): TaskTypeRule[] {
  if (text === undefined || text.trim() === "" || text.trim() === "\ufeff") return [];
  const file = "task-types.csv";
  const table = parseTable(file, text, REQUIRED_COLUMNS.taskTypes, issues);
  const out: TaskTypeRule[] = [];
  const seen = new Map<string, number>();
  table.rows.forEach((r, i) => {
    const row = i + 2;
    const task = r.get("task");
    const key = normalizeName(task);
    if (key === "") {
      issues.push({ severity: "error", code: "TASK_TYPE_EMPTY", message: fmt(T.checks.taskTypeEmpty, { file, row }), file, row });
      return;
    }
    const category = parseTaskCategory(r.get("category"));
    if (category === null) {
      issues.push({ severity: "error", code: "TASK_CATEGORY_INVALID", message: fmt(T.checks.taskCategoryInvalid, { file, row, task, value: r.get("category") }), file, row, ref: { task } });
      return;
    }
    const first = seen.get(key);
    if (first !== undefined) {
      issues.push({ severity: "error", code: "DUPLICATE_TASK_TYPE", message: fmt(T.checks.duplicateTaskType, { file, row, task, first }), file, row, ref: { task } });
      return;
    }
    const match = parseTaskMatch(r.get("match"));
    if (match === null) {
      issues.push({ severity: "error", code: "TASK_MATCH_INVALID", message: fmt(T.checks.taskMatchInvalid, { file, row, task, value: r.get("match") }), file, row, ref: { task } });
      return;
    }
    seen.set(key, row);
    const note = r.get("note");
    // 計画の種別（§50.1）は契約外の行だけ使う
    const group = category === "outside" ? r.get("group") : "";
    out.push({ task, category, ...(group !== "" ? { group } : {}), ...(match === "contains" ? { match } : {}), ...(note !== "" ? { note } : {}) });
  });
  return out;
}

/** match 列（§62.2）: 空・完全一致・exact → 完全一致（"exact"）、含む・contains → "contains"、それ以外 → null */
export function parseTaskMatch(value: string | null | undefined): "exact" | "contains" | null {
  const v = (value ?? "").normalize("NFKC").trim().toLowerCase();
  if (v === "" || v === "完全一致" || v === "exact") return "exact";
  if (v === "含む" || v === "contains") return "contains";
  return null;
}

/** 作業実績の日付: YYYY/MM/DD・YYYY/M/D・YYYY-M-D も受け付けて YYYY-MM-DD に揃える（それ以外はそのまま返し、検証で不正になる） */
export function normalizeWorklogDate(value: string): string {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value.trim());
  if (!m) return value;
  return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
}

/** 参考: マッピング側の顧客名正規化（データ確認画面用） */
export { normalizeName };
