// Observable Framework 設定
// https://observablehq.com/framework/config
import { readFileSync } from "node:fs";

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
  { name: "全体", path: "/", match: ["/", "/index"] },
  { name: "チーム", path: "/teams" },
  { name: "契約", path: "/contracts", match: ["/contracts", "/contract"] },
];
const TOOLS = [
  { name: "データ確認", path: "/data-check" },
  { name: "計算ルール", path: "/rules" },
];

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** 共通ヘッダ: ロゴ・タブ・右上リンク ＋ フィルタバーの差し込み口（mountFilterBar が使う） */
function header({ path }) {
  const isOn = (item) => (item.match ?? [item.path]).includes(path);
  const link = (item, cls) =>
    `<a class="${cls}" href="${item.path}"${isOn(item) ? ' aria-current="page"' : ""}>${escapeHtml(item.name)}</a>`;
  return `<div class="yn-topbar">
  <a class="yn-brand" href="/"><span class="yn-brand-mark" aria-hidden="true"></span>予実ナビ</a>
  <nav class="yn-tabs" aria-label="画面">${NAV.map((i) => link(i, "yn-tab")).join("")}</nav>
  <div id="yn-unit-slot" class="yn-unit-slot"></div>
  <nav class="yn-tools" aria-label="補助">${TOOLS.map((i) => link(i, "yn-tool")).join("")}</nav>
</div>
<div id="yn-filterbar-slot" class="yn-filterbar-slot"></div>`;
}

export default {
  title: "予実ナビ",
  root: "src",
  output: "dist",
  pages: [
    { name: "全体サマリー", path: "/" },
    { name: "チーム一覧", path: "/teams" },
    { name: "契約一覧", path: "/contracts" },
    { name: "計算ルール", path: "/rules" },
    { name: "データ確認", path: "/data-check" },
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
  footer: "予実ナビ — 保守契約の予実（粗利）管理",
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
