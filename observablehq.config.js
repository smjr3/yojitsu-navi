// Observable Framework 設定
// https://observablehq.com/framework/config
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
  head: '<link rel="icon" href="data:,">',
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
};
