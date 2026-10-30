/**
 * フィルタ行（期間・チーム・着地方式・単位）。store と双方向に同期する。
 * すべてのグラフ・表はこの 1 行の条件で再計算される（グラフごとのフィルタは持たない）。
 */
import { html } from "htl";
import { UNASSIGNED_TEAM_ID, UNASSIGNED_TEAM_LABEL, monthRange } from "../core/index.js";
import { METHOD_LABELS, UNITS, dateTimeJst, methodDescription, monthJa } from "./format.js";
import { periodPresets } from "./state.js";
import { T } from "../i18n/index.js";

function monthOptions(model, selected) {
  return monthRange(model.meta.minMonth, model.meta.maxMonth).map((m) => html`<option value=${m} selected=${m === selected}>${monthJa(m)}</option>`);
}

function teamOptions(model, selected) {
  const opts = [html`<option value="" selected=${selected === ""}>${T.filters.allTeams}</option>`];
  const seen = new Set();
  const visit = (id, depth) => {
    const node = model.teamTree[id];
    if (!node) return;
    seen.add(id);
    opts.push(html`<option value=${id} selected=${selected === id}>${"　".repeat(depth)}${node.name}</option>`);
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const id of model.rootTeamIds) visit(id, 0);
  const past = [];
  for (const t of model.teams) if (!seen.has(t.teamId) && !past.some((p) => p.teamId === t.teamId)) past.push(t);
  if (past.length) {
    opts.push(html`<optgroup label=${T.filters.pastTeams}>${past.map((t) => html`<option value=${t.teamId} selected=${selected === t.teamId}>${t.name}</option>`)}</optgroup>`);
  }
  opts.push(html`<option value=${UNASSIGNED_TEAM_ID} selected=${selected === UNASSIGNED_TEAM_ID}>${UNASSIGNED_TEAM_LABEL}${T.filters.unassignedSuffix}</option>`);
  return opts;
}

/** その月の末日（YYYY-MM-DD） */
function lastDayOf(month) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(d).padStart(2, "0")}`;
}

/**
 * カレンダーで日付を選ぶ小さなボタン。データは月単位なので、選んだ日付はその月（YYYY-MM）として onPick に渡す。
 * 中の input[type=date] を透明にしてボタン全面に重ね、クリックで各ブラウザのカレンダーを開く
 * （showPicker は埋め込み表示（iframe）では使えないことがあるため、ネイティブのクリックに任せる）。
 */
function datePicker(id, label, model, onPick) {
  const input = html`<input type="date" id=${id} class="yn-date-pick-input" aria-label=${label} title=${label} min=${`${model.meta.minMonth}-01`} max=${lastDayOf(model.meta.maxMonth)}>`;
  input.addEventListener("change", () => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(input.value)) onPick(input.value.slice(0, 7));
  });
  return html`<span class="yn-date-pick"><span class="yn-date-pick-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5 1.5v3M11 1.5v3"/></svg></span>${input}</span>`;
}

/**
 * filterBar(store, model, { show: ["period", "team", "method", "unit"] })
 */
export function filterBar(store, model, { show = ["period", "team", "method", "unit"], compact = false } = {}) {
  const state = () => store.get();
  const presets = periodPresets(model);
  const form = html`<form class=${`yn-filters${compact ? " is-compact" : ""}`} aria-label=${T.filters.formLabel}></form>`;
  form.addEventListener("submit", (ev) => ev.preventDefault());

  const syncers = [];

  if (show.includes("period")) {
    const from = html`<select class="yn-select" id="yn-filter-from" aria-label=${T.filters.from}>${monthOptions(model, state().from)}</select>`;
    const to = html`<select class="yn-select" id="yn-filter-to" aria-label=${T.filters.to}>${monthOptions(model, state().to)}</select>`;
    const setFrom = (m) => store.set({ from: m, to: m > state().to ? m : state().to });
    const setTo = (m) => store.set({ to: m, from: m < state().from ? m : state().from });
    from.addEventListener("change", () => setFrom(from.value));
    to.addEventListener("change", () => setTo(to.value));
    const fromPick = datePicker("yn-filter-from-date", T.filters.pickFrom, model, setFrom);
    const toPick = datePicker("yn-filter-to-date", T.filters.pickTo, model, setTo);
    const fromDate = fromPick.querySelector("input");
    const toDate = toPick.querySelector("input");
    const presetBtns = presets.map((p) => {
      const b = html`<button type="button" class="yn-seg-btn" data-preset=${p.id} title=${p.label}>${p.short ?? p.label}</button>`;
      b.addEventListener("click", () => store.setPeriod(p.period));
      return b;
    });
    const group = html`<fieldset class="yn-filter yn-filter-period">
      <legend>${T.filters.period}</legend>
      <div class="yn-filter-row">
        <label class="visually-hidden" for="yn-filter-from">${T.filters.from}</label>${from}${fromPick}<span class="yn-filter-sep" aria-hidden="true">〜</span><label class="visually-hidden" for="yn-filter-to">${T.filters.to}</label>${to}${toPick}
        <div class="yn-seg" role="group" aria-label=${T.filters.presetsLabel}>${presetBtns}</div>
      </div>
    </fieldset>`;
    form.append(group);
    syncers.push((s) => {
      from.value = s.from;
      to.value = s.to;
      // 日付欄は今の期間の初日・末日を指しておく（カレンダーがその月から開く）
      fromDate.value = `${s.from}-01`;
      toDate.value = lastDayOf(s.to);
      for (const b of presetBtns) {
        const p = presets.find((x) => x.id === b.dataset.preset);
        const on = p.period.from === s.from && p.period.to === s.to;
        b.setAttribute("aria-pressed", on ? "true" : "false");
      }
    });
  }

  if (show.includes("team")) {
    const sel = html`<select class="yn-select" id="yn-filter-team">${teamOptions(model, state().team)}</select>`;
    sel.addEventListener("change", () => store.set({ team: sel.value }));
    form.append(html`<div class="yn-filter yn-filter-team"><label for="yn-filter-team">${model.config.labels?.team ?? T.filters.team}</label>${sel}<small class="yn-filter-help visually-hidden">${T.filters.teamHelp}</small></div>`);
    sel.title = T.filters.teamHelp;
    syncers.push((s) => {
      sel.value = s.team;
    });
  }

  if (show.includes("method")) {
    const methods = ["assignment", "recent3", "all"];
    const radios = methods.map((m) => {
      const input = html`<input type="radio" name="yn-method" value=${m} id=${`yn-method-${m}`}>`;
      input.addEventListener("change", () => input.checked && store.set({ method: m }));
      return html`<label class="yn-radio" for=${`yn-method-${m}`}>${input}<span>${METHOD_LABELS[m]}</span></label>`;
    });
    const help = html`<small class="yn-filter-help visually-hidden" id="yn-method-help"></small>`;
    form.append(html`<fieldset class="yn-filter yn-filter-method" aria-describedby="yn-method-help"><legend>${T.filters.method}</legend><div class="yn-radio-group yn-seg" role="radiogroup">${radios}</div>${help}</fieldset>`);
    syncers.push((s) => {
      for (const r of form.querySelectorAll('input[name="yn-method"]')) r.checked = r.value === s.method;
      help.textContent = methodDescription(s.method, model.config.forecastRecentMonths);
      for (const r of form.querySelectorAll('input[name="yn-method"]')) {
        r.closest("label").title = methodDescription(r.value, model.config.forecastRecentMonths);
      }
    });
  }

  if (show.includes("unit")) {
    const btns = UNITS.map((u) => {
      const b = html`<button type="button" class="yn-seg-btn" data-unit=${u.id}>${u.label}</button>`;
      b.addEventListener("click", () => store.set({ unit: u.id }));
      return b;
    });
    form.append(html`<div class="yn-filter yn-filter-unit"><span class="yn-filter-label" id="yn-unit-label">${T.filters.unit}</span><div class="yn-seg" role="group" aria-labelledby="yn-unit-label">${btns}</div></div>`);
    syncers.push((s) => {
      for (const b of btns) b.setAttribute("aria-pressed", b.dataset.unit === s.unit ? "true" : "false");
    });
  }

  if (show.includes("outside")) {
    // 契約外（提案・会社業務など）を含む／含まない（§50.4）。メンバー別の計画と実績の両方に効く
    const input = html`<input type="checkbox" id="yn-filter-outside">`;
    input.addEventListener("change", () => store.set({ outside: input.checked ? "1" : "0" }));
    form.append(html`<div class="yn-filter yn-filter-outside"><label class="yn-toggle-chip" for="yn-filter-outside" title=${T.filters.outsideTitle}>${input}<span>${T.filters.outsideInclude}</span></label></div>`);
    syncers.push((s) => {
      input.checked = s.outside === "1";
    });
  }

  // 作業実績の取得日時（mountFilterBar で上段の単位の左に移す）
  const fetchedAt = model.meta?.worklogFetchedAt;
  if (fetchedAt) {
    form.append(html`<div class="yn-filter-fetched"><span>${T.layout.fetchedAt}</span><time datetime=${fetchedAt}>${dateTimeJst(fetchedAt)}</time></div>`);
  }

  const sync = (s) => syncers.forEach((f) => f(s));
  sync(state());
  store.subscribe(sync);
  return form;
}

/**
 * フィルタ行を上部ヘッダの固定バー（#yn-filterbar-slot）に差し込む。差し込み口が無ければ null を返す。
 * ページでは display(filterBar(...)) の代わりに mountFilterBar(store, model, { show }) を呼ぶ。
 */
export function mountFilterBar(store, model, options = {}) {
  const form = filterBar(store, model, options);
  const slot = document.getElementById("yn-filterbar-slot");
  if (!slot) return form;
  slot.replaceChildren(form);
  slot.classList.add("is-filled");
  // 表示単位は「見せ方」の設定なので、絞り込みとは分けて上段（右上）に置く
  // 作業実績の取得日時も、スクロールしても見えるよう同じ上段に置く（§65）
  const unit = form.querySelector(".yn-filter-unit");
  const fetched = form.querySelector(".yn-filter-fetched");
  const unitSlot = document.getElementById("yn-unit-slot");
  if ((unit || fetched) && unitSlot) unitSlot.replaceChildren(...[fetched, unit].filter(Boolean));
  return null;
}
