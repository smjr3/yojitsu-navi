/**
 * KPI タイル（値・ラベル・比較・状態）。値はボタンで、クリックすると計算根拠を開く
 */
import { html } from "htl";
import { numberButton } from "./breakdown.js";

/**
 * statTile({
 *   label, value (表示文字列), unitHint, sub (補足), compare: {text, direction: "up"|"down"|"flat"|null, good: bool|null},
 *   status: {kind: "danger"|"ok"|"neutral", text}, breakdown: spec, id
 * })
 */
export function statTile({ label, value, sub = null, compare = null, status = null, breakdown = null, id = null, emphasis = false, wrap = false }) {
  const valueNode = breakdown
    ? numberButton(value, breakdown, { className: "yn-kpi-value", ariaLabel: `${label} ${value} の計算根拠を表示` })
    : html`<span class="yn-kpi-value">${value}</span>`;
  const statusNode = status
    ? html`<span class=${`yn-chip yn-chip-${status.kind}`}><span class="yn-chip-icon" aria-hidden="true">${chipIcon(status.kind)}</span>${status.text}</span>`
    : null;
  const compareNode = compare
    ? html`<span class=${`yn-kpi-compare${compare.good === true ? " is-good" : compare.good === false ? " is-bad" : ""}`}>
        ${compare.direction ? html`<span class="yn-kpi-arrow" aria-hidden="true">${compare.direction === "up" ? "▲" : compare.direction === "down" ? "▼" : "―"}</span>` : null}
        ${compare.text}</span>`
    : null;
  return html`<article class=${`yn-kpi${emphasis ? " yn-kpi-emphasis" : ""}${status?.kind === "danger" ? " is-danger" : ""}${wrap ? " yn-kpi-wrap" : ""}`} id=${id} aria-label=${label}>
    <div class="yn-kpi-label">${label}</div>
    <div class="yn-kpi-value-row">${valueNode}${statusNode}</div>
    ${sub ? html`<div class="yn-kpi-sub">${sub}</div>` : null}
    ${compareNode ? html`<div class="yn-kpi-compare-row">${compareNode}</div>` : null}
  </article>`;
}

export function chipIcon(kind) {
  switch (kind) {
    case "danger":
      return "▲";
    case "ok":
      return "●";
    case "prelim":
      return "◔";
    default:
      return "○";
  }
}

/** 状態チップ（表のセルやヘッダで共通に使う） */
export function statusChip(kind, text, title = null) {
  return html`<span class=${`yn-chip yn-chip-${kind}`} title=${title}><span class="yn-chip-icon" aria-hidden="true">${chipIcon(kind)}</span>${text}</span>`;
}

/** KPI の行 */
export function kpiRow(tiles, { columns = 5 } = {}) {
  return html`<section class="yn-kpi-grid" style=${`--yn-kpi-cols:${columns}`} aria-label="主要指標">${tiles}</section>`;
}
