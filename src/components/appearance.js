/**
 * 配色（SPEC §52）: 表示モード（ライト／ダーク）と差し色
 *
 * 決め方（上から順に、決まったものを使う）
 *   表示モード: 設定画面で選んだライト／ダーク → GitLab（旧ダークテーマ・API が返す場合のカラーモード）→ PC（OS）の設定 → ライト
 *   （GitLab の GET /user は現行版でカラーモードを返さないので、多くの場合は PC の設定に合わせることになる）
 *   差し色:     設定画面で選んだ色 → GitLab のユーザー設定（テーマ）→ 既定（ブルー）
 * GitLab の設定は「接続を確認」と、トークンがあるときのページ表示（1 時間に 1 回）で GET /user から読み、localStorage に置く。
 *
 * observablehq.config.js が appearanceScript() の文字列を全ページの <head> に埋め込み、描画前に <html data-theme data-accent> を決める。
 * runAppearance・lookFromGitlab はその場で文字列化して実行するので、外の変数・import を参照しないこと。
 */

export const THEME_KEY = "yn-theme";
export const ACCENT_KEY = "yn-accent";
export const GITLAB_LOOK_KEY = "yojitsu-navi:gitlab-look:v1";
export const THEME_PREFS = ["auto", "light", "dark"];
/** 差し色（色の値は style.css の :root[data-accent]） */
export const ACCENTS = ["blue", "indigo", "green", "red", "gray"];
export const DEFAULT_ACCENT = "blue";

/**
 * GitLab の GET /user → { mode, accent }（決まらない項目は null）
 *  color_mode_id: 1 ライト / 2 ダーク / 3 自動。現行の GitLab の API は返さない（UserPublic に無い）が、返す版があれば使う。
 *  古い GitLab のダークテーマ theme_id 11 はダーク
 *  theme_id: 1 Indigo / 6 Light Indigo / 4 Blue / 7 Light Blue / 5 Green / 8 Light Green / 9 Red / 10 Light Red / 2 Gray / 3 Light Gray
 */
export function lookFromGitlab(u) {
  var o = u && typeof u === "object" ? u : {};
  var THEMES = { 1: "indigo", 6: "indigo", 4: "blue", 7: "blue", 5: "green", 8: "green", 9: "red", 10: "red", 2: "gray", 3: "gray" };
  var MODES = { 1: "light", 2: "dark", 3: "auto" };
  var theme = Number(o.theme_id);
  var mode = MODES[Number(o.color_mode_id)] || (theme === 11 ? "dark" : null);
  return { mode: mode, accent: THEMES[theme] || null };
}

/**
 * 使う配色を決める
 * @param {{ theme: string|null, accent: string|null, gitlab: {mode?: string|null, accent?: string|null}|null, osDark: boolean }} s
 * @returns {{ theme: "light"|"dark", accent: string, themeFrom: "app"|"gitlab"|"os", accentFrom: "app"|"gitlab"|"default" }}
 */
export function resolveLook(s) {
  var ACC = ["blue", "indigo", "green", "red", "gray"];
  var g = s.gitlab || {};
  var t = s.theme === "light" || s.theme === "dark" ? s.theme : null;
  var gm = g.mode === "light" || g.mode === "dark" ? g.mode : null;
  var a = ACC.indexOf(s.accent) >= 0 ? s.accent : null;
  var ga = ACC.indexOf(g.accent) >= 0 ? g.accent : null;
  return {
    theme: t || gm || (s.osDark ? "dark" : "light"),
    accent: a || ga || "blue",
    themeFrom: t ? "app" : gm ? "gitlab" : "os",
    accentFrom: a ? "app" : ga ? "gitlab" : "default",
  };
}

/** 描画前に配色を当て、設定画面が使う window.ynAppearance を用意する（ブラウザで実行。w = window） */
export function runAppearance(fromGitlab, resolve, cfg, w) {
  var ACC = ["blue", "indigo", "green", "red", "gray"];
  var TTL = 3600000;
  var root = w.document && w.document.documentElement;
  function lget(key) {
    try {
      return w.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }
  function lset(key, value) {
    try {
      if (value === null) w.localStorage.removeItem(key);
      else w.localStorage.setItem(key, value);
    } catch (e) {
      /* 使えない環境では今のページだけ */
    }
  }
  function osDark() {
    try {
      return !!w.matchMedia && w.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch (e) {
      return false;
    }
  }
  function cached() {
    try {
      var c = JSON.parse(lget("yojitsu-navi:gitlab-look:v1") || "null");
      return c && typeof c === "object" ? c : null;
    } catch (e) {
      return null;
    }
  }
  // GitLab のトークン（無ければ GitLab の設定は使わない。タブを閉じてトークンが消えたら PC の設定・既定の色に戻る）
  var token = "";
  try {
    token = w.sessionStorage.getItem("yojitsu-navi:gitlab-token") || "";
  } catch (e) {
    /* 無視 */
  }
  if (!token) token = lget("yojitsu-navi:gitlab-token") || "";
  // 状態（ストレージが使えないときもページ内では切り替わるよう、選んだ値を持っておく）
  var pref = { theme: lget("yn-theme"), accent: lget("yn-accent") };
  var mem = { gitlab: token ? cached() : null };
  function state() {
    return { theme: pref.theme, accent: pref.accent, gitlab: mem.gitlab, osDark: osDark() };
  }
  var current = null;
  function apply(notify) {
    var r = resolve(state());
    current = r;
    if (root) {
      root.dataset.theme = r.theme;
      root.dataset.accent = r.accent;
    }
    if (notify) {
      try {
        w.dispatchEvent(new w.CustomEvent("yn-theme", { detail: r.theme }));
      } catch (e) {
        /* 無視 */
      }
    }
    return r;
  }
  var api = {
    get: function () {
      var r = current || resolve(state());
      return {
        theme: r.theme,
        accent: r.accent,
        themeFrom: r.themeFrom,
        accentFrom: r.accentFrom,
        themePref: pref.theme === "light" || pref.theme === "dark" ? pref.theme : "auto",
        accentPref: ACC.indexOf(pref.accent) >= 0 ? pref.accent : "auto",
        // 「自動」を選んだときの配色（設定画面のラベル用）
        auto: resolve({ theme: null, accent: null, gitlab: mem.gitlab, osDark: osDark() }),
      };
    },
    setTheme: function (t) {
      pref.theme = t === "light" || t === "dark" ? t : "auto";
      lset("yn-theme", pref.theme);
      apply(true);
    },
    setAccent: function (a) {
      pref.accent = ACC.indexOf(a) >= 0 ? a : "auto";
      lset("yn-accent", pref.accent);
      apply(true);
    },
    /** GitLab の GET /user の結果（null = 接続をやめた） */
    setGitlabUser: function (u) {
      mem.gitlab = u ? fromGitlab(u) : null;
      if (mem.gitlab) mem.gitlab.at = Date.now();
      lset("yojitsu-navi:gitlab-look:v1", mem.gitlab ? JSON.stringify(mem.gitlab) : null);
      apply(true);
    },
  };
  w.ynAppearance = api;
  // 互換: 以前の設定画面・テストが使う
  w.ynSetTheme = api.setTheme;
  apply(false);
  if (w.document) w.document.addEventListener("DOMContentLoaded", function () { apply(false); });
  // PC の設定が変わったら追従する（自動のとき）
  try {
    var mq = w.matchMedia && w.matchMedia("(prefers-color-scheme: dark)");
    if (mq && mq.addEventListener) mq.addEventListener("change", function () { apply(true); });
  } catch (e) {
    /* 無視 */
  }
  // GitLab の設定を読み直す（本物の GitLab に接続済みのときだけ。デモは「接続を確認」で読む）
  if (cfg && cfg.api && token && w.fetch && !(mem.gitlab && Date.now() - Number(mem.gitlab.at) < TTL)) {
    w.fetch(cfg.api + "/user", { headers: { "PRIVATE-TOKEN": token } })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (u) {
        if (u) api.setGitlabUser(u);
      })
      .catch(function () {
        /* 読めなければ前の値のまま */
      });
  }
}
/** config.json の masterEdit → GitLab の設定を読む先（本物の GitLab に接続する設定のときだけ） */
export function appearanceConfig(masterEdit) {
  var me = masterEdit && typeof masterEdit === "object" ? masterEdit : {};
  var g = me.gitlab && typeof me.gitlab === "object" ? me.gitlab : {};
  var mode = me.mode === "download" || me.mode === "demo" ? me.mode : "gitlab";
  var api = typeof g.apiBaseUrl === "string" ? g.apiBaseUrl.trim().replace(/\/+$/, "") : "";
  return { api: mode === "gitlab" ? api : "" };
}

export function appearanceScript(cfg) {
  return `(${runAppearance.toString()})(${lookFromGitlab.toString()}, ${resolveLook.toString()}, ${JSON.stringify(cfg).replace(/</g, "\\u003c")}, window);`;
}
