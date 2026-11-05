// CI 定義（.gitlab-ci.yml）が動くのに要るファイルを、プロジェクトのフォルダから洗い出す（SPEC §85）。Node の標準モジュールだけを使う
//   - script・before_script・after_script のコマンドに書いたファイル（node scripts/ci/install.mjs など）
//   - npm run X → package.json の scripts.X（と preX・postX）に書いたファイル（tsx scripts/build.ts、-c tests/e2e/playwright.config.ts など）
//   - 上のファイルが相対パスで import しているファイル（scripts/ci/install.mjs → scripts/lib/npm.mjs など）を辿った先すべて
//   - npm ci が読む package.json・package-lock.json
//   - include: の local で読み込むファイル（.gitlab-ci.local.yml）と、その中のコマンドが使うファイル
//   - CI 定義と include 先の、GitLab が受け付けない書き方（中身の無いジョブ・空のファイル。scripts/lib/ci-local.mjs、SPEC §91.3）
// init・update・npm run app:build・yojitsu-navi check・npm run ci:check がこれで確かめ、足りなければ止める（CI が「ファイルが無い」で落ちるのを持ち込む前に見つける）
// プロジェクトにも入る（scripts/ci/check.mjs が使う）。yojitsu-navi コマンドには npm run app:build が packages/app/lib に写す
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, normalize, sep } from "node:path";
import { filledKeys, lintCiYaml } from "./ci-local.mjs";

export const CI_FILE = ".gitlab-ci.yml";

const posix = (p) => p.split(sep).join("/");
const CODE = /\.(mjs|cjs|js|mts|cts|ts)$/;
/** コマンドの中のファイルらしい語（拡張子つき。出力先の .xml などは見ない） */
const FILE_TOKEN = /(?:^|[\s=:"'])((?:\.\/)?[\w@.-]+(?:\/[\w@.-]+)*\.(?:mjs|cjs|js|mts|cts|ts|json|ya?ml))(?=$|[\s"'])/g;

/** .gitlab-ci.yml の script・before_script・after_script のコマンド（1 行 1 コマンド。コメントは除く） */
export function ciCommands(yml) {
  const cmds = [];
  let indent = -1;
  for (const line of yml.split(/\r?\n/)) {
    const m = /^(\s*)(?:before_|after_)?script:\s*(.*)$/.exec(line);
    if (m) {
      indent = m[1].length;
      const inline = m[2].trim();
      // script: ["a", "b"] や script: a の形
      if (inline && inline !== "[]") {
        for (const c of inline.replace(/^\[|\]$/g, "").split(",")) if (c.trim()) cmds.push(unquote(c.trim()));
        indent = -1;
      }
      continue;
    }
    if (indent < 0 || line.trim() === "" || /^\s*#/.test(line)) continue;
    const item = /^(\s*)- (.*)$/.exec(line);
    if (item && item[1].length >= indent) cmds.push(unquote(item[2].trim()));
    else indent = -1;
  }
  return cmds;
}

/** include: の local のファイル（- local: a.yml・local: "/a.yml"）。社内の設定 .gitlab-ci.local.yml など（SPEC §91.1） */
export function ciLocalIncludes(yml) {
  const out = [];
  for (const m of yml.matchAll(/^[ \t]*(?:-[ \t]+)?local:[ \t]*["']?([^"'\s#]+)["']?/gm)) out.push(m[1].replace(/^\/+/, ""));
  return [...new Set(out)];
}

function unquote(s) {
  return /^(["']).*\1$/.test(s) ? s.slice(1, -1) : s;
}

/** コマンドに書かれた npm run の名前 */
const npmRuns = (cmd) => [...cmd.matchAll(/\bnpm run(?:-script)? ([\w:.-]+)/g)].map((m) => m[1]);

/** コード（.mjs・.ts など）が相対パスで読み込むファイル。.js と書いて .ts を読む TypeScript の書き方も辿る */
function relativeImports(projectDir, file) {
  let text;
  try {
    text = readFileSync(join(projectDir, file), "utf-8");
  } catch {
    return [];
  }
  const out = [];
  const re = /\b(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of text.matchAll(re)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
    const base = posix(normalize(join(dirname(file), spec)));
    if (base.startsWith("../")) continue;
    const candidates = [base, base.replace(/\.js$/, ".ts"), base.replace(/\.mjs$/, ".mts"), `${base}.ts`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`];
    out.push(candidates.find((c) => isFile(join(projectDir, c))) ?? base);
  }
  return out;
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * CI が動くのに要るファイル（プロジェクトからの相対パス、/ 区切り）。
 * 返す: { files: 要るファイル（並べ替え済み）, missingScripts: CI が npm run するのに package.json に無いスクリプト名, definitions: CI 定義のファイル（.gitlab-ci.yml と include 先） }
 */
export function ciRequiredFiles(projectDir) {
  const files = new Set([CI_FILE]);
  const missingScripts = new Set();
  const yml = existsSync(join(projectDir, CI_FILE)) ? readFileSync(join(projectDir, CI_FILE), "utf-8") : "";
  let scripts = {};
  try {
    scripts = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8")).scripts ?? {};
  } catch {
    // package.json が無い・壊れている → 下で package.json が足りないと出る
  }
  // include したファイルも CI 定義の一部（無いとパイプラインが作られない。中のコマンドも辿る）
  // include 先がさらに include していても辿る（同じファイルは 1 回だけ）
  const cmds = ciCommands(yml);
  const includes = [...ciLocalIncludes(yml)];
  const seenInc = new Set([CI_FILE]);
  while (includes.length) {
    const inc = includes.shift();
    if (seenInc.has(inc)) continue;
    seenInc.add(inc);
    files.add(inc);
    if (!isFile(join(projectDir, inc))) continue;
    const text = readFileSync(join(projectDir, inc), "utf-8");
    cmds.push(...ciCommands(text));
    includes.push(...ciLocalIncludes(text));
  }
  if (cmds.some((c) => /\bnpm (ci|install|run)\b/.test(c) || /\bnpx\b/.test(c)) || cmds.some((c) => /scripts\/ci\/install\.mjs/.test(c))) {
    files.add("package.json");
    files.add("package-lock.json");
  }
  // コマンド → npm run の中身 → コードの読み込み（と、CI 用のスクリプトが中で npm run するもの）を、増えなくなるまで辿る
  const seenRuns = new Set();
  const seenCode = new Set();
  const queue = [...cmds];
  const runScript = (name) => {
    if (seenRuns.has(name)) return;
    seenRuns.add(name);
    if (!(name in scripts)) {
      missingScripts.add(name);
      return;
    }
    for (const n of [`pre${name}`, name, `post${name}`]) if (typeof scripts[n] === "string") queue.push(scripts[n]);
  };
  for (;;) {
    while (queue.length) {
      const cmd = queue.shift();
      for (const m of cmd.matchAll(FILE_TOKEN)) files.add(m[1].replace(/^\.\//, ""));
      for (const name of npmRuns(cmd)) runScript(name);
      // npx vitest は vitest.config.* を読む（あれば）
      if (/\bvitest\b/.test(cmd)) for (const f of ["vitest.config.ts", "vitest.config.mts", "vitest.config.js", "vitest.config.mjs"]) if (isFile(join(projectDir, f))) files.add(f);
    }
    const code = [...files].filter((f) => CODE.test(f) && !seenCode.has(f));
    if (!code.length) break;
    for (const f of code) {
      seenCode.add(f);
      for (const dep of relativeImports(projectDir, f)) files.add(dep);
      // CI 用のスクリプト（scripts/ci/）が中で npm run するもの: npm(["run", "validate"]) や、表の script: "fetch"
      if (f.startsWith("scripts/ci/") && isFile(join(projectDir, f))) {
        const text = readFileSync(join(projectDir, f), "utf-8");
        for (const m of text.matchAll(/["']run["']\s*,\s*["']([\w:.-]+)["']|\bscript:\s*["']([\w:.-]+)["']/g)) runScript(m[1] ?? m[2]);
      }
    }
  }
  return { files: [...files].sort(), missingScripts: [...missingScripts].sort(), definitions: [...seenInc] };
}

/** 今のコミット（HEAD）に入っているファイル（プロジェクトからの相対パス、/ 区切り）。git のリポジトリでない・コミットが無いなら null。
 * 追加しただけ（git add のみ）のファイルは push しても CI から見えないので、index ではなくコミットを見る */
function gitCommitted(projectDir) {
  // ls-tree はプロジェクトがリポジトリのサブフォルダでも、そのフォルダからの相対パスで返す
  const r = spawnSync("git", ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", "."], { cwd: projectDir, encoding: "utf-8" });
  if (r.status !== 0) return null;
  return new Set(r.stdout.split("\0").filter(Boolean));
}

/**
 * CI 定義と、プロジェクトのファイルが揃っているか。
 * 返す: { required, missing: フォルダに無い, untracked: フォルダにはあるが git にコミットされていない（push しても CI から見えない）, missingScripts,
 *   invalid: CI 定義（.gitlab-ci.yml と include 先の .yml）の GitLab が受け付けない書き方 }
 * @param {{ git?: boolean }} [o] git: false なら git の管理は見ない
 */
export function checkCiFiles(projectDir, o = {}) {
  const { files, missingScripts, definitions } = ciRequiredFiles(projectDir);
  const missing = files.filter((f) => !isFile(join(projectDir, f)));
  let untracked = [];
  if (o.git !== false) {
    const committed = gitCommitted(projectDir);
    if (committed) untracked = files.filter((f) => !missing.includes(f) && !committed.has(f));
  }
  // GitLab は include を合わせてから確かめるので、ほかの定義が中身つきで書いた項目は空でもよい
  const defs = definitions.filter((f) => isFile(join(projectDir, f))).map((f) => ({ f, text: readFileSync(join(projectDir, f), "utf-8") }));
  const invalid = defs.flatMap(({ f, text }) => lintCiYaml(text, f, new Set(defs.filter((d) => d.f !== f).flatMap((d) => filledKeys(d.text))), f === CI_FILE));
  return { required: files, missing, untracked, missingScripts, invalid };
}

/** checkCiFiles の結果を、足りないものだけの文章にする（揃っていれば ""） */
export function describeCiProblems(r) {
  const parts = [];
  if (r.missing.length) parts.push(`CI（${CI_FILE}）が使うファイルがありません:\n${r.missing.map((f) => `  ${f}`).join("\n")}`);
  if (r.untracked.length) parts.push(`CI（${CI_FILE}）が使うファイルが git にコミットされていません（push しても CI から見えません。git の除外設定を確かめてください）:\n${r.untracked.map((f) => `  ${f}`).join("\n")}`);
  if (r.invalid?.length) parts.push(`CI の設定に GitLab が受け付けない書き方があります（パイプラインが作られません）:\n${r.invalid.map((s) => `  ${s}`).join("\n")}`);
  if (r.missingScripts.length) parts.push(`CI（${CI_FILE}）が npm run するスクリプトが package.json にありません:\n${r.missingScripts.map((s) => `  ${s}`).join("\n")}`);
  return parts.join("\n");
}

