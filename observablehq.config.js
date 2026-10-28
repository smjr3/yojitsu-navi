// Observable Framework 設定
// https://observablehq.com/framework/config
import { readFileSync } from "node:fs";
import ja from "./src/i18n/ja.js";

/** data/contracts.csv の契約ID（作業ログ明細の動的パス用）。読めなければ空 */
function contractIds() {
  try {
    const text = readFileSync(new URL("./data/contracts.csv", import.meta.url), "utf-8").replace(/^﻿/, "");
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const idx = Math.max(0, header.indexOf("contract_id"));
    const ids = new Set();
    for (const line of lines.slice(1)) {
      const id = (line.split(",")[idx] ?? "").trim().replace(/^"|"$/g, "");
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
  <nav class="yn-tools" aria-label="${escapeHtml(ja.app.toolsLabel)}">${TOOLS.map((i) => link(i, "yn-tool")).join("")}</nav>
</div>
<div id="yn-filterbar-slot" class="yn-filterbar-slot"></div>`;
}

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
  // ID はパスとして安全な形に encodeURIComponent する（ローダ側で decodeURIComponent）。画面の fetchWorklogs も同じ符号化で取得する
  dynamicPaths: contractIds().map((id) => `/data/worklogs/${encodeURIComponent(id)}.json`),
  head: '<link rel="icon" href="data:,"><meta name="color-scheme" content="light dark">',
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
