// yojitsu-navi コマンドの中身（init・update・接続先の設定）。Node の標準モジュールだけを使う（SPEC §44）
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, sep } from "node:path";
import { cwd } from "node:process";

/** 持ち込み先のプロジェクトに置く、どの版のどのファイルを入れたかの記録 */
export const MANIFEST = ".yojitsu-navi.json";
/** 依存込みパッケージの npm キャッシュの置き場（.gitlab-ci.yml がこれを見て npm ci --offline する） */
export const VENDOR_CACHE = "vendor/npm-cache";

/** 社内で書き換えるファイル。update は触らない（足しも消しもしない） */
export function isUserOwned(path) {
  return path === "config.json" || path.startsWith("data/");
}

export class CliError extends Error {}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
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

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() || String(r.error ?? "") };
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

function writeManifest(projectDir, version, files) {
  const hashes = {};
  for (const f of files) hashes[f] = sha(readFileSync(join(projectDir, f)));
  writeFileSync(join(projectDir, MANIFEST), `${JSON.stringify({ version, files: hashes }, null, 2)}\n`);
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
  writeManifest(dir, version, [...template.keys()]);
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
      git(dir, ["add", "-A"]);
      const c = git(dir, ["commit", "-q", "-m", `予実ナビ ${version}`]);
      committed = c.ok;
      if (!c.ok) log(`git commit できませんでした（${c.err.split("\n")[0]}）。git config --global user.name と user.email を設定してから下の手順を続けてください`);
    }
  }
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

/**
 * 今あるプロジェクトを、このパッケージの版に入れ替える。data/ と config.json は変えない。
 * @param {{ pkgDir: string, version: string, dir: string, force?: boolean, git?: boolean, log: (s: string) => void }} o
 */
export function update(o) {
  const { pkgDir, version, dir, log } = o;
  const manifestPath = join(dir, MANIFEST);
  if (!existsSync(manifestPath)) throw new CliError(`${dir} に ${MANIFEST} がありません。yojitsu-navi init で作ったプロジェクトのフォルダで実行してください`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const old = manifest.files ?? {};
  if (compareVersion(version, manifest.version) < 0 && !o.force) throw new CliError(`今のプロジェクト（${manifest.version}）より古い版（${version}）です。戻すときは --force`);
  const useGit = o.git !== false && isGitRepo(dir);
  if (useGit && git(dir, ["status", "--porcelain"]).out !== "" && !o.force) throw new CliError("コミットしていない変更があります。コミットするか取り消してから実行してください（差分を MR で確かめられるように）");
  const hasVendor = existsSync(join(dir, VENDOR_CACHE));
  const pkgHasDeps = existsSync(join(pkgDir, "deps", "npm-cache"));
  if (hasVendor && !pkgHasDeps && !o.force) throw new CliError(`このプロジェクトは依存込み（${VENDOR_CACHE}）です。依存込みのパッケージ（yojitsu-navi-<版>-with-deps.tgz）で update してください`);

  const template = readTemplate(join(pkgDir, "template"));
  const changed = [];
  const added = [];
  const overwritten = [];
  const notAdded = [];
  for (const [f, abs] of template) {
    const to = join(dir, f);
    if (isUserOwned(f)) {
      if (!existsSync(to)) notAdded.push(f);
      continue;
    }
    const next = readFileSync(abs);
    if (existsSync(to)) {
      const cur = readFileSync(to);
      if (cur.equals(next)) continue;
      if (old[f] && sha(cur) !== old[f]) overwritten.push(f);
      changed.push(f);
    } else added.push(f);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, next);
  }
  const removed = [];
  for (const f of Object.keys(old)) {
    if (template.has(f) || isUserOwned(f) || !existsSync(join(dir, f))) continue;
    rmSync(join(dir, f));
    removed.push(f);
  }
  const vendorUpdated = pkgHasDeps ? copyCache(pkgDir, dir) : false;
  writeManifest(dir, version, [...template.keys()].filter((f) => existsSync(join(dir, f))));

  let missing = [];
  try {
    missing = missingConfigKeys(JSON.parse(readFileSync(template.get("config.json"), "utf-8")), JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")));
  } catch {
    // config.json が壊れているときは npm run validate が知らせる
  }

  log(`予実ナビ ${manifest.version} → ${version}: 変更 ${changed.length}・追加 ${added.length}・削除 ${removed.length} ファイル${vendorUpdated ? "・依存を入れ替え" : ""}（data/ と config.json はそのまま）`);
  if (overwritten.length) log(`手で変えていたので上書きしたファイル（MR の差分で確かめ、要るなら入れ直してください）:\n${overwritten.map((f) => `  ${f}`).join("\n")}`);
  // 作業実績（data/worklogs/）はサンプルの月が増えるだけなので知らせない
  const newData = notAdded.filter((f) => !f.startsWith("data/worklogs/"));
  if (newData.length) log(`新しい版のサンプルにあって、このプロジェクトに無いデータ（入れていません。要るなら docs/DATA.md を見て作ってください）:\n${newData.map((f) => `  ${f}`).join("\n")}`);
  if (missing.length) log(`config.json に無い新しい設定（無くても既定値で動きます。変えるときは docs/DATA.md）:\n${missing.map((k) => `  ${k}`).join("\n")}`);

  let branch = "";
  if (useGit) {
    branch = `update-${version}`;
    if (git(dir, ["status", "--porcelain"]).out === "") {
      log("変更はありませんでした");
      branch = "";
    } else {
      const sw = git(dir, ["switch", "-c", branch]);
      if (!sw.ok) git(dir, ["checkout", "-b", branch]);
      git(dir, ["add", "-A"]);
      const c = git(dir, ["commit", "-q", "-m", `予実ナビを ${version} に更新`]);
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
  return { changed, added, removed, overwritten, missing, newData, branch, vendorUpdated };
}
