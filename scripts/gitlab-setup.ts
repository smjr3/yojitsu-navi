/**
 * 本番 GitLab プロジェクトの設定の確認・適用（SPEC §39.2）
 *
 *   GITLAB_TOKEN=glpat-… npm run gitlab:setup -- --api https://gitlab.example.local/api/v4 --project group/yojitsu-navi
 *   GITLAB_TOKEN=glpat-… npm run gitlab:setup -- … --apply     # 足りない設定を直す
 *
 * - 既定は確認だけ（何も変えない）。--apply で、自動で直せる項目（プロジェクトの設定・保護ブランチ）を直して確認し直す
 * - トークンは環境変数 GITLAB_TOKEN だけで受け取る（引数に書くとシェルの履歴に残るため）。
 *   Owner か Maintainer の Personal Access Token（scope: api）。設定が済んだら失効させてよい
 * - --api・--project を省くと config.json の masterEdit.gitlab、それも空なら GitLab CI の CI_API_V4_URL・CI_PROJECT_PATH
 * - 確認する項目と推奨値の理由は docs/DEPLOY_GITLAB.md
 * - 終了コード: 0 = すべて推奨どおり、1 = 直すところがある（--apply 後も残った）、2 = 引数・接続の誤り
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface SetupTarget {
  /** 例 https://gitlab.example.local/api/v4 */
  api: string;
  /** "group/project" または数値 ID */
  project: string;
  /** 反映先のブランチ（config.json の targetBranch） */
  branch: string;
}

/** プロジェクトの推奨設定（PUT /projects/:id のパラメータ名と値） */
export const DESIRED_PROJECT = {
  visibility: "private",
  pages_access_level: "private",
  builds_access_level: "private",
  only_allow_merge_if_pipeline_succeeds: true,
  remove_source_branch_after_merge: true,
} as const;

const PROJECT_LABELS: Record<keyof typeof DESIRED_PROJECT, string> = {
  visibility: "プロジェクトの公開範囲 = Private",
  pages_access_level: "Pages の閲覧 = Only Project Members",
  builds_access_level: "CI/CD の閲覧 = Only Project Members",
  only_allow_merge_if_pipeline_succeeds: "パイプライン成功時だけマージできる",
  remove_source_branch_after_merge: "マージ後にソースブランチを削除",
};

/** 保護ブランチの推奨（0 = No one、40 = Maintainers） */
export const DESIRED_PUSH_LEVEL = 0;
export const DESIRED_MERGE_LEVEL = 40;

export interface CheckItem {
  id: string;
  label: string;
  ok: boolean;
  /** 今の値（表示用） */
  current: string;
  /** --apply で直せるか（false なら手で直す。直し方は hint） */
  fixable: boolean;
  hint?: string;
}

type Project = Record<string, unknown> & { default_branch?: unknown };
type AccessRow = { access_level?: unknown };
export type ProtectedBranch = { push_access_levels?: AccessRow[]; merge_access_levels?: AccessRow[]; allow_force_push?: unknown } | null;
type Variable = { key?: unknown; protected?: unknown; masked?: unknown };
type Schedule = { active?: unknown };
type Member = { access_level?: unknown };
export type AccessToken = { name?: unknown; scopes?: unknown; access_level?: unknown; active?: unknown; revoked?: unknown; expires_at?: unknown };

const ROLE: Record<number, string> = { 0: "No one", 10: "Guest", 20: "Reporter", 30: "Developers + Maintainers", 40: "Maintainers", 50: "Owner", 60: "Admin" };
const ROLE_NAME: Record<number, string> = { 10: "Guest", 15: "Planner", 20: "Reporter", 30: "Developer", 40: "Maintainer", 50: "Owner" };

const show = (v: unknown) => (v === undefined ? "（取得できない）" : String(v));

/** プロジェクトの設定を推奨値と比べる */
export function projectChecks(project: Project, branch: string): CheckItem[] {
  const items: CheckItem[] = (Object.keys(DESIRED_PROJECT) as Array<keyof typeof DESIRED_PROJECT>).map((k) => {
    const want = DESIRED_PROJECT[k];
    const item: CheckItem = { id: k, label: PROJECT_LABELS[k], ok: project[k] === want, current: show(project[k]), fixable: true };
    if (k === "pages_access_level") item.hint = "--apply しても変わらなければ、GitLab 管理者に Pages のアクセス制御（gitlab_pages access_control）の有効化を依頼";
    return item;
  });
  items.unshift({ id: "default_branch", label: `既定ブランチ = ${branch}`, ok: project.default_branch === branch, current: show(project.default_branch), fixable: true, hint: `${branch} ブランチが無ければ先に push する` });
  return items;
}

const levels = (rows: AccessRow[] | undefined) => (rows ?? []).map((r) => r.access_level).filter((v): v is number => typeof v === "number");

/** 保護ブランチを推奨値（push = No one、merge = Maintainers、force push 不可）と比べる */
export function branchChecks(pb: ProtectedBranch, branch: string): CheckItem[] {
  if (pb === null) {
    return [{ id: "protected_branch", label: `${branch} を保護ブランチにする`, ok: false, current: "保護されていない", fixable: true }];
  }
  const push = levels(pb.push_access_levels);
  const merge = levels(pb.merge_access_levels);
  // Premium で個人・グループを指定した行（access_level が null）は数えない
  const pushOk = push.length > 0 && push.every((l) => l === DESIRED_PUSH_LEVEL);
  const mergeOk = merge.length > 0 && merge.every((l) => l >= DESIRED_MERGE_LEVEL);
  const fmt = (ls: number[]) => (ls.length ? ls.map((l) => ROLE[l] ?? String(l)).join(", ") : "（個人・グループ指定のみ）");
  return [
    { id: "protected_push", label: `${branch} への直接プッシュ = No one`, ok: pushOk, current: fmt(push), fixable: true },
    { id: "protected_merge", label: `${branch} へのマージ = Maintainers`, ok: mergeOk, current: fmt(merge), fixable: true },
    { id: "protected_force", label: `${branch} への force push = 不可`, ok: pb.allow_force_push !== true, current: show(pb.allow_force_push), fixable: true },
  ];
}

/** CI/CD 変数とスケジュール（取り込みを動かすときだけ GIT_PUSH_TOKEN が要る） */
export function ciChecks(variables: Variable[] | null, schedules: Schedule[] | null): CheckItem[] {
  if (variables === null) return [];
  const byKey = new Map(variables.map((v) => [String(v.key), v]));
  const active = (schedules ?? []).some((s) => s.active === true);
  const out: CheckItem[] = [];
  const token = byKey.get("GIT_PUSH_TOKEN");
  if (active || token) {
    out.push({
      id: "git_push_token",
      label: "CI/CD 変数 GIT_PUSH_TOKEN（Protected・Masked）",
      ok: !!token && token.protected === true && token.masked === true,
      current: token ? `protected=${String(token.protected)}, masked=${String(token.masked)}` : "未登録（スケジュールあり）",
      fixable: false,
      hint: "Project Access Token（role: Maintainer、scope: write_repository）を作り、Protected と Masked をオンにして登録",
    });
  }
  for (const key of ["WORKLOG_API_TOKEN", "MEMBER_API_TOKEN", "PROJECT_API_TOKEN", "NPM_AUTH_TOKEN"]) {
    const v = byKey.get(key);
    if (!v) continue;
    out.push({ id: key.toLowerCase(), label: `CI/CD 変数 ${key}（Protected・Masked）`, ok: v.protected === true && v.masked === true, current: `protected=${String(v.protected)}, masked=${String(v.masked)}`, fixable: false, hint: "Settings > CI/CD > Variables で Protected と Masked をオン" });
  }
  return out;
}

/**
 * 取り込みの MR を作るプロジェクトアクセストークン（GIT_PUSH_TOKEN の中身。SPEC §39・§100）。
 * GIT_PUSH_TOKEN を登録した・スケジュールがあるときだけ見る。トークンの値は API から読めないので、
 * 「Maintainer 以上・write_repository・有効」のものが 1 つでもあるか、期限が近くないかを見る
 */
export function accessTokenChecks(tokens: AccessToken[] | null, needed: boolean, today: string): CheckItem[] {
  if (!needed || tokens === null) return [];
  const usable = tokens.filter((t) => t.active !== false && t.revoked !== true && typeof t.access_level === "number" && t.access_level >= 40 && Array.isArray(t.scopes) && t.scopes.includes("write_repository"));
  const hint = "Settings > Access tokens で role: Maintainer・scope: write_repository のトークンを作り、CI/CD 変数 GIT_PUSH_TOKEN を入れ替える";
  if (!usable.length) return [{ id: "access_token", label: "取り込みの MR 用のプロジェクトアクセストークン（Maintainer・write_repository・有効）", ok: false, current: tokens.length ? `条件に合うものが無い（${tokens.length} 件）` : "無い", fixable: false, hint }];
  // 期限（YYYY-MM-DD）が一番先のもの。期限なしは null
  const dates = usable.map((t) => (typeof t.expires_at === "string" ? t.expires_at : ""));
  const latest = dates.includes("") ? "" : (dates.sort().at(-1) ?? "");
  const days = latest ? Math.round((Date.parse(`${latest}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : Infinity;
  return [{ id: "access_token_expiry", label: "取り込みの MR 用のプロジェクトアクセストークンの期限が 30 日より先", ok: days > 30, current: latest ? `${latest}（あと ${days} 日）` : "期限なし", fixable: false, hint: `期限が切れると取り込みの MR が作れなくなります。${hint}` }];
}

/** メンバーの役割ごとの人数（情報として出す。Maintainer がいなければ直すところ） */
export function memberChecks(members: Member[] | null): { items: CheckItem[]; summary: string } {
  if (members === null) return { items: [], summary: "" };
  const count = new Map<number, number>();
  for (const m of members) if (typeof m.access_level === "number") count.set(m.access_level, (count.get(m.access_level) ?? 0) + 1);
  const summary = [...count.entries()].sort((a, b) => a[0] - b[0]).map(([l, n]) => `${ROLE_NAME[l] ?? l} ${n} 人`).join("、");
  const leaders = (count.get(40) ?? 0) + (count.get(50) ?? 0);
  return {
    summary,
    items: [{ id: "leaders", label: "マージできる人（Maintainer 以上）がいる", ok: leaders > 0, current: `${leaders} 人`, fixable: false, hint: "Manage > Members でリーダー層を Maintainer にする" }],
  };
}

// ---------------------------------------------------------------------------
// GitLab API
// ---------------------------------------------------------------------------

export class SetupError extends Error {}

function client(fetchImpl: Fetch, target: SetupTarget, token: string) {
  const base = `${target.api}/projects/${encodeURIComponent(target.project)}`;
  async function call<T>(method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; data: T | null }> {
    const headers: Record<string, string> = { "PRIVATE-TOKEN": token, Accept: "application/json" };
    const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers };
    if (body) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, init);
    } catch (e) {
      throw new SetupError(`GitLab に接続できませんでした（${target.api}）: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text().catch(() => "");
    if (res.ok) return { status: res.status, data: text === "" ? null : (JSON.parse(text) as T) };
    return { status: res.status, data: null };
  }
  return { call };
}

export interface SetupReport {
  items: CheckItem[];
  members: string;
  ok: boolean;
}

/** 今の設定を読んで推奨値と比べる */
export async function inspect(fetchImpl: Fetch, target: SetupTarget, token: string): Promise<SetupReport> {
  const { call } = client(fetchImpl, target, token);
  const project = await call<Project>("GET", "");
  if (project.status === 401) throw new SetupError("トークンが無効です（GITLAB_TOKEN）");
  if (project.status === 404 || !project.data) throw new SetupError(`プロジェクト ${target.project} が見つからないか、見る権限がありません（HTTP ${project.status}）`);
  const pb = await call<ProtectedBranch>("GET", `/protected_branches/${encodeURIComponent(target.branch)}`);
  if (pb.status === 403) throw new SetupError("保護ブランチを読めません。Maintainer 以上のトークンが必要です");
  const vars = await call<Variable[]>("GET", "/variables?per_page=100");
  const schedules = await call<Schedule[]>("GET", "/pipeline_schedules?per_page=100");
  const members = await call<Member[]>("GET", "/members/all?per_page=100");
  const m = memberChecks(members.data);
  const ci = ciChecks(vars.data, schedules.data);
  // GIT_PUSH_TOKEN が要るとき（登録した・スケジュールがある）だけ、中身のプロジェクトアクセストークンを見る（読めなければ見ない）
  const tokens = ci.some((i) => i.id === "git_push_token") ? await call<AccessToken[]>("GET", "/access_tokens?per_page=100") : { data: null };
  // 日本時間の今日（CLAUDE.md の「今日」と同じ）
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const items = [...projectChecks(project.data, target.branch), ...branchChecks(pb.data, target.branch), ...m.items, ...ci, ...accessTokenChecks(tokens.data, true, today)];
  return { items, members: m.summary, ok: items.every((i) => i.ok) };
}

/** 自動で直せる項目を直す（プロジェクトの設定 → 保護ブランチ）。直した項目の id を返す */
export async function applyFixes(fetchImpl: Fetch, target: SetupTarget, token: string, report: SetupReport): Promise<string[]> {
  const { call } = client(fetchImpl, target, token);
  const broken = new Set(report.items.filter((i) => !i.ok && i.fixable).map((i) => i.id));
  const done: string[] = [];
  const body: Record<string, unknown> = {};
  for (const k of Object.keys(DESIRED_PROJECT) as Array<keyof typeof DESIRED_PROJECT>) if (broken.has(k)) body[k] = DESIRED_PROJECT[k];
  if (broken.has("default_branch")) body.default_branch = target.branch;
  if (Object.keys(body).length) {
    const r = await call("PUT", "", body);
    if (r.status >= 300) throw new SetupError(`プロジェクトの設定を変えられませんでした（HTTP ${r.status}）。Owner か Maintainer のトークンが必要です`);
    done.push(...Object.keys(body));
  }
  if (["protected_branch", "protected_push", "protected_merge", "protected_force"].some((id) => broken.has(id))) {
    // Free 版の API は保護の中身を直接変えられない（Premium 機能）ので、外してから推奨値で保護し直す
    if (!broken.has("protected_branch")) {
      const d = await call("DELETE", `/protected_branches/${encodeURIComponent(target.branch)}`);
      if (d.status >= 300 && d.status !== 404) throw new SetupError(`保護ブランチを更新できませんでした（HTTP ${d.status}）`);
    }
    const p = await call("POST", "/protected_branches", { name: target.branch, push_access_level: DESIRED_PUSH_LEVEL, merge_access_level: DESIRED_MERGE_LEVEL, allow_force_push: false });
    if (p.status >= 300) throw new SetupError(`保護ブランチを設定できませんでした（HTTP ${p.status}）`);
    done.push("protected_branch");
  }
  return done;
}

export function formatReport(report: SetupReport, target: SetupTarget): string {
  const lines = [`対象: ${target.api} の ${target.project}（反映先 ${target.branch}）`, ""];
  for (const i of report.items) {
    lines.push(`${i.ok ? "✓" : "✗"} ${i.label}${i.ok ? "" : `（今: ${i.current}）`}`);
    if (!i.ok && !i.fixable && i.hint) lines.push(`    → ${i.hint}`);
    if (!i.ok && i.fixable && i.hint) lines.push(`    ※ ${i.hint}`);
  }
  if (report.members) lines.push("", `メンバー: ${report.members}`);
  lines.push("", report.ok ? "すべて推奨どおりです。" : `直すところが ${report.items.filter((i) => !i.ok).length} 件あります。`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv, config: { apiBaseUrl?: unknown; projectId?: unknown; targetBranch?: unknown } = {}): SetupTarget & { apply: boolean; token: string } {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1]!.trim() : "";
  };
  const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");
  let api = get("api") || str(config.apiBaseUrl) || str(env.CI_API_V4_URL);
  api = api.replace(/\/+$/, "");
  if (api !== "" && !/\/api\/v4$/.test(api)) api = `${api}/api/v4`;
  const project = get("project") || str(config.projectId) || str(env.CI_PROJECT_PATH);
  const branch = get("branch") || str(config.targetBranch) || "main";
  const token = str(env.GITLAB_TOKEN);
  if (argv.includes("--token")) throw new SetupError("トークンは引数ではなく環境変数 GITLAB_TOKEN で渡してください（履歴に残らないように）");
  if (api === "") throw new SetupError("--api（例 https://gitlab.example.local/api/v4）を指定してください");
  if (project === "") throw new SetupError("--project（例 group/yojitsu-navi）を指定してください");
  if (token === "") throw new SetupError("環境変数 GITLAB_TOKEN に Owner か Maintainer の Personal Access Token（scope: api）を入れてください");
  return { api, project, branch, token, apply: argv.includes("--apply") };
}

function readConfigGitlab(rootDir: string): Record<string, unknown> {
  try {
    const c = JSON.parse(readFileSync(join(rootDir, "config.json"), "utf-8")) as { masterEdit?: { gitlab?: Record<string, unknown> } };
    return c.masterEdit?.gitlab ?? {};
  } catch {
    return {};
  }
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, fetchImpl: Fetch, log: (s: string) => void, rootDir = process.cwd()): Promise<number> {
  let opts;
  try {
    opts = parseArgs(argv, env, readConfigGitlab(rootDir));
  } catch (e) {
    log(String(e instanceof Error ? e.message : e));
    return 2;
  }
  const target: SetupTarget = { api: opts.api, project: opts.project, branch: opts.branch };
  try {
    let report = await inspect(fetchImpl, target, opts.token);
    log(formatReport(report, target));
    if (!opts.apply || report.ok) {
      if (!report.ok) log("\n--apply を付けると、✗ のうち自動で直せる項目（→ の付いていないもの）を直します。");
      return report.ok ? 0 : 1;
    }
    const done = await applyFixes(fetchImpl, target, opts.token, report);
    log(`\n直しました: ${done.length ? done.join(", ") : "（自動で直せる項目はありませんでした）"}\n`);
    report = await inspect(fetchImpl, target, opts.token);
    log(formatReport(report, target));
    return report.ok ? 0 : 1;
  } catch (e) {
    log(String(e instanceof Error ? e.message : e));
    return 2;
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main(process.argv.slice(2), process.env, (url, init) => fetch(url, init), (s) => console.log(s)).then((code) => process.exit(code));
}
