// 社内の CI 設定（.gitlab-ci.local.yml）の点検と、.gitlab-ci.yml からの移し替え（SPEC §91.3・§91.4）。Node の標準モジュールだけを使う
//   - lintCiYaml: GitLab が「config can't be blank」などで受け付けない書き方（中身の無いジョブ・空のファイル）を見つける
//   - repairLocalPlaceholder: 0.2.0〜0.2.1 のひな形の「.yojitsu-navi-local: {}」（GitLab が失敗にする）を、中身のある形に直す
//   - migrateCi: 社内で直した .gitlab-ci.yml から、ランナーのタグ・変数・社内だけのジョブを .gitlab-ci.local.yml へ移す
// YAML の解釈は字下げだけを見る簡単なもの（.gitlab-ci.yml の書き方の範囲）。読めない書き方は「手で移すもの」に回す
// プロジェクトの npm run ci:check（scripts/ci/check.mjs）と、yojitsu-navi コマンド（packages/app/lib に写して使う）の両方が使う
import { createHash } from "node:crypto";

export const LOCAL_CI_FILE = ".gitlab-ci.local.yml";
const CI_NAME = ".gitlab-ci.yml";

/** 何もしない項目の名前（. で始まる名前は GitLab がジョブとして動かさない） */
export const PLACEHOLDER_KEY = ".yojitsu-navi-local";
/** 何もしない項目の中身。GitLab は中身の無い項目（{} や空）を「config can't be blank」で失敗にするので、使われない変数を 1 つ持たせる */
export const PLACEHOLDER = `${PLACEHOLDER_KEY}:\n  variables:\n    YOJITSU_NAVI_LOCAL: "1"`;
/** 0.2.0〜0.2.1 のひな形の、GitLab が失敗にする行 */
const BAD_PLACEHOLDER = /^\.yojitsu-navi-local:[ \t]*(?:\{[ \t]*\}|null|~)?[ \t]*(?:#.*)?$/m;

/** migrate-ci が移したときの .gitlab-ci.yml の印（update がこれと同じ中身なら止めずに新しい版にする） */
const MARKER = /^# yojitsu-navi migrate-ci: \.gitlab-ci\.yml sha256=([0-9a-f]{64})[ \t]*$/m;

/** GitLab の全体の設定（ジョブではない項目） */
const GLOBAL_KEYS = new Set(["default", "include", "stages", "variables", "workflow", "image", "services", "cache", "before_script", "after_script", "spec"]);

const lines = (text) => text.replace(/\r\n/g, "\n").split("\n");
const isSkip = (l) => l.trim() === "" || /^\s*#/.test(l);
const indentOf = (l) => /^ */.exec(l)[0].length;
const KEY = /^( *)("[^"]*"|'[^']*'|[^\s#'"-][^:#]*?|-[^\s:#][^:#]*?):(?:[ \t]+(.*?))?[ \t]*$/;
const unquoteKey = (k) => (/^(["']).*\1$/.test(k) ? k.slice(1, -1) : k);
const stripComment = (v) => (v == null ? "" : /^["']/.test(v) ? v : v.replace(/\s+#.*$/, "")).trim();

/**
 * 字下げ indent の項目（key: …）を [from, to) の行から拾う。
 * 返す: { key, start, end（中身の最後の行の次）, value（同じ行の値） }
 */
function blocks(ls, from, to, indent) {
  const out = [];
  let cur = null;
  let last = -1;
  for (let i = from; i < to; i++) {
    const l = ls[i];
    if (isSkip(l)) continue;
    const ind = indentOf(l);
    if (ind < indent) break;
    const m = ind === indent ? KEY.exec(l) : null;
    if (m) {
      if (cur) cur.end = last + 1;
      cur = { key: unquoteKey(m[2]), start: i, end: i + 1, value: stripComment(m[3]) };
      out.push(cur);
    }
    last = i;
  }
  if (cur) cur.end = last + 1;
  return out;
}

/** 項目の中身の字下げ（中身が無い・同じ字下げの「- 」の並びなら -1） */
function childIndent(ls, b) {
  for (let i = b.start + 1; i < b.end; i++) if (!isSkip(ls[i])) return indentOf(ls[i]) > indentOf(ls[b.start]) ? indentOf(ls[i]) : -1;
  return -1;
}
const children = (ls, b) => {
  const ind = childIndent(ls, b);
  return ind < 0 ? [] : blocks(ls, b.start + 1, b.end, ind);
};
const isBlank = (ls, b) => {
  const v = b.value;
  const hasBody = ls.slice(b.start + 1, b.end).some((l) => !isSkip(l));
  return !hasBody && (v === "" || v === "null" || v === "~" || v === "{}");
};

/**
 * 項目の行（字下げを項目の行に合わせて外す）。値の中の「 #」・複数行の文字列（script: | など）の空行やコメントに見える行を
 * 変えないよう、行の中身はそのまま写す（行末の空白だけ外す）
 */
function blockText(ls, b) {
  const base = indentOf(ls[b.start]);
  return ls.slice(b.start, b.end).map((l) => l.slice(Math.min(base, indentOf(l))).trimEnd());
}
/** 同じ設定か（コメントだけの行・空行は比べない） */
const sameBlock = (a, b) => {
  const norm = (x) => x.filter((l) => !isSkip(l)).join("\n");
  return norm(a) === norm(b);
};

/**
 * GitLab が受け付けない書き方を探す（見つかったものの説明の配列。無ければ空）。
 * - ファイルに項目が 1 つも無い（include 先が空だと GitLab はパイプラインを作らない）
 * - 中身の無いジョブ（「jobs:<名前> config can't be blank」。0.2.0〜0.2.1 のひな形 .yojitsu-navi-local: {} もこれ）
 * - 中身の無い全体の設定（variables: だけ など）
 * definedElsewhere: ほかの CI 定義で中身つきで書いた項目の名前（GitLab は include を合わせてから確かめるので、それは空でも失敗にならない）。
 * ただし main（.gitlab-ci.yml。合わせるとき勝つ）の null・空は include の中身を消すので、{} 以外は除かない
 */
export function lintCiYaml(text, file, definedElsewhere = new Set(), main = false) {
  const ls = lines(text);
  const top = blocks(ls, 0, ls.length, 0);
  const out = [];
  if (!top.length) out.push(`${file}: 設定が 1 つもありません（空のファイルは GitLab が include できず、パイプラインが作られません）`);
  for (const b of top) {
    // 同じ名前の項目をほかの CI 定義（include 先・.gitlab-ci.yml）が中身つきで書いていれば、合わせた結果は空でない
    if (!isBlank(ls, b) || (definedElsewhere.has(b.key) && (!main || b.value === "{}"))) continue;
    const fix = b.key === PLACEHOLDER_KEY ? "。yojitsu-navi update か yojitsu-navi migrate-ci で直ります" : "";
    if (GLOBAL_KEYS.has(b.key)) {
      if (b.value !== "{}") out.push(`${file} ${b.start + 1} 行目: ${b.key}: の中身がありません（GitLab が失敗にします。要らなければ行ごと消す）`);
    } else out.push(`${file} ${b.start + 1} 行目: ジョブ ${b.key} の中身がありません（GitLab が「jobs:${b.key} config can't be blank」で失敗にします）${fix}`);
  }
  return out;
}

/** 中身のある一番上の項目の名前（lintCiYaml の definedElsewhere に渡す） */
export function filledKeys(text) {
  const ls = lines(text);
  return blocks(ls, 0, ls.length, 0)
    .filter((b) => !isBlank(ls, b))
    .map((b) => b.key);
}

/** 0.2.0〜0.2.1 のひな形の行を直す（直す必要が無ければ同じ文字列を返す） */
export function repairLocalPlaceholder(text) {
  const ls = lines(text);
  const b = blocks(ls, 0, ls.length, 0).find((x) => x.key === PLACEHOLDER_KEY);
  if (!b || !isBlank(ls, b) || !BAD_PLACEHOLDER.test(ls[b.start])) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  ls.splice(b.start, 1, ...PLACEHOLDER.split("\n"));
  return ls.join(eol);
}

/** 改行を LF にした中身の SHA-256（Windows の CRLF でも同じ値） */
export const ciHash = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

/** .gitlab-ci.local.yml の印（migrate-ci が移したときの .gitlab-ci.yml のハッシュ。無ければ ""） */
export function migratedHash(localText) {
  return MARKER.exec(localText ?? "")?.[1] ?? "";
}

/**
 * ls の path（["build", "variables"] など）の項目を探す。無ければ null
 */
function findPath(ls, path) {
  let range = { start: -1, end: ls.length, indent: 0 };
  let found = null;
  for (const key of path) {
    const list = found ? children(ls, found) : blocks(ls, range.start + 1, range.end, range.indent);
    found = list.find((b) => b.key === key) ?? null;
    if (!found) return null;
  }
  return found;
}

/** text の字下げを足す */
const indentLines = (ls, n) => ls.map((l) => (l === "" ? l : " ".repeat(n) + l));

/**
 * 移すもの 1 つを .gitlab-ci.local.yml の行に入れる。
 * 返す: "added"（足した）・"same"（同じものがもうある）・"conflict"（同じ名前で違う中身がある）
 */
function place(ls, path, entry) {
  const key = /^("[^"]*"|'[^']*'|[^:]+):/.exec(entry[0])?.[1];
  const name = key ? unquoteKey(key.trim()) : "";
  // 一番深い、もうある親を探す
  let depth = path.length;
  let parent = null;
  while (depth > 0 && !(parent = findPath(ls, path.slice(0, depth)))) depth--;
  if (depth === path.length) {
    const kids = parent ? children(ls, parent) : blocks(ls, 0, ls.length, 0);
    const same = kids.find((b) => b.key === name);
    if (same) return sameBlock(blockText(ls, same), entry) ? "same" : "conflict";
  }
  // 足す: 親の中身の字下げ（無ければ親 + 2）で、無い途中の親の行も作る
  const missing = path.slice(depth);
  let at;
  let ind;
  if (parent) {
    // 同じ行に値がある（variables: { A: 1 } など）ところには行を足せない
    if (parent.value) return "conflict";
    const ci = childIndent(ls, parent);
    ind = ci >= 0 ? ci : indentOf(ls[parent.start]) + 2;
    at = parent.end;
  } else {
    ind = 0;
    // ファイルの最後（最後の空行・コメントは残して、その前ではなく後ろに足す）
    at = ls.length;
    while (at > 0 && ls[at - 1] === "") at--;
  }
  const add = [];
  for (const k of missing) {
    add.push(`${" ".repeat(ind)}${k}:`);
    ind += 2;
  }
  add.push(...indentLines(entry, ind));
  if (!parent && at > 0 && ls[at - 1].trim() !== "") add.unshift("");
  ls.splice(at, 0, ...add);
  return "added";
}

/**
 * 社内で直した .gitlab-ci.yml（current）を、もとの版（base。init・update が入れたもの。分からなければ新しい版）と比べ、
 * ランナーのタグ・変数・社内だけのジョブを .gitlab-ci.local.yml（local）へ移す。
 * - 移すもの: 全ジョブ・default のタグ（tags:）、全体・ジョブの変数のうち base に無いもの、base に無いジョブ・項目
 * - 手で移すもの（manual）: base にある変数の値を変えたもの（.gitlab-ci.yml が勝つので CI/CD 変数にする）、
 *   ジョブの script・rules などの変更、消したジョブ、.gitlab-ci.local.yml に同じ名前で違う中身があるもの
 * force なら手で移すものが残っていても印を書く（update はその社内の変更を捨てて新しい版にする。前のものはバックアップに残る）
 * 返す: { local（移したあとの中身）, moved, same（もうあったもの）, manual, changed（local が変わったか） }
 */
export function migrateCi({ current, base, local, force = false }) {
  const cur = lines(current);
  const bas = lines(base);
  const loc = lines(repairLocalPlaceholder(local ?? ""));
  const moved = [];
  const same = [];
  const manual = [];
  /** @type {{ path: string[], entry: string[], label: string }[]} */
  const items = [];
  const baseTop = new Map(blocks(bas, 0, bas.length, 0).map((b) => [b.key, b]));
  const curTop = blocks(cur, 0, cur.length, 0);
  const curKeys = new Set(curTop.map((b) => b.key));
  // もとの版のアンカー（.normal-rules: &normal-rules など）の中の項目。<<: *名前 で受け継ぐ項目は .gitlab-ci.yml が勝つ
  const anchorKeys = new Map();
  for (const b of baseTop.values()) {
    const m = /^&([\w-]+)/.exec(b.value);
    if (m) anchorKeys.set(m[1], new Set(children(bas, b).map((k) => k.key)));
  }

  for (const b of curTop) {
    const text = blockText(cur, b);
    const bb = baseTop.get(b.key);
    if (!bb) {
      if (b.key === "include") manual.push(`include: の追加（${LOCAL_CI_FILE} の include: に書く）`);
      else items.push({ path: [], entry: text, label: GLOBAL_KEYS.has(b.key) ? `${b.key}:` : `ジョブ ${b.key}` });
      continue;
    }
    if (sameBlock(text, blockText(bas, bb))) continue;
    const curKids = children(cur, b);
    const baseKids = new Map(children(bas, bb).map((k) => [k.key, k]));
    if (b.key === "variables") {
      // 同じ行に書いた変数（variables: { A: "1" }）は読めないので、自動で移さない
      if (b.value || bb.value) {
        manual.push(`variables: の変更（1 行の書き方は読めないので、変わった変数を手で ${LOCAL_CI_FILE}・CI/CD 変数に移す）`);
        continue;
      }
      for (const k of baseKids.keys()) if (!curKids.some((c) => c.key === k)) manual.push(`変数 ${k} を消したこと（${LOCAL_CI_FILE} では消せない。CI/CD 変数で値を変える）`);
      for (const v of curKids) {
        const bv = baseKids.get(v.key);
        if (!bv) items.push({ path: ["variables"], entry: blockText(cur, v), label: `変数 ${v.key}` });
        else if (!sameBlock(blockText(cur, v), blockText(bas, bv))) manual.push(`変数 ${v.key} の値（${LOCAL_CI_FILE} では変えられない。CI/CD 変数に ${v.key} を登録する）`);
      }
      continue;
    }
    if (!curKids.length || !children(bas, bb).length) {
      manual.push(`${b.key}: の変更（${b.key === "image" ? "CI/CD 変数 NODE_IMAGE にする" : "差分は yojitsu-navi update --dry-run"}）`);
      continue;
    }
    const inherited = new Set();
    for (const k of baseKids.values()) if (k.key === "<<") for (const a of k.value.matchAll(/\*([\w-]+)/g)) for (const x of anchorKeys.get(a[1]) ?? []) inherited.add(x);
    for (const k of curKids) {
      const bk = baseKids.get(k.key);
      const ktext = blockText(cur, k);
      if (bk && sameBlock(ktext, blockText(bas, bk))) continue;
      if (k.key === "tags" && !bk) items.push({ path: [b.key], entry: ktext, label: `${b.key} のタグ` });
      else if (k.key === "variables" && (k.value || bk?.value)) {
        manual.push(`${b.key} の variables: の変更（1 行の書き方は読めないので、変わった変数を手で ${LOCAL_CI_FILE}・CI/CD 変数に移す）`);
      } else if (k.key === "variables") {
        const baseVars = new Map(bk ? children(bas, bk).map((v) => [v.key, v]) : []);
        for (const v of children(cur, k)) {
          const bv = baseVars.get(v.key);
          if (!bv) items.push({ path: [b.key, "variables"], entry: blockText(cur, v), label: `${b.key} の変数 ${v.key}` });
          else if (!sameBlock(blockText(cur, v), blockText(bas, bv))) manual.push(`${b.key} の変数 ${v.key} の値（${LOCAL_CI_FILE} では変えられない。CI/CD 変数に ${v.key} を登録する）`);
        }
        const curVars = new Set(children(cur, k).map((v) => v.key));
        for (const name of baseVars.keys()) if (!curVars.has(name)) manual.push(`${b.key} の変数 ${name} を消したこと（${LOCAL_CI_FILE} では消せない。CI/CD 変数で値を変える）`);
      } else if (!bk && inherited.has(k.key)) {
        manual.push(`${b.key} の ${k.key}: の追加（${CI_NAME} の共通の設定（<<:）から受け継ぐ項目で、${LOCAL_CI_FILE} では変えられない）`);
      } else if (!bk) items.push({ path: [b.key], entry: ktext, label: `${b.key} の ${k.key}:` });
      else manual.push(`${b.key} の ${k.key}: の変更（${LOCAL_CI_FILE} では変えられない。差分は yojitsu-navi update --dry-run）`);
    }
    for (const k of baseKids.keys()) if (!curKids.some((c) => c.key === k)) manual.push(`${b.key} の ${k}: を消したこと（${LOCAL_CI_FILE} では消せない）`);
  }
  for (const k of baseTop.keys()) if (!curKeys.has(k)) manual.push(`${GLOBAL_KEYS.has(k) ? `${k}:` : `ジョブ ${k}`} を消したこと（${LOCAL_CI_FILE} では消せない）`);

  for (const it of items) {
    // アンカーはファイルをまたげないので、ほかで定義したアンカーを使う（*名前・<<:）ものは移さない
    const defined = new Set([...it.entry.join("\n").matchAll(/&([\w-]+)/g)].map((m) => m[1]));
    const used = [...it.entry.join("\n").matchAll(/(?:^|[\s[{,:])\*([A-Za-z0-9_-]+)/gm)].map((m) => m[1]).filter((a) => !defined.has(a));
    if (used.length) {
      manual.push(`${it.label}（${CI_NAME} のアンカー *${used[0]} を使っているので自動で移せない。中身を展開して ${LOCAL_CI_FILE} に書く）`);
      continue;
    }
    const r = place(loc, it.path, it.entry);
    if (r === "added") moved.push(it.label);
    else if (r === "same") same.push(it.label);
    else manual.push(`${it.label}（${LOCAL_CI_FILE} に同じ名前で違う中身があります。どちらにするか決めて手で直す）`);
  }
  // 項目が 1 つも無いと GitLab が include できないので、何もしない項目を足す
  if (!blocks(loc, 0, loc.length, 0).length) place(loc, [], PLACEHOLDER.split("\n"));
  const eol = (local ?? "").includes("\r\n") ? "\r\n" : "\n";
  let text = loc.join("\n");
  // 印を書く・書き直す（手で移すものが残るときは書かない。update は止まったまま）
  text = text.replace(new RegExp(`${MARKER.source}\\n?`, "m"), "");
  if (!manual.length || force) text = `${text.replace(/\n*$/, "\n")}\n# yojitsu-navi migrate-ci: .gitlab-ci.yml sha256=${ciHash(current)}\n`;
  else if (!text.endsWith("\n")) text += "\n";
  if (eol === "\r\n") text = text.replace(/\n/g, "\r\n");
  return { local: text, moved, same, manual, changed: text.replace(/\r\n/g, "\n") !== (local ?? "").replace(/\r\n/g, "\n") };
}
