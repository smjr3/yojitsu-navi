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
import { addMonths, memberStatus, outsideTypes, parseCsvTable, parseNumberCell, parseTaskCategory } from "../core/index.js";
import {
  DRAFT_STORAGE_KEY,
  DRAFT_SESSION_KEY,
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
  serializeMasterDoc,
  stampChangedRows,
  STAMPED_FILES,
  STAMP_COLUMNS,
  rebaseDraftFile,
  rowRecord,
  rowState,
  staleDraftFiles,
  updateRow,
  planSourcesFromDocs,
  validateEdited,
} from "../core/masterEdit.js";
import { allocationFromInput, contractSegments, editMonthAllocation, flattenTeamTree, hoursFromAllocation, memberTeamAt, mergeAdjacent, planView, projectKey } from "../core/plan.js";
import { teamTreeAt } from "../core/masters.js";
import { effectiveSaveMode, fetchCurrentUser, saveToGitLab, webFileUrl } from "../core/gitlab.js";
import { docFromCsvText } from "../core/csvEdit.js";
import { dateTimeJst, integer, monthJa } from "./format.js";
import { infoTip } from "./layout.js";
import { TOKEN_STORAGE_KEY, clearToken, getToken, gitlabFetch } from "./gitlab-client.js";
import { mergeRequestsPanel } from "./mr-list.js";
import { combobox } from "./combobox.js";
import { planCellEditor, planCellTooltip } from "./plan-cell.js";
import { ledgerGroups, nextChangeOf, periodHistory, replaceRange, valueAt } from "../core/ledger.js";

/** アサインの案件欄の name（値は案件のキー。保存時に contract_id へ割り当てる） */
const PROJECT_FIELD = "__project";

export { TOKEN_STORAGE_KEY };

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
  outside: {
    what: T.masters.outsideWhat,
    effect: T.masters.outsideEffect,
    howto: T.masters.outsideHowto,
  },
};

/**
 * 画面ごとの見せ方（§36）
 *  - マスタ編集（台帳）: メンバー・単価・組織。対象ごとに 1 行、行の中に変更の履歴
 *  - リソース計画: 人 × 案件 × 月の配分（アサイン）と契約外予定。人ごとに 1 行、案件ごとの行と変更の履歴
 * 下書き・検証・変更内容・保存は 2 つの画面で共通（どちらで保存しても、両方の変更が 1 つのマージリクエストになる）
 */
export const PLAN_VIEW_ID = "plan";
export const LEDGER_VIEWS = Object.freeze(["members", "rates", "teams"]);
export const PLAN_VIEWS = Object.freeze([PLAN_VIEW_ID]);
/** 画面 → その画面で編集するファイル */
const VIEW_FILES = { members: ["members"], rates: ["rates"], teams: ["teams"], plan: ["assignments", "outside"] };
/** 人ごとの検証（案件の行ではなく人の行で見せる） */
const PERSON_ISSUES = new Set(["ALLOCATION_OVER_1", "ASSIGNMENT_AFTER_LEFT"]);
/** ファイル → それを編集する画面のパス（他の画面の変更・エラーへの案内） */
const FILE_PAGE = { members: "./masters", rates: "./masters?view=rates", teams: "./masters?view=teams", assignments: "./plan", outside: "./plan" };

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

// リソース計画の名前列の幅（境目をドラッグして変える。このブラウザだけに覚える）
const PLAN_NAME_W_KEY = "yojitsu-navi:plan-name-width";
const PLAN_NAME_W_MIN = 100;
const PLAN_NAME_W_MAX = 480;
function clampPlanNameW(w) {
  if (w == null || !Number.isFinite(w)) return null;
  return Math.round(Math.min(PLAN_NAME_W_MAX, Math.max(PLAN_NAME_W_MIN, w)));
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
export function mastersEditor({ data, config, asOfMonth, minMonth, views = LEDGER_VIEWS, initialView = null, initialTeam = null, initialMember = null, initialJump = null, fetchImpl = null, now = () => new Date() }) {
  const VIEW_IDS = [...views];
  /** この画面で編集するファイル */
  const pageFiles = VIEW_IDS.flatMap((v) => VIEW_FILES[v] ?? []);
  const local = safeStorage("local");
  const session = safeStorage("session");
  // GitLab（demo のときはブラウザ内の模擬。本体のファイル = このビルドの元データ）
  const gitlab = fetchImpl ?? gitlabFetch(data.masterEdit, Object.fromEntries(MASTER_FILE_IDS.map((id) => [data.files[id].repoPath ?? MASTER_FILES[id].path, { text: data.files[id].text, lastCommitId: data.files[id].lastCommitId }])));
  const mrPanel = mergeRequestsPanel({ cfg: data.masterEdit, fetchImpl: gitlab, now });
  const range = { fromMonth: minMonth, toMonth: asOfMonth };
  const importMode = (data.memberSourceAdapter ?? "none") !== "none";
  const contracts = parseCsvTable(data.context.contracts)
    .rows.map((r) => ({ id: r.get("contract_id"), customer: r.get("customer_name"), project: r.get("project_name"), startMonth: r.get("start_month"), endMonth: r.get("end_month") }))
    .filter((c) => c.id !== "");
  const contractById = new Map(contracts.map((c) => [c.id, c]));
  // 契約外の種別（§50.1。task-types.csv の契約外の行。無ければ種別なしの 1 行だけ）
  const outsideTypeList = outsideTypes(
    parseCsvTable(data.context.taskTypes ?? "")
      .rows.map((r) => ({ task: r.get("task"), category: parseTaskCategory(r.get("category")), group: r.get("group") }))
      .filter((r) => r.category !== null),
  );
  // 案件（顧客 × 案件名）→ その契約。アサインは案件で選び、保存時に契約へ割り当てる（§31.3）
  const projects = new Map();
  for (const c of contracts) {
    const key = projectKey(c.customer, c.project);
    const p = projects.get(key);
    if (p) p.contracts.push({ contractId: c.id, startMonth: c.startMonth, endMonth: c.endMonth });
    else projects.set(key, { key, customer: c.customer, project: c.project, contracts: [{ contractId: c.id, startMonth: c.startMonth, endMonth: c.endMonth }] });
  }
  /** 契約 → 「顧客 / 案件名」（ID は出さない。§31.1） */
  const contractText = (id) => {
    const c = contractById.get(id);
    return c ? `${c.customer} / ${c.project}` : fmt(T.masters.unknownContractValue, { id });
  };

  // ---- 状態 ---------------------------------------------------------------
  // 編集の土台は常にこのビルドの元データ（古い下書きは復元時にこの土台へ当て直す。§19.2）。書き換えない
  const bases = Object.freeze(Object.fromEntries(MASTER_FILE_IDS.map((id) => [id, Object.freeze({ text: data.files[id].text, lastCommitId: data.files[id].lastCommitId })])));
  let docs = Object.fromEntries(MASTER_FILE_IDS.map((id) => [id, parseMasterDoc(id, bases[id].text)]));
  /** 古い土台の下書きを当て直して復元したファイル → { applied, resolved }（表の上に注記する） */
  let rebasedInfo = {};
  let active = VIEW_IDS.includes(initialView) ? initialView : VIEW_IDS[0];
  const std = config.standardHoursPerMonth;
  // リソース計画タブの状態: 組織（null = すべて）・年度の 12 か月・強調するメンバー・開いているメンバー
  const plan = {
    teamId: initialTeam ?? (initialMember ? memberTeamAt(planSourcesFromDocs(docs, data.context.contracts).members, initialMember, asOfMonth) : null),
    months: fiscalMonths(asOfMonth, config.fiscalYearStartMonth),
    focusMember: initialMember,
    open: new Set(initialMember ? [initialMember] : []),
    /** 変更の履歴を開いている「メンバー|対象」 */
    hist: new Set(),
    /** 名前・所属・案件での絞り込み（数百人の組織で人を探す） */
    q: "",
    /** 名前列の幅（px。null = 既定）。境目のドラッグ・矢印キーで変え、このブラウザに覚える */
    nameW: clampPlanNameW(Number(local.get(PLAN_NAME_W_KEY)) || null),
  };
  const listFilter = Object.fromEntries(MASTER_FILE_IDS.map((id) => [id, { q: "", changedOnly: false }]));
  /** CSV で直接編集（§25）: on = CSV 表示、text = 反映していない書き換え（null = 今の内容）、result = 直前の反映の結果 */
  const csvEdit = Object.fromEntries(MASTER_FILE_IDS.map((id) => [id, { on: false, text: null, result: null }]));
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
  /**
   * このタブで（マスタ編集 ⇔ リソース計画を行き来して）書いた下書きは、土台が変わっていなければ黙って続きから。
   * 別のタブ・前の日の下書きだけ「復元 / 破棄」を聞く（§36.1）
   */
  if (pendingDraft && pendingDraft.savedAt && session.get(DRAFT_SESSION_KEY) === pendingDraft.savedAt && staleDraftFiles(pendingDraft, bases).length === 0) {
    const d = pendingDraft;
    for (const id of MASTER_FILE_IDS.filter((x) => d.files[x])) docs = { ...docs, [id]: rebaseDraftFile(id, d.files[id], bases[id].text, {}).doc };
    draftSavedAt = d.savedAt;
    pendingDraft = null;
    validation = validateEdited(docs, data.context, config);
    // 設定画面などから戻ったときは、変更のあるタブを開く（URL でタブを指定したときを除く）
    if (!VIEW_IDS.includes(initialView) && docs[active] && diffMasterDoc(docs[active]).count === 0) active = VIEW_IDS.find((id) => docs[id] && diffMasterDoc(docs[id]).count > 0) ?? active;
  }
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
  const tooltip = planCellTooltip();
  const cellEditor = planCellEditor();
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
    return [...latest.entries()].map(([id, v]) => {
      const level = cellOf(docs.teams, v.row, "level");
      return { id, label: `${cellOf(docs.teams, v.row, "name") || id}${level ? `（${level}）` : ""}` };
    });
  }
  /** メンバーの候補（名前で選ぶ。補足に所属・役職。ID は一致にだけ使う） */
  function memberOptions() {
    const latest = latestByKey(docs.members, "member_id");
    const tNames = teamNames();
    return [...latest.entries()].map(([id, v]) => {
      const get = (c) => cellOf(docs.members, v.row, c);
      const team = get("team_id") ? (tNames.get(get("team_id")) ?? "") : "";
      const left = memberStatus(get("status")).status === "left";
      const sub = [left ? T.members.chipLeft : "", team || get("section") || get("department"), get("title"), get("kind") === "partner" && get("title") !== T.members.kindPartner ? T.members.kindPartner : ""].filter(Boolean).join(" ・ ");
      return { value: id, label: get("name") || id, sub, search: `${id} ${get("department")} ${get("section")}`, left };
    })
      // 退職した人は候補の後ろへ（過去の行の修正では選べるように残す。§35）
      .sort((a, b) => Number(a.left) - Number(b.left));
  }
  function projectOptions() {
    return [...projects.values()].map((p) => ({ value: p.key, label: p.project || p.customer, sub: p.project ? p.customer : "", search: p.contracts.map((c) => c.contractId).join(" ") }));
  }
  /** ID の列を画面に出す文字（名前）にする。名前が無いものは ID のまま（§31.1） */
  function displayValue(fileId, column, value) {
    if (value === "") return value;
    if (column === "team_id" && fileId !== "teams") return teamNames().get(value) ?? `${value}${T.masters.unknownTeam}`;
    if (column === "parent_team_id") return teamNames().get(value) ?? `${value}${T.masters.unknownTeam}`;
    if ((fileId === "assignments" && column === "member_id") || column === "leader_member_id") return memberNames().get(value) || fmt(T.masters.unknownMemberValue, { id: value });
    if (fileId === "rates" && column === "key") return memberNames().get(value) || value;
    if (column === "contract_id") return contractText(value);
    return value;
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

  /** 表示用の補足（時間換算・区分名・契約の期間・個人単価） */
  function cellHint(fileId, column, value) {
    if (value === "") return null;
    if (column === "allocation" && Number.isFinite(Number(value))) return fmt(T.plan.equalsHours, { hours: hoursFromAllocation(Number(value), std) });
    if (column === "contract_id") {
      const c = contractById.get(value);
      return c ? `${c.startMonth}〜${c.endMonth}` : null;
    }
    if (fileId === "rates" && column === "key" && memberNames().has(value)) return T.masters.personalRateHint;
    if (column === "kind") return KIND_LABELS[value] ?? null;
    return null;
  }

  /** ファイルを編集する画面の名前 */
  function pageName(fileId) {
    return fileId === "assignments" || fileId === "outside" ? T.app.pages.plan : T.app.pages.masters;
  }

  function changeCounts() {
    return Object.fromEntries(MASTER_FILE_IDS.map((id) => [id, diffMasterDoc(docs[id]).count]));
  }
  function totalChanges() {
    return Object.values(changeCounts()).reduce((a, b) => a + b, 0);
  }
  function errorCount(fileId, severity = "error") {
    return Object.values(validation.byRow[fileId]).reduce((s, list) => s + list.filter((i) => i.severity === severity).length, 0);
  }

  function persistDraft() {
    if (pendingDraft) return;
    const d = makeDraft(docs, bases, new Date().toISOString());
    if (d) {
      local.set(DRAFT_STORAGE_KEY, JSON.stringify(d));
      session.set(DRAFT_SESSION_KEY, d.savedAt);
      draftSavedAt = d.savedAt;
    } else {
      local.remove(DRAFT_STORAGE_KEY);
      draftSavedAt = null;
    }
  }

  /** 文書を差し替え → 検証 → 下書き保存 → 描き直し */
  function commit(fileId, nextDoc, focus) {
    commitMany([{ fileId, doc: nextDoc }], focus);
  }

  /** 複数のファイルをまとめて差し替える（リソース計画のセルでアサインと契約外予定を一度に直すとき） */
  function commitMany(changes, focus) {
    for (const { fileId, doc } of changes) {
      docs = { ...docs, [fileId]: doc };
      // 追加・修正した行が見えるよう、その行を含む台帳の対象・リソース計画のメンバーを開く
      const m = /^(edit|next|del):(.+)$/.exec(focus ?? "");
      if (m) {
        const row = doc.rows.find((r) => r.id === m[2]);
        if (row) {
          openGroupOfRow(fileId, row.id);
          if (fileId === "assignments" || fileId === "outside") plan.open.add(cellOf(doc, row, "member_id"));
        }
      }
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
    const keyText = def.keyColumns.map((k) => displayValue(fileId, k, (c.base[k] ?? "").trim())).join(" / ");
    const shown = cols.filter((col) => c.columns.includes(col.name));
    const values = (rec, deletedText) =>
      rec === null
        ? html`<span class="yn-me-conflict-del">${deletedText}</span>`
        : html`<span class="yn-me-conflict-vals">${(shown.length ? shown : cols).map((col, i) => html`${i > 0 ? " / " : ""}${col.label}: <strong>${displayValue(fileId, col.name, (rec[col.name] ?? "").trim()) || T.masters.emptyValue}</strong>`)}</span>`;
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
      <p class="yn-me-small">${T.masters.conflictBaseRow} ${cols.map((col) => displayValue(fileId, col.name, (c.base[col.name] ?? "").trim()) || "—").join(" ・ ")}</p>
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
      // 戻した変更のあるタブを開く（今のタブに変更が無いとき）
      if (docs[active] && diffMasterDoc(docs[active]).count === 0) active = VIEW_IDS.find((id) => docs[id] && diffMasterDoc(docs[id]).count > 0) ?? active;
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
      <div class="yn-title-with-tip"><h2 id="yn-me-draft-title" class="yn-me-banner-title">${T.masters.draftTitle}</h2>${infoTip(`${T.masters.draftRestoreHint}${T.masters.draftLocked}${T.masters.draftNotSavedUntilChoice}`, { label: T.masters.draftTipLabel })}</div>
      <p>${dateTimeJst(d.savedAt)} ${T.masters.draftSavedAt} ${counts.join("、")}</p>
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
    </section>`);
  }

  // ---- タブ ---------------------------------------------------------------
  function renderTabs() {
    // 1 つの見せ方だけの画面（リソース計画）はタブを出さない
    if (VIEW_IDS.length < 2) {
      parts.tabs.replaceChildren();
      return;
    }
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
        const errs = errorCount(id);
        const selected = id === active;
        return html`<button type="button" role="tab" id=${`yn-me-tab-${id}`} class="yn-me-tab" aria-selected=${selected ? "true" : "false"} aria-controls="yn-me-panel" tabindex=${selected ? "0" : "-1"} data-fk=${`tab:${id}`} onclick=${() => select(id)}>
          <span class="yn-me-tab-label">${MASTER_FILES[id].label}</span>
          <span class="yn-me-tab-file">${fileName(MASTER_FILES[id].path)}</span>
          ${counts[id] > 0 ? html`<span class="yn-chip yn-chip-neutral">${T.masters.changed} ${integer(counts[id])}</span>` : null}
          ${errs > 0 ? html`<span class="yn-chip yn-chip-danger"><span aria-hidden="true">!</span> ${T.dataCheck.severityError} ${integer(errs)}</span>` : null}
        </button>`;
      })}
    </div>`);
  }

  // ---- 表 -----------------------------------------------------------------
  /** 表の検索の対象（セルの値と、ID の列の名前） */
  function searchText(fileId, doc, r) {
    const rec = rowRecord(doc, r);
    return [...r.cells, ...Object.entries(rec).map(([k, v]) => displayValue(fileId, k, v.trim()))].join(" ").normalize("NFKC").toLowerCase();
  }

  /** 台帳の開いている対象（fileId → キー）。エラーのある対象は、閉じたものを除いて開いて見せる */
  const ledgerOpen = Object.fromEntries(MASTER_FILE_IDS.map((id) => [id, new Set()]));
  const ledgerClosed = Object.fromEntries(MASTER_FILE_IDS.map((id) => [id, new Set()]));

  /** 文書の行 → 台帳のまとまり（§36） */
  function groupsOf(fileId) {
    const doc = docs[fileId];
    return ledgerGroups(
      doc.rows.map((r) => ({ id: r.id, record: rowRecord(doc, r) })),
      MASTER_FILES[fileId].keyColumns[0],
      asOfMonth,
    );
  }

  /** 行 id を含む台帳の対象を開く（追加・修正のあとにその行を見せる） */
  function openGroupOfRow(fileId, rowId) {
    if (MASTER_FILES[fileId].history !== "effective") return;
    const g = groupsOf(fileId).find((x) => x.entries.some((e) => e.rowId === rowId));
    if (g) {
      ledgerOpen[fileId].add(g.key);
      ledgerClosed[fileId].delete(g.key);
    }
  }

  /** 変更・エラーの数（台帳の対象・リソース計画の行のチップ） */
  function stateChips(changed, added, errors) {
    if (!changed && !added && !errors) return null;
    return html`<span class="yn-chip-row">${added ? html`<span class="yn-chip yn-chip-ok">＋ ${T.masters.added}${added > 1 ? ` ${integer(added)}` : ""}</span>` : null}${changed ? html`<span class="yn-chip yn-chip-neutral">✎ ${T.masters.changed}${changed > 1 ? ` ${integer(changed)}` : ""}</span>` : null}${errors ? html`<span class="yn-chip yn-chip-danger"><span aria-hidden="true">!</span> ${T.dataCheck.severityError}${errors > 1 ? ` ${integer(errors)}` : ""}</span>` : null}</span>`;
  }

  function issueList(list) {
    return html`<ul class="yn-me-issues">${list.map(
      (i) => html`<li class=${i.severity === "error" ? "is-error" : "is-warning"}><span aria-hidden="true">${i.severity === "error" ? "!" : "i"}</span> ${i.severity === "error" ? T.dataCheck.severityError : T.dataCheck.severityWarning}: ${issueText(i)}</li>`,
    )}</ul>`;
  }

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
    const keyColumn = def.keyColumns[0];
    // 台帳の 1 行: 先頭に対象（名前と ID）、続けて値の列。適用開始月は履歴の側に出す
    const nameColumn = (fileId === "members" || fileId === "teams") && doc.header.includes("name") ? "name" : null;
    const columns = def.columns.filter((c) => doc.header.includes(c.name) && c.name !== "effective_from" && c.name !== keyColumn && c.name !== nameColumn);
    const keyDef = def.columns.find((c) => c.name === keyColumn);
    const leadLabel = nameColumn ? fmt(T.ledger.leadLabel, { name: def.columns.find((c) => c.name === nameColumn).label, key: keyDef.label }) : keyDef.label;
    const colCount = columns.length + 4;
    const rowById = new Map(doc.rows.map((r) => [r.id, r]));
    const groups = groupsOf(fileId).filter((g) => {
      const rows = g.entries.map((e) => rowById.get(e.rowId));
      if (f.changedOnly && !rows.some((r) => rowState(doc, r) !== "unchanged" || issues[r.id]?.length > 0)) return false;
      if (q && !rows.some((r) => searchText(fileId, doc, r).includes(q))) return false;
      return true;
    });

    const search = html`<input type="search" class="yn-input yn-me-search" id=${`yn-me-q-${fileId}`} placeholder=${T.masters.searchPlaceholder} aria-label=${fmt(T.masters.searchAria, { file: def.label })} value=${f.q}>`;
    let timer = null;
    search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // 入力の直後にタブの切り替え・一覧からの移動で描き直したときは、古い欄の値で上書きしない
        if (!search.isConnected) return;
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

    const addLabel = T.ledger.addNew[fileId];
    const notes = [];
    if (meta.encoding && meta.encoding !== "utf-8") notes.push(fmt(T.masters.encodingNote, { encoding: meta.encoding === "shift_jis" ? "Shift_JIS" : T.masters.encodingBom }));
    if (meta.lineEnding === "crlf") notes.push(T.masters.crlfNote);
    if (rebasedInfo[fileId]) {
      const ri = rebasedInfo[fileId];
      notes.push(fmt(T.masters.rebasedNote, { n: integer(ri.applied), resolved: ri.resolved ? fmt(T.masters.rebasedResolved, { n: integer(ri.resolved) }) : "" }));
    }
    if (fileId === "members" && importMode) notes.push(fmt(T.masters.hrImportNote, { adapter: data.memberSourceAdapter }));
    const editable = !(locked || pendingDraft);

    /** 値の表示（空は —） */
    const valueEl = (column, raw, cls = "yn-me-val") => {
      const v = displayValue(fileId, column, raw);
      return html`<span class=${cls}>${v === "" ? html`<span class="yn-muted" aria-label=${T.masters.emptyAria}>—</span>` : v}</span>`;
    };

    const rowsHtml = groups.flatMap((g) => {
      const rows = g.entries.map((e) => rowById.get(e.rowId));
      const states = rows.map((r) => rowState(doc, r));
      const nAdded = states.filter((x) => x === "added").length;
      const nChanged = states.filter((x) => x === "changed").length;
      const nErrors = rows.reduce((n, r) => n + (issues[r.id] ?? []).filter((i) => i.severity === "error").length, 0);
      const open = ledgerOpen[fileId].has(g.key) || (nErrors > 0 && !ledgerClosed[fileId].has(g.key));
      const keyText = (nameColumn && g.shown.record[nameColumn]) || displayValue(fileId, keyColumn, g.shown.record[keyColumn] ?? "") || T.masters.emptyValue;
      const histId = `yn-me-hist-${fileId}-${g.shown.rowId}`;
      const toggle = () => {
        if (open) {
          ledgerOpen[fileId].delete(g.key);
          ledgerClosed[fileId].add(g.key);
        } else {
          ledgerOpen[fileId].add(g.key);
          ledgerClosed[fileId].delete(g.key);
        }
        renderPanel();
        focusKey(`grp:${fileId}:${g.key}`);
      };
      const nextEl = (column) => {
        const next = nextChangeOf(g, column);
        return next ? html`<span class="yn-me-next" title=${T.ledger.nextTitle}>${fmt(T.ledger.nextChange, { month: monthJa(next.from), value: displayValue(fileId, column, next.value) || T.masters.emptyValue })}</span>` : null;
      };
      const rawKey = g.shown.record[keyColumn] ?? "";
      const keyHint = cellHint(fileId, keyColumn, rawKey);
      const lead = nameColumn
        ? html`<th scope="row"><span class="yn-me-val yn-me-lead-name">${g.shown.record[nameColumn] || html`<span class="yn-muted">${T.masters.emptyValue}</span>`}</span><span class="yn-me-hint">${rawKey || T.masters.emptyValue}</span>${nextEl(nameColumn)}</th>`
        : html`<th scope="row">${valueEl(keyColumn, rawKey, "yn-me-val yn-me-lead-name")}${keyHint ? html`<span class="yn-me-hint">${keyHint}</span>` : null}</th>`;
      const cells = [
        lead,
        ...columns.map((c) => {
          const raw = g.shown.record[c.name] ?? "";
          const hint = cellHint(fileId, c.name, raw);
          return html`<td class=${c.input === "number" ? "num" : ""}>${valueEl(c.name, raw)}${hint ? html`<span class="yn-me-hint">${hint}</span>` : null}${nextEl(c.name)}</td>`;
        }),
      ];
      const since = g.shown.from;
      const histText = g.entries.length === 1 ? fmt(T.ledger.since, { month: since || "?" }) : fmt(T.ledger.historyCount, { n: integer(g.entries.length) });
      const groupRow = html`<tr class=${`yn-me-group${open ? " is-open" : ""}${nErrors ? " is-invalid" : ""}`} data-group=${g.key}>
        ${cells}
        <td class="yn-me-hist-cell">
          <button type="button" class="yn-btn yn-btn-sm yn-me-hist-toggle" data-fk=${`grp:${fileId}:${g.key}`} aria-expanded=${open ? "true" : "false"} aria-controls=${histId} aria-label=${fmt(T.ledger.toggleAria, { key: keyText, n: g.entries.length })} onclick=${toggle}>${histText} ${open ? "▴" : "▾"}</button>
          ${g.upcoming.length ? html`<span class="yn-chip yn-chip-neutral">${fmt(T.ledger.upcoming, { n: integer(g.upcoming.length) })}</span>` : null}
          ${!g.shown.current && g.entries.length ? html`<span class="yn-chip yn-chip-neutral">${fmt(T.ledger.notYet, { month: monthJa(g.shown.from) })}</span>` : null}
        </td>
        <td class="yn-me-state">${stateChips(nChanged, nAdded, nErrors)}</td>
        <td class="yn-me-actions-cell"><div class="yn-me-row-actions">
          <button type="button" class="yn-btn yn-btn-sm" data-fk=${`next:${g.shown.rowId}`} disabled=${!editable} aria-label=${fmt(T.ledger.addChangeAria, { key: keyText })} onclick=${() => openRowDialog({ fileId, mode: "add", template: latestRowOf(g, rowById), focus: `next:${g.shown.rowId}` })}>${T.ledger.addChange}</button>
          <button type="button" class="yn-btn yn-btn-sm" data-fk=${`edit:${g.shown.rowId}`} disabled=${!editable} aria-label=${fmt(T.ledger.editCurrentAria, { key: keyText, month: g.shown.from })} onclick=${() => openRowDialog({ fileId, mode: "edit", rowId: g.shown.rowId, focus: `edit:${g.shown.rowId}` })}>${T.masters.edit}</button>
        </div></td>
      </tr>`;
      if (!open) return [groupRow];
      // 変更の履歴: 適用開始月の順。前の履歴から変わった列は「前 → 後」、変わらない列は薄く
      const deletable = (st) => !(fileId === "members" && importMode && st !== "added");
      const hist = g.entries.flatMap((e, idx) => {
        const r = rowById.get(e.rowId);
        const st = rowState(doc, r);
        const list = issues[r.id] ?? [];
        const invalid = list.some((i) => i.severity === "error");
        const issueId = `yn-me-issue-${fileId}-${r.id}`;
        const label = idx === 0 ? T.ledger.firstEntry : e.changes.length ? T.ledger.changeEntry : T.ledger.sameEntry;
        const valueOrDiff = (c) => {
          const raw = e.record[c] ?? "";
          if (idx > 0 && e.changes.includes(c)) return html`<span class="yn-me-diff-val">${valueEl(c, e.previous?.[c] ?? "", "yn-me-before")} <span aria-label=${T.ledger.toAria}>→</span> ${valueEl(c, raw, "yn-me-val is-changed")}</span>`;
          return valueEl(c, raw, idx === 0 ? "yn-me-val" : "yn-me-val is-same");
        };
        // 修正した列（保存前の変更）は強調
        const edited = (c) => st === "changed" && doc.originals[r.id] && (doc.originals[r.id].cells[doc.header.indexOf(c)] ?? "") !== (r.cells[doc.header.indexOf(c)] ?? "");
        const nameChanged = nameColumn && ((idx > 0 && e.changes.includes(nameColumn)) || edited(nameColumn));
        const tds = [
          html`<th scope="row"><span class="yn-me-hist-from"><span class="yn-me-hist-arrow" aria-hidden="true">↳</span> ${e.from ? fmt(T.ledger.fromMonth, { month: e.from }) : T.masters.emptyValue}</span><span class="yn-me-hint">${label}${e.current ? html` ・ <strong>${T.ledger.current}</strong>` : e.future ? ` ・ ${T.ledger.future}` : ""}</span>${nameChanged ? html`<span class="yn-me-hist-name">${def.columns.find((c) => c.name === nameColumn).label}: ${valueOrDiff(nameColumn)}</span>` : null}</th>`,
          ...columns.map((c) => html`<td class=${`${c.input === "number" ? "num" : ""}${edited(c.name) ? " is-edited" : ""}`}>${valueOrDiff(c.name)}</td>`),
        ];
        const tr = html`<tr data-key=${r.id} class=${`yn-me-row yn-me-hist is-${st}${invalid ? " is-invalid" : ""}`} aria-describedby=${list.length ? issueId : null}>
          ${tds}
          <td></td>
          <td class="yn-me-state">${stateChips(st === "changed" ? 1 : 0, st === "added" ? 1 : 0, invalid ? 1 : 0)}</td>
          <td class="yn-me-actions-cell"><div class="yn-me-row-actions">
            <button type="button" class="yn-btn yn-btn-sm" data-fk=${`edit:${r.id}`} disabled=${!editable} aria-label=${fmt(T.ledger.entryEditAria, { key: keyText, month: e.from })} onclick=${() => openRowDialog({ fileId, mode: "edit", rowId: r.id, focus: `edit:${r.id}` })}>${T.masters.edit}</button>
            ${st === "changed" ? html`<button type="button" class="yn-btn yn-btn-sm" data-fk=${`revert:${r.id}`} disabled=${!editable} aria-label=${fmt(T.ledger.entryRevertAria, { key: keyText, month: e.from })} onclick=${() => commit(fileId, revertRow(docs[fileId], r.id), `edit:${r.id}`)}>${T.masters.revert}</button>` : null}
            ${deletable(st) ? html`<button type="button" class="yn-btn yn-btn-sm" data-fk=${`del:${r.id}`} disabled=${!editable} aria-label=${fmt(T.ledger.entryDeleteAria, { key: keyText, month: e.from })} onclick=${() => openDeleteDialog(fileId, r.id, `grp:${fileId}:${g.key}`)}>${T.masters.deleteKind}</button>` : null}
          </div></td>
        </tr>`;
        if (list.length === 0) return [tr];
        return [tr, html`<tr class=${`yn-me-issue-row${invalid ? " is-error" : ""}`}><td colspan=${colCount} id=${issueId}>${issueList(list)}</td></tr>`];
      });
      // 履歴の行は開閉ボタンの aria-controls が指すよう、最初の行に id を付ける
      for (const x of hist) x.dataset.parent = g.key;
      if (hist[0]) hist[0].id = histId;
      return [groupRow, ...hist];
    });

    const removed = diffMasterDoc(doc).removed;
    const csv = csvEdit[fileId];
    const csvBlocked = fileId === "members" && importMode;
    const tableBody = html`<div class="yn-me-toolbar">
        <button type="button" class="yn-btn yn-btn-primary" data-fk=${`add:${fileId}`} disabled=${!editable} onclick=${() => openRowDialog({ fileId, mode: "add", focus: `add:${fileId}` })}>${addLabel}</button>
        ${search}
        <label class="yn-toggle-chip" for=${`yn-me-changed-${fileId}`}>${changedOnly}<span>${T.masters.onlyChanged}</span></label>
        <span class="yn-table-count" aria-live="polite">${fmt(T.ledger.count, { n: integer(groups.length), total: integer(groupsOf(fileId).length), unit: T.ledger.unit[fileId] })}</span>
      </div>
      <div class="yn-table-wrap yn-me-table-wrap" tabindex="0" role="region" aria-label=${fmt(T.masters.tableAria, { file: def.label })}>
        <table class="yn-table yn-table-compact yn-me-table yn-me-ledger">
          <caption class="visually-hidden">${fmt(T.ledger.caption, { file: def.label, path: meta.path })}</caption>
          <thead><tr>
            <th scope="col"><span class="yn-me-th">${leadLabel}</span><span class="yn-th-sub">${nameColumn ? `${nameColumn} / ${keyColumn}` : keyColumn}</span></th>
            ${columns.map((c) => html`<th scope="col" class=${c.input === "number" ? "num" : ""}><span class="yn-me-th">${c.label}</span><span class="yn-th-sub">${c.name}</span></th>`)}
            <th scope="col">${T.ledger.colHistory}<span class="yn-th-sub">effective_from</span></th>
            <th scope="col">${T.columns.status}</th>
            <th scope="col">${T.masters.colActions}</th>
          </tr></thead>
          <tbody>${rowsHtml.length ? rowsHtml : html`<tr class="yn-table-empty"><td colspan=${colCount}>${doc.rows.length === 0 ? fmt(T.ledger.empty, { add: addLabel.replace("＋ ", "") }) : T.masters.noMatchRows}</td></tr>`}</tbody>
        </table>
      </div>
      ${removedList(fileId, removed, def.columns.filter((c) => doc.header.includes(c.name)))}`;
    parts.panel.replaceChildren(html`<section id="yn-me-panel" class="yn-me-panel" role="tabpanel" aria-labelledby=${`yn-me-tab-${fileId}`}>
      <div class="yn-me-panel-head">
        <div>
          <div class="yn-title-with-tip"><h2 class="yn-section-title">${def.label}<span class="yn-me-path"> ${meta.path}</span></h2>${infoTip(
            html`<span class="yn-me-help"><strong>${T.masters.helpWhat}</strong> ${help.what}</span><span class="yn-me-help"><strong>${T.masters.helpEffect}</strong> ${help.effect}</span><span class="yn-me-help"><strong>${T.masters.helpHowto}</strong> ${help.howto}</span>`,
            { label: fmt(T.layout.aboutSection, { title: def.label }) },
          )}</div>
        </div>
      </div>
      ${notes.map((n) => html`<p class="yn-note yn-note-warn">${n}</p>`)}
      ${csvBlocked ? null : modeSwitch(fileId, () => renderPanel())}
      ${csv.on && !csvBlocked ? renderCsvEditor(fileId) : tableBody}
    </section>`);
  }

  /** 対象の最新の履歴の行（「＋ 変更」はこれを写して適用開始月を翌月にする） */
  function latestRowOf(g, rowById) {
    const valid = g.entries.filter((e) => /^\d{4}-\d{2}$/.test(e.from));
    return rowById.get((valid[valid.length - 1] ?? g.entries[g.entries.length - 1]).rowId);
  }

  /** 削除した行（元に戻せる） */
  function removedList(fileId, removed, cols) {
    if (!removed.length) return null;
    return html`<div class="yn-me-removed"><h3 class="yn-me-subtitle">${T.masters.removedTitle}${integer(removed.length)}${T.masters.countSuffixParen}</h3><ul>${removed.map(
      (r) => html`<li><span class="yn-chip yn-chip-neutral">${T.masters.removedChip}</span> <span class="yn-me-removed-text">${cols.map((c) => displayValue(fileId, c.name, (r.before[c.name] ?? "").trim())).join(" ・ ")}</span> <button type="button" class="yn-btn yn-btn-sm" data-fk=${`restore:${r.rowId}`} disabled=${locked || !!pendingDraft} onclick=${() => commit(fileId, restoreRow(docs[fileId], r.rowId), `edit:${r.rowId}`)}>${T.masters.undoDelete}</button></li>`,
    )}</ul></div>`;
  }

  /** 表で編集／CSV で編集 の切替（rerender で描き直す） */
  function modeSwitch(fileId, rerender) {
    const csv = csvEdit[fileId];
    const btn = (on, label) =>
      html`<button type="button" class="yn-seg-btn" aria-pressed=${String(csv.on === on)} data-fk=${`csvmode:${fileId}:${on ? "csv" : "table"}`} onclick=${() => {
        csv.on = on;
        rerender();
        focusKey(on ? `csv:text:${fileId}` : `csvmode:${fileId}:table`);
      }}>${label}</button>`;
    return html`<div class="yn-title-with-tip yn-me-editmode-row"><div class="yn-seg yn-me-editmode" role="group" aria-label=${T.csvEdit.modeLabel}>${btn(false, T.csvEdit.modeTable)}${btn(true, T.csvEdit.modeCsv)}</div>${infoTip(T.csvEdit.lead, { label: T.csvEdit.tipLabel })}</div>`;
  }

  // ---- CSV で直接編集（§25） ---------------------------------------------------
  function renderCsvEditor(fileId) {
    const def = MASTER_FILES[fileId];
    const csv = csvEdit[fileId];
    const current = serializeMasterDoc(docs[fileId]).text;
    const text = csv.text ?? current;
    const disabled = locked || !!pendingDraft;
    const lines = text.split("\n").length;
    const area = html`<textarea id=${`yn-me-csv-${fileId}`} class="yn-input yn-me-csv-text" rows=${Math.min(24, Math.max(8, lines + 1))} spellcheck="false" wrap="off" autocomplete="off" aria-describedby=${`yn-me-csv-lead-${fileId} yn-me-csv-status-${fileId}`} readonly=${disabled}></textarea>`;
    area.value = text;
    area.dataset.fk = `csv:text:${fileId}`;
    const status = html`<span class="yn-me-small" id=${`yn-me-csv-status-${fileId}`} aria-live="polite"></span>`;
    const pendingText = () => (csv.text !== null && csv.text !== serializeMasterDoc(docs[fileId]).text ? T.csvEdit.unapplied : "");
    status.textContent = pendingText();
    area.addEventListener("input", () => {
      csv.text = area.value;
      csv.result = null;
      status.textContent = pendingText();
      resultSlot.replaceChildren();
    });
    const apply = () => {
      const r = docFromCsvText(docs[fileId], area.value);
      if (!r.doc) {
        csv.text = area.value;
        csv.result = { errors: r.errors };
        renderPanel();
        focusKey(`csv:result:${fileId}`);
        return;
      }
      csv.text = null;
      csv.result = { stats: r.stats, tsv: r.delimiter === "\t" };
      commit(fileId, r.doc, `csv:result:${fileId}`);
    };
    area.addEventListener("keydown", (e) => {
      // Ctrl/⌘ + Enter で反映
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        apply();
      }
    });
    const res = csv.result;
    const resultSlot = html`<div class="yn-me-csv-result"></div>`;
    if (res?.errors) {
      resultSlot.append(html`<div class="yn-me-outcome is-error" role="alert" tabindex="-1" data-fk=${`csv:result:${fileId}`}>
        <p class="yn-me-outcome-title"><span aria-hidden="true">!</span> ${T.csvEdit.errorsTitle}</p>
        <ul>${res.errors.map((e) => html`<li>${e.line ? fmt(T.csvEdit.lineN, { line: e.line }) : ""}${e.message}</li>`)}</ul>
      </div>`);
    } else if (res?.stats) {
      const st = res.stats;
      resultSlot.append(html`<div class="yn-me-outcome is-ok" role="status" tabindex="-1" data-fk=${`csv:result:${fileId}`}>
        <p>${st.added + st.changed + st.removed === 0 ? T.csvEdit.noChange : fmt(T.csvEdit.applied, { added: integer(st.added), changed: integer(st.changed), removed: integer(st.removed) })}${res.tsv ? ` ${T.csvEdit.tsvNote}` : ""}</p>
      </div>`);
    }
    return html`<div class="yn-me-csv">
      <p class=${disabled ? "yn-me-small" : "visually-hidden"} id=${`yn-me-csv-lead-${fileId}`}>${disabled ? T.csvEdit.lockedNote : T.csvEdit.lead}</p>
      <label class="visually-hidden" for=${`yn-me-csv-${fileId}`}>${fmt(T.csvEdit.textareaLabel, { file: def.label })}</label>
      ${area}
      <p class="yn-me-actions">
        <button type="button" class="yn-btn yn-btn-primary" data-fk=${`csv:apply:${fileId}`} disabled=${disabled} onclick=${apply}>${T.csvEdit.apply}</button>
        <button type="button" class="yn-btn" data-fk=${`csv:reset:${fileId}`} disabled=${disabled} onclick=${() => {
          csv.text = null;
          csv.result = null;
          renderPanel();
          focusKey(`csv:text:${fileId}`);
        }}>${T.csvEdit.reset}</button>
        ${status}
      </p>
      ${resultSlot}
    </div>`;
  }

  // ---- リソース計画（§23・§36） ----------------------------------------------------
  /** 契約 → 案件（顧客 × 案件名）。ファイルに無い契約は "c:<ID>" の案件として扱う */
  function projectOfContract(contractId) {
    const c = contractById.get(contractId);
    if (!c) return { key: `c:${contractId}`, label: fmt(T.masters.unknownContractValue, { id: contractId }), sub: "", contracts: [{ contractId, startMonth: "0000-01", endMonth: "9999-12" }] };
    const key = projectKey(c.customer, c.project);
    return { key, label: c.project || c.customer, sub: c.project ? c.customer : "", contracts: projects.get(key)?.contracts ?? [] };
  }
  /** メンバーの期間付きの行（アサイン or 契約外予定）。value は数値（数値でなければ NaN） */
  function memberPeriodRows(fileId, memberId) {
    const doc = docs[fileId];
    const vcol = MASTER_FILES[fileId].valueColumn;
    return doc.rows
      .filter((r) => cellOf(doc, r, "member_id") === memberId)
      .map((r) => {
        const text = cellOf(doc, r, vcol);
        return { rowId: r.id, contractId: fileId === "assignments" ? cellOf(doc, r, "contract_id") : "", type: fileId === "outside" ? cellOf(doc, r, "type") : "", startMonth: cellOf(doc, r, "start_month"), endMonth: cellOf(doc, r, "end_month"), value: text === "" ? Number.NaN : parseNumberCell(text), text };
      });
  }
  /** 対象（案件 or 契約外予定の種別）の行。target = { kind: "project", key } | { kind: "outside", type } */
  function targetRows(memberId, target) {
    if (target.kind === "outside") return memberPeriodRows("outside", memberId).filter((x) => sameType(x.type, target.type ?? ""));
    return memberPeriodRows("assignments", memberId).filter((x) => projectOfContract(x.contractId).key === target.key);
  }
  const targetFile = (target) => (target.kind === "outside" ? "outside" : "assignments");
  const targetId = (target) => (target.kind === "outside" ? `o:${target.type ?? ""}` : `p:${target.key}`);
  /** 種別の比較（全角半角・大文字小文字・前後の空白を区別しない） */
  const typeKey = (t) => String(t ?? "").normalize("NFKC").trim().toLowerCase();
  const sameType = (a, b) => typeKey(a) === typeKey(b);
  /** 契約外の種別の表示名（空 = 「契約外予定」） */
  const outsideLabel = (type) => (type ? type : T.masterFiles.outside);
  /** その人の契約外の種別: 分類表の種別 ＋ 行にある種別（分類表に無いもの・種別なし）。何も無ければ種別なしの 1 つ */
  function memberOutsideTypes(oRows) {
    const list = [...outsideTypeList];
    for (const x of oRows) if (!list.some((t) => sameType(t, x.type))) list.push(x.type);
    return list.length ? list : [""];
  }
  /** 期間を契約へ割り当てる（契約外予定は 1 区間） */
  function targetSegments(target) {
    if (target.kind === "outside") return (from, to) => [{ contractId: "", startMonth: from, endMonth: to }];
    if (target.key.startsWith("c:")) return (from, to) => [{ contractId: target.key.slice(2), startMonth: from, endMonth: to }];
    const p = projects.get(target.key);
    return (from, to) => (p ? contractSegments(p.contracts, from, to) : []);
  }
  /** 対象の名前（案件名、または「契約外予定」） */
  function targetLabel(target) {
    if (target.kind === "outside") return outsideLabel(target.type);
    if (target.key.startsWith("c:")) return fmt(T.masters.unknownContractValue, { id: target.key.slice(2) });
    const p = projects.get(target.key);
    return p ? p.project || p.customer : target.key;
  }

  /**
   * 対象の期間 [from, to] の人月を value にした文書（§36）。変更が無ければ doc: null。重なりなどで決められなければ error
   */
  function rangeEditDoc(baseDoc, memberId, target, from, to, value) {
    const fileId = targetFile(target);
    const vcol = MASTER_FILES[fileId].valueColumn;
    const rows = targetRows(memberId, target).map((x) => ({ id: x.rowId, contractId: x.contractId, startMonth: x.startMonth, endMonth: x.endMonth, value: x.text }));
    const res = replaceRange(rows, from, to, value, targetSegments(target));
    if (!res.ok) return { error: res.reason === "overlap" ? T.planEdit.overlapError : T.planEdit.rangeError };
    const e = res.edit;
    if (e.updates.size + e.deletes.length + e.adds.length === 0) return { doc: null };
    let doc = baseDoc;
    for (const [id, u] of e.updates) doc = updateRow(doc, id, { ...(fileId === "assignments" ? { contract_id: u.contractId } : {}), start_month: u.startMonth, end_month: u.endMonth, [vcol]: u.value });
    for (const id of e.deletes) doc = deleteRow(doc, id);
    for (const a of e.adds) doc = addRow(doc, { member_id: memberId, ...(fileId === "assignments" ? { contract_id: a.contractId } : { type: target.type ?? "" }), start_month: a.startMonth, end_month: a.endMonth, [vcol]: a.value }).doc;
    return { doc };
  }

  function renderPlanPanel() {
    if (csvEdit.assignments.on) {
      renderPlanCsv();
      return;
    }
    const src = planSourcesFromDocs(docs, data.context.contracts);
    const months = plan.months;
    const last = months[months.length - 1];
    const treeMonth = last < asOfMonth ? last : asOfMonth < months[0] ? months[0] : asOfMonth;
    const tree = teamTreeAt({ teams: src.teams }, treeMonth).tree;
    const flat = flattenTeamTree(tree);
    const view = planView(src, plan.teamId, months);
    const names = memberNames();
    const tNames = teamNames();
    const unit = plan.teamId ? tree[plan.teamId] : null;
    const leaderText = (id) => (id ? names.get(id) || fmt(T.masters.unknownMemberValue, { id }) : T.plan.leaderUnset);
    const optLabel = (n) => `${"　".repeat(n.depth)}${n.name}${n.level ? `［${n.level}］` : ""}${n.leaderMemberId ? fmt(T.plan.optLeader, { name: names.get(n.leaderMemberId) || T.plan.unknownMember }) : ""}`;
    const fyLabel = fmt(T.plan.fyLabel, { fy: months[0].slice(0, 4), first: monthJa(months[0]), last: monthJa(last) });
    const shiftYear = (d) => {
      plan.months = months.map((m) => addMonths(m, 12 * d));
      renderPanel();
      focusKey(d < 0 ? "plan:prev" : "plan:next");
    };
    const teamSel = html`<select id="yn-me-plan-team" class="yn-select" data-fk="plan:team">
      <option value="" selected=${plan.teamId === null}>${T.plan.allUnits}</option>
      ${flat.map((n) => html`<option value=${n.teamId} selected=${plan.teamId === n.teamId}>${optLabel(n)}</option>`)}
      ${plan.teamId !== null && !tree[plan.teamId] ? html`<option value=${plan.teamId} selected>${tNames.get(plan.teamId) ?? plan.teamId}${T.plan.notInYear}</option>` : null}
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
    const toggleHist = (memberId, target) => {
      const k = `${memberId}|${targetId(target)}`;
      if (plan.hist.has(k)) plan.hist.delete(k);
      else plan.hist.add(k);
      renderPanel();
      focusKey(`plan:hist:${k}`);
    };

    const editable = !(locked || pendingDraft);
    const inFy = (x) => /^\d{4}-\d{2}$/.test(x.startMonth) && /^\d{4}-\d{2}$/.test(x.endMonth) && x.startMonth <= last && x.endMonth >= months[0];
    const rowCounts = (fileId, rows) => {
      const doc = docs[fileId];
      const issues = validation.byRow[fileId];
      let changed = 0;
      let added = 0;
      let errors = 0;
      for (const x of rows) {
        const row = doc.rows.find((r) => r.id === x.rowId);
        const st = row ? rowState(doc, row) : "unchanged";
        if (st === "changed") changed++;
        if (st === "added") added++;
        errors += (issues[x.rowId] ?? []).filter((i) => i.severity === "error").length;
      }
      return { changed, added, errors };
    };
    const totals = months.map(() => 0);
    const outsideTotals = months.map(() => 0);

    /** 人の行の月合計の色: 1.0 超は黄、0 より多く 1.0 未満は青系（§41）。0（計画なし）は色を付けない */
    const allocLevel = (v) => (v > 1 + 1e-9 ? "over" : v > 1e-9 && v < 1 - 1e-9 ? "under" : null);

    /** 月のセル（クリックでその場の修正。target を渡すとその対象の欄から始める） */
    const cellButton = (r, m, v, label, focusTarget, level = null) => {
      const fk = `plan:cell:${r.memberId}:${focusTarget ? targetId(focusTarget) : "all"}:${m}`;
      const btn = html`<button type="button" class=${editable ? "yn-plan-cell-btn" : "yn-plan-cell-btn is-readonly"} data-fk=${fk} aria-label=${fmt(T.plan.cellAria, { name: label, month: monthJa(m), pm: pm(v) })} aria-haspopup=${editable ? "dialog" : null}>${v > 0 ? pm(v) : html`<span class="yn-muted" aria-hidden="true">—</span>`}</button>`;
      const tip = () => tooltip.show(btn, cellTip(r, m));
      btn.addEventListener("mouseenter", tip);
      btn.addEventListener("mouseleave", tooltip.hide);
      btn.addEventListener("focus", tip);
      btn.addEventListener("blur", tooltip.hide);
      // 下書きの復元待ち・保存後は修正できない。クリックしても内訳を見せるだけ
      btn.addEventListener("click", () => {
        if (!editable) return tip();
        tooltip.hide();
        openCellEditor(r, m, btn, focusTarget, fk);
      });
      // 退職した月より後（§35）
      const left = r.leftFrom != null && m >= r.leftFrom;
      return html`<td class=${`num yn-me-plan-cell${level ? ` is-${level}` : ""}${left ? " is-left" : ""}`}>${btn}</td>`;
    };

    // 名前・所属・案件で絞り込む（空白区切りの語をすべて含む）
    const terms = plan.q.normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean);
    const rowsShown = terms.length
      ? view.rows.filter((r) => {
          const projectsText = memberPeriodRows("assignments", r.memberId).map((x) => contractText(x.contractId)).join(" ");
          const text = `${r.name ?? ""} ${r.teamId ? (tNames.get(r.teamId) ?? "") : ""} ${r.memberId} ${projectsText}`.normalize("NFKC").toLowerCase();
          return terms.every((t) => text.includes(t));
        })
      : view.rows;
    const search = html`<input type="search" class="yn-input yn-me-search" id="yn-me-plan-q" placeholder=${T.planEdit.searchPlaceholder} aria-label=${T.planEdit.searchAria} value=${plan.q}>`;
    let searchTimer = null;
    search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        if (!search.isConnected) return;
        plan.q = search.value;
        renderPanel();
        const el = root.querySelector("#yn-me-plan-q");
        if (el) {
          el.focus();
          el.setSelectionRange?.(el.value.length, el.value.length);
        }
      }, 150);
    });

    const body = rowsShown.flatMap((r) => {
      const open = plan.open.has(r.memberId);
      const detailId = `yn-me-plan-d-${r.memberId}`;
      const aRows = memberPeriodRows("assignments", r.memberId);
      const oRows = memberPeriodRows("outside", r.memberId);
      const outsideMonthly = months.map((m) => valueAt(oRows, m));
      const monthly = months.map((m, i) => r.monthly[i] + outsideMonthly[i]);
      monthly.forEach((v, i) => (totals[i] += v));
      outsideMonthly.forEach((v, i) => (outsideTotals[i] += v));
      const overMonths = months.filter((_, i) => monthly[i] > 1 + 1e-9);
      // 案件ごと（この年度に掛かる計画のある案件。月の不正な行も見せる）
      const byProject = new Map();
      for (const x of aRows) {
        const p = projectOfContract(x.contractId);
        const g = byProject.get(p.key) ?? { project: p, rows: [] };
        g.rows.push(x);
        byProject.set(p.key, g);
      }
      const projectList = [...byProject.values()].filter((g) => g.rows.some((x) => inFy(x) || !/^\d{4}-\d{2}$/.test(x.startMonth) || !/^\d{4}-\d{2}$/.test(x.endMonth)));
      const counts = rowCounts("assignments", aRows);
      const oCounts = rowCounts("outside", oRows);
      // 開くと出る作業の数 = 案件 ＋ その年度に計画がある運用保守以外の種別（2026-10-30 試用版のコメント「案件じゃなくて作業」）
      const workCount = projectList.length + new Set(oRows.filter(inFy).map((x) => x.type ?? "")).size;
      const name = r.name || fmt(T.masters.unknownMemberValue, { id: r.memberId });
      const teamName = r.teamId ? (tNames.get(r.teamId) ?? "") : "";
      const main = html`<tr class=${`yn-me-plan-row${plan.focusMember === r.memberId ? " is-focus" : ""}${open ? " is-open" : ""}`} data-member=${r.memberId}>
        <th scope="row"><div class="yn-me-plan-who">
          <span class="yn-me-plan-name" title=${teamName ? `${name} ・ ${teamName}` : name}>${name}</span>${teamName ? html`<span class="yn-me-plan-team">${teamName}</span>` : null}
          ${r.support ? html`<span class="yn-chip yn-chip-neutral">${T.plan.support}</span>` : null}${r.leftFrom ? html`<span class="yn-chip yn-chip-neutral" title=${fmt(T.members.chipLeftTitle, { month: monthJa(r.leftFrom) })}>${T.members.chipLeft} ${monthJa(r.leftFrom)}</span>` : null}${r.afterLeftMonths.length ? html`<span class="yn-chip yn-chip-warn" title=${T.plan.afterLeftTitle}><span aria-hidden="true">!</span> ${fmt(T.plan.afterLeftChip, { n: integer(r.afterLeftMonths.length) })}</span>` : null}${overMonths.length ? html`<span class="yn-chip yn-chip-warn"><span aria-hidden="true">!</span> ${fmt(T.plan.overChip, { n: integer(overMonths.length) })}</span>` : null}${stateChips(counts.changed + oCounts.changed, counts.added + oCounts.added, counts.errors + oCounts.errors)}
        </div></th>
        ${months.map((m, i) => cellButton({ ...r, name }, m, monthly[i], name, null, allocLevel(monthly[i])))}
        <td class="num">${pm(monthly.reduce((a, b) => a + b, 0))}</td>
        <td class="yn-me-actions-cell"><div class="yn-me-row-actions">
          <button type="button" class="yn-btn yn-btn-sm" data-fk=${`plan:toggle:${r.memberId}`} aria-expanded=${open ? "true" : "false"} aria-controls=${detailId} aria-label=${fmt(T.planEdit.toggleAria, { name, n: workCount })} onclick=${() => toggle(r.memberId)}>${fmt(T.planEdit.toggle, { n: integer(workCount) })} ${open ? "▴" : "▾"}</button>
          <button type="button" class="yn-btn yn-btn-sm" data-fk=${`plan:add:${r.memberId}`} disabled=${!editable} aria-label=${fmt(T.plan.addForAria, { name })} onclick=${() => addFor(r.memberId, `plan:add:${r.memberId}`)}>${T.planEdit.addProject}</button>
        </div></td>
      </tr>`;
      if (!open) return [main];

      /** 案件・契約外予定の行（月ごとの人月）と、開いていれば変更の履歴 */
      const subRows = (target, rows, label, sub, extraCls) => {
        const fileId = targetFile(target);
        const k = `${r.memberId}|${targetId(target)}`;
        const histOpen = plan.hist.has(k);
        const histId = `yn-me-plan-h-${r.memberId}-${targetId(target).replace(/[^\w-]/g, "_")}`;
        const mv = months.map((m) => valueAt(rows, m));
        const c = rowCounts(fileId, rows);
        const entries = periodHistory(rows);
        const tr = html`<tr class=${`yn-me-plan-sub ${extraCls}`} data-member=${r.memberId} data-target=${targetId(target)}>
          <th scope="row"><div class="yn-me-plan-who yn-me-plan-sub-who">
            <span class="yn-me-plan-name" title=${sub ? `${label} ・ ${sub}` : label}>${label}</span>${sub ? html`<span class="yn-me-plan-team">${sub}</span>` : null}${stateChips(c.changed, c.added, c.errors)}
          </div></th>
          ${months.map((m, i) => cellButton({ ...r, name }, m, mv[i], `${name} ${label}`, target))}
          <td class="num">${pm(mv.reduce((a, b) => a + b, 0))}</td>
          <td class="yn-me-actions-cell"><div class="yn-me-row-actions">
            <button type="button" class="yn-btn yn-btn-sm" data-fk=${`plan:hist:${k}`} aria-expanded=${histOpen ? "true" : "false"} aria-controls=${histId} aria-label=${fmt(T.planEdit.histAria, { name, target: label, n: entries.length })} onclick=${() => toggleHist(r.memberId, target)}>${fmt(T.planEdit.histToggle, { n: integer(entries.length) })} ${histOpen ? "▴" : "▾"}</button>
            <button type="button" class="yn-btn yn-btn-sm" data-fk=${`plan:change:${k}`} disabled=${!editable} aria-label=${fmt(T.planEdit.changeAria, { name, target: label })} onclick=${() => openChangeDialog({ ...r, name }, target, `plan:change:${k}`)}>${T.planEdit.change}</button>
          </div></td>
        </tr>`;
        if (!histOpen) return [tr];
        return [tr, html`<tr class="yn-me-plan-hist" id=${histId}><td colspan=${months.length + 3}>${historyList({ ...r, name }, target, entries, fileId)}</td></tr>`];
      };
      const projRows = projectList
        .sort((a, b) => (a.project.sub + a.project.label).localeCompare(b.project.sub + b.project.label, "ja"))
        .flatMap((g) => subRows({ kind: "project", key: g.project.key }, g.rows, g.project.label, g.project.sub, "is-project"));
      const outRows = memberOutsideTypes(oRows).flatMap((type) =>
        subRows({ kind: "outside", type }, oRows.filter((x) => sameType(x.type, type)), outsideLabel(type), type ? T.planEdit.outsideTypeSub : T.planEdit.outsideSub, "is-outside"),
      );
      return [
        main,
        ...projRows.map((x) => ((x.dataset.parent = r.memberId), x)),
        ...(projectList.length ? [] : [html`<tr class="yn-me-plan-sub is-empty" data-parent=${r.memberId}><td colspan=${months.length + 3}><span class="yn-muted">${T.plan.noItems}</span></td></tr>`]),
        ...outRows.map((x) => ((x.dataset.parent = r.memberId), x)),
      ].map((x, i) => (i === 1 && !x.id ? ((x.id = detailId), x) : x));
    });

    /**
     * 名前列の幅を変える境目（列見出しの右端）。ドラッグ、または矢印キー（Shift で大きく）で変え、ダブルクリック・Home で既定に戻す。
     * 表は描き直さず、表の CSS 変数だけを変える（描き直すとドラッグが途切れるため）。覚えるのは離したとき
     */
    function planNameResizer() {
      const handle = html`<span class="yn-col-resizer" role="separator" aria-orientation="vertical" tabindex="0" aria-label=${T.plan.nameResize} title=${T.plan.nameResize} aria-valuemin=${PLAN_NAME_W_MIN}></span>`;
      const table = () => handle.closest("table");
      const current = () => Math.round(handle.closest("th").getBoundingClientRect().width);
      // 上限は 480px か、表示幅の 6 割の狭い方（CSS の --yn-plan-name-w-eff と同じ）
      const maxNow = () => Math.max(PLAN_NAME_W_MIN, Math.min(PLAN_NAME_W_MAX, Math.floor(window.innerWidth * 0.6)));
      const apply = (w, save) => {
        plan.nameW = w == null ? null : clampPlanNameW(Math.min(w, maxNow()));
        const t = table();
        if (t) {
          t.classList.toggle("is-name-sized", plan.nameW != null);
          if (plan.nameW != null) t.style.setProperty("--yn-plan-name-w", `${plan.nameW}px`);
          else t.style.removeProperty("--yn-plan-name-w");
        }
        handle.setAttribute("aria-valuemax", String(maxNow()));
        if (plan.nameW != null) handle.setAttribute("aria-valuenow", String(plan.nameW));
        else handle.removeAttribute("aria-valuenow");
        if (save) plan.nameW != null ? local.set(PLAN_NAME_W_KEY, String(plan.nameW)) : local.remove(PLAN_NAME_W_KEY);
      };
      handle.setAttribute("aria-valuemax", String(maxNow()));
      if (plan.nameW != null) handle.setAttribute("aria-valuenow", String(Math.min(plan.nameW, maxNow())));
      handle.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        const startX = ev.clientX;
        const startW = current();
        handle.setPointerCapture?.(ev.pointerId);
        handle.classList.add("is-dragging");
        const move = (e) => apply(startW + e.clientX - startX, false);
        const up = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          handle.removeEventListener("pointercancel", up);
          handle.classList.remove("is-dragging");
          apply(plan.nameW, true);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
      });
      handle.addEventListener("dblclick", () => apply(null, true));
      // 列見出しの並べ替えなどへ伝わらないように（この表の見出しは押しても何も起きないが念のため）
      handle.addEventListener("click", (ev) => ev.stopPropagation());
      handle.addEventListener("keydown", (ev) => {
        const step = ev.shiftKey ? 40 : 10;
        if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
          ev.preventDefault();
          ev.stopPropagation();
          apply(current() + (ev.key === "ArrowRight" ? step : -step), true);
        } else if (ev.key === "Home") {
          ev.preventDefault();
          ev.stopPropagation();
          apply(null, true);
        }
      });
      return handle;
    }

    /** セルの吹き出し: その月の案件ごとの人月・契約外予定・合計・空き */
    function cellTip(r, m) {
      const aRows = memberPeriodRows("assignments", r.memberId).filter((x) => x.startMonth <= m && m <= x.endMonth);
      const oRows = memberPeriodRows("outside", r.memberId);
      const outs = memberOutsideTypes(oRows)
        .map((type) => ({ type, v: valueAt(oRows.filter((x) => sameType(x.type, type)), m) }))
        .filter((o) => o.v > 0);
      const out = outs.reduce((s, o) => s + o.v, 0);
      const total = aRows.reduce((s, x) => s + (Number.isFinite(x.value) ? x.value : 0), 0) + out;
      const free = 1 - total;
      return html`<div class="yn-plan-tip-inner">
        <p class="yn-plan-tip-head">${fmt(T.plan.tipTotal, { month: monthJa(m), pm: pm(total), hours: hoursFromAllocation(total, std) })}</p>
        ${aRows.length || out > 0
          ? html`<ul class="yn-plan-tip-list">${aRows.map((x) => html`<li><span>${contractText(x.contractId)}</span><span class="num">${Number.isFinite(x.value) ? pm(x.value) : "?"}</span></li>`)}${outs.map((o) => html`<li class="is-outside"><span>${o.type ? fmt(T.planEdit.outsideTypeTip, { type: o.type }) : T.masterFiles.outside}</span><span class="num">${pm(o.v)}</span></li>`)}</ul>`
          : html`<p class="yn-muted">${T.plan.tipNone}</p>`}
        <p class="yn-plan-tip-foot">${free < -1e-9 ? html`<strong>${fmt(T.plan.tipOver, { pm: pm(-free) })}</strong>` : fmt(T.plan.tipFree, { pm: pm(free) })}${editable ? html` ・ ${T.plan.tipAction}` : null}</p>
      </div>`;
    }

    parts.panel.replaceChildren(html`<section id="yn-me-panel" class="yn-me-panel yn-me-plan">
      <div class="yn-me-panel-head">
        <div>
          <div class="yn-title-with-tip"><h2 class="yn-section-title">${T.planEdit.title}<span class="yn-me-path"> ${data.files.assignments.path} ・ ${data.files.outside.path}</span></h2>${infoTip(
            html`<span class="yn-me-help">${rich(T.plan.helpWhat)}</span><span class="yn-me-help">${rich(T.plan.helpHowto, { std: integer(std) })}</span><span class="yn-me-help">${rich(T.planEdit.helpHistory)}</span><span class="yn-me-help">${T.planEdit.legend}</span><span class="yn-me-help">${T.plan.unitHelp}</span>`,
            { label: fmt(T.layout.aboutSection, { title: T.planEdit.title }) },
          )}</div>
        </div>
      </div>
      ${modeSwitch("assignments", () => renderPanel())}
      <div class="yn-me-toolbar yn-me-plan-toolbar">
        <label class="yn-me-plan-label" for="yn-me-plan-team">${T.plan.unitLabel}</label>${teamSel}
        <span class="yn-me-plan-fy">
          <button type="button" class="yn-btn yn-btn-sm" data-fk="plan:prev" aria-label=${T.plan.prevYear} onclick=${() => shiftYear(-1)}>◀</button>
          <span aria-live="polite">${fyLabel}</span>
          <button type="button" class="yn-btn yn-btn-sm" data-fk="plan:next" aria-label=${T.plan.nextYear} onclick=${() => shiftYear(1)}>▶</button>
        </span>
        <button type="button" class="yn-btn yn-btn-primary" data-fk="add:plan" disabled=${!editable} onclick=${() => addFor(null, "add:plan")}>${T.plan.add}</button>
      </div>
      <div class="yn-me-toolbar yn-me-plan-filter">
        ${search}
        <span class="yn-table-count" aria-live="polite">${fmt(T.ledger.count, { n: integer(rowsShown.length), total: integer(view.rows.length), unit: T.ledger.unit.members })}</span>
      </div>
      ${unit ? html`<p class="yn-me-plan-unit">${unit.name}${unit.level ? html` <span class="yn-chip yn-chip-neutral">${unit.level}</span>` : null} ${fmt(T.plan.unitNote, { leader: leaderText(unit.leaderMemberId) })}</p>` : null}
      <div class="yn-table-wrap yn-me-table-wrap" tabindex="0" role="region" aria-label=${T.plan.tableAria} onkeydown=${gridKeys}>
        <table class=${`yn-table yn-table-compact yn-me-table yn-me-plan-table${plan.nameW ? " is-name-sized" : ""}`} style=${plan.nameW ? `--yn-plan-name-w: ${plan.nameW}px` : ""}>
          <caption class="visually-hidden">${fmt(T.plan.caption, { unit: unit ? unit.name : T.plan.allUnits, fy: fyLabel })}</caption>
          <thead><tr>
            <th scope="col" class="yn-me-plan-name-th">${T.plan.colMember}${planNameResizer()}</th>
            ${months.map((m) => html`<th scope="col" class="num">${fmt(T.plan.colMonth, { m: Number(m.slice(5)) })}</th>`)}
            <th scope="col" class="num">${T.plan.colFyTotal}<span class="yn-th-sub">${T.plan.unitPersonMonth}</span></th>
            <th scope="col">${T.masters.colActions}</th>
          </tr></thead>
          <tbody>${body.length ? body : html`<tr class="yn-table-empty"><td colspan=${months.length + 3}>${view.rows.length ? T.planEdit.noMatch : T.plan.noMembers}</td></tr>`}</tbody>
          ${rowsShown.length
            ? html`<tfoot>
                <tr><th scope="row">${fmt(T.plan.total, { n: integer(rowsShown.length) })}</th>${totals.map((v) => html`<td class="num">${pm(v)}</td>`)}<td class="num">${pm(totals.reduce((a, b) => a + b, 0))}</td><td></td></tr>
                <tr class="yn-me-plan-foot-sub"><th scope="row">${T.planEdit.footOutside}</th>${outsideTotals.map((v) => html`<td class="num">${v > 0 ? pm(v) : html`<span class="yn-muted">—</span>`}</td>`)}<td class="num">${pm(outsideTotals.reduce((a, b) => a + b, 0))}</td><td></td></tr>
              </tfoot>`
            : null}
        </table>
      </div>
      ${removedList("assignments", diffMasterDoc(docs.assignments).removed, MASTER_FILES.assignments.columns)}
      ${removedList("outside", diffMasterDoc(docs.outside).removed, MASTER_FILES.outside.columns)}
    </section>`);
  }

  /** リソース計画の CSV 編集: アサインと契約外予定の 2 つのファイル */
  function renderPlanCsv() {
    parts.panel.replaceChildren(html`<section id="yn-me-panel" class="yn-me-panel yn-me-plan">
      <div class="yn-me-panel-head"><div><h2 class="yn-section-title">${T.planEdit.title}<span class="yn-me-path"> ${data.files.assignments.path} ・ ${data.files.outside.path}</span></h2></div></div>
      ${modeSwitch("assignments", () => renderPanel())}
      ${["assignments", "outside"].map((id) => html`<div class="yn-me-plan-csv"><h3 class="yn-me-subtitle">${MASTER_FILES[id].label} <span class="yn-me-path">${data.files[id].path}</span></h3>${renderCsvEditor(id)}</div>`)}
    </section>`);
  }

  /** 変更の履歴（開始・変更・再開・終了。行ごとに修正・削除） */
  function historyList(r, target, entries, fileId) {
    const doc = docs[fileId];
    const issues = validation.byRow[fileId];
    const editable = !(locked || pendingDraft);
    const label = targetLabel(target);
    const pmText = (v) => (Number.isFinite(v) ? fmt(T.planEdit.pmValue, { pm: pm(v) }) : T.plan.allocNotNumber);
    // 「YYYY-MM から計画なし」は、その月より後に始まる最初の履歴の手前（無ければ最後）に置く（重なりのある履歴の間に挟まないため）
    const ends = [];
    /** 誰がいつ変えたか（保存時に書いた変更者・変更日。§56）。無ければ出さない */
    const stampOf = (row) => {
      if (!row) return null;
      const by = cellOf(doc, row, STAMP_COLUMNS.by);
      const at = cellOf(doc, row, STAMP_COLUMNS.at);
      if (!by && !at) return null;
      return html`<span class="yn-me-hint yn-me-plan-stamp" data-role="stamp">${by && at ? fmt(T.planEdit.stamp, { by, at }) : fmt(T.planEdit.stampOne, { v: by || at })}</span>`;
    };
    const items = entries.flatMap((e) => {
      const row = doc.rows.find((x) => x.id === e.rowId);
      const st = row ? rowState(doc, row) : "unchanged";
      const list = issues[e.rowId] ?? [];
      const what = {
        start: T.planEdit.kindStart,
        restart: T.planEdit.kindRestart,
        change: Number.isFinite(e.previousValue) ? fmt(T.planEdit.kindChange, { before: pm(e.previousValue), after: Number.isFinite(e.value) ? pm(e.value) : "?" }) : T.planEdit.kindChangeUnknown,
        contract: T.planEdit.kindContract,
        same: T.planEdit.kindSame,
        overlap: T.planEdit.kindOverlap,
        invalid: T.planEdit.kindInvalid,
      }[e.kind];
      const contract = fileId === "assignments" ? contractById.get(e.contractId) : null;
      const period = `${e.startMonth || "?"}〜${e.endMonth || "?"}`;
      const li = html`<li class=${`yn-me-plan-entry is-${st} kind-${e.kind}`} data-key=${e.rowId}>
        <span class="yn-me-plan-period">${period}</span>
        <span class="yn-me-plan-alloc">${pmText(e.value)}</span>
        <span class=${`yn-me-plan-kind${e.kind === "overlap" || e.kind === "invalid" ? " is-warn" : e.kind === "change" ? " is-change" : ""}`}>${e.kind === "overlap" || e.kind === "invalid" ? html`<span aria-hidden="true">! </span>` : null}${what}</span>
        ${stampOf(row)}
        ${contract ? html`<span class="yn-me-hint">${fmt(T.planEdit.contractPeriod, { from: contract.startMonth, to: contract.endMonth })}</span>` : null}
        ${fileId === "outside" && row && cellOf(doc, row, "note") ? html`<span class="yn-me-hint yn-me-plan-note" title=${cellOf(doc, row, "note")}>${cellOf(doc, row, "note")}</span>` : null}
        ${stateChips(st === "changed" ? 1 : 0, st === "added" ? 1 : 0, list.some((i) => i.severity === "error") ? 1 : 0)}
        <span class="yn-me-row-actions">
          <button type="button" class="yn-btn yn-btn-sm" data-fk=${`edit:${e.rowId}`} disabled=${!editable} aria-label=${fmt(T.planEdit.entryEditAria, { target: label, period })} onclick=${() => openRowDialog({ fileId, mode: "edit", rowId: e.rowId, focus: `edit:${e.rowId}` })}>${T.masters.edit}</button>
          ${st === "changed" ? html`<button type="button" class="yn-btn yn-btn-sm" data-fk=${`revert:${e.rowId}`} disabled=${!editable} aria-label=${fmt(T.planEdit.entryRevertAria, { target: label, period })} onclick=${() => commit(fileId, revertRow(docs[fileId], e.rowId), `edit:${e.rowId}`)}>${T.masters.revert}</button>` : null}
          <button type="button" class="yn-btn yn-btn-sm" data-fk=${`del:${e.rowId}`} disabled=${!editable} aria-label=${fmt(T.planEdit.entryDeleteAria, { target: label, period })} onclick=${() => openDeleteDialog(fileId, e.rowId, `plan:hist:${r.memberId}|${targetId(target)}`)}>${T.masters.deleteKind}</button>
        </span>
        ${list.length ? issueList(list) : null}
      </li>`;
      if (e.endsBefore) ends.push({ month: e.endsBefore, el: html`<li class="yn-me-plan-entry kind-end"><span class="yn-me-plan-period">${fmt(T.planEdit.fromMonth, { month: e.endsBefore })}</span><span class="yn-me-plan-kind">${T.planEdit.kindEnd}</span></li>` });
      li.dataset.start = /^\d{4}-\d{2}$/.test(e.startMonth) ? e.startMonth : "";
      return [li];
    });
    for (const end of ends) {
      const at = items.findIndex((x) => x.dataset.start && x.dataset.start > end.month);
      if (at < 0) items.push(end.el);
      else items.splice(at, 0, end.el);
    }
    return html`<div class="yn-me-plan-histbox">
      <p class="yn-me-small">${fmt(T.planEdit.histLead, { target: label })}</p>
      ${items.length ? html`<ol class="yn-me-plan-entries">${items}</ol>` : html`<p class="yn-muted">${T.planEdit.histEmpty}</p>`}
    </div>`;
  }

  /**
   * 「＋ 変更」: 対象（案件 or 契約外予定）の人月を、ある月から変える（§36）。
   * 期間は「計画の終わりまで」（既定）／「この月だけ」／「終了月を指定」。0 にするとその期間の計画を外す
   */
  function openChangeDialog(r, target, focus) {
    if (locked || pendingDraft) return;
    returnFocusKey = focus;
    const fileId = targetFile(target);
    const label = targetLabel(target);
    const fyLast = plan.months[plan.months.length - 1];
    const next = addMonths(asOfMonth, 1);
    const startDefault = next >= plan.months[0] && next <= fyLast ? next : plan.months[0];
    const rows = targetRows(r.memberId, target).filter((x) => /^\d{4}-\d{2}$/.test(x.startMonth) && /^\d{4}-\d{2}$/.test(x.endMonth));
    /** 「計画の終わりまで」の終了月: 月 from 以降に掛かる計画の最後の月。無ければ年度末（案件は契約の終わりまで） */
    const planEnd = (from) => {
      const ends = rows.filter((x) => x.endMonth >= from).map((x) => x.endMonth);
      if (ends.length) return ends.reduce((a, b) => (a > b ? a : b));
      if (target.kind === "project") {
        const cs = projects.get(target.key)?.contracts ?? [];
        const cend = cs.map((c) => c.endMonth).filter((m) => m >= from).reduce((a, b) => (a > b ? a : b), "");
        if (cend) return cend;
      }
      return fyLast >= from ? fyLast : from;
    };
    const fromInput = html`<input type="month" id="yn-me-chg-from" class="yn-input" value=${startDefault} required>`;
    const toInput = html`<input type="month" id="yn-me-chg-to" class="yn-input" value=${fyLast} aria-label=${T.planEdit.toMonthLabel}>`;
    const valueField = html`<div class="yn-me-chg-value">${fieldFor(fileId, { name: "__value", label: T.planEdit.valueLabel, input: "allocation", required: false }, "", false)}</div>`;
    const scopeName = "yn-me-chg-scope";
    let scope = "end";
    const radios = ["end", "month", "until"].map((v) => {
      const input = html`<input type="radio" name=${scopeName} value=${v} checked=${scope === v}>`;
      input.addEventListener("change", () => {
        scope = v;
        toInput.disabled = v !== "until";
        update();
      });
      return { v, input };
    });
    toInput.disabled = true;
    const endLabel = html`<span></span>`;
    const preview = html`<p class="yn-me-chg-preview" aria-live="polite"></p>`;
    const msg = html`<div class="yn-me-form-msg" role="alert"></div>`;
    const confirmBox = html`<div class="yn-me-confirm" hidden></div>`;
    const submitBtn = html`<button type="submit" class="yn-btn yn-btn-primary">${T.planEdit.applyChange}</button>`;
    const valueInput = () => valueField.querySelector?.("input") ?? null;
    const unitSel = () => valueField.querySelector?.("select") ?? null;
    const readValue = () => allocationFromInput(String(valueInput()?.value ?? ""), unitSel()?.value ?? "personMonth", std);
    const span = () => {
      const from = fromInput.value;
      const to = scope === "month" ? from : scope === "until" ? toInput.value : planEnd(from);
      return { from, to };
    };
    let pending = null;
    function update() {
      pending = null;
      confirmBox.hidden = true;
      confirmBox.replaceChildren();
      submitBtn.textContent = T.planEdit.applyChange;
      msg.textContent = "";
      const { from, to } = span();
      endLabel.textContent = /^\d{4}-\d{2}$/.test(from) ? fmt(T.planEdit.scopeEndAt, { month: planEnd(from) }) : "";
      if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) {
        preview.textContent = "";
        return;
      }
      const before = valueAt(rows, from);
      const text = readValue();
      const n = parseNumberCell(text);
      preview.textContent =
        text === "" || !Number.isFinite(n)
          ? fmt(T.planEdit.previewNow, { from, pm: pm(before) })
          : Math.abs(n) < 1e-9
            ? fmt(T.planEdit.previewStop, { from, to })
            : before > 1e-9
              ? fmt(T.planEdit.previewChange, { from, to, before: pm(before), after: pm(n) })
              : fmt(T.planEdit.previewAdd, { from, to, after: pm(n) });
    }
    const form = html`<form class="yn-me-form" novalidate>
      <div class="yn-me-fields">
        <div class="yn-me-field"><label for="yn-me-chg-from">${T.planEdit.fromLabel}<span class="yn-me-req" aria-hidden="true"> *</span></label>${fromInput}<span class="yn-me-field-hint">${T.planEdit.fromHint}</span></div>
        <div class="yn-me-field"><label for="yn-me-f-__value">${T.planEdit.valueLabel}<span class="yn-me-req" aria-hidden="true"> *</span></label>${valueField}<span class="yn-me-field-hint" id="yn-me-f-__value-hint">${T.planEdit.valueHint}</span></div>
        <fieldset class="yn-me-field yn-me-chg-scope"><legend>${T.planEdit.scopeLabel}</legend>
          <div class="yn-radio-group yn-radio-col">
            <label class="yn-radio">${radios[0].input}<span>${T.planEdit.scopeEnd} ${endLabel}</span></label>
            <label class="yn-radio">${radios[1].input}<span>${T.planEdit.scopeMonth}</span></label>
            <label class="yn-radio">${radios[2].input}<span>${T.planEdit.scopeUntil}</span> ${toInput}</label>
          </div>
        </fieldset>
      </div>
      ${preview}
      ${msg}
      ${confirmBox}
      <div class="yn-me-form-foot"><button type="button" class="yn-btn" onclick=${() => dialog.close()}>${T.masters.cancel}</button>${submitBtn}</div>
    </form>`;
    form.addEventListener("input", (ev) => {
      if (ev.target === fromInput || ev.target === toInput || ev.target === valueInput()) update();
    });
    form.addEventListener("change", update);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      if (pending) {
        const p = pending;
        returnFocusKey = focus;
        dialog.close();
        plan.hist.add(`${r.memberId}|${targetId(target)}`);
        commit(fileId, p, focus);
        return;
      }
      const { from, to } = span();
      const text = readValue();
      if (!/^\d{4}-\d{2}$/.test(from)) {
        msg.textContent = T.planEdit.needFrom;
        fromInput.focus();
        return;
      }
      if (text === "") {
        msg.textContent = T.planEdit.needValue;
        valueInput()?.focus();
        return;
      }
      const n = parseNumberCell(text);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        msg.textContent = T.planEdit.valueRange;
        valueInput()?.focus();
        return;
      }
      if (!/^\d{4}-\d{2}$/.test(to) || to < from) {
        msg.textContent = T.planEdit.toBeforeFrom;
        toInput.focus();
        return;
      }
      const res = rangeEditDoc(docs[fileId], r.memberId, target, from, to, text);
      if (res.error) {
        msg.textContent = res.error;
        return;
      }
      if (!res.doc) {
        msg.textContent = T.plan.noChange;
        return;
      }
      const impact = impactBetween(docs[fileId], res.doc, range);
      if (impact.months.length === 0) {
        returnFocusKey = focus;
        dialog.close();
        plan.hist.add(`${r.memberId}|${targetId(target)}`);
        commit(fileId, res.doc, focus);
        return;
      }
      pending = res.doc;
      confirmBox.hidden = false;
      confirmBox.replaceChildren(impactNote(fileId, impact, fmt(T.masters.pastNote, { month: monthJa(asOfMonth) })));
      submitBtn.textContent = fmt(T.masters.applyWithImpact, { n: impact.months.length });
      submitBtn.focus();
    });
    dialog.replaceChildren(html`<div class="yn-dialog-inner">
      <header class="yn-dialog-head">
        <div class="yn-title-with-tip"><h2 id="yn-me-dialog-title" class="yn-dialog-title">${fmt(T.planEdit.changeTitle, { name: r.name, target: label })}</h2>${infoTip(fmt(T.planEdit.changeLead, { name: r.name, target: label }), { label: T.masters.dialogTipLabel })}</div>
        <button type="button" class="yn-btn yn-btn-icon" aria-label=${T.breakdown.close} onclick=${() => dialog.close()}>×</button>
      </header>
      <div class="yn-dialog-body">${form}</div>
    </div>`);
    update();
    if (!dialog.open) dialog.showModal();
    valueInput()?.focus();
  }

  // ---- リソース計画のセル: その場で修正（§31.4） -----------------------------------
  /** 表の中の矢印キーで隣のセルへ（人の行・案件の行・契約外予定の行） */
  function gridKeys(ev) {
    const btn = ev.target.closest?.(".yn-plan-cell-btn");
    if (!btn || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(ev.key)) return;
    const td = btn.closest("td");
    const tr = td.closest("tr");
    let target = null;
    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
      target = (ev.key === "ArrowLeft" ? td.previousElementSibling : td.nextElementSibling)?.querySelector(".yn-plan-cell-btn");
    } else {
      const idx = [...tr.children].indexOf(td);
      let row = tr;
      do row = ev.key === "ArrowUp" ? row.previousElementSibling : row.nextElementSibling;
      while (row && !(row.classList.contains("yn-me-plan-row") || (row.classList.contains("yn-me-plan-sub") && !row.classList.contains("is-empty"))));
      target = row?.children[idx]?.querySelector(".yn-plan-cell-btn");
    }
    if (target) {
      ev.preventDefault();
      target.focus();
    }
  }

  const SCOPE_KEY = "yojitsu-navi:plan-cell-scope";

  /**
   * セルの編集欄。その月に掛かる案件ごとの人月・契約外予定・新しい案件の行。
   * 反映すると行を月で分けて書き直し、隣り合う同じ配分の行はまとめ直す
   */
  function openCellEditor(r, month, anchor, focusTarget = null, fk = `plan:cell:${r.memberId}:all:${month}`) {
    const fyLast = plan.months[plan.months.length - 1];
    const name = r.name || fmt(T.masters.unknownMemberValue, { id: r.memberId });
    const active = memberPeriodRows("assignments", r.memberId).filter((a) => a.startMonth <= month && month <= a.endMonth);
    const outAll = memberPeriodRows("outside", r.memberId);
    // 契約外予定は種別ごとに 1 欄（§50.1）。同じ月に同じ種別の行が重なっていれば欄を無効にする
    const outs = memberOutsideTypes(outAll).map((type, i) => {
      const covering = outAll.filter((o) => sameType(o.type, type) && o.startMonth <= month && month <= o.endMonth);
      const before = covering.length === 1 ? covering[0].text : covering.length === 0 ? "" : null;
      const label = outsideLabel(type);
      const input = html`<input type="text" class="yn-input yn-plan-pop-num" inputmode="decimal" autocomplete="off" id=${`yn-plan-pop-out-${i}`} value=${before ?? ""} disabled=${before === null} aria-label=${fmt(T.plan.editRowAria, { project: label, month: monthJa(month) })}>`;
      return { type, label, covering, before, input };
    });
    let scope = session.get(SCOPE_KEY) === "after" ? "after" : "month";
    let confirmed = false;
    const inputs = active.map((a, i) => {
      const input = html`<input type="text" class="yn-input yn-plan-pop-num" inputmode="decimal" autocomplete="off" id=${`yn-plan-pop-${i}`} value=${a.text} aria-label=${fmt(T.plan.editRowAria, { project: contractText(a.contractId), month: monthJa(month) })}>`;
      return { a, input, before: a.text };
    });
    const proj = combobox({ id: "yn-plan-pop-project", name: "__plan_project", options: projectOptions(), value: "", placeholder: T.masters.projectPlaceholder });
    const newNum = html`<input type="text" class="yn-input yn-plan-pop-num" inputmode="decimal" autocomplete="off" id="yn-plan-pop-new" aria-label=${fmt(T.plan.editRowAria, { project: T.plan.editNewRow, month: monthJa(month) })}>`;
    const msg = html`<p class="yn-me-form-msg" role="alert"></p>`;
    const note = html`<div class="yn-plan-pop-note"></div>`;
    const submit = html`<button type="submit" class="yn-btn yn-btn-primary">${T.plan.apply}</button>`;
    const afterNote = html`<span class="yn-me-small yn-plan-pop-after">${fmt(T.plan.scopeAfterNew, { last: monthJa(fyLast) })}</span>`;
    const scopeRadios = ["month", "after"].map((v) => {
      const input = html`<input type="radio" name="yn-plan-scope" value=${v} checked=${scope === v}>`;
      input.addEventListener("change", () => {
        scope = v;
        session.set(SCOPE_KEY, v);
        reset();
      });
      return html`<label class="yn-radio">${input}<span>${v === "month" ? T.plan.scopeMonth : T.plan.scopeAfter}</span></label>`;
    });
    const reset = () => {
      confirmed = false;
      note.replaceChildren();
      submit.textContent = T.plan.apply;
      afterNote.hidden = scope !== "after";
      cellEditor.refresh();
    };
    const form = html`<form class="yn-plan-pop-form" novalidate>
      <header class="yn-plan-pop-head">
        <div class="yn-title-with-tip"><h2 id="yn-plan-pop-title" class="yn-plan-pop-title">${fmt(T.plan.editTitle, { name, month: monthJa(month) })}</h2>${infoTip(T.plan.editLead, { label: T.masters.dialogTipLabel })}</div>
        <button type="button" class="yn-btn yn-btn-icon" aria-label=${T.breakdown.close} onclick=${() => cellEditor.close()}>×</button>
      </header>
      ${inputs.length
        ? html`<ul class="yn-plan-pop-rows">${inputs.map(({ a, input }) => {
            const c = contractById.get(a.contractId);
            return html`<li><label for=${input.id}><span class="yn-plan-pop-project">${c ? c.project || c.customer : contractText(a.contractId)}</span>${c && c.project ? html`<span class="yn-me-hint">${c.customer}</span>` : null}</label><span class="yn-plan-pop-val">${input}<span class="yn-me-small">${T.plan.unitPersonMonth}</span></span></li>`;
          })}</ul>`
        : html`<p class="yn-muted">${T.plan.tipNone}</p>`}
      <ul class="yn-plan-pop-rows yn-plan-pop-outside">${outs.map((o) => html`<li><label for=${o.input.id}><span class="yn-plan-pop-project">${o.label}</span><span class="yn-me-hint">${o.before === null ? T.planEdit.outsideOverlapHint : o.type ? T.planEdit.outsideTypeSub : T.planEdit.outsideSub}</span></label><span class="yn-plan-pop-val">${o.input}<span class="yn-me-small">${T.plan.unitPersonMonth}</span></span></li>`)}</ul>
      <div class="yn-plan-pop-new">
        <label for="yn-plan-pop-project">${T.plan.editNewRow}</label>
        <div class="yn-plan-pop-new-row">${proj}<span class="yn-plan-pop-val">${newNum}<span class="yn-me-small">${T.plan.unitPersonMonth}</span></span></div>
      </div>
      <fieldset class="yn-plan-pop-scope"><legend>${T.plan.scopeLabel}</legend><div class="yn-radio-group">${scopeRadios}</div>${afterNote}</fieldset>
      ${msg}${note}
      <div class="yn-me-form-foot">
        <button type="button" class="yn-btn-link yn-plan-pop-full" onclick=${() => {
          cellEditor.close();
          openRowDialog({ fileId: "assignments", mode: "add", preset: { member_id: r.memberId, start_month: month, end_month: fyLast }, focus: fk });
        }}>${T.plan.openFull}</button>
        <button type="button" class="yn-btn" onclick=${() => cellEditor.close()}>${T.masters.cancel}</button>
        ${submit}
      </div>
    </form>`;
    afterNote.hidden = scope !== "after";
    form.addEventListener("input", () => {
      msg.textContent = "";
      if (confirmed) reset();
    });
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const result = buildCellEdit();
      if (result.error) {
        msg.textContent = result.error;
        result.focus?.focus();
        cellEditor.refresh();
        return;
      }
      if (!result.changes.length) {
        cellEditor.close();
        return;
      }
      const months = new Set();
      let impactFile = null;
      let impactAll = null;
      for (const ch of result.changes) {
        const impact = impactBetween(docs[ch.fileId], ch.doc, range);
        for (const m of impact.months) months.add(m);
        if (impact.months.length && (!impactAll || ch.fileId === "assignments")) {
          impactFile = ch.fileId;
          impactAll = impact;
        }
      }
      if (months.size && !confirmed) {
        confirmed = true;
        note.replaceChildren(impactNote(impactFile, { ...impactAll, months: [...months].sort() }, fmt(T.masters.pastNote, { month: monthJa(asOfMonth) })));
        submit.textContent = fmt(T.plan.applyWithImpact, { n: months.size });
        cellEditor.refresh();
        submit.focus();
        return;
      }
      returnFocusKey = null;
      cellEditor.close();
      commitMany(result.changes, fk);
    });

    const isNum = (text) => text.trim() === "" || Number.isFinite(parseNumberCell(allocationFromInput(text, "personMonth", std)));
    const inRange = (text) => {
      const n = parseNumberCell(text);
      return text.trim() === "" || (Number.isFinite(n) && n >= 0 && n <= 1);
    };

    /** 入力から新しい文書を作る（変わったファイルだけ changes に入れる） */
    function buildCellEdit() {
      let doc = docs.assignments;
      const touched = new Set();
      const num = (text) => allocationFromInput(text, "personMonth", std);
      for (const { input } of inputs) if (!isNum(input.value)) return { error: T.plan.notNumber, focus: input };
      if (!isNum(newNum.value)) return { error: T.plan.notNumber, focus: newNum };
      for (const o of outs) {
        if (!isNum(o.input.value)) return { error: T.plan.notNumber, focus: o.input };
        if (!inRange(num(o.input.value))) return { error: T.planEdit.valueRange, focus: o.input };
      }
      const pKey = proj.getValue();
      const newVal = num(newNum.value);
      const newZero = newVal === "" || Math.abs(parseNumberCell(newVal)) < 1e-9;
      if (!newZero && !pKey) return { error: T.plan.needProject, focus: proj.input };
      for (const { a, input, before } of inputs) {
        const after = num(input.value);
        const same = after === before || (after !== "" && before !== "" && Math.abs(parseNumberCell(after) - parseNumberCell(before)) < 1e-9);
        if (same) continue;
        const row = doc.rows.find((x) => x.id === a.rowId);
        if (!row) continue;
        const pieces = editMonthAllocation({ startMonth: a.startMonth, endMonth: a.endMonth, allocation: before }, month, after, scope);
        if (pieces.length === 0) doc = deleteRow(doc, a.rowId);
        else {
          doc = updateRow(doc, a.rowId, { start_month: pieces[0].startMonth, end_month: pieces[0].endMonth, allocation: pieces[0].allocation });
          for (const p of pieces.slice(1)) doc = addRow(doc, { member_id: r.memberId, contract_id: a.contractId, start_month: p.startMonth, end_month: p.endMonth, allocation: p.allocation }).doc;
        }
        touched.add(a.contractId);
      }
      if (pKey && !newZero) {
        const p = projects.get(pKey);
        const to = scope === "after" ? (fyLast >= month ? fyLast : month) : month;
        for (const sg of p ? contractSegments(p.contracts, month, to) : []) {
          doc = addRow(doc, { member_id: r.memberId, contract_id: sg.contractId, start_month: sg.startMonth, end_month: sg.endMonth, allocation: newVal }).doc;
          touched.add(sg.contractId);
        }
      }
      // 同じメンバー・契約で隣り合う同じ配分の行をまとめ直す（元の行を残す）
      for (const contractId of touched) {
        const rows = doc.rows
          .filter((x) => cellOf(doc, x, "member_id") === r.memberId && cellOf(doc, x, "contract_id") === contractId)
          .map((x) => ({ id: x.id, startMonth: cellOf(doc, x, "start_month"), endMonth: cellOf(doc, x, "end_month"), allocation: cellOf(doc, x, "allocation") }));
        const { keep, drop } = mergeAdjacent(rows, new Set(rows.filter((x) => doc.originals[x.id]).map((x) => x.id)));
        for (const [id, period] of keep) doc = updateRow(doc, id, { start_month: period.startMonth, end_month: period.endMonth });
        for (const id of drop) doc = deleteRow(doc, id);
      }
      const changes = touched.size ? [{ fileId: "assignments", doc }] : [];
      // 契約外予定: この月だけ／この月以降（掛かっている行の終わりまで、無ければ年度末まで）
      // 種別ごとに順に当てる（前の種別の変更を土台に次の種別を書き直す）
      let outDoc = docs.outside;
      for (const o of outs) {
        if (o.before === null) continue;
        const after = num(o.input.value);
        const same = after === o.before || (after !== "" && o.before !== "" && Math.abs(parseNumberCell(after) - parseNumberCell(o.before)) < 1e-9) || (after !== "" && o.before === "" && Math.abs(parseNumberCell(after)) < 1e-9);
        if (same) continue;
        const to = scope === "month" ? month : o.covering[0] ? o.covering[0].endMonth : fyLast >= month ? fyLast : month;
        const res = rangeEditDoc(outDoc, r.memberId, { kind: "outside", type: o.type }, month, to, after);
        if (res.error) return { error: res.error, focus: o.input };
        if (res.doc) outDoc = res.doc;
      }
      if (outDoc !== docs.outside) changes.push({ fileId: "outside", doc: outDoc });
      return { changes };
    }

    cellEditor.open(anchor, form, { onClose: () => focusKey(fk) });
    const first = focusTarget?.kind === "outside" ? (outs.find((o) => sameType(o.type, focusTarget.type ?? "") && !o.input.disabled)?.input ?? null) : focusTarget ? (inputs.find(({ a }) => projectOfContract(a.contractId).key === focusTarget.key)?.input ?? (focusTarget.kind === "project" ? proj.input : null)) : null;
    const el = first ?? inputs[0]?.input ?? proj.input;
    el.focus();
    el.select?.();
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
    if (col.input === "status") {
      // 在籍状態（§35）。CSV では空 = 在籍、「退職」= 退職
      const left = value !== "" && value !== T.masters.statusActive;
      const known = value === "" || value === T.masters.statusActive || value === T.masters.statusLeft || /^(left|retired)$/i.test(value);
      return html`<select id=${id} name=${col.name} class="yn-select" disabled=${disabled} aria-describedby=${`${id}-hint`}>
        <option value="" selected=${!left}>${T.masters.statusActive}</option>
        <option value=${T.masters.statusLeft} selected=${left && known}>${T.masters.statusLeft}</option>
        ${!known ? html`<option value=${value} selected>${value}${T.masters.invalidValue}</option>` : null}
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
    if (col.input === "project") {
      // 案件で選ぶ（値は案件のキー）。ファイルに無い契約を指す既存の行は "c:<ID>" のまま持つ（§31.3）
      const c = contractById.get(value);
      const v = value === "" ? "" : c ? projectKey(c.customer, c.project) : `c:${value}`;
      return combobox({ id, name: PROJECT_FIELD, options: projectOptions(), value: v, required: req, disabled, placeholder: T.masters.projectPlaceholder, describedBy: `${id}-hint`, unknownLabel: (x) => fmt(T.masters.unknownContractValue, { id: x.replace(/^c:/, "") }) });
    }
    if (col.input === "member") {
      return combobox({ id, name: col.name, options: memberOptions(), value, required: req, disabled, placeholder: T.masters.memberPlaceholder, describedBy: `${id}-hint`, unknownLabel: (x) => fmt(T.masters.unknownMemberValue, { id: x }) });
    }
    if (col.input === "rateKey") {
      // 役職名（新しい役職も入れられる）か、個人単価ならメンバーを名前で選ぶ
      const titles = titleOptions().map((t) => ({ value: t, label: t, sub: T.members.colTitle }));
      const people = memberOptions().map((o) => ({ ...o, sub: [T.masters.personalRateHint, o.sub].filter(Boolean).join(" ・ ") }));
      return combobox({ id, name: col.name, options: [...titles, ...people], value, required: req, disabled, allowCustom: true, describedBy: `${id}-hint` });
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
        const n = parseNumberCell(out);
        conv.textContent = out === "" || !Number.isFinite(n) ? "" : unitSel.value === "hours" ? fmt(T.plan.convFromHours, { hours: input.value.trim(), pm: out, std }) : fmt(T.plan.convFromPm, { pm: out, hours: hoursFromAllocation(n, std) });
      };
      let lastUnit = "personMonth";
      unitSel.addEventListener("change", () => {
        // 単位を切り替えたら、入っている値を新しい単位に換算して見せる
        const n = parseNumberCell(input.value);
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
    if (col.input === "outsideType") {
      // 契約外の種別（§50.1）。分類表の種別から選ぶ（分類表に無い値も消さずに残す）
      const known = value === "" || outsideTypeList.some((t) => sameType(t, value));
      return html`<select id=${id} name=${col.name} class="yn-select" disabled=${disabled} aria-describedby=${`${id}-hint`}>
        ${outsideTypeList.length === 0 || value === "" ? html`<option value="" selected=${value === ""}>${T.masterFiles.outsideNoType}</option>` : null}
        ${outsideTypeList.map((t) => html`<option value=${t} selected=${sameType(t, value)}>${t}</option>`)}
        ${!known ? html`<option value=${value} selected>${value}${T.masters.invalidValue}</option>` : null}
      </select>`;
    }
    if (col.input === "month") {
      return html`<input id=${id} name=${col.name} class="yn-input" type="month" value=${/^\d{4}-\d{2}$/.test(value) ? value : ""} required=${req} disabled=${disabled} aria-describedby=${`${id}-hint`}>`;
    }
    const listId = col.input === "title" ? `${id}-list` : null;
    const input = html`<input id=${id} name=${col.name} class="yn-input" type="text" value=${value} required=${req} disabled=${disabled} list=${listId} autocomplete="off" inputmode=${col.input === "number" ? "decimal" : null} aria-describedby=${`${id}-hint`}>`;
    if (!listId) return input;
    const options = titleOptions().map((t) => ({ v: t, l: T.members.colTitle }));
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
    contract_id: T.masters.hintProject,
    team_id: T.masters.hintTeamId,
    title: T.masters.hintTitle,
    status: T.masters.statusHint,
  };

  /**
   * フォームの値（アサインの contract_id 欄は案件のキー）を、書き込む行の値の配列にする（§31.3）
   * 案件の契約へ期間の月ごとに割り当て、契約が切り替わる所で行を分ける。アサイン以外はそのまま 1 行
   */
  function resolveProjectRows(fileId, values) {
    if (fileId !== "assignments") return [values];
    const v = values.contract_id ?? "";
    if (v.startsWith("c:")) return [{ ...values, contract_id: v.slice(2) }];
    const p = projects.get(v);
    if (!p) return [values];
    const segs = contractSegments(p.contracts, values.start_month, values.end_month);
    if (segs.length === 0) {
      // 月が未入力・逆順など。開始月に最も近い契約を入れておき、期間の誤りは検証で知らせる
      const latest = p.contracts.reduce((a, b) => (b.startMonth > a.startMonth ? b : a));
      return [{ ...values, contract_id: latest.contractId }];
    }
    return segs.map((sg) => ({ ...values, contract_id: sg.contractId, start_month: sg.startMonth, end_month: sg.endMonth }));
  }

  /**
   * 追加（mode: "add"、template があればその行を写して適用開始月を翌月に）／修正（mode: "edit"）
   */
  function openRowDialog({ fileId, mode, rowId = null, template = null, preset = null, focus }) {
    if (locked || pendingDraft) return;
    returnFocusKey = focus;
    const def = MASTER_FILES[fileId];
    const doc = docs[fileId];
    const columns = def.columns.filter((c) => doc.header.includes(c.name));
    const row = rowId ? doc.rows.find((r) => r.id === rowId) : null;
    const isOriginal = !!(row && doc.originals[row.id]);
    let initial = row ? rowRecord(doc, row) : template ? rowRecord(doc, template) : Object.fromEntries(columns.map((c) => [c.name, ""]));
    if (mode === "add") {
      const next = addMonths(asOfMonth, 1);
      // 変更の追加は翌月から（最新の履歴がそれより後なら、その翌月から）
      const tFrom = template ? (initial.effective_from ?? "").trim() : "";
      if (def.history === "effective") initial = { ...initial, effective_from: /^\d{4}-\d{2}$/.test(tFrom) && tFrom >= next ? addMonths(tFrom, 1) : next };
      else if (template) initial = { ...initial, start_month: next };
      if (!template && fileId === "members") initial = { ...initial, kind: "employee" };
      if (preset) initial = { ...initial, ...preset };
    }
    const lockImported = (name) => fileId === "members" && importMode && MEMBER_IMPORTED_COLUMNS.includes(name) && !(mode === "edit" && !isOriginal) && !(mode === "add" && !template);
    // 「＋ 変更」（同じ対象の履歴を足す）では対象の ID を変えさせない。変えると別の対象の行になってしまう
    const lockKey = (name) => mode === "add" && !!template && def.history === "effective" && name === def.keyColumns[0];
    // 対象は名前で呼ぶ（メンバー・組織。ID は前面に出さない）
    const templateKey = template ? ((fileId === "members" || fileId === "teams") && (initial.name ?? "").trim()) || displayValue(fileId, def.keyColumns[0], (initial[def.keyColumns[0]] ?? "").trim()) : "";
    const title =
      mode === "edit"
        ? def.history === "effective"
          ? fmt(T.ledger.editTitle, { file: def.label })
          : fmt(T.masters.editTitle, { file: def.label })
        : def.history === "effective"
          ? template
            ? fmt(T.ledger.addChangeTitle, { key: templateKey })
            : T.ledger.addNew[fileId]
          : fileId === "outside"
            ? T.planEdit.addOutsideTitle
            : T.masters.addAssignmentTitle;
    const lead =
      mode === "edit"
        ? isOriginal
          ? def.history === "effective"
            ? T.ledger.editLead
            : T.planEdit.editLead
          : T.masters.editAddedLead
        : def.history === "effective"
          ? template
            ? T.ledger.addChangeLead
            : T.ledger.addNewLead
          : fileId === "outside"
            ? T.planEdit.addOutsideLead
            : T.masters.addAssignmentLead;

    const form = html`<form class="yn-me-form" novalidate>
      <div class="yn-me-fields">
        ${columns.map((c) => {
          const keyLocked = lockKey(c.name);
          const disabled = keyLocked || lockImported(c.name);
          return html`<div class="yn-me-field">
            <label for=${`yn-me-f-${c.name}`}>${c.label}${c.required ? html`<span class="yn-me-req" aria-hidden="true"> *</span>` : null}</label>
            ${fieldFor(fileId, c, (initial[c.name] ?? "").trim(), disabled)}
            <span class="yn-me-field-hint" id=${`yn-me-f-${c.name}-hint`}>${keyLocked ? T.masters.keyLocked : disabled ? T.masters.hrReadonly : fileId === "members" && c.name === "member_id" ? T.masters.hintMemberKey : c.name === "team_id" && c.input !== "text" ? "" : (FIELD_HINTS[c.name] ?? "")}</span>
          </div>`;
        })}
      </div>
      <div class="yn-me-form-msg" role="alert"></div>
      <div class="yn-me-confirm" hidden></div>
    </form>`;
    // 取り込みモードのメンバー追加: 社員番号を選ぶと取り込み列を最新の行から写す
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
        const el = form.querySelector(`[name="${c.input === "project" ? PROJECT_FIELD : c.name}"]`);
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
      form.querySelector(`#yn-me-f-${columns[0].name}`)?.focus();
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
        form.querySelector(`#yn-me-f-${missing[0].name}`)?.focus();
        return;
      }
      msg.textContent = "";
      const before = docs[fileId];
      let next;
      let focusAfter;
      // アサインは案件 → 期間の月ごとに契約へ割り当て、切り替わりで行を分ける（§31.3）
      const pieces = resolveProjectRows(fileId, values);
      if (mode === "edit") {
        next = updateRow(before, rowId, pieces[0]);
        focusAfter = `edit:${rowId}`;
        for (const extra of pieces.slice(1)) next = addRow(next, extra).doc;
      } else {
        const r = addRow(before, pieces[0]);
        next = r.doc;
        focusAfter = `edit:${r.rowId}`;
        for (const extra of pieces.slice(1)) next = addRow(next, extra).doc;
      }
      Object.assign(values, pieces[0]);
      const impact = impactBetween(before, next, range);
      const changes = mode === "edit" ? columns.filter((c) => (rowRecord(before, row)[c.name] ?? "").trim() !== (values[c.name] ?? "")) : [];
      if (mode === "edit" && changes.length === 0 && pieces.length === 1) {
        dialog.close();
        return;
      }
      // 追加で過去に影響が無く、行も分けないならそのまま適用。修正は常に確認、追加も過去が変わるなら確認
      if (mode === "add" && impact.months.length === 0 && pieces.length === 1) {
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
            ? html`<p><strong>${T.masters.willChange}</strong></p><ul class="yn-me-change-list">${changes.map((c) => html`<li>${c.label}: <span class="yn-me-before">${displayValue(fileId, c.name, (rowRecord(before, row)[c.name] ?? "").trim()) || T.masters.emptyValue}</span> → <span class="yn-me-after">${displayValue(fileId, c.name, values[c.name] ?? "") || T.masters.emptyValue}</span></li>`)}</ul>`
            : html`<p><strong>${T.masters.willAdd}</strong></p>`}
          ${pieces.length > 1 ? html`<p class="yn-me-split" role="note">${fmt(T.masters.splitNote, { n: pieces.length, list: pieces.map((p) => `${p.start_month}〜${p.end_month}`).join("、") })}</p>` : null}
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
        <div class="yn-title-with-tip"><h2 id="yn-me-dialog-title" class="yn-dialog-title">${title}<span class="yn-me-path"> ${fileName(def.path)}</span></h2>${infoTip(lead, { label: T.masters.dialogTipLabel })}</div>
        <button type="button" class="yn-btn yn-btn-icon" aria-label=${T.breakdown.close} onclick=${() => dialog.close()}>×</button>
      </header>
      <div class="yn-dialog-body">${form}</div>
    </div>`);
    if (!dialog.open) dialog.showModal();
    // 最初の空の入力欄にフォーカス（リソース計画でメンバーを入れて開いたときは配分から）。無ければ最初の欄。
    // 選択欄（select）は Space でリストが開き Esc がダイアログに届かないので、空でも最初には選ばない
    const fields = [...form.querySelectorAll("input:not([disabled]):not([type=hidden]), select:not([disabled])")];
    (fields.find((el) => el.tagName === "INPUT" && el.value === "") ?? fields[0])?.focus();
  }

  function openDeleteDialog(fileId, rowId, focus) {
    if (locked || pendingDraft) return;
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
      // 削除後は対象の開閉ボタン（台帳の対象・リソース計画の履歴）にフォーカス。無くなっていれば追加ボタン
      returnFocusKey = focus;
      dialog.close();
      commit(fileId, next, returnFocusKey);
    };
    dialog.replaceChildren(html`<div class="yn-dialog-inner">
      <header class="yn-dialog-head">
        <h2 id="yn-me-dialog-title" class="yn-dialog-title">${def.label}${T.masters.deleteConfirmTitle}</h2>
        <button type="button" class="yn-btn yn-btn-icon" aria-label=${T.breakdown.close} onclick=${() => dialog.close()}>×</button>
      </header>
      <div class="yn-dialog-body">
        <dl class="yn-me-dl">${columns.map((c) => html`<div><dt>${c.label}</dt><dd>${displayValue(fileId, c.name, (rec[c.name] ?? "").trim()) || "—"}</dd></div>`)}</dl>
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
  // ---- 検証の一覧（§40）: 名前で示し、押すと該当箇所へ -------------------------
  /** 一覧に最初に出す件数（残りは「すべて表示」） */
  const ISSUE_PREVIEW = 8;
  let showAllIssues = false;

  /** 行の列の値（行が無ければ ""） */
  function issueRowCell(i, column) {
    if (!i.fileId || !i.rowId) return "";
    const doc = docs[i.fileId];
    const row = doc.rows.find((r) => r.id === i.rowId);
    return row && doc.header.includes(column) ? cellOf(doc, row, column) : "";
  }
  /** 誰・何のエラーか（名前。ID は名前が無いときだけ） */
  function issueSubject(i) {
    const names = memberNames();
    const memberId = issueRowCell(i, "member_id") || (i.ref?.memberId != null ? String(i.ref.memberId) : "");
    switch (i.fileId) {
      case "members":
        return issueRowCell(i, "name") || names.get(memberId) || memberId;
      case "rates": {
        const key = issueRowCell(i, "key");
        return names.get(key) || key;
      }
      case "teams": {
        const id = issueRowCell(i, "team_id");
        return issueRowCell(i, "name") || teamNames().get(id) || id;
      }
      case "assignments":
      case "outside": {
        const who = memberId ? names.get(memberId) || fmt(T.masters.unknownMemberValue, { id: memberId }) : "";
        // 人の月合計・退職後のアサインは人ごとのこと（案件は付けない）
        if (PERSON_ISSUES.has(i.code)) return who;
        const contractId = issueRowCell(i, "contract_id");
        const what = i.fileId === "outside" ? outsideLabel(issueRowCell(i, "type")) : contractId ? projectOfContract(contractId).label : "";
        return [who, what].filter(Boolean).join(" ・ ");
      }
      default:
        return "";
    }
  }
  /** 文中の ID を名前に（メンバー・案件）。先頭に出した人の名前は文から外す */
  function issueMessage(i) {
    const names = memberNames();
    const subjectId = issueRowCell(i, "member_id") || (i.ref?.memberId != null ? String(i.ref.memberId) : "");
    return issueText(i)
      .replace(/^メンバー(?:ID)? ([A-Za-z0-9_-]+) ?(?:の|は) ?/, (m, id) => (id === subjectId && names.get(id) ? "" : m))
      .replace(/メンバー(?:ID)? ([A-Za-z0-9_-]+)/g, (m, id) => names.get(id) || m)
      .replace(/(?:契約ID|案件) ([A-Za-z0-9_-]+)/g, (m, id) => (contractById.has(id) ? `「${projectOfContract(id).label}」` : m))
      .replace(/（([A-Za-z0-9_, -]+)）/g, (m, ids) => {
        // 「（M025, M202）」のような ID の並びも名前に
        const list = ids.split(/,\s*/);
        return list.every((id) => names.get(id)) ? `（${list.map((id) => names.get(id)).join("、")}）` : m;
      });
  }
  /** 他の画面のファイルは、その画面を開いて該当箇所へ（?jump=ファイル:行番号） */
  function issueHref(i) {
    const base = FILE_PAGE[i.fileId];
    const jump = i.row ? `jump=${i.fileId}:${i.row}` : "";
    return jump ? `${base}${base.includes("?") ? "&" : "?"}${jump}` : base;
  }

  /** 該当箇所を見せてフォーカスする（絞り込み・年度・組織を合わせ、閉じている履歴を開く） */
  function revealIssue(i) {
    const fileId = i.fileId;
    if (!fileId || !pageFiles.includes(fileId)) return;
    const doc = docs[fileId];
    const row = i.rowId ? doc.rows.find((r) => r.id === i.rowId) : null;
    let key = null;
    if (fileId === "assignments" || fileId === "outside") {
      active = PLAN_VIEW_ID;
      if (csvEdit.assignments.on && csvEdit.assignments.text === null) csvEdit.assignments.on = false;
      const memberId = row ? cellOf(doc, row, "member_id") : i.ref?.memberId != null ? String(i.ref.memberId) : "";
      const start = row ? cellOf(doc, row, "start_month") : String(i.ref?.month ?? "");
      if (/^\d{4}-\d{2}$/.test(start) && !plan.months.includes(start)) plan.months = fiscalMonths(start, config.fiscalYearStartMonth);
      plan.q = "";
      const src = planSourcesFromDocs(docs, data.context.contracts);
      const shown = () => planView(src, plan.teamId, plan.months).rows.some((r) => r.memberId === memberId);
      if (memberId && !shown()) {
        const at = plan.months.includes(asOfMonth) ? asOfMonth : plan.months[0];
        plan.teamId = memberTeamAt(src.members, memberId, at) ?? null;
        if (!shown()) plan.teamId = null;
      }
      if (memberId) plan.open.add(memberId);
      if (PERSON_ISSUES.has(i.code) && memberId) {
        // 人の行の、問題の最初の月のセルへ
        const month = String(i.ref?.month ?? start);
        if (/^\d{4}-\d{2}$/.test(month) && !plan.months.includes(month)) plan.months = fiscalMonths(month, config.fiscalYearStartMonth);
        key = `plan:cell:${memberId}:all:${month}`;
      } else if (row && memberId) {
        const target = fileId === "outside" ? { kind: "outside", type: memberOutsideTypes(memberPeriodRows("outside", memberId)).find((t) => sameType(t, cellOf(doc, row, "type"))) ?? cellOf(doc, row, "type") } : { kind: "project", key: projectOfContract(cellOf(doc, row, "contract_id")).key };
        plan.hist.add(`${memberId}|${targetId(target)}`);
        key = `edit:${row.id}`;
      } else if (memberId) key = `plan:toggle:${memberId}`;
    } else {
      active = fileId;
      if (csvEdit[fileId].on && csvEdit[fileId].text === null) csvEdit[fileId].on = false;
      listFilter[fileId].q = "";
      listFilter[fileId].changedOnly = false;
      if (row) {
        openGroupOfRow(fileId, row.id);
        key = `edit:${row.id}`;
      } else key = VIEW_IDS.length > 1 ? `tab:${fileId}` : null;
    }
    renderTabs();
    renderPanel();
    // 台帳は対象の行と今の値の履歴の行に同じ「修正」があるので、履歴の行（エラーの文が付く方）を選ぶ
    const el = key ? (row ? root.querySelector(`[data-key="${CSS.escape(row.id)}"] [data-fk="${CSS.escape(key)}"]`) : null) ?? root.querySelector(`[data-fk="${CSS.escape(key)}"]`) : null;
    if (!el) {
      // 画面に出せない行（存在しないメンバーのアサインなど）は修正のダイアログで見せる
      if (row && !(locked || pendingDraft)) openRowDialog({ fileId, mode: "edit", rowId: row.id, focus: `tab:${fileId}` });
      else root.querySelector("#yn-me-panel")?.scrollIntoView({ block: "start" });
      return;
    }
    // 月のセルはそのセルを（横にも）見せる。それ以外は行を
    const box = el.matches(".yn-plan-cell-btn") ? el : (el.closest("li.yn-me-plan-entry, tr") ?? el);
    el.focus({ preventScroll: true });
    box.scrollIntoView({ block: "center", inline: "nearest" });
    // 横にスクロールする表は左端に戻す（名前とエラーの文が見えるように）
    const wrap = el.closest(".yn-table-wrap");
    if (wrap && !el.matches(".yn-plan-cell-btn")) wrap.scrollLeft = 0;
    box.classList.add("is-jumped");
    setTimeout(() => box.classList.remove("is-jumped"), 2400);
  }

  function renderCheck() {
    const v = validation;
    const status =
      v.errors > 0
        ? html`<p class="yn-me-check is-error" role="status"><span class="yn-chip yn-chip-danger"><span aria-hidden="true">!</span> ${T.dataCheck.severityError} ${integer(v.errors)}${T.masters.countSuffix}</span> ${T.masters.cannotSave}${v.warnings ? html` <span class="yn-chip yn-chip-warn"><span aria-hidden="true">i</span> ${T.dataCheck.severityWarning} ${integer(v.warnings)}${T.masters.countSuffix}</span> ${T.masters.warningsNotBlocking}` : null}</p>`
        : html`<p class="yn-me-check is-ok" role="status"><span class="yn-chip yn-chip-ok"><span aria-hidden="true">✓</span> ${T.dataCheck.noErrors}</span>${v.warnings ? html` <span class="yn-chip yn-chip-warn"><span aria-hidden="true">i</span> ${T.dataCheck.severityWarning} ${integer(v.warnings)}${T.masters.countSuffix}</span> ${T.masters.warningsNotBlocking}` : null}</p>`;
    // エラーを先に。同じ重さの中はファイル（この画面のものを先）・行の順
    const order = (i) => (i.fileId && pageFiles.includes(i.fileId) ? 0 : 1);
    const all = [...v.issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) || order(a) - order(b) || MASTER_FILE_IDS.indexOf(a.fileId) - MASTER_FILE_IDS.indexOf(b.fileId) || (a.row ?? 0) - (b.row ?? 0));
    const shown = showAllIssues ? all : all.slice(0, ISSUE_PREVIEW);
    const item = (i, n) => {
      const err = i.severity === "error";
      const subject = issueSubject(i);
      const where = i.fileId ? MASTER_FILES[i.fileId].label : "";
      const other = i.fileId && !pageFiles.includes(i.fileId);
      const body = html`<span class=${`yn-chip ${err ? "yn-chip-danger" : "yn-chip-warn"}`}><span aria-hidden="true">${err ? "!" : "i"}</span> ${err ? T.dataCheck.severityError : T.dataCheck.severityWarning}</span>
        <span class="yn-me-issue-main">${subject ? html`<strong class="yn-me-issue-subject">${subject}</strong>` : null}<span class="yn-me-issue-msg">${issueMessage(i)}</span></span>
        ${where ? html`<span class="yn-me-issue-where">${other ? fmt(T.masters.issueOnPage, { file: where, page: pageName(i.fileId) }) : where}</span>` : null}`;
      const fk = `issue:${n}`;
      const cls = `yn-me-issue-item ${err ? "is-error" : "is-warning"}`;
      if (!i.fileId) return html`<li class=${cls}><span class="yn-me-issue-static">${body}</span></li>`;
      if (other) return html`<li class=${cls}><a class="yn-me-issue-link" href=${issueHref(i)} data-fk=${fk}>${body}</a></li>`;
      return html`<li class=${cls}><button type="button" class="yn-me-issue-link" data-fk=${fk} onclick=${() => revealIssue(i)}>${body}</button></li>`;
    };
    parts.check.replaceChildren(html`<section class="yn-me-section" aria-labelledby="yn-me-check-title">
      <div class="yn-title-with-tip"><h2 id="yn-me-check-title" class="yn-section-title">${T.masters.validationTitle}</h2>${infoTip(html`<span class="yn-me-help">${T.masters.validationOk}</span><span class="yn-me-help">${T.masters.issueListHelp}</span><span class="yn-me-help">${T.masters.worklogWarningsNote}</span>`, { label: fmt(T.layout.aboutSection, { title: T.masters.validationTitle }) })}</div>
      ${status}
      ${all.length ? html`<ul class="yn-me-issue-list" aria-label=${T.masters.issueListAria}>${shown.map(item)}</ul>` : null}
      ${all.length > ISSUE_PREVIEW
        ? html`<p class="yn-me-actions"><button type="button" class="yn-btn yn-btn-sm" data-fk="issue:more" aria-expanded=${showAllIssues ? "true" : "false"} onclick=${() => {
            showAllIssues = !showAllIssues;
            renderCheck();
            focusKey(showAllIssues ? `issue:${ISSUE_PREVIEW}` : "issue:more");
          }}>${showAllIssues ? fmt(T.masters.issueShowLess, { n: integer(ISSUE_PREVIEW) }) : fmt(T.masters.issueShowAll, { n: integer(all.length) })}</button></p>`
        : null}
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
          const line = (rec) => cols.map((c) => displayValue(d.fileId, c.name, (rec[c.name] ?? "").trim()) || "—").join(" ・ ");
          const rows = [
            ...d.added.map((a) => ({ kind: T.masters.added, chip: "yn-chip-ok", sign: "＋", key: a.rowId, text: line(a.after), detail: null })),
            ...d.changed.map((c) => ({ kind: T.masters.changed, chip: "yn-chip-neutral", sign: "✎", key: c.rowId, text: line(c.before), detail: c.columns.map((col) => fmt(T.masters.diffValue, { col: label(col), before: displayValue(d.fileId, col, (c.before[col] ?? "").trim()) || T.masters.emptyValue, after: displayValue(d.fileId, col, (c.after[col] ?? "").trim()) || T.masters.emptyValue })).join(" / ") })),
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
      <div class="yn-title-with-tip"><h2 id="yn-me-diff-title" class="yn-section-title">${T.masters.diffTitle}</h2>${infoTip(T.masters.diffNote, { label: fmt(T.layout.aboutSection, { title: T.masters.diffTitle }) })}</div>
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

  /** 利用者が入力したコミットメッセージ（再描画で既定文に戻さない）。null なら既定文 */
  let typedMessage = null;
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
    const token = getToken();
    saving = true;
    outcome = null;
    renderSave();
    // 検証を通った内容をここで固定する（変更者を問い合わせているあいだに編集されても、検証していない内容を送らない）
    const snapshot = changedFiles().map((id) => ({ id, doc: docs[id], text: validation.texts[id] }));
    const message = (messageInput || "").trim() || commitMessage();
    const description = mrDescription();
    try {
      // 追加・変更した行に変更者と変更日を書き込む（§56。リソース計画の変更の履歴に出す）
      const by = snapshot.some((f) => STAMPED_FILES.includes(f.id)) ? (await fetchCurrentUser(gitlab, data.masterEdit, token)).username : "";
      const files = snapshot.map((f) => ({ path: data.files[f.id].repoPath ?? MASTER_FILES[f.id].path, content: stampedText(f.id, by, f.doc, f.text), lastCommitId: bases[f.id].lastCommitId, create: data.files[f.id].exists === false }));
      const result = await saveToGitLab(gitlab, { config: data.masterEdit, token, files, message, description, now: now() });
      outcome = { kind: "ok", result };
      locked = true;
      // 保存できたら下書きは不要
      local.remove(DRAFT_STORAGE_KEY);
      draftSavedAt = null;
      for (const c of Object.values(csvEdit)) c.result = null;
      // 作った MR を「マージ待ちの変更」とヘッダーの件数に出す
      if (result.commitMode === "mr") mrPanel.refresh();
    } catch (e) {
      outcome = { kind: "error", error: { kind: e?.kind ?? "other", message: e?.message ?? String(e), detail: e?.detail ?? "", status: e?.status ?? null, partial: e?.partial ?? null } };
      if (outcome.error.kind === "permission" && outcome.error.status === 401) clearToken();
      // コミットまでは済んだ（MR だけ失敗）: もう一度保存すると別ブランチに同じ変更が重複するので止める
      if (outcome.error.partial) {
        locked = true;
        local.remove(DRAFT_STORAGE_KEY);
        draftSavedAt = null;
      }
    } finally {
      saving = false;
      renderAll();
      focusKey("save:outcome");
    }
  }

  /** 保存する CSV（追加・変更した行に変更者・変更日を書く。§56） */
  function stampedText(id, by, doc = docs[id], text = validation.texts[id]) {
    if (!STAMPED_FILES.includes(id)) return text;
    const at = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(now());
    return serializeMasterDoc(stampChangedRows(doc, by, at)).text;
  }

  function download(id) {
    // ダウンロードでは GitLab のユーザー名が分からないので変更日だけ書く
    const text = stampedText(id, "");
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
    for (const c of Object.values(csvEdit)) Object.assign(c, { text: null, result: null });
    locked = false;
    outcome = null;
    typedMessage = null;
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
        <p>${r.commitMode === "mr" ? T.masters.afterMrShort : T.masters.afterCommitShort} ${infoTip(r.commitMode === "mr" ? T.masters.afterMr : T.masters.afterCommit, { label: T.masters.afterSaveTipLabel })}</p>
        <p><button type="button" class="yn-btn" data-fk="save:restart" onclick=${() => resetAll()}>${T.masters.startOver}</button></p>
      </div>`;
    }
    const e = outcome.error;
    const titles = e.partial ? { other: T.masters.errPartial, permission: T.masters.errPartial } : { conflict: T.masters.errConflict, permission: T.masters.errPermission, network: T.masters.errNetwork, other: T.masters.errOther };
    return html`<div class="yn-me-outcome is-error" role="alert" tabindex="-1" data-fk="save:outcome" data-error-kind=${e.kind}>
      <p class="yn-me-outcome-title"><span aria-hidden="true">!</span> ${titles[e.kind] ?? titles.other}</p>
      <p>${e.message}</p>
      ${e.partial
        ? html`<ul>
            <li>${T.masters.branchLabel} <code>${e.partial.branch}</code></li>
            ${e.partial.commitUrl ? html`<li>${T.masters.commitLabel} <a href=${e.partial.commitUrl} target="_blank" rel="noopener">${T.masters.openInGitlab}</a></li>` : null}
          </ul>
          <p><button type="button" class="yn-btn" data-fk="save:restart" onclick=${() => resetAll()}>${T.masters.startOver}</button></p>`
        : html`${e.detail ? html`<p class="yn-me-small">${T.masters.gitlabResponse} <code>${e.detail}</code></p>` : null}
          <p class="yn-me-small">${T.masters.editsKept}</p>`}
      ${e.kind === "network" ? html`<p><button type="button" class="yn-btn yn-btn-primary" data-fk="save:to-download" onclick=${() => {
        mode = "download";
        outcome = null;
        renderAll();
        focusKey("save:heading");
      }}>${T.masters.switchToDownload}</button></p>` : null}
    </div>`;
  }

  /** 他の画面（マスタ編集 ↔ リソース計画）で行った変更も一緒に保存されることの案内 */
  function otherPageNote() {
    const others = changedFiles().filter((id) => !pageFiles.includes(id));
    if (!others.length) return null;
    return html`<p class="yn-note" data-role="other-page-changes">${fmt(T.ledger.otherPageChanges, { files: others.map((id) => `${MASTER_FILES[id].label} ${integer(diffMasterDoc(docs[id]).count)}`).join("、") })} ${[...new Set(others.map((id) => FILE_PAGE[id]))].map((href) => html`<a href=${href}>${fmt(T.ledger.openPage, { page: pageName(others.find((id) => FILE_PAGE[id] === href)) })}</a> `)}</p>`;
  }

  function renderSave() {
    const reason = blockedReason();
    const files = changedFiles();
    const cfg = data.masterEdit;
    // 変更が無いうちは保存の欄を出さない（保存の結果を表示中は除く）
    if (files.length === 0 && !outcome && !saving) {
      parts.save.replaceChildren();
      return;
    }
    let body;
    let help;
    if (mode === "gitlab") {
      // トークンの登録・接続の確認は設定画面だけで行う（SPEC §28）。ここは未登録のときに設定へのリンクを出すだけ
      const hasToken = getToken() !== "";
      const msgInput = html`<input type="text" id="yn-me-message" class="yn-input yn-me-message" value=${typedMessage ?? commitMessage()}>`;
      msgInput.addEventListener("input", () => {
        typedMessage = msgInput.value.trim() === "" ? null : msgInput.value;
      });
      const tokenReason = hasToken ? null : T.masters.noTokenSave;
      const disabled = saving || !!reason || !!tokenReason;
      help = html`<span class="yn-me-help">${fmt(T.masters.saveTargetTip, { project: cfg.gitlab.projectId, branch: cfg.gitlab.targetBranch })}${cfg.gitlab.commitMode === "mr" ? T.masters.modeMr : fmt(T.masters.modeDirect, { branch: cfg.gitlab.targetBranch })}</span><span class="yn-me-help">${T.masters.saveWho}</span><span class="yn-me-help">${T.masters.commitMessageHelp}</span>`;
      body = html`<div class="yn-me-save-body">
        ${data.gitAvailable ? null : html`<p class="yn-note yn-note-warn">${T.masters.noBaseWarning}</p>`}
        <div class="yn-me-field">
          <label for="yn-me-message">${T.masters.commitMessage}${cfg.gitlab.commitMode === "mr" ? T.masters.mrTitleSuffix : ""}</label>
          ${msgInput}
        </div>
        <p class="yn-me-actions">
          <button type="button" class="yn-btn yn-btn-primary" data-fk="save:submit" disabled=${disabled} aria-describedby="yn-me-save-reason" onclick=${() => doSave(msgInput.value)}>${cfg.gitlab.commitMode === "mr" ? T.masters.saveMr : T.masters.saveDirect}</button>
          <span id="yn-me-save-reason" class="yn-me-small">${reason ?? tokenReason ?? ""}${!reason && tokenReason ? html` <a href="./settings" data-fk="save:to-settings">${T.masters.toSettings}</a>` : null}</span>
        </p>
      </div>`;
    } else {
      help = html`<span class="yn-me-help">${configuredMode === "gitlab" || data.masterEdit.mode !== "download" ? T.masters.downloadLeadFallback : T.masters.downloadLead}</span>
        <ol class="yn-me-steps">
          <li>${T.masters.step1}</li>
          <li>${T.masters.step2a}${files.length ? files.map((id, i) => html`${i > 0 ? "、" : ""}<code>${MASTER_FILES[id].path}</code>`) : html`<code>data/masters/…</code>`}${T.masters.step2b}</li>
          <li class="yn-me-step-check">${T.masters.step3a}<strong>${T.masters.step3b}</strong>${T.masters.step3c}</li>
          <li>${T.masters.step4}</li>
          <li>${T.masters.step5}</li>
          <li>${T.masters.step6}</li>
        </ol>
        <span class="yn-me-help">${T.masters.downloadNote}</span>`;
      body = html`<div class="yn-me-save-body">
        ${configuredMode === "gitlab" ? html`<p class="yn-note yn-note-warn">${T.masters.fallbackDownload}</p>` : null}
        <div class="yn-me-downloads">
          ${files.map((id) => {
            const link = webFileUrl(cfg, data.files[id].repoPath ?? MASTER_FILES[id].path);
            return html`<p class="yn-me-dl-row">
              <button type="button" class="yn-btn yn-btn-primary yn-export" data-fk=${`dl:${id}`} disabled=${!!reason} onclick=${() => download(id)}>⤓ ${fileName(MASTER_FILES[id].path)} ${T.masters.downloadSuffix}</button>
              <span class="yn-me-small">${MASTER_FILES[id].label}: ${integer(diffMasterDoc(docs[id]).count)}${T.masters.changesSuffix}${downloaded.has(id) ? T.masters.downloaded : ""}</span>
              <span class="yn-me-small" data-base-commit=${id}>${bases[id].lastCommitId ? html`${T.masters.baseCommit} <code>${bases[id].lastCommitId.slice(0, 8)}</code>` : T.masters.noBaseCommit}</span>
              ${link ? html`<a href=${link} target="_blank" rel="noopener" class="yn-me-small">${T.masters.openInGitlab}</a>` : null}
            </p>`;
          })}
        </div>
        <p id="yn-me-save-reason" class="yn-me-small">${reason ?? ""}</p>
      </div>`;
    }
    const saveTitle = `${T.masters.saveTitle1}${mode === "gitlab" ? "GitLab" : T.masters.csvDownload}）`;
    parts.save.replaceChildren(html`<section class="yn-me-section yn-me-save" aria-labelledby="yn-me-save-title">
      <div class="yn-title-with-tip"><h2 id="yn-me-save-title" class="yn-section-title" tabindex="-1" data-fk="save:heading">${saveTitle}</h2>${infoTip(help, { label: fmt(T.layout.aboutSection, { title: saveTitle }) })}</div>
      ${otherPageNote()}
      ${body}
      ${renderOutcome()}
      <p class="yn-me-actions yn-me-discard">
        <button type="button" class="yn-btn" data-fk="save:discard" disabled=${totalChanges() === 0 || saving} onclick=${openDiscardDialog}>${T.masters.discardAllButton}</button>
        ${draftSavedAt ? html`<span class="yn-me-small">${T.masters.autosaved1}${dateTimeJst(draftSavedAt)}</span>` : null}
      </p>
    </section>`);
  }

  function renderAll() {
    root.dataset.mode = mode;
    // 下書きの復元／破棄を選ぶまでは編集させない（選ぶ前の編集は下書きに保存されず、再読み込みで消えるため）
    root.classList.toggle("is-locked", locked || !!pendingDraft);
    renderDraft();
    renderTabs();
    renderPanel();
    renderCheck();
    renderDiff();
    renderSave();
  }

  // 設定画面でトークンを登録して「戻る」で戻ったとき（ページがキャッシュから復元されたとき）は、保存の欄とマージ待ちを読み直す
  addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    renderSave();
    mrPanel.refresh();
  });
  root.append(mrPanel.el, parts.draft, parts.tabs, parts.panel, parts.check, parts.diff, parts.save, dialog, tooltip.el, cellEditor.el);
  renderAll();
  mrPanel.refresh();
  // 他の画面の検証の一覧から来たとき（?jump=ファイル:行番号）は、その行を見せる（§40）
  const jm = /^([a-z]+):(\d+)$/.exec(initialJump ?? "");
  if (jm && pageFiles.includes(jm[1])) {
    const fileId = jm[1];
    const row = Number(jm[2]);
    const issue = validation.issues.find((i) => i.fileId === fileId && i.row === row) ?? { fileId, row, rowId: docs[fileId].rows[row - 2]?.id ?? null };
    // 画面に入ってから（スクロールとフォーカスのため）
    requestAnimationFrame(() => revealIssue(issue));
  }
  return root;
}
