/**
 * CSV で直接編集（SPEC §25）: 書き換えた CSV テキスト（または Excel から貼り付けたタブ区切り）を、
 * 表で編集したときと同じ文書（MasterDoc）に取り込む。純粋関数。
 *
 * 元ファイルの行との対応付けは下書きの当て直し（§19.2）と同じ考え方:
 *  1. 内容（trim した値）が同じ行を、順序を保って最長一致で元の行に対応させる（変更なし。元のテキストのまま書き戻す）
 *  2. 対応しなかった行は、キー列（と適用開始月／開始月）が同じ元の行と順に対にする（変更）
 *  3. 残りは追加。どの行とも対にならなかった元の行は削除
 */
import { MASTER_FILES, STAMPED_FILES, STAMP_COLUMNS, alignRows, withStampColumns, type MasterDoc, type MasterRow } from "./masterEdit.js";
import { T, fmt } from "../i18n/index.js";

export interface CsvParseError {
  /** 何行目（1 始まり、テキストの物理行）。行に結び付かないエラーは null */
  line: number | null;
  message: string;
}

export interface CsvTable {
  header: string[];
  rows: string[][];
  delimiter: "," | "\t";
}

/**
 * CSV / TSV を表に分ける（引用符 "…"・"" のエスケープ・セル内の改行に対応）。
 * 1 行目（見出し）にタブがあればタブ区切り（Excel からの貼り付け）。閉じていない引用符はエラー
 */
export function parseCsvOrTsv(text: string): { table: CsvTable | null; errors: CsvParseError[] } {
  let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  src = src.replace(/\r\n?/g, "\n");
  const firstLine = src.split("\n", 1)[0] ?? "";
  const delimiter: "," | "\t" = firstLine.includes("\t") ? "\t" : ",";
  const records: string[][] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let quoteLine = 0;
  let line = 1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === "") {
      inQuotes = true;
      quoteLine = line;
      cell = "";
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
    } else if (ch === "\n") {
      cells.push(cell);
      records.push(cells);
      cells = [];
      cell = "";
      line++;
    } else cell += ch;
  }
  if (inQuotes) return { table: null, errors: [{ line: quoteLine, message: T.csvEdit.unclosedQuote }] };
  cells.push(cell);
  records.push(cells);
  const nonBlank = records.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonBlank.length === 0) return { table: null, errors: [{ line: null, message: T.csvEdit.empty }] };
  const [head, ...rows] = nonBlank as [string[], ...string[][]];
  return { table: { header: head.map((h) => h.trim()), rows, delimiter }, errors: [] };
}

export interface CsvImportResult {
  doc: MasterDoc | null;
  errors: CsvParseError[];
  /** 取り込み前の文書と比べた件数（元ファイルに対する差分ではない） */
  stats: { added: number; changed: number; removed: number; unchanged: number };
  delimiter: "," | "\t";
}

function sameCells(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * 書き換えた CSV を文書に取り込む。見出しは doc と同じ列名の集合でなければならない（順序は自由）。
 * 戻り値の doc は元ファイル（doc.originals）に対する行 id を保つので、差分・影響月・下書きはそのまま使える
 */
export function docFromCsvText(source: MasterDoc, text: string): CsvImportResult {
  const empty = { added: 0, changed: 0, removed: 0, unchanged: 0 };
  const parsed = parseCsvOrTsv(text);
  if (!parsed.table) return { doc: null, errors: parsed.errors, stats: empty, delimiter: "," };
  const { header, rows, delimiter } = parsed.table;
  // 変更者・変更日の列（§56）が貼り付けた側にだけあれば（このアプリのダウンロードなど）、文書の見出しに足して受け入れる
  const stamped = STAMPED_FILES.includes(source.fileId);
  const doc = stamped && [STAMP_COLUMNS.by, STAMP_COLUMNS.at].some((c) => header.includes(c) && !source.header.includes(c)) ? withStampColumns(source) : source;
  const errors: CsvParseError[] = [];
  const seen = new Set<string>();
  const dup = header.filter((h) => (seen.has(h) ? true : (seen.add(h), false)));
  const unknown = header.filter((h) => h !== "" && !doc.header.includes(h));
  // 変更者・変更日の列（§56）は無くてもよい（Excel で列を消して貼っても通す）。元の行の値を引き継ぐ
  const carried = stamped ? [STAMP_COLUMNS.by, STAMP_COLUMNS.at].filter((c) => doc.header.includes(c) && !header.includes(c)) : [];
  const missing = doc.header.filter((h) => !header.includes(h) && !(carried as string[]).includes(h));
  if (dup.length) errors.push({ line: 1, message: fmt(T.csvEdit.duplicateColumns, { cols: [...new Set(dup)].join(", ") }) });
  if (unknown.length) errors.push({ line: 1, message: fmt(T.csvEdit.unknownColumns, { cols: unknown.join(", ") }) });
  if (missing.length) errors.push({ line: 1, message: fmt(T.csvEdit.missingColumns, { cols: missing.join(", ") }) });
  if (header.includes("")) errors.push({ line: 1, message: T.csvEdit.blankColumn });
  if (errors.length) return { doc: null, errors, stats: empty, delimiter };

  const width = doc.header.length;
  const at = doc.header.map((h) => header.indexOf(h));
  const extraWidth = (cells: readonly string[]) => Math.max(0, cells.length - header.length);
  const newCells = rows.map((r) => {
    const out = at.map((j) => r[j] ?? "");
    // 見出しより多いセルは元の行と同じく後ろに残す（検証で列数の誤りとして出る）
    for (let k = 0; k < extraWidth(r); k++) out.push(r[header.length + k] ?? "");
    return out;
  });

  const def = MASTER_FILES[doc.fileId];
  const skip = new Set(carried.map((c) => doc.header.indexOf(c)));
  const sig = (cells: readonly string[]) => doc.header.map((_, i) => (skip.has(i) ? "" : (cells[i] ?? "").trim())).join("\u0001");
  const originals = Object.entries(doc.originals).sort((a, b) => a[1].index - b[1].index);
  const map = alignRows(newCells.map(sig), originals.map(([, o]) => sig(o.cells)));
  const keyIdx = def.keyColumns.map((k) => doc.header.indexOf(k));
  const timeIdx = doc.header.indexOf(def.history === "effective" ? "effective_from" : "start_month");
  const keyOf = (cells: readonly string[]) => keyIdx.map((i) => (cells[i] ?? "").trim()).join("|");
  const timeOf = (cells: readonly string[]) => (timeIdx < 0 ? "" : (cells[timeIdx] ?? "").trim());
  const used = new Set<number>(map.filter((j) => j >= 0));
  const pair = new Array<number>(newCells.length).fill(-1);
  for (const strict of [true, false]) {
    for (let i = 0; i < newCells.length; i++) {
      if ((map[i] as number) >= 0 || (pair[i] as number) >= 0) continue;
      const c = newCells[i] as string[];
      for (let j = 0; j < originals.length; j++) {
        if (used.has(j)) continue;
        const o = (originals[j] as [string, MasterDoc["originals"][string]])[1].cells;
        if (keyOf(c) !== keyOf(o) || (strict && timeOf(c) !== timeOf(o))) continue;
        pair[i] = j;
        used.add(j);
        break;
      }
    }
  }

  let nextId = doc.nextId;
  const before = new Map(doc.rows.map((r) => [r.id, r.cells]));
  // すでに追加してあった行（元ファイルに無い行）は、同じ内容なら同じ id のままにする
  const addedBySig = new Map<string, string[]>();
  for (const r of doc.rows) {
    if (doc.originals[r.id]) continue;
    const k = sig(r.cells);
    addedBySig.set(k, [...(addedBySig.get(k) ?? []), r.id]);
  }
  const outRows: MasterRow[] = newCells.map((cells, i) => {
    const j = (map[i] as number) >= 0 ? (map[i] as number) : (pair[i] as number);
    if (j >= 0) {
      const [id, o] = originals[j] as [string, MasterDoc["originals"][string]];
      // 内容が同じなら元のセル（空白・引用符の付け方も元のまま書き戻す）
      if (sig(cells) === sig(o.cells)) return { id, cells: o.cells.slice() };
      const out = cells.length < width ? [...cells, ...new Array(width - cells.length).fill("")] : cells.slice();
      for (const i of skip) out[i] = o.cells[i] ?? "";
      return { id, cells: out };
    }
    const reuse = addedBySig.get(sig(cells))?.shift();
    return { id: reuse ?? `n${nextId++}`, cells };
  });
  // 前の文書（取り込み前）と比べた件数
  const stats = { added: 0, changed: 0, removed: 0, unchanged: 0 };
  const present = new Set<string>();
  for (const r of outRows) {
    present.add(r.id);
    const prev = before.get(r.id);
    if (!prev) stats.added++;
    else if (sig(prev) === sig(r.cells) && sameCells(prev.slice(width), r.cells.slice(width))) stats.unchanged++;
    else stats.changed++;
  }
  for (const r of doc.rows) if (!present.has(r.id)) stats.removed++;
  return { doc: { ...doc, rows: outRows, nextId }, errors: [], stats, delimiter };
}
