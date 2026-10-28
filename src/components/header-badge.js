/**
 * ヘッダーの「マスタ編集」のマージ待ち件数バッジ（SPEC §27）
 *
 * observablehq.config.js が、ビルド時の config.json の masterEdit から badgeConfig() を作り、
 * mrBadgeScript() の文字列を全ページの <head> に埋め込む（トークンは埋め込まない）。
 * runMrBadge はその場で文字列化して実行するので、外の変数・import を参照しないこと。
 * キー名・デモの接続先は gitlab-client.js / core/gitlab.ts / core/gitlab-mock.ts と同じ（tests/unit/header-badge.test.ts で確認）。
 */

/** config.json の masterEdit → バッジの設定 */
export function badgeConfig(masterEdit, label) {
  const me = masterEdit && typeof masterEdit === "object" ? masterEdit : {};
  const g = me.gitlab && typeof me.gitlab === "object" ? me.gitlab : {};
  const mode = me.mode === "download" || me.mode === "demo" ? me.mode : "gitlab";
  const api = typeof g.apiBaseUrl === "string" ? g.apiBaseUrl.trim().replace(/\/+$/, "") : "";
  const projectId = typeof g.projectId === "string" || typeof g.projectId === "number" ? String(g.projectId).trim() : "";
  const targetBranch = typeof g.targetBranch === "string" && g.targetBranch.trim() !== "" ? g.targetBranch.trim() : "main";
  return {
    enabled: mode === "demo" || (mode === "gitlab" && api !== "" && projectId !== ""),
    demo: mode === "demo",
    api,
    projectId,
    targetBranch,
    label,
  };
}

/** バッジを描く・取得する（ブラウザで実行。w = window） */
export function runMrBadge(cfg, w) {
  var KEY_TOKEN = "yojitsu-navi:gitlab-token";
  var KEY_COUNT = "yojitsu-navi:mr-count:v1";
  var KEY_DEMO = "yojitsu-navi:gitlab-demo:v1";
  var TTL = 60000;
  var doc = w.document;
  function sget(kind, key) {
    try {
      return w[kind].getItem(key);
    } catch (e) {
      return null;
    }
  }
  function sset(kind, key, value) {
    try {
      w[kind].setItem(key, value);
    } catch (e) {
      /* 無視 */
    }
  }
  function render(n) {
    var els = doc.querySelectorAll(".yn-mr-badge");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var show = typeof n === "number" && n > 0;
      el.hidden = !show;
      var num = el.querySelector(".yn-mr-badge-n");
      var sr = el.querySelector(".yn-mr-badge-sr");
      if (num) num.textContent = show ? String(n > 99 ? "99+" : n) : "";
      if (sr) sr.textContent = show ? cfg.label.replace("{n}", String(n)) : "";
    }
  }
  function token() {
    return sget("sessionStorage", KEY_TOKEN) || sget("localStorage", KEY_TOKEN) || "";
  }
  function isMaster(m) {
    return !!m && typeof m.source_branch === "string" && m.source_branch.indexOf("masters/") === 0 && m.target_branch === cfg.targetBranch && m.state === "opened";
  }
  function done(n) {
    sset("sessionStorage", KEY_COUNT, JSON.stringify({ n: n, at: Date.now() }));
    render(n);
  }
  function load(force) {
    if (!cfg.enabled || !token()) return render(0);
    if (!force) {
      try {
        var c = JSON.parse(sget("sessionStorage", KEY_COUNT) || "null");
        if (c && typeof c.n === "number" && Date.now() - c.at < TTL) return render(c.n);
      } catch (e) {
        /* 読み直す */
      }
    }
    if (cfg.demo) {
      var n = 0;
      try {
        var s = JSON.parse(sget("localStorage", KEY_DEMO) || "null");
        if (s && s.mrs && s.mrs.filter) n = s.mrs.filter(isMaster).length;
      } catch (e) {
        n = 0;
      }
      return done(n);
    }
    if (typeof w.fetch !== "function") return render(0);
    var url = cfg.api + "/projects/" + encodeURIComponent(cfg.projectId) + "/merge_requests?state=opened&target_branch=" + encodeURIComponent(cfg.targetBranch) + "&per_page=100";
    w.fetch(url, { headers: { "PRIVATE-TOKEN": token(), Accept: "application/json" } })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (list) {
        if (!list || !list.filter) return render(0);
        done(list.filter(isMaster).length);
      })
      .catch(function () {
        render(0);
      });
  }
  // マスタ編集・設定画面からの通知: 数 = そのまま出す、null = 消す、それ以外 = 読み直す
  w.addEventListener("yn-mr-count", function (e) {
    if (typeof e.detail === "number") render(e.detail);
    else if (e.detail === null) render(0);
    else load(true);
  });
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", function () { load(false); });
  else load(false);
}

/** <head> に埋め込むスクリプト（E2E は window.__YN_BADGE_CONFIG__ で接続先を差し替える） */
export function mrBadgeScript(cfg) {
  return `(${runMrBadge.toString()})(window.__YN_BADGE_CONFIG__ || ${JSON.stringify(cfg).replace(/</g, "\\u003c")}, window);`;
}
