/**
 * 今月の残り時間（SPEC §113）
 *  - myHoursCard: 残り・計画・実績と案件ごとの表（メンバー詳細とヘッダー右上の吹き出しで共用）
 *  - runMyHours: ヘッダー右上の「今月の残り」ボタン。GitLab のトークンの持ち主（GET /user の username）を data/my-month.json で探して出す
 *
 * observablehq.config.js が myHoursScript() の文字列を全ページの <head> に埋め込む（トークンは埋め込まない）。
 * runMyHours・myHoursCard はその場で文字列化して実行するので、外の変数・import を参照しないこと（header-badge.js と同じ）。
 */

/**
 * 残り時間のカード
 * @param {Document} doc
 * @param {{ name?: string, memberHref?: string, rows: Array<{ label: string, sub?: string, plannedHours: number, actualHours: number }> }} data
 * @param {Record<string, string>} L 文言（T.myHours）
 */
export function myHoursCard(doc, data, L) {
  var nf = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 });
  function hours(n) {
    return nf.format(Math.round(n * 100) / 100) + "h";
  }
  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function remainText(r) {
    return r < 0 ? L.over.replace("{hours}", hours(-r)) : L.remaining.replace("{hours}", hours(r));
  }
  var rows = data.rows || [];
  var planned = 0;
  var actual = 0;
  for (var i = 0; i < rows.length; i++) {
    planned += rows[i].plannedHours;
    actual += rows[i].actualHours;
  }
  var remaining = Math.round((planned - actual) * 100) / 100;
  var card = el("section", "yn-my-hours-card");
  var main = el("div", "yn-my-hours-main");
  if (data.name) {
    var who = el("div", "yn-my-hours-who");
    who.appendChild(el("span", "yn-my-hours-title", L.title));
    who.appendChild(el("span", "yn-my-hours-name", data.name));
    main.appendChild(who);
  }
  var big = el("div", "yn-my-hours-big" + (remaining < 0 ? " is-over" : ""), remainText(remaining));
  main.appendChild(big);
  // 計画に対する実績の割合。超えたら、計画の分（橙）と超えた分（赤）に分けて全体を実績にする
  var bar = el("div", "yn-my-hours-bar" + (remaining < 0 ? " is-over" : ""));
  bar.setAttribute("aria-hidden", "true");
  var used = el("i", "yn-my-hours-bar-used");
  if (remaining < 0) {
    used.style.width = (actual > 0 ? (planned / actual) * 100 : 0) + "%";
    var over = el("i", "yn-my-hours-bar-over");
    over.style.width = (actual > 0 ? ((actual - planned) / actual) * 100 : 0) + "%";
    bar.appendChild(used);
    bar.appendChild(over);
  } else {
    used.style.width = (planned > 0 ? Math.min(100, (actual / planned) * 100) : 0) + "%";
    bar.appendChild(used);
  }
  main.appendChild(bar);
  main.appendChild(el("div", "yn-my-hours-sub", L.sub.replace("{planned}", hours(planned)).replace("{actual}", hours(actual))));
  card.appendChild(main);
  if (rows.length > 0) {
    var wrap = el("div", "yn-my-hours-table-wrap");
    var table = el("table", "yn-my-hours-table");
    var cap = el("caption", "visually-hidden", L.caption);
    table.appendChild(cap);
    var thead = el("thead");
    var hr = el("tr");
    var heads = [L.colProject, L.colPlanned, L.colActual, L.colRemaining];
    for (var h = 0; h < heads.length; h++) {
      var th = el("th", h === 0 ? "" : "is-num", heads[h]);
      th.setAttribute("scope", "col");
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = el("tbody");
    for (var k = 0; k < rows.length; k++) {
      var r = rows[k];
      var rem = Math.round((r.plannedHours - r.actualHours) * 100) / 100;
      var tr = el("tr");
      // 名前の下に顧客名（運用保守以外は「運用保守以外」）。リソース計画の作業の行と同じ書き方
      var name = el("td", "yn-my-hours-project");
      name.appendChild(el("span", "yn-my-hours-project-name", r.label));
      if (r.sub) name.appendChild(el("span", "yn-my-hours-project-sub", r.sub));
      name.title = r.sub ? r.label + "（" + r.sub + "）" : r.label;
      tr.appendChild(name);
      tr.appendChild(el("td", "is-num", hours(r.plannedHours)));
      tr.appendChild(el("td", "is-num", hours(r.actualHours)));
      tr.appendChild(el("td", "is-num" + (rem < 0 ? " is-over" : ""), rem < 0 ? L.overCell.replace("{hours}", hours(-rem)) : hours(rem)));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);
  } else {
    card.appendChild(el("p", "yn-my-hours-empty", L.noPlan));
  }
  if (data.memberHref) {
    var a = el("a", "yn-my-hours-link", L.toMember);
    a.href = data.memberHref;
    card.appendChild(a);
  }
  return card;
}

/**
 * ヘッダー右上の「今月の残り」（ブラウザで実行。w = window、card = myHoursCard）
 * @param {{ enabled: boolean, demo: boolean, api: string, demoUser: string, labels: Record<string, string> }} cfg
 */
export function runMyHours(cfg, w, card) {
  var KEY_TOKEN = "yojitsu-navi:gitlab-token";
  var KEY_ME = "yojitsu-navi:gitlab-me:v1";
  var TTL = 3600000;
  var doc = w.document;
  var L = cfg.labels;
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
  if (!cfg.enabled || typeof w.fetch !== "function") return;
  function readToken() {
    return sget("sessionStorage", KEY_TOKEN) || sget("localStorage", KEY_TOKEN) || "";
  }
  // トークンそのものは覚えない。末尾と長さだけで見分ける（替わったらユーザー名を読み直す）
  function markOf(t) {
    return t ? t.length + ":" + t.slice(-4) : "";
  }
  function norm(u) {
    return String(u || "")
      .trim()
      .replace(/^@+/, "")
      .toLowerCase();
  }
  function username(token) {
    if (cfg.demo) return Promise.resolve(norm(cfg.demoUser));
    var mark = markOf(token);
    try {
      var c = JSON.parse(sget("localStorage", KEY_ME) || "null");
      if (c && c.t === mark && Date.now() - Number(c.at) < TTL && typeof c.u === "string") return Promise.resolve(c.u);
    } catch (e) {
      /* 読み直す */
    }
    if (!cfg.api) return Promise.resolve("");
    return w
      .fetch(cfg.api + "/user", { headers: { "PRIVATE-TOKEN": token, Accept: "application/json" } })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (u) {
        var name = u && typeof u.username === "string" ? norm(u.username) : "";
        if (name) sset("localStorage", KEY_ME, JSON.stringify({ u: name, t: mark, at: Date.now() }));
        return name;
      });
  }
  // ビルド済みサイトは data/my-month.json、開発プレビュー（npm run dev）は _file/data/my-month.json
  var dataPromise = null;
  function data() {
    if (dataPromise) return dataPromise;
    var urls = [new w.URL("data/my-month.json", w.location.href).href, new w.URL("_file/data/my-month.json", w.location.href).href];
    function next(i) {
      if (i >= urls.length) return Promise.resolve(null);
      return w.fetch(urls[i], { cache: "no-cache" }).then(function (r) {
        return r.ok ? r.json() : r.status === 404 ? next(i + 1) : null;
      });
    }
    dataPromise = next(0).catch(function () {
      dataPromise = null;
      return null;
    });
    return dataPromise;
  }
  // 今月 = 開いた人の今日（日本時間）の月。基準日を固定したデータ（デモ・テスト）はその月（§75）
  function monthOf(d) {
    var today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    var asOf = typeof d.asOf === "string" ? d.asOf : "";
    return (d.asOfFixed || today < asOf ? asOf : today).slice(0, 7);
  }
  // 今出しているボタン（無ければ null）と、出したときのトークン
  var shown = null;
  var shownMark = "";
  var seq = 0;
  function unmount() {
    if (shown && shown.wrap.parentNode) shown.wrap.parentNode.removeChild(shown.wrap);
    shown = null;
    var bar = doc.querySelector(".yn-topbar");
    if (bar) bar.classList.remove("has-my-hours");
  }
  function mount(d, user) {
    var month = monthOf(d);
    // ユーザー名 → 社員番号は月ごと（月が替わって付け替えたときも、その月の持ち主を出す）
    var users = d && d.users ? d.users[month] : null;
    var id = users ? users[user] : null;
    var m = id && d.members ? d.members[id] : null;
    var rows = m && m.months ? m.months[month] : null;
    if (!rows) return;
    var tools = doc.querySelector(".yn-tools");
    if (!tools) return;
    var planned = 0;
    var actual = 0;
    for (var i = 0; i < rows.length; i++) {
      planned += rows[i].plannedHours;
      actual += rows[i].actualHours;
    }
    var rem = Math.round((planned - actual) * 100) / 100;
    var nf = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 });
    var value = nf.format(Math.abs(rem)) + "h";
    var wrap = doc.createElement("span");
    wrap.className = "yn-my-hours";
    var btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "yn-my-hours-btn" + (rem < 0 ? " is-over" : "");
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "yn-my-hours-pop");
    var lab = doc.createElement("span");
    lab.className = "yn-my-hours-btn-label";
    lab.textContent = rem < 0 ? L.chipOver : L.chip;
    var val = doc.createElement("b");
    val.textContent = value;
    btn.appendChild(lab);
    btn.appendChild(val);
    var pop = doc.createElement("div");
    pop.className = "yn-my-hours-pop";
    pop.id = "yn-my-hours-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", L.title);
    pop.hidden = true;
    pop.appendChild(card(doc, { name: m.name, memberHref: "./member?id=" + encodeURIComponent(id), rows: rows }, L));
    wrap.appendChild(btn);
    wrap.appendChild(pop);
    tools.insertBefore(wrap, tools.firstChild);
    var bar = doc.querySelector(".yn-topbar");
    if (bar) bar.classList.add("has-my-hours");
    btn.addEventListener("click", function () {
      open(pop.hidden);
    });
    shown = { wrap: wrap, btn: btn, pop: pop };
  }
  function open(on) {
    if (!shown) return;
    if (on) shown.pop.style.setProperty("--yn-my-hours-top", Math.round(shown.btn.getBoundingClientRect().bottom + 8) + "px");
    shown.pop.hidden = !on;
    shown.btn.setAttribute("aria-expanded", on ? "true" : "false");
  }
  doc.addEventListener("click", function (e) {
    if (shown && !shown.pop.hidden && !shown.wrap.contains(e.target)) open(false);
  });
  doc.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && shown && !shown.pop.hidden) {
      open(false);
      shown.btn.focus();
    }
  });
  function start() {
    var token = readToken();
    var mark = markOf(token);
    var my = ++seq;
    unmount();
    shownMark = mark;
    if (!token) return;
    Promise.all([username(token), data()])
      .then(function (res) {
        // 待つ間にトークンが替わったら、古い結果は出さない
        if (my === seq && res[0] && res[1]) mount(res[1], res[0]);
      })
      .catch(function () {
        /* 出せなければ何も出さない */
      });
  }
  // 設定画面でトークンを登録・削除したら（gitlab-client.js の setToken / clearToken が yn-mr-count を送る）、出し直す・消す
  w.addEventListener("yn-mr-count", function () {
    if (markOf(readToken()) !== shownMark) start();
  });
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start);
  else start();
}

/** デモ（§29）のユーザー名。core/gitlab-mock.ts の DEMO_USER と同じ（tests/unit/my-hours.test.ts で確認） */
export const DEMO_USERNAME = "demo-user";

/** config.json の masterEdit → ボタンの設定（マスタ編集の保存先と同じ GitLab。download は GitLab を使わないので出さない） */
export function myHoursConfig(masterEdit, labels) {
  var me = masterEdit && typeof masterEdit === "object" ? masterEdit : {};
  var g = me.gitlab && typeof me.gitlab === "object" ? me.gitlab : {};
  var mode = me.mode === "download" || me.mode === "demo" ? me.mode : "gitlab";
  var api = typeof g.apiBaseUrl === "string" ? g.apiBaseUrl.trim().replace(/\/+$/, "") : "";
  return { enabled: mode === "demo" || (mode === "gitlab" && api !== ""), demo: mode === "demo", api: mode === "gitlab" ? api : "", demoUser: DEMO_USERNAME, labels: labels };
}

/** <head> に埋め込むスクリプト（E2E は window.__YN_MY_HOURS_CONFIG__ で接続先を差し替える。文言はそのまま） */
export function myHoursScript(cfg) {
  return `(${runMyHours.toString()})(Object.assign(${JSON.stringify(cfg).replace(/</g, "\\u003c")}, window.__YN_MY_HOURS_CONFIG__ || {}), window, ${myHoursCard.toString()});`;
}
