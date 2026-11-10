/**
 * 画面状態（期間・チーム・単位・着地方式）⇄ URL クエリ ⇄ localStorage
 *
 * 優先順位: URL クエリ（共有された表示を再現） > localStorage（前回の表示） > 既定値。
 * 変更すると URL（history.replaceState）と localStorage の両方に書き戻す。
 *
 * クエリ:  ?from=2026-04&to=2027-03&team=T111&unit=m&method=assignment
 *   from/to  YYYY-MM（meta.minMonth〜maxMonth に収める）
 *   team     チームID / "" = 全体 / "__unassigned__" = 未設定
 *   unit     m（百万円）| k（千円）| yen
 *   method   assignment | recent3 | all
 *   outside  1 = 契約外を含む（メンバー別の計画・実績。§50.4）。0（既定）は URL に書かない
 */
import { UNITS, fromCoreUnit } from "./format.js";
import { T, fmt } from "../i18n/index.js";
import { UNASSIGNED_TEAM_ID, addMonths, isValidYearMonth, fiscalYearMonths, fiscalYearOf } from "../core/index.js";

export const STATE_KEYS = ["from", "to", "team", "unit", "method", "outside"];
// v2: 既定の単位を百万円に変えたとき、以前の既定（円）が保存値として残らないように切り替えた
export const STORAGE_KEY = "yojitsu-navi:state:v2";
const METHODS = ["assignment", "recent3", "all"];
const UNIT_IDS = UNITS.map((u) => u.id);

function clampMonth(m, min, max) {
  if (m < min) return min;
  if (m > max) return max;
  return m;
}

/** 既定の期間 = asOf の年度を、データの範囲に収めたもの */
export function defaultPeriod(model) {
  const { meta } = model;
  const fy = meta.fiscalYearMonths;
  const from = clampMonth(fy[0], meta.minMonth, meta.maxMonth);
  const to = clampMonth(fy[fy.length - 1], meta.minMonth, meta.maxMonth);
  return from <= to ? { from, to } : { from: meta.minMonth, to: meta.maxMonth };
}

export function defaultState(model) {
  const p = defaultPeriod(model);
  return {
    from: p.from,
    to: p.to,
    team: "",
    unit: fromCoreUnit(model.config.currency?.defaultUnit),
    method: METHODS.includes(model.config.forecastMethodDefault) ? model.config.forecastMethodDefault : "assignment",
    outside: "0",
  };
}

/** 期間プリセット（今年度 / 今月 / 先月 / 今後3か月 / 直近12か月 / 前年度）。今月 = 基準日（asOf）の月、先月はその前の月、今後3か月は今月から 2 か月先まで。データ範囲に収めて返す */
export function periodPresets(model) {
  const { meta, config } = model;
  const start = config.fiscalYearStartMonth;
  const fy = meta.fiscalYear;
  const clip = (months) => {
    const from = clampMonth(months[0], meta.minMonth, meta.maxMonth);
    const to = clampMonth(months[months.length - 1], meta.minMonth, meta.maxMonth);
    return { from, to };
  };
  const thisFy = fiscalYearMonths(fy, start);
  const prevFy = fiscalYearMonths(fy - 1, start);
  const recent = (n) => [addMonths(meta.asOfMonth, -(n - 1)), meta.asOfMonth];
  return [
    { id: "fy", label: fmt(T.filters.presets.fy, { fy }), short: T.filters.presets.fyShort, period: clip(thisFy) },
    { id: "thisMonth", label: T.filters.presets.thisMonth, period: clip(recent(1)) },
    { id: "lastMonth", label: T.filters.presets.lastMonth, period: clip([addMonths(meta.asOfMonth, -1), addMonths(meta.asOfMonth, -1)]) },
    { id: "next3", label: T.filters.presets.next3, period: clip([meta.asOfMonth, addMonths(meta.asOfMonth, 2)]) },
    { id: "recent12", label: T.filters.presets.recent12, period: clip(recent(12)) },
    // 前年度は見る頻度が低いので右端に置く
    { id: "prevFy", label: fmt(T.filters.presets.prevFy, { fy: fy - 1 }), short: T.filters.presets.prevFyShort, period: clip(prevFy) },
  ];
}

/** 値の検証。不正な値は既定に戻す */
export function sanitize(model, raw) {
  const d = defaultState(model);
  const { meta } = model;
  const out = { ...d };
  if (isValidYearMonth(raw.from)) out.from = clampMonth(raw.from, meta.minMonth, meta.maxMonth);
  if (isValidYearMonth(raw.to)) out.to = clampMonth(raw.to, meta.minMonth, meta.maxMonth);
  if (out.from > out.to) [out.from, out.to] = [out.to, out.from];
  if (typeof raw.team === "string") {
    const t = raw.team;
    const known = t === "" || t === UNASSIGNED_TEAM_ID || (model.teamTree && Object.hasOwn(model.teamTree, t)) || model.teams.some((r) => r.teamId === t);
    out.team = known ? t : "";
  }
  if (UNIT_IDS.includes(raw.unit)) out.unit = raw.unit;
  if (METHODS.includes(raw.method)) out.method = raw.method;
  if (raw.outside === "1" || raw.outside === 1 || raw.outside === true) out.outside = "1";
  return out;
}

function readQuery() {
  const q = new URLSearchParams(location.search);
  const raw = {};
  let any = false;
  for (const k of STATE_KEYS) {
    if (q.has(k)) {
      raw[k] = q.get(k);
      any = true;
    }
  }
  return any ? raw : null;
}

function readStorage() {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return null;
    const obj = JSON.parse(text);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

function writeStorage(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* プライベートモード等では無視 */
  }
}

/** 既定のときは URL に書かない値（契約外を含まない） */
const isDefaultHidden = (k, v) => k === "outside" && v !== "1";

function writeQuery(state) {
  const url = new URL(location.href);
  for (const k of STATE_KEYS) {
    if (isDefaultHidden(k, state[k])) url.searchParams.delete(k);
    else url.searchParams.set(k, state[k]);
  }
  history.replaceState(history.state, "", url);
}

/**
 * ストアを作る。
 *   store.get()            現在の状態
 *   store.set({to: "..."}) 一部を更新（URL と localStorage に反映し購読者へ通知）
 *   store.subscribe(fn)    変更通知。戻り値で解除
 *   store.href(path, patch) 状態を引き継いだリンク（別ページへの遷移用）
 */
export function createStore(model, options = {}) {
  const fromQuery = readQuery();
  const fromStorage = readStorage();
  let state = sanitize(model, { ...(fromStorage ?? {}), ...(fromQuery ?? {}), ...(options.initial ?? {}) });
  const listeners = new Set();
  // 初回も URL を正規化しておく（共有しやすい）
  if (options.syncUrl !== false) writeQuery(state);
  // 先読み（SPEC §108）で裏で作っている間は保存先に書かない（表示されたときに書く。元の画面の状態を古い値で上書きしない）
  if (typeof document !== "undefined" && document.prerendering) document.addEventListener("prerenderingchange", () => writeStorage(state), { once: true });
  else writeStorage(state);

  const notify = () => {
    for (const fn of [...listeners]) fn(state);
  };

  return {
    model,
    get: () => state,
    set(patch) {
      const next = sanitize(model, { ...state, ...patch });
      if (STATE_KEYS.every((k) => next[k] === state[k])) return;
      state = next;
      if (options.syncUrl !== false) writeQuery(state);
      writeStorage(state);
      notify();
    },
    setPeriod(period) {
      this.set({ from: period.from, to: period.to });
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    href(path, patch = {}, extra = {}) {
      return buildHref(path, { ...state, ...patch }, extra);
    },
  };
}

/** 保存してある表示条件（URL・保存先は書き換えない。リソース計画の変更の影響 §65 で期間・単位を引き継ぐ） */
export function savedState(model) {
  return sanitize(model, readStorage() ?? {});
}

/** 状態を引き継いだ相対リンク。path は "./contracts" のようにページ名 */
export function buildHref(path, state, extra = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  for (const k of STATE_KEYS) if (state && state[k] !== undefined && !isDefaultHidden(k, state[k])) q.set(k, state[k]);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** 現在の期間 */
export function periodOf(state) {
  return { from: state.from, to: state.to };
}

/** 状態からその期間の年度ラベル（期間が年度と一致するときのみ） */
export function periodFiscalYear(model, period) {
  const start = model.config.fiscalYearStartMonth;
  const fy = fiscalYearOf(period.from, start);
  const months = fiscalYearMonths(fy, start);
  return months[0] === period.from && months[months.length - 1] === period.to ? fy : null;
}
