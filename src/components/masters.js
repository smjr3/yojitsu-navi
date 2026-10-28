/**
 * マスタ編集画面（SPEC §19）の部品: タブ・表・行の追加／修正／削除ダイアログ・検証・差分・保存（GitLab / CSV ダウンロード）・下書き
 *
 * 純粋ロジック（CSV の書き出し・差分・影響月・検証・下書きの当て直し・GitLab API）は src/core/masterEdit.ts と src/core/gitlab.ts。
 * ここは状態を持って DOM を描くだけ。状態が変わるたびに該当部分を描き直し、data-fk でフォーカスを戻す。
 *
 *   mastersEditor({ data, asOfMonth, minMonth, storage, fetchImpl, now }) → HTMLElement
 */
import { html } from "htl";
import { T, fmt, rich } from "../i18n/index.js";
import { addMonths, parseCsvTable } from "../core/index.js";
import {
  DRAFT_STORAGE_KEY,
  MASTER_FILES,
  MASTER_FILE_IDS,
  MEMBER_IMPORTED_COLUMNS,
  addRow,
  cellOf,
  deleteRow,
  describeImpactEffects,
  describeImpactMonths,
  diffMasterDoc,
  draftFileCount,
  impactBetween,
  issueText,
  makeDraft,
  parseDraft,
  parseMasterDoc,
  restoreRow,
  revertRow,
  rebaseDraftFile,
  rowRecord,
  rowState,
  staleDraftFiles,
  updateRow,
  planSourcesFromDocs,
  validateEdited,
} from "../core/masterEdit.js";
import { allocationFromInput, flattenTeamTree, hoursFromAllocation, memberTeamAt, planView } from "../core/plan.js";
import { teamTreeAt } from "../core/masters.js";
import { effectiveSaveMode, saveToGitLab, webFileUrl } from "../core/gitlab.js";
import { dateTimeJst, integer, monthJa } from "./format.js";

export const TOKEN_STORAGE_KEY = "yojitsu-navi:gitlab-token";

/** 各ファイルの説明（何を編集すると何が変わるか） */
export const FILE_HELP = {
  members: {
    what: T.masters.membersWhat,
    effect: T.masters.membersEffect,
    howto: T.masters.membersHowto,
  },
  rates: {
    what: T.masters.ratesWhat,
    effect: T.masters.ratesEffect,
    howto: T.masters.ratesHowto,
  },
  teams: {
    what: T.masters.teamsWhat,
    effect: T.masters.teamsEffect,
    howto: T.masters.teamsHowto,
  },
  assignments: {
    what: T.masters.assignmentsWhat,
    effect: T.masters.assignmentsEffect,
    howto: T.masters.assignmentsHowto,
  },
};

/** 稼働計画タブ（§23。アサインのファイルを、組織 × メンバー × 月で見せる別の見せ方） */
export const PLAN_VIEW_ID = "plan";
const VIEW_IDS = [...MASTER_FILE_IDS, PLAN_VIEW_ID];
const VIEW_LABELS = { plan: { label: T.plan.tabLabel, file: T.plan.tabFile } };

/** 月 m を含む年度の 12 か月 */
function fiscalMonths(month, startMonth) {
  const [y, m] = month.split("-").map(Number);
  const fy = m >= startMonth ? y : y - 1;
  const first = `${fy}-${String(startMonth).padStart(2, "0")}`;
  return Array.from({ length: 12 }, (_, i) => addMonths(first, i));
}

/** 人月の表示（小数 2 桁）。保存・表示は人月に統一（§23.2） */
function pm(v) {
  return (Math.round(v * 100) / 100).toFixed(2);
}

const KIND_LABELS = { employee: T.members.kindEmployee, partner: T.members.kindPartner };
const STATE_LABELS = { added: T.masters.added, changed: T.masters.changed };

/** 安全な localStorage / sessionStorage（使えない環境では何もしない） */
function safeStorage(kind) {
  try {
    const s = kind === "session" ? window.sessionStorage : window.localStorage;
    const probe = "__yn_probe__";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return {
      get: (k) => {
        try {
          return s.getItem(k);
        } catch {
          return null;
        }
      },
      set: (k, v) => {
        try {
          s.setItem(k, v);
        } catch {
          /* 容量超過などは無視 */
        }
      },
      remove: (k) => {
        try {
          s.removeItem(k);
        } catch {
          /* 無視 */
        }
      },
    };
  } catch {
    return { get: () => null, set: () => {}, remove: () => {} };
  }
}

function fileName(path) {
  return path.split("/").pop();
}

/** 行の最新（適用開始月が最大、同じなら後の行）を返す */
function latestByKey(doc, keyColumn) {
  const out = new Map();
  for (const r of doc.rows) {
    const k = cellOf(doc, r, keyColumn);
    if (k === "") continue;
    const from = cellOf(doc, r, "effective_from");
    const cur = out.get(k);
    if (!cur || from >= cur.from) out.set(k, { from, row: r });
  }
  return out;
}

/**
 * マスタ編集の画面全体
 * @param {object} opts
 * @param {object} opts.data masters.json（src/data/_masters.ts の MastersPayload）
 * @param {object} opts.config 検証に渡す Config（model.config）
 * @param {string} opts.asOfMonth 計算基準月（これ以前 = 実績が表示されている「過去」）
 * @param {string} opts.minMonth データの最小月（影響月を数える最初の月）
 */
export function mastersEditor({ data, config, asOfMonth, minMonth, initialView = null, initialTeam = null, initialMember = null, fetchImpl = (url, init) => window.fetch(url, init), now = () => new Date() }) {
  const local = safeStorage("local");
  const session = safeStorage("session");
  const range = { fromMonth: minMonth, toMonth: asOfMonth };
  const importMode = (data.memberSourceAdapter ?? "none") !== "none";
  const contracts = parseCsvTable(data.context.contracts).rows.map((r) => ({ id: r.get("contract_id"), customer: r.get("customer_name"), project: r.get("project_name") })).filter((c) => c.id !== "");

  // ---- 状態 ---------------------------------------------------------------
  // 編集の土台は常にこのビルドの元データ（古い下書きは復元時にこの土台へ当て直す。§19.2）。書き換えない
  const bases = Object.freeze(Object.fromEntries(MASTER_FILE_IDS.map((id) => [id, Object.freeze({ text: data.files[id].text, lastCommitId: data.files[id].lastCommitId })])));
  let docs = Object.fromEntries(MASTER_FILE_IDS.map((id) => [id, parseMasterDoc(id, bases[id].text)]));
  /** 古い土台の下書きを当て直して復元したファイル → { applied, resolved }（表の上に注記する） */
  let rebasedInfo = {};
  let active = VIEW_IDS.includes(initialView) ? initialView : "members";
  const std = config.standardHoursPerMonth;
  // 稼働計画タブの状態: 組織（null = すべて）・年度の 12 か月・強調するメンバー・開いているメンバー
  const plan = {
    teamId: initialTeam ?? (initialMember ? memberTeamAt(planSourcesFromDocs(docs, data.context.contracts).members, initialMember, asOfMonth) : null),
    months: fiscalMonths(asOfMonth, config.fiscalYearStartMonth),
    focusMember: initialMember,
    open: new Set(initialMember ? [initialMember] : []),
  };
  const listFilter = Object.fromEntries(MASTER_FILE_IDS.map((id) => [id, { q: "", changedOnly: false }]));
  let mode = effectiveSaveMode(data.masterEdit);
  const configuredMode = mode;
  let saving = false;
  /** {kind: "ok"|"error", ...} */
  let outcome = null;
  let locked = false;
  let downloaded = new Set();
  let validation = validateEdited(docs, data.context, config);

  // 下書き（復元か破棄を選ぶまで自動保存しない）
  let pendingDraft = parseDraft(local.get(DRAFT_STORAGE_KEY));
  if (pendingDraft && Object.keys(pendingDraft.files).length === 0) {
    local.remove(DRAFT_STORAGE_KEY);
    pendingDraft = null;
  }
  let draftSavedAt = null;
  /** 下書きの衝突の選択: fileId → 衝突 id → "mine" | "theirs" */
  let draftChoices = {};
  /** 復元を押したが選んでいない衝突があるときの案内 */
  let draftMsg = "";

  const root = html`<div class="yn-me" data-mode=${mode}></div>`;
  const parts = {
    draft: html`<div class="yn-me-draft-slot"></div>`,
    tabs: html`<div class="yn-me-tabs-slot"></div>`,
    panel: html`<div class="yn-me-panel-slot"></div>`,
    check: html`<div class="yn-me-check-slot"></div>`,
    diff: html`<div class="yn-me-diff-slot"></div>`,
    save: html`<div class="yn-me-save-slot"></div>`,
  };
  const dialog = html`<dialog class="yn-dialog yn-me-dialog" aria-labelledby="yn-me-dialog-title"></dialog>`;
  dialog.addEventListener("click", (ev) => {
    if (ev.target === dialog) dialog.close();
  });
  let returnFocusKey = null;
  dialog.addEventListener("close", () => {
    dialog.replaceChildren();
    if (returnFocusKey) focusKey(returnFocusKey);
  });

  // ---- 補助 ---------------------------------------------------------------
  function focusKey(key) {
    const el = root.querySelector(`[data-fk="${CSS.escape(key)}"]`) ?? root.querySelector(`[data-fk="add:${active}"]`);
    if (el && typeof el.focus === "function") el.focus();
  }

  function teamOptions() {
    const latest = latestByKey(docs.teams, "team_id");
    return [...latest.entries()].map(([id, v]) => ({ id, label: `${id} ${cellOf(docs.teams, v.row, "name")}` }));
  }
  function memberNames() {
    const latest = latestByKey(docs.members, "member_id");
    return new Map([...latest.entries()].map(([id, v]) => [id, cellOf(docs.members, v.row, "name")]));
  }
  function teamNames() {
    const latest = latestByKey(docs.teams, "team_id");
    return new Map([...latest.entries()].map(([id, v]) => [id, cellOf(docs.teams, v.row, "name")]));
  }
  /** 組織の種別の候補（いま使われている値。§21） */
  function levelOptions() {
    const s = new Set();
    for (const r of docs.teams.rows) {
      const v = cellOf(docs.teams, r, "level");
      if (v) s.add(v);
    }
    return [...s];
  }
  function titleOptions() {
    const s = new Set();
    for (const r of docs.members.rows) {
      const t = cellOf(docs.members, r, "title");
      if (t) s.add(t);
    }
    const members = new Set(docs.members.rows.map((r) => cellOf(docs.members, r, "member_id")));
    for (const r of docs.rates.rows) {
      const k = cellOf(docs.rates, r, "key");
      if (k && !members.has(k)) s.add(k);
    }
    return [...s];
  }

  /** 表示用の補足（チーム名・氏名・契約名） */
  function cellHint(fileId, column, value) {
    if (value === "") return null;
    if (column === "team_id" || column === "parent_team_id") return teamNames().get(value) ?? T.masters.unknownTeam;
    if ((fileId === "assignments" && column === "member_id") || (fileId === "rates" && column === "key")) return memberNames().get(value) ?? null;
    if (column === "leader_member_id") return memberNames().get(value) ?? T.plan.unknownMember;
    if (column === "allocation" && Number.isFinite(Number(value))) return fmt(T.plan.equalsHours, { hours: hoursFromAllocation(Number(value), std) });
    if (column === "contract_id") {
      const c = contracts.find((x) => x.id === value);
      return c ? `${c.customer} / ${c.project}` : T.masters.unknownContract;
    }
    if (column === "kind") return KIND_LABELS[value] ?? null;
    return null;
  }

  function changeCounts() {
    return Object.fromEntries(MASTER_FILE_IDS.map((id) => [id, diffMasterDoc(docs[id]).count]));
  }
  function totalChanges() {
    return Object.values(changeCounts()).reduce((a, b) => a + b, 0);
  }
  function errorCount(fileId) {
    return Object.values(validation.byRow[fileId]).reduce((s, list) => s + list.filter((i) => i.severity === "error").length, 0);
  }

  function persistDraft() {
    if (pendingDraft) return;
    const d = makeDraft(docs, bases, new Date().toISOString());
    if (d) {
      local.set(DRAFT_STORAGE_KEY, JSON.stringify(d));
      draftSavedAt = d.savedAt;
    } else {
      local.remove(DRAFT_STORAGE_KEY);
      draftSavedAt = null;
    }
  }

  /** 文書を差し替え → 検証 → 下書き保存 → 描き直し */
  function commit(fileId, nextDoc, focus) {
    docs = { ...docs, [fileId]: nextDoc };
    // 稼働計画タブで追加・修正した行は、そのメンバーの計画を開いて見せる
    if (active === PLAN_VIEW_ID && fileId === "assignments" && focus?.startsWith("edit:")) {
      const row = nextDoc.rows.find((r) => r.id === focus.slice(5));
      if (row) plan.open.add(cellOf(nextDoc, row, "member_id"));
    }
    validation = validateEdited(docs, data.context, config);
    outcome = outcome?.kind === "error" ? outcome : null;
    downloaded = new Set();
    persistDraft();
    renderAll();
    if (focus) focusKey(focus);
  }

  // ---- 下書きの復元 ---------------------------------------------------------
  const CONFLICT_TEXT = {
    "both-changed": T.masters.conflictBothChanged,
    "changed-vs-deleted": T.masters.conflictTheyDeleted,
    "deleted-vs-changed": T.masters.conflictYouDeleted,
  };

  /** 衝突 1 件の選択肢（自分の下書き／最新のデータ） */
  function conflictItem(fileId, c) {
    const def = MASTER_FILES[fileId];
    const cols = def.columns.filter((col) => docs[fileId].header.includes(col.name));
    const keyText = def.keyColumns.map((k) => (c.base[k] ?? "").trim()).join(" / ");
    const shown = cols.filter((col) => c.columns.includes(col.name));
    const values = (rec, deletedText) =>
      rec === null
        ? html`<span class="yn-me-conflict-del">${deletedText}</span>`
        : html`<span class="yn-me-conflict-vals">${(shown.length ? shown : cols).map((col, i) => html`${i > 0 ? " / " : ""}${col.label}: <strong>${(rec[col.name] ?? "").trim() || T.masters.emptyValue}</strong>`)}</span>`;
    const chosen = draftChoices[fileId]?.[c.id] ?? null;
    const name = `yn-me-conflict-${fileId}-${c.id}`;
    const option = (value, label, rec, deletedText) => {
      const input = html`<input type="radio" name=${name} value=${value} checked=${chosen === value}>`;
      input.dataset.fk = `conflict:${fileId}:${c.id}:${value}`;
      input.addEventListener("change", () => {
        draftChoices = { ...draftChoices, [fileId]: { ...(draftChoices[fileId] ?? {}), [c.id]: value } };
        draftMsg = "";
        renderDraft();
        focusKey(`conflict:${fileId}:${c.id}:${value}`);
      });
      return html`<label class="yn-me-conflict-opt">${input}<span><span class="yn-me-conflict-label">${label}:</span> ${values(rec, deletedText)}</span></label>`;
    };
    return html`<fieldset class=${`yn-me-conflict${chosen ? "" : " is-unresolved"}`} data-conflict=${`${fileId}:${c.id}`}>
      <legend><span class="yn-chip yn-chip-neutral">${def.label}</span> ${keyText}: ${CONFLICT_TEXT[c.kind]}</legend>
      <p class="yn-me-small">${T.masters.conflictBaseRow} ${cols.map((col) => (c.base[col.name] ?? "").trim() || "—").join(" ・ ")}</p>
      ${option("mine", T.masters.keepMine, c.mine, T.masters.deleteThisRow)}
      ${option("theirs", T.masters.keepTheirs, c.theirs, T.masters.keepDeleted)}
    </fieldset>`;
  }

  function renderDraft() {
    if (!pendingDraft) {
      parts.draft.replaceChildren();
      return;
    }
    const d = pendingDraft;
    const stale = staleDraftFiles(d, bases);
    const ids = MASTER_FILE_IDS.filter((id) => d.files[id]);
    // 下書きの差分を、このビルドの元データ（最新の土台）に当て直す。土台が同じならそのまま戻るだけ
    const results = Object.fromEntries(ids.map((id) => [id, rebaseDraftFile(id, d.files[id], bases[id].text, draftChoices[id] ?? {})]));
    const counts = ids.map((id) => fmt(T.masters.draftFileCount, { file: MASTER_FILES[id].label, n: integer(draftFileCount(d.files[id])) }));
    const conflicts = ids.flatMap((id) => results[id].conflicts.map((c) => ({ fileId: id, c })));
    const unresolved = ids.flatMap((id) => results[id].unresolved.map((cid) => `${id}:${cid}`));
    const applied = ids.reduce((sum, id) => sum + results[id].applied, 0);
    const restore = () => {
      if (unresolved.length) {
        draftMsg = fmt(T.masters.unresolvedLeft, { n: integer(unresolved.length) });
        renderDraft();
        parts.draft.querySelector(`[data-conflict="${CSS.escape(unresolved[0])}"] input`)?.focus();
        return;
      }
      rebasedInfo = {};
      for (const id of ids) {
        docs = { ...docs, [id]: results[id].doc };
        if (results[id].stale) rebasedInfo[id] = { applied: results[id].applied, resolved: results[id].conflicts.length };
      }
      pendingDraft = null;
      draftChoices = {};
      draftMsg = "";
      validation = validateEdited(docs, data.context, config);
      persistDraft();
      renderAll();
      focusKey(`tab:${active}`);
    };
    const discard = () => {
      local.remove(DRAFT_STORAGE_KEY);
      pendingDraft = null;
      draftChoices = {};
      draftMsg = "";
      persistDraft();
      renderAll();
      focusKey(`tab:${active}`);
    };
    parts.draft.replaceChildren(html`<section class="yn-me-banner" role="region" aria-labelledby="yn-me-draft-title">
      <h2 id="yn-me-draft-title" class="yn-me-banner-title">${T.masters.draftTitle}</h2>
      <p>${dateTimeJst(d.savedAt)} ${T.masters.draftSavedAt} ${counts.join("、")}${T.masters.draftRestoreHint}</p>
      ${stale.length
        ? html`<div class="yn-me-stale" role="alert">
            <p><strong>${T.masters.staleTitle}</strong>（${stale.map((id) => fileName(MASTER_FILES[id].path)).join("、")}${T.masters.staleText1}<strong>${T.masters.staleText2}</strong>${T.masters.staleText3}</p>
            <p>${T.masters.appliable} ${integer(applied)} ${T.masters.countSuffixPeriod}${conflicts.length
              ? html`${T.masters.notAppliable} <strong>${integer(conflicts.length)} ${T.masters.countSuffix}</strong>${T.masters.chooseBeforeRestore}`
              : T.masters.noConflicts}</p>
          </div>`
        : null}
      ${conflicts.length
        ? html`<div class="yn-me-conflicts">
            <h3 class="yn-me-subtitle">${T.masters.chooseTitle1}${integer(conflicts.length)} ${T.masters.chooseTitle2} ${integer(unresolved.length)} ${T.masters.countSuffixParen}</h3>
            ${conflicts.map(({ fileId, c }) => conflictItem(fileId, c))}
          </div>`
        : null}
      ${draftMsg ? html`<p class="yn-me-form-msg" role="alert">${draftMsg}</p>` : null}
      <p class="yn-me-actions">
        <button type="button" class="yn-btn yn-btn-primary" data-fk="draft:restore" onclick=${restore}>${T.masters.restoreDraft}</button>
        <button type="button" class="yn-btn" data-fk="draft:discard" onclick=${discard}>${T.masters.discardDraft}</button>
      </p>
      <p class="yn-me-small">${T.masters.draftNotSavedUntilChoice}</p>
    </section>`);
  }

  // ---- タブ ---------------------------------------------------------------
  function renderTabs() {
    const counts = changeCounts();
    const select = (id, focus = true) => {
      active = id;
      renderTabs();
      renderPanel();
      if (focus) focusKey(`tab:${id}`);
    };
    const onKey = (ev) => {
      const i = VIEW_IDS.indexOf(active);
      let next = null;
      if (ev.key === "ArrowRight") next = VIEW_IDS[(i + 1) % VIEW_IDS.length];
      else if (ev.key === "ArrowLeft") next = VIEW_IDS[(i + VIEW_IDS.length - 1) % VIEW_IDS.length];
      else if (ev.key === "Home") next = VIEW_IDS[0];
      else if (ev.key === "End") next = VIEW_IDS[VIEW_IDS.length - 1];
      if (next) {
        ev.preventDefault();
        select(next);
      }
    };
    parts.tabs.replaceChildren(html`<div class="yn-me-tabs" role="tablist" aria-label=${T.masters.tabsLabel} onkeydown=${onKey}>
      ${VIEW_IDS.map((id) => {
        const isPlan = id === PLAN_VIEW_ID;
        const errs = isPlan ? 0 : errorCount(id);
        const selected = id === active;
        return html`<button type="button" role="tab" id=${`yn-me-tab-${id}`} class=${isPlan ? "yn-me-tab yn-me-tab-plan" : "yn-me-tab"} aria-selected=${selected ? "true" : "false"} aria-controls="yn-me-panel" tabindex=${selected ? "0" : "-1"} data-fk=${`tab:${id}`} onclick=${() => select(id)}>
          <span class="yn-me-tab-label">${isPlan ? VIEW_LABELS.plan.label : MASTER_FILES[id].label}</span>
          <span class="yn-me-tab-file">${isPlan ? VIEW_LABELS.plan.file : fileName(MASTER_FILES[id].path)}</span>
          ${!isPlan && counts[id] > 0 ? html`<span class="yn-chip yn-chip-neutral">${T.masters.changed} ${integer(counts[id])}</span>` : null}
          ${errs > 0 ? html`<span class="yn-chip yn-chip-warn"><span aria-hidden="true">!</span> ${T.dataCheck.severityError} ${integer(errs)}</span>` : null}
        </button>`;
      })}
    </div>`);
  }

  // ---- 表 -----------------------------------------------------------------
  function renderPanel() {
    if (active === PLAN_VIEW_ID) {
      renderPlanPanel();
      return;
    }
    const fileId = active;
    const def = MASTER_FILES[fileId];
    const doc = docs[fileId];
    const help = FILE_HELP[fileId];
    const meta = data.files[fileId];
    const f = listFilter[fileId];
    const q = f.q.normalize("NFKC").toLowerCase().trim();
    const issues = validation.byRow[fileId];
    const shown = doc.rows.filter((r) => {
      const st = rowState(doc, r);
      if (f.changedOnly && st === "unchanged" && !(issues[r.id]?.length > 0)) return false;
      if (q && !r.cells.join(" ").normalize("NFKC").toLowerCase().includes(q)) return false;
      return true;
    });
    const isHistory = def.history === "effective";
    const columns = def.columns.filter((c) => doc.header.includes(c.name));
    const colCount = columns.length + 2;

    const search = html`<input type="search" class="yn-input yn-me-search" id=${`yn-me-q-${fileId}`} placeholder=${T.masters.searchPlaceholder} aria-label=${fmt(T.masters.searchAria, { file: def.label })} value=${f.q}>`;
    let timer = null;
    search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        f.q = search.value;
        renderPanel();
        const el = root.querySelector(`#yn-me-q-${fileId}`);
        if (el) {
          el.focus();
          el.setSelectionRange?.(el.value.length, el.value.length);
        }
      }, 150);
    });
    const changedOnly = html`<input type="checkbox" id=${`yn-me-changed-${fileId}`} checked=${f.changedOnly}>`;
    changedOnly.addEventListener("change", () => {
      f.changedOnly = changedOnly.checked;
      renderPanel();
      focusKey(`changed:${fileId}`);
    });
    changedOnly.dataset.fk = `changed:${fileId}`;

    const addLabel = isHistory ? T.masters.addHistoryRow : T.masters.addAssignment;
    const notes = [];
    if (meta.encoding && meta.encoding !== "utf-8") notes.push(fmt(T.masters.encodingNote, { encoding: meta.encoding === "shift_jis" ? "Shift_JIS" : T.masters.encodingBom }));
    if (meta.lineEnding === "crlf") notes.push(T.masters.crlfNote);
    if (rebasedInfo[fileId]) {
      const ri = rebasedInfo[fileId];
      notes.push(fmt(T.masters.rebasedNote, { n: integer(ri.applied), resolved: ri.resolved ? fmt(T.masters.rebasedResolved, { n: integer(ri.resolved) }) : "" }));
    }
    if (fileId === "members" && importMode) notes.push(fmt(T.masters.hrImportNote, { adapter: data.memberSourceAdapter }));

    const rowsHtml = shown.flatMap((r) => {
      const st = rowState(doc, r);
      const list = issues[r.id] ?? [];
      const errs = list.filter((i) => i.severity === "error");
      const invalid = errs.length > 0;
      const issueId = `yn-me-issue-${fileId}-${r.id}`;
      const rec = rowRecord(doc, r);
      const keyText = def.keyColumns.map((k) => rec[k] ?? "").join(" / ");
      const deletable = !(fileId === "members" && importMode && st !== "added");
      const cells = columns.map((c, i) => {
        const v = (rec[c.name] ?? "").trim();
        const hint = cellHint(fileId, c.name, v);
        const changedCol = st === "changed" && doc.originals[r.id] && (doc.originals[r.id].cells[doc.header.indexOf(c.name)] ?? "") !== (r.cells[doc.header.indexOf(c.name)] ?? "");
        const content = html`<span class=${changedCol ? "yn-me-val is-changed" : "yn-me-val"}>${v === "" ? html`<span class="yn-muted" aria-label=${T.masters.emptyAria}>—</span>` : v}</span>${hint ? html`<span class="yn-me-hint">${hint}</span>` : null}`;
        const cls = `${c.input === "number" ? "num" : ""}${c.input === "month" ? " yn-me-month" : ""}`;
        return i === 0 ? html`<th scope="row" class=${cls}>${content}</th>` : html`<td class=${cls}>${content}</td>`;
      });
      const actions = html`<td class="yn-me-actions-cell"><div class="yn-me-row-actions">
        ${isHistory ? html`<button type="button" class="yn-btn yn-btn-sm" data-fk=${`next:${r.id}`} aria-label=${fmt(T.masters.rowAddNextAria, { key: keyText })} onclick=${() => openRowDialog({ fileId, mode: "add", template: r, focus: `next:${r.id}` })}>${T.masters.addNextShort}</button>` : null}
        <button type="button" class="yn-btn yn-btn-sm" data-fk=${`edit:${r.id}`} aria-label=${fmt(T.masters.rowEditAria, { key: keyText })} onclick=${() => openRowDialog({ fileId, mode: "edit", rowId: r.id, focus: `edit:${r.id}` })}>${T.masters.edit}</button>
        ${st === "changed" ? html`<button type="button" class="yn-btn yn-btn-sm" data-fk=${`revert:${r.id}`} aria-label=${fmt(T.masters.rowRevertAria, { key: keyText })} onclick=${() => commit(fileId, revertRow(docs[fileId], r.id), `edit:${r.id}`)}>${T.masters.revert}</button>` : null}
        ${deletable ? html`<button type="button" class="yn-btn yn-btn-sm" data-fk=${`del:${r.id}`} aria-label=${fmt(T.masters.rowDeleteAria, { key: keyText })} onclick=${() => openDeleteDialog(fileId, r.id, `del:${r.id}`)}>${T.masters.deleteKind}</button>` : null}
      </div></td>`;
      const stateChip =
        st === "unchanged" && !invalid
          ? null
          : html`<span class="yn-chip-row">${st !== "unchanged" ? html`<span class=${`yn-chip ${st === "added" ? "yn-chip-ok" : "yn-chip-neutral"}`}>${st === "added" ? "＋" : "✎"} ${STATE_LABELS[st]}</span>` : null}${invalid ? html`<span class="yn-chip yn-chip-warn"><span aria-hidden="true">!</span> ${T.dataCheck.severityError}</span>` : null}</span>`;
      const tr = html`<tr data-key=${r.id} class=${`yn-me-row is-${st}${invalid ? " is-invalid" : ""}`} aria-describedby=${list.length ? issueId : null}>${cells}<td class="yn-me-state">${stateChip}</td>${actions}</tr>`;
      if (list.length === 0) return [tr];
      return [
        tr,
        html`<tr class="yn-me-issue-row"><td colspan=${colCount} id=${issueId}><ul class="yn-me-issues">${list.map(
          (i) => html`<li class=${i.severity === "error" ? "is-error" : "is-warning"}><span aria-hidden="true">${i.severity === "error" ? "!" : "i"}</span> ${i.severity === "error" ? T.dataCheck.severityError : T.dataCheck.severityWarning}: ${issueText(i)}</li>`,
        )}</ul></td></tr>`,
      ];
    });

    const removed = diffMasterDoc(doc).removed;
    parts.panel.replaceChildren(html`<section id="yn-me-panel" class="yn-me-panel" role="tabpanel" aria-labelledby=${`yn-me-tab-${fileId}`}>
      <div class="yn-me-panel-head">
        <div>
          <h2 class="yn-section-title">${def.label}<span class="yn-me-path"> ${meta.path}</span></h2>
          <p class="yn-me-help"><strong>${T.masters.helpWhat}</strong> ${help.what} <strong>${T.masters.helpEffect}</strong> ${help.effect}</p>
          <p class="yn-me-help"><strong>${T.masters.helpHowto}</strong> ${help.howto}</p>
        </div>
      </div>
      ${notes.map((n) => html`<p class="yn-note yn-note-warn">${n}</p>`)}
      <div class="yn-me-toolbar">
        <button type="button" class="yn-btn yn-btn-primary" data-fk=${`add:${fileId}`} disabled=${locked} onclick=${() => openRowDialog({ fileId, mode: "add", focus: `add:${fileId}` })}>${addLabel}</button>
        ${search}
        <label class="yn-toggle-chip" for=${`yn-me-changed-${fileId}`}>${changedOnly}<span>${T.masters.onlyChanged}</span></label>
        <span class="yn-table-count" aria-live="polite">${integer(shown.length)} / ${integer(doc.rows.length)} ${T.masters.rowsSuffix}</span>
      </div>
      <div class="yn-table-wrap yn-me-table-wrap" tabindex="0" role="region" aria-label=${fmt(T.masters.tableAria, { file: def.label })}>
        <table class="yn-table yn-table-compact yn-me-table">
          <caption class="visually-hidden">${def.label}（${meta.path}${T.masters.fileOrderNote}</caption>
          <thead><tr>
            ${columns.map((c) => html`<th scope="col" class=${c.input === "number" ? "num" : ""}><span class="yn-me-th">${c.label}</span><span class="yn-th-sub">${c.name}</span></th>`)}
            <th scope="col">${T.columns.status}</th>
            <th scope="col">${T.masters.colActions}</th>
          </tr></thead>
          <tbody>${rowsHtml.length ? rowsHtml : html`<tr class="yn-table-empty"><td colspan=${colCount}>${doc.rows.length === 0 ? T.masters.noRowsBefore + addLabel.replace("＋ ", "") + T.masters.noRowsAfter : T.masters.noMatchRows}</td></tr>`}</tbody>
        </table>
      </div>
      ${removed.length
        ? html`<div class="yn-me-removed"><h3 class="yn-me-subtitle">${T.masters.removedTitle}${integer(removed.length)}${T.masters.countSuffixParen}</h3><ul>${removed.map(
            (r) => html`<li><span class="yn-chip yn-chip-neutral">${T.masters.removedChip}</span> <span class="yn-me-removed-text">${columns.map((c) => r.before[c.name] ?? "").join(" ・ ")}</span> <button type="button" class="yn-btn yn-btn-sm" data-fk=${`restore:${r.rowId}`} onclick=${() => commit(fileId, restoreRow(docs[fileId], r.rowId), `edit:${r.rowId}`)}>${T.masters.undoDelete}</button></li>`,
          )}</ul></div>`
        : null}
    </section>`);
  }

  // ---- 稼働計画（§23） -------------------------------------------------------
  function renderPlanPanel() {
    const src = planSourcesFromDocs(docs, data.context.contracts);
    const months = plan.months;
    const last = months[months.length - 1];
    const treeMonth = last < asOfMonth ? last : asOfMonth < months[0] ? months[0] : asOfMonth;
    const tree = teamTreeAt({ teams: src.teams }, treeMonth).tree;
    const flat = flattenTeamTree(tree);
    const view = planView(src, plan.teamId, months);
    const names = memberNames();
    const tNames = teamNames();
    const doc = docs.assignments;
    const issues = validation.byRow.assignments;
    const unit = plan.teamId ? tree[plan.teamId] : null;
    const leaderText = (id) => (id ? fmt(T.plan.leaderWithId, { name: names.get(id) ?? T.plan.unknownMember, id }) : T.plan.leaderUnset);
    const optLabel = (n) => `${"　".repeat(n.depth)}${n.name}${n.level ? `［${n.level}］` : ""}${n.leaderMemberId ? fmt(T.plan.optLeader, { name: names.get(n.leaderMemberId) ?? n.leaderMemberId }) : ""}`;
    const contractLabel = (id) => {
      const c = contracts.find((x) => x.id === id);
      return c ? `${id} ${c.customer} / ${c.project}` : `${id}${T.masters.unknownContract}`;
    };
    const fyLabel = fmt(T.plan.fyLabel, { fy: months[0].slice(0, 4), first: monthJa(months[0]), last: monthJa(last) });
    const shiftYear = (d) => {
      plan.months = months.map((m) => addMonths(m, 12 * d));
      renderPanel();
      focusKey(d < 0 ? "plan:prev" : "plan:next");
    };
    const teamSel = html`<select id="yn-me-plan-team" class="yn-select" data-fk="plan:team">
      <option value="" selected=${plan.teamId === null}>${T.plan.allUnits}</option>
      ${flat.map((n) => html`<option value=${n.teamId} selected=${plan.teamId === n.teamId}>${optLabel(n)}</option>`)}
      ${plan.teamId !== null && !tree[plan.teamId] ? html`<option value=${plan.teamId} selected>${plan.teamId}${T.plan.notInYear}</option>` : null}
    </select>`;
    teamSel.addEventListener("change", () => {
      plan.teamId = teamSel.value || null;
      plan.focusMember = null;
      renderPanel();
      focusKey("plan:team");
    });
    const defaultStart = () => {
      const next = addMonths(asOfMonth, 1);
      return next >= months[0] && next <= last ? next : months[0];
    };
    const addFor = (memberId, focus) => openRowDialog({ fileId: "assignments", mode: "add", preset: { ...(memberId ? { member_id: memberId } : {}), start_month: defaultStart(), end_month: last }, focus });
    const toggle = (memberId) => {
      if (plan.open.has(memberId)) plan.open.delete(memberId);
      else plan.open.add(memberId);
      renderPanel();
      focusKey(`plan:toggle:${memberId}`);
    };

    const body = view.rows.flatMap((r) => {
      const open = plan.open.has(r.memberId);
      const detailId = `yn-me-plan-d-${r.memberId}`;
      const rowErrors = r.assignments.reduce((n, a) => n + (issues[a.rowId] ?? []).filter((i) => i.severity === "error").length, 0);
      const changed = r.assignments.filter((a) => {
        const row = doc.rows.find((x) => x.id === a.rowId);
        return row && rowState(doc, row) !== "unchanged";
      }).length;
      const sum = r.monthly.reduce((a, b) => a + b, 0);
      const main = html`<tr class=${`yn-me-plan-row${plan.focusMember === r.memberId ? " is-focus" : ""}`} data-member=${r.memberId}>
        <th scope="row">
          <span class="yn-me-plan-name">${r.name || r.memberId}</span> <span class="yn-me-hint">${r.memberId}${r.teamId ? ` ・ ${tNames.get(r.teamId) ?? r.teamId}` : ""}</span>
          <span class="yn-chip-row">${r.support ? html`<span class="yn-chip yn-chip-neutral">${T.plan.support}</span>` : null}${r.overMonths.length ? html`<span class="yn-chip yn-chip-warn"><span aria-hidden="true">!</span> ${fmt(T.plan.overChip, { n: integer(r.overMonths.length) })}</span>` : null}${changed ? html`<span class="yn-chip yn-chip-neutral">${T.masters.changed} ${integer(changed)}</span>` : null}${rowErrors ? html`<span class="yn-chip yn-chip-warn"><span aria-hidden="true">!</span> ${T.dataCheck.severityError} ${integer(rowErrors)}</span>` : null}</span>
        </th>
        ${r.monthly.map((v, i) => html`<td class=${`num yn-me-plan-cell${v > 1 + 1e-9 ? " is-over" : v > 0 ? " is-set" : ""}`} title=${fmt(T.plan.cellTitle, { month: months[i], pm: pm(v) })}>${v > 0 ? pm(v) : html`<span class="yn-muted" aria-label="0">—</span>`}</td>`)}
        <td class="num">${pm(sum)}</td>
        <td class="yn-me-actions-cell"><div class="yn-me-row-actions">
          <button type="button" class="yn-btn yn-btn-sm" data-fk=${`plan:toggle:${r.memberId}`} aria-expanded=${open ? "true" : "false"} aria-controls=${detailId} onclick=${() => toggle(r.memberId)}>${fmt(T.plan.toggle, { n: integer(r.assignments.length) })} ${open ? "▴" : "▾"}</button>
          <button type="button" class="yn-btn yn-btn-sm" data-fk=${`plan:add:${r.memberId}`} disabled=${locked} aria-label=${fmt(T.plan.addForAria, { name: r.name || r.memberId })} onclick=${() => addFor(r.memberId, `plan:add:${r.memberId}`)}>${T.plan.addShort}</button>
        </div></td>
      </tr>`;
      if (!open) return [main];
      const items = r.assignments.map((a) => {
        const row = doc.rows.find((x) => x.id === a.rowId);
        const st = row ? rowState(doc, row) : "unchanged";
        const list = issues[a.rowId] ?? [];
        return html`<li class=${`yn-me-plan-item is-${st}`}>
          <span class="yn-me-plan-contract">${contractLabel(a.contractId)}</span>
          <span class="yn-me-plan-period">${a.startMonth}〜${a.endMonth}</span>
          <span class="yn-me-plan-alloc">${Number.isFinite(a.allocation) ? fmt(T.plan.allocPerMonth, { pm: pm(a.allocation) }) : T.plan.allocNotNumber}</span>
          ${st !== "unchanged" ? html`<span class=${`yn-chip ${st === "added" ? "yn-chip-ok" : "yn-chip-neutral"}`}>${st === "added" ? "＋" : "✎"} ${STATE_LABELS[st]}</span>` : null}
          <span class="yn-me-row-actions">
            <button type="button" class="yn-btn yn-btn-sm" data-fk=${`edit:${a.rowId}`} disabled=${locked} aria-label=${fmt(T.plan.editAria, { contract: a.contractId })} onclick=${() => openRowDialog({ fileId: "assignments", mode: "edit", rowId: a.rowId, focus: `edit:${a.rowId}` })}>${T.masters.edit}</button>
            <button type="button" class="yn-btn yn-btn-sm" data-fk=${`del:${a.rowId}`} disabled=${locked} aria-label=${fmt(T.plan.deleteAria, { contract: a.contractId })} onclick=${() => openDeleteDialog("assignments", a.rowId, `plan:toggle:${r.memberId}`)}>${T.masters.deleteKind}</button>
          </span>
          ${list.length ? html`<ul class="yn-me-issues">${list.map((i) => html`<li class=${i.severity === "error" ? "is-error" : "is-warning"}><span aria-hidden="true">${i.severity === "error" ? "!" : "i"}</span> ${i.severity === "error" ? T.dataCheck.severityError : T.dataCheck.severityWarning}: ${issueText(i)}</li>`)}</ul>` : null}
        </li>`;
      });
      return [
        main,
        html`<tr class="yn-me-plan-detail" id=${detailId}><td colspan=${months.length + 3}>
          ${items.length ? html`<ul class="yn-me-plan-items">${items}</ul>` : html`<p class="yn-muted">${T.plan.noItems}</p>`}
          ${r.overMonths.length ? html`<p class="yn-me-small">${fmt(T.plan.overMonths, { months: r.overMonths.join("、") })}</p>` : null}
        </td></tr>`,
      ];
    });

    parts.panel.replaceChildren(html`<section id="yn-me-panel" class="yn-me-panel yn-me-plan" role="tabpanel" aria-labelledby=${`yn-me-tab-${PLAN_VIEW_ID}`}>
      <div class="yn-me-panel-head">
        <div>
          <h2 class="yn-section-title">${T.plan.tabLabel}<span class="yn-me-path"> ${data.files.assignments.path}</span></h2>
          <p class="yn-me-help">${rich(T.plan.helpWhat)}</p>
          <p class="yn-me-help">${rich(T.plan.helpHowto, { std: integer(std) })}</p>
        </div>
      </div>
      <div class="yn-me-toolbar yn-me-plan-toolbar">
        <label class="yn-me-plan-label" for="yn-me-plan-team">${T.plan.unitLabel}</label>${teamSel}
        <span class="yn-me-plan-fy">
          <button type="button" class="yn-btn yn-btn-sm" data-fk="plan:prev" aria-label=${T.plan.prevYear} onclick=${() => shiftYear(-1)}>◀</button>
          <span aria-live="polite">${fyLabel}</span>
          <button type="button" class="yn-btn yn-btn-sm" data-fk="plan:next" aria-label=${T.plan.nextYear} onclick=${() => shiftYear(1)}>▶</button>
        </span>
        <button type="button" class="yn-btn yn-btn-primary" data-fk="add:plan" disabled=${locked} onclick=${() => addFor(null, "add:plan")}>${T.plan.add}</button>
      </div>
      ${unit ? html`<p class="yn-me-plan-unit">${unit.name}${unit.level ? html` <span class="yn-chip yn-chip-neutral">${unit.level}</span>` : null} ${fmt(T.plan.unitNote, { leader: leaderText(unit.leaderMemberId) })}</p>` : null}
      <div class="yn-table-wrap yn-me-table-wrap" tabindex="0" role="region" aria-label=${T.plan.tableAria}>
        <table class="yn-table yn-table-compact yn-me-table yn-me-plan-table">
          <caption class="visually-hidden">${fmt(T.plan.caption, { unit: unit ? unit.name : T.plan.allUnits, fy: fyLabel })}</caption>
          <thead><tr>
            <th scope="col">${T.plan.colMember}</th>
            ${months.map((m) => html`<th scope="col" class="num">${fmt(T.plan.colMonth, { m: Number(m.slice(5)) })}</th>`)}
            <th scope="col" class="num">${T.plan.colFyTotal}<span class="yn-th-sub">${T.plan.unitPersonMonth}</span></th>
            <th scope="col">${T.masters.colActions}</th>
          </tr></thead>
          <tbody>${body.length ? body : html`<tr class="yn-table-empty"><td colspan=${months.length + 3}>${T.plan.noMembers}</td></tr>`}</tbody>
          ${view.rows.length ? html`<tfoot><tr><th scope="row">${fmt(T.plan.total, { n: integer(view.rows.length) })}</th>${view.totals.map((v) => html`<td class="num">${pm(v)}</td>`)}<td class="num">${pm(view.totals.reduce((a, b) => a + b, 0))}</td><td></td></tr></tfoot>` : null}
        </table>
      </div>
    </section>`);
  }

  // ---- 行の追加・修正ダイアログ --------------------------------------------
  function fieldFor(fileId, col, value, disabled) {
    const id = `yn-me-f-${col.name}`;
    const req = col.required;
    if (col.input === "kind") {
      return html`<select id=${id} name=${col.name} class="yn-select" required=${req} disabled=${disabled}>
        ${["employee", "partner"].map((k) => html`<option value=${k} selected=${value === k}>${KIND_LABELS[k]}（${k}）</option>`)}
        ${value !== "" && value !== "employee" && value !== "partner" ? html`<option value=${value} selected>${value}${T.masters.invalidValue}</option>` : null}
      </select>`;
    }
    if (col.input === "team") {
      const opts = teamOptions();
      return html`<select id=${id} name=${col.name} class="yn-select" disabled=${disabled}>
        <option value="" selected=${value === ""}>${T.masters.noneOption}</option>
        ${opts.map((o) => html`<option value=${o.id} selected=${value === o.id}>${o.label}</option>`)}
        ${value !== "" && !opts.some((o) => o.id === value) ? html`<option value=${value} selected>${value}${T.masters.unknownTeam}</option>` : null}
      </select>`;
    }
    if (col.input === "contract") {
      return html`<select id=${id} name=${col.name} class="yn-select" required=${req} disabled=${disabled}>
        <option value="" selected=${value === ""}>${T.masters.choose}</option>
        ${contracts.map((c) => html`<option value=${c.id} selected=${value === c.id}>${c.id} ${c.customer} / ${c.project}</option>`)}
        ${value !== "" && !contracts.some((c) => c.id === value) ? html`<option value=${value} selected>${value}${T.masters.unknownContract}</option>` : null}
      </select>`;
    }
    if (col.input === "allocation") {
      // 入力は人月か時間を選べる。保存は人月（§23.2）
      const unitSel = html`<select id=${`${id}-unit`} name="__allocation_unit" class="yn-select yn-me-unit" disabled=${disabled}>
        <option value="personMonth" selected>${T.plan.unitPersonMonth}</option>
        <option value="hours">${T.plan.unitHours}</option>
      </select>`;
      const input = html`<input id=${id} name=${col.name} class="yn-input" type="text" value=${value} required=${req} disabled=${disabled} autocomplete="off" inputmode="decimal" aria-describedby=${`${id}-hint ${id}-conv`}>`;
      const conv = html`<span class="yn-me-conv" id=${`${id}-conv`} aria-live="polite"></span>`;
      const update = () => {
        const out = allocationFromInput(input.value, unitSel.value, std);
        const n = Number(out);
        conv.textContent = out === "" || !Number.isFinite(n) ? "" : unitSel.value === "hours" ? fmt(T.plan.convFromHours, { hours: input.value.trim(), pm: out, std }) : fmt(T.plan.convFromPm, { pm: out, hours: hoursFromAllocation(n, std) });
      };
      let lastUnit = "personMonth";
      unitSel.addEventListener("change", () => {
        // 単位を切り替えたら、入っている値を新しい単位に換算して見せる
        const n = Number(input.value.normalize("NFKC").trim());
        if (input.value.trim() !== "" && Number.isFinite(n)) input.value = lastUnit === "personMonth" ? String(hoursFromAllocation(n, std)) : allocationFromInput(String(n), "hours", std);
        lastUnit = unitSel.value;
        update();
      });
      input.addEventListener("input", update);
      update();
      return html`<span class="yn-me-alloc">${input}<label class="visually-hidden" for=${`${id}-unit`}>${T.plan.unitSelectLabel}</label>${unitSel}</span>${conv}`;
    }
    if (col.input === "level") {
      const listId = `${id}-list`;
      return html`<span class="yn-me-combo"><input id=${id} name=${col.name} class="yn-input" type="text" value=${value} disabled=${disabled} list=${listId} autocomplete="off" aria-describedby=${`${id}-hint`}><datalist id=${listId}>${levelOptions().map((v) => html`<option value=${v}></option>`)}</datalist></span>`;
    }
    if (col.input === "month") {
      return html`<input id=${id} name=${col.name} class="yn-input" type="month" value=${/^\d{4}-\d{2}$/.test(value) ? value : ""} required=${req} disabled=${disabled} aria-describedby=${`${id}-hint`}>`;
    }
    const listId = col.input === "member" || col.input === "rateKey" || col.input === "title" ? `${id}-list` : null;
    const input = html`<input id=${id} name=${col.name} class="yn-input" type="text" value=${value} required=${req} disabled=${disabled} list=${listId} autocomplete="off" inputmode=${col.input === "number" ? "decimal" : null} aria-describedby=${`${id}-hint`}>`;
    if (!listId) return input;
    const names = memberNames();
    const options =
      col.input === "member"
        ? [...names.entries()].map(([k, n]) => ({ v: k, l: n }))
        : col.input === "title"
          ? titleOptions().map((t) => ({ v: t, l: T.members.colTitle }))
          : [...titleOptions().map((t) => ({ v: t, l: T.members.colTitle })), ...[...names.entries()].map(([k, n]) => ({ v: k, l: fmt(T.masters.personalRateOption, { name: n }) }))];
    return html`<span class="yn-me-combo">${input}<datalist id=${listId}>${options.map((o) => html`<option value=${o.v} label=${o.l}></option>`)}</datalist></span>`;
  }

  /** 過去月への影響の注記。何が変わるかは、過去の月で値が変わる列で出し分ける（§19.1） */
  function impactNote(fileId, impact, tail) {
    const eff = describeImpactEffects(fileId, impact.columns);
    return html`<p class="yn-me-impact" role="alert" data-cost-changes=${eff.costChanges ? "true" : "false"}><span aria-hidden="true">!</span> <strong>${T.masters.impact1} ${integer(impact.months.length)} ${T.masters.impact2}</strong><br>${describeImpactMonths(impact.months)} ${T.masters.particleNo}${eff.effects.join("、")}${T.masters.impact3}${eff.note ? html`<strong class="yn-me-impact-safe">${eff.note}</strong>` : null}${tail}</p>`;
  }

  const FIELD_HINTS = {
    effective_from: T.masters.hintEffectiveFrom,
    start_month: "YYYY-MM",
    end_month: T.masters.hintMonth,
    allocation: T.masters.hintAllocation,
    level: T.masters.hintLevel,
    leader_member_id: T.masters.hintLeader,
    parent_team_id: T.masters.hintParentTeam,
    hourly_rate: T.masters.hintRate,
    key: T.masters.hintRateKey,
    member_id: T.masters.hintMember,
    team_id: T.masters.hintTeamId,
    title: T.masters.hintTitle,
  };

  /**
   * 追加（mode: "add"、template があればその行を写して適用開始月を翌月に）／修正（mode: "edit"）
   */
  function openRowDialog({ fileId, mode, rowId = null, template = null, preset = null, focus }) {
    if (locked) return;
    returnFocusKey = focus;
    const def = MASTER_FILES[fileId];
    const doc = docs[fileId];
    const columns = def.columns.filter((c) => doc.header.includes(c.name));
    const row = rowId ? doc.rows.find((r) => r.id === rowId) : null;
    const isOriginal = !!(row && doc.originals[row.id]);
    let initial = row ? rowRecord(doc, row) : template ? rowRecord(doc, template) : Object.fromEntries(columns.map((c) => [c.name, ""]));
    if (mode === "add") {
      const next = addMonths(asOfMonth, 1);
      if (def.history === "effective") initial = { ...initial, effective_from: next };
      else if (template) initial = { ...initial, start_month: next };
      if (!template && fileId === "members") initial = { ...initial, kind: "employee" };
      if (preset) initial = { ...initial, ...preset };
    }
    const lockImported = (name) => fileId === "members" && importMode && MEMBER_IMPORTED_COLUMNS.includes(name) && !(mode === "edit" && !isOriginal) && !(mode === "add" && !template);
    const title = mode === "edit" ? fmt(T.masters.editTitle, { file: def.label }) : def.history === "effective" ? fmt(T.masters.addNextTitle, { file: def.label }) : T.masters.addAssignmentTitle;
    const lead =
      mode === "edit"
        ? isOriginal
          ? T.masters.editLead
          : T.masters.editAddedLead
        : def.history === "effective"
          ? T.masters.addNextLead
          : T.masters.addAssignmentLead;

    const form = html`<form class="yn-me-form" novalidate>
      <p class="yn-me-form-lead">${lead}</p>
      <div class="yn-me-fields">
        ${columns.map((c) => {
          const disabled = lockImported(c.name);
          return html`<div class="yn-me-field">
            <label for=${`yn-me-f-${c.name}`}>${c.label}${c.required ? html`<span class="yn-me-req" aria-hidden="true"> *</span>` : null} <span class="yn-me-colname">${c.name}</span></label>
            ${fieldFor(fileId, c, (initial[c.name] ?? "").trim(), disabled)}
            <span class="yn-me-field-hint" id=${`yn-me-f-${c.name}-hint`}>${disabled ? T.masters.hrReadonly : (FIELD_HINTS[c.name] ?? "")}</span>
          </div>`;
        })}
      </div>
      <div class="yn-me-form-msg" role="alert"></div>
      <div class="yn-me-confirm" hidden></div>
    </form>`;
    // 取り込みモードのメンバー追加: メンバーIDを選ぶと取り込み列を最新の行から写す
    if (fileId === "members" && importMode && mode === "add") {
      const idInput = form.querySelector('[name="member_id"]');
      idInput?.addEventListener("change", () => {
        const latest = latestByKey(docs.members, "member_id").get(idInput.value.trim());
        if (!latest) return;
        for (const name of MEMBER_IMPORTED_COLUMNS) {
          const el = form.querySelector(`[name="${name}"]`);
          if (el) el.value = cellOf(docs.members, latest.row, name);
        }
      });
    }
    const msg = form.querySelector(".yn-me-form-msg");
    const confirmBox = form.querySelector(".yn-me-confirm");
    const submitBtn = html`<button type="submit" class="yn-btn yn-btn-primary" data-role="submit">${mode === "edit" ? T.masters.confirm : T.masters.add}</button>`;
    const cancelBtn = html`<button type="button" class="yn-btn" onclick=${() => dialog.close()}>${T.masters.cancel}</button>`;
    form.append(html`<div class="yn-me-form-foot">${cancelBtn}${submitBtn}</div>`);
    let pending = null;

    const readValues = () => {
      const values = {};
      for (const c of columns) {
        const el = form.querySelector(`[name="${c.name}"]`);
        if (el) values[c.name] = String(el.value ?? "").trim();
      }
      const unitSel = form.querySelector('[name="__allocation_unit"]');
      if (unitSel && "allocation" in values) values.allocation = allocationFromInput(values.allocation, unitSel.value, std);
      return values;
    };
    const backToForm = () => {
      pending = null;
      confirmBox.hidden = true;
      confirmBox.replaceChildren();
      form.querySelector(".yn-me-fields").hidden = false;
      submitBtn.textContent = mode === "edit" ? T.masters.confirm : T.masters.add;
      form.querySelector(`[name="${columns[0].name}"]`)?.focus();
    };
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      if (pending) {
        const p = pending;
        returnFocusKey = p.focus;
        dialog.close();
        commit(fileId, p.doc, p.focus);
        return;
      }
      const values = readValues();
      const missing = columns.filter((c) => c.required && !lockImported(c.name) && (values[c.name] ?? "") === "");
      if (missing.length) {
        msg.textContent = fmt(T.masters.required, { fields: missing.map((c) => c.label).join("、") });
        form.querySelector(`[name="${missing[0].name}"]`)?.focus();
        return;
      }
      msg.textContent = "";
      const before = docs[fileId];
      let next;
      let focusAfter;
      if (mode === "edit") {
        next = updateRow(before, rowId, values);
        focusAfter = `edit:${rowId}`;
      } else {
        const r = addRow(before, values);
        next = r.doc;
        focusAfter = `edit:${r.rowId}`;
      }
      const impact = impactBetween(before, next, range);
      const changes = mode === "edit" ? columns.filter((c) => (rowRecord(before, row)[c.name] ?? "").trim() !== (values[c.name] ?? "")) : [];
      if (mode === "edit" && changes.length === 0) {
        dialog.close();
        return;
      }
      // 追加で過去に影響が無ければそのまま適用。修正は常に確認、追加も過去が変わるなら確認
      if (mode === "add" && impact.months.length === 0) {
        returnFocusKey = focusAfter;
        dialog.close();
        commit(fileId, next, focusAfter);
        return;
      }
      pending = { doc: next, focus: focusAfter };
      form.querySelector(".yn-me-fields").hidden = true;
      confirmBox.hidden = false;
      confirmBox.replaceChildren(
        html`<div>
          ${changes.length
            ? html`<p><strong>${T.masters.willChange}</strong></p><ul class="yn-me-change-list">${changes.map((c) => html`<li>${c.label}: <span class="yn-me-before">${(rowRecord(before, row)[c.name] ?? "").trim() || T.masters.emptyValue}</span> → <span class="yn-me-after">${values[c.name] || T.masters.emptyValue}</span></li>`)}</ul>`
            : html`<p><strong>${T.masters.willAdd}</strong></p>`}
          ${impact.months.length
            ? impactNote(fileId, impact, fmt(T.masters.pastNote, { month: monthJa(asOfMonth) }))
            : html`<p class="yn-me-impact-none">${T.masters.noImpact1}${monthJa(asOfMonth)} ${T.masters.noImpact2}</p>`}
          <p><button type="button" class="yn-btn" onclick=${backToForm}>${T.masters.backToInput}</button></p>
        </div>`,
      );
      submitBtn.textContent = impact.months.length ? fmt(T.masters.applyWithImpact, { n: impact.months.length }) : T.masters.apply;
      submitBtn.focus();
    });

    dialog.replaceChildren(html`<div class="yn-dialog-inner">
      <header class="yn-dialog-head">
        <h2 id="yn-me-dialog-title" class="yn-dialog-title">${title}<span class="yn-me-path"> ${fileName(def.path)}</span></h2>
        <button type="button" class="yn-btn yn-btn-icon" aria-label=${T.breakdown.close} onclick=${() => dialog.close()}>×</button>
      </header>
      <div class="yn-dialog-body">${form}</div>
    </div>`);
    if (!dialog.open) dialog.showModal();
    // 最初の空の入力欄にフォーカス（稼働計画でメンバーを入れて開いたときは配分から）。無ければ最初の欄。
    // 選択欄（select）は Space でリストが開き Esc がダイアログに届かないので、空でも最初には選ばない
    const fields = [...form.querySelectorAll("input:not([disabled]), select:not([disabled])")];
    (fields.find((el) => el.tagName === "INPUT" && el.value === "") ?? fields[0])?.focus();
  }

  function openDeleteDialog(fileId, rowId, focus) {
    if (locked) return;
    returnFocusKey = focus;
    const def = MASTER_FILES[fileId];
    const before = docs[fileId];
    const row = before.rows.find((r) => r.id === rowId);
    if (!row) return;
    const next = deleteRow(before, rowId);
    const impact = impactBetween(before, next, range);
    const rec = rowRecord(before, row);
    const columns = def.columns.filter((c) => before.header.includes(c.name));
    const doDelete = () => {
      // 削除後はその位置の次の行の「修正」か、追加ボタンにフォーカス
      const idx = before.rows.findIndex((r) => r.id === rowId);
      const neighbor = next.rows[idx] ?? next.rows[idx - 1];
      returnFocusKey = neighbor ? `del:${neighbor.id}` : `add:${fileId}`;
      dialog.close();
      commit(fileId, next, returnFocusKey);
    };
    dialog.replaceChildren(html`<div class="yn-dialog-inner">
      <header class="yn-dialog-head">
        <h2 id="yn-me-dialog-title" class="yn-dialog-title">${def.label}${T.masters.deleteConfirmTitle}</h2>
        <button type="button" class="yn-btn yn-btn-icon" aria-label=${T.breakdown.close} onclick=${() => dialog.close()}>×</button>
      </header>
      <div class="yn-dialog-body">
        <dl class="yn-me-dl">${columns.map((c) => html`<div><dt>${c.label}</dt><dd>${(rec[c.name] ?? "").trim() || "—"}</dd></div>`)}</dl>
        ${impact.months.length
          ? impactNote(fileId, impact, T.masters.deleteHint)
          : html`<p class="yn-me-impact-none">${T.masters.noImpact}</p>`}
        <p class="yn-me-small">${T.masters.deleteNote}</p>
        <div class="yn-me-form-foot">
          <button type="button" class="yn-btn" onclick=${() => dialog.close()}>${T.masters.abort}</button>
          <button type="button" class="yn-btn yn-btn-primary" data-role="confirm-delete" onclick=${doDelete}>${impact.months.length ? fmt(T.masters.deleteWithImpact, { n: impact.months.length }) : T.masters.delete}</button>
        </div>
      </div>
    </div>`);
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('[data-role="confirm-delete"]').focus();
  }

  // ---- 検証 ---------------------------------------------------------------
  function renderCheck() {
    const v = validation;
    const general = v.general;
    const status =
      v.errors > 0
        ? html`<p class="yn-me-check is-error" role="status"><span class="yn-chip yn-chip-warn"><span aria-hidden="true">!</span> ${T.dataCheck.severityError} ${integer(v.errors)}${T.masters.countSuffix}</span> ${T.masters.cannotSave}${v.warnings ? fmt(T.masters.warningsNotBlocking, { n: integer(v.warnings) }) : ""}</p>`
        : html`<p class="yn-me-check is-ok" role="status"><span class="yn-chip yn-chip-ok"><span aria-hidden="true">✓</span> ${T.dataCheck.noErrors}</span> ${T.masters.validationOk}${v.warnings ? fmt(T.masters.warningsNotBlocking2, { n: integer(v.warnings) }) : ""}</p>`;
    const byTab = MASTER_FILE_IDS.filter((id) => errorCount(id) > 0);
    parts.check.replaceChildren(html`<section class="yn-me-section" aria-labelledby="yn-me-check-title">
      <h2 id="yn-me-check-title" class="yn-section-title">${T.masters.validationTitle}</h2>
      ${status}
      ${byTab.length ? html`<p class="yn-me-small">${T.masters.filesWithErrors} ${byTab.map((id, i) => html`${i > 0 ? "、" : ""}<button type="button" class="yn-btn-link" data-fk=${`goto:${id}`} onclick=${() => {
        active = id;
        renderTabs();
        renderPanel();
        focusKey(`tab:${id}`);
      }}>${MASTER_FILES[id].label}（${integer(errorCount(id))}${T.masters.countSuffixParen}</button>`)}</p>` : null}
      ${general.length
        ? html`<ul class="yn-me-issues yn-me-general">${general.map((i) => html`<li class=${i.severity === "error" ? "is-error" : "is-warning"}><span aria-hidden="true">${i.severity === "error" ? "!" : "i"}</span> ${i.severity === "error" ? T.dataCheck.severityError : T.dataCheck.severityWarning}: ${i.message}</li>`)}</ul>`
        : null}
      <p class="yn-me-small">${T.masters.worklogWarningsNote}</p>
    </section>`);
  }

  // ---- 差分 ---------------------------------------------------------------
  function renderDiff() {
    const diffs = MASTER_FILE_IDS.map((id) => diffMasterDoc(docs[id])).filter((d) => d.count > 0);
    const body = diffs.length
      ? diffs.map((d) => {
          const def = MASTER_FILES[d.fileId];
          const cols = def.columns.filter((c) => docs[d.fileId].header.includes(c.name));
          const label = (name) => cols.find((c) => c.name === name)?.label ?? name;
          const line = (rec) => cols.map((c) => (rec[c.name] ?? "").trim() || "—").join(" ・ ");
          const rows = [
            ...d.added.map((a) => ({ kind: T.masters.added, chip: "yn-chip-ok", sign: "＋", key: a.rowId, text: line(a.after), detail: null })),
            ...d.changed.map((c) => ({ kind: T.masters.changed, chip: "yn-chip-neutral", sign: "✎", key: c.rowId, text: line(c.before), detail: c.columns.map((col) => fmt(T.masters.diffValue, { col: label(col), before: (c.before[col] ?? "").trim() || T.masters.emptyValue, after: (c.after[col] ?? "").trim() || T.masters.emptyValue })).join(" / ") })),
            ...d.removed.map((r) => ({ kind: T.masters.deleteKind, chip: "yn-chip-neutral", sign: "−", key: r.rowId, text: line(r.before), detail: null })),
          ];
          return html`<div class="yn-me-diff-file">
            <h3 class="yn-me-subtitle">${def.label} <span class="yn-me-path">${def.path}</span> <span class="yn-me-small">${T.masters.added} ${integer(d.added.length)} ${T.masters.diffChanged} ${integer(d.changed.length)} ${T.masters.diffRemoved} ${integer(d.removed.length)}</span></h3>
            <div class="yn-table-wrap"><table class="yn-table yn-table-compact yn-me-diff-table">
              <caption class="visually-hidden">${def.label}${T.masters.diffCaption}</caption>
              <thead><tr><th scope="col">${T.dataCheck.colKind}</th><th scope="col">${T.masters.diffRowCol}${cols.map((c) => c.label).join(" ・ ")}）</th><th scope="col">${T.masters.diffValuesCol}</th></tr></thead>
              <tbody>${rows.map((r) => html`<tr data-key=${r.key}><th scope="row"><span class=${`yn-chip ${r.chip}`}>${r.sign} ${r.kind}</span></th><td>${r.text}</td><td>${r.detail ?? (r.kind === T.masters.added ? T.masters.newRow : T.masters.wholeRowDeleted)}</td></tr>`)}</tbody>
            </table></div>
          </div>`;
        })
      : html`<p class="yn-me-empty">${T.masters.noDiff}</p>`;
    parts.diff.replaceChildren(html`<section class="yn-me-section" aria-labelledby="yn-me-diff-title">
      <h2 id="yn-me-diff-title" class="yn-section-title">${T.masters.diffTitle}</h2>
      <p class="yn-section-hint">${T.masters.diffNote}</p>
      ${body}
    </section>`);
  }

  // ---- 保存 ---------------------------------------------------------------
  function changedFiles() {
    return MASTER_FILE_IDS.filter((id) => diffMasterDoc(docs[id]).count > 0);
  }

  function blockedReason() {
    if (locked) return T.masters.saved;
    if (totalChanges() === 0) return T.masters.noChanges;
    if (validation.errors > 0) return fmt(T.masters.validationErrors, { n: integer(validation.errors) });
    return null;
  }

  function commitMessage() {
    const files = changedFiles();
    return fmt(T.masters.commitTitle, { files: files.map((id) => fileName(MASTER_FILES[id].path)).join(", ") });
  }

  function mrDescription() {
    const lines = [T.masters.commitBody, ""];
    for (const id of changedFiles()) {
      const d = diffMasterDoc(docs[id]);
      lines.push(fmt(T.masters.commitFileLine, { path: MASTER_FILES[id].path, added: d.added.length, changed: d.changed.length, removed: d.removed.length }));
    }
    return lines.join("\n");
  }

  async function doSave(messageInput) {
    if (saving || blockedReason()) return;
    const token = session.get(TOKEN_STORAGE_KEY) ?? "";
    saving = true;
    outcome = null;
    renderSave();
    const files = changedFiles().map((id) => ({ path: data.files[id].repoPath ?? MASTER_FILES[id].path, content: validation.texts[id], lastCommitId: bases[id].lastCommitId }));
    try {
      const result = await saveToGitLab(fetchImpl, { config: data.masterEdit, token, files, message: (messageInput || "").trim() || commitMessage(), description: mrDescription(), now: now() });
      outcome = { kind: "ok", result };
      locked = true;
      // 保存できたら下書きは不要
      local.remove(DRAFT_STORAGE_KEY);
      draftSavedAt = null;
    } catch (e) {
      outcome = { kind: "error", error: { kind: e?.kind ?? "other", message: e?.message ?? String(e), detail: e?.detail ?? "", status: e?.status ?? null, partial: e?.partial ?? null } };
      if (outcome.error.kind === "permission" && outcome.error.status === 401) session.remove(TOKEN_STORAGE_KEY);
    } finally {
      saving = false;
      renderAll();
      focusKey("save:outcome");
    }
  }

  function download(id) {
    const text = validation.texts[id];
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName(MASTER_FILES[id].path);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    downloaded.add(id);
    renderSave();
    focusKey(`dl:${id}`);
  }

  function resetAll(focus = "add:" + active) {
    docs = Object.fromEntries(MASTER_FILE_IDS.map((id) => [id, parseMasterDoc(id, bases[id].text)]));
    rebasedInfo = {};
    locked = false;
    outcome = null;
    downloaded = new Set();
    validation = validateEdited(docs, data.context, config);
    persistDraft();
    renderAll();
    focusKey(focus);
  }

  function openDiscardDialog() {
    returnFocusKey = "save:discard";
    dialog.replaceChildren(html`<div class="yn-dialog-inner">
      <header class="yn-dialog-head">
        <h2 id="yn-me-dialog-title" class="yn-dialog-title">${T.masters.discardAllTitle}</h2>
        <button type="button" class="yn-btn yn-btn-icon" aria-label=${T.breakdown.close} onclick=${() => dialog.close()}>×</button>
      </header>
      <div class="yn-dialog-body">
        <p>${integer(totalChanges())} ${T.masters.discardAllText}</p>
        <div class="yn-me-form-foot">
          <button type="button" class="yn-btn" onclick=${() => dialog.close()}>${T.masters.abort}</button>
          <button type="button" class="yn-btn yn-btn-primary" data-role="confirm-discard" onclick=${() => {
            returnFocusKey = `add:${active}`;
            dialog.close();
            resetAll();
          }}>${T.masters.discardAll}</button>
        </div>
      </div>
    </div>`);
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('[data-role="confirm-discard"]').focus();
  }

  function renderOutcome() {
    if (saving) return html`<div class="yn-me-outcome is-busy" role="status" aria-live="polite" tabindex="-1" data-fk="save:outcome"><span class="yn-spinner yn-me-spinner" aria-hidden="true"></span> ${T.masters.saving}</div>`;
    if (!outcome) return html`<div class="yn-me-outcome-slot" aria-live="polite"></div>`;
    if (outcome.kind === "ok") {
      const r = outcome.result;
      return html`<div class="yn-me-outcome is-ok" role="status" tabindex="-1" data-fk="save:outcome">
        <p class="yn-me-outcome-title"><span aria-hidden="true">✓</span> ${r.commitMode === "mr" ? T.masters.mrCreated : fmt(T.masters.committed, { branch: r.branch })}</p>
        <ul>
          ${r.mergeRequestUrl ? html`<li>${T.masters.mrLabel} <a href=${r.mergeRequestUrl} target="_blank" rel="noopener">${r.mergeRequestIid ? `!${r.mergeRequestIid}` : T.masters.open}（GitLab）</a></li>` : null}
          ${r.commitUrl ? html`<li>${T.masters.commitLabel} <a href=${r.commitUrl} target="_blank" rel="noopener">${r.commitId ? r.commitId.slice(0, 8) : T.masters.open}（GitLab）</a></li>` : null}
          ${r.commitMode === "mr" ? html`<li>${T.masters.branchLabel} <code>${r.branch}</code></li>` : null}
        </ul>
        <p>${r.commitMode === "mr" ? T.masters.afterMr : T.masters.afterCommit}${T.masters.draftCleared}</p>
        <p><button type="button" class="yn-btn" data-fk="save:restart" onclick=${() => resetAll()}>${T.masters.startOver}</button></p>
      </div>`;
    }
    const e = outcome.error;
    const titles = { conflict: T.masters.errConflict, permission: T.masters.errPermission, network: T.masters.errNetwork, other: T.masters.errOther };
    return html`<div class="yn-me-outcome is-error" role="alert" tabindex="-1" data-fk="save:outcome" data-error-kind=${e.kind}>
      <p class="yn-me-outcome-title"><span aria-hidden="true">!</span> ${titles[e.kind] ?? titles.other}</p>
      <p>${e.message}</p>
      ${e.detail ? html`<p class="yn-me-small">${T.masters.gitlabResponse} <code>${e.detail}</code></p>` : null}
      <p class="yn-me-small">${T.masters.editsKept}</p>
      ${e.kind === "network" ? html`<p><button type="button" class="yn-btn yn-btn-primary" data-fk="save:to-download" onclick=${() => {
        mode = "download";
        outcome = null;
        renderAll();
        focusKey("save:heading");
      }}>${T.masters.switchToDownload}</button></p>` : null}
    </div>`;
  }

  function renderSave() {
    const reason = blockedReason();
    const files = changedFiles();
    const cfg = data.masterEdit;
    let body;
    if (mode === "gitlab") {
      const hasToken = (session.get(TOKEN_STORAGE_KEY) ?? "") !== "";
      const tokenInput = html`<input type="password" id="yn-me-token" class="yn-input" autocomplete="off" aria-labelledby="yn-me-token-label" spellcheck="false" aria-describedby="yn-me-token-hint" placeholder="glpat-…">`;
      const setToken = () => {
        const v = tokenInput.value.trim();
        if (v === "") return;
        session.set(TOKEN_STORAGE_KEY, v);
        tokenInput.value = "";
        renderSave();
        focusKey("save:token-clear");
      };
      tokenInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          setToken();
        }
      });
      const msgInput = html`<input type="text" id="yn-me-message" class="yn-input yn-me-message" value=${commitMessage()} aria-describedby="yn-me-message-hint">`;
      const tokenReason = hasToken ? null : T.gitlab.noToken;
      const disabled = saving || !!reason || !!tokenReason;
      body = html`<div class="yn-me-save-body">
        <p>${T.masters.saveTarget1} <code>${cfg.gitlab.projectId}</code> ${T.masters.particleNo} <code>${cfg.gitlab.targetBranch}</code> ${T.masters.saveTarget2}${cfg.gitlab.commitMode === "mr" ? T.masters.modeMr : fmt(T.masters.modeDirect, { branch: cfg.gitlab.targetBranch })}${T.masters.saveWho}</p>
        ${data.gitAvailable ? null : html`<p class="yn-note yn-note-warn">${T.masters.noBaseWarning}</p>`}
        <div class="yn-me-field">
          <span class="yn-me-label" id="yn-me-token-label">${T.masters.tokenLabel}</span>
          ${hasToken
            ? html`<p class="yn-me-token-set"><span class="yn-chip yn-chip-ok"><span aria-hidden="true">✓</span> ${T.masters.tokenSet}</span> ${T.masters.tokenSetNote} <button type="button" class="yn-btn yn-btn-sm" data-fk="save:token-clear" onclick=${() => {
                session.remove(TOKEN_STORAGE_KEY);
                renderSave();
                document.getElementById("yn-me-token")?.focus();
              }}>${T.masters.tokenClear}</button></p>`
            : html`<div class="yn-me-inline">${tokenInput}<button type="button" class="yn-btn" data-fk="save:token-set" onclick=${setToken}>${T.masters.tokenUse}</button></div>`}
          <span class="yn-me-field-hint" id="yn-me-token-hint">${T.masters.tokenHelp}</span>
        </div>
        <div class="yn-me-field">
          <label for="yn-me-message">${T.masters.commitMessage}${cfg.gitlab.commitMode === "mr" ? T.masters.mrTitleSuffix : ""}</label>
          ${msgInput}
          <span class="yn-me-field-hint" id="yn-me-message-hint">${T.masters.commitMessageHelp}</span>
        </div>
        <p class="yn-me-actions">
          <button type="button" class="yn-btn yn-btn-primary" data-fk="save:submit" disabled=${disabled} aria-describedby="yn-me-save-reason" onclick=${() => doSave(msgInput.value)}>${cfg.gitlab.commitMode === "mr" ? T.masters.saveMr : T.masters.saveDirect}</button>
        </p>
        <p id="yn-me-save-reason" class="yn-me-small">${reason ?? tokenReason ?? fmt(T.masters.oneCommit, { files: files.map((id) => fileName(MASTER_FILES[id].path)).join("・") })}</p>
      </div>`;
    } else {
      body = html`<div class="yn-me-save-body">
        ${configuredMode === "gitlab" ? html`<p class="yn-note yn-note-warn">${T.masters.fallbackDownload}</p>` : null}
        <p>${T.masters.downloadLead}</p>
        <ol class="yn-me-steps">
          <li>${T.masters.step1}</li>
          <li>${T.masters.step2a}${files.length ? files.map((id, i) => html`${i > 0 ? "、" : ""}<code>${MASTER_FILES[id].path}</code>`) : html`<code>data/masters/…</code>`}${T.masters.step2b}</li>
          <li class="yn-me-step-check">${T.masters.step3a}<strong>${T.masters.step3b}</strong>${T.masters.step3c}</li>
          <li>${T.masters.step4}</li>
          <li>${T.masters.step5}</li>
          <li>${T.masters.step6}</li>
        </ol>
        <div class="yn-me-downloads">
          ${files.length
            ? files.map((id) => {
                const link = webFileUrl(cfg, data.files[id].repoPath ?? MASTER_FILES[id].path);
                return html`<p class="yn-me-dl-row">
                  <button type="button" class="yn-btn yn-btn-primary yn-export" data-fk=${`dl:${id}`} disabled=${!!reason} onclick=${() => download(id)}>⤓ ${fileName(MASTER_FILES[id].path)} ${T.masters.downloadSuffix}</button>
                  <span class="yn-me-small">${MASTER_FILES[id].label}: ${integer(diffMasterDoc(docs[id]).count)}${T.masters.changesSuffix}${downloaded.has(id) ? T.masters.downloaded : ""}</span>
                  <span class="yn-me-small" data-base-commit=${id}>${bases[id].lastCommitId ? html`${T.masters.baseCommit} <code>${bases[id].lastCommitId.slice(0, 8)}</code>` : T.masters.noBaseCommit}</span>
                  ${link ? html`<a href=${link} target="_blank" rel="noopener" class="yn-me-small">${T.masters.openInGitlab}</a>` : null}
                </p>`;
              })
            : null}
        </div>
        <p id="yn-me-save-reason" class="yn-me-small">${reason ?? T.masters.downloadNote}</p>
      </div>`;
    }
    parts.save.replaceChildren(html`<section class="yn-me-section yn-me-save" aria-labelledby="yn-me-save-title">
      <h2 id="yn-me-save-title" class="yn-section-title" tabindex="-1" data-fk="save:heading">${T.masters.saveTitle1}${mode === "gitlab" ? "GitLab" : T.masters.csvDownload}）</h2>
      ${body}
      ${renderOutcome()}
      <p class="yn-me-actions yn-me-discard">
        <button type="button" class="yn-btn" data-fk="save:discard" disabled=${totalChanges() === 0 || saving} onclick=${openDiscardDialog}>${T.masters.discardAllButton}</button>
        ${draftSavedAt ? html`<span class="yn-me-small">${T.masters.autosaved1}${dateTimeJst(draftSavedAt)}${T.masters.autosaved2}</span>` : null}
      </p>
    </section>`);
  }

  function renderAll() {
    root.dataset.mode = mode;
    root.classList.toggle("is-locked", locked);
    renderDraft();
    renderTabs();
    renderPanel();
    renderCheck();
    renderDiff();
    renderSave();
  }

  root.append(parts.draft, parts.tabs, parts.panel, parts.check, parts.diff, parts.save, dialog);
  renderAll();
  return root;
}
