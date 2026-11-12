/**
 * 試用のデモ（SPEC §29）: GitLab REST API の代わりにブラウザ内で動く模擬。
 *
 * gitlab.ts が使う範囲（/user、/personal_access_tokens/self、/projects/:id、保護ブランチ、commits、merge_requests の作成・一覧・詳細・マージ・取り下げ、
 * repository/files/:path(/raw)）だけを、localStorage 相当の保存先に持つ。fetch と同じ形（FetchLike）なので
 * 画面・テストからは本物の GitLab と同じ呼び方で使える。
 *
 * - 本体（targetBranch）の中身は画面のビルド時のファイル（baseFiles）。マージしても本体は変えない
 *   （画面のデータはビルドし直さないと変わらないため。画面にもそう明記する）
 * - 「マージできる立場か」は canMerge() で切り替える（設定画面の「リーダーとして操作」）
 * - web_url は返さない（GitLab の画面は無いのでリンクを出さない）
 */
import type { FetchLike } from "./gitlab.js";
import { DEMO_API_BASE, DEMO_PROJECT_ID } from "./gitlab.js";

export const DEMO_STORAGE_KEY = "yojitsu-navi:gitlab-demo:v1";
export const DEMO_ROLE_KEY = "yojitsu-navi:gitlab-demo-role";
/** デモの本体の base_sha（diff_refs） */
export const DEMO_BASE_SHA = "demo-base";

export interface DemoStore {
  seq: number;
  branches: Record<string, { files: Record<string, string>; head: string }>;
  mrs: Array<{
    iid: number;
    title: string;
    description: string;
    source_branch: string;
    target_branch: string;
    state: "opened" | "merged" | "closed";
    author: { username: string; name: string };
    created_at: string;
  }>;
}

export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface DemoOptions {
  storage: KeyValueStorage;
  /** 本体のファイル（パス → 中身・最終コミット ID）。無いパスは 404 */
  baseFiles?: Record<string, { text: string; lastCommitId: string | null }>;
  /** マージできる立場か（既定 true） */
  canMerge?: () => boolean;
  now?: () => Date;
  targetBranch?: string;
}

/** theme_id 1 = GitLab の既定テーマ（Indigo）。カラーモードは返さない（本物の GitLab と同じ。PC の設定に合わせる） */
export const DEMO_USER = { username: "demo-user", name: "デモ利用者", theme_id: 1 };

export function emptyDemoStore(): DemoStore {
  return { seq: 0, branches: {}, mrs: [] };
}

export function readDemoStore(storage: KeyValueStorage): DemoStore {
  try {
    const j = JSON.parse(storage.get(DEMO_STORAGE_KEY) ?? "null") as DemoStore | null;
    if (j && typeof j === "object" && Array.isArray(j.mrs) && j.branches && typeof j.seq === "number") return j;
  } catch {
    /* 壊れていれば作り直す */
  }
  return emptyDemoStore();
}

type Reply = { ok: boolean; status: number; text(): Promise<string> };
const reply = (status: number, body: unknown): Reply => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
};

/** 模擬の GitLab（fetch の代わりに渡す） */
export function createGitLabMock(opts: DemoOptions): FetchLike {
  const canMerge = opts.canMerge ?? (() => true);
  const now = opts.now ?? (() => new Date());
  const target = opts.targetBranch ?? "main";
  const base = opts.baseFiles ?? {};
  const load = () => readDemoStore(opts.storage);
  const save = (s: DemoStore) => opts.storage.set(DEMO_STORAGE_KEY, JSON.stringify(s));
  const sha = (s: DemoStore) => `demo${String(++s.seq).padStart(8, "0")}`;

  const mrJson = (s: DemoStore, m: DemoStore["mrs"][number]) => ({
    ...m,
    has_conflicts: false,
    detailed_merge_status: m.state === "opened" ? "mergeable" : "not_open",
    diff_refs: { base_sha: DEMO_BASE_SHA, head_sha: s.branches[m.source_branch]?.head ?? null },
    head_pipeline: { status: "success" },
    user: { can_merge: canMerge() },
  });

  return async (url, init) => {
    if (!url.startsWith(DEMO_API_BASE)) return reply(404, { message: "404 Not Found" });
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace(/^\/api\/v4/, ""));
    const method = init.method.toUpperCase();
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const projectPrefix = `/projects/${DEMO_PROJECT_ID}`;
    if (!init.headers["PRIVATE-TOKEN"]) return reply(401, { message: "401 Unauthorized" });

    if (method === "GET" && path === "/user") return reply(200, DEMO_USER);
    if (method === "GET" && path === "/personal_access_tokens/self") return reply(200, { scopes: ["api"] });
    if (!path.startsWith(projectPrefix)) return reply(404, { message: "404 Project Not Found" });
    const rest = path.slice(projectPrefix.length);

    if (method === "GET" && rest === "") return reply(200, { id: 1, path_with_namespace: DEMO_PROJECT_ID, visibility: "private", pages_access_level: "private", permissions: { project_access: { access_level: canMerge() ? 40 : 30 }, group_access: null } });

    // 推奨どおりの保護（§39.2: 直接プッシュ不可・マージは Maintainer）
    if (method === "GET" && rest === `/protected_branches/${target}`) return reply(200, { name: target, push_access_levels: [{ access_level: 0 }], merge_access_levels: [{ access_level: 40 }] });

    if (method === "POST" && rest === "/repository/commits") {
      const s = load();
      const branch = String(body.branch ?? "");
      if (branch === target || s.branches[branch]) return reply(400, { message: "A branch called this already exists" });
      const actions = Array.isArray(body.actions) ? (body.actions as Array<Record<string, unknown>>) : [];
      for (const a of actions) {
        const b = base[String(a.file_path)];
        if (a.last_commit_id && b && b.lastCommitId && a.last_commit_id !== b.lastCommitId) return reply(400, { message: "You are attempting to update a file that has changed since you started editing it." });
      }
      const head = sha(s);
      s.branches[branch] = { files: Object.fromEntries(actions.map((a) => [String(a.file_path), String(a.content ?? "")])), head };
      save(s);
      return reply(201, { id: head, short_id: head.slice(0, 8) });
    }

    if (method === "POST" && rest === "/merge_requests") {
      const s = load();
      const source = String(body.source_branch ?? "");
      if (!s.branches[source]) return reply(400, { message: "Source branch does not exist" });
      const iid = s.mrs.reduce((m, x) => Math.max(m, x.iid), 0) + 1;
      s.mrs.push({ iid, title: String(body.title ?? ""), description: String(body.description ?? ""), source_branch: source, target_branch: String(body.target_branch ?? target), state: "opened", author: DEMO_USER, created_at: now().toISOString() });
      save(s);
      return reply(201, { iid });
    }

    if (method === "GET" && rest === "/merge_requests") {
      const s = load();
      const state = u.searchParams.get("state");
      const tb = u.searchParams.get("target_branch");
      const list = s.mrs.filter((m) => (!state || m.state === state) && (!tb || m.target_branch === tb)).sort((a, b) => b.iid - a.iid);
      return reply(200, list.map((m) => mrJson(s, m)));
    }

    const mrMatch = /^\/merge_requests\/(\d+)(\/merge)?$/.exec(rest);
    if (mrMatch) {
      const s = load();
      const m = s.mrs.find((x) => x.iid === Number(mrMatch[1]));
      if (!m) return reply(404, { message: "404 Not found" });
      if (method === "GET" && !mrMatch[2]) return reply(200, mrJson(s, m));
      if (method === "PUT" && mrMatch[2]) {
        if (!canMerge()) return reply(401, { message: "401 Unauthorized" });
        if (m.state !== "opened") return reply(405, { message: "405 Method Not Allowed" });
        const head = s.branches[m.source_branch]?.head ?? null;
        if (body.sha && body.sha !== head) return reply(409, { message: "SHA does not match HEAD of source branch" });
        m.state = "merged";
        if (body.should_remove_source_branch) delete s.branches[m.source_branch];
        save(s);
        return reply(200, mrJson(s, m));
      }
      if (method === "PUT" && body.state_event === "close") {
        if (m.state !== "opened") return reply(405, { message: "405 Method Not Allowed" });
        m.state = "closed";
        save(s);
        return reply(200, mrJson(s, m));
      }
    }

    // 本体の中身と最終コミット ID（JSON・base64。§120 の載せ直し）
    const metaMatch = /^\/repository\/files\/(.+)$/.exec(rest);
    if (method === "GET" && metaMatch && !metaMatch[1]!.endsWith("/raw")) {
      const b = base[metaMatch[1] as string];
      if (!b) return reply(404, { message: "404 File Not Found" });
      const bytes = new TextEncoder().encode(b.text);
      let bin = "";
      for (const x of bytes) bin += String.fromCharCode(x);
      return reply(200, { file_path: metaMatch[1], encoding: "base64", content: btoa(bin), last_commit_id: b.lastCommitId });
    }

    const fileMatch = /^\/repository\/files\/(.+)\/raw$/.exec(rest);
    if (method === "GET" && fileMatch) {
      const file = fileMatch[1] as string;
      const ref = u.searchParams.get("ref") ?? target;
      const s = load();
      const branch = Object.values(s.branches).find((b) => b.head === ref);
      const text = branch && file in branch.files ? branch.files[file] : base[file]?.text;
      return text === undefined ? reply(404, { message: "404 File Not Found" }) : reply(200, text);
    }

    return reply(404, { message: "404 Not Found" });
  };
}
