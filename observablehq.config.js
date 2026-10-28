// Observable Framework 設定
// https://observablehq.com/framework/config
import { readFileSync } from "node:fs";
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
 * NAV = 画面の切り替えタブ、TOOLS = 右上の補助・管理リンク。match はタブを選択状態にするパス（詳細画面など）。
 * 新しい画面はここに足す。href は "/" 始まりで書けば Framework がページごとの相対パスに書き換える。
 */
const NAV = [
  { name: ja.app.nav.index, path: "/", match: ["/", "/index"] },
  { name: ja.app.nav.teams, path: "/teams", match: ["/teams", "/team"] },
  { name: ja.app.nav.customers, path: "/customers", match: ["/customers", "/customer"] },
  { name: ja.app.nav.contracts, path: "/contracts", match: ["/contracts", "/contract"] },
  { name: ja.app.nav.members, path: "/members", match: ["/members", "/member"] },
];
const TOOLS = [
  { name: ja.app.nav.dataCheck, path: "/data-check" },
  { name: ja.app.nav.rules, path: "/rules" },
  { name: ja.app.nav.plan, path: "/plan" },
  { name: ja.app.nav.masters, path: "/masters" },
];

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** 共通ヘッダ: ロゴ・タブ・右上リンク ＋ フィルタバーの差し込み口（mountFilterBar が使う） */
function header({ path }) {
  const isOn = (item) => (item.match ?? [item.path]).includes(path);
  const link = (item, cls) =>
    `<a class="${cls}" href="${item.path}"${isOn(item) ? ' aria-current="page"' : ""}>${escapeHtml(item.name)}</a>`;
  return `<div class="yn-topbar">
  <a class="yn-brand" href="/"><span class="yn-brand-mark" aria-hidden="true"></span>${escapeHtml(ja.app.name)}</a>
  <nav class="yn-tabs" aria-label="${escapeHtml(ja.app.tabsLabel)}">${NAV.map((i) => link(i, "yn-tab")).join("")}</nav>
  <div id="yn-unit-slot" class="yn-unit-slot"></div>
  <nav class="yn-tools" aria-label="${escapeHtml(ja.app.toolsLabel)}">${TOOLS.map((i) => link(i, "yn-tool")).join("")}<button type="button" class="yn-tool yn-theme-toggle" aria-pressed="false">${escapeHtml(ja.app.themeToggle)}</button></nav>
</div>
<div id="yn-filterbar-slot" class="yn-filterbar-slot"></div>`;
}

/**
 * テーマ（既定ライト）。描画前に localStorage の選択を <html data-theme> に戻し、ヘッダーの切替ボタンで保存する。
 * Framework の dark（グラフの配色）は body の color-scheme を見て自動で追従する（style.css の :root[data-theme="dark"]）。
 */
const THEME_SCRIPT = `(() => {
  const KEY = "yn-theme";
  const root = document.documentElement;
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const apply = (t) => {
    root.dataset.theme = t === "dark" ? "dark" : "light";
    for (const b of document.querySelectorAll(".yn-theme-toggle")) b.setAttribute("aria-pressed", String(t === "dark"));
  };
  apply(read());
  document.addEventListener("DOMContentLoaded", () => apply(read()));
  document.addEventListener("click", (e) => {
    if (!(e.target instanceof Element) || !e.target.closest(".yn-theme-toggle")) return;
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    try { localStorage.setItem(KEY, next); } catch {}
    apply(next);
  });
})();`;
const head = `<link rel="icon" href="data:,"><meta name="color-scheme" content="light dark"><script>${THEME_SCRIPT}</script>`;

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
    { name: ja.app.pages.rules, path: "/rules" },
    { name: ja.app.pages.dataCheck, path: "/data-check" },
    { name: ja.app.pages.plan, path: "/plan" },
    { name: ja.app.pages.masters, path: "/masters" },
  ],
  // 契約ごとの作業ログ明細（src/data/worklogs/[contractId].json.ts）を dist/data/worklogs/<id>.json に出力する
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
