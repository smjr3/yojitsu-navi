/**
 * 稼働計画のセル（SPEC §31.4）の吹き出しと、その場で修正する小さな編集欄の置き場所
 *
 *   planCellTooltip() → { el, show(anchor, content), hide() }
 *   planCellEditor() → { el, open(anchor, content, { onClose }), close() }
 *
 * どちらも position: fixed。セルの下に出し、入らなければ上、どちらにも入らなければ画面内に収める。
 * 中身（内訳・入力欄）は masters.js が作る。ここは出し入れと位置だけ。
 */
import { html } from "htl";

/** anchor の下（入らなければ上）に el を置く。横は画面内に収める */
export function placeNear(el, anchor, { width = 320, gap = 6, margin = 8 } = {}) {
  const r = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const w = Math.min(width, vw - margin * 2);
  el.style.width = `${w}px`;
  el.style.left = `${Math.max(margin, Math.min(r.left + r.width / 2 - w / 2, vw - w - margin))}px`;
  const h = el.offsetHeight;
  const below = r.bottom + gap;
  const above = r.top - gap - h;
  el.style.top = `${below + h <= vh - margin ? below : above >= margin ? above : Math.max(margin, vh - margin - h)}px`;
}

export function planCellTooltip() {
  const el = html`<div class="yn-plan-tip" role="tooltip" id="yn-plan-tip" hidden></div>`;
  let anchor = null;
  const onScroll = () => hide();
  function show(a, content) {
    anchor = a;
    el.replaceChildren(content);
    el.hidden = false;
    placeNear(el, a, { width: 300 });
    a.setAttribute("aria-describedby", "yn-plan-tip");
    addEventListener("scroll", onScroll, { passive: true, capture: true });
  }
  function hide() {
    el.hidden = true;
    anchor?.removeAttribute("aria-describedby");
    anchor = null;
    removeEventListener("scroll", onScroll, { capture: true });
  }
  return { el, show, hide };
}

export function planCellEditor() {
  // showModal でフォーカスを閉じ込め、Esc で閉じる。背景は透明（外側のクリックで閉じる）
  const el = html`<dialog class="yn-plan-pop" aria-labelledby="yn-plan-pop-title"></dialog>`;
  let anchor = null;
  let onClose = null;
  const isSheet = () => document.documentElement.clientWidth < 640;
  // 狭い画面は画面下に寄せたシート（CSS）。広い画面はセルの近く。
  // 開いたまま画面幅が変わったとき（回転・ウィンドウの縮小）も、広い画面で付けた位置を外してシートに戻す
  const place = () => {
    if (!anchor || !el.open) return;
    if (isSheet()) {
      el.style.removeProperty("left");
      el.style.removeProperty("top");
      el.style.removeProperty("width");
    } else placeNear(el, anchor, { width: 380 });
  };
  const reposition = place;
  el.addEventListener("click", (ev) => {
    if (ev.target === el) el.close();
  });
  el.addEventListener("close", () => {
    removeEventListener("resize", reposition);
    const cb = onClose;
    onClose = null;
    anchor = null;
    el.replaceChildren();
    cb?.();
  });
  function open(a, content, opts = {}) {
    anchor = a;
    onClose = opts.onClose ?? null;
    el.replaceChildren(content);
    if (!el.open) el.showModal();
    place();
    addEventListener("resize", reposition);
  }
  /** 中身の高さが変わったとき（注記を出したときなど）に置き直す */
  function refresh() {
    reposition();
  }
  return { el, open, close: () => el.open && el.close(), refresh };
}
