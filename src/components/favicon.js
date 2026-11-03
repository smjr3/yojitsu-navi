/**
 * ファビコン（§85）。画像ファイルは置かない（§44）ので、SVG の文字列を data URI にして全ページの <head> に埋め込む。
 * 色はテーマカラーの既定（Blue）。OS がダーク表示ならダーク側の色にする（SVG 内の prefers-color-scheme）。
 * 図柄は「月ごとに伸びる 3 本の棒」（予実の推移）。16px でも潰れないよう線を細くしない。
 */
export const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  "<style>.b{fill:#1c5cab}.f{fill:#fff}@media (prefers-color-scheme:dark){.b{fill:#6da7ec}.f{fill:#161c27}}</style>" +
  '<rect class="b" width="32" height="32" rx="7"/>' +
  '<rect class="f" x="6" y="17" width="5.5" height="9" rx="1"/>' +
  '<rect class="f" x="13.25" y="12" width="5.5" height="14" rx="1"/>' +
  '<rect class="f" x="20.5" y="6" width="5.5" height="20" rx="1"/>' +
  "</svg>";

/** <head> に入れる <link rel="icon">（data URI。外部ファイルを読まない） */
export function faviconLink() {
  return `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">`;
}
