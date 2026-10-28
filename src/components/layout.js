/**
 * ページ共通の枠: ヘッダ（基準日・取得日時・速報バッジ・パンくず）、空状態、エラー状態、読み込み中
 */
import { html } from "htl";
import { dateIso, dateTimeJst, fiscalYearLabel } from "./format.js";
import { T, fmt } from "../i18n/index.js";

/** 速報バッジ（期間に速報月を含むとき） */
export function preliminaryBadge(includes) {
  return includes
    ? html`<span class="yn-badge yn-badge-prelim" role="status" title=${T.layout.prelimBadgeTitle}><span class="yn-icon-prelim" aria-hidden="true">◔</span> ${T.layout.prelimBadge}</span>`
    : html`<span class="yn-badge yn-badge-final" title=${T.layout.finalBadgeTitle}><span aria-hidden="true">●</span> ${T.layout.finalBadge}</span>`;
}

/**
 * ページヘッダ
 *   pageHeader({ model, title, lead, breadcrumbs: [{label, href}], includesPreliminary, extra })
 */
export function pageHeader({ model, title, lead, breadcrumbs = [], includesPreliminary = false, extra = null }) {
  const meta = model?.meta;
  // 1 段だけのパンくずは上部タブと重複するので出さない
  const crumbs = breadcrumbs.length > 1
    ? html`<nav class="yn-crumbs" aria-label=${T.layout.breadcrumbsLabel}><ol>${breadcrumbs.map(
        (c, i) =>
          html`<li>${c.href && i < breadcrumbs.length - 1 ? html`<a href=${c.href}>${c.label}</a>` : html`<span aria-current="page">${c.label}</span>`}</li>`,
      )}</ol></nav>`
    : null;
  return html`<header class="yn-page-header">
    ${crumbs}
    <div class="yn-page-title-row">
      <h1 class="yn-page-title">${title}</h1>
      ${extra}
    </div>
    ${lead ? html`<p class="yn-lead">${lead}</p>` : null}
    ${meta
      ? html`<dl class="yn-meta" aria-label=${T.layout.metaLabel}>
          <div><dt>${T.layout.asOf}</dt><dd><time datetime=${meta.asOf}>${dateIso(meta.asOf)}</time></dd></div>
          <div><dt>${T.layout.fiscalYear}</dt><dd>${fmt(T.layout.fiscalYearValue, { fy: fiscalYearLabel(meta.fiscalYear), from: meta.fiscalYearMonths[0], to: meta.fiscalYearMonths[meta.fiscalYearMonths.length - 1] })}</dd></div>
          <div><dt>${T.layout.lastFinal}</dt><dd>${fmt(T.layout.lastFinalValue, { month: meta.lastFinalMonth })}</dd></div>
          <div><dt>${T.layout.fetchedAt}</dt><dd>${meta.worklogFetchedAt ? html`<time datetime=${meta.worklogFetchedAt}>${dateTimeJst(meta.worklogFetchedAt)}</time>` : T.layout.notFetched}</dd></div>
          <div class="yn-meta-badge"><dt class="visually-hidden">${T.layout.prelimHidden}</dt><dd>${preliminaryBadge(includesPreliminary)}</dd></div>
        </dl>`
      : null}
  </header>`;
}

/** セクション見出し（番号付きで「一画面一問」を明示） */
export function sectionTitle(title, hint, actions = null) {
  return html`<div class="yn-section-head">
    <div><h2 class="yn-section-title">${title}</h2>${hint ? html`<p class="yn-section-hint">${hint}</p>` : null}</div>
    ${actions ? html`<div class="yn-section-actions">${actions}</div>` : null}
  </div>`;
}

/** 空状態 */
export function emptyState({ title, text, icon = "○", actions = [] }) {
  return html`<div class="yn-state yn-empty" role="status">
    <div class="yn-state-icon" aria-hidden="true">${icon}</div>
    <p class="yn-state-title">${title}</p>
    ${text ? html`<p class="yn-state-text">${text}</p>` : null}
    ${actions.length ? html`<p class="yn-state-actions">${actions.map((a) => html`<a class="yn-btn" href=${a.href}>${a.label}</a>`)}</p>` : null}
  </div>`;
}

/** エラー状態 */
export function errorState({ title = T.layout.loadErrorTitle, error, actions = [] }) {
  const detail = error ? (error.message ?? String(error)) : null;
  return html`<div class="yn-state yn-error" role="alert">
    <div class="yn-state-icon" aria-hidden="true">!</div>
    <p class="yn-state-title">${title}</p>
    ${detail ? html`<p class="yn-state-text"><code>${detail}</code></p>` : null}
    <p class="yn-state-text">${T.layout.loadErrorHelp}</p>
    ${actions.length ? html`<p class="yn-state-actions">${actions.map((a) => html`<a class="yn-btn" href=${a.href}>${a.label}</a>`)}</p>` : null}
  </div>`;
}

/** 読み込み中（スケルトン） */
export function loadingState(label = T.common.loading) {
  return html`<div class="yn-state yn-loading" role="status" aria-live="polite" aria-busy="true">
    <div class="yn-spinner" aria-hidden="true"></div>
    <p class="yn-state-text">${label}</p>
  </div>`;
}

/**
 * データファイルを読む。失敗したら null を返し、代わりにエラー状態を描く。
 *   const model = await loadJson(FileAttachment("./data/model.json"), {skeleton: "page-skeleton"})
 */
export async function loadJson(file, { skeleton } = {}) {
  const placeholder = skeleton ? document.getElementById(skeleton) : null;
  try {
    const data = await file.json();
    placeholder?.remove();
    return data;
  } catch (error) {
    if (placeholder) {
      placeholder.replaceChildren(errorState({ error }));
      placeholder.removeAttribute("aria-busy");
    }
    return null;
  }
}

/** ノート（注記） */
export function note(text, kind = "info") {
  return html`<p class=${`yn-note yn-note-${kind}`}>${text}</p>`;
}
