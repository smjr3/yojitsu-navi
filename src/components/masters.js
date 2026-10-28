/**
 * マスタ編集画面（SPEC §19）の部品: タブ・表・行の追加／修正／削除ダイアログ・検証・差分・保存（GitLab / CSV ダウンロード）・下書き
 *
 * 純粋ロジック（CSV の書き出し・差分・影響月・検証・下書きの当て直し・GitLab API）は src/core/masterEdit.ts と src/core/gitlab.ts。
 * ここは状態を持って DOM を描くだけ。状態が変わるたびに該当部分を描き直し、data-fk でフォーカスを戻す。
 *
 *   mastersEditor({ data, asOfMonth, minMonth, storage, fetchImpl, now }) → HTMLElement
 */
import { html } from "htl";
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
    what: "メンバーの所属チーム・役職・区分（社員／パートナー）。",
    effect: "役職が変わると、その月からの時間単価（単価表の役職の行）が変わり、原価が変わります。所属チームはメンバー別画面の所属に使います（契約の担当チームは契約で決まるので変わりません）。",
    howto: "異動・昇格は、既存の行を書き換えずに「新しい適用開始月の行を追加」で、変わった月からの行を足してください。",
  },
  rates: {
    what: "役職ごとの時間単価と、パートナー個人の時間単価（キーにメンバーIDを書く）。",
    effect: "原価 = 作業時間 × その月に有効な時間単価。単価を変えると、その適用開始月からの原価・粗利・消化率・着地見込みが変わります。",
    howto: "単価改定は「新しい適用開始月の行を追加」。例: 4月から部長の単価を上げる → キー「部長」、適用開始月 2026-04 の行を足す。",
  },
  teams: {
    what: "組織（本部・事業部・課・チーム・班など）の名前・種別・親子関係・リーダー。段数は自由で、種別は組織ごとに好きな呼び名を付けられます。",
    effect: "チーム一覧の組織の木と、上位組織の合計（配下の合計）が変わります。種別とリーダーは表示だけで、数値は変わりません。組織を消すと、その組織を使っているメンバー・契約が検証エラーになります。",
    howto: "組織変更（新設・統合・改称・格上げ・リーダー交代）は、変わった月からの行を追加します（過去の月は当時の組織のまま集計されます）。",
  },
  assignments: {
    what: "誰を、どの契約に、何人月（0〜1.0）割り当てるか。",
    effect: "着地見込みの「アサイン方式」と、メンバー別画面の計画（計画時間・計画原価）が変わります。1 人の月合計は 1.0 以下にしてください。",
    howto: "期間（開始月〜終了月）と配分を入力します。配分を途中で変えるときは、元の行の終了月を前月にして、新しい行を追加します。",
  },
};

/** 稼働計画タブ（§23。アサインのファイルを、組織 × メンバー × 月で見せる別の見せ方） */
export const PLAN_VIEW_ID = "plan";
const VIEW_IDS = [...MASTER_FILE_IDS, PLAN_VIEW_ID];
const VIEW_LABELS = { plan: { label: "稼働計画", file: "人 × 月の一覧" } };

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

const KIND_LABELS = { employee: "社員", partner: "パートナー" };
const STATE_LABELS = { added: "追加", changed: "変更" };

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
    if (column === "team_id" || column === "parent_team_id") return teamNames().get(value) ?? "（存在しないチーム）";
    if ((fileId === "assignments" && column === "member_id") || (fileId === "rates" && column === "key")) return memberNames().get(value) ?? null;
    if (column === "leader_member_id") return memberNames().get(value) ?? "（存在しないメンバー）";
    if (column === "allocation" && Number.isFinite(Number(value))) return `= ${hoursFromAllocation(Number(value), std)} 時間`;
    if (column === "contract_id") {
      const c = contracts.find((x) => x.id === value);
      return c ? `${c.customer} / ${c.project}` : "（存在しない契約）";
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
    "both-changed": "あなたも他の人も、この行を変更しました",
    "changed-vs-deleted": "あなたが変更した行を、他の人が削除しました",
    "deleted-vs-changed": "あなたが削除した行を、他の人が変更しました",
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
        : html`<span class="yn-me-conflict-vals">${(shown.length ? shown : cols).map((col, i) => html`${i > 0 ? " / " : ""}${col.label}: <strong>${(rec[col.name] ?? "").trim() || "（空）"}</strong>`)}</span>`;
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
      <p class="yn-me-small">下書きを作ったときの行: ${cols.map((col) => (c.base[col.name] ?? "").trim() || "—").join(" ・ ")}</p>
      ${option("mine", "自分の下書きを残す", c.mine, "この行を削除する")}
      ${option("theirs", "最新のデータを残す", c.theirs, "削除されたまま（行なし）")}
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
    const counts = ids.map((id) => `${MASTER_FILES[id].label} ${integer(draftFileCount(d.files[id]))}件`);
    const conflicts = ids.flatMap((id) => results[id].conflicts.map((c) => ({ fileId: id, c })));
    const unresolved = ids.flatMap((id) => results[id].unresolved.map((cid) => `${id}:${cid}`));
    const applied = ids.reduce((sum, id) => sum + results[id].applied, 0);
    const restore = () => {
      if (unresolved.length) {
        draftMsg = `どちらを残すか、まだ選んでいない行が ${integer(unresolved.length)} 件あります。すべて選んでから復元してください。`;
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
      <h2 id="yn-me-draft-title" class="yn-me-banner-title">保存していない編集内容（下書き）があります</h2>
      <p>${dateTimeJst(d.savedAt)} に自動保存した下書き: ${counts.join("、")}。続きから編集するには「下書きを復元する」を押してください。</p>
      ${stale.length
        ? html`<div class="yn-me-stale" role="alert">
            <p><strong>元データが更新されています</strong>（${stale.map((id) => fileName(MASTER_FILES[id].path)).join("、")}）。下書きを作ったあとに、他の人がこのファイルを更新しました。復元すると、下書きの変更（追加・変更・削除）を<strong>最新のデータに当て直します</strong>（古いデータを土台にしたまま保存・ダウンロードすることはありません）。</p>
            <p>そのまま当て直せる変更: ${integer(applied)} 件。${conflicts.length
              ? html`他の人も同じ行を変更・削除しているため当て直せない変更: <strong>${integer(conflicts.length)} 件</strong>。下の一覧で、行ごとにどちらを残すか選んでから復元してください。`
              : "当て直せない変更（他の人も同じ行を変えたもの）はありません。"}</p>
          </div>`
        : null}
      ${conflicts.length
        ? html`<div class="yn-me-conflicts">
            <h3 class="yn-me-subtitle">どちらを残すか選んでください（${integer(conflicts.length)} 件、未選択 ${integer(unresolved.length)} 件）</h3>
            ${conflicts.map(({ fileId, c }) => conflictItem(fileId, c))}
          </div>`
        : null}
      ${draftMsg ? html`<p class="yn-me-form-msg" role="alert">${draftMsg}</p>` : null}
      <p class="yn-me-actions">
        <button type="button" class="yn-btn yn-btn-primary" data-fk="draft:restore" onclick=${restore}>下書きを復元する</button>
        <button type="button" class="yn-btn" data-fk="draft:discard" onclick=${discard}>下書きを破棄する</button>
      </p>
      <p class="yn-me-small">どちらかを選ぶまで、新しい編集は下書きに保存されません。</p>
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
    parts.tabs.replaceChildren(html`<div class="yn-me-tabs" role="tablist" aria-label="編集するファイル" onkeydown=${onKey}>
      ${VIEW_IDS.map((id) => {
        const isPlan = id === PLAN_VIEW_ID;
        const errs = isPlan ? 0 : errorCount(id);
        const selected = id === active;
        return html`<button type="button" role="tab" id=${`yn-me-tab-${id}`} class=${isPlan ? "yn-me-tab yn-me-tab-plan" : "yn-me-tab"} aria-selected=${selected ? "true" : "false"} aria-controls="yn-me-panel" tabindex=${selected ? "0" : "-1"} data-fk=${`tab:${id}`} onclick=${() => select(id)}>
          <span class="yn-me-tab-label">${isPlan ? VIEW_LABELS.plan.label : MASTER_FILES[id].label}</span>
          <span class="yn-me-tab-file">${isPlan ? VIEW_LABELS.plan.file : fileName(MASTER_FILES[id].path)}</span>
          ${!isPlan && counts[id] > 0 ? html`<span class="yn-chip yn-chip-neutral">変更 ${integer(counts[id])}</span>` : null}
          ${errs > 0 ? html`<span class="yn-chip yn-chip-warn"><span aria-hidden="true">!</span> エラー ${integer(errs)}</span>` : null}
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

    const search = html`<input type="search" class="yn-input yn-me-search" id=${`yn-me-q-${fileId}`} placeholder="この表を検索" aria-label=${`${def.label}の表を検索`} value=${f.q}>`;
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

    const addLabel = isHistory ? "＋ 新しい適用開始月の行を追加" : "＋ アサインを追加";
    const notes = [];
    if (meta.encoding && meta.encoding !== "utf-8") notes.push(`元のファイルは ${meta.encoding === "shift_jis" ? "Shift_JIS" : "BOM 付き UTF-8"} です。保存すると UTF-8（BOM なし）に変わるため、GitLab 上では全行が変更として表示されます。`);
    if (meta.lineEnding === "crlf") notes.push("元のファイルの改行が CRLF です。保存すると LF に揃えるため、GitLab 上では全行が変更として表示されます。");
    if (rebasedInfo[fileId]) {
      const ri = rebasedInfo[fileId];
      notes.push(`このファイルは、古い元データで作った下書きを最新のデータに当て直して復元しました（そのまま当て直した変更 ${integer(ri.applied)} 件${ri.resolved ? `、どちらを残すか選んだ行 ${integer(ri.resolved)} 件` : ""}）。保存の前に「変更内容」で確認してください。`);
    }
    if (fileId === "members" && importMode) notes.push(`氏名・区分・役職・部署・課は人事データから自動で取り込みます（memberSource: ${data.memberSourceAdapter}）。ここで編集できるのは所属チームと適用開始月だけです。`);

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
        const content = html`<span class=${changedCol ? "yn-me-val is-changed" : "yn-me-val"}>${v === "" ? html`<span class="yn-muted" aria-label="空">—</span>` : v}</span>${hint ? html`<span class="yn-me-hint">${hint}</span>` : null}`;
        const cls = `${c.input === "number" ? "num" : ""}${c.input === "month" ? " yn-me-month" : ""}`;
        return i === 0 ? html`<th scope="row" class=${cls}>${content}</th>` : html`<td class=${cls}>${content}</td>`;
      });
      const actions = html`<td class="yn-me-actions-cell"><div class="yn-me-row-actions">
        ${isHistory ? html`<button type="button" class="yn-btn yn-btn-sm" data-fk=${`next:${r.id}`} aria-label=${`${keyText} の新しい適用開始月の行を追加`} onclick=${() => openRowDialog({ fileId, mode: "add", template: r, focus: `next:${r.id}` })}>＋ 新しい月</button>` : null}
        <button type="button" class="yn-btn yn-btn-sm" data-fk=${`edit:${r.id}`} aria-label=${`${keyText} の行を修正`} onclick=${() => openRowDialog({ fileId, mode: "edit", rowId: r.id, focus: `edit:${r.id}` })}>修正</button>
        ${st === "changed" ? html`<button type="button" class="yn-btn yn-btn-sm" data-fk=${`revert:${r.id}`} aria-label=${`${keyText} の変更を元に戻す`} onclick=${() => commit(fileId, revertRow(docs[fileId], r.id), `edit:${r.id}`)}>元に戻す</button>` : null}
        ${deletable ? html`<button type="button" class="yn-btn yn-btn-sm" data-fk=${`del:${r.id}`} aria-label=${`${keyText} の行を削除`} onclick=${() => openDeleteDialog(fileId, r.id, `del:${r.id}`)}>削除</button>` : null}
      </div></td>`;
      const stateChip =
        st === "unchanged" && !invalid
          ? null
          : html`<span class="yn-chip-row">${st !== "unchanged" ? html`<span class=${`yn-chip ${st === "added" ? "yn-chip-ok" : "yn-chip-neutral"}`}>${st === "added" ? "＋" : "✎"} ${STATE_LABELS[st]}</span>` : null}${invalid ? html`<span class="yn-chip yn-chip-warn"><span aria-hidden="true">!</span> エラー</span>` : null}</span>`;
      const tr = html`<tr data-key=${r.id} class=${`yn-me-row is-${st}${invalid ? " is-invalid" : ""}`} aria-describedby=${list.length ? issueId : null}>${cells}<td class="yn-me-state">${stateChip}</td>${actions}</tr>`;
      if (list.length === 0) return [tr];
      return [
        tr,
        html`<tr class="yn-me-issue-row"><td colspan=${colCount} id=${issueId}><ul class="yn-me-issues">${list.map(
          (i) => html`<li class=${i.severity === "error" ? "is-error" : "is-warning"}><span aria-hidden="true">${i.severity === "error" ? "!" : "i"}</span> ${i.severity === "error" ? "エラー" : "警告"}: ${issueText(i)}</li>`,
        )}</ul></td></tr>`,
      ];
    });

    const removed = diffMasterDoc(doc).removed;
    parts.panel.replaceChildren(html`<section id="yn-me-panel" class="yn-me-panel" role="tabpanel" aria-labelledby=${`yn-me-tab-${fileId}`}>
      <div class="yn-me-panel-head">
        <div>
          <h2 class="yn-section-title">${def.label}<span class="yn-me-path"> ${meta.path}</span></h2>
          <p class="yn-me-help"><strong>内容:</strong> ${help.what} <strong>変えると:</strong> ${help.effect}</p>
          <p class="yn-me-help"><strong>編集のしかた:</strong> ${help.howto}</p>
        </div>
      </div>
      ${notes.map((n) => html`<p class="yn-note yn-note-warn">${n}</p>`)}
      <div class="yn-me-toolbar">
        <button type="button" class="yn-btn yn-btn-primary" data-fk=${`add:${fileId}`} disabled=${locked} onclick=${() => openRowDialog({ fileId, mode: "add", focus: `add:${fileId}` })}>${addLabel}</button>
        ${search}
        <label class="yn-toggle-chip" for=${`yn-me-changed-${fileId}`}>${changedOnly}<span>変更・エラーの行だけ表示</span></label>
        <span class="yn-table-count" aria-live="polite">${integer(shown.length)} / ${integer(doc.rows.length)} 行</span>
      </div>
      <div class="yn-table-wrap yn-me-table-wrap" tabindex="0" role="region" aria-label=${`${def.label}の表（横にスクロールできます）`}>
        <table class="yn-table yn-table-compact yn-me-table">
          <caption class="visually-hidden">${def.label}（${meta.path}）。ファイルの行の順に表示</caption>
          <thead><tr>
            ${columns.map((c) => html`<th scope="col" class=${c.input === "number" ? "num" : ""}><span class="yn-me-th">${c.label}</span><span class="yn-th-sub">${c.name}</span></th>`)}
            <th scope="col">状態</th>
            <th scope="col">操作</th>
          </tr></thead>
          <tbody>${rowsHtml.length ? rowsHtml : html`<tr class="yn-table-empty"><td colspan=${colCount}>${doc.rows.length === 0 ? "行がありません。「" + addLabel.replace("＋ ", "") + "」から追加してください。" : "条件に合う行がありません。検索語か「変更・エラーの行だけ表示」を見直してください。"}</td></tr>`}</tbody>
        </table>
      </div>
      ${removed.length
        ? html`<div class="yn-me-removed"><h3 class="yn-me-subtitle">削除する行（${integer(removed.length)}件）</h3><ul>${removed.map(
            (r) => html`<li><span class="yn-chip yn-chip-neutral">− 削除</span> <span class="yn-me-removed-text">${columns.map((c) => r.before[c.name] ?? "").join(" ・ ")}</span> <button type="button" class="yn-btn yn-btn-sm" data-fk=${`restore:${r.rowId}`} onclick=${() => commit(fileId, restoreRow(docs[fileId], r.rowId), `edit:${r.rowId}`)}>削除を取り消す</button></li>`,
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
    const leaderText = (id) => (id ? `${names.get(id) ?? "（存在しないメンバー）"}（${id}）` : "未設定");
    const optLabel = (n) => `${"　".repeat(n.depth)}${n.name}${n.level ? `［${n.level}］` : ""}${n.leaderMemberId ? ` ・ リーダー ${names.get(n.leaderMemberId) ?? n.leaderMemberId}` : ""}`;
    const contractLabel = (id) => {
      const c = contracts.find((x) => x.id === id);
      return c ? `${id} ${c.customer} / ${c.project}` : `${id}（存在しない契約）`;
    };
    const fyLabel = `${months[0].slice(0, 4)}年度（${monthJa(months[0])}〜${monthJa(last)}）`;
    const shiftYear = (d) => {
      plan.months = months.map((m) => addMonths(m, 12 * d));
      renderPanel();
      focusKey(d < 0 ? "plan:prev" : "plan:next");
    };
    const teamSel = html`<select id="yn-me-plan-team" class="yn-select" data-fk="plan:team">
      <option value="" selected=${plan.teamId === null}>すべての組織</option>
      ${flat.map((n) => html`<option value=${n.teamId} selected=${plan.teamId === n.teamId}>${optLabel(n)}</option>`)}
      ${plan.teamId !== null && !tree[plan.teamId] ? html`<option value=${plan.teamId} selected>${plan.teamId}（この年度の組織にありません）</option>` : null}
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
          <span class="yn-chip-row">${r.support ? html`<span class="yn-chip yn-chip-neutral">応援</span>` : null}${r.overMonths.length ? html`<span class="yn-chip yn-chip-warn"><span aria-hidden="true">!</span> 1.0 超 ${integer(r.overMonths.length)}か月</span>` : null}${changed ? html`<span class="yn-chip yn-chip-neutral">変更 ${integer(changed)}</span>` : null}${rowErrors ? html`<span class="yn-chip yn-chip-warn"><span aria-hidden="true">!</span> エラー ${integer(rowErrors)}</span>` : null}</span>
        </th>
        ${r.monthly.map((v, i) => html`<td class=${`num yn-me-plan-cell${v > 1 + 1e-9 ? " is-over" : v > 0 ? " is-set" : ""}`} title=${`${months[i]}: ${pm(v)} 人月`}>${v > 0 ? pm(v) : html`<span class="yn-muted" aria-label="0">—</span>`}</td>`)}
        <td class="num">${pm(sum)}</td>
        <td class="yn-me-actions-cell"><div class="yn-me-row-actions">
          <button type="button" class="yn-btn yn-btn-sm" data-fk=${`plan:toggle:${r.memberId}`} aria-expanded=${open ? "true" : "false"} aria-controls=${detailId} onclick=${() => toggle(r.memberId)}>計画 ${integer(r.assignments.length)}件 ${open ? "▴" : "▾"}</button>
          <button type="button" class="yn-btn yn-btn-sm" data-fk=${`plan:add:${r.memberId}`} disabled=${locked} aria-label=${`${r.name || r.memberId} の計画を追加`} onclick=${() => addFor(r.memberId, `plan:add:${r.memberId}`)}>＋ 追加</button>
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
          <span class="yn-me-plan-alloc">${Number.isFinite(a.allocation) ? `${pm(a.allocation)} 人月/月` : "（配分が数値ではありません）"}</span>
          ${st !== "unchanged" ? html`<span class=${`yn-chip ${st === "added" ? "yn-chip-ok" : "yn-chip-neutral"}`}>${st === "added" ? "＋" : "✎"} ${STATE_LABELS[st]}</span>` : null}
          <span class="yn-me-row-actions">
            <button type="button" class="yn-btn yn-btn-sm" data-fk=${`edit:${a.rowId}`} disabled=${locked} aria-label=${`${a.contractId} の計画を修正`} onclick=${() => openRowDialog({ fileId: "assignments", mode: "edit", rowId: a.rowId, focus: `edit:${a.rowId}` })}>修正</button>
            <button type="button" class="yn-btn yn-btn-sm" data-fk=${`del:${a.rowId}`} disabled=${locked} aria-label=${`${a.contractId} の計画を削除`} onclick=${() => openDeleteDialog("assignments", a.rowId, `plan:toggle:${r.memberId}`)}>削除</button>
          </span>
          ${list.length ? html`<ul class="yn-me-issues">${list.map((i) => html`<li class=${i.severity === "error" ? "is-error" : "is-warning"}><span aria-hidden="true">${i.severity === "error" ? "!" : "i"}</span> ${i.severity === "error" ? "エラー" : "警告"}: ${issueText(i)}</li>`)}</ul>` : null}
        </li>`;
      });
      return [
        main,
        html`<tr class="yn-me-plan-detail" id=${detailId}><td colspan=${months.length + 3}>
          ${items.length ? html`<ul class="yn-me-plan-items">${items}</ul>` : html`<p class="yn-muted">この年度に掛かる計画はありません。</p>`}
          ${r.overMonths.length ? html`<p class="yn-me-small">1.0 人月を超える月: ${r.overMonths.join("、")}（このままでは保存できません）</p>` : null}
        </td></tr>`,
      ];
    });

    parts.panel.replaceChildren(html`<section id="yn-me-panel" class="yn-me-panel yn-me-plan" role="tabpanel" aria-labelledby=${`yn-me-tab-${PLAN_VIEW_ID}`}>
      <div class="yn-me-panel-head">
        <div>
          <h2 class="yn-section-title">稼働計画<span class="yn-me-path"> ${data.files.assignments.path}</span></h2>
          <p class="yn-me-help"><strong>内容:</strong> リーダーが、組織のメンバー一人ひとりを「どの契約に、月何人月」充てるかを入れる画面です。中身はアサイン（assignments.csv）で、保存・下書き・検証は他のタブと同じです。</p>
          <p class="yn-me-help"><strong>入力のしかた:</strong> 人月（例 0.1）でも時間（例 16 時間）でも入力できます。時間は ${integer(std)} 時間 = 1 人月で人月に直して保存し、表示は人月に揃えます。1 人の月の合計は 1.0 人月までです。</p>
        </div>
      </div>
      <div class="yn-me-toolbar yn-me-plan-toolbar">
        <label class="yn-me-plan-label" for="yn-me-plan-team">組織</label>${teamSel}
        <span class="yn-me-plan-fy">
          <button type="button" class="yn-btn yn-btn-sm" data-fk="plan:prev" aria-label="前の年度" onclick=${() => shiftYear(-1)}>◀</button>
          <span aria-live="polite">${fyLabel}</span>
          <button type="button" class="yn-btn yn-btn-sm" data-fk="plan:next" aria-label="次の年度" onclick=${() => shiftYear(1)}>▶</button>
        </span>
        <button type="button" class="yn-btn yn-btn-primary" data-fk="add:plan" disabled=${locked} onclick=${() => addFor(null, "add:plan")}>＋ 計画を追加</button>
      </div>
      ${unit ? html`<p class="yn-me-plan-unit">${unit.name}${unit.level ? html` <span class="yn-chip yn-chip-neutral">${unit.level}</span>` : null} ・ リーダー: ${leaderText(unit.leaderMemberId)} ・ 配下の組織とメンバーを含みます（他の組織から、この組織の契約に入る人は「応援」）</p>` : null}
      <div class="yn-table-wrap yn-me-table-wrap" tabindex="0" role="region" aria-label="稼働計画の表（横にスクロールできます）">
        <table class="yn-table yn-table-compact yn-me-table yn-me-plan-table">
          <caption class="visually-hidden">稼働計画: ${unit ? unit.name : "すべての組織"}、${fyLabel}。セルは月の配分合計（人月）</caption>
          <thead><tr>
            <th scope="col">メンバー</th>
            ${months.map((m) => html`<th scope="col" class="num">${Number(m.slice(5))}月</th>`)}
            <th scope="col" class="num">年度計<span class="yn-th-sub">人月</span></th>
            <th scope="col">操作</th>
          </tr></thead>
          <tbody>${body.length ? body : html`<tr class="yn-table-empty"><td colspan=${months.length + 3}>この組織・年度のメンバーがいません。</td></tr>`}</tbody>
          ${view.rows.length ? html`<tfoot><tr><th scope="row">合計（${integer(view.rows.length)}人）</th>${view.totals.map((v) => html`<td class="num">${pm(v)}</td>`)}<td class="num">${pm(view.totals.reduce((a, b) => a + b, 0))}</td><td></td></tr></tfoot>` : null}
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
        ${value !== "" && value !== "employee" && value !== "partner" ? html`<option value=${value} selected>${value}（不正な値）</option>` : null}
      </select>`;
    }
    if (col.input === "team") {
      const opts = teamOptions();
      return html`<select id=${id} name=${col.name} class="yn-select" disabled=${disabled}>
        <option value="" selected=${value === ""}>（なし）</option>
        ${opts.map((o) => html`<option value=${o.id} selected=${value === o.id}>${o.label}</option>`)}
        ${value !== "" && !opts.some((o) => o.id === value) ? html`<option value=${value} selected>${value}（存在しないチーム）</option>` : null}
      </select>`;
    }
    if (col.input === "contract") {
      return html`<select id=${id} name=${col.name} class="yn-select" required=${req} disabled=${disabled}>
        <option value="" selected=${value === ""}>選んでください</option>
        ${contracts.map((c) => html`<option value=${c.id} selected=${value === c.id}>${c.id} ${c.customer} / ${c.project}</option>`)}
        ${value !== "" && !contracts.some((c) => c.id === value) ? html`<option value=${value} selected>${value}（存在しない契約）</option>` : null}
      </select>`;
    }
    if (col.input === "allocation") {
      // 入力は人月か時間を選べる。保存は人月（§23.2）
      const unitSel = html`<select id=${`${id}-unit`} name="__allocation_unit" class="yn-select yn-me-unit" disabled=${disabled}>
        <option value="personMonth" selected>人月</option>
        <option value="hours">時間</option>
      </select>`;
      const input = html`<input id=${id} name=${col.name} class="yn-input" type="text" value=${value} required=${req} disabled=${disabled} autocomplete="off" inputmode="decimal" aria-describedby=${`${id}-hint ${id}-conv`}>`;
      const conv = html`<span class="yn-me-conv" id=${`${id}-conv`} aria-live="polite"></span>`;
      const update = () => {
        const out = allocationFromInput(input.value, unitSel.value, std);
        const n = Number(out);
        conv.textContent = out === "" || !Number.isFinite(n) ? "" : unitSel.value === "hours" ? `${input.value.trim()} 時間 = ${out} 人月（${std} 時間 = 1 人月）として保存` : `${out} 人月 = ${hoursFromAllocation(n, std)} 時間`;
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
      return html`<span class="yn-me-alloc">${input}<label class="visually-hidden" for=${`${id}-unit`}>配分の入力単位</label>${unitSel}</span>${conv}`;
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
          ? titleOptions().map((t) => ({ v: t, l: "役職" }))
          : [...titleOptions().map((t) => ({ v: t, l: "役職" })), ...[...names.entries()].map(([k, n]) => ({ v: k, l: `個人単価: ${n}` }))];
    return html`<span class="yn-me-combo">${input}<datalist id=${listId}>${options.map((o) => html`<option value=${o.v} label=${o.l}></option>`)}</datalist></span>`;
  }

  /** 過去月への影響の注記。何が変わるかは、過去の月で値が変わる列で出し分ける（§19.1） */
  function impactNote(fileId, impact, tail) {
    const eff = describeImpactEffects(fileId, impact.columns);
    return html`<p class="yn-me-impact" role="alert" data-cost-changes=${eff.costChanges ? "true" : "false"}><span aria-hidden="true">!</span> <strong>過去の計算結果が変わります（影響: ${integer(impact.months.length)} か月）</strong><br>${describeImpactMonths(impact.months)} の${eff.effects.join("、")}が変わります。${eff.note ? html`<strong class="yn-me-impact-safe">${eff.note}</strong>` : null}${tail}</p>`;
  }

  const FIELD_HINTS = {
    effective_from: "この月から有効（YYYY-MM）。過去の月を選ぶと過去の数値が変わります",
    start_month: "YYYY-MM",
    end_month: "YYYY-MM（この月を含む）",
    allocation: "0〜1.0 人月（1.0 = 基準時間）。右で「時間」を選ぶと時間で入力でき、人月に直して保存します",
    level: "課・チーム・班など（自由入力。既存の値から選べます）",
    leader_member_id: "リーダーのメンバーID（空 = 未設定）",
    parent_team_id: "空 = 最上位",
    hourly_rate: "円の数値（例 12000）",
    key: "役職名（例 部長）か、パートナー個人の単価ならメンバーID",
    member_id: "既存のメンバーIDから選ぶか、新しいIDを入力",
    team_id: "英数字の ID（例 S11）",
    title: "単価表の役職名と同じ文字にすると、その単価が使われます",
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
    const title = mode === "edit" ? `${def.label}の行を修正` : def.history === "effective" ? `${def.label}: 新しい適用開始月の行を追加` : "アサインを追加";
    const lead =
      mode === "edit"
        ? isOriginal
          ? "既存の行を直接書き換えます。値の変更が過去の月に及ぶ場合は、適用前に影響する月数を表示します。履歴を残したい変更（異動・単価改定など）は、修正ではなく「新しい適用開始月の行を追加」を使ってください。"
          : "この画面で追加した行を修正します。"
        : def.history === "effective"
          ? "変わった月からの行を足します。適用開始月より前の月は、これまでの行のまま計算されます。"
          : "期間と配分を入力します。";

    const form = html`<form class="yn-me-form" novalidate>
      <p class="yn-me-form-lead">${lead}</p>
      <div class="yn-me-fields">
        ${columns.map((c) => {
          const disabled = lockImported(c.name);
          return html`<div class="yn-me-field">
            <label for=${`yn-me-f-${c.name}`}>${c.label}${c.required ? html`<span class="yn-me-req" aria-hidden="true"> *</span>` : null} <span class="yn-me-colname">${c.name}</span></label>
            ${fieldFor(fileId, c, (initial[c.name] ?? "").trim(), disabled)}
            <span class="yn-me-field-hint" id=${`yn-me-f-${c.name}-hint`}>${disabled ? "人事データから取り込むため変更できません" : (FIELD_HINTS[c.name] ?? "")}</span>
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
    const submitBtn = html`<button type="submit" class="yn-btn yn-btn-primary" data-role="submit">${mode === "edit" ? "確認する" : "追加する"}</button>`;
    const cancelBtn = html`<button type="button" class="yn-btn" onclick=${() => dialog.close()}>キャンセル</button>`;
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
      submitBtn.textContent = mode === "edit" ? "確認する" : "追加する";
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
        msg.textContent = `入力してください: ${missing.map((c) => c.label).join("、")}`;
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
            ? html`<p><strong>この行を次のように変更します。</strong></p><ul class="yn-me-change-list">${changes.map((c) => html`<li>${c.label}: <span class="yn-me-before">${(rowRecord(before, row)[c.name] ?? "").trim() || "（空）"}</span> → <span class="yn-me-after">${values[c.name] || "（空）"}</span></li>`)}</ul>`
            : html`<p><strong>この行を追加します。</strong></p>`}
          ${impact.months.length
            ? impactNote(fileId, impact, `計算基準月 ${monthJa(asOfMonth)} までを過去として数えています。`)
            : html`<p class="yn-me-impact-none">過去の計算結果は変わりません（${monthJa(asOfMonth)} までの月に影響しません）。</p>`}
          <p><button type="button" class="yn-btn" onclick=${backToForm}>入力に戻る</button></p>
        </div>`,
      );
      submitBtn.textContent = impact.months.length ? `適用する（過去 ${impact.months.length} か月が変わります）` : "適用する";
      submitBtn.focus();
    });

    dialog.replaceChildren(html`<div class="yn-dialog-inner">
      <header class="yn-dialog-head">
        <h2 id="yn-me-dialog-title" class="yn-dialog-title">${title}<span class="yn-me-path"> ${fileName(def.path)}</span></h2>
        <button type="button" class="yn-btn yn-btn-icon" aria-label="閉じる" onclick=${() => dialog.close()}>×</button>
      </header>
      <div class="yn-dialog-body">${form}</div>
    </div>`);
    if (!dialog.open) dialog.showModal();
    // 最初の空欄にフォーカス（稼働計画でメンバーを入れて開いたときは契約から）。空欄が無ければ最初の欄
    const fields = [...form.querySelectorAll("input:not([disabled]), select:not([disabled])")].filter((el) => el.name !== "__allocation_unit");
    (fields.find((el) => el.value === "") ?? fields[0])?.focus();
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
        <h2 id="yn-me-dialog-title" class="yn-dialog-title">${def.label}の行を削除しますか？</h2>
        <button type="button" class="yn-btn yn-btn-icon" aria-label="閉じる" onclick=${() => dialog.close()}>×</button>
      </header>
      <div class="yn-dialog-body">
        <dl class="yn-me-dl">${columns.map((c) => html`<div><dt>${c.label}</dt><dd>${(rec[c.name] ?? "").trim() || "—"}</dd></div>`)}</dl>
        ${impact.months.length
          ? impactNote(fileId, impact, "履歴を終わらせたいだけなら、削除ではなく新しい適用開始月の行を追加してください。")
          : html`<p class="yn-me-impact-none">過去の計算結果は変わりません。</p>`}
        <p class="yn-me-small">削除は保存するまで確定しません。「削除する行」の一覧から取り消せます。</p>
        <div class="yn-me-form-foot">
          <button type="button" class="yn-btn" onclick=${() => dialog.close()}>やめる</button>
          <button type="button" class="yn-btn yn-btn-primary" data-role="confirm-delete" onclick=${doDelete}>${impact.months.length ? `削除する（過去 ${impact.months.length} か月が変わります）` : "削除する"}</button>
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
        ? html`<p class="yn-me-check is-error" role="status"><span class="yn-chip yn-chip-warn"><span aria-hidden="true">!</span> エラー ${integer(v.errors)}件</span> 保存できません。エラーのある行（各タブの「! エラー」）を直してください。${v.warnings ? `警告 ${integer(v.warnings)}件は保存を止めません。` : ""}</p>`
        : html`<p class="yn-me-check is-ok" role="status"><span class="yn-chip yn-chip-ok"><span aria-hidden="true">✓</span> エラーなし</span> 編集後のデータは CI と同じ検証（データ検証）を通ります。${v.warnings ? `警告 ${integer(v.warnings)}件（保存は止めません）。` : ""}</p>`;
    const byTab = MASTER_FILE_IDS.filter((id) => errorCount(id) > 0);
    parts.check.replaceChildren(html`<section class="yn-me-section" aria-labelledby="yn-me-check-title">
      <h2 id="yn-me-check-title" class="yn-section-title">検証</h2>
      ${status}
      ${byTab.length ? html`<p class="yn-me-small">エラーのあるファイル: ${byTab.map((id, i) => html`${i > 0 ? "、" : ""}<button type="button" class="yn-btn-link" data-fk=${`goto:${id}`} onclick=${() => {
        active = id;
        renderTabs();
        renderPanel();
        focusKey(`tab:${id}`);
      }}>${MASTER_FILES[id].label}（${integer(errorCount(id))}件）</button>`)}</p>` : null}
      ${general.length
        ? html`<ul class="yn-me-issues yn-me-general">${general.map((i) => html`<li class=${i.severity === "error" ? "is-error" : "is-warning"}><span aria-hidden="true">${i.severity === "error" ? "!" : "i"}</span> ${i.severity === "error" ? "エラー" : "警告"}: ${i.message}</li>`)}</ul>`
        : null}
      <p class="yn-me-small">作業実績に関する警告（未紐付け・単価なし）はここでは調べません。保存後のビルドで「データ確認」画面に出ます。</p>
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
            ...d.added.map((a) => ({ kind: "追加", chip: "yn-chip-ok", sign: "＋", key: a.rowId, text: line(a.after), detail: null })),
            ...d.changed.map((c) => ({ kind: "変更", chip: "yn-chip-neutral", sign: "✎", key: c.rowId, text: line(c.before), detail: c.columns.map((col) => `${label(col)}: ${(c.before[col] ?? "").trim() || "（空）"} → ${(c.after[col] ?? "").trim() || "（空）"}`).join(" / ") })),
            ...d.removed.map((r) => ({ kind: "削除", chip: "yn-chip-neutral", sign: "−", key: r.rowId, text: line(r.before), detail: null })),
          ];
          return html`<div class="yn-me-diff-file">
            <h3 class="yn-me-subtitle">${def.label} <span class="yn-me-path">${def.path}</span> <span class="yn-me-small">追加 ${integer(d.added.length)} ・ 変更 ${integer(d.changed.length)} ・ 削除 ${integer(d.removed.length)}</span></h3>
            <div class="yn-table-wrap"><table class="yn-table yn-table-compact yn-me-diff-table">
              <caption class="visually-hidden">${def.label}の変更内容</caption>
              <thead><tr><th scope="col">種類</th><th scope="col">行（${cols.map((c) => c.label).join(" ・ ")}）</th><th scope="col">変わる値</th></tr></thead>
              <tbody>${rows.map((r) => html`<tr data-key=${r.key}><th scope="row"><span class=${`yn-chip ${r.chip}`}>${r.sign} ${r.kind}</span></th><td>${r.text}</td><td>${r.detail ?? (r.kind === "追加" ? "新しい行" : "行ごと削除")}</td></tr>`)}</tbody>
            </table></div>
          </div>`;
        })
      : html`<p class="yn-me-empty">まだ変更はありません。上の表で行を追加・修正すると、ここに一覧が出ます。</p>`;
    parts.diff.replaceChildren(html`<section class="yn-me-section" aria-labelledby="yn-me-diff-title">
      <h2 id="yn-me-diff-title" class="yn-section-title">変更内容（保存前の確認）</h2>
      <p class="yn-section-hint">保存されるのはこの一覧の変更だけです。変更していない行は元のファイルのまま残ります。</p>
      ${body}
    </section>`);
  }

  // ---- 保存 ---------------------------------------------------------------
  function changedFiles() {
    return MASTER_FILE_IDS.filter((id) => diffMasterDoc(docs[id]).count > 0);
  }

  function blockedReason() {
    if (locked) return "保存済みです。";
    if (totalChanges() === 0) return "変更がありません。";
    if (validation.errors > 0) return `検証エラーが ${integer(validation.errors)} 件あります。エラーの行を直すと保存できます。`;
    return null;
  }

  function commitMessage() {
    const files = changedFiles();
    return `マスタ更新: ${files.map((id) => fileName(MASTER_FILES[id].path)).join(", ")}`;
  }

  function mrDescription() {
    const lines = ["予実ナビのマスタ編集画面から作成しました。", ""];
    for (const id of changedFiles()) {
      const d = diffMasterDoc(docs[id]);
      lines.push(`- ${MASTER_FILES[id].path}: 追加 ${d.added.length} / 変更 ${d.changed.length} / 削除 ${d.removed.length}`);
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
        <h2 id="yn-me-dialog-title" class="yn-dialog-title">編集をすべて取り消しますか？</h2>
        <button type="button" class="yn-btn yn-btn-icon" aria-label="閉じる" onclick=${() => dialog.close()}>×</button>
      </header>
      <div class="yn-dialog-body">
        <p>${integer(totalChanges())} 件の変更と下書きを消して、元のデータに戻します。この操作は元に戻せません。</p>
        <div class="yn-me-form-foot">
          <button type="button" class="yn-btn" onclick=${() => dialog.close()}>やめる</button>
          <button type="button" class="yn-btn yn-btn-primary" data-role="confirm-discard" onclick=${() => {
            returnFocusKey = `add:${active}`;
            dialog.close();
            resetAll();
          }}>すべて取り消す</button>
        </div>
      </div>
    </div>`);
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('[data-role="confirm-discard"]').focus();
  }

  function renderOutcome() {
    if (saving) return html`<div class="yn-me-outcome is-busy" role="status" aria-live="polite" tabindex="-1" data-fk="save:outcome"><span class="yn-spinner yn-me-spinner" aria-hidden="true"></span> GitLab に保存しています…</div>`;
    if (!outcome) return html`<div class="yn-me-outcome-slot" aria-live="polite"></div>`;
    if (outcome.kind === "ok") {
      const r = outcome.result;
      return html`<div class="yn-me-outcome is-ok" role="status" tabindex="-1" data-fk="save:outcome">
        <p class="yn-me-outcome-title"><span aria-hidden="true">✓</span> ${r.commitMode === "mr" ? "マージリクエストを作成しました" : `${r.branch} にコミットしました`}</p>
        <ul>
          ${r.mergeRequestUrl ? html`<li>マージリクエスト: <a href=${r.mergeRequestUrl} target="_blank" rel="noopener">${r.mergeRequestIid ? `!${r.mergeRequestIid}` : "開く"}（GitLab）</a></li>` : null}
          ${r.commitUrl ? html`<li>コミット: <a href=${r.commitUrl} target="_blank" rel="noopener">${r.commitId ? r.commitId.slice(0, 8) : "開く"}（GitLab）</a></li>` : null}
          ${r.commitMode === "mr" ? html`<li>ブランチ: <code>${r.branch}</code></li>` : null}
        </ul>
        <p>${r.commitMode === "mr" ? "レビューしてマージされると、CI がビルドし直して画面の数値に反映されます。" : "CI がビルドし直すと、画面の数値に反映されます。"}下書きは消しました。</p>
        <p><button type="button" class="yn-btn" data-fk="save:restart" onclick=${() => resetAll()}>新しく編集を始める（元のデータから）</button></p>
      </div>`;
    }
    const e = outcome.error;
    const titles = { conflict: "他の人が先に更新しました（競合）", permission: "権限がありません", network: "GitLab に接続できませんでした", other: "保存できませんでした" };
    return html`<div class="yn-me-outcome is-error" role="alert" tabindex="-1" data-fk="save:outcome" data-error-kind=${e.kind}>
      <p class="yn-me-outcome-title"><span aria-hidden="true">!</span> ${titles[e.kind] ?? titles.other}</p>
      <p>${e.message}</p>
      ${e.detail ? html`<p class="yn-me-small">GitLab の応答: <code>${e.detail}</code></p>` : null}
      <p class="yn-me-small">編集内容は消えていません（このページと下書きに残っています）。</p>
      ${e.kind === "network" ? html`<p><button type="button" class="yn-btn yn-btn-primary" data-fk="save:to-download" onclick=${() => {
        mode = "download";
        outcome = null;
        renderAll();
        focusKey("save:heading");
      }}>CSV ダウンロードに切り替える</button></p>` : null}
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
      const tokenReason = hasToken ? null : "GitLab のトークンを入力してください。";
      const disabled = saving || !!reason || !!tokenReason;
      body = html`<div class="yn-me-save-body">
        <p>保存先: GitLab プロジェクト <code>${cfg.gitlab.projectId}</code> の <code>${cfg.gitlab.targetBranch}</code> ブランチ。${cfg.gitlab.commitMode === "mr" ? "新しいブランチにコミットしてマージリクエストを作ります（レビューしてマージすると反映）。" : `${cfg.gitlab.targetBranch} に直接コミットします。`}保存できるのは GitLab で Developer 以上の人です。</p>
        ${data.gitAvailable ? null : html`<p class="yn-note yn-note-warn">ビルド時に元ファイルの最終コミットを取得できなかったため、他の人の更新との競合を検出できません（後から保存した内容で上書きされます）。</p>`}
        <div class="yn-me-field">
          <span class="yn-me-label" id="yn-me-token-label">GitLab の Personal Access Token（scope: api）</span>
          ${hasToken
            ? html`<p class="yn-me-token-set"><span class="yn-chip yn-chip-ok"><span aria-hidden="true">✓</span> 入力済み</span> このタブを閉じると消えます（画面には再表示しません）。 <button type="button" class="yn-btn yn-btn-sm" data-fk="save:token-clear" onclick=${() => {
                session.remove(TOKEN_STORAGE_KEY);
                renderSave();
                document.getElementById("yn-me-token")?.focus();
              }}>トークンを消す</button></p>`
            : html`<div class="yn-me-inline">${tokenInput}<button type="button" class="yn-btn" data-fk="save:token-set" onclick=${setToken}>このタブで使う</button></div>`}
          <span class="yn-me-field-hint" id="yn-me-token-hint">GitLab の「ユーザー設定 → アクセストークン」で作成します。トークンはこのブラウザのタブ（sessionStorage）にだけ保存し、サーバーやファイルには保存しません。</span>
        </div>
        <div class="yn-me-field">
          <label for="yn-me-message">コミットメッセージ${cfg.gitlab.commitMode === "mr" ? "（マージリクエストのタイトル）" : ""}</label>
          ${msgInput}
          <span class="yn-me-field-hint" id="yn-me-message-hint">何をなぜ変えたかを書くと、レビューと後からの確認が楽になります（例: 2026年4月の単価改定）。</span>
        </div>
        <p class="yn-me-actions">
          <button type="button" class="yn-btn yn-btn-primary" data-fk="save:submit" disabled=${disabled} aria-describedby="yn-me-save-reason" onclick=${() => doSave(msgInput.value)}>${cfg.gitlab.commitMode === "mr" ? "GitLab に保存（マージリクエストを作成）" : "GitLab に保存（直接コミット）"}</button>
        </p>
        <p id="yn-me-save-reason" class="yn-me-small">${reason ?? tokenReason ?? `${files.map((id) => fileName(MASTER_FILES[id].path)).join("・")} を 1 つのコミットで保存します。`}</p>
      </div>`;
    } else {
      body = html`<div class="yn-me-save-body">
        ${configuredMode === "gitlab" ? html`<p class="yn-note yn-note-warn">GitLab に接続できなかったため、CSV ダウンロードで保存します。</p>` : null}
        <p>変更したファイルを CSV でダウンロードし、GitLab の画面からアップロードしてください（この画面からは GitLab に直接保存しない設定です）。</p>
        <ol class="yn-me-steps">
          <li>下のボタンで、変更したファイルをダウンロードします（ファイル名は元と同じ。UTF-8・BOM なし）。</li>
          <li>GitLab でこのプロジェクトを開き、同じ場所のファイル（${files.length ? files.map((id, i) => html`${i > 0 ? "、" : ""}<code>${MASTER_FILES[id].path}</code>`) : html`<code>data/masters/…</code>`}）を開きます。</li>
          <li class="yn-me-step-check">ファイルの最新のコミットが、この画面の元データ（ダウンロードボタンの横に表示）と同じか確認します。<strong>違っていれば他の人が先に更新しています。アップロードせずに</strong>、その更新が CI でビルドされたあとにこの画面を再読み込みしてください（下書きは最新のデータに当て直して復元できます）。</li>
          <li>「置換」（Replace）を押し、ダウンロードしたファイルを選びます。</li>
          <li>コミットメッセージに変更の理由を書き、「新しいブランチで MR を作成」を選んでコミットします（Web IDE で複数ファイルをまとめて置き換えてもかまいません）。</li>
          <li>マージされると CI がビルドし直し、画面の数値に反映されます。反映を確認したら、この画面の下書きを破棄してください。</li>
        </ol>
        <div class="yn-me-downloads">
          ${files.length
            ? files.map((id) => {
                const link = webFileUrl(cfg, data.files[id].repoPath ?? MASTER_FILES[id].path);
                return html`<p class="yn-me-dl-row">
                  <button type="button" class="yn-btn yn-btn-primary yn-export" data-fk=${`dl:${id}`} disabled=${!!reason} onclick=${() => download(id)}>⤓ ${fileName(MASTER_FILES[id].path)} をダウンロード</button>
                  <span class="yn-me-small">${MASTER_FILES[id].label}: ${integer(diffMasterDoc(docs[id]).count)}件の変更${downloaded.has(id) ? "・ダウンロード済み" : ""}</span>
                  <span class="yn-me-small" data-base-commit=${id}>${bases[id].lastCommitId ? html`元データ: コミット <code>${bases[id].lastCommitId.slice(0, 8)}</code>` : "元データのコミットは取得できませんでした（GitLab のファイルの履歴で最近の更新が無いか確認してください）"}</span>
                  ${link ? html`<a href=${link} target="_blank" rel="noopener" class="yn-me-small">GitLab でこのファイルを開く</a>` : null}
                </p>`;
              })
            : null}
        </div>
        <p id="yn-me-save-reason" class="yn-me-small">${reason ?? "ダウンロードしたファイルは、元のファイルと同じ列順・改行（LF）・文字コード（UTF-8）です。"}</p>
      </div>`;
    }
    parts.save.replaceChildren(html`<section class="yn-me-section yn-me-save" aria-labelledby="yn-me-save-title">
      <h2 id="yn-me-save-title" class="yn-section-title" tabindex="-1" data-fk="save:heading">保存（${mode === "gitlab" ? "GitLab" : "CSV ダウンロード"}）</h2>
      ${body}
      ${renderOutcome()}
      <p class="yn-me-actions yn-me-discard">
        <button type="button" class="yn-btn" data-fk="save:discard" disabled=${totalChanges() === 0 || saving} onclick=${openDiscardDialog}>編集をすべて取り消す</button>
        ${draftSavedAt ? html`<span class="yn-me-small">下書きを自動保存しました（${dateTimeJst(draftSavedAt)}、このブラウザだけ）</span>` : null}
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
