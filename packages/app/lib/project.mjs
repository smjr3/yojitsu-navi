// yojitsu-navi コマンドの中身（init・update・接続先の設定）。Node の標準モジュールだけを使う（SPEC §44）
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, sep } from "node:path";
import { cwd } from "node:process";
import { CHANGELOG, updateNotes } from "./changelog.mjs";
import { CI_FILE, checkCiFiles, describeCiProblems } from "./ci-files.mjs";
import { ciHash, migrateCi, migratedHash, repairLocalPlaceholder } from "./ci-local.mjs";
import { checkConfig, formatConfigIssues, parseConfigText } from "./config-schema.mjs";
import { compareVersion } from "./version.mjs";

export { compareVersion };

/** 持ち込み先のプロジェクトに置く、どの版のどのファイルを入れたかの記録 */
export const MANIFEST = ".yojitsu-navi.json";
/** 依存込みパッケージの npm キャッシュの置き場（.gitlab-ci.yml がこれを見て npm ci --offline する） */
export const VENDOR_CACHE = "vendor/npm-cache";

/** update が上書きする前のファイルを写しておく置き場（git には入れない。.gitignore にもある） */
export const BACKUP_DIR = ".yojitsu-navi-backup";
/** upgrade などのログの置き場（git には入れない。.gitignore にもある。SPEC §94） */
export const LOG_DIR = ".yojitsu-navi-log";

/** サンプルのデータの置き場（パッケージの中。data/ と同じ並び。init --sample のときだけ入れる。SPEC §93） */
export const SAMPLE_DIR = "sample";

/**
 * 社内の CI の設定を書くファイル（SPEC §91.1）。.gitlab-ci.yml が include する。ランナーのタグ・社内レジストリ・証明書など、
 * .gitlab-ci.yml を直さずに足す・上書きする設定はここに書く。パッケージには中身の無いひな形が入り、update は無いときだけ足す
 */
export const LOCAL_CI_FILE = ".gitlab-ci.local.yml";
/** npm の設定（社内レジストリの URL・認証・証明書）。パッケージには入れない。社内で置いたら update は触らない */
export const NPMRC = ".npmrc";

/** 社内で書き換えるファイル。update は触らない（消さない。足すのは LOCAL_CI_FILE が無いときだけ） */
export function isUserOwned(path) {
  return path === "config.json" || path.startsWith("data/") || path === LOCAL_CI_FILE || path === NPMRC;
}

/**
 * update でのファイルの扱い（SPEC §91。docs/DEPLOY_GITLAB.md「新しい版にする」の表と同じ）。
 * - keep: 社内のもの。触らない（config.json・data/ 以下すべて・.gitlab-ci.local.yml・.npmrc。.gitlab-ci.local.yml は無ければひな形を足す）
 * - vendor: 依存込みのとき、パッケージのもので丸ごと入れ替える（vendor/npm-cache/）
 * - tool: コマンドが書く・使う（.yojitsu-navi.json・.yojitsu-navi-backup/・.yojitsu-navi-log/）
 * - package: それ以外。パッケージの版にする（社内で変えていたら止まる）。パッケージに無く、前の版の記録にも無いファイルは社内で足したものとして触らない
 */
export function fileKind(path) {
  if (isUserOwned(path)) return "keep";
  if (path === VENDOR_CACHE || path.startsWith(`${VENDOR_CACHE}/`)) return "vendor";
  if (path === MANIFEST || [BACKUP_DIR, LOG_DIR].some((d) => path === d || path.startsWith(`${d}/`))) return "tool";
  return "package";
}

export class CliError extends Error {}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
/** 中身が同じか（テキストは改行 CRLF と LF の違いを見ない。Windows で core.autocrlf のまま取り出したファイルを「変えた」としない） */
const lf = (buf) => (buf.includes(0) ? buf : Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n"), "latin1"));
const sameContent = (a, b) => a.equals(b) || lf(a).equals(lf(b));
/** 記録したハッシュ（コマンドが入れたときの中身）と同じか */
const matchesHash = (buf, hash) => sha(buf) === hash || sha(lf(buf)) === hash;
const posix = (p) => p.split(sep).join("/");

/** template/ のファイル一覧（プロジェクトでのパス → template 内の実パス）。_gitignore は .gitignore に戻す */
export function readTemplate(templateDir) {
  const files = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else files.set(posix(relative(templateDir, abs)).replace(/(^|\/)_gitignore$/, "$1.gitignore"), abs);
    }
  };
  walk(templateDir);
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * 社内 GitLab の URL とプロジェクトを、config.json に入れる形にする。両方空なら null。
 * url は https://gitlab.example.local でも …/api/v4 でもよい。project は「グループ/プロジェクト」
 */
export function normalizeGitlab(url, project) {
  const u = String(url ?? "").trim().replace(/\/+$/, "");
  const p = String(project ?? "").trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (u === "" && p === "") return null;
  if (u === "") throw new CliError("--gitlab（社内 GitLab の URL。例 https://gitlab.example.local）も指定してください");
  if (p === "") throw new CliError("--project（グループ/プロジェクト。例 yojitsu-navi/yojitsu-navi）も指定してください");
  if (!/^https?:\/\/[^/\s]+/.test(u)) throw new CliError(`--gitlab は http(s):// から始まる URL にしてください（今: ${u}）`);
  if (!/^[^/\s]+(\/[^/\s]+)+$/.test(p)) throw new CliError(`--project は「グループ/プロジェクト」の形にしてください（今: ${p}）`);
  const web = u.replace(/\/api\/v4$/, "");
  return { webUrl: web, apiBaseUrl: `${web}/api/v4`, projectId: p, remoteUrl: `${web}/${p}.git` };
}

/** git remote の URL（https）から社内 GitLab の URL とプロジェクトを読む。読めなければ null */
export function gitlabFromRemote(remote) {
  const m = /^(https?:\/\/[^/\s]+)\/(.+?)(?:\.git)?\/?$/.exec(String(remote ?? "").trim().replace(/\/\/[^@/]*@/, "//"));
  if (!m || !m[2].includes("/")) return null;
  return normalizeGitlab(m[1], m[2]);
}

/** config.json の masterEdit.gitlab の apiBaseUrl・projectId だけを書き換える（ほかの書式は変えない） */
export function applyGitlabTarget(configText, gitlab) {
  let text = configText;
  for (const [key, value] of [["apiBaseUrl", gitlab.apiBaseUrl], ["projectId", gitlab.projectId]]) {
    const re = new RegExp(`("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`);
    if (!re.test(text)) throw new CliError(`config.json に masterEdit.gitlab.${key} がありません`);
    text = text.replace(re, `$1${JSON.stringify(value)}`);
  }
  const g = JSON.parse(text).masterEdit?.gitlab;
  if (g?.apiBaseUrl !== gitlab.apiBaseUrl || g?.projectId !== gitlab.projectId) throw new CliError("config.json の接続先を書き換えられませんでした");
  return text;
}

/** config.json の接続先（未設定なら null） */
export function readGitlabTarget(projectDir) {
  try {
    const g = JSON.parse(readFileSync(join(projectDir, "config.json"), "utf-8")).masterEdit?.gitlab ?? {};
    const api = String(g.apiBaseUrl ?? "").trim();
    const project = String(g.projectId ?? "").trim();
    return api && project ? normalizeGitlab(api, project) : null;
  } catch {
    return null;
  }
}

/** a にあって b に無い設定の項目（"masterEdit.gitlab.commitMode" の形）。配列の中は見ない */
export function missingConfigKeys(a, b, prefix = "") {
  const out = [];
  if (!a || typeof a !== "object" || Array.isArray(a)) return out;
  for (const [k, v] of Object.entries(a)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (!b || typeof b !== "object" || !(k in b)) out.push(path);
    else out.push(...missingConfigKeys(v, b[k], path));
  }
  return out;
}

function git(cwd, args, input) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", input });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() || String(r.error ?? "") };
}

/** コミットしていない変更・新しいファイルのパス（git status。名前を引用符で囲まないよう -z で読む） */
function gitStatusPaths(dir, pathspec = []) {
  // git() は前後の空白を落とすので使わない（先頭の「 M」の空白が要る）
  const r = spawnSync("git", ["status", "--porcelain", "-z", "--untracked-files=all", ...pathspec], { cwd: dir, encoding: "utf-8" });
  const parts = (r.stdout ?? "").split("\0").filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    out.push(parts[i].slice(3));
    // 名前の変更は「新しい名前\0前の名前」の 2 つ
    if (/^[RC]/.test(parts[i])) i++;
  }
  return out;
}

/** git が管理する・管理していない（除外設定に当たらない）ファイル */
function gitFiles(dir) {
  return git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).out.split("\0").filter(Boolean);
}

/**
 * パッケージのファイルを git に入れる。git add -A に加えて、git の除外設定（PC 全体の core.excludesFile など）に
 * 当たるファイルも -f で入れる（入らないと push しても CI から見えず、「ファイルが無い」で落ちる）
 */
function gitAddPackageFiles(dir, files, pathspec = []) {
  git(dir, ["add", "-A", ...pathspec]);
  if (files.length) git(dir, ["add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], `${files.join("\0")}\0`);
}

/** CI 定義（.gitlab-ci.yml）が使うファイルが揃っていなければ止める（SPEC §85）。CI 定義の無いパッケージ（テスト用）では見ない */
function assertCiFiles(dir, template, useGit) {
  if (!template.has(CI_FILE)) return;
  const problems = describeCiProblems(checkCiFiles(dir, { git: useGit }));
  if (problems) throw new CliError(`${problems}\nこのままでは GitLab の CI が失敗します。直してから push してください（確かめ直すには yojitsu-navi check）`);
}

/** 今あるプロジェクトで、CI 定義が使うファイルが揃っているか確かめる（yojitsu-navi check） */
export function check(o) {
  const { dir, log } = o;
  if (!existsSync(join(dir, CI_FILE))) throw new CliError(`${dir} に ${CI_FILE} がありません。予実ナビのプロジェクトのフォルダで実行してください`);
  const r = checkCiFiles(dir, { git: o.git === false ? false : isGitRepo(dir) });
  const problems = describeCiProblems(r);
  if (problems) throw new CliError(problems);
  log(`CI（.gitlab-ci.yml）が使う ${r.required.length} ファイルは揃っています`);
  return r;
}

const isGitRepo = (dir) => git(dir, ["rev-parse", "--is-inside-work-tree"]).out === "true";

function copyCache(pkgDir, projectDir) {
  const from = join(pkgDir, "deps", "npm-cache");
  if (!existsSync(from)) return false;
  rmSync(join(projectDir, VENDOR_CACHE), { recursive: true, force: true });
  mkdirSync(join(projectDir, VENDOR_CACHE), { recursive: true });
  cpSync(from, join(projectDir, VENDOR_CACHE), { recursive: true });
  return true;
}

/**
 * 記録を書く。files は「パス → コマンドが入れた中身（Buffer）か、その SHA-256」。
 * kept は社内の版を残すと決めたファイル（update --keep-local。次の update でも止まらずに残す）
 */
function writeManifest(projectDir, version, files, kept = []) {
  const hashes = {};
  for (const [f, v] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) hashes[f] = typeof v === "string" ? v : sha(v);
  const body = { version, files: hashes };
  if (kept.length) body.kept = [...kept].sort();
  writeFileSync(join(projectDir, MANIFEST), `${JSON.stringify(body, null, 2)}\n`);
}


/**
 * パッケージのサンプルのデータ（プロジェクトでのパス data/… → パッケージ内の実パス）。サンプルの無いパッケージでは空
 */
export function readSample(pkgDir) {
  const dir = join(pkgDir, SAMPLE_DIR);
  return existsSync(dir) ? readTemplate(dir) : new Map();
}

/**
 * プロジェクトの data/ のうち、パッケージのサンプルと中身が同じファイル（サンプルのまま残っているもの）。
 * サンプルを除いた空の data/（template）と同じものは除く（祝日など、もともと利用環境でも使うもの）
 */
export function sampleLeftovers(pkgDir, dir, template = readTemplate(join(pkgDir, "template"))) {
  const out = [];
  for (const [f, abs] of readSample(pkgDir)) {
    const to = join(dir, f);
    if (!existsSync(to)) continue;
    const cur = readFileSync(to);
    if (!sameContent(cur, readFileSync(abs))) continue;
    const starter = template.get(f);
    if (starter && sameContent(cur, readFileSync(starter))) continue;
    out.push(f);
  }
  return out;
}

/**
 * 新しいプロジェクトのフォルダを作る。data/ は空（見出しの行だけ）。sample なら試す用のサンプルのデータを入れる（SPEC §93）
 * @param {{ pkgDir: string, version: string, dir: string, gitlab?: ReturnType<typeof normalizeGitlab>, git?: boolean, sample?: boolean, log: (s: string) => void }} o
 */
export function init(o) {
  const { pkgDir, version, dir, log } = o;
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new CliError(`${dir} は空ではありません。新しいフォルダ名を指定してください（今あるプロジェクトを新しい版にするときは update）`);
  const template = readTemplate(join(pkgDir, "template"));
  mkdirSync(dir, { recursive: true });
  const files = new Map(template);
  if (o.sample) {
    const sample = readSample(pkgDir);
    if (!sample.size) throw new CliError("このパッケージにはサンプルのデータが入っていません（--sample なしで作ってください）");
    for (const [f, abs] of sample) files.set(f, abs);
  }
  for (const [f, abs] of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(abs, join(dir, f));
  }
  const gitlab = o.gitlab ?? readGitlabTarget(dir);
  if (o.gitlab) writeFileSync(join(dir, "config.json"), applyGitlabTarget(readFileSync(join(dir, "config.json"), "utf-8"), o.gitlab));
  const withDeps = copyCache(pkgDir, dir);
  writeManifest(dir, version, [...files.keys()].map((f) => [f, readFileSync(join(dir, f))]));
  log(`予実ナビ ${version} を ${dir} に作りました（${files.size} ファイル${withDeps ? "、依存込み" : ""}）`);
  log(o.sample ? "data/ にはサンプル（架空の会社のデータ）が入っています。本番のデータを入れる前に、作業実績（data/worklogs/）を含めて置き換えてください" : "data/ は空です（見出しの行だけ）。docs/DATA.md を見て本番のデータを入れてください（試すだけなら init --sample でサンプル入りを作れます）");
  if (gitlab) log(`接続先: ${gitlab.webUrl} の ${gitlab.projectId}`);

  let repo = false;
  let committed = false;
  if (o.git !== false) {
    if (!git(dir, ["--version"]).ok) log("git が見つからないので、git の準備は飛ばしました");
    else {
      if (!git(dir, ["init", "-q", "-b", "main"]).ok) {
        git(dir, ["init", "-q"]);
        git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      }
      repo = true;
      if (gitlab) git(dir, ["remote", "add", "origin", gitlab.remoteUrl]);
      gitAddPackageFiles(dir, [...files.keys(), MANIFEST]);
      const c = git(dir, ["commit", "-q", "-m", `予実ナビ ${version}`]);
      committed = c.ok;
      if (!c.ok) log(`git commit できませんでした（${c.err.split("\n")[0]}）。git config --global user.name と user.email を設定してから下の手順を続けてください`);
    }
  }
  assertCiFiles(dir, template, committed);
  const remote = gitlab ? gitlab.remoteUrl : "https://<社内GitLab>/<グループ>/<プロジェクト>.git";
  log("");
  log("次に行うこと（詳しくは docs/DEPLOY_GITLAB.md）:");
  log(`  cd ${relative(cwd(), dir) || "."}`);
  if (!repo) log("  git init -b main");
  if (!repo || !gitlab) log(`  git remote add origin ${remote}`);
  if (!committed) log(`  git add -A && git commit -m "予実ナビ ${version}"`);
  log("  git push -u origin main");
  log("  yojitsu-navi gitlab-setup --apply   （Owner か Maintainer のトークンを聞かれます）");
  return { files: files.size, withDeps, committed, sample: Boolean(o.sample) };
}

/** 日時をフォルダ名にする（ローカル時刻の YYYYMMDD-HHMMSS。ロケールによらない。Windows で使えない「:」を使わない） */
export function backupStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** git の差分（git が無ければ null）。a・b はファイルのパス（無いときは null）。表示のパスは label */
function unifiedDiff(a, b, label, tmp) {
  const empty = join(tmp, "empty");
  if (!existsSync(empty)) writeFileSync(empty, "");
  const r = spawnSync("git", ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", a ?? empty, b ?? empty], { encoding: "utf-8" });
  if (r.error || (r.status !== 0 && r.status !== 1)) return null;
  // 一時フォルダのパスを、プロジェクトでのパスに置き換える（a/ が社内の今のファイル、b/ が新しい版）
  return r.stdout
    .split("\n")
    .map((l) => (/^diff --git /.test(l) ? `diff --git a/${label} b/${label}` : l.startsWith("--- ") ? (a ? `--- a/${label}` : "--- /dev/null") : l.startsWith("+++ ") ? (b ? `+++ b/${label}` : "+++ /dev/null") : l))
    .join("\n")
    .trimEnd();
}

/** 変更履歴から読んだ、導入先で行うこと（無ければ何も出さない） */
function logNotes(log, detail, notes, from, to) {
  if (!notes.length) return;
  log(`\n${from} → ${to} で導入先が行うこと・前提が変わること: ${notes.length} 行（${CHANGELOG} から。全体は ${CHANGELOG}）`);
  detail(notes.map((l) => `  ${l}`).join("\n"));
}

/**
 * config.json が新しい版で動くか（SPEC §96）。読めないときもエラーにする。
 * @returns {{ errors: number, warnings: number, lines: string[] }}
 */
export function configCompat(dir) {
  const path = join(dir, "config.json");
  if (!existsSync(path)) return { errors: 1, warnings: 0, lines: ["  - config.json がありません"] };
  const r = parseConfigText(readFileSync(path, "utf-8"));
  if (r.error) return { errors: 1, warnings: 0, lines: [`  - ${r.error}`] };
  const issues = checkConfig(r.config);
  const errors = issues.filter((i) => i.level === "error").length;
  return { errors, warnings: issues.length - errors, lines: formatConfigIssues(issues) };
}

/** 互換確認の結果を出す。エラーは画面に、注意の中身は詳しい行に */
function reportConfig(log, detail, c, version) {
  if (!c.errors && !c.warnings) {
    log(`config.json の互換確認: ${version} でそのまま動きます（直すところはありません）`);
    return;
  }
  if (c.errors) {
    log(`config.json の互換確認: ${version} で直すところがあります（エラー ${c.errors}・注意 ${c.warnings}。直すまで npm run validate と CI の build が止まります。docs/DATA.md）`);
    log(c.lines.join("\n"));
    return;
  }
  log(`config.json の互換確認: ${version} で動きます（注意 ${c.warnings}。止めません）`);
  detail(c.lines.join("\n"));
}

const CONFLICT_LABEL = { modified: "社内で変更", created: "社内で作成", removedModified: "新しい版で削除（社内で変更）" };

/**
 * 今あるプロジェクトを、このパッケージの版に入れ替える（SPEC §44・§91）。
 * - data/ と config.json は変えない。それ以外は新しい版にし、前の版の記録にあって新しい版に無いファイルは消す
 * - 上書き・削除するファイルに社内の変更（前の版の記録と中身が違う・同じ名前で作った）があれば、何も変えずに止まる。
 *   overwrite で新しい版にする、keepLocal で社内の版を残す（次の update でも残す）
 * - 上書き・削除する前のファイルは .yojitsu-navi-backup/<日時>/ に写す
 * - dryRun は何も変えず、変わるファイルの一覧と、社内の変更があるファイルの差分（社内の今 → 新しい版）を出す
 * - commit が false（--no-commit）ならブランチを作らず、コミットもしない（変更は git add までする）
 * - detail は詳しい行（ファイルの一覧・差分・変更履歴）。--summary のときは画面に出さずログのファイルにだけ書く（SPEC §94）
 * @param {{ pkgDir: string, version: string, dir: string, force?: boolean, overwrite?: boolean, keepLocal?: boolean, dryRun?: boolean, git?: boolean, commit?: boolean, now?: Date, log: (s: string) => void, detail?: (s: string) => void }} o
 */
export function update(o) {
  const { pkgDir, version, dir, log } = o;
  const detail = o.detail ?? log;
  if (o.overwrite && o.keepLocal) throw new CliError("--overwrite と --keep-local はどちらか 1 つにしてください");
  const manifestPath = join(dir, MANIFEST);
  if (!existsSync(manifestPath)) throw new CliError(`${dir} に ${MANIFEST} がありません。yojitsu-navi init で作ったプロジェクトのフォルダで実行してください`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const old = manifest.files ?? {};
  const keptBefore = new Set(manifest.kept ?? []);
  const dry = Boolean(o.dryRun);
  if (compareVersion(version, manifest.version) < 0 && !o.force && !dry) throw new CliError(`今のプロジェクト（${manifest.version}）より古い版（${version}）です。戻すときは --force`);
  const useGit = o.git !== false && isGitRepo(dir);
  // バックアップの置き場は git の外（.gitignore が古い版でも「コミットしていない変更」にしない）
  // --log で指定したプロジェクトの中のファイル（先に書き始めるので、変更・コミットに数えない）
  const excludeExtra = (o.exclude ?? []).map((p) => posix(relative(dir, p))).filter((p) => p && !p.startsWith("..") && !/^[A-Za-z]:/.test(p));
  const outsideBackup = ["--", ".", `:(exclude)${BACKUP_DIR}`, `:(exclude)${LOG_DIR}`, ...excludeExtra.map((p) => `:(exclude,literal)${p}`)];
  if (useGit && !dry && !o.force) {
    // .gitlab-ci.local.yml だけは、変更履歴の手順どおり update の前に作った・直したものとして止めない（update のコミットに入る）。
    // .npmrc は社内レジストリのトークンが入ることがあるので、コミットに入れないよう止める（SPEC §94）
    const dirty = gitStatusPaths(dir, outsideBackup).filter((p) => p !== LOCAL_CI_FILE);
    if (dirty.length) throw new CliError(`コミットしていない変更があります。コミットするか取り消してから実行してください（差分を MR で確かめられるように）:\n${dirty.map((p) => `  ${p}`).join("\n")}`);
  }
  const hasVendor = existsSync(join(dir, VENDOR_CACHE));
  const pkgHasDeps = existsSync(join(pkgDir, "deps", "npm-cache"));
  if (hasVendor && !pkgHasDeps && !o.force && !dry) throw new CliError(`このプロジェクトは依存込み（${VENDOR_CACHE}）です。依存込みのパッケージ（yojitsu-navi-<版>-with-deps.tgz）で update してください`);

  // 1. 何をするかを決める（ここではまだ何も変えない）
  const template = readTemplate(join(pkgDir, "template"));
  const writes = []; // { f, next, kind: "changed" | "added" }
  const deletes = []; // f
  const conflicts = []; // { f, type, next? }
  const notAdded = [];
  /** 記録に書くもの（パス → コマンドが入れた中身のハッシュ） */
  const record = new Map();
  /** 社内の版を残すファイル（--keep-local。前に残すと決めたものは、新しい版と中身が同じになっても次の版のために覚えておく） */
  const kept = [];
  let repairedLocal = false;
  let migratedCi = false;
  /** migrate-ci が社内の設定を .gitlab-ci.local.yml へ移したときの .gitlab-ci.yml の中身（同じなら止めずに新しい版にする。SPEC §91.4） */
  const migrated = existsSync(join(dir, LOCAL_CI_FILE)) ? migratedHash(readFileSync(join(dir, LOCAL_CI_FILE), "utf-8")) : "";
  for (const [f, abs] of template) {
    const to = join(dir, f);
    if (fileKind(f) !== "package") {
      // .gitlab-ci.local.yml は .gitlab-ci.yml が include するので、無ければひな形を足す（無いと CI が動かない）
      if (f === LOCAL_CI_FILE && !existsSync(to)) writes.push({ f, next: readFileSync(abs), kind: "added" });
      // 0.2.0〜0.2.1 のひな形の中身の無い項目（GitLab が「config can't be blank」で失敗にする）は、その行だけ直す（SPEC §91.3）
      else if (f === LOCAL_CI_FILE) {
        const text = readFileSync(to, "utf-8");
        const fixed = repairLocalPlaceholder(text);
        if (fixed !== text) {
          writes.push({ f, next: Buffer.from(fixed, "utf-8"), kind: "changed" });
          repairedLocal = true;
        }
      }
      else if (fileKind(f) === "keep" && !existsSync(to)) notAdded.push(f);
      continue;
    }
    const next = readFileSync(abs);
    const cur = existsSync(to) ? readFileSync(to) : null;
    if (cur && sameContent(cur, next)) {
      record.set(f, sha(next));
      if (keptBefore.has(f) && !o.overwrite) kept.push(f);
      continue;
    }
    const base = old[f];
    // 無くなっていたファイルは入れ直す（git の除外設定でコミットされなかったもの §85 と、社内で消したものは見分けられないので止めない）
    let type = cur ? (base ? (matchesHash(cur, base) ? null : "modified") : "created") : null;
    // 前に社内の版を残すと決めたファイルは、記録と中身が同じでも（新しい版と同じだった版を挟んだとき）社内の版として扱う
    if (!type && cur && keptBefore.has(f)) type = "modified";
    if (type === "modified" && f === CI_FILE && migrated && ciHash(cur.toString("utf-8")) === migrated) {
      writes.push({ f, next, kind: "changed" });
      migratedCi = true;
    } else if (type) conflicts.push({ f, type, next, cur });
    else writes.push({ f, next, kind: cur ? "changed" : "added" });
  }
  for (const f of Object.keys(old)) {
    if (template.has(f) || fileKind(f) !== "package" || !existsSync(join(dir, f))) continue;
    const cur = readFileSync(join(dir, f));
    if (matchesHash(cur, old[f])) deletes.push(f);
    else conflicts.push({ f, type: "removedModified", cur });
  }

  // 社内の変更をどうするか
  const keep = (c) => o.keepLocal || (keptBefore.has(c.f) && !o.overwrite);
  const unresolved = conflicts.filter((c) => !keep(c) && !o.overwrite);
  const keptNow = conflicts.filter(keep);
  const take = conflicts.filter((c) => !keep(c) && o.overwrite);
  for (const c of take) {
    if (c.type === "removedModified") deletes.push(c.f);
    else writes.push({ f: c.f, next: c.next, kind: "changed" });
  }
  // 社内の版を残すファイルは「新しい版の中身を入れた」と記録し、次の update でも社内の変更として見分ける（新しい版で消えたものは記録から外し、社内のファイルにする）
  for (const c of keptNow) {
    if (c.type === "removedModified") continue;
    record.set(c.f, sha(c.next));
    kept.push(c.f);
  }
  for (const w of writes) if (fileKind(w.f) === "package") record.set(w.f, sha(w.next));
  const sortByPath = (a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : 0);
  conflicts.sort(sortByPath);
  writes.sort(sortByPath);
  deletes.sort();

  const changed = writes.filter((w) => w.kind === "changed").map((w) => w.f);
  const added = writes.filter((w) => w.kind === "added").map((w) => w.f);
  const overwritten = take.map((c) => c.f).sort();
  const listConflicts = (cs) => cs.map((c) => `  ${c.f}（${CONFLICT_LABEL[c.type]}）`).join("\n");
  // 作業実績（data/worklogs/）は空の data/ に入っていないので、ここには出てこない（念のため除く）
  const newData = notAdded.filter((f) => !f.startsWith("data/worklogs/"));
  let missing = [];
  let localConfig = null;
  try {
    localConfig = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"));
    missing = missingConfigKeys(JSON.parse(readFileSync(template.get("config.json"), "utf-8")), localConfig);
  } catch {
    // config.json が壊れているときは npm run validate が知らせる
  }
  // config.json の互換確認（SPEC §96）: 新しい版で必須になった項目・型や値の違い・使わなくなった項目だけを見る
  const configCheck = configCompat(dir);
  // サンプルのまま残っているデータ（本番のデータと混ざって集計を誤らないよう知らせる。消すのは yojitsu-navi reset-data か社内で）
  const sampleLeft = sampleLeftovers(pkgDir, dir, template);
  // パッケージに無いファイル（社内で足したもの。触らないが、使われないまま残ったテスト用のデータなどに気づけるよう知らせる。SPEC §94）
  const extras = localExtras(dir, template, old, useGit).filter((f) => !excludeExtra.includes(f));
  // 今の版から新しい版までの変更履歴の「更新後に行うこと」「テスト・CI の前提」「新しい設定と推奨値」（SPEC §91.2）
  const notes = template.has(CHANGELOG) ? updateNotes(readFileSync(template.get(CHANGELOG), "utf-8"), manifest.version, version, localConfig) : [];
  const ciNotes = [
    ...(migratedCi ? [`${CI_FILE}: 社内の設定は migrate-ci で ${LOCAL_CI_FILE} に移してあるので、新しい版にします`] : []),
    ...(repairedLocal ? [`${LOCAL_CI_FILE}: 中身の無い項目（GitLab が「config can't be blank」で失敗にする）を直します（ほかの行は変えません）`] : []),
  ];
  const ciNote = () => {
    if (ciNotes.length) log(ciNotes.join("\n"));
  };
  const base = { changed, added, removed: deletes, migratedCi, repairedLocal, conflicts: conflicts.map((c) => ({ path: c.f, type: c.type })), overwritten, kept, missing, newData, notes, sampleLeft, extras, configCheck };
  /** 一覧（--summary のときは件数だけを画面に出し、一覧はログのファイルに書く） */
  const list = (title, items) => {
    if (!items.length) return;
    log(`${title}: ${items.length} ファイル`);
    detail(items.map((f) => `  ${f}`).join("\n"));
  };
  const reportFound = () => {
    list(`サンプルのまま残っているデータ（本番のデータと混ざらないよう消すか本番のものに置き換える。yojitsu-navi reset-data で見出しの行だけにできます。docs/DEPLOY_GITLAB.md「サンプルのデータを消す」）`, sampleLeft);
    if (extras.length) {
      list(`パッケージに無いファイル（社内で足したもの。update は触りません。使っていないものは消してください。${summarizeDirs(extras)}）`, extras);
    }
  };

  // 2. 確かめるだけ（--dry-run）
  if (dry) {
    log(`予実ナビ ${manifest.version} → ${version} の確認（何も変えていません）: 変更 ${changed.length}・追加 ${added.length}・削除 ${deletes.length} ファイル${pkgHasDeps ? "・依存を入れ替え" : ""}（data/ と config.json はそのまま）`);
    if (unresolved.length) log(`社内で変えたファイル（このままでは止まります。--overwrite で新しい版に、--keep-local で社内の版のまま）:\n${listConflicts(unresolved)}`);
    if (take.length) log(`社内で変えていたが新しい版にするファイル（前のものは ${BACKUP_DIR}/ に残します）:\n${listConflicts(take)}`);
    if (keptNow.length) log(`社内の版のまま残すファイル:\n${listConflicts(keptNow)}`);
    ciNote();
    list("新しい版にするファイル", changed);
    list("足すファイル", added);
    list("消すファイル", deletes);
    reportFound();
    reportConfig(log, detail, configCheck, version);
    logNotes(log, detail, notes, manifest.version, version);
    if (conflicts.length) {
      const tmp = mkdtempSync(join(tmpdir(), "yojitsu-update-"));
      try {
        const diffs = [];
        for (const c of conflicts) {
          let next = null;
          if (c.next) writeFileSync((next = join(tmp, `n${diffs.length}`)), c.next);
          const d = unifiedDiff(c.cur ? join(dir, c.f) : null, next, c.f, tmp);
          if (d === null) {
            diffs.length = 0;
            log("git が見つからないので、差分は出せません（ファイルの一覧だけです）");
            break;
          }
          diffs.push(d);
        }
        if (diffs.length) {
          log(`社内で変えたファイルの差分: ${diffs.length} ファイル（- が社内の今、+ が新しい版）`);
          detail(diffs.join("\n"));
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    return { ...base, dryRun: true, backup: "", branch: "", commit: null, vendorUpdated: false };
  }

  if (unresolved.length) {
    const e = new CliError(
      [
        `社内で変えたファイルがあるので止めました（何も変えていません）:`,
        listConflicts(unresolved),
        "",
        "差分を見る:                         yojitsu-navi update --dry-run",
        `新しい版にする（前のものは ${BACKUP_DIR}/ に残す）: yojitsu-navi update --overwrite`,
        "社内の版のまま残す（次の更新でも残す）: yojitsu-navi update --keep-local",
        ...(unresolved.some((c) => c.f === CI_FILE || c.f === "package.json")
          ? ["", `社内向けの CI の設定（ランナーのタグ・変数・社内だけのジョブ）は yojitsu-navi migrate-ci で ${LOCAL_CI_FILE} に移せます。移したあとの update は ${CI_FILE} を止まらずに新しい版にします。レジストリ・証明書は ${NPMRC}・CI/CD 変数へ（docs/DEPLOY_GITLAB.md「社内の設定の置き場」）`]
          : []),
      ].join("\n"),
    );
    e.conflicts = base.conflicts;
    throw e;
  }

  // 3. 上書き・削除する前のファイルを写す
  const toBackup = [...changed, ...overwritten.filter((f) => existsSync(join(dir, f))), ...deletes].filter((f, i, a) => a.indexOf(f) === i && existsSync(join(dir, f)));
  const backup = toBackup.length ? backupFiles(dir, toBackup, o.now, manifestPath) : "";

  // 4. 入れ替える
  for (const w of writes) {
    const to = join(dir, w.f);
    mkdirSync(dirname(to), { recursive: true });
    // シンボリックリンクは指す先（プロジェクトの外のこともある）を書き換えず、リンクを普通のファイルに置き換える
    if (lstatSync(to, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(to);
    writeFileSync(to, w.next);
  }
  for (const f of deletes) rmSync(join(dir, f));
  const vendorUpdated = pkgHasDeps ? copyCache(pkgDir, dir) : false;
  writeManifest(dir, version, record, kept);

  log(`予実ナビ ${manifest.version} → ${version}: 変更 ${changed.length}・追加 ${added.length}・削除 ${deletes.length} ファイル${vendorUpdated ? "・依存を入れ替え" : ""}（data/ と config.json はそのまま）`);
  ciNote();
  const touched = [...changed.map((f) => `  変更 ${f}`), ...added.map((f) => `  追加 ${f}`), ...deletes.map((f) => `  削除 ${f}`)];
  if (touched.length) detail(touched.join("\n"));
  if (backup) log(`前のファイルは ${backup}/ に写しました（git には入りません。要らなければ消してください）`);
  if (overwritten.length) log(`社内で変えていたが新しい版にしたファイル（要るものは ${backup || BACKUP_DIR}/ から入れ直してください）:\n${listConflicts(take)}`);
  if (keptNow.length) log(`社内の版のまま残したファイル（新しい版の変更は入っていません。yojitsu-navi update --dry-run で差分を確かめられます）:\n${listConflicts(keptNow)}`);
  list("新しい版で増えたデータのファイルで、このプロジェクトに無いもの（入れていません。要るなら docs/DATA.md を見て作ってください）", newData);
  reportFound();
  if (missing.length) {
    log(`config.json に無い新しい設定: ${missing.length} 項目（無くても既定値で動きます。変えるときは docs/DATA.md）`);
    detail(missing.map((k) => `  ${k}`).join("\n"));
  }
  reportConfig(log, detail, configCheck, version);
  logNotes(log, detail, notes, manifest.version, version);

  let branch = "";
  let committed = false;
  let commit = null;
  let commitError = "";
  const commitIt = o.commit !== false;
  if (useGit) {
    // git の除外設定に当たるパッケージのファイルも入れる（前の版で入らなかったものもここで入る）
    gitAddPackageFiles(dir, [...[...template.keys()].filter((f) => (!isUserOwned(f) || f === LOCAL_CI_FILE) && existsSync(join(dir, f))), MANIFEST], outsideBackup);
    if (git(dir, ["diff", "--cached", "--quiet"]).ok) {
      log("変更はありませんでした（コミットしていません）");
      committed = true;
    } else if (!commitIt) {
      log("");
      log(`【コミットしていません】--no-commit のため、変更は git add までにしてあります（ブランチは今のまま: ${currentBranch(dir) || "（不明）"}）`);
      log("MR にするには:");
      log(`  git switch -c update-${version}`);
      log(`  git commit -m "予実ナビを ${version} に更新"`);
      log(`  git push -u origin update-${version}`);
      log(`取り消すには: git reset --hard（変える前のファイルは ${backup || BACKUP_DIR}/ にもあります）`);
    } else {
      const from = currentBranch(dir);
      branch = `update-${version}`;
      for (let n = 2; git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok; n++) branch = `update-${version}-${n}`;
      const sw = git(dir, ["switch", "-c", branch]);
      if (!sw.ok) git(dir, ["checkout", "-b", branch]);
      const c = git(dir, ["commit", "-q", "-m", `予実ナビを ${version} に更新`]);
      committed = c.ok;
      if (!c.ok) {
        commitError = c.err.split("\n")[0] || "git commit が失敗しました";
        log(`git commit できませんでした（${commitError}）。変更はフォルダに入っています`);
        branch = currentBranch(dir) === branch ? branch : "";
      } else {
        const hash = git(dir, ["rev-parse", "--short", "HEAD"]).out;
        commit = { branch, from, hash };
        log("");
        log(`【自動でコミットしました】ブランチ ${branch}（${from || "今のブランチ"} から作成）に「予実ナビを ${version} に更新」（${hash}）`);
        log(`  コミットしたくないときは --no-commit。取り消すには: git switch ${from || "main"} && git branch -D ${branch}`);
        log("");
        log("次に行うこと:");
        log(`  git push -u origin ${branch}`);
        log("  GitLab で MR を作り、パイプラインが緑になったらリーダーがマージする");
      }
    }
  }
  assertCiFiles(dir, template, committed);
  return { ...base, dryRun: false, backup, branch: commit ? branch : "", commit, commitError, vendorUpdated };
}

/** 今のブランチの名前（ブランチに居ないときは空） */
function currentBranch(dir) {
  const b = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
  return b === "HEAD" ? "" : b;
}

/** ファイルを .yojitsu-navi-backup/<日時>/ に写す（前の版の記録も入れる）。写した先（プロジェクトからのパス）を返す */
function backupFiles(dir, files, now, manifestPath) {
  const stamp = backupStamp(now);
  let backup = `${BACKUP_DIR}/${stamp}`;
  for (let n = 2; existsSync(join(dir, backup)); n++) backup = `${BACKUP_DIR}/${stamp}-${n}`;
  for (const f of files) {
    mkdirSync(dirname(join(dir, backup, f)), { recursive: true });
    // シンボリックリンクは指す先の中身を写す（上書きするのはリンクではなく中身なので）
    copyFileSync(join(dir, f), join(dir, backup, f));
  }
  if (manifestPath && existsSync(manifestPath)) writeFileSync(join(dir, backup, MANIFEST), readFileSync(manifestPath));
  return backup;
}

/** git を使わないときに見ないフォルダ（依存・ビルドの結果・コマンドのもの） */
const NOT_PROJECT_FILES = new Set([".git", "node_modules", "dist", ".npm", ".observablehq", "test-results", "playwright-report", BACKUP_DIR, LOG_DIR, VENDOR_CACHE.split("/")[0]]);

/**
 * パッケージに無く、前の版の記録にも無いファイル（社内で足したもの）。社内のもの（config.json・data/ など）とコマンドのものは除く。
 * git のプロジェクトでは git が管理する・除外設定に当たらないファイルから、そうでなければフォルダを辿って探す
 */
export function localExtras(dir, template, recorded = {}, useGit = isGitRepo(dir)) {
  const files = useGit ? gitFiles(dir) : walkFiles(dir);
  return files.filter((f) => fileKind(f) === "package" && !template.has(f) && !(f in recorded) && existsSync(join(dir, f))).sort();
}

function walkFiles(root) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      if (!rel && NOT_PROJECT_FILES.has(name)) continue;
      const st = lstatSync(join(root, r));
      if (st.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk("");
  return out;
}

/** 「tests/ 3・certs/ 1」の形（上の階層のフォルダごとの数） */
function summarizeDirs(files) {
  const n = new Map();
  for (const f of files) {
    const top = f.includes("/") ? `${f.split("/")[0]}/` : f;
    n.set(top, (n.get(top) ?? 0) + 1);
  }
  return [...n].map(([k, v]) => `${k} ${v}`).join("・");
}

/**
 * サンプルのまま残っているデータを空にする（yojitsu-navi reset-data。SPEC §94）。
 * 対象はパッケージのサンプルと中身が同じファイルだけ（sampleLeftovers。本番のデータ・社内で直したファイル・config.json には触らない）。
 * - data/worklogs/ の月のファイル・_meta.json: 消す（取り込みで作り直される）
 * - そのほかの CSV: 見出しの行だけを残す（消すとビルドが止まるものがあるため）
 * - 変える前のファイルは .yojitsu-navi-backup/<日時>/ に写す。git のコミットはしない（MR にするのは社内で）
 * @param {{ pkgDir: string, dir: string, dryRun?: boolean, now?: Date, log: (s: string) => void }} o
 */
export function resetData(o) {
  const { pkgDir, dir, log } = o;
  if (!existsSync(join(dir, MANIFEST))) throw new CliError(`${dir} に ${MANIFEST} がありません。yojitsu-navi init で作ったプロジェクトのフォルダで実行してください`);
  if (!existsSync(join(pkgDir, SAMPLE_DIR))) throw new CliError("このパッケージにはサンプルのデータが入っていないので、サンプルのまま残っているかを見分けられません");
  const plan = sampleLeftovers(pkgDir, dir).map((f) => {
    if (f.startsWith("data/worklogs/")) return { f, action: "remove" };
    if (f.endsWith(".csv")) return { f, action: "header" };
    return { f, action: "skip" };
  });
  const label = { remove: "消す", header: "見出しの行だけにする", skip: "そのまま（CSV でないので手で直す）" };
  if (!plan.length) {
    log("サンプルのまま残っているデータはありません（何も変えていません）");
    return { dryRun: Boolean(o.dryRun), removed: [], emptied: [], skipped: [], backup: "" };
  }
  const by = (a) => plan.filter((p) => p.action === a).map((p) => p.f);
  const result = { dryRun: Boolean(o.dryRun), removed: by("remove"), emptied: by("header"), skipped: by("skip"), backup: "" };
  const lines = plan.map((p) => `  ${p.f}（${label[p.action]}）`).join("\n");
  if (o.dryRun) {
    log(`サンプルのまま残っているデータ: ${plan.length} ファイル（何も変えていません。yojitsu-navi reset-data で次のようにします）:\n${lines}`);
    return result;
  }
  const targets = plan.filter((p) => p.action !== "skip").map((p) => p.f);
  if (targets.length) result.backup = backupFiles(dir, targets, o.now, join(dir, MANIFEST));
  for (const { f, action } of plan) {
    const to = join(dir, f);
    if (action === "remove") rmSync(to);
    else if (action === "header") {
      const text = readFileSync(to, "utf-8");
      const end = text.indexOf("\n");
      writeFileSync(to, end < 0 ? `${text}\n` : text.slice(0, end + 1));
    }
  }
  log(`サンプルのまま残っていたデータを直しました: ${plan.length} ファイル（前のものは ${result.backup || BACKUP_DIR}/ に写しました）:\n${lines}`);
  log("");
  log("次に行うこと: 本番のデータを入れ、npm run validate で確かめてから MR にする（git add data && git commit）");
  if (result.removed.length) log("消した作業実績の月は、取り込みで作り直されます（過去の月は Run pipeline で FETCH_FROM・FETCH_TO を入れて取り直す。docs/OPERATIONS.md）");
  return result;
}

/**
 * もとの版の .gitlab-ci.yml（init・update が入れたもの）。記録（.yojitsu-navi.json）のハッシュと同じ中身を、パッケージ・git の履歴から探す。
 * 見つからなければ null
 */
function originalCi(dir, templateCi, hash) {
  if (!hash) return null;
  if (templateCi && matchesHash(templateCi, hash)) return templateCi.toString("utf-8");
  if (!isGitRepo(dir)) return null;
  const commits = git(dir, ["log", "--format=%H", "-n", "200", "--", CI_FILE]).out.split("\n").filter(Boolean);
  for (const c of commits) {
    const r = spawnSync("git", ["show", `${c}:./${CI_FILE}`], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
    if (r.status === 0 && matchesHash(r.stdout, hash)) return r.stdout.toString("utf-8");
  }
  return null;
}

/**
 * 社内で直した .gitlab-ci.yml から、ランナーのタグ・変数・社内だけのジョブを .gitlab-ci.local.yml に移す（yojitsu-navi migrate-ci。SPEC §91.4）。
 * .gitlab-ci.yml は変えない。移し終えたら .gitlab-ci.local.yml に印を書き、次の update はその .gitlab-ci.yml を止めずに新しい版にする
 * @param {{ pkgDir: string, dir: string, dryRun?: boolean, force?: boolean, log: (s: string) => void }} o
 */
export function migrateCiCommand(o) {
  const { pkgDir, dir, log } = o;
  const ciPath = join(dir, CI_FILE);
  if (!existsSync(ciPath)) throw new CliError(`${dir} に ${CI_FILE} がありません。予実ナビのプロジェクトのフォルダで実行してください`);
  const current = readFileSync(ciPath, "utf-8");
  const template = readTemplate(join(pkgDir, "template"));
  const templateCi = template.has(CI_FILE) ? readFileSync(template.get(CI_FILE)) : null;
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(join(dir, MANIFEST), "utf-8"));
  } catch {
    // init で作っていないプロジェクトでも、新しい版と比べて移す
  }
  const hash = manifest.files?.[CI_FILE] ?? "";
  const localPath = join(dir, LOCAL_CI_FILE);
  if (hash && matchesHash(Buffer.from(current, "utf-8"), hash)) {
    log(`${CI_FILE} は社内で変えていません（移すものはありません）`);
    // 0.2.0〜0.2.1 のひな形（GitLab が失敗にする）だけは直す（SPEC §91.3）
    const before = existsSync(localPath) ? readFileSync(localPath, "utf-8") : null;
    const fixed = before === null ? null : repairLocalPlaceholder(before);
    const repair = fixed !== null && fixed !== before;
    if (repair) log(`${LOCAL_CI_FILE} の中身の無い項目（GitLab が「config can't be blank」で失敗にする）を${o.dryRun ? "直します（何も変えていません）" : "直しました。コミットしてください"}`);
    if (repair && !o.dryRun) writeFileSync(localPath, fixed);
    return { moved: [], same: [], manual: [], written: repair && !o.dryRun, base: "original" };
  }
  const original = originalCi(dir, templateCi, hash);
  if (!original && !templateCi) throw new CliError("比べるもとの .gitlab-ci.yml が見つかりません");
  const local = existsSync(localPath) ? readFileSync(localPath, "utf-8") : template.has(LOCAL_CI_FILE) ? readFileSync(template.get(LOCAL_CI_FILE), "utf-8") : "";
  const r = migrateCi({ current, base: original ?? templateCi.toString("utf-8"), local, force: o.force });
  const dry = Boolean(o.dryRun);
  const list = (xs) => xs.map((x) => `  ${x}`).join("\n");
  log(`${CI_FILE} の社内の変更を${original ? "もとの版" : `この版（${manifest.version ?? "?"} の記録と合うものが見つからないので新しい版）`}と比べました${dry ? "（何も変えていません）" : ""}`);
  if (r.moved.length) log(`${LOCAL_CI_FILE} に${dry ? "移すもの" : "移したもの"}:\n${list(r.moved)}`);
  if (r.same.length) log(`${LOCAL_CI_FILE} にもうあるもの:\n${list(r.same)}`);
  if (r.manual.length) log(`自動で移せないもの（手で直す）:\n${list(r.manual)}`);
  const written = !dry && r.changed;
  if (written) writeFileSync(localPath, r.local);
  log("");
  if (r.manual.length && !o.force) {
    log(`自動で移せないものがあるので、update は ${CI_FILE} でまだ止まります。上を直してから、もう一度 yojitsu-navi migrate-ci を実行してください`);
    log(`（要らない変更なら yojitsu-navi migrate-ci --force。update が ${CI_FILE} を新しい版にし、前のものは ${BACKUP_DIR}/ に残します）`);
  } else {
    log("次に行うこと:");
    if (dry) log("  yojitsu-navi migrate-ci");
    if (r.changed) log(`  git add ${LOCAL_CI_FILE} && git commit -m "社内の CI の設定を ${LOCAL_CI_FILE} に移す"`);
    log(`  yojitsu-navi update   （${CI_FILE} を新しい版にします。前のものは ${BACKUP_DIR}/ に残します）`);
  }
  if (!original) log("（もとの版が見つからないので新しい版と比べました。新しい版で変わったところも「自動で移せないもの」に出ることがあります）");
  return { moved: r.moved, same: r.same, manual: r.manual, written, base: original ? "original" : "template" };
}
