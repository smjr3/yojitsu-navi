/**
 * 表の列の表示・並び順（SPEC §106）。一覧表（dataTable）とマスタ編集の台帳で共通。
 * 設定は画面と表ごとにこのブラウザ（localStorage）に覚える: {order: [列 key], hidden: [列 key]}
 * 先頭（名前）の列は固定（行の見出し・詳細へのリンク・横スクロールで左に貼り付く列のため）
 */
import { html } from "htl";
import { T, fmt } from "../i18n/index.js";

const PREFIX = "yojitsu-navi:columns:";

/** 今開いている画面での設定（保存できない環境・容量切れでも、変えた設定はこの画面のあいだ効かせる） */
const memory = new Map();

/** 覚えた設定。壊れた値・無い値は空 */
export function loadColumnPrefs(id) {
  if (memory.has(id)) return memory.get(id);
  try {
    const v = JSON.parse(localStorage.getItem(PREFIX + id) ?? "null");
    const keys = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === "string") : []);
    return { order: keys(v?.order), hidden: keys(v?.hidden) };
  } catch {
    return { order: [], hidden: [] };
  }
}

export function saveColumnPrefs(id, prefs) {
  memory.set(id, { order: [...prefs.order], hidden: [...prefs.hidden] });
  try {
    if (!prefs.order.length && !prefs.hidden.length) localStorage.removeItem(PREFIX + id);
    else localStorage.setItem(PREFIX + id, JSON.stringify({ order: prefs.order, hidden: prefs.hidden }));
  } catch {
    /* プライベートモード等では覚えない */
  }
}

/**
 * 列を覚えた順に並べる（隠した列も残す）。覚えた後に増えた列は既定の位置に入る:
 * 覚えた列が既定で占めていた位置を、覚えた順で埋め直す
 */
export function orderColumns(cols, prefs, keyOf = (c) => c.key) {
  const pos = new Map(prefs.order.map((k, i) => [k, i]));
  const known = cols.filter((c) => pos.has(keyOf(c))).sort((a, b) => pos.get(keyOf(a)) - pos.get(keyOf(b)));
  let i = 0;
  return cols.map((c) => (pos.has(keyOf(c)) ? known[i++] : c));
}

/** 表示する列（並べ替え後、隠した列を除く） */
export function arrangeColumns(cols, prefs, keyOf = (c) => c.key) {
  const hidden = new Set(prefs.hidden);
  return orderColumns(cols, prefs, keyOf).filter((c) => !hidden.has(keyOf(c)));
}

/** 既定から変えているか（ボタンの印） */
export function isCustomized(cols, prefs, keyOf = (c) => c.key) {
  const keys = new Set(cols.map(keyOf));
  if (prefs.hidden.some((k) => keys.has(k))) return true;
  const ordered = orderColumns(cols, prefs, keyOf);
  return ordered.some((c, i) => c !== cols[i]);
}

let open = null;

export function closeColumnPop({ focus = false } = {}) {
  if (!open) return;
  const o = open;
  open = null;
  o.cleanup();
  o.pop.remove();
  const btn = o.anchor();
  if (btn) {
    btn.setAttribute("aria-expanded", "false");
    if (focus) btn.focus();
  }
}

const COLS_ICON = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M1 2h2.5v8H1zM4.75 2h2.5v8h-2.5zM8.5 2H11v8H8.5z" fill="currentColor"/></svg>';

/**
 * 列の設定のボタン。押すと列の一覧（表示のチェックと ↑↓）を出す。
 * columns: 設定できる列 [{key, label}]（先頭の固定列は含めない）、id: 覚える名前、
 * onChange(prefs): 変えたとき（表を描き直す）、anchor(): 描き直しで替わったボタンを探す（既定はこのボタン）
 */
export function columnsButton({ id, columns, onChange, anchor = null, fk = null }) {
  const btn = html`<button type="button" class="yn-btn yn-btn-sm yn-cols-btn" aria-haspopup="dialog" aria-expanded="false" title=${T.table.columnsButton}></button>`;
  btn.innerHTML = `${COLS_ICON}<span class="yn-cols-btn-text"></span>`;
  btn.querySelector(".yn-cols-btn-text").textContent = T.table.columnsButton;
  if (fk) btn.dataset.fk = fk;
  const getAnchor = anchor ?? (() => (btn.isConnected ? btn : null));
  const mark = () => btn.classList.toggle("is-active", isCustomized(columns, loadColumnPrefs(id)));
  mark();
  if (open && open.id === id) {
    // 描き直しで作り直されたボタン: 開いている一覧を付け直す
    btn.setAttribute("aria-expanded", "true");
    queueMicrotask(() => open?.place());
  }
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (open && open.id === id) closeColumnPop();
    else openPop({ id, columns, onChange, anchor: getAnchor, mark });
  });
  return btn;
}

function openPop({ id, columns, onChange, anchor, mark }) {
  closeColumnPop();
  const pop = html`<div class="yn-filter-pop yn-cols-pop" role="dialog" aria-label=${T.table.columnsTitle}></div>`;
  const list = html`<ul class="yn-cols-list"></ul>`;
  const reset = html`<button type="button" class="yn-btn yn-btn-sm">${T.table.columnsReset}</button>`;
  const close = html`<button type="button" class="yn-btn yn-btn-sm">${T.table.filterClose}</button>`;
  pop.append(list, html`<div class="yn-filter-pop-actions">${reset}${close}</div>`);

  const apply = (prefs, focusSel = null) => {
    saveColumnPrefs(id, prefs);
    onChange(prefs);
    mark();
    draw(focusSel);
    open?.place();
  };
  const draw = (focusSel = null) => {
    const prefs = loadColumnPrefs(id);
    const ordered = orderColumns(columns, prefs);
    const hidden = new Set(prefs.hidden);
    const shownCount = ordered.filter((c) => !hidden.has(c.key)).length;
    list.replaceChildren(
      ...ordered.map((c, i) => {
        const on = !hidden.has(c.key);
        const box = html`<input type="checkbox" checked=${on}>`;
        // 最後の 1 列は外せない（先頭の固定列だけの表にならないように）
        box.disabled = on && shownCount <= 1;
        box.addEventListener("change", () => {
          const p = loadColumnPrefs(id);
          const h = new Set(p.hidden);
          if (box.checked) h.delete(c.key);
          else h.add(c.key);
          apply({ order: ordered.map((x) => x.key), hidden: [...h] }, `[data-col="${i}"] input`);
        });
        const move = (d, dir) => {
          const b = html`<button type="button" class="yn-btn yn-btn-sm yn-cols-move" aria-label=${fmt(d < 0 ? T.table.columnsUp : T.table.columnsDown, { label: c.label })} title=${fmt(d < 0 ? T.table.columnsUp : T.table.columnsDown, { label: c.label })}><span aria-hidden="true">${dir}</span></button>`;
          const j = i + d;
          b.disabled = j < 0 || j >= ordered.length;
          b.dataset.dir = d < 0 ? "up" : "down";
          b.addEventListener("click", () => {
            const keys = ordered.map((x) => x.key);
            [keys[i], keys[j]] = [keys[j], keys[i]];
            // 端まで動かしてボタンが押せなくなったら、反対向きのボタンへ
            const edge = j === 0 || j === ordered.length - 1;
            apply({ order: keys, hidden: loadColumnPrefs(id).hidden }, `[data-col="${j}"] .yn-cols-move[data-dir="${edge ? (d < 0 ? "down" : "up") : d < 0 ? "up" : "down"}"]`);
          });
          return b;
        };
        const li = html`<li class=${`yn-cols-item${on ? "" : " is-off"}`} data-col=${String(i)} data-key=${c.key}><label class="yn-filter-item">${box}<span class="yn-filter-item-text">${c.label}</span></label>${move(-1, "↑")}${move(1, "↓")}</li>`;
        return li;
      }),
    );
    reset.disabled = !isCustomized(columns, prefs);
    if (focusSel) list.querySelector(focusSel)?.focus();
  };
  reset.addEventListener("click", () => {
    apply({ order: [], hidden: [] });
    close.focus();
  });
  close.addEventListener("click", () => closeColumnPop({ focus: true }));
  document.body.append(pop);

  const place = () => {
    const a = anchor();
    if (!a) return;
    const r = a.getBoundingClientRect();
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
  const onDown = (e) => {
    if (pop.contains(e.target) || anchor()?.contains(e.target)) return;
    closeColumnPop();
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeColumnPop({ focus: true });
    }
  };
  const onScroll = (e) => {
    if (e.target instanceof Node && pop.contains(e.target)) return;
    const a = anchor();
    const r = a?.getBoundingClientRect();
    if (!a || r.bottom < 0 || r.top > document.documentElement.clientHeight) closeColumnPop();
    else place();
  };
  const onResize = () => closeColumnPop();
  document.addEventListener("pointerdown", onDown, true);
  pop.addEventListener("keydown", onKey);
  addEventListener("scroll", onScroll, { passive: true, capture: true });
  addEventListener("resize", onResize);
  open = {
    id,
    pop,
    anchor,
    place,
    cleanup: () => {
      document.removeEventListener("pointerdown", onDown, true);
      removeEventListener("scroll", onScroll, { capture: true });
      removeEventListener("resize", onResize);
    },
  };
  anchor()?.setAttribute("aria-expanded", "true");
  draw();
  place();
  list.querySelector("input:not(:disabled)")?.focus();
}
