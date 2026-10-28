/**
 * マージ待ちの変更（SPEC §26）: この画面から作った GitLab の MR の一覧・内容・マージ・取り下げ
 *
 *   const panel = mergeRequestsPanel({ cfg, fetchImpl, now })
 *   panel.el → HTMLElement、panel.refresh() → 読み直す
 *
 * マージボタンは GitLab の user.can_merge が true の人（リーダー = Maintainer）にだけ出す。権限の強制は GitLab 側。
 */
import { html } from "htl";
import { T, fmt } from "../i18n/index.js";
import { closeMergeRequest, fetchCurrentUser, getMergeRequest, gitlabConfigured, listMasterMergeRequests, mergeMergeRequest, mergeRequestFileChanges } from "../core/gitlab.js";
import { MASTER_FILES, MASTER_FILE_IDS, diffMasterDoc, parseMasterDoc } from "../core/masterEdit.js";
import { docFromCsvText } from "../core/csvEdit.js";
import { getToken, publishMrCount } from "./gitlab-client.js";
import { dateTimeJst, integer } from "./format.js";
import { infoTip } from "./layout.js";

const PIPE_CHIP = { success: "yn-chip-ok", failed: "yn-chip-warn" };

/** MR で変わったマスタの行（§19 の差分と同じ形） */
function fileDiff(fileId, before, after) {
  const doc = parseMasterDoc(fileId, before ?? "");
  const r = docFromCsvText(doc, after ?? "");
  return r.doc ? diffMasterDoc(r.doc) : null;
}

function rowKey(def, rec) {
  const time = def.history === "effective" ? rec.effective_from : rec.start_month;
  return [...def.keyColumns.map((k) => (rec[k] ?? "").trim()), (time ?? "").trim()].filter((v) => v !== "").join(" / ");
}

/** 追加した行の値（キー列・適用開始月はキーとして別に出すので除く） */
function valuesText(def, rec) {
  const skip = new Set([...def.keyColumns, "effective_from", "start_month"]);
  return def.columns
    .filter((col) => !skip.has(col.name) && (rec[col.name] ?? "").trim() !== "")
    .map((col) => `${col.label}: ${(rec[col.name] ?? "").trim()}`)
    .join(" / ");
}

export function mergeRequestsPanel({ cfg, fetchImpl, now = () => new Date() }) {
  const el = html`<div class="yn-mr-slot"></div>`;
  const dialog = html`<dialog class="yn-dialog yn-me-dialog" aria-labelledby="yn-mr-dialog-title"></dialog>`;
  dialog.addEventListener("click", (ev) => ev.target === dialog && dialog.close());
  let returnFocus = null;
  dialog.addEventListener("close", () => {
    dialog.replaceChildren();
    returnFocus?.focus?.();
  });
  /** {status: "idle"|"loading"|"ok"|"error", items: [{detail, open, changes}], error, notice} */
  let state = { status: "idle", items: [], error: null, notice: null, busy: null };
  let seq = 0;
  /** トークンの持ち主の username（自分の MR は取り下げられる） */
  let me = null;
  let meToken = null;

  const enabled = () => gitlabConfigured(cfg);
  const fk = (key) => el.querySelector(`[data-fk="${CSS.escape(key)}"]`);

  async function refresh({ notice = null } = {}) {
    if (!enabled()) return render();
    const token = getToken();
    if (token === "") {
      state = { status: "idle", items: [], error: null, notice, busy: null };
      return render();
    }
    const my = ++seq;
    state = { ...state, status: "loading", notice };
    render();
    try {
      if (meToken !== token) {
        me = (await fetchCurrentUser(fetchImpl, cfg, token)).username;
        meToken = token;
      }
      const list = await listMasterMergeRequests(fetchImpl, cfg, token);
      const details = await Promise.all(list.map((m) => getMergeRequest(fetchImpl, cfg, token, m.iid).catch(() => ({ ...m, canMerge: false, headSha: null, baseSha: null, pipelineStatus: null, mergeStatus: null }))));
      if (my !== seq) return;
      const prevOpen = new Set(state.items.filter((i) => i.open).map((i) => i.detail.iid));
      state = { status: "ok", items: details.map((d) => ({ detail: d, open: prevOpen.has(d.iid), changes: null })), error: null, notice, busy: null };
      publishMrCount(details.length);
      for (const it of state.items) if (it.open) loadChanges(it);
    } catch (e) {
      if (my !== seq) return;
      state = { status: "error", items: [], error: { message: e?.message ?? String(e), detail: e?.detail ?? "" }, notice, busy: null };
    }
    render();
  }

  async function loadChanges(item) {
    item.changes = { status: "loading" };
    render();
    try {
      const paths = MASTER_FILE_IDS.map((id) => MASTER_FILES[id].path);
      const changes = await mergeRequestFileChanges(fetchImpl, cfg, getToken(), item.detail, paths);
      item.changes = {
        status: "ok",
        files: changes.map((c) => {
          const id = MASTER_FILE_IDS.find((x) => MASTER_FILES[x].path === c.path);
          return { path: c.path, id, diff: id ? fileDiff(id, c.before, c.after) : null };
        }),
      };
    } catch (e) {
      item.changes = { status: "error", message: e?.message ?? String(e) };
    }
    render();
  }

  function toggle(item) {
    item.open = !item.open;
    if (item.open && !item.changes) loadChanges(item);
    else render();
    fk(`mr:toggle:${item.detail.iid}`)?.focus();
  }

  function confirm(kind, item, opener) {
    const d = item.detail;
    const isMerge = kind === "merge";
    returnFocus = opener;
    dialog.replaceChildren(html`<div class="yn-dialog-inner">
      <header class="yn-dialog-head">
        <h2 id="yn-mr-dialog-title" class="yn-dialog-title">${isMerge ? T.mr.confirmMergeTitle : T.mr.confirmCloseTitle}</h2>
        <button type="button" class="yn-btn yn-btn-icon" aria-label=${T.breakdown.close} onclick=${() => dialog.close()}>×</button>
      </header>
      <div class="yn-dialog-body">
        <p>${fmt(isMerge ? T.mr.confirmMergeText : T.mr.confirmCloseText, { iid: d.iid, title: d.title, branch: cfg.gitlab.targetBranch })}</p>
        ${isMerge && item.changes?.status === "ok" ? html`<ul class="yn-mr-summary">${summaryLines(item)}</ul>` : isMerge ? html`<p class="yn-me-small">${T.mr.confirmMergeCheck}</p>` : null}
        <div class="yn-me-form-foot">
          <button type="button" class="yn-btn" onclick=${() => dialog.close()}>${T.mr.cancel}</button>
          <button type="button" class="yn-btn yn-btn-primary" data-role="mr-confirm" onclick=${() => {
            returnFocus = null;
            dialog.close();
            run(kind, item);
          }}>${isMerge ? T.mr.confirmMerge : T.mr.confirmClose}</button>
        </div>
      </div>
    </div>`);
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('[data-role="mr-confirm"]').focus();
  }

  async function run(kind, item) {
    const d = item.detail;
    state = { ...state, busy: { kind, iid: d.iid }, notice: null };
    render();
    try {
      if (kind === "merge") await mergeMergeRequest(fetchImpl, cfg, getToken(), d.iid, d.headSha);
      else await closeMergeRequest(fetchImpl, cfg, getToken(), d.iid);
      const text = kind === "merge" ? fmt(cfg.mode === "demo" ? T.mr.mergedDemo : T.mr.merged, { iid: d.iid }) : fmt(T.mr.closed, { iid: d.iid });
      await refresh({ notice: { kind: "ok", text } });
    } catch (e) {
      state = { ...state, busy: null, notice: { kind: "error", text: e?.message ?? String(e), detail: e?.detail ?? "" } };
      render();
    }
    fk("mr:notice")?.focus();
  }

  function summaryLines(item) {
    if (item.changes?.status !== "ok") return [];
    return item.changes.files.map((f) =>
      html`<li>${f.diff ? fmt(T.mr.fileSummary, { file: MASTER_FILES[f.id].label, added: integer(f.diff.added.length), changed: integer(f.diff.changed.length), removed: integer(f.diff.removed.length) }) : fmt(T.mr.otherFile, { path: f.path })}</li>`,
    );
  }

  function renderChanges(item) {
    const c = item.changes;
    if (!c || c.status === "loading") return html`<p class="yn-me-small" role="status">${T.mr.changesLoading}</p>`;
    if (c.status === "error") return html`<p class="yn-note yn-note-warn">${T.mr.changesFailed} ${c.message}</p>`;
    if (c.files.length === 0) return html`<p class="yn-me-small">${T.mr.noFileChanges}</p>`;
    return c.files.map((f) => {
      if (!f.diff) return html`<p class="yn-me-small">${fmt(T.mr.otherFile, { path: f.path })}</p>`;
      const def = MASTER_FILES[f.id];
      const label = (name) => def.columns.find((col) => col.name === name)?.label ?? name;
      const rows = [
        ...f.diff.added.map((r) => ({ chip: "yn-chip-ok", sign: "＋", kind: T.masters.added, key: rowKey(def, r.after), text: valuesText(def, r.after) })),
        ...f.diff.changed.map((r) => ({ chip: "yn-chip-neutral", sign: "✎", kind: T.masters.changed, key: rowKey(def, r.before), text: r.columns.map((col) => `${label(col)}: ${(r.before[col] ?? "").trim() || T.masters.emptyValue} → ${(r.after[col] ?? "").trim() || T.masters.emptyValue}`).join(" / ") })),
        ...f.diff.removed.map((r) => ({ chip: "yn-chip-neutral", sign: "−", kind: T.masters.removedChip, key: rowKey(def, r.before), text: T.masters.wholeRowDeleted })),
      ];
      return html`<div class="yn-mr-file">
        <h4 class="yn-mr-file-title">${fmt(T.mr.fileSummary, { file: def.label, added: integer(f.diff.added.length), changed: integer(f.diff.changed.length), removed: integer(f.diff.removed.length) })}</h4>
        <ul class="yn-mr-rows">${rows.map((r) => html`<li><span class=${`yn-chip ${r.chip}`}>${r.sign} ${r.kind}</span> <span class="yn-mr-key">${r.key}</span> <span class="yn-mr-text">${r.text}</span></li>`)}</ul>
      </div>`;
    });
  }

  function renderItem(item) {
    const d = item.detail;
    const busy = state.busy?.iid === d.iid ? state.busy.kind : null;
    const pipe = d.pipelineStatus ? (T.mr.pipelineStatus[d.pipelineStatus] ?? d.pipelineStatus) : null;
    const mine = d.author.username !== "" && d.author.username === me;
    return html`<li class="yn-mr-item" data-iid=${d.iid}>
      <div class="yn-mr-head">
        <p class="yn-mr-title"><span class="yn-mr-iid">!${d.iid}</span> ${d.title}</p>
        <p class="yn-mr-meta">
          <span>${fmt(T.mr.by, { name: d.author.name || d.author.username })}</span>
          ${d.createdAt ? html`<span>${fmt(T.mr.createdAt, { at: dateTimeJst(d.createdAt) })}</span>` : null}
          ${pipe ? html`<span class=${`yn-chip ${PIPE_CHIP[d.pipelineStatus] ?? "yn-chip-neutral"}`}>${T.mr.pipeline}: ${pipe}</span>` : null}
          ${d.hasConflicts ? html`<span class="yn-chip yn-chip-warn"><span aria-hidden="true">!</span> ${T.mr.conflict}</span>` : null}
          ${d.webUrl ? html`<a href=${d.webUrl} target="_blank" rel="noopener">${T.mr.openInGitlab}</a>` : null}
        </p>
      </div>
      <div class="yn-mr-actions">
        <button type="button" class="yn-btn yn-btn-sm" aria-expanded=${String(item.open)} data-fk=${`mr:toggle:${d.iid}`} onclick=${() => toggle(item)}>${item.open ? T.mr.hideChanges : T.mr.showChanges}</button>
        ${d.canMerge
          ? html`<button type="button" class="yn-btn yn-btn-sm yn-btn-primary" data-fk=${`mr:merge:${d.iid}`} aria-label=${fmt(T.mr.mergeAria, { iid: d.iid, title: d.title })} disabled=${!!state.busy} onclick=${(e) => confirm("merge", item, e.currentTarget)}>${busy === "merge" ? T.mr.merging : T.mr.merge}</button>`
          : html`<span class="yn-me-small yn-mr-nomerge">${T.mr.cannotMerge}</span>`}
        ${d.canMerge || mine ? html`<button type="button" class="yn-btn yn-btn-sm" data-fk=${`mr:close:${d.iid}`} aria-label=${fmt(T.mr.closeAria, { iid: d.iid, title: d.title })} disabled=${!!state.busy} onclick=${(e) => confirm("close", item, e.currentTarget)}>${busy === "close" ? T.mr.closing : T.mr.close}</button>` : null}
      </div>
      ${item.open ? html`<div class="yn-mr-changes">${renderChanges(item)}</div>` : null}
    </li>`;
  }

  function render() {
    if (!enabled()) {
      el.replaceChildren();
      return;
    }
    const token = getToken();
    const n = state.status === "ok" ? state.items.length : null;
    let body;
    if (token === "") body = html`<p class="yn-mr-empty">${T.mr.noToken} <a href="./settings">${T.mr.toSettings}</a></p>`;
    else if (state.status === "loading" && state.items.length === 0) body = html`<p class="yn-mr-empty" role="status">${T.mr.loading}</p>`;
    else if (state.status === "error") body = html`<p class="yn-note yn-note-warn">${T.mr.loadFailed} ${state.error.message}${state.error.detail ? html` <code>${state.error.detail}</code>` : null}</p>`;
    else if (state.items.length === 0) body = html`<p class="yn-mr-empty">${T.mr.none}</p>`;
    else body = html`<ul class="yn-mr-list">${state.items.map(renderItem)}</ul>`;
    const notice = state.notice
      ? html`<div class=${`yn-me-outcome ${state.notice.kind === "ok" ? "is-ok" : "is-error"}`} role=${state.notice.kind === "ok" ? "status" : "alert"} tabindex="-1" data-fk="mr:notice"><p>${state.notice.text}</p>${state.notice.detail ? html`<p class="yn-me-small"><code>${state.notice.detail}</code></p>` : null}</div>`
      : null;
    el.replaceChildren(html`<section class="yn-me-section yn-mr" aria-labelledby="yn-mr-title">
      <div class="yn-mr-bar">
        <div class="yn-title-with-tip"><h2 id="yn-mr-title" class="yn-section-title">${T.mr.title}${n ? html` <span class="yn-mr-count">${fmt(T.mr.countLabel, { n: integer(n) })}</span>` : null}</h2>${infoTip(T.mr.hint, { label: fmt(T.layout.aboutSection, { title: T.mr.title }) })}</div>
        ${token !== "" ? html`<button type="button" class="yn-btn yn-btn-sm" data-fk="mr:refresh" disabled=${state.status === "loading"} onclick=${() => refresh()}>${state.status === "loading" ? T.mr.loading : T.mr.refresh}</button>` : null}
      </div>
      ${cfg.mode === "demo" ? html`<p class="yn-me-small yn-mr-demo">${T.mr.demoNote}</p>` : null}
      ${notice}
      ${body}
    </section>`, dialog);
  }

  render();
  return { el, refresh };
}
