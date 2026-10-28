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
  mode: "download",
  gitlab: { apiBaseUrl: "", projectId: "", targetBranch: "main", commitMode: "mr" },
};

/** config の masterEdit を既定値で補う（無い・壊れている項目は既定値） */
export function resolveMasterEdit(cfg: Partial<MasterEditConfig> | null | undefined): MasterEditConfig {
  const g: Partial<MasterEditConfig["gitlab"]> = cfg?.gitlab ?? {};
  return {
    mode: cfg?.mode === "gitlab" ? "gitlab" : "download",
    gitlab: {
      apiBaseUrl: typeof g.apiBaseUrl === "string" ? g.apiBaseUrl.trim().replace(/\/+$/, "") : "",
      projectId: typeof g.projectId === "string" || typeof g.projectId === "number" ? String(g.projectId).trim() : "",
      targetBranch: typeof g.targetBranch === "string" && g.targetBranch.trim() !== "" ? g.targetBranch.trim() : "main",
      commitMode: g.commitMode === "direct" ? "direct" : "mr",
    },
  };
}

/** 実際に使う保存方式: mode が gitlab でも apiBaseUrl か projectId が空なら download（§19.2） */
export function effectiveSaveMode(cfg: MasterEditConfig): SaveMode {
  return cfg.mode === "gitlab" && cfg.gitlab.apiBaseUrl !== "" && cfg.gitlab.projectId !== "" ? "gitlab" : "download";
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
export function classifyHttpError(step: "user" | "commit" | "mr", status: number, body: string): GitLabError {
  const detail = gitlabMessage(body);
  if (status === 401) {
    return new GitLabError("permission", T.gitlab.tokenInvalid, { status, detail });
  }
  if (status === 403) {
    return new GitLabError("permission", T.gitlab.noPermission, { status, detail });
  }
  if (status === 409 || (step === "commit" && status === 400 && CONFLICT_PATTERN.test(detail))) {
    return new GitLabError("conflict", T.gitlab.conflict, { status, detail });
  }
  if (status === 404) {
    return new GitLabError("other", T.gitlab.notFound, { status, detail });
  }
  const what = step === "user" ? T.gitlab.stepUser : step === "commit" ? T.gitlab.stepCommit : T.gitlab.stepMr;
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

async function request<T>(fetchImpl: FetchLike, step: "user" | "commit" | "mr", url: string, token: string, method: string, body?: unknown): Promise<T> {
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
  try {
    return (text === "" ? {} : JSON.parse(text)) as T;
  } catch {
    throw new GitLabError("other", T.gitlab.notJson, { status: res.status, detail: text.slice(0, 300) });
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
    throw new GitLabError(err.kind === "permission" ? "permission" : "other", fmt(T.gitlab.mrFailed, { branch, error: err.message }), {
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
