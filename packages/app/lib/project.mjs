// yojitsu-navi コマンドの中身（init・update・接続先の設定）。Node の標準モジュールだけを使う（SPEC §44）
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, sep } from "node:path";
import { cwd } from "node:process";
import { CI_FILE, checkCiFiles, describeCiProblems } from "./ci-files.mjs";

/** 持ち込み先のプロジェクトに置く、どの版のどのファイルを入れたかの記録 */
export const MANIFEST = ".yojitsu-navi.json";
/** 依存込みパッケージの npm キャッシュの置き場（.gitlab-ci.yml がこれを見て npm ci --offline する） */
export const VENDOR_CACHE = "vendor/npm-cache";

/** update が上書きする前のファイルを写しておく置き場（git には入れない。.gitignore にもある） */
export const BACKUP_DIR = ".yojitsu-navi-backup";

/** 社内で書き換えるファイル。update は触らない（足しも消しもしない） */
export function isUserOwned(path) {
  return path === "config.json" || path.startsWith("data/");
}

/**
 * update でのファイルの扱い（SPEC §91。docs/DEPLOY_GITLAB.md「新しい版にする」の表と同じ）。
 * - keep: 社内のもの。触らない（config.json・data/ 以下すべて）
 * - vendor: 依存込みのとき、パッケージのもので丸ごと入れ替える（vendor/npm-cache/）
 * - tool: コマンドが書く・使う（.yojitsu-navi.json・.yojitsu-navi-backup/）
 * - package: それ以外。パッケージの版にする（社内で変えていたら止まる）。パッケージに無く、前の版の記録にも無いファイルは社内で足したものとして触らない
 */
export function fileKind(path) {
  if (isUserOwned(path)) return "keep";
  if (path === VENDOR_CACHE || path.startsWith(`${VENDOR_CACHE}/`)) return "vendor";
  if (path === MANIFEST || path === BACKUP_DIR || path.startsWith(`${BACKUP_DIR}/`)) return "tool";
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
  const r = checkCiFiles(dir, { git: isGitRepo(dir) });
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

/** "1.2.3" の大小（a<b で負） */
export function compareVersion(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/**
 * 新しいプロジェクトのフォルダを作る。
 * @param {{ pkgDir: string, version: string, dir: string, gitlab?: ReturnType<typeof normalizeGitlab>, git?: boolean, log: (s: string) => void }} o
 */
export function init(o) {
  const { pkgDir, version, dir, log } = o;
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new CliError(`${dir} は空ではありません。新しいフォルダ名を指定してください（今あるプロジェクトを新しい版にするときは update）`);
  const template = readTemplate(join(pkgDir, "template"));
  mkdirSync(dir, { recursive: true });
  for (const [f, abs] of template) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(abs, join(dir, f));
  }
  const gitlab = o.gitlab ?? readGitlabTarget(dir);
  if (o.gitlab) writeFileSync(join(dir, "config.json"), applyGitlabTarget(readFileSync(join(dir, "config.json"), "utf-8"), o.gitlab));
  const withDeps = copyCache(pkgDir, dir);
  writeManifest(dir, version, [...template.keys()].map((f) => [f, readFileSync(join(dir, f))]));
  log(`予実ナビ ${version} を ${dir} に作りました（${template.size} ファイル${withDeps ? "、依存込み" : ""}）`);
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
      gitAddPackageFiles(dir, [...template.keys(), MANIFEST]);
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
  return { files: template.size, withDeps, committed };
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

const CONFLICT_LABEL = { modified: "社内で変更", created: "社内で作成", removedModified: "新しい版で削除（社内で変更）" };

/**
 * 今あるプロジェクトを、このパッケージの版に入れ替える（SPEC §44・§91）。
 * - data/ と config.json は変えない。それ以外は新しい版にし、前の版の記録にあって新しい版に無いファイルは消す
 * - 上書き・削除するファイルに社内の変更（前の版の記録と中身が違う・同じ名前で作った）があれば、何も変えずに止まる。
 *   overwrite で新しい版にする、keepLocal で社内の版を残す（次の update でも残す）
 * - 上書き・削除する前のファイルは .yojitsu-navi-backup/<日時>/ に写す
 * - dryRun は何も変えず、変わるファイルの一覧と、社内の変更があるファイルの差分（社内の今 → 新しい版）を出す
 * @param {{ pkgDir: string, version: string, dir: string, force?: boolean, overwrite?: boolean, keepLocal?: boolean, dryRun?: boolean, git?: boolean, now?: Date, log: (s: string) => void }} o
 */
export function update(o) {
  const { pkgDir, version, dir, log } = o;
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
  const outsideBackup = ["--", ".", `:(exclude)${BACKUP_DIR}`];
  if (useGit && !dry && git(dir, ["status", "--porcelain", ...outsideBackup]).out !== "" && !o.force) throw new CliError("コミットしていない変更があります。コミットするか取り消してから実行してください（差分を MR で確かめられるように）");
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
  for (const [f, abs] of template) {
    const to = join(dir, f);
    if (fileKind(f) !== "package") {
      if (fileKind(f) === "keep" && !existsSync(to)) notAdded.push(f);
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
    if (type) conflicts.push({ f, type, next, cur });
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
  for (const w of writes) record.set(w.f, sha(w.next));
  const sortByPath = (a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : 0);
  conflicts.sort(sortByPath);
  writes.sort(sortByPath);
  deletes.sort();

  const changed = writes.filter((w) => w.kind === "changed").map((w) => w.f);
  const added = writes.filter((w) => w.kind === "added").map((w) => w.f);
  const overwritten = take.map((c) => c.f).sort();
  const listConflicts = (cs) => cs.map((c) => `  ${c.f}（${CONFLICT_LABEL[c.type]}）`).join("\n");
  // 作業実績（data/worklogs/）はサンプルの月が増えるだけなので知らせない
  const newData = notAdded.filter((f) => !f.startsWith("data/worklogs/"));
  let missing = [];
  try {
    missing = missingConfigKeys(JSON.parse(readFileSync(template.get("config.json"), "utf-8")), JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")));
  } catch {
    // config.json が壊れているときは npm run validate が知らせる
  }
  const base = { changed, added, removed: deletes, conflicts: conflicts.map((c) => ({ path: c.f, type: c.type })), overwritten, kept, missing, newData };

  // 2. 確かめるだけ（--dry-run）
  if (dry) {
    log(`予実ナビ ${manifest.version} → ${version} の確認（何も変えていません）: 変更 ${changed.length}・追加 ${added.length}・削除 ${deletes.length} ファイル${pkgHasDeps ? "・依存を入れ替え" : ""}（data/ と config.json はそのまま）`);
    if (unresolved.length) log(`社内で変えたファイル（このままでは止まります。--overwrite で新しい版に、--keep-local で社内の版のまま）:\n${listConflicts(unresolved)}`);
    if (take.length) log(`社内で変えていたが新しい版にするファイル（前のものは ${BACKUP_DIR}/ に残します）:\n${listConflicts(take)}`);
    if (keptNow.length) log(`社内の版のまま残すファイル:\n${listConflicts(keptNow)}`);
    if (changed.length) log(`新しい版にするファイル:\n${changed.map((f) => `  ${f}`).join("\n")}`);
    if (added.length) log(`足すファイル:\n${added.map((f) => `  ${f}`).join("\n")}`);
    if (deletes.length) log(`消すファイル:\n${deletes.map((f) => `  ${f}`).join("\n")}`);
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
        if (diffs.length) log(`\n社内で変えたファイルの差分（- が社内の今、+ が新しい版）:\n${diffs.join("\n")}`);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    return { ...base, dryRun: true, backup: "", branch: "", vendorUpdated: false };
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
      ].join("\n"),
    );
    e.conflicts = base.conflicts;
    throw e;
  }

  // 3. 上書き・削除する前のファイルを写す
  let backup = "";
  const toBackup = [...changed, ...overwritten.filter((f) => existsSync(join(dir, f))), ...deletes].filter((f, i, a) => a.indexOf(f) === i && existsSync(join(dir, f)));
  if (toBackup.length) {
    const stamp = backupStamp(o.now);
    backup = `${BACKUP_DIR}/${stamp}`;
    for (let n = 2; existsSync(join(dir, backup)); n++) backup = `${BACKUP_DIR}/${stamp}-${n}`;
    for (const f of toBackup) {
      mkdirSync(dirname(join(dir, backup, f)), { recursive: true });
      // シンボリックリンクは指す先の中身を写す（下で上書きするのはリンクではなく中身なので）
      copyFileSync(join(dir, f), join(dir, backup, f));
    }
    writeFileSync(join(dir, backup, MANIFEST), readFileSync(manifestPath));
  }

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
  if (backup) log(`前のファイルは ${backup}/ に写しました（git には入りません。要らなければ消してください）`);
  if (overwritten.length) log(`社内で変えていたが新しい版にしたファイル（要るものは ${backup || BACKUP_DIR}/ から入れ直してください）:\n${listConflicts(take)}`);
  if (keptNow.length) log(`社内の版のまま残したファイル（新しい版の変更は入っていません。yojitsu-navi update --dry-run で差分を確かめられます）:\n${listConflicts(keptNow)}`);
  if (newData.length) log(`新しい版のサンプルにあって、このプロジェクトに無いデータ（入れていません。要るなら docs/DATA.md を見て作ってください）:\n${newData.map((f) => `  ${f}`).join("\n")}`);
  if (missing.length) log(`config.json に無い新しい設定（無くても既定値で動きます。変えるときは docs/DATA.md）:\n${missing.map((k) => `  ${k}`).join("\n")}`);

  let branch = "";
  let committed = false;
  if (useGit) {
    // git の除外設定に当たるパッケージのファイルも入れる（前の版で入らなかったものもここで入る）
    gitAddPackageFiles(dir, [...[...template.keys()].filter((f) => !isUserOwned(f) && existsSync(join(dir, f))), MANIFEST], outsideBackup);
    if (git(dir, ["diff", "--cached", "--quiet"]).ok) {
      log("変更はありませんでした");
      committed = true;
    } else {
      branch = `update-${version}`;
      const sw = git(dir, ["switch", "-c", branch]);
      if (!sw.ok) git(dir, ["checkout", "-b", branch]);
      const c = git(dir, ["commit", "-q", "-m", `予実ナビを ${version} に更新`]);
      committed = c.ok;
      if (!c.ok) {
        log(`git commit できませんでした（${c.err.split("\n")[0]}）。変更はフォルダに入っています`);
        branch = "";
      } else {
        log("");
        log("次に行うこと:");
        log(`  git push -u origin ${branch}`);
        log("  GitLab で MR を作り、パイプラインが緑になったらリーダーがマージする");
      }
    }
  }
  assertCiFiles(dir, template, committed);
  return { ...base, dryRun: false, backup, branch, vendorUpdated };
}
