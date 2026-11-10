/**
 * 文字を打つと候補が絞り込まれる入力欄（SPEC §31.2）。数百件の中から名前で選ぶ。
 *
 *   combobox({ id, name, options, value, ... }) → HTMLElement
 *
 * - options: [{ value, label, sub?, search? }]。label は欄に出す名前、sub は候補の補足（所属など）、
 *   search は表示しないが一致に使う文字（ID など）、muted は薄く出す候補（契約期間外の案件など。選べる）
 *   options は関数でもよい（候補を開くたびに呼ぶ。引数はこの部品の要素。フォームの他の欄に合わせて印を変えるとき）
 * - 選んだ値は name の hidden input に入る（フォームの読み取りは従来どおり name で引ける）
 * - 候補に無い文字のまま離れたら、直前の値に戻す。allowCustom なら打った文字を値にする
 * - WAI-ARIA の combobox（listbox ポップアップ）。↑↓ で移動、Enter で決定、Esc で閉じる
 */
import { html } from "htl";
import { T, fmt } from "../i18n/index.js";

export const COMBO_MAX = 50;

/** 一致用の正規化（全角・半角、大文字・小文字、空白を区別しない） */
export function normalizeQuery(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 候補を絞り込む（純粋関数。テストする）。空白で区切った語をすべて含むもの。
 * 並びは「名前の先頭一致」→「名前に含む」→「補足・検索語だけに含む」、同じ順位は元の順。薄い候補（muted）はいつも後ろ
 */
export function filterOptions(options, query) {
  const terms = normalizeQuery(query).split(" ").filter(Boolean);
  if (terms.length === 0) return options.slice();
  const ranked = [];
  options.forEach((o, i) => {
    const label = normalizeQuery(o.label).replace(/ /g, "");
    const all = `${label} ${normalizeQuery(o.sub)} ${normalizeQuery(o.search)}`;
    const allTight = all.replace(/ /g, "");
    if (!terms.every((t) => all.includes(t) || allTight.includes(t.replace(/ /g, "")))) return;
    const first = terms[0];
    const rank = label.startsWith(first) ? 0 : label.includes(first) ? 1 : 2;
    ranked.push({ o, rank, i });
  });
  ranked.sort((a, b) => Number(!!a.o.muted) - Number(!!b.o.muted) || a.rank - b.rank || a.i - b.i);
  return ranked.map((r) => r.o);
}

let seq = 0;

export function combobox({ id, name, options, value = "", required = false, disabled = false, placeholder = "", describedBy = null, allowCustom = false, unknownLabel = null, onChange = null }) {
  const listId = `${id}-listbox`;
  const uid = ++seq;
  let rootEl = null;
  const optionsOf = typeof options === "function" ? () => options(rootEl) : () => options;
  /** 名前の引き当て用（値 → 候補）。値と名前は期間で変わらないので最初の 1 回で作る */
  let byValue = null;
  const lookup = () => (byValue ??= new Map(optionsOf().map((o) => [o.value, o])));
  let current = value;
  const labelOf = (v) => {
    if (v === "") return "";
    const o = lookup().get(v);
    if (o) return o.label;
    return unknownLabel ? unknownLabel(v) : v;
  };

  const hidden = html`<input type="hidden" name=${name} value=${current}>`;
  const input = html`<input id=${id} class="yn-input yn-combo-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls=${listId} autocomplete="off" spellcheck="false" placeholder=${placeholder} value=${labelOf(current)} required=${required} disabled=${disabled} aria-describedby=${describedBy}>`;
  const list = html`<ul id=${listId} class="yn-combo-list" role="listbox" hidden></ul>`;
  const toggle = html`<button type="button" class="yn-combo-toggle" tabindex="-1" aria-label=${T.combo.showAll} disabled=${disabled}><span aria-hidden="true">▾</span></button>`;
  const status = html`<span class="visually-hidden" aria-live="polite"></span>`;
  const root = html`<span class="yn-combo">${input}${toggle}${hidden}${list}${status}</span>`;
  rootEl = root;

  let shown = [];
  let active = -1;
  let open = false;

  const set = (v, { notify = true } = {}) => {
    const changed = v !== current;
    current = v;
    hidden.value = v;
    input.value = labelOf(v);
    if (changed && notify) {
      onChange?.(v);
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };

  const optionId = (i) => `${id}-opt-${uid}-${i}`;
  const highlight = (i) => {
    active = i;
    for (const li of list.children) li.classList.toggle("is-active", li.dataset.index === String(i));
    if (i >= 0) {
      input.setAttribute("aria-activedescendant", optionId(i));
      list.querySelector(`[data-index="${i}"]`)?.scrollIntoView?.({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };

  const render = (query) => {
    const all = filterOptions(optionsOf(), query);
    shown = all.slice(0, COMBO_MAX);
    const items = shown.map((o, i) => {
      const li = html`<li id=${optionId(i)} role="option" class=${o.muted ? "yn-combo-opt is-muted" : "yn-combo-opt"} data-index=${String(i)} aria-selected=${o.value === current ? "true" : "false"}><span class="yn-combo-label">${o.label}</span>${o.sub ? html`<span class="yn-combo-sub">${o.sub}</span>` : null}</li>`;
      // mousedown で決める（click だと先に input の blur が走って閉じてしまう）
      li.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        choose(i);
      });
      return li;
    });
    if (shown.length === 0) items.push(html`<li class="yn-combo-empty" role="presentation">${allowCustom && query.trim() ? fmt(T.combo.useTyped, { text: query.trim() }) : T.combo.noMatch}</li>`);
    if (all.length > shown.length) items.push(html`<li class="yn-combo-more" role="presentation">${fmt(T.combo.more, { n: all.length - shown.length })}</li>`);
    list.replaceChildren(...items);
    status.textContent = fmt(T.combo.count, { n: all.length });
    const sel = shown.findIndex((o) => o.value === current);
    highlight(query.trim() ? (shown.length ? 0 : -1) : sel);
  };

  const openList = (query = "") => {
    if (disabled) return;
    open = true;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    render(query);
  };
  const closeList = () => {
    open = false;
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    highlight(-1);
  };

  function choose(i) {
    const o = shown[i];
    if (!o) return;
    set(o.value);
    closeList();
    input.focus();
    input.select?.();
  }

  /** 欄を離れる・Enter で打った文字を確定する */
  const settle = () => {
    const text = input.value.trim();
    if (text === "") {
      set("");
      return;
    }
    if (text === labelOf(current)) return;
    const exact = optionsOf().filter((o) => normalizeQuery(o.label) === normalizeQuery(text));
    if (exact.length === 1) set(exact[0].value);
    else if (allowCustom) set(text);
    else input.value = labelOf(current);
  };

  input.addEventListener("input", () => openList(input.value));
  input.addEventListener("click", () => {
    if (!open) openList("");
  });
  toggle.addEventListener("mousedown", (ev) => ev.preventDefault());
  toggle.addEventListener("click", () => {
    if (open) closeList();
    else {
      input.focus();
      openList("");
    }
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.isComposing || ev.keyCode === 229) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!open) {
        openList("");
        return;
      }
      if (shown.length === 0) return;
      const d = ev.key === "ArrowDown" ? 1 : -1;
      highlight(active < 0 ? (d > 0 ? 0 : shown.length - 1) : (active + d + shown.length) % shown.length);
    } else if (ev.key === "Enter") {
      if (open) {
        // 開いている候補で決める。フォームは送らない
        ev.preventDefault();
        if (active >= 0) choose(active);
        else {
          settle();
          closeList();
        }
      } else settle();
    } else if (ev.key === "Escape") {
      if (open) {
        // 候補だけ閉じる（ダイアログは閉じない）
        ev.preventDefault();
        ev.stopPropagation();
        closeList();
        input.value = labelOf(current);
      }
    } else if (ev.key === "Tab") {
      if (open && active >= 0 && input.value.trim() !== "" && input.value.trim() !== labelOf(current)) choose(active);
      closeList();
    }
  });
  input.addEventListener("blur", () => {
    closeList();
    settle();
  });

  /** 外から値を入れる（通知しない） */
  root.setValue = (v) => set(v, { notify: false });
  root.getValue = () => current;
  root.input = input;
  return root;
}
