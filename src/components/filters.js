/**
 * フィルタ行（期間・チーム・着地方式・単位）。store と双方向に同期する。
 * すべてのグラフ・表はこの 1 行の条件で再計算される（グラフごとのフィルタは持たない）。
 */
import { html } from "htl";
import { UNASSIGNED_TEAM_ID, UNASSIGNED_TEAM_LABEL, monthRange } from "../core/index.js";
import { METHOD_DESCRIPTIONS, METHOD_LABELS, UNITS, monthJa } from "./format.js";
import { periodPresets } from "./state.js";

function monthOptions(model, selected) {
  return monthRange(model.meta.minMonth, model.meta.maxMonth).map((m) => html`<option value=${m} selected=${m === selected}>${monthJa(m)}</option>`);
}

function teamOptions(model, selected) {
  const opts = [html`<option value="" selected=${selected === ""}>全体（すべてのチーム）</option>`];
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
    opts.push(html`<optgroup label="過去の組織にのみ存在するチーム">${past.map((t) => html`<option value=${t.teamId} selected=${selected === t.teamId}>${t.name}</option>`)}</optgroup>`);
  }
  opts.push(html`<option value=${UNASSIGNED_TEAM_ID} selected=${selected === UNASSIGNED_TEAM_ID}>${UNASSIGNED_TEAM_LABEL}（主担当チームなし）</option>`);
  return opts;
}

/**
 * filterBar(store, model, { show: ["period", "team", "method", "unit"] })
 */
export function filterBar(store, model, { show = ["period", "team", "method", "unit"], compact = false } = {}) {
  const state = () => store.get();
  const presets = periodPresets(model);
  const form = html`<form class=${`yn-filters${compact ? " is-compact" : ""}`} aria-label="表示条件"></form>`;
  form.addEventListener("submit", (ev) => ev.preventDefault());

  const syncers = [];

  if (show.includes("period")) {
    const from = html`<select class="yn-select" id="yn-filter-from" aria-label="開始月">${monthOptions(model, state().from)}</select>`;
    const to = html`<select class="yn-select" id="yn-filter-to" aria-label="終了月">${monthOptions(model, state().to)}</select>`;
    from.addEventListener("change", () => store.set({ from: from.value, to: from.value > state().to ? from.value : state().to }));
    to.addEventListener("change", () => store.set({ to: to.value, from: to.value < state().from ? to.value : state().from }));
    const presetBtns = presets.map((p) => {
      const b = html`<button type="button" class="yn-seg-btn" data-preset=${p.id}>${p.label}</button>`;
      b.addEventListener("click", () => store.setPeriod(p.period));
      return b;
    });
    const group = html`<fieldset class="yn-filter yn-filter-period">
      <legend>期間</legend>
      <div class="yn-filter-row">
        <label class="visually-hidden" for="yn-filter-from">開始月</label>${from}<span class="yn-filter-sep" aria-hidden="true">〜</span><label class="visually-hidden" for="yn-filter-to">終了月</label>${to}
      </div>
      <div class="yn-seg" role="group" aria-label="期間のプリセット">${presetBtns}</div>
    </fieldset>`;
    form.append(group);
    syncers.push((s) => {
      from.value = s.from;
      to.value = s.to;
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
    form.append(html`<div class="yn-filter yn-filter-team"><label for="yn-filter-team">${model.config.labels?.team ?? "チーム"}</label>${sel}<small class="yn-filter-help">配下のチームを含めて集計</small></div>`);
    syncers.push((s) => {
      sel.value = s.team;
    });
  }

  if (show.includes("method")) {
    const methods = ["recent3", "all", "assignment"];
    const radios = methods.map((m) => {
      const input = html`<input type="radio" name="yn-method" value=${m} id=${`yn-method-${m}`}>`;
      input.addEventListener("change", () => input.checked && store.set({ method: m }));
      return html`<label class="yn-radio" for=${`yn-method-${m}`}>${input}<span>${METHOD_LABELS[m]}</span></label>`;
    });
    const help = html`<small class="yn-filter-help" id="yn-method-help"></small>`;
    form.append(html`<fieldset class="yn-filter yn-filter-method" aria-describedby="yn-method-help"><legend>着地見込みの方式</legend><div class="yn-radio-group">${radios}</div>${help}</fieldset>`);
    syncers.push((s) => {
      for (const r of form.querySelectorAll('input[name="yn-method"]')) r.checked = r.value === s.method;
      help.textContent = METHOD_DESCRIPTIONS[s.method].replace("N", String(model.config.forecastRecentMonths));
    });
  }

  if (show.includes("unit")) {
    const btns = UNITS.map((u) => {
      const b = html`<button type="button" class="yn-seg-btn" data-unit=${u.id}>${u.label}</button>`;
      b.addEventListener("click", () => store.set({ unit: u.id }));
      return b;
    });
    form.append(html`<div class="yn-filter yn-filter-unit"><span class="yn-filter-label" id="yn-unit-label">表示単位</span><div class="yn-seg" role="group" aria-labelledby="yn-unit-label">${btns}</div></div>`);
    syncers.push((s) => {
      for (const b of btns) b.setAttribute("aria-pressed", b.dataset.unit === s.unit ? "true" : "false");
    });
  }

  const sync = (s) => syncers.forEach((f) => f(s));
  sync(state());
  store.subscribe(sync);
  return form;
}
