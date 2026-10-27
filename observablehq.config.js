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

export default {
  title: "予実ナビ",
  root: "src",
  output: "dist",
  pages: [
    { name: "全体サマリー", path: "/" },
    { name: "チーム一覧", path: "/teams" },
    { name: "顧客別", path: "/customers" },
    { name: "契約一覧", path: "/contracts" },
    { name: "メンバー別", path: "/members" },
    { name: "計算ルール", path: "/rules" },
    { name: "データ確認", path: "/data-check" },
    { name: "マスタ編集", path: "/masters" },
  ],
  // 契約ごとの作業ログ明細（src/data/worklogs/[contractId].json.ts）を dist/data/worklogs/<id>.json に出力する
  // ID はパスとして安全な形に encodeURIComponent する（ローダ側で decodeURIComponent）。画面の fetchWorklogs も同じ符号化で取得する
  dynamicPaths: contractIds().map((id) => `/data/worklogs/${encodeURIComponent(id)}.json`),
  head: '<link rel="icon" href="data:,"><meta name="color-scheme" content="light dark">',
  toc: false,
  pager: false,
  sidebar: true,
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
