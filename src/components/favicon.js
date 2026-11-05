/**
 * ファビコン（§89）。src/icons/ のファイル（favicon.svg・favicon-32.png・apple-touch-icon.png）を全ページの <head> から読む。
 * data URI の埋め込みは社内の配信先で表示されなかったため、ファイルにした（2026-11-04）。
 * favicon.svg はこの FAVICON_SVG と同じ中身（tests/unit/favicon.test.ts で確かめる）。PNG は scripts/make-favicons.mjs で作り直す。
 * 色はテーマカラーの既定（Blue）。OS がダーク表示ならダーク側の色にする（SVG 内の prefers-color-scheme。PNG はライトの色だけ）。
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

/** <head> に入れるリンク。Framework が href のファイルを dist にハッシュ付きの名前で出す（フォントと同じ） */
export function faviconLink() {
  return (
    '<link rel="icon" type="image/png" sizes="32x32" href="./icons/favicon-32.png">' +
    '<link rel="icon" type="image/svg+xml" href="./icons/favicon.svg">' +
    '<link rel="apple-touch-icon" href="./icons/apple-touch-icon.png">'
  );
}
