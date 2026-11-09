/**
 * マスタ編集（SPEC §19）の純粋ロジック — 画面（src/masters.md）から使う
 *
 * - CSV を「元の行テキスト ＋ セル」の行列として持ち、編集後に書き出す。
 *   変更していない行は元のテキストをそのまま（バイト単位で）書き戻し、差分を最小にする。
 *   書き出しは列順 = 元ファイルのヘッダ順、改行 LF、UTF-8（BOM なし）、末尾改行 1 つで固定。
 * - 差分（追加・変更・削除）、過去月への影響月数、編集後データの parseDataset + validateDataset。
 *
 * DOM にも fetch にも依存しない（GitLab API は gitlab.ts）。
 */
import { addMonths, isValidYearMonth } from "./calendar.js";
import { customerTeamIndex, memberStatus, parseCsvTable, parseDataset, parseNumberCell, type DatasetFiles } from "./csv.js";
import { normalizeName } from "./normalize.js";
import type { PlanAssignment, PlanSources } from "./plan.js";
import type { Config, Dataset, MemberRecord, TeamRecord, YearMonth } from "./types.js";
import type { ValidationIssue } from "./validate.js";
import { T, fmt } from "../i18n/index.js";

// ---------------------------------------------------------------------------
// 対象ファイルの定義
// ---------------------------------------------------------------------------

export type MasterFileId = "members" | "rates" | "teams" | "contracts" | "customerTeams" | "holidays" | "assignments" | "outside" | "targets";

export interface MasterColumnDef {
  /** CSV の列名 */
  name: string;
  /** 画面の見出し */
  label: string;
  /** 入力の種類（画面のフォーム部品を決める） */
  input: "text" | "customer" | "flag" | "month" | "number" | "kind" | "status" | "team" | "member" | "memberKey" | "project" | "rateKey" | "title" | "level" | "org" | "allocation" | "outsideType" | "targetType" | "target" | "percent" | "date";
  required: boolean;
  /** true: CSV に列があるときだけ扱う（無いファイルに見出しを足さない。§98 の project_id） */
  onlyIfPresent?: boolean;
  /** true（onlyIfPresent と一緒に使う）: 列が無くても入力欄は出し、値を入れたときだけ見出しの末尾に足す（§103 の provisional） */
  addOnInput?: boolean;
  /** true: 台帳の一覧の列には出さない（修正のダイアログには出す。§98 の project_id。表を横に広げないため） */
  listHidden?: boolean;
}

export interface MasterFileDef {
  id: MasterFileId;
  /** リポジトリ内のパス（data/ からの相対ではなくプロジェクトルートから） */
  path: string;
  /** parseDataset / validateDataset が報告するファイル名 */
  issueFile: string;
  label: string;
  /** 列（docs/DATA.md と同じ順） */
  columns: MasterColumnDef[];
  /**
   * 履歴の種類
   *  - effective: effective_from 付きの履歴（§5）。キー列ごとに「月 m の有効レコード」を引く
   *  - period:    start_month〜end_month の期間（アサイン）
   *  - list:      1 行が 1 件（案件 §80・目標 §63）。履歴を持たない。目標は過去の月の数値に影響しない（案件は期間の月の予算が変わる）
   */
  history: "effective" | "period" | "list";
  /** 影響範囲を判定するキー列 */
  keyColumns: string[];
  /** period の値の列（人月。影響月の判定に使う） */
  valueColumn?: string;
  /** 省略可のファイル（無ければ見出しだけの空のファイルとして扱う。§36） */
  optional?: boolean;
  /**
   * 画面で変えられるのはこの列だけ（他システムから取り込む列は変えさせない。案件 §80）。
   * 指定したファイルは行の追加・削除・CSV で編集もできない（行は取り込みで増減する）
   */
  editableColumns?: readonly string[];
  /**
   * true: editableColumns があっても、画面で新しい行を足せる（足した行は保存するまですべての列を入れられる）。
   * 案件（§103）: 未登録の案件の確認から登録する。取り込み済みの行の顧客名・案件名は変えない
   */
  addable?: boolean;
}

export const MASTER_FILES: Record<MasterFileId, MasterFileDef> = {
  members: {
    id: "members",
    path: "data/masters/members.csv",
    issueFile: "masters/members.csv",
    label: T.masterFiles.members,
    history: "effective",
    keyColumns: ["member_id"],
    columns: [
      { name: "member_id", label: T.masterFiles.colMemberId, input: "memberKey", required: true },
      { name: "name", label: T.masterFiles.colName, input: "text", required: true },
      { name: "kind", label: T.masterFiles.colKind, input: "kind", required: true },
      { name: "title", label: T.masterFiles.colTitle, input: "title", required: false },
      // 所属の 3 段（事業本部・部・課）。事業本部は省略可（旧ファイルには無い。無ければ見出しの末尾に足す。§60）
      { name: "division", label: T.masterFiles.colDivision, input: "org", required: false },
      { name: "department", label: T.masterFiles.colDepartment, input: "org", required: false },
      { name: "section", label: T.masterFiles.colSection, input: "org", required: false },
      { name: "team_id", label: T.masterFiles.colTeamId, input: "team", required: false },
      { name: "effective_from", label: T.masterFiles.colEffectiveFrom, input: "month", required: true },
      // 在籍状態（§35）。省略可。何か書いてある行（退職・休職など）の effective_from から不在
      { name: "status", label: T.masterFiles.colStatus, input: "status", required: false },
    ],
  },
  rates: {
    id: "rates",
    path: "data/masters/rates.csv",
    issueFile: "masters/rates.csv",
    label: T.masterFiles.rates,
    history: "effective",
    keyColumns: ["key"],
    columns: [
      { name: "key", label: T.masterFiles.colRateKey, input: "rateKey", required: true },
      { name: "hourly_rate", label: T.masterFiles.colHourlyRate, input: "number", required: true },
      { name: "effective_from", label: T.masterFiles.colEffectiveFrom, input: "month", required: true },
      // 仮の値（§103。動作確認用で本番の単価ではない）。省略可。列が無いファイルは、画面で仮にした行を保存するときに見出しの末尾に足す
      { name: "provisional", label: T.masterFiles.colProvisional, input: "flag", required: false, onlyIfPresent: true, addOnInput: true },
    ],
  },
  teams: {
    id: "teams",
    path: "data/masters/teams.csv",
    issueFile: "masters/teams.csv",
    label: T.masterFiles.teams,
    history: "effective",
    keyColumns: ["team_id"],
    columns: [
      { name: "team_id", label: T.masterFiles.colTeamIdKey, input: "text", required: true },
      { name: "name", label: T.masterFiles.colTeamName, input: "text", required: true },
      { name: "parent_team_id", label: T.masterFiles.colParentTeam, input: "team", required: false },
      { name: "effective_from", label: T.masterFiles.colEffectiveFrom, input: "month", required: true },
      { name: "level", label: T.masterFiles.colLevel, input: "level", required: false },
      { name: "leader_member_id", label: T.masterFiles.colLeader, input: "member", required: false },
    ],
  },
  // 案件（§80）。1 行 = 1 契約。顧客名・案件名などは他システムから取り込む予定なので、画面で変えられるのは期間・金額・担当チームだけ
  contracts: {
    id: "contracts",
    path: "data/contracts.csv",
    issueFile: "contracts.csv",
    label: T.masterFiles.contracts,
    history: "list",
    keyColumns: ["contract_id"],
    editableColumns: ["start_month", "end_month", "total_amount", "team_id"],
    addable: true,
    columns: [
      { name: "contract_id", label: T.masterFiles.colContractKey, input: "text", required: true },
      { name: "customer_name", label: T.masterFiles.colCustomer, input: "text", required: true },
      { name: "project_name", label: T.masterFiles.colProjectName, input: "text", required: true },
      // 正式な案件ID（§98）。列があるときだけ一覧に出す。登録済みの行では変えない。列が無くても新しい案件の登録（§103.3）で入れたら見出しに足す
      { name: "project_id", label: T.masterFiles.colProjectId, input: "text", required: false, onlyIfPresent: true, addOnInput: true, listHidden: true },
      { name: "start_month", label: T.masterFiles.colStartMonth, input: "month", required: true },
      { name: "end_month", label: T.masterFiles.colEndMonth, input: "month", required: true },
      { name: "total_amount", label: T.masterFiles.colTotalAmount, input: "number", required: true },
      { name: "team_id", label: T.masterFiles.colContractTeam, input: "team", required: false },
      { name: "note", label: T.masterFiles.colNote, input: "text", required: false },
    ],
  },
  // 顧客の既定の担当チーム（§103）。1 行 = 1 顧客。案件の team_id が空ならこのチーム（案件に書けばそちらが優先）
  customerTeams: {
    id: "customerTeams",
    path: "data/customer-teams.csv",
    issueFile: "customer-teams.csv",
    label: T.masterFiles.customerTeams,
    history: "list",
    keyColumns: ["customer_name"],
    optional: true,
    columns: [
      { name: "customer_name", label: T.masterFiles.colCustomer, input: "customer", required: true },
      { name: "team_id", label: T.masterFiles.colCustomerTeam, input: "team", required: true },
      { name: "note", label: T.masterFiles.colNote, input: "text", required: false },
    ],
  },
  // 祝日・会社の休日（§80）。1 行 = 1 日。営業日（工数の確定日・今月の進捗の目安）の数え方に使う
  holidays: {
    id: "holidays",
    path: "data/holidays.csv",
    issueFile: "holidays.csv",
    label: T.masterFiles.holidays,
    history: "list",
    keyColumns: ["date"],
    columns: [
      { name: "date", label: T.masterFiles.colHolidayDate, input: "date", required: true },
      { name: "name", label: T.masterFiles.colHolidayName, input: "text", required: true },
    ],
  },
  assignments: {
    id: "assignments",
    path: "data/assignments.csv",
    issueFile: "assignments.csv",
    label: T.masterFiles.assignments,
    history: "period",
    keyColumns: ["member_id", "contract_id"],
    valueColumn: "allocation",
    columns: [
      { name: "member_id", label: T.masterFiles.colMember, input: "member", required: true },
      { name: "contract_id", label: T.masterFiles.colProject, input: "project", required: true },
      { name: "start_month", label: T.masterFiles.colStartMonth, input: "month", required: true },
      { name: "end_month", label: T.masterFiles.colEndMonth, input: "month", required: true },
      { name: "allocation", label: T.masterFiles.colAllocation, input: "allocation", required: true },
    ],
  },
  outside: {
    id: "outside",
    path: "data/outside-plans.csv",
    issueFile: "outside-plans.csv",
    label: T.masterFiles.outside,
    history: "period",
    keyColumns: ["member_id", "type"],
    valueColumn: "person_months",
    optional: true,
    columns: [
      { name: "member_id", label: T.masterFiles.colMember, input: "member", required: true },
      // 契約外の種別（§50.1）。省略可（旧ファイルには無い。無ければ見出しの末尾に足す）
      { name: "type", label: T.masterFiles.colOutsideType, input: "outsideType", required: false },
      { name: "start_month", label: T.masterFiles.colStartMonth, input: "month", required: true },
      { name: "end_month", label: T.masterFiles.colEndMonth, input: "month", required: true },
      { name: "person_months", label: T.masterFiles.colPersonMonths, input: "allocation", required: true },
      { name: "note", label: T.masterFiles.colNote, input: "text", required: false },
    ],
  },
  targets: {
    id: "targets",
    path: "data/targets.csv",
    issueFile: "targets.csv",
    label: T.masterFiles.targets,
    history: "list",
    keyColumns: ["target_type", "target_id"],
    optional: true,
    columns: [
      // 対象の種類と対象は、画面では 1 つの欄（チーム・顧客・案件から選ぶ）で入れる
      { name: "target_type", label: T.masterFiles.colTargetType, input: "targetType", required: true },
      { name: "target_id", label: T.masterFiles.colTarget, input: "target", required: true },
      { name: "end_month", label: T.masterFiles.colEndMonth, input: "month", required: true },
      { name: "remaining_rate", label: T.masterFiles.colRemainingRate, input: "percent", required: true },
      { name: "start_month", label: T.masterFiles.colTargetStart, input: "month", required: false },
      { name: "note", label: T.masterFiles.colNote, input: "text", required: false },
    ],
  },
};

export const MASTER_FILE_IDS: readonly MasterFileId[] = ["members", "rates", "teams", "contracts", "customerTeams", "holidays", "assignments", "outside", "targets"];

/** 行の「いつ」の列（履歴 = 適用開始月、期間 = 開始月、一覧 = 終了月） */
export function timeColumnOf(def: Pick<MasterFileDef, "history">): string {
  return def.history === "effective" ? "effective_from" : def.history === "list" ? "end_month" : "start_month";
}

/** 省略可のファイルが無いときの中身（見出しだけ） */
export function emptyMasterText(fileId: MasterFileId): string {
  return `${MASTER_FILES[fileId].columns.map((c) => c.name).join(",")}\n`;
}

/** memberSource で取り込める列（§20.2。team_id は取り込まない。実際に取り込むのは config の columns に書いた列だけ） */
export const MEMBER_IMPORTED_COLUMNS: readonly string[] = ["name", "kind", "title", "division", "department", "section"];

/** メンバーで画面から変えさせない列（社員番号・氏名は人事から取り込む。§81）。新しいメンバーの追加では入力する */
export const MEMBER_FIXED_COLUMNS: readonly string[] = ["member_id", "name"];

// ---------------------------------------------------------------------------
// CSV: 行テキストを保ったまま読む
// ---------------------------------------------------------------------------

export interface RawRecord {
  /** 元の 1 レコードのテキスト（改行コードを含まない。引用符内の改行は含む） */
  raw: string;
  /** 引用符を外したセル（trim しない） */
  cells: string[];
}

/**
 * CSV テキストをレコード単位に分ける（core/csv.ts の parseCsvText と同じ規則: BOM 除去、CRLF/LF、
 * 引用符内のカンマ・改行・""、空白だけの行は捨てる）。各レコードの元テキストも返す
 */
export function splitCsvRecords(text: string): RawRecord[] {
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const out: RawRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let start = 0;
  let i = 0;
  const n = src.length;
  const end = (stop: number): void => {
    cells.push(cell);
    if (cells.some((c) => c.trim() !== "")) out.push({ raw: src.slice(start, stop), cells });
    cells = [];
    cell = "";
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
      cells.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      const stop = i;
      i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
      end(stop);
      start = i;
      continue;
    }
    cell += ch;
    i++;
  }
  // 末尾に改行の無い最終レコード
  if (start < n) end(n);
  return out;
}

/** 1 セルを CSV 用に書く。カンマ・二重引用符・改行を含むときだけ引用符で囲む */
export function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** セル配列 → 1 レコードのテキスト */
export function formatCsvRecord(cells: readonly string[]): string {
  return cells.map(escapeCsvCell).join(",");
}

export interface MasterRow {
  /** 行の識別子。元ファイルの行は "o<データ行の通し番号>"、追加した行は "n<連番>" */
  id: string;
  /** 現在の値（ヘッダの列数に揃える。元の行に余分な列があれば後ろに残す） */
  cells: string[];
}

export interface MasterDoc {
  fileId: MasterFileId;
  header: string[];
  /** ヘッダ行の元テキスト（ヘッダを変えない限りそのまま書き戻す） */
  headerRaw: string | null;
  rows: MasterRow[];
  /** 元ファイルの行（id → 元テキストとセル）。差分と「未変更行はそのまま」の判定に使う */
  originals: Record<string, { raw: string; cells: string[]; index: number }>;
  /** 次に追加する行の番号 */
  nextId: number;
}

function padCells(cells: readonly string[], width: number): string[] {
  const out = cells.slice();
  while (out.length < width) out.push("");
  return out;
}

/**
 * 元テキストから編集用の文書を作る。
 * 必須の列（MASTER_FILES の columns）がヘッダに無ければ末尾に足す（その場合ヘッダ行は書き換わる）
 */
export function parseMasterDoc(fileId: MasterFileId, text: string): MasterDoc {
  const def = MASTER_FILES[fileId];
  const records = splitCsvRecords(text);
  const first = records[0];
  const header = first ? first.cells.map((h) => h.trim()) : [];
  let headerRaw: string | null = first ? first.raw : null;
  for (const c of def.columns) {
    if (!header.includes(c.name) && !c.onlyIfPresent) {
      header.push(c.name);
      headerRaw = null;
    }
  }
  const originals: MasterDoc["originals"] = {};
  const rows: MasterRow[] = records.slice(1).map((r, i) => {
    const id = `o${i}`;
    const cells = padCells(r.cells, header.length);
    originals[id] = { raw: r.raw, cells, index: i };
    return { id, cells: cells.slice() };
  });
  return { fileId, header, headerRaw, rows, originals, nextId: 1 };
}

/** 列名 → 列番号（無ければ -1） */
export function columnIndex(doc: Pick<MasterDoc, "header">, column: string): number {
  return doc.header.indexOf(column);
}

/** 行の値を列名で引く（trim 済み。CSV 読み込みと同じ） */
export function cellOf(doc: Pick<MasterDoc, "header">, row: Pick<MasterRow, "cells">, column: string): string {
  const i = columnIndex(doc, column);
  return i < 0 ? "" : (row.cells[i] ?? "").trim();
}

/** 列名 → 値 のオブジェクト（画面表示・フォームの初期値用） */
export function rowRecord(doc: Pick<MasterDoc, "header">, row: Pick<MasterRow, "cells">): Record<string, string> {
  const out: Record<string, string> = {};
  doc.header.forEach((h, i) => (out[h] = row.cells[i] ?? ""));
  return out;
}

function sameCells(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 行がすべて空（書き出さない・CSV 読み込みでも捨てられる） */
function isBlankRow(cells: readonly string[]): boolean {
  return !cells.some((c) => c.trim() !== "");
}

/** 行の状態 */
export function rowState(doc: MasterDoc, row: MasterRow): "unchanged" | "changed" | "added" {
  const o = doc.originals[row.id];
  if (!o) return "added";
  return sameCells(o.cells, row.cells) ? "unchanged" : "changed";
}

export interface SerializedDoc {
  text: string;
  /** 書き出したデータ行（ヘッダの次から）の行 id。CSV 読み込み後の行番号 = 添字 + 2 */
  rowIds: string[];
}

/**
 * 文書を CSV テキストに書き出す。
 * - 変更していない行（セルが元と同じ）は元のテキストをそのまま使う（引用符の付け方・余分な空白も保つ）
 * - 変更・追加した行は escapeCsvCell で書く
 * - 改行は LF、BOM なし、末尾に改行 1 つ。すべて空の行は書かない
 */
export function serializeMasterDoc(doc: MasterDoc): SerializedDoc {
  const lines: string[] = [doc.headerRaw ?? formatCsvRecord(doc.header)];
  const rowIds: string[] = [];
  for (const row of doc.rows) {
    if (isBlankRow(row.cells)) continue;
    const o = doc.originals[row.id];
    lines.push(o && sameCells(o.cells, row.cells) ? o.raw : formatCsvRecord(row.cells));
    rowIds.push(row.id);
  }
  return { text: lines.join("\n") + "\n", rowIds };
}

/** 変更者・変更日の列（リソース計画の変更の履歴・目標の一覧に出す。§56）。保存するときに画面が書き込み、フォームでは編集しない */
export const STAMP_COLUMNS = { by: "updated_by", at: "updated_at" } as const;
/** 変更者・変更日を書き込むファイル */
export const STAMPED_FILES: readonly MasterFileId[] = ["contracts", "customerTeams", "assignments", "outside", "targets"];

/**
 * 追加・変更した行に変更者（GitLab のユーザー名。分からなければ空）と変更日（YYYY-MM-DD）を書き込む（§56）。
 * 列が無いファイルには見出しの末尾に足す。変更していない行はそのまま（元のテキストで書き出す）
 */
/** 変更者・変更日の列が見出しに無ければ末尾に足す（元の行も列数を揃える。行の値・状態は変えない） */
export function withStampColumns(doc: MasterDoc): MasterDoc {
  const missing = [STAMP_COLUMNS.by, STAMP_COLUMNS.at].filter((c) => !doc.header.includes(c));
  if (missing.length === 0) return doc;
  const header = [...doc.header, ...missing];
  const width = header.length;
  const originals: MasterDoc["originals"] = {};
  for (const [id, o] of Object.entries(doc.originals)) originals[id] = { ...o, cells: padCells(o.cells, width) };
  return { ...doc, header, headerRaw: null, originals, rows: doc.rows.map((r) => ({ id: r.id, cells: padCells(r.cells, width) })) };
}

/** 列が見出しに無ければ末尾に足す（元の行も列数を揃える。行の値・状態は変えない。§103 の provisional） */
export function withColumn(doc: MasterDoc, column: string): MasterDoc {
  if (doc.header.includes(column)) return doc;
  const header = [...doc.header, column];
  const width = header.length;
  const originals: MasterDoc["originals"] = {};
  for (const [id, o] of Object.entries(doc.originals)) originals[id] = { ...o, cells: padCells(o.cells, width) };
  return { ...doc, header, headerRaw: null, originals, rows: doc.rows.map((r) => ({ id: r.id, cells: padCells(r.cells, width) })) };
}

export function stampChangedRows(doc: MasterDoc, by: string, at: string): MasterDoc {
  if (!STAMPED_FILES.includes(doc.fileId)) return doc;
  const targets = doc.rows.filter((r) => rowState(doc, r) !== "unchanged" && !isBlankRow(r.cells));
  if (targets.length === 0) return doc;
  const { header, headerRaw, originals } = withStampColumns(doc);
  const width = header.length;
  const iBy = header.indexOf(STAMP_COLUMNS.by);
  const iAt = header.indexOf(STAMP_COLUMNS.at);
  const ids = new Set(targets.map((r) => r.id));
  const rows = doc.rows.map((r) => {
    const cells = padCells(r.cells, width);
    if (ids.has(r.id)) {
      cells[iBy] = by;
      cells[iAt] = at;
    }
    return { id: r.id, cells };
  });
  return { ...doc, header, headerRaw, rows, originals };
}

/** 編集が 1 つも無いか（行の並び・値とも元どおり） */
export function isPristine(doc: MasterDoc): boolean {
  const originalIds = Object.keys(doc.originals);
  if (doc.rows.length !== originalIds.length) return false;
  return doc.rows.every((r, i) => r.id === `o${i}` && rowState(doc, r) === "unchanged") && doc.headerRaw !== null;
}

// ---------------------------------------------------------------------------
// 編集操作（すべて新しい文書を返す。元の文書は変えない）
// ---------------------------------------------------------------------------

function cellsFromRecord(doc: MasterDoc, values: Record<string, string>, base?: readonly string[]): string[] {
  const cells = base ? padCells(base, doc.header.length) : doc.header.map(() => "");
  doc.header.forEach((h, i) => {
    if (Object.prototype.hasOwnProperty.call(values, h)) cells[i] = String(values[h] ?? "").trim();
  });
  return cells;
}

/** 行を末尾に追加する（履歴は「同じキー・同じ適用開始月なら後の行」が有効なので末尾に足すのが安全） */
export function addRow(doc: MasterDoc, values: Record<string, string>): { doc: MasterDoc; rowId: string } {
  const rowId = `n${doc.nextId}`;
  const row: MasterRow = { id: rowId, cells: cellsFromRecord(doc, values) };
  return { doc: { ...doc, rows: [...doc.rows, row], nextId: doc.nextId + 1 }, rowId };
}

/** 行の値を変える（values に無い列はそのまま） */
export function updateRow(doc: MasterDoc, rowId: string, values: Record<string, string>): MasterDoc {
  return { ...doc, rows: doc.rows.map((r) => (r.id === rowId ? { ...r, cells: cellsFromRecord(doc, values, r.cells) } : r)) };
}

/** 行を消す */
export function deleteRow(doc: MasterDoc, rowId: string): MasterDoc {
  return { ...doc, rows: doc.rows.filter((r) => r.id !== rowId) };
}

/** 変更した行を元の値に戻す（追加した行は消す） */
export function revertRow(doc: MasterDoc, rowId: string): MasterDoc {
  const o = doc.originals[rowId];
  if (!o) return deleteRow(doc, rowId);
  return { ...doc, rows: doc.rows.map((r) => (r.id === rowId ? { ...r, cells: o.cells.slice() } : r)) };
}

/** 削除した元の行を元の位置に戻す */
export function restoreRow(doc: MasterDoc, rowId: string): MasterDoc {
  const o = doc.originals[rowId];
  if (!o || doc.rows.some((r) => r.id === rowId)) return doc;
  const rows = doc.rows.slice();
  // 元の通し番号より後ろにある最初の元行の手前に入れる（追加行は末尾にあるので、その手前）
  let at = rows.findIndex((r) => {
    const ro = doc.originals[r.id];
    return !ro || ro.index > o.index;
  });
  if (at < 0) at = rows.length;
  rows.splice(at, 0, { id: rowId, cells: o.cells.slice() });
  return { ...doc, rows };
}

// ---------------------------------------------------------------------------
// 差分
// ---------------------------------------------------------------------------

export interface RowChange {
  rowId: string;
  before: Record<string, string>;
  after: Record<string, string>;
  /** 値が変わった列名（ヘッダ順） */
  columns: string[];
}

export interface MasterDiff {
  fileId: MasterFileId;
  added: Array<{ rowId: string; after: Record<string, string> }>;
  changed: RowChange[];
  removed: Array<{ rowId: string; before: Record<string, string> }>;
  /** 追加 + 変更 + 削除 の件数 */
  count: number;
}

/** 元ファイルとの差分（追加・変更・削除）。値はセルを trim せずに比べる */
export function diffMasterDoc(doc: MasterDoc): MasterDiff {
  const added: MasterDiff["added"] = [];
  const changed: RowChange[] = [];
  const present = new Set<string>();
  for (const row of doc.rows) {
    present.add(row.id);
    const o = doc.originals[row.id];
    if (!o) {
      if (!isBlankRow(row.cells)) added.push({ rowId: row.id, after: rowRecord(doc, row) });
      continue;
    }
    if (sameCells(o.cells, row.cells)) continue;
    const columns = doc.header.filter((_, i) => (o.cells[i] ?? "") !== (row.cells[i] ?? ""));
    changed.push({ rowId: row.id, before: rowRecord(doc, { cells: o.cells }), after: rowRecord(doc, row), columns });
  }
  const removed = Object.entries(doc.originals)
    .filter(([id]) => !present.has(id))
    .sort((a, b) => a[1].index - b[1].index)
    .map(([rowId, o]) => ({ rowId, before: rowRecord(doc, { cells: o.cells }) }));
  return { fileId: doc.fileId, added, changed, removed, count: added.length + changed.length + removed.length };
}

// ---------------------------------------------------------------------------
// 過去月への影響
// ---------------------------------------------------------------------------

export interface ImpactRange {
  /** 影響を数える最初の月（データの最小月。これより前は計算に使われない） */
  fromMonth: YearMonth;
  /** 影響を数える最後の月（計算基準月。実績が表示されている月 = 「過去」） */
  toMonth: YearMonth;
}

export interface Impact {
  /** 値が変わる月（昇順） */
  months: YearMonth[];
  /** 関係したキー（"member_id" など keyColumns の値を "|" で連結） */
  keys: string[];
  /**
   * 変わる月に、計算・表示に使う値が変わる列（ヘッダ順）。確認ダイアログで「何が変わるか」を出し分ける（§19.1）。
   * アサインは allocation（その月に掛かる配分の集合が変わる）
   */
  columns: string[];
}

type CellRow = readonly string[];

function keyOf(def: MasterFileDef, header: readonly string[], cells: CellRow): string {
  return def.keyColumns.map((k) => (cells[header.indexOf(k)] ?? "").trim()).join("|");
}

/** 月 m に有効な行（§5: effective_from <= m で最大、同じなら後の行）。無ければ null */
function effectiveRowAt(header: readonly string[], rows: readonly CellRow[], month: YearMonth): CellRow | null {
  const ei = header.indexOf("effective_from");
  let best: CellRow | null = null;
  let bestFrom = "";
  for (const cells of rows) {
    const from = (cells[ei] ?? "").trim();
    if (!isValidYearMonth(from) || from > month) continue;
    if (best === null || from >= bestFrom) {
      best = cells;
      bestFrom = from;
    }
  }
  return best;
}

/**
 * 月 m の有効な行の、編集前後で値が違う列（effective_from は除く。値が同じなら適用開始月が違っても計算は同じ）。
 * 片方にしか有効な行が無ければ、無い側は全列空として比べ、キー列も「変わった列」に含める（登録の有無が変わる）
 */
function effectiveDiffColumns(def: MasterFileDef, header: readonly string[], b: CellRow | null, a: CellRow | null): string[] {
  if (b === null && a === null) return [];
  const out: string[] = [];
  header.forEach((h, i) => {
    if (h === "effective_from") return;
    const bv = b ? (b[i] ?? "").trim() : "";
    const av = a ? (a[i] ?? "").trim() : "";
    if (bv !== av || ((b === null) !== (a === null) && def.keyColumns.includes(h))) out.push(h);
  });
  return out;
}

/**
 * 月 m に掛かるアサイン行の署名（その月の計算に使う allocation を並べ替えて連結。行の順序・期間の端は
 * その月の計算に影響しない。キー = メンバー×契約 でまとめてから呼ぶ）
 */
function periodSignature(header: readonly string[], rows: readonly CellRow[], month: YearMonth, valueColumn: string): string {
  const si = header.indexOf("start_month");
  const ei = header.indexOf("end_month");
  const ai = header.indexOf(valueColumn);
  const hits: string[] = [];
  for (const cells of rows) {
    const s = (cells[si] ?? "").trim();
    const e = (cells[ei] ?? "").trim();
    if (!isValidYearMonth(s) || !isValidYearMonth(e) || s > month || e < month) continue;
    hits.push((cells[ai] ?? "").trim());
  }
  return hits.sort().join("\u0002");
}

/** 祝日（§80）の変更で営業日が変わる月: 休みの日の集合が変わった日の月（名前だけの変更は数えない） */
function holidayImpact(header: readonly string[], before: readonly CellRow[], after: readonly CellRow[], range: ImpactRange): Impact {
  const di = header.indexOf("date");
  const dates = (rows: readonly CellRow[]) => new Set(rows.map((r) => (r[di] ?? "").trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
  const b = dates(before);
  const a = dates(after);
  const changed = [...new Set([...[...b].filter((d) => !a.has(d)), ...[...a].filter((d) => !b.has(d))])].sort();
  const months = [...new Set(changed.map((d) => d.slice(0, 7)))].filter((m) => m >= range.fromMonth && m <= range.toMonth).sort();
  return months.length ? { months, keys: changed, columns: ["date"] } : { months: [], keys: [], columns: [] };
}

/** 案件（§80）の月 m の中身: その月に期間が掛かる行の「予算の月割り・担当チーム・顧客・案件名」 */
const CONTRACT_COLUMNS = ["contract_id", "customer_name", "project_name", "team_id", "start_month", "end_month", "total_amount"] as const;
function contractMonthSignature(header: readonly string[], rows: readonly CellRow[], m: YearMonth): string {
  const at = (r: CellRow, c: string) => (r[header.indexOf(c)] ?? "").trim();
  return rows
    .filter((r) => isValidYearMonth(at(r, "start_month")) && isValidYearMonth(at(r, "end_month")) && at(r, "start_month") <= m && m <= at(r, "end_month"))
    .map((r) => [at(r, "contract_id"), at(r, "customer_name"), at(r, "project_name"), at(r, "team_id"), at(r, "start_month"), at(r, "end_month"), at(r, "total_amount")].join("\u0001"))
    .sort()
    .join("\u0002");
}

/**
 * 案件の変更で値が変わる月（予算は期間の均等割りなので、金額・期間を変えると期間の月すべての予算が変わる）。
 * 変わった列は、その月に掛かる行どうしで比べる（片方にしか無ければ contract_id）
 */
function contractImpact(header: readonly string[], before: readonly CellRow[], after: readonly CellRow[], range: ImpactRange): Impact {
  const sig = (r: CellRow) => r.map((c) => c.trim()).join("\u0001");
  const bs = new Set(before.map(sig));
  const as = new Set(after.map(sig));
  const touchedB = before.filter((r) => !as.has(sig(r)));
  const touchedA = after.filter((r) => !bs.has(sig(r)));
  if (touchedB.length === 0 && touchedA.length === 0) return { months: [], keys: [], columns: [] };
  const id = (r: CellRow) => (r[header.indexOf("contract_id")] ?? "").trim();
  const keys = [...new Set([...touchedB, ...touchedA].map(id))].sort();
  const months: YearMonth[] = [];
  const columns = new Set<string>();
  for (let m = range.fromMonth; m <= range.toMonth; m = addMonths(m, 1)) {
    if (contractMonthSignature(header, touchedB, m) === contractMonthSignature(header, touchedA, m)) continue;
    months.push(m);
    for (const k of keys) {
      const b = touchedB.find((r) => id(r) === k);
      const a = touchedA.find((r) => id(r) === k);
      if (!b || !a) columns.add("contract_id");
      else for (const c of CONTRACT_COLUMNS) if ((b[header.indexOf(c)] ?? "").trim() !== (a[header.indexOf(c)] ?? "").trim()) columns.add(c);
    }
  }
  return { months, keys, columns: header.filter((h) => columns.has(h)) };
}

/**
 * 編集前 → 編集後で、range（過去の月）の計算に使う値が変わる月を求める。
 * 履歴マスタはキーごとに「月 m の有効レコード」、アサインは「月 m に掛かる行の集合」を比べる。
 * 変わったキー（行の追加・変更・削除で触れたキー）だけを調べる。
 */
export function impactOfChange(fileId: MasterFileId, header: readonly string[], before: readonly CellRow[], after: readonly CellRow[], range: ImpactRange): Impact {
  const def = MASTER_FILES[fileId];
  // 目標（§63）は計算の値を変えない
  if (def.history === "list" && fileId !== "contracts" && fileId !== "holidays") return { months: [], keys: [], columns: [] };
  if (!isValidYearMonth(range.fromMonth) || !isValidYearMonth(range.toMonth) || range.fromMonth > range.toMonth) return { months: [], keys: [], columns: [] };
  if (fileId === "contracts") return contractImpact(header, before, after, range);
  if (fileId === "holidays") return holidayImpact(header, before, after, range);
  // 触れたキー: 片方にしか無い行（値まで含めて比べる）のキー
  const count = (rows: readonly CellRow[]) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const s = r.map((c) => c.trim()).join("\u0001");
      m.set(s, (m.get(s) ?? 0) + 1);
    }
    return m;
  };
  const cb = count(before);
  const ca = count(after);
  const keys = new Set<string>();
  for (const r of [...before, ...after]) {
    const s = r.map((c) => c.trim()).join("\u0001");
    if ((cb.get(s) ?? 0) !== (ca.get(s) ?? 0)) keys.add(keyOf(def, header, r));
  }
  // 同じ行が同数あっても順序が変わると「同じ適用開始月なら後の行」が変わりうる → 順序の違うキーも調べる
  if (def.history === "effective") {
    const order = (rows: readonly CellRow[]) => {
      const m = new Map<string, string[]>();
      for (const r of rows) {
        const k = keyOf(def, header, r);
        const list = m.get(k) ?? [];
        list.push(r.map((c) => c.trim()).join("\u0001"));
        m.set(k, list);
      }
      return m;
    };
    const ob = order(before);
    const oa = order(after);
    for (const [k, list] of ob) if ((oa.get(k) ?? []).join("\u0002") !== list.join("\u0002")) keys.add(k);
    for (const [k, list] of oa) if ((ob.get(k) ?? []).join("\u0002") !== list.join("\u0002")) keys.add(k);
  }
  if (keys.size === 0) return { months: [], keys: [], columns: [] };
  const group = (rows: readonly CellRow[]) => {
    const m = new Map<string, CellRow[]>();
    for (const r of rows) {
      const k = keyOf(def, header, r);
      if (!keys.has(k)) continue;
      const list = m.get(k) ?? [];
      list.push(r);
      m.set(k, list);
    }
    return m;
  };
  const gb = group(before);
  const ga = group(after);
  const months: YearMonth[] = [];
  const columns = new Set<string>();
  for (let m = range.fromMonth; m <= range.toMonth; m = addMonths(m, 1)) {
    let differs = false;
    for (const k of keys) {
      const b = gb.get(k) ?? [];
      const a = ga.get(k) ?? [];
      if (def.history === "effective") {
        const cols = effectiveDiffColumns(def, header, effectiveRowAt(header, b, m), effectiveRowAt(header, a, m));
        if (cols.length === 0) continue;
        differs = true;
        for (const c of cols) columns.add(c);
      } else if (periodSignature(header, b, m, def.valueColumn ?? "allocation") !== periodSignature(header, a, m, def.valueColumn ?? "allocation")) {
        differs = true;
        columns.add(def.valueColumn ?? "allocation");
        break;
      }
    }
    if (differs) months.push(m);
  }
  return { months, keys: [...keys].sort(), columns: header.filter((h) => columns.has(h)) };
}

/** 文書 2 つ（編集前・編集後）の影響 */
export function impactBetween(before: MasterDoc, after: MasterDoc, range: ImpactRange): Impact {
  return impactOfChange(
    after.fileId,
    after.header,
    before.rows.map((r) => r.cells),
    after.rows.map((r) => r.cells),
    range,
  );
}

export interface ImpactEffects {
  /** 変わる内容（重要なものから。例「時間単価と、原価・粗利・消化率・着地見込み」） */
  effects: string[];
  /** 原価・粗利が変わるか */
  costChanges: boolean;
  /** 補足（原価・粗利が変わらないときの明記など）。無ければ null */
  note: string | null;
}

/** 列ごとの「変わる内容」（ファイル → 列 → [順位, 文, 原価が変わるか]）。§19.1 */
const EFFECTS: Record<MasterFileId, Record<string, [number, string, boolean]>> = {
  members: {
    title: [0, T.masterFiles.effectRate, true],
    member_id: [1, T.masterFiles.effectMemberId, false],
    team_id: [2, T.masterFiles.effectTeamId, false],
    division: [3, T.masterFiles.effectDepartment, false],
    department: [3, T.masterFiles.effectDepartment, false],
    section: [3, T.masterFiles.effectDepartment, false],
    name: [4, T.masterFiles.effectName, false],
    kind: [5, T.masterFiles.effectKind, false],
  },
  rates: {
    key: [0, T.masterFiles.effectRate, true],
    hourly_rate: [0, T.masterFiles.effectRate, true],
    provisional: [1, T.masterFiles.effectProvisional, false],
  },
  customerTeams: {
    customer_name: [0, T.masterFiles.effectContractTeam, false],
    team_id: [0, T.masterFiles.effectContractTeam, false],
  },
  teams: {
    team_id: [0, T.masterFiles.effectTeamTree, false],
    parent_team_id: [1, T.masterFiles.effectParent, false],
    name: [2, T.masterFiles.effectTeamName, false],
    level: [3, T.masterFiles.effectLevel, false],
    leader_member_id: [4, T.masterFiles.effectLeader, false],
  },
  holidays: {
    date: [0, T.masterFiles.effectHolidays, false],
  },
  contracts: {
    total_amount: [0, T.masterFiles.effectContractBudget, false],
    start_month: [0, T.masterFiles.effectContractBudget, false],
    end_month: [0, T.masterFiles.effectContractBudget, false],
    contract_id: [0, T.masterFiles.effectContractBudget, false],
    team_id: [1, T.masterFiles.effectContractTeam, false],
    customer_name: [2, T.masterFiles.effectContractName, false],
    project_name: [2, T.masterFiles.effectContractName, false],
  },
  assignments: {
    allocation: [0, T.masterFiles.effectAllocation, false],
  },
  outside: {
    person_months: [0, T.masterFiles.effectOutside, false],
  },
  targets: {},
};

/** Impact.columns から、確認ダイアログに出す「何が変わるか」を作る（§19.1。一律に「原価・粗利など」と書かない） */
export function describeImpactEffects(fileId: MasterFileId, columns: readonly string[]): ImpactEffects {
  const table = EFFECTS[fileId];
  const hits = columns.map((c) => table[c]).filter((e): e is [number, string, boolean] => e !== undefined);
  hits.sort((a, b) => a[0] - b[0]);
  const effects = [...new Set(hits.map((e) => e[1]))];
  const costChanges = hits.some((e) => e[2]);
  if (effects.length === 0) return { effects: [T.masterFiles.effectDefault], costChanges: false, note: null };
  const note = fileId === "members" && !costChanges ? T.masterFiles.noCostChangeNote : null;
  return { effects, costChanges, note };
}

/** 影響の月を「2026-04〜2026-10（7か月）」のように短く言う（連続していない月は「ほか」） */
export function describeImpactMonths(months: readonly YearMonth[]): string {
  if (months.length === 0) return T.common.none;
  const first = months[0] as string;
  const last = months[months.length - 1] as string;
  if (months.length === 1) return fmt(T.masterFiles.oneMonth, { first });
  return fmt(T.masterFiles.monthRange, { first, last, n: months.length });
}

// ---------------------------------------------------------------------------
// 検証（§14 と同じ parseDataset + validateDataset を編集後のデータに対して）
// ---------------------------------------------------------------------------

/** 検証に使う、編集しないファイル（ビルド時の生テキスト） */
export interface ContextFiles {
  /** ビルド時の contracts.csv・holidays.csv（案件・祝日の文書を渡さないときだけ使う。§80） */
  contracts: string;
  mapping: string;
  holidays: string;
  /** 作業種別の分類表（契約外の種別の検証用。§50.1）。省略 = 分類なし */
  taskTypes?: string;
  /** 顧客の既定の担当チーム（§103。文書を渡さないときだけ使う） */
  customerTeams?: string;
}

export interface RowIssue extends ValidationIssue {
  fileId: MasterFileId | null;
  /** 行に結び付けられたときの行 id */
  rowId: string | null;
}

export interface EditValidation {
  issues: RowIssue[];
  errors: number;
  warnings: number;
  /** fileId → rowId → その行の問題 */
  byRow: Record<MasterFileId, Record<string, RowIssue[]>>;
  /** 行に結び付かない問題（循環・列の欠落・編集対象外のファイルの問題） */
  general: RowIssue[];
  /** 書き出したテキスト（保存・ダウンロードに使う） */
  texts: Record<MasterFileId, string>;
  /** 読み込んだデータ（変更の影響の計算に使う。§65） */
  dataset: Dataset;
}

/**
 * 編集後の 4 ファイル ＋ 編集しないファイルで parseDataset（validateDataset を含む）を実行し、
 * 問題を行に結び付ける。作業実績は読み込まない（作業実績に関する警告はビルド後の「データ確認」で見る）
 */
export function validateEdited(docs: Omit<Record<MasterFileId, MasterDoc>, "contracts" | "holidays" | "customerTeams"> & Partial<Pick<Record<MasterFileId, MasterDoc>, "contracts" | "holidays" | "customerTeams">>, context: ContextFiles, config: Config): EditValidation {
  const ser = {} as Record<MasterFileId, SerializedDoc>;
  // 案件・祝日（§80）の文書が無い呼び出し（以前の形）は、ビルド時の contracts.csv・holidays.csv をそのまま使う
  const ids = MASTER_FILE_IDS.filter((id) => docs[id] !== undefined);
  for (const id of ids) ser[id] = serializeMasterDoc(docs[id] as MasterDoc);
  const files: DatasetFiles = {
    config,
    contracts: ser.contracts?.text ?? context.contracts,
    mapping: context.mapping,
    holidays: ser.holidays?.text ?? context.holidays,
    assignments: ser.assignments.text,
    teams: ser.teams.text,
    members: ser.members.text,
    rates: ser.rates.text,
    outsidePlans: ser.outside.text,
    targets: ser.targets.text,
    ...(ser.customerTeams ? { customerTeams: ser.customerTeams.text } : context.customerTeams !== undefined ? { customerTeams: context.customerTeams } : {}),
    ...(context.taskTypes !== undefined ? { taskTypes: context.taskTypes } : {}),
    worklogs: [],
  };
  const { issues, dataset } = parseDataset(files);
  const byFile = new Map<string, MasterFileId>(ids.map((id) => [MASTER_FILES[id].issueFile, id]));
  const byRow = { members: {}, rates: {}, teams: {}, contracts: {}, customerTeams: {}, holidays: {}, assignments: {}, outside: {}, targets: {} } as EditValidation["byRow"];
  const general: RowIssue[] = [];
  const seen = new Set<string>();
  const out: RowIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.severity}|${issue.code}|${issue.file ?? ""}|${issue.row ?? ""}|${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fileId = issue.file ? (byFile.get(issue.file) ?? null) : null;
    let rowId: string | null = null;
    // MISSING_COLUMN の row=1 はヘッダなので行に結び付けない
    if (fileId && issue.row !== undefined && issue.row >= 2 && issue.code !== "MISSING_COLUMN") rowId = ser[fileId].rowIds[issue.row - 2] ?? null;
    const ri: RowIssue = { ...issue, fileId, rowId };
    out.push(ri);
    if (fileId && rowId) (byRow[fileId][rowId] ??= []).push(ri);
    else general.push(ri);
  }
  const texts = {} as Record<MasterFileId, string>;
  for (const id of ids) texts[id] = ser[id].text;
  return {
    issues: out,
    errors: out.filter((i) => i.severity === "error").length,
    warnings: out.filter((i) => i.severity === "warning").length,
    byRow,
    general,
    texts,
    dataset,
  };
}

/** 行に表示する文（"masters/rates.csv 12 行目: " の接頭辞を外す） */
export function issueText(issue: Pick<ValidationIssue, "message">): string {
  return issue.message.replace(/^[^\s:]+\.csv \d+ 行目: /, "").replace(/^[^\s:]+\.csv: /, "");
}


// ---------------------------------------------------------------------------
// 下書き（localStorage）: 「土台 ＋ 差分」として持ち、復元時に最新の土台へ当て直す（§19.2）
// ---------------------------------------------------------------------------

export const DRAFT_STORAGE_KEY = "yojitsu-navi:masters-draft:v1";
/** このタブで最後に書いた下書きの savedAt（sessionStorage）。同じタブで開き直したときは聞かずに続きから */
export const DRAFT_SESSION_KEY = "yojitsu-navi:masters-draft-session";

/**
 * 1 ファイル分の下書き。差分は土台（baseText）に対して持つ。
 * セルの並びは parseMasterDoc(baseText) のヘッダ順（ヘッダは baseText から決まるので保存しない）
 */
export interface DraftFile {
  /** 編集の土台にした生テキスト */
  baseText: string;
  baseCommitId: string | null;
  /** 変更した土台の行（baseIndex = 土台のデータ行の通し番号）と変更後のセル */
  changed: Array<{ baseIndex: number; cells: string[] }>;
  /** 削除した土台の行の通し番号（昇順） */
  removed: number[];
  /** 追加した行のセル（追加した順） */
  added: string[][];
  /** 編集で見出しの末尾に足した列（§103.5 の provisional）。セルはこの列を足した見出しの順 */
  columns?: string[];
}

export interface MasterDraft {
  version: 2;
  savedAt: string;
  files: Partial<Record<MasterFileId, DraftFile>>;
}

type Bases = Record<MasterFileId, { text: string; lastCommitId: string | null }>;

/** 文書（土台 base から編集したもの）→ 下書きのファイル（土台に対する差分） */
export function draftFileOf(doc: MasterDoc, base: { text: string; lastCommitId: string | null }): DraftFile {
  const changed: DraftFile["changed"] = [];
  const added: string[][] = [];
  const present = new Set<string>();
  for (const row of doc.rows) {
    present.add(row.id);
    const o = doc.originals[row.id];
    if (!o) {
      if (!isBlankRow(row.cells)) added.push(row.cells.slice());
    } else if (!sameCells(o.cells, row.cells)) {
      changed.push({ baseIndex: o.index, cells: row.cells.slice() });
    }
  }
  changed.sort((a, b) => a.baseIndex - b.baseIndex);
  const removed = Object.entries(doc.originals)
    .filter(([id]) => !present.has(id))
    .map(([, o]) => o.index)
    .sort((a, b) => a - b);
  // 見出しに足した列（§103.5）。見出しを書き換えたときだけ土台の見出しと比べる
  const columns = doc.headerRaw === null ? (() => {
    const baseHeader = parseMasterDoc(doc.fileId, base.text).header;
    return doc.header.filter((h) => !baseHeader.includes(h));
  })() : [];
  return { baseText: base.text, baseCommitId: base.lastCommitId, changed, removed, added, ...(columns.length > 0 ? { columns } : {}) };
}

/** 下書きのファイルの変更件数（追加 + 変更 + 削除） */
export function draftFileCount(f: DraftFile): number {
  return f.changed.length + f.removed.length + f.added.length;
}

/** 編集のあるファイルだけを下書きにする（編集が無ければ null = 下書きを消す） */
export function makeDraft(docs: Record<MasterFileId, MasterDoc>, bases: Bases, savedAt: string): MasterDraft | null {
  const files: MasterDraft["files"] = {};
  let any = false;
  for (const id of MASTER_FILE_IDS) {
    const f = draftFileOf(docs[id], bases[id]);
    if (draftFileCount(f) === 0) continue;
    any = true;
    files[id] = f;
  }
  return any ? { version: 2, savedAt, files } : null;
}

const isCells = (v: unknown): v is string[] => Array.isArray(v) && v.every((c) => typeof c === "string");
const isIndex = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * 下書きの JSON を読む（壊れていれば null）。
 * 以前の形式（version 1: 土台 ＋ 編集後の全行）は差分の形（version 2）に直して返す
 */
export function parseDraft(json: string | null): MasterDraft | null {
  if (!json) return null;
  try {
    const d = JSON.parse(json) as { version?: unknown; savedAt?: unknown; files?: unknown };
    if (!d || (d.version !== 1 && d.version !== 2) || typeof d.files !== "object" || d.files === null) return null;
    const files: MasterDraft["files"] = {};
    for (const [id, raw] of Object.entries(d.files as Record<string, unknown>)) {
      if (!MASTER_FILE_IDS.includes(id as MasterFileId)) return null;
      const fileId = id as MasterFileId;
      const f = raw as Record<string, unknown> | null;
      if (!f || typeof f.baseText !== "string") return null;
      const baseCommitId = typeof f.baseCommitId === "string" ? f.baseCommitId : null;
      if (d.version === 1) {
        const rows = f.rows as unknown;
        if (!Array.isArray(rows) || !rows.every((r) => r && typeof r.id === "string" && isCells(r.cells))) return null;
        const base = parseMasterDoc(fileId, f.baseText);
        const doc: MasterDoc = { ...base, rows: (rows as MasterRow[]).map((r) => ({ id: r.id, cells: padCells(r.cells, base.header.length) })) };
        files[fileId] = draftFileOf(doc, { text: f.baseText, lastCommitId: baseCommitId });
        continue;
      }
      const changed = f.changed as unknown;
      const removed = f.removed as unknown;
      const added = f.added as unknown;
      if (!Array.isArray(changed) || !changed.every((c) => c && isIndex(c.baseIndex) && isCells(c.cells))) return null;
      if (!Array.isArray(removed) || !removed.every(isIndex)) return null;
      if (!Array.isArray(added) || !added.every(isCells)) return null;
      files[fileId] = {
        baseText: f.baseText,
        baseCommitId,
        changed: (changed as DraftFile["changed"]).map((c) => ({ baseIndex: c.baseIndex, cells: c.cells.slice() })),
        removed: (removed as number[]).slice(),
        added: (added as string[][]).map((c) => c.slice()),
        ...(isCells(f.columns) && f.columns.length > 0 ? { columns: (f.columns as string[]).slice() } : {}),
      };
    }
    return { version: 2, savedAt: typeof d.savedAt === "string" ? d.savedAt : "", files };
  } catch {
    return null;
  }
}

/** 下書きのファイルを、下書きの土台（baseText）に対する編集として文書に戻す */
export function docFromDraft(fileId: MasterFileId, f: DraftFile): MasterDoc {
  return rebaseDraftFile(fileId, f, f.baseText).doc;
}

/** 下書きの土台が今のビルドと違うファイル（他の人が先に更新した） */
export function staleDraftFiles(draft: MasterDraft, bases: Bases): MasterFileId[] {
  const out: MasterFileId[] = [];
  for (const id of MASTER_FILE_IDS) {
    const f = draft.files[id];
    if (!f) continue;
    const b = bases[id];
    const commitChanged = f.baseCommitId !== null && b.lastCommitId !== null && f.baseCommitId !== b.lastCommitId;
    if (commitChanged || f.baseText !== b.text) out.push(id);
  }
  return out;
}

// ---- 当て直し（rebase） ----------------------------------------------------

/**
 * 衝突の種類
 *  - both-changed:       下書きで変更した行を、最新側でも別の値に変更した
 *  - changed-vs-deleted: 下書きで変更した行を、最新側では削除した
 *  - deleted-vs-changed: 下書きで削除した行を、最新側では変更した
 */
export type RebaseConflictKind = "both-changed" | "changed-vs-deleted" | "deleted-vs-changed";
export type ConflictChoice = "mine" | "theirs";

export interface RebaseConflict {
  /** 衝突の識別子（下書きの土台の行番号。同じ下書き・同じ最新の土台なら毎回同じ） */
  id: string;
  kind: RebaseConflictKind;
  /** 下書きを作ったときの行（最新のヘッダの列名で） */
  base: Record<string, string>;
  /** 下書きの行（null = 下書きで削除） */
  mine: Record<string, string> | null;
  /** 最新のデータの行（null = 最新側で削除） */
  theirs: Record<string, string> | null;
  /** mine と theirs で値が違う列（片方が削除なら、もう片方の値のある列。最新のヘッダ順） */
  columns: string[];
}

export interface RebaseResult {
  /** 最新の土台に当て直した文書（衝突は choices に従う。選ばれていない衝突は最新のデータのまま） */
  doc: MasterDoc;
  /** 下書きの土台と最新の土台が違うか */
  stale: boolean;
  /** そのまま当て直せた変更の件数（両方が同じ値に変えた・両方が削除した行を含む） */
  applied: number;
  conflicts: RebaseConflict[];
  /** まだ choices で選ばれていない衝突の id */
  unresolved: string[];
}

/** a の各行に対応する b の行番号（無ければ -1）。同じ内容の行を順序を保って最長一致で対応させる */
export function alignRows(a: readonly string[], b: readonly string[]): number[] {
  const map = new Array<number>(a.length).fill(-1);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) {
    map[s] = s;
    s++;
  }
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
    map[ea] = eb;
  }
  const n = ea - s;
  const m = eb - s;
  if (n === 0 || m === 0) return map;
  if (n * m <= 4_000_000) {
    // 最長共通部分列（LCS）
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = a[s + i] === b[s + j] ? (dp[(i + 1) * w + j + 1] as number) + 1 : Math.max(dp[(i + 1) * w + j] as number, dp[i * w + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[s + i] === b[s + j]) {
        map[s + i] = s + j;
        i++;
        j++;
      } else if ((dp[(i + 1) * w + j] as number) >= (dp[i * w + j + 1] as number)) i++;
      else j++;
    }
    return map;
  }
  // 行数が非常に多いとき: 順序を保って、次に現れる同じ内容の行に対応させる（貪欲）
  const positions = new Map<string, number[]>();
  for (let j = s; j < eb; j++) {
    const list = positions.get(b[j] as string) ?? [];
    list.push(j);
    positions.set(b[j] as string, list);
  }
  let last = s - 1;
  for (let i = s; i < ea; i++) {
    const list = positions.get(a[i] as string);
    if (!list) continue;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((list[mid] as number) <= last) lo = mid + 1;
      else hi = mid;
    }
    if (lo < list.length) {
      last = list[lo] as number;
      map[i] = last;
    }
  }
  return map;
}

/**
 * 下書き（土台 f.baseText に対する差分）を、最新の土台 latestText に当て直す（純粋・決定的）。
 *
 * 1. 下書きの土台の行と最新の土台の行を、内容（最新のヘッダの列名で並べ、trim した値）で対応付ける（alignRows）
 * 2. 対応しなかった土台の行は、同じ区間（前後の対応した行の間）にある最新側の対応しなかった行のうち、
 *    キー列が同じもの（適用開始月／開始月も同じものを優先）と対にする（= 最新側で変更された行）。
 *    対が無ければ最新側で削除された行
 * 3. 下書きの変更・削除は、最新側で変わっていない行にはそのまま当てる。最新側でも変更・削除されていれば衝突
 *    （両方が同じ値に変えた・両方が削除したなら衝突にしない）
 * 4. 下書きで追加した行は末尾に足す（衝突で「自分の下書き」を選んだ、最新側で削除済みの行もその手前に足す）
 *
 * 当て直した結果を draftFileOf で下書きにし、同じ latestText にもう一度当て直しても結果は変わらない（冪等）
 */
export function rebaseDraftFile(fileId: MasterFileId, f: DraftFile, latestText: string, choices: Readonly<Record<string, ConflictChoice>> = {}): RebaseResult {
  const def = MASTER_FILES[fileId];
  // 下書きで見出しに足した列（§103.5）は、土台にも最新にも足してから当て直す
  let old = parseMasterDoc(fileId, f.baseText);
  let latest = parseMasterDoc(fileId, latestText);
  for (const c of f.columns ?? []) {
    old = withColumn(old, c);
    latest = withColumn(latest, c);
  }
  const header = latest.header;
  const width = header.length;
  const sameHeader = sameCells(old.header, header);
  const colMap = header.map((h) => old.header.indexOf(h));
  /** 下書き側のセル → 最新のヘッダ順（下書きの土台に無い列は fallback の値か空） */
  const remap = (cells: readonly string[], fallback?: readonly string[]): string[] => {
    if (sameHeader) return padCells(cells, width);
    return header.map((_, i) => {
      const at = colMap[i] as number;
      return at < 0 ? (fallback?.[i] ?? "") : (cells[at] ?? "");
    });
  };
  const sig = (cells: readonly string[]): string => header.map((_, i) => (cells[i] ?? "").trim()).join("\u0001");
  const oldCells = old.rows.map((r) => remap(r.cells));
  const latestCells = latest.rows.map((r) => r.cells);
  const map = alignRows(oldCells.map(sig), latestCells.map(sig));

  // 対応しなかった行を、同じ区間・同じキーの行と対にする
  const pair = new Array<number>(old.rows.length).fill(-1);
  const matchedB = new Set<number>(map.filter((j) => j >= 0));
  const timeIndex = header.indexOf(timeColumnOf(def));
  const keyAt = (cells: readonly string[]) => keyOf(def, header, cells);
  const timeAt = (cells: readonly string[]) => (cells[timeIndex] ?? "").trim();
  const bounds: Array<[number, number]> = [];
  {
    const nextMatched = new Array<number>(old.rows.length).fill(latest.rows.length);
    let next = latest.rows.length;
    for (let i = old.rows.length - 1; i >= 0; i--) {
      nextMatched[i] = next;
      if ((map[i] as number) >= 0) next = map[i] as number;
    }
    let prev = -1;
    for (let i = 0; i < old.rows.length; i++) {
      bounds.push([prev, nextMatched[i] as number]);
      if ((map[i] as number) >= 0) prev = map[i] as number;
    }
  }
  const usedB = new Set<number>();
  for (const strict of [true, false]) {
    for (let i = 0; i < old.rows.length; i++) {
      if ((map[i] as number) >= 0 || (pair[i] as number) >= 0) continue;
      const a = oldCells[i] as string[];
      const [lo, hi] = bounds[i] as [number, number];
      for (let j = lo + 1; j < hi; j++) {
        if (matchedB.has(j) || usedB.has(j)) continue;
        const b = latestCells[j] as string[];
        if (keyAt(a) !== keyAt(b) || (strict && timeAt(a) !== timeAt(b))) continue;
        pair[i] = j;
        usedB.add(j);
        break;
      }
    }
  }

  const rowsOut: Array<MasterRow | null> = latest.rows.map((r) => ({ id: r.id, cells: r.cells.slice() }));
  const appended: string[][] = [];
  const conflicts: RebaseConflict[] = [];
  let applied = 0;
  const record = (cells: readonly string[]) => rowRecord(latest, { cells: cells as string[] });
  const diffCols = (x: readonly string[] | null, y: readonly string[] | null) => header.filter((_, i) => (x ? (x[i] ?? "").trim() : "") !== (y ? (y[i] ?? "").trim() : ""));
  const touched = new Map<number, { kind: "changed"; cells: string[] } | { kind: "removed" }>();
  for (const c of f.changed) if (c.baseIndex < old.rows.length) touched.set(c.baseIndex, { kind: "changed", cells: c.cells });
  for (const i of f.removed) if (i < old.rows.length) touched.set(i, { kind: "removed" });
  for (const i of [...touched.keys()].sort((x, y) => x - y)) {
    const t = touched.get(i)!;
    const j = map[i] as number;
    const p = pair[i] as number;
    const id = String(i);
    const base = record(oldCells[i] as string[]);
    if (t.kind === "changed") {
      if (j >= 0) {
        rowsOut[j] = { id: latest.rows[j]!.id, cells: remap(t.cells, latestCells[j]) };
        applied++;
      } else if (p >= 0) {
        const theirs = latestCells[p] as string[];
        const mine = remap(t.cells, theirs);
        if (sig(mine) === sig(theirs)) {
          applied++; // 両方が同じ値に変えた
          continue;
        }
        conflicts.push({ id, kind: "both-changed", base, mine: record(mine), theirs: record(theirs), columns: diffCols(mine, theirs) });
        if (choices[id] === "mine") rowsOut[p] = { id: latest.rows[p]!.id, cells: mine };
      } else {
        const mine = remap(t.cells);
        conflicts.push({ id, kind: "changed-vs-deleted", base, mine: record(mine), theirs: null, columns: diffCols(mine, null) });
        if (choices[id] === "mine") appended.push(mine);
      }
    } else if (j >= 0) {
      rowsOut[j] = null;
      applied++;
    } else if (p >= 0) {
      const theirs = latestCells[p] as string[];
      conflicts.push({ id, kind: "deleted-vs-changed", base, mine: null, theirs: record(theirs), columns: diffCols(null, theirs) });
      if (choices[id] === "mine") rowsOut[p] = null;
    } else {
      applied++; // 両方が削除
    }
  }
  let nextId = 1;
  const rows = rowsOut.filter((r): r is MasterRow => r !== null);
  for (const cells of [...appended, ...f.added.map((c) => remap(c))]) rows.push({ id: `n${nextId++}`, cells: padCells(cells, width) });
  applied += f.added.length;
  return {
    doc: { ...latest, rows, nextId },
    stale: f.baseText !== latestText,
    applied,
    conflicts,
    unresolved: conflicts.filter((c) => choices[c.id] !== "mine" && choices[c.id] !== "theirs").map((c) => c.id),
  };
}

// ---------------------------------------------------------------------------
// リソース計画タブ（§23）の入力: 編集中の文書 → PlanSources
// ---------------------------------------------------------------------------

/**
 * 編集中（保存前）の組織・メンバー・アサイン（・運用保守以外の予定）と、契約の担当組織からリソース計画の計算の入力を作る。
 * worklogMonths は作業実績のある「メンバー|月」（§35 の不在した月の稼働判定。model.json の worklogMonths）
 */
export function planSourcesFromDocs(
  docs: Pick<Record<MasterFileId, MasterDoc>, "teams" | "members" | "assignments"> & Partial<Pick<Record<MasterFileId, MasterDoc>, "outside" | "customerTeams">>,
  contractsText: string,
  worklogMonths: readonly string[] = [],
): PlanSources {
  const teams: TeamRecord[] = docs.teams.rows.map((r) => {
    const v = rowRecord(docs.teams, r);
    return {
      teamId: (v.team_id ?? "").trim(),
      name: (v.name ?? "").trim(),
      parentTeamId: (v.parent_team_id ?? "").trim() || null,
      effectiveFrom: (v.effective_from ?? "").trim(),
      level: (v.level ?? "").trim(),
      leaderMemberId: (v.leader_member_id ?? "").trim() || null,
    };
  });
  const members: MemberRecord[] = docs.members.rows.map((r) => {
    const v = rowRecord(docs.members, r);
    return {
      memberId: (v.member_id ?? "").trim(),
      name: (v.name ?? "").trim(),
      kind: (v.kind ?? "").trim() as MemberRecord["kind"],
      title: (v.title ?? "").trim(),
      ...((v.division ?? "").trim() ? { division: (v.division ?? "").trim() } : {}),
      department: (v.department ?? "").trim(),
      section: (v.section ?? "").trim(),
      teamId: (v.team_id ?? "").trim() || null,
      effectiveFrom: (v.effective_from ?? "").trim(),
      ...memberStatus(v.status ?? ""),
    };
  });
  const assignments: PlanAssignment[] = docs.assignments.rows.map((r) => {
    const v = rowRecord(docs.assignments, r);
    const raw = (v.allocation ?? "").trim();
    return {
      rowId: r.id,
      memberId: (v.member_id ?? "").trim(),
      contractId: (v.contract_id ?? "").trim(),
      startMonth: (v.start_month ?? "").trim(),
      endMonth: (v.end_month ?? "").trim(),
      allocation: raw === "" ? Number.NaN : parseNumberCell(raw),
    };
  });
  // 担当チームが空の案件は顧客の既定の担当チーム（§103.6。読み込み時と同じ）
  const ct = docs.customerTeams;
  const defaults = ct ? customerTeamIndex(ct.rows.map((r) => ({ customerName: cellOf(ct, r, "customer_name"), teamId: cellOf(ct, r, "team_id") }))) : new Map<string, string>();
  const contractTeams = new Map<string, string | null>();
  for (const row of parseCsvTable(contractsText).rows) {
    const id = row.get("contract_id");
    if (id !== "" && !contractTeams.has(id)) contractTeams.set(id, row.get("team_id") || defaults.get(normalizeName(row.get("customer_name"))) || null);
  }
  const outsidePlans = (docs.outside?.rows ?? []).map((r) => {
    const v = rowRecord(docs.outside as MasterDoc, r);
    const raw = (v.person_months ?? "").trim();
    return { memberId: (v.member_id ?? "").trim(), startMonth: (v.start_month ?? "").trim(), endMonth: (v.end_month ?? "").trim(), personMonths: raw === "" ? Number.NaN : parseNumberCell(raw) };
  });
  return { teams, members, assignments, contractTeams, outsidePlans, worklogMonths };
}
