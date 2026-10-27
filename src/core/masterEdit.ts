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
import { parseDataset, type DatasetFiles } from "./csv.js";
import type { Config, YearMonth } from "./types.js";
import type { ValidationIssue } from "./validate.js";

// ---------------------------------------------------------------------------
// 対象ファイルの定義
// ---------------------------------------------------------------------------

export type MasterFileId = "members" | "rates" | "teams" | "assignments";

export interface MasterColumnDef {
  /** CSV の列名 */
  name: string;
  /** 画面の見出し */
  label: string;
  /** 入力の種類（画面のフォーム部品を決める） */
  input: "text" | "month" | "number" | "kind" | "team" | "member" | "contract" | "rateKey" | "title";
  required: boolean;
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
   */
  history: "effective" | "period";
  /** 影響範囲を判定するキー列 */
  keyColumns: string[];
}

export const MASTER_FILES: Record<MasterFileId, MasterFileDef> = {
  members: {
    id: "members",
    path: "data/masters/members.csv",
    issueFile: "masters/members.csv",
    label: "メンバー",
    history: "effective",
    keyColumns: ["member_id"],
    columns: [
      { name: "member_id", label: "メンバーID", input: "member", required: true },
      { name: "name", label: "氏名", input: "text", required: true },
      { name: "kind", label: "区分", input: "kind", required: true },
      { name: "title", label: "役職", input: "title", required: false },
      { name: "department", label: "部署", input: "text", required: false },
      { name: "section", label: "課", input: "text", required: false },
      { name: "team_id", label: "所属チーム", input: "team", required: false },
      { name: "effective_from", label: "適用開始月", input: "month", required: true },
    ],
  },
  rates: {
    id: "rates",
    path: "data/masters/rates.csv",
    issueFile: "masters/rates.csv",
    label: "単価",
    history: "effective",
    keyColumns: ["key"],
    columns: [
      { name: "key", label: "役職名 または メンバーID", input: "rateKey", required: true },
      { name: "hourly_rate", label: "時間単価（円）", input: "number", required: true },
      { name: "effective_from", label: "適用開始月", input: "month", required: true },
    ],
  },
  teams: {
    id: "teams",
    path: "data/masters/teams.csv",
    issueFile: "masters/teams.csv",
    label: "チーム",
    history: "effective",
    keyColumns: ["team_id"],
    columns: [
      { name: "team_id", label: "チームID", input: "text", required: true },
      { name: "name", label: "チーム名", input: "text", required: true },
      { name: "parent_team_id", label: "親チーム", input: "team", required: false },
      { name: "effective_from", label: "適用開始月", input: "month", required: true },
    ],
  },
  assignments: {
    id: "assignments",
    path: "data/assignments.csv",
    issueFile: "assignments.csv",
    label: "アサイン",
    history: "period",
    keyColumns: ["member_id", "contract_id"],
    columns: [
      { name: "member_id", label: "メンバーID", input: "member", required: true },
      { name: "contract_id", label: "契約ID", input: "contract", required: true },
      { name: "start_month", label: "開始月", input: "month", required: true },
      { name: "end_month", label: "終了月", input: "month", required: true },
      { name: "allocation", label: "配分（人月）", input: "number", required: true },
    ],
  },
};

export const MASTER_FILE_IDS: readonly MasterFileId[] = ["members", "rates", "teams", "assignments"];

/** memberSource で取り込む列（§20.2。team_id は取り込まない） */
export const MEMBER_IMPORTED_COLUMNS: readonly string[] = ["name", "kind", "title", "department", "section"];

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
    if (!header.includes(c.name)) {
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
}

type CellRow = readonly string[];

function keyOf(def: MasterFileDef, header: readonly string[], cells: CellRow): string {
  return def.keyColumns.map((k) => (cells[header.indexOf(k)] ?? "").trim()).join("|");
}

/** 月 m に有効な行（§5: effective_from <= m で最大、同じなら後の行）のセルを "\u0001" で連結した署名 */
function effectiveSignature(header: readonly string[], rows: readonly CellRow[], month: YearMonth): string | null {
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
  return best === null ? null : best.map((c) => c.trim()).join("\u0001");
}

/**
 * 月 m に掛かるアサイン行の署名（その月の計算に使う allocation を並べ替えて連結。行の順序・期間の端は
 * その月の計算に影響しない。キー = メンバー×契約 でまとめてから呼ぶ）
 */
function periodSignature(header: readonly string[], rows: readonly CellRow[], month: YearMonth): string {
  const si = header.indexOf("start_month");
  const ei = header.indexOf("end_month");
  const ai = header.indexOf("allocation");
  const hits: string[] = [];
  for (const cells of rows) {
    const s = (cells[si] ?? "").trim();
    const e = (cells[ei] ?? "").trim();
    if (!isValidYearMonth(s) || !isValidYearMonth(e) || s > month || e < month) continue;
    hits.push((cells[ai] ?? "").trim());
  }
  return hits.sort().join("\u0002");
}

/**
 * 編集前 → 編集後で、range（過去の月）の計算に使う値が変わる月を求める。
 * 履歴マスタはキーごとに「月 m の有効レコード」、アサインは「月 m に掛かる行の集合」を比べる。
 * 変わったキー（行の追加・変更・削除で触れたキー）だけを調べる。
 */
export function impactOfChange(fileId: MasterFileId, header: readonly string[], before: readonly CellRow[], after: readonly CellRow[], range: ImpactRange): Impact {
  const def = MASTER_FILES[fileId];
  if (!isValidYearMonth(range.fromMonth) || !isValidYearMonth(range.toMonth) || range.fromMonth > range.toMonth) return { months: [], keys: [] };
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
  if (keys.size === 0) return { months: [], keys: [] };
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
  for (let m = range.fromMonth; m <= range.toMonth; m = addMonths(m, 1)) {
    for (const k of keys) {
      const b = gb.get(k) ?? [];
      const a = ga.get(k) ?? [];
      const differs = def.history === "effective" ? effectiveSignature(header, b, m) !== effectiveSignature(header, a, m) : periodSignature(header, b, m) !== periodSignature(header, a, m);
      if (differs) {
        months.push(m);
        break;
      }
    }
  }
  return { months, keys: [...keys].sort() };
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

/** 影響の月を「2026-04〜2026-10（7か月）」のように短く言う（連続していない月は「ほか」） */
export function describeImpactMonths(months: readonly YearMonth[]): string {
  if (months.length === 0) return "なし";
  const first = months[0] as string;
  const last = months[months.length - 1] as string;
  if (months.length === 1) return `${first}（1か月）`;
  return `${first}〜${last}（${months.length}か月）`;
}

// ---------------------------------------------------------------------------
// 検証（§14 と同じ parseDataset + validateDataset を編集後のデータに対して）
// ---------------------------------------------------------------------------

/** 検証に使う、編集しないファイル（ビルド時の生テキスト） */
export interface ContextFiles {
  contracts: string;
  mapping: string;
  holidays: string;
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
}

/**
 * 編集後の 4 ファイル ＋ 編集しないファイルで parseDataset（validateDataset を含む）を実行し、
 * 問題を行に結び付ける。作業実績は読み込まない（作業実績に関する警告はビルド後の「データ確認」で見る）
 */
export function validateEdited(docs: Record<MasterFileId, MasterDoc>, context: ContextFiles, config: Config): EditValidation {
  const ser = {} as Record<MasterFileId, SerializedDoc>;
  for (const id of MASTER_FILE_IDS) ser[id] = serializeMasterDoc(docs[id]);
  const files: DatasetFiles = {
    config,
    contracts: context.contracts,
    mapping: context.mapping,
    holidays: context.holidays,
    assignments: ser.assignments.text,
    teams: ser.teams.text,
    members: ser.members.text,
    rates: ser.rates.text,
    worklogs: [],
  };
  const { issues } = parseDataset(files);
  const byFile = new Map<string, MasterFileId>(MASTER_FILE_IDS.map((id) => [MASTER_FILES[id].issueFile, id]));
  const byRow = { members: {}, rates: {}, teams: {}, assignments: {} } as EditValidation["byRow"];
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
  for (const id of MASTER_FILE_IDS) texts[id] = ser[id].text;
  return {
    issues: out,
    errors: out.filter((i) => i.severity === "error").length,
    warnings: out.filter((i) => i.severity === "warning").length,
    byRow,
    general,
    texts,
  };
}

/** 行に表示する文（"masters/rates.csv 12 行目: " の接頭辞を外す） */
export function issueText(issue: Pick<ValidationIssue, "message">): string {
  return issue.message.replace(/^[^\s:]+\.csv \d+ 行目: /, "").replace(/^[^\s:]+\.csv: /, "");
}

// ---------------------------------------------------------------------------
// 下書き（localStorage）
// ---------------------------------------------------------------------------

export const DRAFT_STORAGE_KEY = "yojitsu-navi:masters-draft:v1";

export interface DraftFile {
  /** 編集の土台にした生テキスト（土台が更新されても、この土台に対する差分として復元できる） */
  baseText: string;
  baseCommitId: string | null;
  rows: MasterRow[];
  nextId: number;
}

export interface MasterDraft {
  version: 1;
  savedAt: string;
  files: Partial<Record<MasterFileId, DraftFile>>;
}

/** 編集のあるファイルだけを下書きにする（編集が無ければ null = 下書きを消す） */
export function makeDraft(docs: Record<MasterFileId, MasterDoc>, bases: Record<MasterFileId, { text: string; lastCommitId: string | null }>, savedAt: string): MasterDraft | null {
  const files: MasterDraft["files"] = {};
  let any = false;
  for (const id of MASTER_FILE_IDS) {
    const doc = docs[id];
    if (diffMasterDoc(doc).count === 0) continue;
    any = true;
    files[id] = { baseText: bases[id].text, baseCommitId: bases[id].lastCommitId, rows: doc.rows.map((r) => ({ id: r.id, cells: r.cells.slice() })), nextId: doc.nextId };
  }
  return any ? { version: 1, savedAt, files } : null;
}

/** 下書きの JSON を読む（壊れていれば null） */
export function parseDraft(json: string | null): MasterDraft | null {
  if (!json) return null;
  try {
    const d = JSON.parse(json) as MasterDraft;
    if (!d || d.version !== 1 || typeof d.files !== "object" || d.files === null) return null;
    for (const id of Object.keys(d.files)) {
      if (!MASTER_FILE_IDS.includes(id as MasterFileId)) return null;
      const f = d.files[id as MasterFileId];
      if (!f || typeof f.baseText !== "string" || !Array.isArray(f.rows)) return null;
      if (!f.rows.every((r) => r && typeof r.id === "string" && Array.isArray(r.cells) && r.cells.every((c) => typeof c === "string"))) return null;
    }
    return d;
  } catch {
    return null;
  }
}

/** 下書きのファイルを文書に戻す（土台は下書きに保存した baseText） */
export function docFromDraft(fileId: MasterFileId, f: DraftFile): MasterDoc {
  const base = parseMasterDoc(fileId, f.baseText);
  const width = base.header.length;
  return { ...base, rows: f.rows.map((r) => ({ id: r.id, cells: padCells(r.cells, width) })), nextId: Math.max(1, Number(f.nextId) || 1) };
}

/** 下書きの土台が今のビルドと違うファイル（他の人が先に更新した） */
export function staleDraftFiles(draft: MasterDraft, bases: Record<MasterFileId, { text: string; lastCommitId: string | null }>): MasterFileId[] {
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
