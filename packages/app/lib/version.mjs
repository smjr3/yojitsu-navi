// 版の比較（project.mjs・changelog.mjs が使う）。Node の標準モジュールも使わない

/** "1.2.3" の大小（a<b で負） */
export function compareVersion(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}
