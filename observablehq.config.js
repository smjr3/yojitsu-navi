// Observable Framework 設定
// https://observablehq.com/framework/config
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { worklogKey } from "./src/components/worklog-key.js";

/** UTF-8（BOM 可）で読めなければ Shift_JIS（scripts/lib/encoding.ts の decodeAuto と同じ判定） */
function decode(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\ufeff/, "");
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

/** 引用符（"…"、"" はエスケープ）・セル内のカンマ・改行に対応した最小限の CSV 分解 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}
import ja from "./src/i18n/ja.js";
import { badgeConfig, mrBadgeScript } from "./src/components/header-badge.js";
import { appearanceConfig, appearanceScript } from "./src/components/appearance.js";
import { withGitLabEnv } from "./src/components/gitlab-env.js";
import { faviconLink } from "./src/components/favicon.js";

/** config.json の masterEdit（ヘッダーのマージ待ち件数バッジの接続先。§27・§39.1）。読めなければ空 */
function masterEditConfig() {
  try {
    // 接続先が空なら GitLab CI の値で補う（§39.1。マスタ編集画面と同じ）
    return withGitLabEnv(JSON.parse(decode(readFileSync(new URL("./config.json", import.meta.url)))).masterEdit ?? null, process.env);
  } catch {
    return null;
  }
}

/** data/contracts.csv の契約ID（作業ログ明細の動的パス用）。読めなければ空 */
function contractIds() {
  try {
    const rows = parseCsv(decode(readFileSync(new URL("./data/contracts.csv", import.meta.url))));
    const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
    const idx = Math.max(0, header.indexOf("contract_id"));
    const ids = new Set();
    for (const row of rows.slice(1)) {
      const id = (row[idx] ?? "").trim();
      if (id !== "") ids.add(id);
    }
    return [...ids];
  } catch {
    return [];
  }
}

/**
 * 上部ナビゲーション（左サイドバーは使わない）。
 * NAV = 画面の切り替えタブ、TOOLS = 右上の業務リンク、MORE = 右端「その他」（⋯）のメニューに入れる控えめなリンク。
 * match はタブを選択状態にするパス（詳細画面など）。
 * 新しい画面はここに足す。href は "/" 始まりで書けば Framework がページごとの相対パスに書き換える。
 */
const NAV = [
  { name: ja.app.nav.index, path: "/", match: ["/", "/index"] },
  { name: ja.app.nav.teams, path: "/teams", match: ["/teams", "/team"] },
  { name: ja.app.nav.customers, path: "/customers", match: ["/customers", "/customer"] },
  { name: ja.app.nav.contracts, path: "/contracts", match: ["/contracts", "/contract"] },
  { name: ja.app.nav.members, path: "/members", match: ["/members", "/member"] },
  { name: ja.app.nav.workload, path: "/workload", match: ["/workload"] },
];
const TOOLS = [{ name: ja.app.nav.plan, path: "/plan" }];
// マスタ編集・使い方・データ確認・計算ルールは目立つ場所に置かない（§45・§47・§52）。マージ待ちの件数は「⋯」にも出す
const MORE = [
  { name: ja.app.nav.masters, path: "/masters", badge: true },
  { name: ja.app.nav.guide, path: "/guide" },
  { name: ja.app.nav.dataCheck, path: "/data-check" },
  { name: ja.app.nav.rules, path: "/rules" },
];

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** 共通ヘッダ: ロゴ・タブ・右上リンク ＋ フィルタバーの差し込み口（mountFilterBar が使う） */
function header({ path }) {
  const isOn = (item) => (item.match ?? [item.path]).includes(path);
  // badge: マージ待ちの件数（head の mrBadgeScript が数を入れて表示する。0 件は隠す）
  const badge = `<span class="yn-mr-badge" hidden><span class="yn-mr-badge-n" aria-hidden="true"></span><span class="yn-mr-badge-sr visually-hidden"></span></span>`;
  const link = (item, cls) =>
    `<a class="${cls}" href="${item.path}"${isOn(item) ? ' aria-current="page"' : ""}>${escapeHtml(item.name)}${item.badge ? badge : ""}</a>`;
  // 設定と「⋯」は、他のリンクと見分けられるアイコンのボタン（§28。テーマの切替は設定画面だけ）
  const gear = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6a.5.5 0 0 0 .1-.6l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.4 7.4 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.6L4.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6a.5.5 0 0 0-.1.6l2 3.5c.1.2.4.3.6.2l2.5-1c.5.4 1.1.7 1.7 1l.4 2.6c0 .3.2.4.5.4h4c.3 0 .5-.2.5-.4l.4-2.6c.6-.3 1.2-.6 1.7-1l2.5 1c.2.1.5 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.6L19.4 13zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>`;
  const dots = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><g fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></g></svg>`;
  const settingsOn = path === "/settings";
  const moreOn = MORE.some(isOn);
  const more = `<span class="yn-more"><button type="button" class="yn-icon-btn yn-more-btn${moreOn ? " is-current" : ""}" aria-haspopup="true" aria-expanded="false" aria-controls="yn-more-menu" aria-label="${escapeHtml(ja.app.more)}" title="${escapeHtml(ja.app.more)}">${dots}</button>${badge.replace('class="yn-mr-badge"', 'class="yn-mr-badge yn-more-badge"')}<span class="yn-more-menu" id="yn-more-menu" hidden>${MORE.map((i) => link(i, "yn-more-item")).join("")}</span></span>`;
  return `<div class="yn-topbar">
  <a class="yn-brand" href="/"><span class="yn-brand-mark" aria-hidden="true"></span>${escapeHtml(ja.app.name)}</a>
  <nav class="yn-tabs" aria-label="${escapeHtml(ja.app.tabsLabel)}">${NAV.map((i) => link(i, "yn-tab")).join("")}</nav>
  <div id="yn-unit-slot" class="yn-unit-slot"></div>
  <nav class="yn-tools" aria-label="${escapeHtml(ja.app.toolsLabel)}">${TOOLS.map((i) => link(i, "yn-tool")).join("")}<span class="yn-icon-tools"><a class="yn-icon-btn yn-settings-link" href="/settings" aria-label="${escapeHtml(ja.app.settings)}" title="${escapeHtml(ja.app.settings)}"${settingsOn ? ' aria-current="page"' : ""}>${gear}</a>${more}</span></nav>
</div>
<div id="yn-filterbar-slot" class="yn-filterbar-slot"></div>`;
}

/**
 * 配色（§53）: 描画前に表示モード（設定画面 → GitLab → PC の設定）と差し色（設定画面 → GitLab → 既定）を <html data-theme data-accent> に当てる。
 * Framework の dark（グラフの配色）は body の color-scheme を見て自動で追従する（style.css の :root[data-theme="dark"]）。
 */
const THEME_SCRIPT = appearanceScript(appearanceConfig(masterEditConfig()));
/**
 * 戻る・再読み込みでスクロール位置を戻す。画面はデータを読んでから描くため、ブラウザ任せだと一番上に戻ってしまう。
 * 離れるときの位置を URL ごとに sessionStorage に置き、描き終わって高さが足りたら戻す（その前に利用者が動かしたら戻さない）
 */
const SCROLL_SCRIPT = `(() => {
  const KEY = "yn-scroll:";
  const id = () => location.pathname + location.search;
  try { history.scrollRestoration = "manual"; } catch {}
  addEventListener("pagehide", () => { try { sessionStorage.setItem(KEY + id(), String(Math.round(scrollY))); } catch {} });
  const nav = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
  if (!nav || (nav.type !== "back_forward" && nav.type !== "reload") || location.hash) return;
  let y = 0;
  try { y = Number(sessionStorage.getItem(KEY + id())) || 0; } catch {}
  if (y <= 0) return;
  let stop = false;
  const cancel = () => { stop = true; };
  for (const t of ["wheel", "touchstart", "keydown", "mousedown"]) addEventListener(t, cancel, { once: true, passive: true });
  const t0 = Date.now();
  let lastH = 0, since = 0;
  const tick = () => {
    if (stop || Date.now() - t0 > 8000) return;
    const h = document.documentElement.scrollHeight;
    if (h !== lastH) { lastH = h; since = Date.now(); }
    // 骨組みが消え、高さが足りて 0.2 秒変わらなければ描き終わったとみなす
    if (!document.getElementById("page-skeleton") && h >= y + innerHeight && Date.now() - since >= 200) { scrollTo(0, y); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;
/**
 * 画面フォント BIZ UDPゴシック（src/fonts/、§46）。外部に出ないよう同梱する。
 * Framework は head の <link href> のファイルを dist にハッシュ付きの名前で出すので、その href から @font-face を組み立てる
 */
const FONT_WEIGHTS = [
  ["Regular", 400],
  ["Bold", 700],
];
const FONT_LINKS = FONT_WEIGHTS.map(
  ([style, weight]) => `<link rel="preload" as="font" type="font/woff2" crossorigin href="./fonts/BIZUDPGothic-${style}.woff2" data-yn-font="${weight}">`,
).join("");
const FONT_SCRIPT = `(() => {
  let css = "";
  for (const l of document.querySelectorAll("link[data-yn-font]")) {
    css += '@font-face{font-family:"YN BIZ UDPGothic";font-style:normal;font-weight:' + l.dataset.ynFont + ';font-display:swap;src:url("' + l.href + '") format("woff2")}';
  }
  const s = document.createElement("style");
  s.textContent = css;
  document.head.append(s);
})();`;
/**
 * 画面の切り替えを速くする先読み（SPEC §108）。Chrome・Edge は、リンクにマウスを載せた（または押し始めた）ところで次の画面を裏で作っておき、
 * 押すとすぐに出す（Speculation Rules。対応しないブラウザでは何もしない）。マスタ編集・設定は先読みしない（下書き・GitLab の確認があるため）
 */
const SPECULATION_RULES = JSON.stringify({
  prerender: [
    {
      where: { and: [{ selector_matches: 'a[href^="./"]' }, { not: { selector_matches: 'a[href^="./masters"], a[href^="./settings"], a[download], a[target]' } }] },
      eagerness: "moderate",
    },
  ],
});
/**
 * 先読みで裏で作っている画面（document.prerendering）の調整:
 * - 画面の計算（Observable の実行）は requestAnimationFrame で進むが、裏で作っている間は呼ばれない。裏でも集計・表まで作るよう、その間だけ時計（setTimeout）で代わりに呼ぶ
 * - 裏で作った後、表示される前に元の画面で表示の状態（期間・チーム・列の設定など、このブラウザに覚えたもの）が変わっていたら、表示するときに作り直す（古い状態の画面を出さない）
 */
const PRERENDER_SCRIPT = `(() => {
  if (!document.prerendering) return;
  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => (document.prerendering ? -setTimeout(() => cb(performance.now()), 16) : raf(cb));
  window.cancelAnimationFrame = (id) => (id < 0 ? clearTimeout(-id) : caf(id));
  const own = new Set();
  for (const m of ["setItem", "removeItem"]) {
    const f = Storage.prototype[m];
    Storage.prototype[m] = function (key, ...rest) {
      if (document.prerendering) own.add(String(key));
      return f.call(this, key, ...rest);
    };
  }
  const snap = () => {
    const out = {};
    for (const [name, st] of [["l", localStorage], ["s", sessionStorage]]) {
      try {
        for (let i = 0; i < st.length; i++) {
          const k = st.key(i);
          if (k && k.startsWith("yojitsu-navi") && !own.has(k)) out[name + k] = st.getItem(k);
        }
      } catch {}
    }
    return out;
  };
  // 先読みを始めたときにあった値が変わった・消えたら古い（後から足された値は見ない。元の画面が読み込みの途中で初めて書いた既定値で作り直さない）
  const before = snap();
  // 作り直すときは、先読みを始めたときの URL で開き直す（裏で作る間に画面が URL へ足した期間などを使わない）
  const href = location.href;
  document.addEventListener("prerenderingchange", () => {
    const now = snap();
    if (Object.keys(before).some((k) => !own.has(k.slice(1)) && now[k] !== before[k])) location.replace(href);
  }, { once: true });
})();`;
/** 右端「その他」（⋯）のメニュー: 押すと開閉、外を押す・Esc・フォーカスが外れると閉じる */
const MORE_SCRIPT = `(() => {
  const parts = () => { const btn = document.querySelector(".yn-more-btn"); return btn ? [btn, document.getElementById("yn-more-menu")] : []; };
  const set = (open, focusBtn) => {
    const [btn, menu] = parts();
    if (!btn) return;
    btn.setAttribute("aria-expanded", String(open));
    menu.hidden = !open;
    if (open) menu.querySelector("a")?.focus();
    else if (focusBtn) btn.focus();
  };
  document.addEventListener("click", (e) => {
    const [btn] = parts();
    if (!btn || !(e.target instanceof Element)) return;
    if (e.target.closest(".yn-more-btn")) set(btn.getAttribute("aria-expanded") !== "true");
    else if (!e.target.closest(".yn-more-menu")) set(false);
  });
  document.addEventListener("keydown", (e) => {
    const [btn] = parts();
    if (e.key === "Escape" && btn?.getAttribute("aria-expanded") === "true") set(false, true);
  });
  document.addEventListener("focusout", (e) => {
    const [btn] = parts();
    if (btn?.getAttribute("aria-expanded") === "true" && e.relatedTarget instanceof Element && !e.relatedTarget.closest(".yn-more")) set(false);
  });
  // 戻るでキャッシュから戻ったときだけ閉じる（読み込み中に開いたメニューを、読み込み完了で閉じない）
  addEventListener("pageshow", (e) => { if (e.persisted) set(false); });
})();`;
const BADGE_SCRIPT = mrBadgeScript(badgeConfig(masterEditConfig(), ja.app.mrBadge));
/**
 * バージョン情報（設定画面に出す、§59）: package.json の version・ビルドしたコミット・ビルド日時（JST）。
 * コミットは CI の変数か git から取る。取れなければ空（設定画面ではその行を出さない）
 */
function buildInfo() {
  let version = "";
  try {
    version = JSON.parse(decode(readFileSync(new URL("./package.json", import.meta.url)))).version ?? "";
  } catch {}
  let commit = process.env.CI_COMMIT_SHORT_SHA ?? "";
  if (!commit) {
    try {
      commit = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: new URL(".", import.meta.url), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {}
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  const builtAt = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  return { version, commit, builtAt };
}
const BUILD = buildInfo();
const BUILD_META = `<meta name="yn-build" data-version="${escapeHtml(BUILD.version)}" data-commit="${escapeHtml(BUILD.commit)}" data-built-at="${escapeHtml(BUILD.builtAt)}">`;
const head = `${faviconLink()}${BUILD_META}<meta name="color-scheme" content="light dark">${FONT_LINKS}<script>${FONT_SCRIPT}</script><script>${THEME_SCRIPT}</script><script>${BADGE_SCRIPT}</script><script>${SCROLL_SCRIPT}</script><script>${MORE_SCRIPT}</script><script>${PRERENDER_SCRIPT}</script><script type="speculationrules">${SPECULATION_RULES}</script>`;

export default {
  title: ja.app.name,
  root: "src",
  output: "dist",
  pages: [
    { name: ja.app.pages.index, path: "/" },
    { name: ja.app.pages.teams, path: "/teams" },
    { name: ja.app.pages.customers, path: "/customers" },
    { name: ja.app.pages.contracts, path: "/contracts" },
    { name: ja.app.pages.members, path: "/members" },
    { name: ja.app.pages.workload, path: "/workload" },
    { name: ja.app.pages.guide, path: "/guide" },
    { name: ja.app.pages.rules, path: "/rules" },
    { name: ja.app.pages.dataCheck, path: "/data-check" },
    { name: ja.app.pages.plan, path: "/plan" },
    { name: ja.app.pages.masters, path: "/masters" },
    { name: ja.app.pages.settings, path: "/settings" },
  ],
  // 契約ごとの作業ログ明細（src/data/worklogs/[contractId].json.js）を dist/data/worklogs/<id>.json に出力する
  // ファイル名は worklogKey(id)（英数字以外の ID は "~"＋16進。ローダ・画面の fetchWorklogs も同じ関数を使う）
  dynamicPaths: contractIds().map((id) => `/data/worklogs/${worklogKey(id)}.json`),
  head,
  toc: false,
  pager: false,
  sidebar: false,
  header,
  search: false,
  footer: escapeHtml(ja.app.footer),
  // 社内GitLab Pages はサブパス配信のことが多いので相対パスにする
  // (GitLab Pages で https://group.pages.example/yojitsu-navi/ の形で配信される想定)
  cleanUrls: true,
  preserveExtension: false,
  // 依存ライブラリはビルド時に同梱され、CDNは不要（社内公開向け）
  globalStylesheets: [],
  typographyDefault: false,
  // 画面のスタイル（既定テーマを読み込んだ上で上書き）
  style: "style.css",
};
