/**
 * マージ待ちの変更（SPEC §26）・接続の確認（§28）・デモの模擬 GitLab（§29）
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEMO_API_BASE,
  GitLabError,
  checkConnection,
  closeMergeRequest,
  fetchFileRaw,
  getMergeRequest,
  gitlabConfigured,
  isMasterMergeRequest,
  listMasterMergeRequests,
  mergeMergeRequest,
  mergeRequestFileChanges,
  resolveMasterEdit,
  saveToGitLab,
  type FetchLike,
} from "../../src/core/gitlab.js";
import { DEMO_STORAGE_KEY, createGitLabMock, readDemoStore } from "../../src/core/gitlab-mock.js";
import type { MasterEditConfig } from "../../src/core/types.js";

const cfg: MasterEditConfig = { mode: "gitlab", gitlab: { apiBaseUrl: "https://g.local/api/v4", projectId: "grp/yn", targetBranch: "main", commitMode: "mr" } };

function route(map: Record<string, { status?: number; body?: unknown; raw?: string }>): { fetch: FetchLike; calls: Array<{ method: string; url: string; body: unknown }> } {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    const key = Object.keys(map).find((k) => {
      const [m, p] = k.split(" ");
      return m === init.method && url.includes(p as string);
    });
    if (!key) throw new TypeError("Failed to fetch");
    const r = map[key]!;
    const status = r.status ?? 200;
    return { ok: status < 300, status, text: async () => r.raw ?? JSON.stringify(r.body ?? {}) };
  };
  return { fetch, calls };
}

describe("設定（§24・§29）", () => {
  it("既定は gitlab。接続先が空なら保存は download、MR 一覧は使えない", () => {
    const c = resolveMasterEdit({});
    expect(c.mode).toBe("gitlab");
    expect(gitlabConfigured(c)).toBe(false);
  });
  it("demo は接続先を模擬に固定し、mr で動く（direct は無視）", () => {
    const c = resolveMasterEdit({ mode: "demo", gitlab: { apiBaseUrl: "x", projectId: "y", targetBranch: "main", commitMode: "direct" } });
    expect(c.gitlab.apiBaseUrl).toBe(DEMO_API_BASE);
    expect(c.gitlab.commitMode).toBe("mr");
    expect(gitlabConfigured(c)).toBe(true);
  });
});

describe("MR 一覧・詳細", () => {
  it("masters/ のブランチ・targetBranch 向け・opened だけ", async () => {
    const { fetch, calls } = route({
      "GET /merge_requests?": {
        body: [
          { iid: 3, title: "a", source_branch: "masters/x", target_branch: "main", state: "opened", author: { username: "u", name: "U" }, created_at: "2026-10-28T00:00:00Z", web_url: "https://g/mr/3" },
          { iid: 2, title: "b", source_branch: "feature/x", target_branch: "main", state: "opened" },
          { iid: 1, title: "c", source_branch: "masters/y", target_branch: "dev", state: "opened" },
        ],
      },
    });
    const list = await listMasterMergeRequests(fetch, cfg, "t");
    expect(list.map((m) => m.iid)).toEqual([3]);
    expect(list[0]).toMatchObject({ title: "a", author: { username: "u", name: "U" }, webUrl: "https://g/mr/3" });
    expect(calls[0]!.url).toContain("/projects/grp%2Fyn/merge_requests?state=opened&target_branch=main");
  });
  it("isMasterMergeRequest", () => {
    expect(isMasterMergeRequest(cfg, { source_branch: "masters/a", target_branch: "main", state: "merged" })).toBe(false);
    expect(isMasterMergeRequest(cfg, { source_branch: "masters/a", target_branch: "main" })).toBe(true);
  });
  it("詳細: can_merge・diff_refs・パイプライン・detailed_merge_status（古い GitLab は merge_status）", async () => {
    const { fetch } = route({
      "GET /merge_requests/5": { body: { iid: 5, user: { can_merge: true }, diff_refs: { base_sha: "b", head_sha: "h" }, head_pipeline: { status: "failed" }, merge_status: "can_be_merged" } },
    });
    const d = await getMergeRequest(fetch, cfg, "t", 5);
    expect(d).toMatchObject({ canMerge: true, baseSha: "b", headSha: "h", pipelineStatus: "failed", mergeStatus: "can_be_merged" });
  });
  it("詳細: user が無ければマージできない扱い", async () => {
    const { fetch } = route({ "GET /merge_requests/5": { body: { iid: 5, sha: "s" } } });
    const d = await getMergeRequest(fetch, cfg, "t", 5);
    expect(d.canMerge).toBe(false);
    expect(d.headSha).toBe("s");
  });
  it("トークンが無ければ呼ばない", async () => {
    const { fetch, calls } = route({});
    await expect(listMasterMergeRequests(fetch, cfg, " ")).rejects.toMatchObject({ kind: "permission" });
    expect(calls).toHaveLength(0);
  });
});

describe("マージ・取り下げ", () => {
  it("マージは sha とソースブランチ削除を付ける", async () => {
    const { fetch, calls } = route({ "PUT /merge_requests/7/merge": { body: {} } });
    await mergeMergeRequest(fetch, cfg, "t", 7, "abc");
    expect(calls[0]!.body).toEqual({ should_remove_source_branch: true, sha: "abc" });
  });
  it.each([
    [401, "permission", "マージする権限"],
    [403, "permission", "マージする権限"],
    [405, "conflict", "今はマージできません"],
    [406, "conflict", "今はマージできません"],
    [409, "conflict", "新しい変更"],
  ])("マージの失敗 HTTP %i → %s", async (status, kind, text) => {
    const { fetch } = route({ "PUT /merge_requests/7/merge": { status, body: { message: "x" } } });
    const e = (await mergeMergeRequest(fetch, cfg, "t", 7, null).catch((x) => x)) as GitLabError;
    expect(e.kind).toBe(kind);
    expect(e.message).toContain(text);
  });
  it("取り下げは state_event=close", async () => {
    const { fetch, calls } = route({ "PUT /merge_requests/7": { body: {} } });
    await closeMergeRequest(fetch, cfg, "t", 7);
    expect(calls[0]!.body).toEqual({ state_event: "close" });
  });
  it("ネットワーク失敗は network", async () => {
    const { fetch } = route({});
    await expect(closeMergeRequest(fetch, cfg, "t", 7)).rejects.toMatchObject({ kind: "network" });
  });
});

describe("ファイルと接続の確認", () => {
  it("ファイルの中身。404 は null、他の失敗は投げる", async () => {
    const { fetch, calls } = route({ "GET /raw?ref=h": { raw: "a,b\n" }, "GET /raw?ref=b": { status: 404, body: {} } });
    expect(await fetchFileRaw(fetch, cfg, "t", "data/masters/rates.csv", "h")).toBe("a,b\n");
    expect(calls[0]!.url).toContain("/repository/files/data%2Fmasters%2Frates.csv/raw?ref=h");
    expect(await fetchFileRaw(fetch, cfg, "t", "x.csv", "b")).toBeNull();
  });
  it("mergeRequestFileChanges: 中身が違うファイルだけ", async () => {
    const fetch: FetchLike = async (url) => {
      const ref = new URL(url).searchParams.get("ref");
      const same = url.includes("teams");
      return { ok: true, status: 200, text: async () => (same ? "x\n" : `${ref}\n`) };
    };
    const out = await mergeRequestFileChanges(fetch, cfg, "t", { baseSha: "b", headSha: "h" }, ["data/masters/rates.csv", "data/masters/teams.csv"]);
    expect(out).toEqual([{ path: "data/masters/rates.csv", before: "b\n", after: "h\n" }]);
    expect(await mergeRequestFileChanges(fetch, cfg, "t", { baseSha: "b", headSha: null }, ["a"])).toEqual([]);
  });
  it("checkConnection: ユーザーと権限（プロジェクトとグループの大きいほう）", async () => {
    const { fetch } = route({ "GET /user": { body: { username: "sato", name: "佐藤" } }, "GET /projects/grp%2Fyn": { body: { permissions: { project_access: { access_level: 30 }, group_access: { access_level: 40 } } } } });
    expect(await checkConnection(fetch, cfg, "t")).toEqual({ user: { username: "sato", name: "佐藤" }, accessLevel: 40, warnings: [] });
  });
  it("checkConnection: 権限が無ければ null。トークン無効は permission", async () => {
    const ok = route({ "GET /user": { body: { username: "a" } }, "GET /projects/grp%2Fyn": { body: { permissions: {} } } });
    expect((await checkConnection(ok.fetch, cfg, "t")).accessLevel).toBeNull();
    const bad = route({ "GET /user": { status: 401, body: { message: "401 Unauthorized" } } });
    await expect(checkConnection(bad.fetch, cfg, "t")).rejects.toMatchObject({ kind: "permission", status: 401 });
  });
});

describe("接続の確認: 本番の設定の不足（§38.3）", () => {
  const user = { "GET /user": { body: { username: "sato", name: "佐藤" } } };
  const project = (level: number, extra: Record<string, unknown> = {}) => ({ "GET /projects/grp%2Fyn": { body: { visibility: "private", pages_access_level: "private", permissions: { project_access: { access_level: level } }, ...extra } } });
  const protectedMain = (push: number[], merge: number[]) => ({
    "GET /protected_branches/main": { body: { push_access_levels: push.map((access_level) => ({ access_level })), merge_access_levels: merge.map((access_level) => ({ access_level })) } },
  });
  const run = (map: Parameters<typeof route>[0]) => checkConnection(route(map).fetch, cfg, "t");

  it("推奨どおりなら警告なし", async () => {
    const info = await run({ ...user, "GET /personal_access_tokens/self": { body: { scopes: ["api"] } }, ...protectedMain([0], [40]), ...project(40) });
    expect(info.warnings).toEqual([]);
  });
  it("scope が read_api だけなら scope。公開範囲・Pages が公開なら visibility・pagesPublic", async () => {
    const info = await run({ ...user, "GET /personal_access_tokens/self": { body: { scopes: ["read_api"] } }, ...project(30, { visibility: "internal", pages_access_level: "public" }) });
    expect(info.warnings).toEqual(["scope", "visibility", "pagesPublic"]);
  });
  it("リーダーには保護ブランチの不足を出す（未保護・直接プッシュ可・Developer もマージ可）", async () => {
    expect((await run({ ...user, "GET /protected_branches/main": { status: 404, body: { message: "404 Not found" } }, ...project(40) })).warnings).toEqual(["unprotected"]);
    expect((await run({ ...user, ...protectedMain([40], [30]), ...project(40) })).warnings).toEqual(["pushAllowed", "mergeByDeveloper"]);
    // 個人・グループの指定（access_level が null）は判定しない
    expect((await run({ ...user, "GET /protected_branches/main": { body: { push_access_levels: [{ access_level: null }], merge_access_levels: [{ access_level: null }] } }, ...project(40) })).warnings).toEqual([]);
  });
  it("Developer には保護ブランチを問い合わせない。読めない項目・古い GitLab（404・403・接続失敗）は警告しない", async () => {
    const r = route({ ...user, ...protectedMain([40], [30]), ...project(30) });
    expect((await checkConnection(r.fetch, cfg, "t")).warnings).toEqual([]);
    expect(r.calls.some((c) => c.url.includes("protected_branches"))).toBe(false);
    expect((await run({ ...user, "GET /personal_access_tokens/self": { status: 404 }, "GET /protected_branches/main": { status: 403 }, "GET /projects/grp%2Fyn": { body: { permissions: { project_access: { access_level: 40 } } } } })).warnings).toEqual([]);
  });
  it("デモの模擬は推奨どおり（警告なし）", async () => {
    const mem = new Map<string, string>();
    const demo = resolveMasterEdit({ mode: "demo" });
    const fetch = createGitLabMock({ storage: { get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v) }, baseFiles: {}, canMerge: () => true });
    expect((await checkConnection(fetch, demo, "demo")).warnings).toEqual([]);
  });
});

describe("デモの模擬 GitLab（§29）: 保存 → 一覧 → 内容 → マージ", () => {
  const demo = resolveMasterEdit({ mode: "demo" });
  let mem: Map<string, string>;
  let leader: boolean;
  const base = { "data/masters/rates.csv": { text: "key,hourly_rate,effective_from\n部長,12000,2025-04\n", lastCommitId: "c1" } };
  const mock = () => createGitLabMock({ storage: { get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v) }, baseFiles: base, canMerge: () => leader, now: () => new Date("2026-10-28T00:00:00Z") });
  beforeEach(() => {
    mem = new Map();
    leader = true;
  });
  const save = (lastCommitId = "c1") =>
    saveToGitLab(mock(), { config: demo, token: "demo", message: "単価", files: [{ path: "data/masters/rates.csv", content: "key,hourly_rate,effective_from\n部長,12000,2025-04\n部長,13000,2026-04\n", lastCommitId }], now: new Date("2026-10-28T00:00:00Z") });

  it("保存で MR ができ、一覧・詳細・内容が取れる", async () => {
    const r = await save();
    expect(r).toMatchObject({ commitMode: "mr", mergeRequestIid: 1, mergeRequestUrl: null, user: "demo-user" });
    const list = await listMasterMergeRequests(mock(), demo, "demo");
    expect(list.map((m) => m.title)).toEqual(["単価"]);
    const d = await getMergeRequest(mock(), demo, "demo", 1);
    expect(d.canMerge).toBe(true);
    const ch = await mergeRequestFileChanges(mock(), demo, "demo", d, ["data/masters/rates.csv", "data/masters/teams.csv"]);
    expect(ch).toHaveLength(1);
    expect(ch[0]!.after).toContain("13000");
  });
  it("元データが古い（last_commit_id 違い）と競合", async () => {
    await expect(save("old")).rejects.toMatchObject({ kind: "conflict" });
  });
  it("リーダーでなければマージできない（401 → 権限の案内）、ボタンも出ない", async () => {
    await save();
    leader = false;
    expect((await getMergeRequest(mock(), demo, "demo", 1)).canMerge).toBe(false);
    await expect(mergeMergeRequest(mock(), demo, "demo", 1, null)).rejects.toMatchObject({ kind: "permission" });
    expect((await checkConnection(mock(), demo, "demo")).accessLevel).toBe(30);
  });
  it("マージで一覧から消え、head が違えば 409", async () => {
    await save();
    await expect(mergeMergeRequest(mock(), demo, "demo", 1, "zzz")).rejects.toMatchObject({ kind: "conflict", status: 409 });
    const d = await getMergeRequest(mock(), demo, "demo", 1);
    await mergeMergeRequest(mock(), demo, "demo", 1, d.headSha);
    expect(await listMasterMergeRequests(mock(), demo, "demo")).toEqual([]);
    expect(readDemoStore({ get: (k) => mem.get(k) ?? null, set: () => {} }).mrs[0]!.state).toBe("merged");
    await expect(mergeMergeRequest(mock(), demo, "demo", 1, null)).rejects.toMatchObject({ kind: "conflict", status: 405 });
  });
  it("取り下げ", async () => {
    await save();
    await closeMergeRequest(mock(), demo, "demo", 1);
    expect(await listMasterMergeRequests(mock(), demo, "demo")).toEqual([]);
  });
  it("壊れた保存内容は作り直す・トークン無しは 401", async () => {
    mem.set(DEMO_STORAGE_KEY, "{broken");
    expect(await listMasterMergeRequests(mock(), demo, "demo")).toEqual([]);
    const f = mock();
    const r = await f(`${DEMO_API_BASE}/user`, { method: "GET", headers: {} });
    expect(r.status).toBe(401);
  });
});
