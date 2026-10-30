/**
 * 一覧表: 並べ替え（aria-sort）・固定ヘッダ・右寄せ数値・状態チップ・行クリック・Excel 出力・木構造（チーム一覧）
 *
 * dataTable({
 *   columns: [{ key, label, type: "text"|"money"|"moneyYen"（明細: 常に円）|"percent"|"hours"|"int"|"status"|"custom",
 *               get(row), render?(row) -> Node|string, sortValue?(row), exportValue?(row), exportLabel?,
 *               breakdown?(row) -> spec, align?: "num"|"text", sortable?: boolean, width?, hideOnPhone?: boolean, hideMid?: boolean（ノート PC の狭い幅で隠す）,
 *               summaryDash?: 合計行に値が無い（null）とき空欄でなく「—」を出す（「該当なし」を明示したい列）,
 *               sublabel?: 見出しの 2 行目（母集団の注記など。幅を増やさずに補足する）,
 *               filter?: "values"|"range"|false（見出しの絞り込み。既定は数値列 range・それ以外 values）, filterValue?(row) -> string|string[] }],
 *   rows, rowKey(row), unit, sort: {key, dir}, rowHref?(row), caption, exportName, emptyText,
 *   tree?: boolean（rows に key/parentKey/depth/hasChildren を持たせる。並べ替えは無効）,
 *   summary?: row | (shownRows) => row（tfoot の合計行。関数なら列の絞り込み後の行で作り直す。
 *             固定の row は絞り込み中は出さない）, summaryBreakdown?(col, summaryRow) -> spec（合計行の根拠。無ければ合計行はプレーン表示）,
 *   filter?: false（列ごとの絞り込みを付けない）,
 *   maxHeight?: px, toolbar?: Node
 * })
 * Excel 出力: 金額は単位に関係なく常に円の整数（列名「…（円）」、1 行目に「単位: 円」の注記）。
 */
import { html } from "htl";
import { EMPTY_VALUE, formatHours, formatPercent, integer, money, periodCompact } from "./format.js";
import { numberButton } from "./breakdown.js";
import { statusChip } from "./kpi.js";
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
      return html`<span class="yn-chip-row">${list.map((s) => statusChip(s.kind, s.text, s.title ?? null))}</span>`;
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
  if (col.type === "money") return T.format.units[unit] ?? T.format.units.yen;
  if (col.type === "moneyYen") return T.format.units.yen;
  if (col.type === "percent") return "%";
  if (col.type === "hours") return "h";
  return "";
}

/** 絞り込みの種類。右寄せでも値が文字の列（単価の「6,000円 / 7,000円」など）は値の一覧にする */
function filterKind(col, rows = null) {
  if (col.filter === false) return null;
  if (col.filter === "values" || col.filter === "range") return col.filter;
  if (NUMERIC_TYPES.has(col.type)) return "range";
  if (isNumeric(col) && (!rows || rows.some((r) => rangeValue(col, r) !== null))) return "range";
  return "values";
}

/** 絞り込みの値（文字）。空は "" */
function filterValues(col, row, unit) {
  let v;
  if (col.filterValue) v = col.filterValue(row);
  else if (col.type === "status") {
    const s = col.get ? col.get(row) : row[col.key];
    v = s ? (Array.isArray(s) ? s : [s]).map((x) => x.text) : "";
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

/** 1 行が列の絞り込みを満たすか。f = {q, values} | {min, max}（min/max は円・比率などの元の値） */
export function matchesFilter(col, f, row, unit) {
  if (!f) return true;
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

function isActiveFilter(f) {
  return !!f && ((typeof f.q === "string" && f.q !== "") || Array.isArray(f.values) || typeof f.min === "number" || typeof f.max === "number");
}

const FILTER_ICON = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M1 1.5h10L7.2 6.2V10L4.8 11V6.2Z" fill="currentColor"/></svg>';

let filterPopSeq = 0;

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
  const visibleCols = columns.filter((c) => !c.hidden && !c.exportOnly);
  const exportCols = columns.filter((c) => !c.hidden && c.export !== false);
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
  let sortState = tree ? null : remembered ?? (sort ? { ...sort } : null);
  const collapsed = new Set();
  let currentRows = rows;

  // 列ごとの絞り込み（SPEC §67）。木構造の表には付けない。並べ替えと同じくタブ単位で覚える
  const filterable = !tree && filter !== false && rows.length > 0;
  const filterMemoKey = filterable && caption ? `yojitsu-navi:filter:${location.pathname}:${caption}` : null;
  /** @type {Map<string, any>} 列 key → {q, values} | {min, max} */
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
  function filteredRows() {
    const act = activeFilters();
    if (act.length === 0) return rows;
    const cols = act.map(([key, f]) => [visibleCols.find((c) => c.key === key), f]).filter(([c]) => c);
    return rows.filter((r) => cols.every(([c, f]) => matchesFilter(c, f, r, unit)));
  }

  const table = html`<table class="yn-table" id=${id}>${caption ? html`<caption class="visually-hidden">${caption}</caption>` : null}</table>`;
  const thead = html`<thead></thead>`;
  const tbody = html`<tbody></tbody>`;
  table.append(thead, tbody);

  function orderedRows() {
    if (tree) {
      // 折りたたみ: 祖先が collapsed なら非表示
      const byKey = new Map(rows.map((r) => [r.key, r]));
      return rows.filter((r) => {
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
            if (openPop && openPop.col === col) closeFilterPop();
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
        return th;
      })}</tr>`,
    );
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
    const danger = row.isDanger || row.isDeficit || row.isOverBudget;
    const tr = html`<tr class=${`${href ? "is-clickable" : ""}${danger ? " is-danger" : ""}${tree ? ` yn-depth-${row.depth ?? 0}` : ""}`} data-key=${String(rowKey(row, i))}></tr>`;
    visibleCols.forEach((col, ci) => {
      const numeric = isNumeric(col);
      const cls = `${numeric ? "num" : ""}${col.hideOnPhone ? " hide-phone" : ""}${col.hideNarrow ? " hide-narrow" : ""}${col.hideMid ? " hide-mid" : ""}${col.key === "name" || ci === 0 ? " yn-primary-cell" : ""}`;
      const cell = ci === 0 ? html`<th scope="row" class=${cls}></th>` : html`<td class=${cls}></td>`;
      let content = cellNode(col, row);
      if (ci === 0) {
        if (tree) {
          const indent = html`<span class="yn-tree-indent" style=${`--depth:${row.depth ?? 0}`}></span>`;
          cell.append(indent);
          if (row.hasChildren) {
            const open = !collapsed.has(row.key);
            const toggle = html`<button type="button" class="yn-tree-toggle" aria-expanded=${open ? "true" : "false"} aria-label=${fmt(open ? T.table.treeClose : T.table.treeOpen, { name: row.name ?? "" })}><span aria-hidden="true">${open ? "▾" : "▸"}</span></button>`;
            toggle.addEventListener("click", (ev) => {
              ev.stopPropagation();
              if (collapsed.has(row.key)) collapsed.delete(row.key);
              else collapsed.add(row.key);
              renderBody();
              focusIn(tbody, `tr[data-key="${cssEscape(String(row.key))}"] .yn-tree-toggle`);
            });
            cell.append(toggle);
          } else cell.append(html`<span class="yn-tree-toggle yn-tree-leaf" aria-hidden="true"></span>`);
        }
        if (href) content = html`<a class="yn-row-link" href=${href}>${content}</a>`;
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
    tfoot.replaceChildren(html`<tr class="yn-summary-row">${visibleCols.map((col, ci) => {
      const numeric = isNumeric(col);
      const has = sm[col.key] !== undefined && sm[col.key] !== null;
      const content = ci === 0 ? (sm.name ?? T.table.total) : col.summary === false || (!numeric && !has) || (numeric && !has && !col.get) ? (col.summaryDash && numeric ? EMPTY_VALUE : "") : cellNode(col, sm, true);
      return html`<td class=${`${numeric ? "num" : ""}${col.hideOnPhone ? " hide-phone" : ""}${col.hideNarrow ? " hide-narrow" : ""}${col.hideMid ? " hide-mid" : ""}`}>${content}</td>`;
    })}</tr>`);
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
    if (count)
      count.textContent = tree
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

  // ── 絞り込みの吹き出し（body 直下に fixed で出す。表は横スクロールの枠で切られるため） ──
  let openPop = null;
  function closeFilterPop({ focus = false } = {}) {
    if (!openPop) return;
    const { pop, btn, cleanup } = openPop;
    openPop = null;
    cleanup();
    pop.remove();
    btn.setAttribute("aria-expanded", "false");
    if (focus && btn.isConnected) btn.focus();
  }
  function setFilter(col, f) {
    if (isActiveFilter(f)) filters.set(col.key, f);
    else filters.delete(col.key);
    saveFilters();
    renderBody();
  }
  function openFilterPop(col, btn) {
    closeFilterPop();
    const kind = filterKind(col, rows);
    const popId = `yn-filter-pop-${++filterPopSeq}`;
    const pop = html`<div class="yn-filter-pop" role="dialog" id=${popId} aria-label=${fmt(T.table.filterBy, { label: col.label })}></div>`;
    const body = kind === "range" ? rangeBody(col) : valuesBody(col);
    const clear = html`<button type="button" class="yn-btn yn-btn-sm">${T.table.filterClear}</button>`;
    const close = html`<button type="button" class="yn-btn yn-btn-sm">${T.table.filterClose}</button>`;
    clear.addEventListener("click", () => {
      setFilter(col, null);
      body.reset();
    });
    close.addEventListener("click", () => closeFilterPop({ focus: true }));
    pop.append(body.node, html`<div class="yn-filter-pop-actions">${clear}${close}</div>`);
    document.body.append(pop);
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-controls", popId);
    const place = () => {
      const r = btn.getBoundingClientRect();
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
      if (!pop.contains(e.target) && !btn.contains(e.target)) closeFilterPop();
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
      const r = btn.getBoundingClientRect();
      if (!btn.isConnected || r.bottom < 0 || r.top > document.documentElement.clientHeight) closeFilterPop();
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
    for (const r of rows) for (const v of new Set(filterValues(col, r, unit))) counts.set(v, (counts.get(v) ?? 0) + 1);
    const values = [...counts.keys()];
    if (col.type !== "status") values.sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, "ja", { numeric: true })));
    const cur = () => filters.get(col.key) ?? {};
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
    let timer = null;
    search.addEventListener("input", () => {
      sync();
      clearTimeout(timer);
      timer = setTimeout(() => setFilter(col, { ...cur(), q: search.value.trim() }), 150);
    });
    sync();
    const node = html`<div class="yn-filter-values">${search}<label class="yn-filter-item yn-filter-all">${allBox}<span>${T.table.filterAll}</span></label>${list}${none}</div>`;
    return {
      node,
      focus: () => search.focus(),
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
    const f0 = filters.get(col.key) ?? {};
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
    let timer = null;
    const apply = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const a = parse(min);
        const b = parse(max);
        if (a === undefined || b === undefined) return;
        const f = {};
        if (a !== null) f.min = a;
        if (b !== null) f.max = b;
        setFilter(col, f);
      }, 250);
    };
    min.addEventListener("input", apply);
    max.addEventListener("input", apply);
    const node = html`<div class="yn-filter-range">${min}<span aria-hidden="true">〜</span>${max}${unitLabel ? html`<span class="yn-filter-unit">${unitLabel}</span>` : null}</div>`;
    return {
      node,
      focus: () => min.focus(),
      reset: () => {
        min.value = "";
        max.value = "";
        min.classList.remove("is-invalid");
        max.classList.remove("is-invalid");
      },
    };
  }

  renderHead();
  const count = html`<span class="yn-table-count" aria-live="polite"></span>`;
  const clearBtn = filterable ? html`<button type="button" class="yn-btn yn-btn-sm yn-filter-clear-all" hidden>${T.table.filterClearAll}</button>` : null;
  if (clearBtn)
    clearBtn.addEventListener("click", () => {
      closeFilterPop();
      filters.clear();
      saveFilters();
      renderBody();
    });
  renderBody();

  const exportBtn = exportName
    ? exportButton(() => ({
        columns: exportCols,
        rows: tree ? rows.map((r) => ({ ...r, name: `${"　".repeat(r.depth ?? 0)}${r.name ?? ""}` })) : currentRows,
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
    <div class="yn-table-toolbar">${count}${clearBtn}${scrollHint}${toolbar}${exportBtn}</div>
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
  wrapEl.addEventListener("scroll", updateScroll, { passive: true });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(updateScroll).observe(wrapEl);
  queueMicrotask(updateScroll);
  wrap.refresh = () => renderBody();
  wrap.getRows = () => currentRows;
  return wrap;
}

/** 契約名のセル: 1 行目 顧客 / 案件、2 行目 チーム・期間（幅を節約し、title に正式表記。ID は出さない §31.1） */
export function contractNameCell(r) {
  const full = fmt(T.table.contractTitle, { id: r.contractId, customer: r.customerName, project: r.projectName, team: r.teamName, from: r.startMonth, to: r.endMonth });
  return html`<span class="yn-cell-2line" title=${full}><span class="yn-cell-main">${r.customerName} / ${r.projectName}</span><span class="yn-cell-sub">${r.teamName} ・ ${periodCompact(r.startMonth, r.endMonth)}</span></span>`;
}

/**
 * 全一覧で共通の数値列（予算・原価・粗利・粗利率・消化率・着地）。
 * breakdowns: {budget(row), cost(row), grossProfit(row), margin(row), burnRate(row), forecast(row)} を渡すと各セルが根拠ボタンになる
 */
export function standardColumns({ breakdowns = {}, forecastLabel = T.columns.forecastGrossProfit, includeHours = false } = {}) {
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
        return row.isOverBudget ? html`<span class="yn-danger-text"><span aria-hidden="true">▲</span> ${t}</span>` : t;
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
        return row.isDeficit && row.forecastGrossProfit < 0 ? html`<span class="yn-danger-text"><span aria-hidden="true">▲</span> ${t}</span>` : t;
      },
    },
  ];
  if (includeHours) cols.splice(2, 0, { key: "hours", label: T.columns.hours, type: "hours", hideOnPhone: true });
  return cols;
}

/** チーム行の契約数列: 「契約数（期間内）」。年度内の契約数は Excel に別列で出す */
export function teamCountColumns() {
  return [
    { key: "contractCount", label: T.columns.contractCount, sublabel: T.columns.inPeriodSub, type: "int", hideOnPhone: true, hideNarrow: true, exportLabel: T.columns.contractCountInPeriod },
  ];
}

/**
 * 行の状態（チップの配列）。赤は 消化率超過 と 赤字着地 だけ。
 * 契約: 「赤字見込み」「予算超過」。チーム（deficitCount を持つ行）: 「赤字 N件」「予算超過」。
 */
export function rowStatus(row) {
  const chips = [];
  const isTeam = typeof row.deficitCount === "number";
  if (isTeam ? row.deficitCount > 0 : row.isDeficit) {
    chips.push(isTeam ? { kind: "danger", text: fmt(T.table.chipTeamDeficit, { n: row.deficitCount }), title: fmt(T.table.chipTeamDeficitTitle, { n: row.deficitCount }) } : { kind: "danger", text: T.table.chipDeficit, title: T.table.chipDeficitTitle });
  }
  if (row.isOverBudget) chips.push({ kind: "danger", text: T.table.chipOverBudget, title: T.table.chipOverBudgetTitle });
  if (chips.length) return chips;
  if (row.includesPreliminary) return [{ kind: "prelim", text: T.table.chipPrelim, title: T.table.chipPrelimTitle }];
  return [{ kind: "ok", text: T.table.chipOk }];
}

/** 状態列の並び順: 赤（赤字・予算超過）を先頭、その中は消化率の高い順 */
export function statusSortValue(row) {
  const danger = row.isDeficit || row.isOverBudget || (row.deficitCount ?? 0) > 0;
  const rate = typeof row.burnRate === "number" && Number.isFinite(row.burnRate) ? row.burnRate : -1;
  return (danger ? 0 : 1000) - rate;
}
