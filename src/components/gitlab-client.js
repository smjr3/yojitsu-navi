/**
 * GitLab 接続の画面側の共通部品（SPEC §26〜§29）
 *  - トークンの保存場所（既定はタブだけ = sessionStorage、「記憶する」なら localStorage）
 *  - 使う fetch（本物の GitLab / デモの模擬）
 *  - ヘッダーのマージ待ち件数バッジへの通知（header-badge.js が受け取る）
 */
import { createGitLabMock, DEMO_ROLE_KEY, DEMO_STORAGE_KEY } from "../core/gitlab-mock.js";

export const TOKEN_STORAGE_KEY = "yojitsu-navi:gitlab-token";
export const MR_COUNT_KEY = "yojitsu-navi:mr-count:v1";
export const MR_COUNT_EVENT = "yn-mr-count";

function store(kind) {
  try {
    return kind === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}
function get(kind, key) {
  try {
    return store(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function set(kind, key, value) {
  try {
    store(kind)?.setItem(key, value);
  } catch {
    /* 使えない環境では何もしない */
  }
}
function remove(kind, key) {
  try {
    store(kind)?.removeItem(key);
  } catch {
    /* 無視 */
  }
}

/** 登録済みのトークン（タブ → ブラウザの順に探す）。無ければ "" */
export function getToken() {
  return get("session", TOKEN_STORAGE_KEY) ?? get("local", TOKEN_STORAGE_KEY) ?? "";
}

/** このブラウザに記憶しているか */
export function tokenRemembered() {
  return get("session", TOKEN_STORAGE_KEY) === null && get("local", TOKEN_STORAGE_KEY) !== null;
}

/** トークンを登録する（remember = このブラウザに記憶） */
export function setToken(value, remember = false) {
  const v = String(value ?? "").trim();
  if (v === "") return;
  if (remember) {
    set("local", TOKEN_STORAGE_KEY, v);
    remove("session", TOKEN_STORAGE_KEY);
  } else {
    set("session", TOKEN_STORAGE_KEY, v);
    remove("local", TOKEN_STORAGE_KEY);
  }
  clearMrCount();
}

/** トークンを消す（タブ・ブラウザの両方） */
export function clearToken() {
  remove("session", TOKEN_STORAGE_KEY);
  remove("local", TOKEN_STORAGE_KEY);
  publishMrCount(null);
  // GitLab から読んだ配色の設定も使わない（§53）
  try {
    window.ynAppearance?.setGitlabUser(null);
  } catch {
    /* 無視 */
  }
}

/** デモ（§29）で「リーダーとして操作」しているか（既定 true） */
export function demoCanMerge() {
  return get("local", DEMO_ROLE_KEY) !== "member";
}
export function setDemoCanMerge(on) {
  set("local", DEMO_ROLE_KEY, on ? "leader" : "member");
}
export function resetDemo() {
  remove("local", DEMO_STORAGE_KEY);
  publishMrCount(0);
}

/**
 * GitLab を呼ぶ fetch。demo なら模擬（baseFiles = 本体のファイル: パス → {text, lastCommitId}）
 * @param {import("../core/types.js").MasterEditConfig} cfg
 */
export function gitlabFetch(cfg, baseFiles = {}) {
  if (cfg.mode === "demo") {
    return createGitLabMock({
      storage: { get: (k) => get("local", k), set: (k, v) => set("local", k, v) },
      baseFiles,
      canMerge: demoCanMerge,
      targetBranch: cfg.gitlab.targetBranch,
    });
  }
  return (url, init) => window.fetch(url, init);
}

/** マージ待ちの件数をヘッダーのバッジに伝える（null = 不明・出さない） */
export function publishMrCount(n) {
  if (n === null) remove("session", MR_COUNT_KEY);
  else set("session", MR_COUNT_KEY, JSON.stringify({ n, at: Date.now() }));
  try {
    window.dispatchEvent(new CustomEvent(MR_COUNT_EVENT, { detail: n }));
  } catch {
    /* 無視 */
  }
}
function clearMrCount() {
  remove("session", MR_COUNT_KEY);
  try {
    window.dispatchEvent(new CustomEvent(MR_COUNT_EVENT, { detail: undefined }));
  } catch {
    /* 無視 */
  }
}
