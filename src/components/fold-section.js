/**
 * 開閉できる節と、件数付きの目次（データ確認。SPEC §126）
 *
 * - foldSection({ id, title, hint, count, tone }) → { el, body }:
 *   見出しのボタンで本文を開閉する節。見出しの横に件数（0 件は ✓）。開閉はこのブラウザに覚える（既定は defaultOpen）
 * - sectionToc(items) → nav: 節の名前と件数を並べ、押すとその節を開いて移る
 */
import { html } from "htl";
import { T, fmt } from "../i18n/index.js";
import { infoTip } from "./layout.js";
import { integer } from "./format.js";

const memoKey = (id) => `yojitsu-navi:fold:${location.pathname}:${id}`;
function loadOpen(id, defaultOpen) {
  try {
    const v = localStorage.getItem(memoKey(id));
    return v === null ? defaultOpen : v === "1";
  } catch {
    return defaultOpen;
  }
}
function saveOpen(id, open, defaultOpen) {
  try {
    if (open === defaultOpen) localStorage.removeItem(memoKey(id));
    else localStorage.setItem(memoKey(id), open ? "1" : "0");
  } catch {
    /* プライベートモード等では覚えない */
  }
}

/** 件数の印。tone: "danger"（エラー）| "warn"（確認要求）| "neutral"（参考）。0 件は ✓ */
export function countChip(count, tone = "warn") {
  if (count === null || count === undefined) return null;
  const kind = count === 0 ? "ok" : tone;
  return html`<span class="yn-chip yn-chip-${kind} yn-fold-count">${count === 0 ? "✓" : fmt(T.fold.count, { n: integer(count) })}</span>`;
}

export function foldSection({ id, title, hint = null, count = null, tone = "warn", defaultOpen = true }) {
  let open = loadOpen(id, defaultOpen);
  const bodyId = `${id}-body`;
  const caret = html`<span class="yn-fold-caret" aria-hidden="true"></span>`;
  const btn = html`<button type="button" class="yn-fold-toggle" aria-controls=${bodyId}>${caret}<span>${title}</span></button>`;
  const body = html`<div class="yn-fold-body" id=${bodyId}></div>`;
  const el = html`<section class="yn-fold" id=${id}>
    <div class="yn-section-head yn-fold-head"><div class="yn-title-with-tip"><h2 class="yn-section-title">${btn}</h2>${hint ? infoTip(hint, { label: fmt(T.layout.aboutSection, { title }) }) : null}${countChip(count, tone)}</div></div>
    ${body}
  </section>`;
  const apply = () => {
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    el.classList.toggle("is-closed", !open);
    body.hidden = !open;
  };
  el.setOpen = (v) => {
    open = !!v;
    saveOpen(id, open, defaultOpen);
    apply();
  };
  btn.addEventListener("click", () => el.setOpen(!open));
  apply();
  return { el, body };
}

/** 目次。items: { id, title, count, tone }（count が null の節は件数を出さない） */
export function sectionToc(items, { label = T.fold.tocLabel } = {}) {
  const nav = html`<nav class="yn-toc" aria-label=${label}><ul></ul></nav>`;
  const ul = nav.querySelector("ul");
  for (const it of items) {
    const a = html`<a href=${`#${it.id}`} class=${`yn-toc-link${it.count === 0 ? " is-zero" : ""}`}><span>${it.title}</span>${countChip(it.count, it.tone)}</a>`;
    a.addEventListener("click", (e) => {
      const target = document.getElementById(it.id);
      if (!target) return;
      e.preventDefault();
      target.setOpen?.(true);
      target.scrollIntoView({ block: "start" });
      target.querySelector(".yn-fold-toggle")?.focus({ preventScroll: true });
      try {
        history.replaceState(history.state, "", `#${it.id}`);
      } catch {
        /* 無視 */
      }
    });
    ul.append(html`<li>${a}</li>`);
  }
  return nav;
}
