// 変更履歴（CHANGELOG.md）を読み、update のあとに「今の版から新しい版までに導入先で行うこと」を出す（SPEC §91.2）。Node の標準モジュールだけを使う
//
// CHANGELOG.md の形（docs/RELEASE.md「変更履歴の書き方」）:
//   ## 0.3.0                ← 版ごと。公開前は「## 次の版」（版を上げる PR で版の番号にする）
//   ### 更新後に行うこと     ← update が出す（箇条書き）
//   ### テスト・CI の前提     ← update が出す（箇条書き）
//   ### 新しい設定と推奨値   ← update が出す（表。1 列目が `config.json の項目`。今の値を添える）
//   ### 変更                ← update は出さない（MR・リリースで読む）

import { compareVersion } from "./version.mjs";

export const CHANGELOG = "CHANGELOG.md";
/** update が出す小見出し（この順で出す） */
export const NOTE_HEADINGS = ["更新後に行うこと", "テスト・CI の前提", "新しい設定と推奨値"];
/** 公開前の版の見出し */
export const NEXT_HEADING = "次の版";

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * 版ごとに分ける。返す: [{ version: "0.2.0" | "次の版", sections: Map<小見出し, 行の配列> }]（書いてある順）
 * 見出しの後ろの「（…）」は見ない（例: ## 0.2.0（作業コード））
 */
export function parseChangelog(text) {
  const out = [];
  let cur = null;
  let sec = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const v = /^##\s+([^#\s（(]+)/.exec(raw);
    if (v && !raw.startsWith("###")) {
      cur = { version: v[1], sections: new Map() };
      out.push(cur);
      sec = null;
      continue;
    }
    const s = /^###\s+(.+?)\s*$/.exec(raw);
    if (s && cur) {
      sec = [];
      cur.sections.set(s[1], sec);
      continue;
    }
    if (sec) sec.push(raw);
  }
  for (const c of out) for (const [k, lines] of c.sections) c.sections.set(k, trimBlank(lines));
  return out;
}

function trimBlank(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === "") a++;
  while (b > a && lines[b - 1].trim() === "") b--;
  return lines.slice(a, b);
}

/** from より新しく to 以下の版（古い順）。「次の版」は入れない */
export function versionsBetween(entries, from, to) {
  return entries
    .filter((e) => VERSION_RE.test(e.version) && compareVersion(e.version, from) > 0 && compareVersion(e.version, to) <= 0)
    .sort((a, b) => compareVersion(a.version, b.version));
}

/** 設定の値（"a.b.c"）。無ければ undefined */
export function configValue(config, path) {
  let v = config;
  for (const k of path.split(".")) {
    if (!v || typeof v !== "object" || !(k in v)) return undefined;
    v = v[k];
  }
  return v;
}

/** 表の行（| a | b |）をセルにする。見出し行・区切り行は null */
function tableRow(line, index) {
  if (!/^\s*\|/.test(line) || /^\s*\|[\s:|-]+\|\s*$/.test(line)) return null;
  const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  return index === 0 ? null : cells;
}

/**
 * 設定の表を「項目 今の値 → 推奨」の行にする。1 列目の `a.b.c` を config から読む（項目が複数のときは最初のもの）。
 * 表の列: 項目 | 書かないとき | 推奨 | 理由・いつ
 */
export function settingLines(lines, config) {
  const out = [];
  let i = 0;
  for (const line of lines) {
    if (!/^\s*\|/.test(line)) {
      if (line.trim()) out.push(line);
      continue;
    }
    const cells = tableRow(line, i++);
    if (!cells) continue;
    const [item = "", dflt = "", rec = "", why = ""] = cells;
    const key = /`([\w.]+)`/.exec(item)?.[1];
    const v = key && config ? configValue(config, key) : undefined;
    const now = key ? (v === undefined ? `未設定（書かないとき: ${dflt.replace(/`/g, "") || "なし"}）` : JSON.stringify(v)) : "";
    out.push(`- ${item.replace(/`/g, "")}  今: ${now} / 推奨: ${rec.replace(/`/g, "")}${why ? `（${why.replace(/`/g, "")}）` : ""}`);
  }
  return out;
}

/**
 * update のあとに出す文章（行の配列）。対象の版が無ければ []。
 * @param {string} text CHANGELOG.md の中身
 * @param {string} from 今のプロジェクトの版
 * @param {string} to 新しい版
 * @param {object | null} config 社内の config.json（読めなければ null）
 */
export function updateNotes(text, from, to, config) {
  const out = [];
  for (const e of versionsBetween(parseChangelog(text), from, to)) {
    const body = [];
    for (const h of NOTE_HEADINGS) {
      const lines = e.sections.get(h);
      if (!lines?.length) continue;
      body.push(`  [${h}]`);
      const shown = h === "新しい設定と推奨値" ? settingLines(lines, config) : lines.filter((l) => l.trim());
      // 端末で読むので、Markdown のコードの印（`）は外す
      for (const l of shown) body.push(`    ${l.trim().replace(/`/g, "")}`);
    }
    if (body.length) out.push(`${e.version}:`, ...body);
  }
  return out;
}
