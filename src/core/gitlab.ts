/**
 * マスタ編集の保存: GitLab REST API（v4）呼び出し（SPEC §19.2）
 *
 * fetch を引数で受け取る（テストではモックを渡す）。ブラウザからは window.fetch をそのまま渡す。
 * - commits API: POST /projects/:id/repository/commits（actions[] で複数ファイルを 1 コミット。
 *   各 action に last_commit_id を付け、他の人が先に更新していたら GitLab が 400 で拒否する）
 * - mr モード: start_branch = targetBranch、branch = masters/<YYYYMMDD-HHmmss>-<user> に新ブランチでコミットし、
 *   POST /projects/:id/merge_requests で MR を作る
 * - エラーは conflict / permission / network / other に分類し、人が読める文を付ける
 */
import type { MasterEditConfig } from "./types.js";
import { T, fmt } from "../i18n/index.js";

/** fetch の最小限の形（Response は ok / status / text() だけ使う） */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type SaveMode = "gitlab" | "download";

export const DEFAULT_MASTER_EDIT: MasterEditConfig = {
  mode: "gitlab",
  gitlab: { apiBaseUrl: "", projectId: "", targetBranch: "main", commitMode: "mr" },
};

/** デモ（§29）の接続先。ブラウザ内の模擬（gitlab-mock.ts）がこの URL を受ける */
export const DEMO_API_BASE = "https://gitlab.demo.invalid/api/v4";
export const DEMO_PROJECT_ID = "demo/yojitsu-navi";

/** config の masterEdit を既定値で補う（無い・壊れている項目は既定値。§24 で既定は gitlab） */
export function resolveMasterEdit(cfg: Partial<MasterEditConfig> | null | undefined): MasterEditConfig {
  const g: Partial<MasterEditConfig["gitlab"]> = cfg?.gitlab ?? {};
  const mode = cfg?.mode === "download" || cfg?.mode === "demo" ? cfg.mode : "gitlab";
  const apiBaseUrl = typeof g.apiBaseUrl === "string" ? g.apiBaseUrl.trim().replace(/\/+$/, "") : "";
  const projectId = typeof g.projectId === "string" || typeof g.projectId === "number" ? String(g.projectId).trim() : "";
  return {
    mode,
    gitlab: {
      apiBaseUrl: mode === "demo" ? DEMO_API_BASE : apiBaseUrl,
      projectId: mode === "demo" ? DEMO_PROJECT_ID : projectId,
      targetBranch: typeof g.targetBranch === "string" && g.targetBranch.trim() !== "" ? g.targetBranch.trim() : "main",
      commitMode: g.commitMode === "direct" && mode !== "demo" ? "direct" : "mr",
    },
  };
}

/** 実際に使う保存方式: mode が gitlab でも apiBaseUrl か projectId が空なら download（§19.2）。demo は gitlab と同じ流れ */
export function effectiveSaveMode(cfg: MasterEditConfig): SaveMode {
  if (cfg.mode === "demo") return "gitlab";
  return cfg.mode === "gitlab" && cfg.gitlab.apiBaseUrl !== "" && cfg.gitlab.projectId !== "" ? "gitlab" : "download";
}

/** GitLab 接続（MR 一覧・バッジ・設定画面）が使えるか */
export function gitlabConfigured(cfg: MasterEditConfig): boolean {
  return effectiveSaveMode(cfg) === "gitlab";
}

/** プロジェクトの API パス（"group/project" は URL エンコードする） */
export function projectPath(cfg: MasterEditConfig): string {
  return `${cfg.gitlab.apiBaseUrl}/projects/${encodeURIComponent(cfg.gitlab.projectId)}`;
}

/**
 * GitLab の Web 画面のファイル URL（projectId が "group/project" 形式のときだけ作れる。数値 ID なら null）。
 * download モードの手順で「このファイルを開く」リンクに使う
 */
export function webFileUrl(cfg: MasterEditConfig, path: string): string | null {
  const { apiBaseUrl, projectId, targetBranch } = cfg.gitlab;
  if (apiBaseUrl === "" || projectId === "" || /^\d+$/.test(projectId)) return null;
  const origin = apiBaseUrl.replace(/\/api\/v4$/, "");
  if (origin === apiBaseUrl) return null;
  return `${origin}/${projectId}/-/blob/${encodeURIComponent(targetBranch)}/${path}`;
}

/** ブランチ名 masters/<YYYYMMDD-HHmmss>-<user>（日時は JST。user は英数・.-_ 以外を - に） */
export function masterBranchName(now: Date, user: string): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${jst.getUTCFullYear()}${p(jst.getUTCMonth() + 1)}${p(jst.getUTCDate())}-${p(jst.getUTCHours())}${p(jst.getUTCMinutes())}${p(jst.getUTCSeconds())}`;
  const safe = user
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .replace(/\.{2,}/g, ".")
    .slice(0, 40);
  return `masters/${stamp}-${safe || "user"}`;
}

export interface CommitFile {
  /** リポジトリ内のパス（例 data/masters/rates.csv） */
  path: string;
  content: string;
  /** 編集の土台にしたファイルの最終コミット ID（無ければ競合を検出できない） */
  lastCommitId: string | null;
}

export interface CommitPayload {
  branch: string;
  commit_message: string;
  start_branch?: string;
  actions: Array<{ action: "update"; file_path: string; content: string; encoding: "text"; last_commit_id?: string }>;
}

/** commits API の本文 */
export function buildCommitPayload(args: { files: readonly CommitFile[]; message: string; branch: string; startBranch?: string }): CommitPayload {
  const payload: CommitPayload = {
    branch: args.branch,
    commit_message: args.message,
    actions: args.files.map((f) => {
      const a: CommitPayload["actions"][number] = { action: "update", file_path: f.path, content: f.content, encoding: "text" };
      if (f.lastCommitId) a.last_commit_id = f.lastCommitId;
      return a;
    }),
  };
  if (args.startBranch !== undefined) payload.start_branch = args.startBranch;
  return payload;
}

// ---------------------------------------------------------------------------
// エラー
// ---------------------------------------------------------------------------

export type GitLabErrorKind = "conflict" | "permission" | "network" | "other";

export class GitLabError extends Error {
  readonly kind: GitLabErrorKind;
  readonly status: number | null;
  /** GitLab が返したメッセージ（あれば） */
  readonly detail: string;
  /** mr モードでコミットまで成功し、MR の作成で失敗したときのブランチ・コミット */
  readonly partial: { branch: string; commitUrl: string | null } | null;
  constructor(kind: GitLabErrorKind, message: string, opts: { status?: number | null; detail?: string; partial?: GitLabError["partial"] } = {}) {
    super(message);
    this.name = "GitLabError";
    this.kind = kind;
    this.status = opts.status ?? null;
    this.detail = opts.detail ?? "";
    this.partial = opts.partial ?? null;
  }
}

/** GitLab のエラー本文からメッセージを取り出す（{message} / {error} / 文字列） */
export function gitlabMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { message?: unknown; error?: unknown; error_description?: unknown };
    const m = j.message ?? j.error_description ?? j.error;
    if (typeof m === "string") return m;
    if (Array.isArray(m)) return m.map(String).join(" / ");
    if (m && typeof m === "object") return Object.entries(m).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`).join(" / ");
  } catch {
    /* JSON でない */
  }
  return body.slice(0, 300);
}

/** last_commit_id 不一致（他の人が先に更新）を表す 400 のメッセージ */
const CONFLICT_PATTERN = /changed since|last_commit_id|has been (?:modified|updated)|conflict|outdated/i;

/** HTTP ステータスと本文からエラーを分類する（step はどの操作か） */
export type Step = "user" | "commit" | "mr" | "project" | "list" | "file" | "merge" | "close";

export function classifyHttpError(step: Step, status: number, body: string): GitLabError {
  const detail = gitlabMessage(body);
  if (step === "merge") {
    // GitLab はマージできない人に 401 を返す（トークンは直前の一覧取得で確認済み）
    if (status === 401 || status === 403) return new GitLabError("permission", T.gitlab.noMergePermission, { status, detail });
    if (status === 405 || status === 406 || status === 422) return new GitLabError("conflict", T.gitlab.notMergeable, { status, detail });
    if (status === 409) return new GitLabError("conflict", T.gitlab.mergeShaChanged, { status, detail });
  }
  if (status === 401) {
    return new GitLabError("permission", T.gitlab.tokenInvalid, { status, detail });
  }
  if (status === 403) {
    return new GitLabError("permission", T.gitlab.noPermission, { status, detail });
  }
  if (step === "commit" && (status === 409 || (status === 400 && CONFLICT_PATTERN.test(detail)))) {
    return new GitLabError("conflict", T.gitlab.conflict, { status, detail });
  }
  if (status === 404) {
    return new GitLabError("other", T.gitlab.notFound, { status, detail });
  }
  const what = T.gitlab.steps[step];
  return new GitLabError("other", fmt(T.gitlab.failed, { step: what, status }), { status, detail });
}

/** fetch 自体が失敗した（ネットワーク断・CORS で拒否・証明書など。ブラウザからは区別できない） */
export function networkError(cause: unknown): GitLabError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new GitLabError(
    "network",
    T.gitlab.network,
    { detail },
  );
}

// ---------------------------------------------------------------------------
// 呼び出し
// ---------------------------------------------------------------------------

async function requestText(fetchImpl: FetchLike, step: Step, url: string, token: string, method: string, body?: unknown): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { "PRIVATE-TOKEN": token, Accept: "application/json" };
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    throw networkError(e);
  }
  let text = "";
  try {
    text = await res.text();
  } catch (e) {
    if (res.ok) throw networkError(e);
  }
  if (!res.ok) throw classifyHttpError(step, res.status, text);
  return { status: res.status, text };
}

async function request<T>(fetchImpl: FetchLike, step: Step, url: string, token: string, method: string, body?: unknown): Promise<T> {
  const res = await requestText(fetchImpl, step, url, token, method, body);
  try {
    return (res.text === "" ? {} : JSON.parse(res.text)) as T;
  } catch {
    throw new GitLabError("other", T.gitlab.notJson, { status: res.status, detail: res.text.slice(0, 300) });
  }
}

export interface SaveRequest {
  config: MasterEditConfig;
  token: string;
  files: readonly CommitFile[];
  /** コミットメッセージ（MR のタイトルにも使う） */
  message: string;
  /** MR の説明（変更の一覧など） */
  description?: string;
  now?: Date;
}

export interface SaveResult {
  commitMode: "mr" | "direct";
  branch: string;
  commitId: string | null;
  commitUrl: string | null;
  mergeRequestUrl: string | null;
  mergeRequestIid: number | null;
  /** トークンの持ち主（GET /user の username） */
  user: string;
}

/**
 * 変更したファイルを GitLab に保存する。
 * 1) GET /user（トークンの確認とブランチ名用の username）
 * 2) POST /projects/:id/repository/commits
 * 3) mr モードなら POST /projects/:id/merge_requests
 */
export async function saveToGitLab(fetchImpl: FetchLike, req: SaveRequest): Promise<SaveResult> {
  const cfg = req.config;
  if (effectiveSaveMode(cfg) !== "gitlab") throw new GitLabError("other", T.gitlab.notConfigured);
  if (req.token.trim() === "") throw new GitLabError("permission", T.gitlab.noToken);
  if (req.files.length === 0) throw new GitLabError("other", T.gitlab.noChanges);
  const token = req.token.trim();
  const me = await request<{ username?: string }>(fetchImpl, "user", `${cfg.gitlab.apiBaseUrl}/user`, token, "GET");
  const user = typeof me.username === "string" ? me.username : "user";
  const mr = cfg.gitlab.commitMode === "mr";
  const branch = mr ? masterBranchName(req.now ?? new Date(), user) : cfg.gitlab.targetBranch;
  const payload = buildCommitPayload(mr ? { files: req.files, message: req.message, branch, startBranch: cfg.gitlab.targetBranch } : { files: req.files, message: req.message, branch });
  const commit = await request<{ id?: string; web_url?: string }>(fetchImpl, "commit", `${projectPath(cfg)}/repository/commits`, token, "POST", payload);
  const commitId = typeof commit.id === "string" ? commit.id : null;
  const commitUrl = typeof commit.web_url === "string" ? commit.web_url : null;
  if (!mr) return { commitMode: "direct", branch, commitId, commitUrl, mergeRequestUrl: null, mergeRequestIid: null, user };
  let created: { web_url?: string; iid?: number };
  try {
    created = await request<{ web_url?: string; iid?: number }>(fetchImpl, "mr", `${projectPath(cfg)}/merge_requests`, token, "POST", {
      source_branch: branch,
      target_branch: cfg.gitlab.targetBranch,
      title: req.message,
      description: req.description ?? "",
      remove_source_branch: true,
    });
  } catch (e) {
    const err = e as GitLabError;
    // コミットは済んでいるので「ダウンロードに切り替え」は出さない（network → other）
    throw new GitLabError(err.kind === "permission" ? "permission" : "other", fmt(T.gitlab.mrFailed, { branch, error: err.status ? `（HTTP ${err.status}${err.detail ? `: ${err.detail}` : ""}）` : "" }), {
      status: err.status,
      detail: err.detail,
      partial: { branch, commitUrl },
    });
  }
  return {
    commitMode: "mr",
    branch,
    commitId,
    commitUrl,
    mergeRequestUrl: typeof created.web_url === "string" ? created.web_url : null,
    mergeRequestIid: typeof created.iid === "number" ? created.iid : null,
    user,
  };
}

// ---------------------------------------------------------------------------
// マージ待ちの変更（§26）・設定画面の接続確認（§28）
// ---------------------------------------------------------------------------

/** この画面で作る MR のソースブランチの接頭辞（masterBranchName と同じ） */
export const MASTER_BRANCH_PREFIX = "masters/";

/** GitLab の権限レベル（access_level） */
export const ACCESS_LEVELS: Readonly<Record<number, string>> = { 10: "Guest", 20: "Reporter", 30: "Developer", 40: "Maintainer", 50: "Owner" };

export interface GitLabUser {
  username: string;
  name: string;
}

export interface ConnectionInfo {
  user: GitLabUser;
  /** プロジェクトでの権限レベル（プロジェクトとグループの大きいほう。取れなければ null） */
  accessLevel: number | null;
}

function token0(token: string): string {
  const t = token.trim();
  if (t === "") throw new GitLabError("permission", T.gitlab.noToken);
  return t;
}

function ensureConfigured(cfg: MasterEditConfig): void {
  if (!gitlabConfigured(cfg)) throw new GitLabError("other", T.gitlab.notConfigured);
}

/** トークンの持ち主 */
export async function fetchCurrentUser(fetchImpl: FetchLike, cfg: MasterEditConfig, token: string): Promise<GitLabUser> {
  ensureConfigured(cfg);
  const me = await request<{ username?: unknown; name?: unknown }>(fetchImpl, "user", `${cfg.gitlab.apiBaseUrl}/user`, token0(token), "GET");
  return userOf(me);
}

/** 接続の確認: トークンの持ち主と、このプロジェクトでの権限 */
export async function checkConnection(fetchImpl: FetchLike, cfg: MasterEditConfig, token: string): Promise<ConnectionInfo> {
  ensureConfigured(cfg);
  const t = token0(token);
  const user = await fetchCurrentUser(fetchImpl, cfg, t);
  const project = await request<{ permissions?: { project_access?: { access_level?: unknown } | null; group_access?: { access_level?: unknown } | null } }>(fetchImpl, "project", projectPath(cfg), t, "GET");
  const levels = [project.permissions?.project_access?.access_level, project.permissions?.group_access?.access_level].filter((v): v is number => typeof v === "number");
  return { user, accessLevel: levels.length ? Math.max(...levels) : null };
}

export interface MergeRequestSummary {
  iid: number;
  title: string;
  description: string;
  author: GitLabUser;
  createdAt: string;
  webUrl: string | null;
  sourceBranch: string;
  /** 競合（GitLab が判定済みのとき） */
  hasConflicts: boolean;
}

function userOf(u: unknown): GitLabUser {
  const o = (u && typeof u === "object" ? u : {}) as { username?: unknown; name?: unknown };
  return { username: typeof o.username === "string" ? o.username : "", name: typeof o.name === "string" ? o.name : "" };
}

function summaryOf(m: Record<string, unknown>): MergeRequestSummary {
  return {
    iid: Number(m.iid),
    title: typeof m.title === "string" ? m.title : "",
    description: typeof m.description === "string" ? m.description : "",
    author: userOf(m.author),
    createdAt: typeof m.created_at === "string" ? m.created_at : "",
    webUrl: typeof m.web_url === "string" ? m.web_url : null,
    sourceBranch: typeof m.source_branch === "string" ? m.source_branch : "",
    hasConflicts: m.has_conflicts === true,
  };
}

/** マスタ編集の MR か（targetBranch 向けで、この画面のブランチから） */
export function isMasterMergeRequest(cfg: MasterEditConfig, m: { source_branch?: unknown; target_branch?: unknown; state?: unknown }): boolean {
  return typeof m.source_branch === "string" && m.source_branch.startsWith(MASTER_BRANCH_PREFIX) && m.target_branch === cfg.gitlab.targetBranch && (m.state === undefined || m.state === "opened");
}

/** 開いているマスタ編集の MR（新しい順） */
export async function listMasterMergeRequests(fetchImpl: FetchLike, cfg: MasterEditConfig, token: string): Promise<MergeRequestSummary[]> {
  ensureConfigured(cfg);
  const q = `state=opened&target_branch=${encodeURIComponent(cfg.gitlab.targetBranch)}&order_by=created_at&sort=desc&per_page=100`;
  const list = await request<unknown>(fetchImpl, "list", `${projectPath(cfg)}/merge_requests?${q}`, token0(token), "GET");
  if (!Array.isArray(list)) throw new GitLabError("other", T.gitlab.notJson, { detail: "not an array" });
  return list
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object" && isMasterMergeRequest(cfg, m as Record<string, unknown>))
    .map(summaryOf)
    .filter((m) => Number.isFinite(m.iid));
}

export interface MergeRequestDetail extends MergeRequestSummary {
  /** このトークンの人がマージできるか（GitLab の user.can_merge。§26 の出し分けに使う） */
  canMerge: boolean;
  headSha: string | null;
  baseSha: string | null;
  /** MR のパイプラインの状態（success / failed / running …。無ければ null） */
  pipelineStatus: string | null;
  /** GitLab のマージ可否の詳細（mergeable / conflict / ci_must_pass …。古い GitLab は merge_status） */
  mergeStatus: string | null;
}

export async function getMergeRequest(fetchImpl: FetchLike, cfg: MasterEditConfig, token: string, iid: number): Promise<MergeRequestDetail> {
  ensureConfigured(cfg);
  const m = await request<Record<string, unknown>>(fetchImpl, "list", `${projectPath(cfg)}/merge_requests/${iid}`, token0(token), "GET");
  const refs = (m.diff_refs && typeof m.diff_refs === "object" ? m.diff_refs : {}) as { base_sha?: unknown; head_sha?: unknown };
  const user = (m.user && typeof m.user === "object" ? m.user : {}) as { can_merge?: unknown };
  const pipe = (m.head_pipeline && typeof m.head_pipeline === "object" ? m.head_pipeline : null) as { status?: unknown } | null;
  const status = typeof m.detailed_merge_status === "string" ? m.detailed_merge_status : typeof m.merge_status === "string" ? m.merge_status : null;
  return {
    ...summaryOf(m),
    canMerge: user.can_merge === true,
    headSha: typeof refs.head_sha === "string" ? refs.head_sha : typeof m.sha === "string" ? m.sha : null,
    baseSha: typeof refs.base_sha === "string" ? refs.base_sha : null,
    pipelineStatus: pipe && typeof pipe.status === "string" ? pipe.status : null,
    mergeStatus: status,
  };
}

/** ファイルの中身（ref 時点）。無ければ null */
export async function fetchFileRaw(fetchImpl: FetchLike, cfg: MasterEditConfig, token: string, path: string, ref: string): Promise<string | null> {
  ensureConfigured(cfg);
  try {
    const res = await requestText(fetchImpl, "file", `${projectPath(cfg)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`, token0(token), "GET");
    return res.text;
  } catch (e) {
    if (e instanceof GitLabError && e.status === 404) return null;
    throw e;
  }
}

export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
}

/** MR で変わったファイル（paths のうち、base と head で中身が違うもの） */
export async function mergeRequestFileChanges(fetchImpl: FetchLike, cfg: MasterEditConfig, token: string, mr: Pick<MergeRequestDetail, "baseSha" | "headSha">, paths: readonly string[]): Promise<FileChange[]> {
  const base = mr.baseSha ?? cfg.gitlab.targetBranch;
  const head = mr.headSha;
  if (!head) return [];
  const out = await Promise.all(
    paths.map(async (path) => {
      const [before, after] = await Promise.all([fetchFileRaw(fetchImpl, cfg, token, path, base), fetchFileRaw(fetchImpl, cfg, token, path, head)]);
      return { path, before, after };
    }),
  );
  return out.filter((c) => c.before !== c.after);
}

/** マージする（sha = 確認した head。違えば GitLab が 409 で拒否する） */
export async function mergeMergeRequest(fetchImpl: FetchLike, cfg: MasterEditConfig, token: string, iid: number, sha: string | null): Promise<void> {
  ensureConfigured(cfg);
  const body: Record<string, unknown> = { should_remove_source_branch: true };
  if (sha) body.sha = sha;
  await request(fetchImpl, "merge", `${projectPath(cfg)}/merge_requests/${iid}/merge`, token0(token), "PUT", body);
}

/** 取り下げる（MR を閉じる） */
export async function closeMergeRequest(fetchImpl: FetchLike, cfg: MasterEditConfig, token: string, iid: number): Promise<void> {
  ensureConfigured(cfg);
  await request(fetchImpl, "close", `${projectPath(cfg)}/merge_requests/${iid}`, token0(token), "PUT", { state_event: "close" });
}
