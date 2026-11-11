/**
 * 一覧表: 並べ替え（aria-sort）・固定ヘッダ・右寄せ数値・状態チップ・行クリック・Excel 出力・木構造（チーム一覧）
 *
 * dataTable({
 *   columns: [{ key, label, type: "text"|"money"|"moneyYen"（明細: 常に円）|"percent"|"hours"|"int"|"status"|"custom",
 *               get(row), render?(row) -> Node|string, sortValue?(row), exportValue?(row), exportLabel?,
 *               breakdown?(row) -> spec, align?: "num"|"text", sortable?: boolean, width?, hideOnPhone?: boolean, hideMid?: boolean（ノート PC の狭い幅で隠す）,
 *               summaryDash?: 合計行に値が無い（null）とき空欄でなく「—」を出す（「該当なし」を明示したい列）,
 *               optional?: 選べる列（既定では出さず「列」でチェックしたときだけ出す。§106.1）, exportAlways?: 画面で隠していても Excel に出す,
 *               exportOnly?: Excel だけの列（ID など。画面の「列」にも出さない）,
 *               sublabel?: 見出しの 2 行目（母集団の注記など。幅を増やさずに補足する）,
 *               filter?: "values"|"range"|"date"|false（見出しの絞り込み。既定は数値列 range、値がすべて年月・日付の列 date、それ以外 values）, filterValue?(row) -> string|string[],
 *               dateValue?(row) -> "YYYY-MM"|"YYYY-MM-DD"|[from, to]（日付の絞り込みに使う値。期間の列は [開始, 終了] で、重なれば残す）,
 *               rangeUnit?: 範囲の絞り込みの単位の表示（既定は型から。リソース計画の「人月」など） }],
 *   rows, rowKey(row), unit, sort: {key, dir}, rowHref?(row), caption, exportName, emptyText,
 *   tree?: boolean（rows に key/parentKey/depth/hasChildren を持たせる。並べ替えは無効。絞り込みは一致行＋その親を残す）,
 *   summary?: row | (shownRows) => row（tfoot の合計行。関数なら列の絞り込み後の行で作り直す。
 *             固定の row は絞り込み中は出さない）, summaryBreakdown?(col, summaryRow) -> spec（合計行の根拠。無ければ合計行はプレーン表示）,
 *   filter?: false（列ごとの絞り込みを付けない）,
 *   maxHeight?: px, toolbar?: Node
 * })
 * 列の表示・並び順: caption があり列が 3 つ以上なら、ツールバーの「列」で利用者が変えられる（先頭の列は固定。§106）。
 * 文字の列（type "text"、文字だけのセル）は上限の幅で「…」にし、全文を title に出す。
 * Excel 出力: 金額は単位に関係なく常に円の整数（列名「…（円）」、1 行目に「単位: 円」の注記）。
 */
import { bindColResizer } from "./col-resize.js";
import { arrangeColumns, columnsButton, loadColumnPrefs, orderColumns } from "./column-prefs.js";
import { h } from "./dom.js";
import { html } from "htl";
import { EMPTY_VALUE, decimal, formatHours, formatPercent, integer, money, periodCompact } from "./format.js";
import { numberButton } from "./breakdown.js";
import { statusChip } from "./kpi.js";
import { onTextInput } from "./text-input.js";
import { T, fmt } from "../i18n/index.js";

const NUMERIC_TYPES = new Set(["money", "moneyYen", "percent", "hours", "int"]);

/**
 * 明細の金額列は type "moneyYen"（SPEC §12: 選択単位に関係なく常に円。見出しに「（円）」を付ける）。
 * 集計行・KPI は従来どおり type "money"（選択単位に従う）。
 */
function headLabel(col) {
  return col.type === "moneyYen" ? fmt(T.table.exportYen, { label: col.label }) : col.label;
}

function isNumeric(col) {
  return col.align === "num" || NUMERIC_TYPES.has(col.type);
}

function defaultRender(col, row, unit) {
  const v = col.get ? col.get(row) : row[col.key];
  switch (col.type) {
    case "money":
      return money(v, unit);
    case "moneyYen":
      return money(v, "yen");
    case "percent":
      return formatPercent(v);
    case "hours":
      return formatHours(v);
    case "int":
      return integer(v);
    case "status": {
      if (!v) return "";
      const list = Array.isArray(v) ? v : [v];
      return h("span", { class: "yn-chip-row" }, list.map((s) => statusChip(s.kind, s.text, s.title ?? null)));
    }
    default:
      return v === null || v === undefined || v === "" ? (col.empty ?? EMPTY_VALUE) : String(v);
  }
}

function defaultExport(col, row, unit) {
  const v = col.get ? col.get(row) : row[col.key];
  switch (col.type) {
    case "money":
    case "moneyYen":
      return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
    case "percent":
      return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) / 10 : null;
    case "hours":
    case "int":
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    case "status":
      return v ? (Array.isArray(v) ? v.map((s) => s.text).join("・") : v.text) : "";
    default:
      return v === null || v === undefined ? "" : typeof v === "object" ? String(v.text ?? "") : v;
  }
}

function exportLabel(col, unit) {
  if (col.exportLabel) return col.exportLabel;
  switch (col.type) {
    case "money":
    case "moneyYen":
      return fmt(T.table.exportYen, { label: col.label });
    case "percent":
      return fmt(T.table.exportPercent, { label: col.label });
    case "hours":
      return fmt(T.table.exportHours, { label: col.label });
    default:
      return col.label;
  }
}

function cssEscape(s) {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&");
}

function focusIn(rootEl, selector) {
  const el = rootEl.querySelector(selector);
  if (el) el.focus();
}

function sortValue(col, row) {
  if (col.sortValue) return col.sortValue(row);
  const v = col.get ? col.get(row) : row[col.key];
  if (Array.isArray(v)) return v.map((s) => s.text).join("・");
  if (v && typeof v === "object" && "text" in v) return v.text;
  return v;
}

function compare(a, b, dir) {
  const an = a === null || a === undefined || (typeof a === "number" && Number.isNaN(a));
  const bn = b === null || b === undefined || (typeof b === "number" && Number.isNaN(b));
  if (an && bn) return 0;
  if (an) return 1; // 空は常に末尾
  if (bn) return -1;
  let r;
  if (typeof a === "number" && typeof b === "number") r = a - b;
  else r = String(a).localeCompare(String(b), "ja");
  return dir === "desc" ? -r : r;
}

/** 金額列の入力値（表示単位）→ 円 の倍率。割合は % で入力する */
function rangeFactor(col, unit) {
  if (col.type === "money") return unit === "m" ? 1e6 : unit === "k" ? 1e3 : 1;
  if (col.type === "percent") return 0.01;
  return 1;
}

function rangeUnitLabel(col, unit) {
  if (col.rangeUnit) return col.rangeUnit;
  if (col.type === "money") return T.format.units[unit] ?? T.format.units.yen;
  if (col.type === "moneyYen") return T.format.units.yen;
  if (col.type === "percent") return "%";
  if (col.type === "hours") return "h";
  return "";
}

/** 絞り込みの種類。右寄せでも値が文字の列（単価の「6,000円 / 7,000円」など）は値の一覧にする */
function filterKind(col, rows = null) {
  if (col.filter === false) return null;
  if (col.filter === "values" || col.filter === "range" || col.filter === "date") return col.filter;
  if (NUMERIC_TYPES.has(col.type)) return "range";
  if (isNumeric(col) && (!rows || rows.some((r) => rangeValue(col, r) !== null))) return "range";
  if (col.dateValue) return "date";
  if (rows && isDateColumn(col, rows)) return "date";
  return "values";
}

// ---- 日付・年月の列の絞り込み（以降〜以前。年・年月・日のどれでも入れられる。SPEC §109） ----
const DATE_RE = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/;

/** 列の日付の値（"YYYY-MM" | "YYYY-MM-DD" | [開始, 終了]）。無ければ null */
function dateRaw(col, row) {
  const v = col.dateValue ? col.dateValue(row) : col.get ? col.get(row) : row[col.key];
  if (Array.isArray(v)) return v.some((x) => typeof x === "string" && DATE_RE.test(x)) ? v : null;
  return typeof v === "string" && DATE_RE.test(v) ? v : null;
}

/** 値のある行がすべて年月・日付の列（作業日・月・初回日など）。文字の列でも日付の絞り込みにする */
function isDateColumn(col, rows) {
  let seen = false;
  for (const r of rows) {
    const v = col.get ? col.get(r) : r[col.key];
    if (v === null || v === undefined || v === "") continue;
    if (typeof v !== "string" || !DATE_RE.test(v)) return false;
    seen = true;
  }
  return seen;
}

/** "YYYY" | "YYYY-MM" | "YYYY-MM-DD" の始まり（from）・終わり（to）の日。文字の比較で前後が分かる形 */
function dateBound(s, edge) {
  if (typeof s !== "string" || s === "") return null;
  const [y, m, d] = s.split("-");
  if (d) return s;
  if (m) return `${y}-${m}-${edge === "from" ? "01" : "31"}`;
  return `${y}-${edge === "from" ? "01-01" : "12-31"}`;
}

/**
 * 絞り込みの入力（年・年月・日）を "YYYY" | "YYYY-MM" | "YYYY-MM-DD" に揃える。空は null、読めないときは undefined。
 * 2026 / 2026年 / 2026-4 / 2026/04 / 2026年4月 / 202604 / 2026-04-15 / 2026/4/15 / 2026年4月15日 / 20260415
 */
export function parseDateFilterInput(text) {
  const t = String(text ?? "").normalize("NFKC").replace(/\s+/g, "");
  if (t === "") return null;
  const pad = (n) => String(n).padStart(2, "0");
  let m = t.match(/^(\d{4})年?$/);
  if (m) return m[1];
  m = t.match(/^(\d{4})[-/.年](\d{1,2})月?$/) ?? t.match(/^(\d{4})(\d{2})$/);
  if (m) {
    const mo = Number(m[2]);
    return mo >= 1 && mo <= 12 ? `${m[1]}-${pad(mo)}` : undefined;
  }
  m = t.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/) ?? t.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return mo >= 1 && mo <= 12 && d >= 1 && d <= last ? `${m[1]}-${pad(mo)}-${pad(d)}` : undefined;
  }
  return undefined;
}

/** 行の日付の範囲 [最初の日, 最後の日]。期間の列で終了が空なら先は無限 */
function dateSpan(col, row) {
  const v = dateRaw(col, row);
  if (v === null) return null;
  if (Array.isArray(v)) {
    const [a, b] = v;
    const lo = typeof a === "string" && DATE_RE.test(a) ? dateBound(a, "from") : "0000-01-01";
    const hi = typeof b === "string" && DATE_RE.test(b) ? dateBound(b, "to") : "9999-12-31";
    return [lo, hi];
  }
  return [dateBound(v, "from"), dateBound(v, "to")];
}

/** 列の値に出てくる年（新しい順の候補にする） */
function dateYears(col, rows) {
  const ys = new Set();
  for (const r of rows) {
    const v = dateRaw(col, r);
    if (v === null) continue;
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string" && DATE_RE.test(x)) ys.add(x.slice(0, 4));
  }
  return [...ys].sort();
}

/** 絞り込みの値（文字）。空は "" */
function filterValues(col, row, unit) {
  let v;
  if (col.filterValue) v = col.filterValue(row);
  else if (col.type === "status") {
    const s = col.get ? col.get(row) : row[col.key];
    const list = s ? (Array.isArray(s) ? s : [s]).map((x) => x.text) : [];
    v = list.length ? list : ""; // 印が無い行は（空白）として選べるように
  } else if (col.exportValue) v = col.exportValue(row, unit);
  else if (col.render) v = plainText(col.render(row, col.type === "moneyYen" ? "yen" : unit));
  else v = defaultExport(col, row, unit);
  const list = Array.isArray(v) ? v : [v];
  return list.map((x) => (x === null || x === undefined || x === EMPTY_VALUE ? "" : String(x).trim()));
}

function rangeValue(col, row) {
  const v = col.get ? col.get(row) : row[col.key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 検索語の比較（全角・半角、大文字・小文字を揃える） */
function norm(s) {
  return String(s).normalize("NFKC").toLowerCase();
}

/** 読み上げ用の値の文字（記号や色付きの要素で包まれていても、見えている文字を使う） */
function plainText(text) {
  if (typeof text === "string") return text;
  if (typeof Node === "undefined" || !(text instanceof Node)) return text === null || text === undefined ? "" : String(text);
  const clone = text.cloneNode(true);
  if (clone instanceof Element) for (const h of clone.querySelectorAll('[aria-hidden="true"]')) h.remove();
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** 1 行が列の絞り込みを満たすか。f = {q, values} | {min, max}（min/max は円・比率などの元の値） | {from, to}（"YYYY"・"YYYY-MM"・"YYYY-MM-DD"） */
export function matchesFilter(col, f, row, unit) {
  if (!f) return true;
  if ("from" in f || "to" in f) {
    const span = dateSpan(col, row);
    if (span === null) return false;
    // 年・年月で入れたら、その年・月を丸ごと含める（以降はその始まりから、以前はその終わりまで）。期間の列は重なれば残す
    const from = dateBound(f.from, "from");
    const to = dateBound(f.to, "to");
    if (from && span[1] < from) return false;
    if (to && span[0] > to) return false;
    return true;
  }
  if ("min" in f || "max" in f) {
    const v = rangeValue(col, row);
    if (v === null) return false;
    // 表示と同じ丸めで比べると端の値が漏れるので、元の値で比べる
    if (typeof f.min === "number" && v < f.min) return false;
    if (typeof f.max === "number" && v > f.max) return false;
    return true;
  }
  const vals = filterValues(col, row, unit);
  if (f.q) {
    const q = norm(f.q);
    if (!vals.some((v) => norm(v).includes(q))) return false;
  }
  if (Array.isArray(f.values)) {
    const set = new Set(f.values);
    if (!vals.some((v) => set.has(v))) return false;
  }
  return true;
}

export function isActiveFilter(f) {
  return !!f && ((typeof f.q === "string" && f.q !== "") || Array.isArray(f.values) || typeof f.min === "number" || typeof f.max === "number" || (typeof f.from === "string" && f.from !== "") || (typeof f.to === "string" && f.to !== ""));
}

export const FILTER_ICON = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M1 1.5h10L7.2 6.2V10L4.8 11V6.2Z" fill="currentColor"/></svg>';

let filterPopSeq = 0;

const COL_W_MIN = 40;
const COL_W_MAX = 640;
const COL_LEAD_VW = 60;
function clampColW(w) {
  if (!Number.isFinite(w)) return null;
  return Math.round(Math.min(COL_W_MAX, Math.max(COL_W_MIN, w)));
}

/**
 * 木構造の表の絞り込み: 一致した行と、その祖先（親子の位置を保つ）を元の並びのまま残す。
 * onKeys(一致した key の集合, 残った子を持つ key の集合)
 */
export function treeFilteredRows(rows, matched, onKeys = () => {}) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const keys = new Set(matched.map((r) => r.key));
  const keep = new Set(keys);
  const parents = new Set();
  for (const r of matched) {
    let p = r.parentKey;
    while (p !== null && p !== undefined && byKey.has(p)) {
      parents.add(p);
      keep.add(p);
      p = byKey.get(p)?.parentKey ?? null;
    }
  }
  onKeys(keys, parents);
  return rows.filter((r) => keep.has(r.key));
}

/** ファイル名に使えない文字を _ に（契約IDがそのまま入るため） */
export function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "export";
}

export const EXPORT_UNIT_NOTE = T.table.exportUnitNote;

/** 現在の表示（並べ替え・絞り込み後）を .xlsx で保存。金額は常に円の整数 */
export async function exportXlsx({ columns, rows, unit = "yen", name = "export", sheet = "Sheet1", summary = null }) {
  const XLSX = await import("xlsx");
  const header = columns.map((c) => exportLabel(c, unit));
  const valueOf = (c, r) => (c.exportValue ? c.exportValue(r, unit) : defaultExport(c, r, unit));
  const body = rows.map((r) => columns.map((c) => valueOf(c, r)));
  // 画面の合計行（tfoot）と同じ列だけ値を入れる
  if (summary) {
    body.push(columns.map((c, ci) => {
      if (ci === 0) return summary.name ?? T.table.total;
      const has = summary[c.key] !== undefined && summary[c.key] !== null;
      if (c.summary === false || (!has && (!isNumeric(c) || !c.get))) return null;
      try {
        return valueOf(c, summary);
      } catch {
        return null; // 行専用の exportValue（ID など）は合計行では空にする
      }
    }));
  }
  const ws = XLSX.utils.aoa_to_sheet([[EXPORT_UNIT_NOTE], header, ...body]);
  ws["!cols"] = columns.map((c) => ({ wch: Math.max(10, Math.min(40, String(exportLabel(c, unit)).length * 2)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, safeFileName(sheet).slice(0, 31));
  XLSX.writeFile(wb, `${safeFileName(name)}.xlsx`);
}

export function exportButton(getPayload, label = T.table.exportButton) {
  const btn = html`<button type="button" class="yn-btn yn-btn-sm yn-export"><span aria-hidden="true">⤓</span> ${label}</button>`;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await exportXlsx(getPayload());
    } catch (error) {
      console.error(error);
      alert(fmt(T.table.exportFailed, { error: error?.message ?? error }));
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

export function dataTable({
  columns,
  rows,
  rowKey = (r, i) => r.key ?? r.id ?? i,
  unit = "yen",
  sort = null,
  rowHref = null,
  caption = null,
  exportName = null,
  emptyText = T.table.empty,
  tree = false,
  summary = null,
  summaryBreakdown = null,
  maxHeight = null,
  toolbar = null,
  id = null,
  filter = true,
}) {
  const baseCols = columns.filter((c) => !c.hidden && !c.exportOnly);
  // 列の表示・並び順（§106）。先頭（名前）の列は固定。画面と表ごとにこのブラウザに覚える
  const colPrefsId = caption && baseCols.length >= 3 ? `${location.pathname}:${caption}` : null;
  let colPrefs = colPrefsId ? loadColumnPrefs(colPrefsId) : { order: [], hidden: [], shown: [] };
  // 選べる列（optional）は「列」でチェックしたときだけ出す。「列」が無い表では出さない
  const arrange = (cols) => {
    if (!colPrefsId || cols.length === 0) return cols.filter((c) => !c.optional);
    const lead = cols[0] === baseCols[0] ? [cols[0]] : [];
    return [...lead, ...arrangeColumns(cols.slice(lead.length), colPrefs)];
  };
  let visibleCols = arrange(baseCols);
  // Excel も画面の列の並び・表示に合わせる。Excel だけの列（exportOnly）と exportAlways の列は画面で隠していても出す
  const exportColsNow = () => {
    const all = columns.filter((c) => !c.hidden && c.export !== false);
    const lead = colPrefsId && all[0] === baseCols[0] ? [all[0]] : [];
    const ordered = colPrefsId ? [...lead, ...orderColumns(all.slice(lead.length), colPrefs)] : all;
    const shown = new Set(visibleCols);
    return ordered.filter((c) => c.exportOnly || c.exportAlways || shown.has(c));
  };
  // 利用者が選んだ並べ替えは、絞り込み・単位の変更で表が作り直されても、詳細から戻っても残す（タブ単位）
  const sortMemoKey = !tree && caption ? `yojitsu-navi:sort:${location.pathname}:${caption}` : null;
  const remembered = (() => {
    try {
      const v = sortMemoKey ? JSON.parse(sessionStorage.getItem(sortMemoKey) ?? "null") : null;
      return v && columns.some((c) => c.key === v.key) && (v.dir === "asc" || v.dir === "desc") ? v : null;
    } catch {
      return null;
    }
  })();
  // 利用者が選んだ並べ替えの列を隠したら、既定の並びに戻す
  let sortState = tree ? null : (remembered && visibleCols.some((c) => c.key === remembered.key) ? remembered : null) ?? (sort ? { ...sort } : null);
  const collapsed = new Set();
  let currentRows = rows;

  // 列ごとの絞り込み（SPEC §70）。並べ替えと同じくタブ単位で覚える。
  // 木構造の表は一致した行とその親（親子の位置を保つための行。薄く出す）を残す
  const filterable = filter !== false && rows.length > 0;
  const filterMemoKey = filterable && caption ? `yojitsu-navi:filter:${location.pathname}:${caption}` : null;
  /** @type {Map<string, any>} 列 key → {q, values} | {min, max} | {from, to} */
  const filters = new Map();
  if (filterMemoKey) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(filterMemoKey) ?? "null");
      for (const [key, f] of Object.entries(saved ?? {})) {
        const col = visibleCols.find((c) => c.key === key && filterKind(c));
        if (!col || !isActiveFilter(f)) continue;
        if (Array.isArray(f.values) && f.values.length > 0) {
          // 別の案件などで覚えた値のうち、この表に無いものは捨てる（全部無ければ絞り込みごと捨てる）。
          // 全部外した（空の）選択は利用者の意図なのでそのまま残す
          const present = new Set(rows.flatMap((r) => filterValues(col, r, unit)));
          const values = f.values.filter((v) => present.has(v));
          if (values.length === 0) continue;
          filters.set(key, { ...f, values });
        } else filters.set(key, f);
      }
    } catch {
      /* プライベートモード等では無視 */
    }
  }
  const saveFilters = () => {
    try {
      if (filterMemoKey) sessionStorage.setItem(filterMemoKey, JSON.stringify(Object.fromEntries(filters)));
    } catch {
      /* 無視 */
    }
  };
  const activeFilters = () => [...filters].filter(([, f]) => isActiveFilter(f));
  /** 絞り込みに一致した行（木構造の表で、親として残すだけの行と区別する） */
  let matchedKeys = null;
  /** 木構造の表で、絞り込み後も子が残っている行（開閉ボタンを出す行） */
  let parentsShown = null;
  function filteredRows() {
    const act = activeFilters();
    matchedKeys = null;
    parentsShown = null;
    if (act.length === 0) return rows;
    const cols = act.map(([key, f]) => [visibleCols.find((c) => c.key === key), f]).filter(([c]) => c);
    const matched = rows.filter((r) => cols.every(([c, f]) => matchesFilter(c, f, r, unit)));
    if (!tree) return matched;
    return treeFilteredRows(rows, matched, (keys, parents) => {
      matchedKeys = keys;
      parentsShown = parents;
    });
  }

  // 列幅（見出しの右端をドラッグ。マスタ編集と同じ部品。§77）。画面と表ごとにこのブラウザに覚える
  const colWKey = caption ? `yojitsu-navi:col-width:${location.pathname}:${caption}` : null;
  /** @type {Record<string, number>} 列 key → px */
  const colW = (() => {
    try {
      const saved = colWKey ? JSON.parse(localStorage.getItem(colWKey) ?? "null") : null;
      if (!saved || typeof saved !== "object") return {};
      return Object.fromEntries(
        Object.entries(saved)
          .filter(([k]) => baseCols.some((c) => c.key === k))
          .map(([k, v]) => [k, clampColW(Number(v))])
          .filter(([, v]) => v !== null),
      );
    } catch {
      return {};
    }
  })();
  const saveColW = () => {
    try {
      if (!colWKey) return;
      if (Object.keys(colW).length) localStorage.setItem(colWKey, JSON.stringify(colW));
      else localStorage.removeItem(colWKey);
    } catch {
      /* 無視 */
    }
  };
  /** 1 列の幅を決める（null = 既定）。入りきらない中身は「…」で切る。先頭（名前）の列は左に貼り付くので表示幅の 6 割まで */
  function sizeColumn(index, w) {
    const n = visibleCols.length;
    const v = w === null || w === undefined ? "" : index === 0 ? `min(${w}px, ${COL_LEAD_VW}vw)` : `${w}px`;
    for (const tr of table.rows) {
      if (tr.cells.length !== n) continue;
      const c = tr.cells[index];
      c.classList.toggle("is-col-sized", v !== "");
      c.style.width = v;
      c.style.minWidth = v;
      c.style.maxWidth = v;
    }
  }
  function applyColWidths() {
    visibleCols.forEach((col, i) => {
      if (colW[col.key] !== undefined) sizeColumn(i, colW[col.key]);
    });
  }
  function colResizer(col, index) {
    const name = fmt(T.masters.colResize, { col: col.label });
    const handle = html`<span class="yn-col-resizer" role="separator" aria-orientation="vertical" tabindex="0" aria-label=${name} title=${name} aria-valuemin=${COL_W_MIN} aria-valuemax=${COL_W_MAX}></span>`;
    handle.dataset.col = col.key;
    if (colW[col.key] !== undefined) handle.setAttribute("aria-valuenow", String(colW[col.key]));
    const current = () => Math.round(handle.closest("th").getBoundingClientRect().width);
    const maxNow = () => (index === 0 ? Math.max(COL_W_MIN, Math.min(COL_W_MAX, Math.floor((window.innerWidth * COL_LEAD_VW) / 100))) : COL_W_MAX);
    bindColResizer(handle, current, (w, save) => {
      const v = w === null ? null : clampColW(Math.min(w, maxNow()));
      if (v === null) delete colW[col.key];
      else colW[col.key] = v;
      sizeColumn(index, v);
      if (v === null) handle.removeAttribute("aria-valuenow");
      else handle.setAttribute("aria-valuenow", String(v));
      if (save) saveColW();
    });
    return handle;
  }

  const table = html`<table class="yn-table" id=${id}>${caption ? html`<caption class="visually-hidden">${caption}</caption>` : null}</table>`;
  const thead = html`<thead></thead>`;
  const tbody = html`<tbody></tbody>`;
  table.append(thead, tbody);

  function orderedRows() {
    if (tree) {
      // 折りたたみ: 祖先が collapsed なら非表示
      const byKey = new Map(rows.map((r) => [r.key, r]));
      return filteredRows().filter((r) => {
        let p = r.parentKey;
        while (p !== null && p !== undefined) {
          if (collapsed.has(p)) return false;
          p = byKey.get(p)?.parentKey ?? null;
        }
        return true;
      });
    }
    const base = filteredRows();
    if (!sortState) return base;
    const col = columns.find((c) => c.key === sortState.key);
    if (!col) return base;
    return base
      .map((r, i) => ({ r, i, v: sortValue(col, r) }))
      .sort((a, b) => compare(a.v, b.v, sortState.dir) || a.i - b.i)
      .map((x) => x.r);
  }

  const filterButtons = new Map();
  function renderHead() {
    closeFilterPop();
    filterButtons.clear();
    thead.replaceChildren(
      html`<tr>${visibleCols.map((col) => {
        const numeric = isNumeric(col);
        const sortable = !tree && col.sortable !== false;
        const active = sortState && sortState.key === col.key;
        const th = html`<th scope="col" class=${`${numeric ? "num" : ""}${col.hideOnPhone ? " hide-phone" : ""}${col.hideNarrow ? " hide-narrow" : ""}${col.hideMid ? " hide-mid" : ""}`} style=${col.width ? `width:${col.width}` : null} data-key=${col.key} aria-sort=${active ? (sortState.dir === "asc" ? "ascending" : "descending") : sortable ? "none" : null}></th>`;
        if (sortable) {
          const btn = html`<button type="button" class="yn-sort" title=${fmt(T.table.sortBy, { label: col.label })}>${headLabel(col)}<span class="yn-sort-icon" aria-hidden="true">${active ? (sortState.dir === "asc" ? "▲" : "▼") : "⇅"}</span>${col.sublabel ? html`<span class="yn-th-sub">${col.sublabel}</span>` : null}</button>`;
          btn.addEventListener("click", () => {
            const first = numeric ? "desc" : "asc";
            sortState = active ? { key: col.key, dir: sortState.dir === "asc" ? "desc" : "asc" } : { key: col.key, dir: first };
            try {
              if (sortMemoKey) sessionStorage.setItem(sortMemoKey, JSON.stringify(sortState));
            } catch {
              /* プライベートモード等では無視 */
            }
            renderHead();
            renderBody();
            // 再描画で消えたフォーカスを同じ列のボタンへ戻す（キーボード操作の継続）
            focusIn(thead, `th[data-key="${cssEscape(col.key)}"] button`);
          });
          th.append(btn);
        } else th.append(headLabel(col), col.sublabel ? html`<span class="yn-th-sub">${col.sublabel}</span>` : "");
        if (filterable && filterKind(col)) {
          const fb = html`<button type="button" class="yn-filter-btn" aria-haspopup="dialog" aria-expanded="false"></button>`;
          fb.innerHTML = FILTER_ICON;
          fb.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (filterPop.isOpenFor(col)) closeFilterPop();
            else openFilterPop(col, fb);
          });
          filterButtons.set(col.key, { btn: fb, col });
          th.classList.add("has-filter");
          // 並べ替えのボタン（または見出しの文字）と漏斗を横に並べる
          const inner = html`<div class="yn-th-inner"><span class="yn-th-main"></span></div>`;
          inner.firstChild.append(...th.childNodes);
          inner.append(fb);
          th.append(inner);
        }
        const ci = visibleCols.indexOf(col);
        th.append(colResizer(col, ci));
        // 列幅の境目は右隣の見出しにまたがるので、左の見出しほど上に重ねる（固定ヘッダの重なり順。先頭の列は横スクロールでも最前面）
        th.style.zIndex = String(ci === 0 ? visibleCols.length + 3 : visibleCols.length - ci + 1);
        return th;
      })}</tr>`,
    );
    applyColWidths();
  }

  function cellNode(col, row, isSummary = false) {
    const cellUnit = col.type === "moneyYen" ? "yen" : unit;
    const text = col.render ? col.render(row, cellUnit) : defaultRender(col, row, unit);
    if (text === EMPTY_VALUE || text === "") return text;
    if (isSummary) {
      // 合計行は行用の breakdown(row) を使わない（契約IDなどを持たないため）。summaryBreakdown(col) があればそれを開く
      const spec = summaryBreakdown ? summaryBreakdown(col, row) : null;
      return spec ? numberButton(text, spec, { ariaLabel: fmt(T.table.totalBreakdownAria, { label: col.label, value: plainText(text) }) }) : text;
    }
    if (col.breakdown) {
      const spec = () => col.breakdown(row);
      return numberButton(text, spec, { ariaLabel: fmt(T.table.cellBreakdownAria, { label: col.label, value: plainText(text) }) });
    }
    return text;
  }

  function renderRow(row, i) {
    const href = rowHref ? rowHref(row) : null;
    const danger = row.isDanger || rowDeficit(row) || row.isOverBudget;
    const context = tree && matchedKeys !== null && !matchedKeys.has(row.key);
    // 行・セルは html`` でなく直接作る（1 マスごとの HTML 解析を避ける。§107）
    const tr = h("tr", { class: `${href ? "is-clickable" : ""}${danger ? " is-danger" : ""}${tree ? ` yn-depth-${row.depth ?? 0}` : ""}${context ? " is-filter-context" : ""}`, "data-key": String(rowKey(row, i)) });
    visibleCols.forEach((col, ci) => {
      const numeric = isNumeric(col);
      const cls = `${numeric ? "num" : ""}${col.hideOnPhone ? " hide-phone" : ""}${col.hideNarrow ? " hide-narrow" : ""}${col.hideMid ? " hide-mid" : ""}${col.key === "name" || ci === 0 ? " yn-primary-cell" : ""}`;
      const cell = ci === 0 ? h("th", { scope: "row", class: cls }) : h("td", { class: cls });
      let content = cellNode(col, row);
      if (ci === 0) {
        if (tree) {
          const indent = h("span", { class: "yn-tree-indent", style: `--depth:${row.depth ?? 0}` });
          cell.append(indent);
          if (row.hasChildren && (parentsShown === null || parentsShown.has(row.key))) {
            const open = !collapsed.has(row.key);
            const toggle = h("button", { type: "button", class: "yn-tree-toggle", "aria-expanded": open ? "true" : "false", "aria-label": fmt(open ? T.table.treeClose : T.table.treeOpen, { name: row.name ?? "" }) }, h("span", { "aria-hidden": "true" }, open ? "▾" : "▸"));
            toggle.addEventListener("click", (ev) => {
              ev.stopPropagation();
              if (collapsed.has(row.key)) collapsed.delete(row.key);
              else collapsed.add(row.key);
              renderBody();
              focusIn(tbody, `tr[data-key="${cssEscape(String(row.key))}"] .yn-tree-toggle`);
            });
            cell.append(toggle);
          } else cell.append(h("span", { class: "yn-tree-toggle yn-tree-leaf", "aria-hidden": "true" }));
        }
        if (href) content = h("a", { class: "yn-row-link", href }, content);
      }
      // 文字の列（案件名・作業名など）は長くても他の列を潰さないよう上限で「…」にし、全文は title（§106）
      if (ci > 0 && typeof content === "string" && content !== EMPTY_VALUE && !numeric && (col.type === undefined || col.type === "text")) {
        cell.classList.add("yn-cell-clip");
        cell.title = content;
      }
      cell.append(content);
      if (ci === 0 && !cell.title) cell.title = cell.textContent.trim();
      tr.append(cell);
    });
    if (href) {
      tr.addEventListener("click", (ev) => {
        if (ev.defaultPrevented) return;
        if (ev.target.closest("a, button, input, select, label")) return;
        if (window.getSelection()?.toString()) return;
        location.href = href;
      });
    }
    return tr;
  }

  // 合計行。関数なら絞り込み後の行で作り直す。固定の行は絞り込み中は母集団が合わないので出さない
  let currentSummary = null;
  const tfoot = html`<tfoot></tfoot>`;
  function renderSummary() {
    const filtered = activeFilters().length > 0;
    currentSummary = typeof summary === "function" ? (currentRows.length ? summary(currentRows) : null) : filtered ? null : summary;
    if (!currentSummary) {
      tfoot.remove();
      return;
    }
    const sm = currentSummary;
    tfoot.replaceChildren(h("tr", { class: "yn-summary-row" }, visibleCols.map((col, ci) => {
      const numeric = isNumeric(col);
      const has = sm[col.key] !== undefined && sm[col.key] !== null;
      const content = ci === 0 ? (sm.name ?? T.table.total) : col.summary === false || (!numeric && !has) || (numeric && !has && !col.get) ? (col.summaryDash && numeric ? EMPTY_VALUE : "") : cellNode(col, sm, true);
      return h("td", { class: `${numeric ? "num" : ""}${col.hideOnPhone ? " hide-phone" : ""}${col.hideNarrow ? " hide-narrow" : ""}${col.hideMid ? " hide-mid" : ""}` }, content);
    })));
    if (!tfoot.isConnected) table.append(tfoot);
  }

  function renderBody() {
    currentRows = orderedRows();
    const filtered = activeFilters().length > 0;
    if (currentRows.length === 0) {
      tbody.replaceChildren(html`<tr class="yn-table-empty"><td colspan=${visibleCols.length}>${filtered && rows.length ? T.table.filterEmpty : emptyText}</td></tr>`);
    } else {
      tbody.replaceChildren(...currentRows.map(renderRow));
    }
    renderSummary();
    applyColWidths();
    if (count)
      count.textContent = tree && filtered
        ? fmt(T.table.rowCountFiltered, { shown: integer(matchedKeys?.size ?? 0), n: integer(rows.length) })
        : tree
        ? currentRows.length < rows.length
          ? fmt(T.table.rowCountTreeCollapsed, { shown: integer(currentRows.length), n: integer(rows.length) })
          : fmt(T.table.rowCountTree, { n: integer(rows.length) })
        : filtered
          ? fmt(T.table.rowCountFiltered, { shown: integer(currentRows.length), n: integer(rows.length) })
          : fmt(T.table.rowCount, { n: integer(rows.length) });
    for (const { btn, col } of filterButtons.values()) {
      const on = isActiveFilter(filters.get(col.key));
      btn.classList.toggle("is-active", on);
      btn.closest("th")?.classList.toggle("is-filtered", on);
      const label = fmt(on ? T.table.filterActive : T.table.filterBy, { label: col.label });
      btn.setAttribute("aria-label", label);
      btn.title = label;
    }
    if (clearBtn) clearBtn.hidden = !filtered;
  }

  // ── 絞り込みの吹き出し（共通の部品。マスタ編集の表でも使う） ──
  function setFilter(col, f) {
    if (isActiveFilter(f)) filters.set(col.key, f);
    else filters.delete(col.key);
    saveFilters();
    renderBody();
  }
  const filterPop = createFilterPopover({ getRows: () => rows, unit, getFilter: (key) => filters.get(key), setFilter });
  const closeFilterPop = (opts) => filterPop.close(opts);
  const openFilterPop = (col, btn) => filterPop.open(col, btn);

  renderHead();
  const count = html`<span class="yn-table-count" aria-live="polite"></span>`;
  const clearBtn = filterable ? html`<button type="button" class="yn-btn yn-btn-sm yn-filter-clear-all" hidden>${T.table.filterClearAll}</button>` : null;
  if (clearBtn)
    clearBtn.addEventListener("click", () => {
      closeFilterPop({ discard: true });
      filters.clear();
      saveFilters();
      renderBody();
    });
  renderBody();

  const colsBtn = colPrefsId
    ? columnsButton({
        id: colPrefsId,
        columns: baseCols.slice(1).map((c) => ({ key: c.key, label: c.label, optional: !!c.optional })),
        lead: baseCols[0]?.label ?? null,
        onChange: (prefs) => {
          colPrefs = prefs;
          visibleCols = arrange(baseCols);
          // 隠した列の絞り込みは外す（見えない条件で行が減らないように）。並べ替えは既定に戻す
          let dropped = false;
          for (const key of [...filters.keys()]) if (!visibleCols.some((c) => c.key === key)) dropped = filters.delete(key) || dropped;
          if (dropped) saveFilters();
          if (sortState && !visibleCols.some((c) => c.key === sortState.key)) {
            sortState = !tree && sort ? { ...sort } : null;
            try {
              if (sortMemoKey) sessionStorage.removeItem(sortMemoKey);
            } catch {
              /* 無視 */
            }
          }
          renderHead();
          renderBody();
          updateScroll();
        },
      })
    : null;

  const exportBtn = exportName
    ? exportButton(() => ({
        columns: exportColsNow(),
        // 木構造は折りたたみに関係なく全行（絞り込み中は一致した行とその親）
        rows: tree ? filteredRows().map((r) => ({ ...r, name: `${"　".repeat(r.depth ?? 0)}${r.name ?? ""}` })) : currentRows,
        unit,
        name: exportName,
        sheet: caption ?? exportName,
        summary: currentSummary,
      }))
    : null;

  const scrollHint = html`<span class="yn-scroll-hint" aria-live="polite" hidden>${T.table.scrollHint} <span aria-hidden="true">→</span></span>`;
  const wrapEl = html`<div class="yn-table-wrap" style=${maxHeight ? `max-height:${maxHeight}px` : null} tabindex="0" role="region" aria-label=${caption ?? T.table.regionLabel}>${table}</div>`;
  const scroller = html`<div class="yn-table-scroll">${wrapEl}</div>`;
  const wrap = html`<div class="yn-table-block">
    <div class="yn-table-toolbar">${count}${clearBtn}${scrollHint}${toolbar}${colsBtn || exportBtn ? html`<span class="yn-table-actions">${colsBtn}${exportBtn}</span>` : null}</div>
    ${scroller}
  </div>`;
  // 横スクロールの有無と位置を示す（端に影、ツールバーに案内）
  const updateScroll = () => {
    const scrollable = wrapEl.scrollWidth > wrapEl.clientWidth + 1;
    scroller.classList.toggle("is-scrollable", scrollable);
    scroller.classList.toggle("at-start", wrapEl.scrollLeft <= 1);
    scroller.classList.toggle("at-end", !scrollable || wrapEl.scrollLeft + wrapEl.clientWidth >= wrapEl.scrollWidth - 1);
    scrollHint.hidden = !scrollable;
  };
  // 大きさの変化では次の描画の直前に 1 回だけ調べる（描画の途中でレイアウト計算を何度もさせない。§107）
  let scrollFrame = 0;
  const scheduleScroll = () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      updateScroll();
    });
  };
  wrapEl.addEventListener("scroll", updateScroll, { passive: true });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(scheduleScroll).observe(wrapEl);
  scheduleScroll();
  wrap.refresh = () => renderBody();
  wrap.getRows = () => currentRows;
  return wrap;
}

/** 超過の印付きの数値（▲ と赤字。表の 1 マスごとに使うので直接作る） */
function dangerText(t) {
  return h("span", { class: "yn-danger-text" }, h("span", { "aria-hidden": "true" }, "▲"), " ", t);
}

/** 契約名のセル: 1 行目 顧客 / 案件、2 行目 チーム・期間（幅を節約し、title に正式表記。ID は出さない §31.1） */
export function contractNameCell(r) {
  const full = fmt(T.table.contractTitle, { id: r.contractId, customer: r.customerName, project: r.projectName, team: r.teamName, from: r.startMonth, to: r.endMonth });
  return h("span", { class: "yn-cell-2line", title: full }, h("span", { class: "yn-cell-main" }, `${r.customerName} / ${r.projectName}`), h("span", { class: "yn-cell-sub" }, `${r.teamName} ・ ${periodCompact(r.startMonth, r.endMonth)}`));
}

/**
 * 全一覧で共通の数値列（予算・原価・粗利・粗利率・消化率・着地）。
 * breakdowns: {budget(row), cost(row), grossProfit(row), margin(row), burnRate(row), forecast(row)} を渡すと各セルが根拠ボタンになる
 */
export function standardColumns({ breakdowns = {}, forecastLabel = T.columns.forecastGrossProfit, includeHours = false, costTypes = [] } = {}) {
  const cols = [
    { key: "budget", label: T.columns.budget, type: "money", breakdown: breakdowns.budget },
    { key: "cost", label: T.columns.cost, type: "money", breakdown: breakdowns.cost },
    { key: "grossProfit", label: T.columns.grossProfit, type: "money", breakdown: breakdowns.grossProfit },
    { key: "grossMargin", label: T.columns.grossMargin, type: "percent", breakdown: breakdowns.margin },
    {
      key: "burnRate",
      label: T.columns.burnRate,
      type: "percent",
      breakdown: breakdowns.burnRate,
      render: (row) => {
        const t = formatPercent(row.burnRate);
        return row.isOverBudget ? dangerText(t) : t;
      },
    },
    {
      key: "forecastGrossProfit",
      label: forecastLabel,
      type: "money",
      summaryDash: true,
      breakdown: breakdowns.forecast,
      render: (row, unit) => {
        if (row.forecastGrossProfit === null || row.forecastGrossProfit === undefined) return EMPTY_VALUE;
        const t = money(row.forecastGrossProfit, unit);
        return row.isDeficit && row.forecastGrossProfit < 0 ? dangerText(t) : t;
      },
    },
  ];
  if (includeHours) cols.splice(2, 0, { key: "hours", label: T.columns.hours, type: "hours", hideOnPhone: true });
  return [...cols, ...totalsExtraColumns({ includeHours, costTypes })];
}

/**
 * 行の集計（totals・forecast）から追加の計算なしで出せる「選べる列」（§106.1。既定では出さない）。
 * 時間・人月・着地の予算と実績・実績の種類ごとの内訳（種類が 2 つ以上のとき）
 */
export function totalsExtraColumns({ includeHours = false, costTypes = [] } = {}) {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const cols = [];
  if (!includeHours) cols.push({ key: "hours", label: T.columns.hours, type: "hours", optional: true, get: (r) => num(r.hours ?? r.totals?.hours) });
  cols.push(
    { key: "personMonths", label: T.columns.personMonths, align: "num", optional: true, get: (r) => num(r.totals?.personMonthsStandard), render: (r) => decimal(num(r.totals?.personMonthsStandard), 2) },
    // 着地を出さない行（期間内に案件が無い）は空
    { key: "forecastBudget", label: T.columns.forecastBudget, type: "money", optional: true, get: (r) => (r.forecastGrossProfit === null ? null : num(r.forecast?.targetBudget)) },
    { key: "forecastCost", label: T.columns.forecastCost, type: "money", optional: true, get: (r) => (r.forecastGrossProfit === null ? null : num(r.forecast?.forecastCost)) },
  );
  if (costTypes.length > 1)
    for (const t of costTypes) cols.push({ key: `cost:${t.id}`, label: fmt(T.columns.costOfType, { type: t.label }), type: "money", optional: true, get: (r) => num(r.totals?.costs?.[t.id] ?? 0) });
  return cols;
}

/**
 * 案件の行で選べる列（顧客・案件名・チーム・契約期間・契約総額。§106.1）。先頭の列は「顧客 / 案件」の 2 行表示なので、
 * 分けて並べ替え・絞り込みたいとき用。契約総額以外は Excel には従来どおり常に出す
 */
export function contractInfoColumns({ team = true } = {}) {
  return [
    { key: "customerName", label: T.customers.colCustomer, type: "text", optional: true, exportAlways: true },
    { key: "projectName", label: T.contracts.colProject, type: "text", optional: true, exportAlways: true },
    ...(team ? [{ key: "teamName", label: T.columns.team, type: "text", optional: true, exportAlways: true }] : []),
    { key: "period", label: T.columns.contractPeriod, type: "text", optional: true, exportAlways: true, get: (r) => `${r.startMonth}〜${r.endMonth}`, dateValue: (r) => [r.startMonth, r.endMonth] },
    { key: "totalAmount", label: T.columns.totalAmount, type: "money", optional: true },
  ];
}

/** チーム行の契約数列: 「契約数（期間内）」。年度内の契約数は Excel に別列で出す */
export function teamCountColumns() {
  return [
    { key: "contractCount", label: T.columns.contractCount, sublabel: T.columns.inPeriodSub, type: "int", hideOnPhone: true, hideNarrow: true, exportLabel: T.columns.contractCountInPeriod },
  ];
}

/** まとめた行（チーム・顧客）の超過見込み: 配下に超過見込みの案件があり、合計の着地もマイナス（§67） */
const teamDeficit = (row) => row.deficitCount > 0 && (row.forecastGrossProfit ?? 0) < 0;
/** 行を赤にする超過見込み（案件の行は案件の超過見込み、まとめた行は teamDeficit） */
function rowDeficit(row) {
  return typeof row.deficitCount === "number" ? teamDeficit(row) : Boolean(row.isDeficit);
}

/**
 * 行の状態（チップの配列）。赤は 消化率超過 と 赤字着地 だけ。
 * 契約: 「赤字見込み」「予算超過」。チーム（deficitCount を持つ行）: 「赤字 N件」「予算超過」。
 */
export function rowStatus(row) {
  const chips = [];
  const isTeam = typeof row.deficitCount === "number";
  if (isTeam ? teamDeficit(row) : row.isDeficit) {
    chips.push(isTeam ? { kind: "danger", text: fmt(T.table.chipTeamDeficit, { n: row.deficitCount }), title: fmt(T.table.chipTeamDeficitTitle, { n: row.deficitCount }) } : { kind: "danger", text: T.table.chipDeficit, title: T.table.chipDeficitTitle });
  }
  if (row.isOverBudget) chips.push({ kind: "danger", text: T.table.chipOverBudget, title: T.table.chipOverBudgetTitle });
  // まとめた行の合計がマイナスでなければ、超過見込みの案件があっても赤にしない（件数は灰色で出す。§67）
  if (isTeam && !teamDeficit(row) && row.deficitCount > 0) chips.push({ kind: "neutral", text: fmt(T.table.chipTeamDeficitWithin, { n: row.deficitCount }), title: fmt(T.table.chipTeamDeficitWithinTitle, { n: row.deficitCount }) });
  if (chips.length) return chips;
  if (row.includesPreliminary) return [{ kind: "prelim", text: T.table.chipPrelim, title: T.table.chipPrelimTitle }];
  return [{ kind: "ok", text: T.table.chipOk }];
}

/** 状態列の並び順: 赤（赤字・予算超過）を先頭、その中は消化率の高い順 */
export function statusSortValue(row) {
  const danger = rowDeficit(row) || row.isOverBudget;
  const rate = typeof row.burnRate === "number" && Number.isFinite(row.burnRate) ? row.burnRate : -1;
  return (danger ? 0 : 1000) - rate;
}

/**
 * 列の絞り込みの吹き出し（body 直下に fixed で出す。表は横スクロールの枠で切られるため）。一覧表とマスタ編集の表で共通（SPEC §70）。
 * getRows() = 値の一覧を作る行、getFilter(key) = 今の絞り込み、setFilter(col, f) = 変えたとき（表を描き直す）
 */
export function createFilterPopover({ getRows, unit = "yen", getFilter, setFilter }) {
  let openPop = null;
  // discard: 入力の反映待ち（デバウンス中）を捨てる（「絞り込みを解除」用）。既定は閉じる前に反映する
  function closeFilterPop({ focus = false, discard = false } = {}) {
    if (!openPop) return;
    const { pop, btn, cleanup, body } = openPop;
    openPop = null;
    if (discard) body.cancel();
    else body.flush();
    cleanup();
    pop.remove();
    btn.setAttribute("aria-expanded", "false");
    if (focus && btn.isConnected) btn.focus();
  }
  function openFilterPop(col, btn) {
    closeFilterPop();
    const kind = filterKind(col, getRows());
    const popId = `yn-filter-pop-${++filterPopSeq}`;
    const pop = html`<div class="yn-filter-pop" role="dialog" id=${popId} aria-label=${fmt(T.table.filterBy, { label: col.label })}></div>`;
    const body = kind === "range" ? rangeBody(col) : kind === "date" ? dateBody(col) : valuesBody(col);
    const clear = html`<button type="button" class="yn-btn yn-btn-sm">${T.table.filterClear}</button>`;
    const close = html`<button type="button" class="yn-btn yn-btn-sm">${T.table.filterClose}</button>`;
    clear.addEventListener("click", () => {
      body.cancel();
      setFilter(col, null);
      body.reset();
    });
    close.addEventListener("click", () => closeFilterPop({ focus: true }));
    pop.append(body.node, html`<div class="yn-filter-pop-actions">${clear}${close}</div>`);
    document.body.append(pop);
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-controls", popId);
    const place = () => {
      const r = (openPop?.btn ?? btn).getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const w = Math.min(300, vw - 32);
      pop.style.width = `${w}px`;
      pop.style.left = `${Math.max(16, Math.min(r.right - w, vw - w - 16))}px`;
      const h = pop.offsetHeight;
      const below = r.bottom + 4;
      const above = r.top - 4 - h;
      pop.style.top = `${below + h <= vh - 8 ? below : above >= 8 ? above : Math.max(8, vh - 8 - h)}px`;
    };
    place();
    const onDown = (e) => {
      if (!pop.contains(e.target) && !openPop?.btn.contains(e.target)) closeFilterPop();
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeFilterPop({ focus: true });
      }
    };
    // 吹き出しは fixed なので、外側がスクロールしたら見出しのボタンに付いて動かし、ボタンが画面から消えたら閉じる
    // （絞り込みで行が減ると表の枠もスクロールするため、スクロールだけでは閉じない）
    const onScroll = (e) => {
      if (e.target instanceof Node && pop.contains(e.target)) return;
      const cur = openPop?.btn ?? btn;
      const r = cur.getBoundingClientRect();
      if (!cur.isConnected || r.bottom < 0 || r.top > document.documentElement.clientHeight) closeFilterPop();
      else place();
    };
    const onResize = () => closeFilterPop();
    document.addEventListener("pointerdown", onDown, true);
    pop.addEventListener("keydown", onKey);
    addEventListener("scroll", onScroll, { passive: true, capture: true });
    addEventListener("resize", onResize);
    openPop = {
      col,
      pop,
      btn,
      body,
      place,
      cleanup: () => {
        document.removeEventListener("pointerdown", onDown, true);
        removeEventListener("scroll", onScroll, { capture: true });
        removeEventListener("resize", onResize);
      },
    };
    body.focus();
  }

  /** 値の一覧（チェックボックス）＋検索。検索語は行の部分一致にもなる */
  function valuesBody(col) {
    const counts = new Map();
    for (const r of getRows()) for (const v of new Set(filterValues(col, r, unit))) counts.set(v, (counts.get(v) ?? 0) + 1);
    const values = [...counts.keys()];
    if (col.type !== "status") values.sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, "ja", { numeric: true })));
    const cur = () => getFilter(col.key) ?? {};
    const search = html`<input type="search" class="yn-input yn-filter-search" placeholder=${T.table.filterSearch} aria-label=${fmt(T.table.filterBy, { label: col.label })}>`;
    search.value = cur().q ?? "";
    const allBox = html`<input type="checkbox">`;
    const list = html`<div class="yn-filter-list" role="group" aria-label=${col.label}></div>`;
    const none = html`<p class="yn-filter-none" hidden>${T.table.filterNoMatch}</p>`;
    const boxes = values.map((v) => {
      const input = html`<input type="checkbox" value=${v}>`;
      const label = html`<label class="yn-filter-item">${input}<span class="yn-filter-item-text">${v === "" ? T.table.filterBlank : v}</span><span class="yn-filter-item-count">${integer(counts.get(v))}</span></label>`;
      input.addEventListener("change", () => {
        const f = cur();
        const selected = new Set(Array.isArray(f.values) ? f.values : values);
        if (input.checked) selected.add(v);
        else selected.delete(v);
        // すべて選んだ状態は「絞り込みなし」と同じに戻す（後から増えた値も出るように）
        setFilter(col, { q: f.q ?? "", values: values.every((x) => selected.has(x)) ? null : [...selected] });
        sync();
      });
      list.append(label);
      return { v, input, label };
    });
    function sync() {
      const f = cur();
      const sel = Array.isArray(f.values) ? new Set(f.values) : null;
      const q = norm(search.value);
      let shown = 0;
      let checked = 0;
      for (const b of boxes) {
        const vis = !q || norm(b.v).includes(q);
        b.label.hidden = !vis;
        b.input.checked = sel ? sel.has(b.v) : true;
        if (vis) {
          shown += 1;
          if (b.input.checked) checked += 1;
        }
      }
      none.hidden = shown > 0;
      allBox.checked = shown > 0 && checked === shown;
      allBox.indeterminate = checked > 0 && checked < shown;
    }
    allBox.addEventListener("change", () => {
      const f = cur();
      const q = norm(search.value);
      const target = boxes.filter((b) => !q || norm(b.v).includes(q)).map((b) => b.v);
      const selected = new Set(Array.isArray(f.values) ? f.values : values);
      for (const v of target) allBox.checked ? selected.add(v) : selected.delete(v);
      setFilter(col, { q: f.q ?? "", values: values.every((x) => selected.has(x)) ? null : [...selected] });
      sync();
    });
    // 候補の一覧はすぐ絞る。表への反映は打ち終わってから（日本語の変換中は確定してから。§105）
    search.addEventListener("input", sync);
    const applySearch = onTextInput(search, () => setFilter(col, { ...cur(), q: search.value.trim() }));
    sync();
    const node = html`<div class="yn-filter-values">${search}<label class="yn-filter-item yn-filter-all">${allBox}<span>${T.table.filterAll}</span></label>${list}${none}</div>`;
    return {
      node,
      focus: () => search.focus(),
      flush: () => applySearch.flush(),
      cancel: () => applySearch.cancel(),
      reset: () => {
        search.value = "";
        sync();
      },
    };
  }

  /** 数値の範囲（下限・上限）。入力は画面の単位（百万円・%・h）で、元の値に直して覚える */
  function rangeBody(col) {
    const factor = col.type === "moneyYen" ? 1 : rangeFactor(col, unit);
    const unitLabel = rangeUnitLabel(col, unit);
    const toInput = (v) => (typeof v === "number" ? String(Math.round((v / factor) * 1e6) / 1e6) : "");
    const f0 = getFilter(col.key) ?? {};
    const mk = (label, v) => html`<input type="text" inputmode="decimal" class="yn-input yn-filter-num" aria-label=${`${col.label} ${label}`} placeholder=${label} value=${toInput(v)}>`;
    const min = mk(T.table.filterMin, f0.min);
    const max = mk(T.table.filterMax, f0.max);
    const parse = (el) => {
      const t = el.value.normalize("NFKC").replace(/[,\s]/g, "").replace(/[−ー‐]/g, "-");
      if (t === "") return null;
      const n = Number(t);
      el.classList.toggle("is-invalid", !Number.isFinite(n));
      return Number.isFinite(n) ? n * factor : undefined;
    };
    const commit = () => {
      const a = parse(min);
      const b = parse(max);
      if (a === undefined || b === undefined) return;
      const f = {};
      if (a !== null) f.min = a;
      if (b !== null) f.max = b;
      setFilter(col, f);
    };
    // 打ち終わってから反映（全角の数字を日本語入力で打つときは確定してから。§105）
    const inputs = [min, max].map((el) => onTextInput(el, commit, 250));
    const node = html`<div class="yn-filter-range">${min}<span aria-hidden="true">〜</span>${max}${unitLabel ? html`<span class="yn-filter-unit">${unitLabel}</span>` : null}</div>`;
    return {
      node,
      focus: () => min.focus(),
      flush: () => inputs.forEach((x) => x.flush()),
      cancel: () => inputs.forEach((x) => x.cancel()),
      reset: () => {
        min.value = "";
        max.value = "";
        min.classList.remove("is-invalid");
        max.classList.remove("is-invalid");
      },
    };
  }

  /**
   * 日付・年月の範囲（以降〜以前。どちらか片方でよい）。年・年月・日のどれでも入れられ、年・年月はその期間を丸ごと含める。
   * 下の年のボタンで、その年だけに絞る（もう一度押すと解除）
   */
  function dateBody(col) {
    const cur = () => getFilter(col.key) ?? {};
    const f0 = cur();
    const mk = (label, v) => html`<input type="text" inputmode="numeric" class="yn-input yn-filter-num yn-filter-date" aria-label=${`${col.label} ${label}`} placeholder=${label} value=${v ?? ""}>`;
    const from = mk(T.table.filterFrom, f0.from);
    const to = mk(T.table.filterTo, f0.to);
    const years = dateYears(col, getRows());
    const yearBtns = years.map((y) => {
      const b = html`<button type="button" class="yn-btn yn-btn-sm yn-filter-year">${fmt(T.table.filterYear, { y })}</button>`;
      b.addEventListener("click", () => {
        const f = cur();
        const on = f.from === y && f.to === y;
        for (const x of inputs) x.cancel();
        from.value = on ? "" : y;
        to.value = on ? "" : y;
        commit();
      });
      return { y, b };
    });
    const syncYears = () => {
      const f = cur();
      for (const { y, b } of yearBtns) b.setAttribute("aria-pressed", String(f.from === y && f.to === y));
    };
    const parse = (el) => {
      const v = parseDateFilterInput(el.value);
      el.classList.toggle("is-invalid", v === undefined);
      return v;
    };
    function commit() {
      const a = parse(from);
      const b = parse(to);
      if (a === undefined || b === undefined) return;
      const f = {};
      if (a) f.from = a;
      if (b) f.to = b;
      setFilter(col, f);
      syncYears();
    }
    // 打ち終わってから反映。「2026年4月」のように日本語で打つときは、変換を確定してから読む（§105）
    const inputs = [from, to].map((el) => onTextInput(el, commit, 250));
    for (const el of [from, to])
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) {
          for (const x of inputs) x.cancel();
          commit();
        }
      });
    syncYears();
    const node = html`<div class="yn-filter-dates"><div class="yn-filter-range yn-filter-date-range">${from}<span aria-hidden="true">〜</span>${to}</div>${yearBtns.length ? html`<div class="yn-filter-years" role="group" aria-label=${fmt(T.table.filterYears, { label: col.label })}>${yearBtns.map((x) => x.b)}</div>` : null}</div>`;
    return {
      node,
      focus: () => from.focus(),
      flush: () => inputs.forEach((x) => x.flush()),
      cancel: () => inputs.forEach((x) => x.cancel()),
      reset: () => {
        from.value = "";
        to.value = "";
        from.classList.remove("is-invalid");
        to.classList.remove("is-invalid");
        syncYears();
      },
    };
  }

  return {
    open: openFilterPop,
    close: closeFilterPop,
    isOpenFor: (col) => !!openPop && openPop.col.key === col.key,
    /** 表を描き直して見出しのボタンが替わったとき、開いている吹き出しを新しいボタンに付け直す */
    rebind(key, btn) {
      if (!openPop || openPop.col.key !== key || !btn) return;
      openPop.btn = btn;
      btn.setAttribute("aria-expanded", "true");
      btn.setAttribute("aria-controls", openPop.pop.id);
      openPop.place();
    },
  };
}
