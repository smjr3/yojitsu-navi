/**
 * 一覧表: 並べ替え（aria-sort）・固定ヘッダ・右寄せ数値・状態チップ・行クリック・Excel 出力・木構造（チーム一覧）
 *
 * dataTable({
 *   columns: [{ key, label, type: "text"|"money"|"moneyYen"（明細: 常に円）|"percent"|"hours"|"int"|"status"|"custom",
 *               get(row), render?(row) -> Node|string, sortValue?(row), exportValue?(row), exportLabel?,
 *               breakdown?(row) -> spec, align?: "num"|"text", sortable?: boolean, width?, hideOnPhone?: boolean,
 *               summaryDash?: 合計行に値が無い（null）とき空欄でなく「—」を出す（「該当なし」を明示したい列）,
 *               sublabel?: 見出しの 2 行目（母集団の注記など。幅を増やさずに補足する） }],
 *   rows, rowKey(row), unit, sort: {key, dir}, rowHref?(row), caption, exportName, emptyText,
 *   tree?: boolean（rows に key/parentKey/depth/hasChildren を持たせる。並べ替えは無効）,
 *   summary?: row（tfoot の合計行）, summaryBreakdown?(col) -> spec（合計行の根拠。無ければ合計行はプレーン表示）,
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

/** ファイル名に使えない文字を _ に（契約IDがそのまま入るため） */
export function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "export";
}

export const EXPORT_UNIT_NOTE = T.table.exportUnitNote;

/** 現在の表示（並べ替え・絞り込み後）を .xlsx で保存。金額は常に円の整数 */
export async function exportXlsx({ columns, rows, unit = "yen", name = "export", sheet = "Sheet1" }) {
  const XLSX = await import("xlsx");
  const header = columns.map((c) => exportLabel(c, unit));
  const body = rows.map((r) => columns.map((c) => (c.exportValue ? c.exportValue(r, unit) : defaultExport(c, r, unit))));
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
}) {
  const visibleCols = columns.filter((c) => !c.hidden && !c.exportOnly);
  const exportCols = columns.filter((c) => !c.hidden && c.export !== false);
  let sortState = tree ? null : sort ? { ...sort } : null;
  const collapsed = new Set();
  let currentRows = rows;

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
    if (!sortState) return rows;
    const col = columns.find((c) => c.key === sortState.key);
    if (!col) return rows;
    return rows
      .map((r, i) => ({ r, i, v: sortValue(col, r) }))
      .sort((a, b) => compare(a.v, b.v, sortState.dir) || a.i - b.i)
      .map((x) => x.r);
  }

  function renderHead() {
    thead.replaceChildren(
      html`<tr>${visibleCols.map((col) => {
        const numeric = isNumeric(col);
        const sortable = !tree && col.sortable !== false;
        const active = sortState && sortState.key === col.key;
        const th = html`<th scope="col" class=${`${numeric ? "num" : ""}${col.hideOnPhone ? " hide-phone" : ""}${col.hideNarrow ? " hide-narrow" : ""}`} style=${col.width ? `width:${col.width}` : null} data-key=${col.key} aria-sort=${active ? (sortState.dir === "asc" ? "ascending" : "descending") : sortable ? "none" : null}></th>`;
        if (sortable) {
          const btn = html`<button type="button" class="yn-sort" title=${fmt(T.table.sortBy, { label: col.label })}>${headLabel(col)}<span class="yn-sort-icon" aria-hidden="true">${active ? (sortState.dir === "asc" ? "▲" : "▼") : "⇅"}</span>${col.sublabel ? html`<span class="yn-th-sub">${col.sublabel}</span>` : null}</button>`;
          btn.addEventListener("click", () => {
            const first = numeric ? "desc" : "asc";
            sortState = active ? { key: col.key, dir: sortState.dir === "asc" ? "desc" : "asc" } : { key: col.key, dir: first };
            renderHead();
            renderBody();
            // 再描画で消えたフォーカスを同じ列のボタンへ戻す（キーボード操作の継続）
            focusIn(thead, `th[data-key="${cssEscape(col.key)}"] button`);
          });
          th.append(btn);
        } else th.append(headLabel(col), col.sublabel ? html`<span class="yn-th-sub">${col.sublabel}</span>` : "");
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
      return spec ? numberButton(text, spec, { ariaLabel: fmt(T.table.totalBreakdownAria, { label: col.label, value: typeof text === "string" ? text : "" }) }) : text;
    }
    if (col.breakdown) {
      const spec = () => col.breakdown(row);
      return numberButton(text, spec, { ariaLabel: fmt(T.table.cellBreakdownAria, { label: col.label, value: typeof text === "string" ? text : "" }) });
    }
    return text;
  }

  function renderRow(row, i) {
    const href = rowHref ? rowHref(row) : null;
    const danger = row.isDanger || row.isDeficit || row.isOverBudget;
    const tr = html`<tr class=${`${href ? "is-clickable" : ""}${danger ? " is-danger" : ""}${tree ? ` yn-depth-${row.depth ?? 0}` : ""}`} data-key=${String(rowKey(row, i))}></tr>`;
    visibleCols.forEach((col, ci) => {
      const numeric = isNumeric(col);
      const cls = `${numeric ? "num" : ""}${col.hideOnPhone ? " hide-phone" : ""}${col.hideNarrow ? " hide-narrow" : ""}${col.key === "name" || ci === 0 ? " yn-primary-cell" : ""}`;
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

  function renderBody() {
    currentRows = orderedRows();
    if (currentRows.length === 0) {
      tbody.replaceChildren(html`<tr class="yn-table-empty"><td colspan=${visibleCols.length}>${emptyText}</td></tr>`);
    } else {
      tbody.replaceChildren(...currentRows.map(renderRow));
    }
    if (count) count.textContent = fmt(tree ? T.table.rowCountTree : T.table.rowCount, { n: integer(rows.length) });
  }

  renderHead();
  const count = html`<span class="yn-table-count" aria-live="polite"></span>`;
  renderBody();

  if (summary) {
    const tfoot = html`<tfoot><tr class="yn-summary-row">${visibleCols.map((col, ci) => {
      const numeric = isNumeric(col);
      const has = summary[col.key] !== undefined && summary[col.key] !== null;
      const content = ci === 0 ? (summary.name ?? T.table.total) : col.summary === false || (!numeric && !has) || (numeric && !has && !col.get) ? (col.summaryDash && numeric ? EMPTY_VALUE : "") : cellNode(col, summary, true);
      return html`<td class=${`${numeric ? "num" : ""}${col.hideOnPhone ? " hide-phone" : ""}${col.hideNarrow ? " hide-narrow" : ""}`}>${content}</td>`;
    })}</tr></tfoot>`;
    table.append(tfoot);
  }

  const exportBtn = exportName
    ? exportButton(() => ({
        columns: exportCols,
        rows: tree ? rows.map((r) => ({ ...r, name: `${"　".repeat(r.depth ?? 0)}${r.name ?? ""}` })) : currentRows,
        unit,
        name: exportName,
        sheet: caption ?? exportName,
      }))
    : null;

  const scrollHint = html`<span class="yn-scroll-hint" aria-live="polite" hidden>${T.table.scrollHint} <span aria-hidden="true">→</span></span>`;
  const wrapEl = html`<div class="yn-table-wrap" style=${maxHeight ? `max-height:${maxHeight}px` : null} tabindex="0" role="region" aria-label=${caption ?? T.table.regionLabel}>${table}</div>`;
  const scroller = html`<div class="yn-table-scroll">${wrapEl}</div>`;
  const wrap = html`<div class="yn-table-block">
    <div class="yn-table-toolbar">${count}${scrollHint}${toolbar}${exportBtn}</div>
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

/** 契約名のセル: 1 行目 顧客 / 案件、2 行目 ID・チーム・期間（幅を節約し、title に正式表記） */
export function contractNameCell(r) {
  const full = fmt(T.table.contractTitle, { id: r.contractId, customer: r.customerName, project: r.projectName, team: r.teamName, from: r.startMonth, to: r.endMonth });
  return html`<span class="yn-cell-2line" title=${full}><span class="yn-cell-main">${r.customerName} / ${r.projectName}</span><span class="yn-cell-sub"><span class="yn-cell-id">${r.contractId}</span> ・ ${r.teamName} ・ ${periodCompact(r.startMonth, r.endMonth)}</span></span>`;
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
    { key: "fyContractCount", label: T.columns.contractCountFy, type: "int", exportOnly: true },
  ];
}

/** チーム行の着地粗利列: 見出しに「（年度内）」、セルの 2 行目に年度内の契約件数（契約数列とは母集団が違うため） */
export function withForecastCount(col) {
  if (col.key !== "forecastGrossProfit") return col;
  const base = col.render;
  return {
    ...col,
    sublabel: T.columns.inFySub,
    exportLabel: T.columns.forecastGrossProfitFyExport,
    render: (row, unit) => {
      const t = base(row, unit);
      if (t === EMPTY_VALUE || typeof row.fyContractCount !== "number") return t;
      return html`<span class="yn-cell-stack">${t}<span class="yn-muted yn-cell-count" title=${T.table.fyContractCountTitle}>${fmt(T.table.fyContractCount, { n: integer(row.fyContractCount) })}</span></span>`;
    },
  };
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
