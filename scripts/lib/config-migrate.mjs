// config.json の不足の項目・名前が変わった項目を、今の設定と書式を残したまま書き足す（SPEC §100）。Node の標準モジュールだけを使う
//
// - 不足の項目: 新しい版のひな形（template/config.json）にあって導入先に無い項目。無くても既定値で動くので、書き足すのは選んだものだけ（--add）
// - 名前が変わった項目: スキーマ（config-schema.mjs）の renamedTo。値を新しい名前へ移す（動きは変わらない）
// どちらも今ある値は変えない。ファイルは文字の位置で書き足すので、ほかの行の書式・並び・メモ（"_" の項目）は変わらない

import { CONFIG_SCHEMA } from "./config-schema.mjs";

/** a にあって b に無い項目（"x.y.z" の形）。配列の中は見ない。「_」で始まる項目（メモ）は見ない */
export function missingPaths(a, b, prefix = "") {
  const out = [];
  if (!isObj(a)) return out;
  for (const [k, v] of Object.entries(a)) {
    if (k.startsWith("_") || k === "$schema") continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (!isObj(b) || !(k in b)) out.push(path);
    else out.push(...missingPaths(v, b[k], path));
  }
  return out;
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** 設定の値（"a.b.c"）。無ければ undefined */
export function getPath(config, path) {
  let v = config;
  for (const k of path.split(".")) {
    if (!isObj(v) || !(k in v)) return undefined;
    v = v[k];
  }
  return v;
}

/** スキーマの名前が変わった項目（{ from, to }）。variants の中も見る */
export function renamedPaths(schema = CONFIG_SCHEMA, prefix = "") {
  const out = [];
  const walk = (node, path) => {
    if (node.renamedTo) out.push({ from: path, to: node.renamedTo });
    const props = { ...(node.props ?? {}) };
    for (const c of Object.values(node.variants?.cases ?? {})) Object.assign(props, c);
    for (const [k, child] of Object.entries(props)) walk(child, path ? `${path}.${k}` : k);
  };
  walk(schema, prefix);
  return out;
}

/** 見せる値（長いものは縮める） */
export function showValue(v) {
  const s = inline(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

/** 1 行の JSON（{ "a": 1, "b": [2] } の形。ひな形の書き方に合わせる） */
export function inline(v) {
  if (Array.isArray(v)) return `[${v.map(inline).join(", ")}]`;
  if (isObj(v)) {
    const e = Object.entries(v);
    return e.length ? `{ ${e.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(", ")} }` : "{}";
  }
  return JSON.stringify(v);
}

/**
 * JSON の文字を読み、オブジェクトの位置（{ と } の位置）と各項目の位置を返す。
 * @returns {{ objects: Map<string, { open: number, close: number }>, members: Map<string, { start: number, end: number }> }}
 */
export function scanJson(text) {
  const objects = new Map();
  const members = new Map();
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const str = () => {
    const s = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(text.slice(s, i));
  };
  const value = (path) => {
    ws();
    const c = text[i];
    if (c === "{") {
      const open = i++;
      ws();
      if (text[i] === "}") {
        objects.set(path, { open, close: i++ });
        return;
      }
      for (;;) {
        ws();
        const start = i;
        const key = str();
        ws();
        i++; // :
        const p = path ? `${path}.${key}` : key;
        value(p);
        members.set(p, { start, end: i });
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        objects.set(path, { open, close: i++ });
        return;
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") {
        i++;
        return;
      }
      for (let n = 0; ; n++) {
        value(`${path}[${n}]`);
        ws();
        if (text[i++] === "]") return;
      }
    }
    if (c === '"') {
      str();
      return;
    }
    while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
  };
  value("");
  return { objects, members };
}

/** 行の頭の字下げ */
function indentAt(text, pos) {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))[0];
}

/**
 * 項目を書き足す（親が無ければ親ごと）。今ある項目は変えない。書式は親のオブジェクトに合わせる（複数行なら 1 項目 1 行、1 行なら同じ行に）
 * @returns {string}
 */
export function addPath(text, path, value) {
  const config = JSON.parse(text.replace(/^﻿/, ""));
  if (getPath(config, path) !== undefined) return text;
  const keys = path.split(".");
  // 今ある一番深い親
  let n = 0;
  while (n < keys.length - 1 && isObj(getPath(config, keys.slice(0, n + 1).join(".")))) n++;
  const parent = keys.slice(0, n).join(".");
  let v = value;
  for (let k = keys.length - 1; k > n; k--) v = { [keys[k]]: v };
  const { objects } = scanJson(text);
  const o = objects.get(parent);
  if (!o) throw new Error(`${parent || "(全体)"} が { … } ではないので ${path} を書き足せません`);
  const body = text.slice(o.open + 1, o.close);
  const empty = body.trim() === "";
  const multiline = body.includes("\n") || (parent === "" && empty);
  const member = `${JSON.stringify(keys[n])}: ${inline(v)}`;
  if (!multiline) return `${text.slice(0, o.close).replace(/\s*$/, "")}${empty ? " " : ", "}${member} ${text.slice(o.close)}`;
  const closeIndent = indentAt(text, o.close);
  const firstMember = /\n([ \t]*)\S/.exec(body);
  const indent = firstMember ? firstMember[1] : `${closeIndent}  `;
  if (empty) return `${text.slice(0, o.open + 1)}\n${indent}${member}\n${closeIndent}${text.slice(o.close)}`;
  let last = o.close - 1;
  while (/\s/.test(text[last])) last--;
  return `${text.slice(0, last + 1)},\n${indent}${member}${text.slice(last + 1)}`;
}

/** 項目を消す（前後の「,」も） */
export function removePath(text, path) {
  const { members } = scanJson(text);
  const m = members.get(path);
  if (!m) return text;
  let end = m.end;
  let j = end;
  while (/\s/.test(text[j])) j++;
  if (text[j] === ",") {
    // 後ろに項目がある: 次の項目の頭まで消す
    j++;
    while (/[ \t]/.test(text[j])) j++;
    if (text[j] === "\n") {
      // 改行の後ろの字下げは次の項目のもの。消す行の字下げから消す
      let s = m.start;
      while (s > 0 && /[ \t]/.test(text[s - 1])) s--;
      return text.slice(0, s) + text.slice(j + 1);
    }
    return text.slice(0, m.start) + text.slice(j);
  }
  // 最後の項目: 前の「,」から消す
  let s = m.start - 1;
  while (s >= 0 && /\s/.test(text[s])) s--;
  if (text[s] === ",") return text.slice(0, s) + text.slice(end);
  return text.slice(0, m.start) + text.slice(end);
}

/**
 * 導入先の config.json と新しい版のひな形を比べる
 * @returns {{ missing: { path: string, value: string }[], renames: { from: string, to: string, value: string, conflict: boolean }[] }}
 */
export function configDiff(localText, templateText, schema = CONFIG_SCHEMA) {
  const local = JSON.parse(String(localText).replace(/^﻿/, ""));
  const tpl = JSON.parse(String(templateText).replace(/^﻿/, ""));
  const renames = renamedPaths(schema)
    .filter((r) => getPath(local, r.from) !== undefined)
    .map((r) => ({ ...r, value: showValue(getPath(local, r.from)), conflict: getPath(local, r.to) !== undefined }));
  const moved = new Set(renames.map((r) => r.to));
  const missing = missingPaths(tpl, local)
    .filter((p) => !moved.has(p))
    .map((path) => ({ path, value: showValue(getPath(tpl, path)) }));
  return { missing, renames };
}

/**
 * 名前が変わった項目を移し（apply）、選んだ不足の項目（add）をひな形の値で書き足す
 * @param {{ localText: string, templateText: string, add?: string[], renames?: boolean, schema?: any }} o
 * @returns {{ text: string, added: string[], moved: { from: string, to: string }[], skipped: { path: string, why: string }[] }}
 */
export function migrateConfigText(o) {
  const tpl = JSON.parse(String(o.templateText).replace(/^﻿/, ""));
  let text = String(o.localText);
  const bom = text.startsWith("﻿") ? "﻿" : "";
  text = text.slice(bom.length);
  const diff = configDiff(text, o.templateText, o.schema);
  const added = [];
  const moved = [];
  const skipped = [];
  if (o.renames) {
    for (const r of diff.renames) {
      if (r.conflict) {
        skipped.push({ path: r.from, why: `${r.to} もあるので移しません（どちらかを消してください）` });
        continue;
      }
      const v = getPath(JSON.parse(text), r.from);
      text = removePath(addPath(text, r.to, v), r.from);
      moved.push({ from: r.from, to: r.to });
    }
  }
  const missing = new Set(diff.missing.map((m) => m.path));
  for (const p of o.add ?? []) {
    // 親を選んだときは、その下の不足の項目をまとめて足す
    const under = [...missing].filter((m) => m === p || m.startsWith(`${p}.`));
    // 親ごと無いときに下の項目だけを選んだ: その項目だけを（親を作って）足す
    if (!under.length && getPath(tpl, p) !== undefined && getPath(JSON.parse(text), p) === undefined) {
      text = addPath(text, p, getPath(tpl, p));
      added.push(p);
      continue;
    }
    if (!under.length) {
      skipped.push({ path: p, why: getPath(JSON.parse(text), p) !== undefined ? "もう書いてあります（値は変えません）" : "新しい版のひな形にありません" });
      continue;
    }
    for (const m of under) {
      text = addPath(text, m, getPath(tpl, m));
      added.push(m);
      missing.delete(m);
    }
  }
  JSON.parse(text);
  return { text: bom + text, added, moved, skipped };
}
