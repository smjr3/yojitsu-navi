/**
 * 本番 GitLab の設定の確認・適用（SPEC §39.2、scripts/gitlab-setup.ts）
 * GitLab の API を小さな模擬で置き換え、確認 → 適用 → 確認し直しの流れを確かめる
 */
import { describe, expect, it } from "vitest";
import { DESIRED_PROJECT, accessTokenChecks, branchChecks, ciChecks, main, memberChecks, parseArgs, projectChecks, type Fetch } from "../../scripts/gitlab-setup.js";

type Pb = { push_access_levels: Array<{ access_level: number }>; merge_access_levels: Array<{ access_level: number }>; allow_force_push: boolean } | null;

/** 新規作成直後のプロジェクトに近い状態の模擬 */
function fakeGitLab(opts: { project?: Record<string, unknown>; pb?: Pb; variables?: unknown[]; schedules?: unknown[]; members?: unknown[]; pagesLocked?: boolean; token?: string } = {}) {
  const state = {
    project: { default_branch: "main", visibility: "internal", pages_access_level: "enabled", builds_access_level: "enabled", only_allow_merge_if_pipeline_succeeds: false, remove_source_branch_after_merge: false, ...opts.project } as Record<string, unknown>,
    pb: opts.pb === undefined ? ({ push_access_levels: [{ access_level: 40 }], merge_access_levels: [{ access_level: 40 }], allow_force_push: false } as Pb) : opts.pb,
  };
  const calls: string[] = [];
  const base = "https://g.local/api/v4/projects/grp%2Fyn";
  const json = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
  const fetch: Fetch = async (url, init) => {
    calls.push(`${init.method} ${url.replace(base, "")}`);
    if (init.headers["PRIVATE-TOKEN"] !== (opts.token ?? "tok")) return json(401, { message: "401 Unauthorized" });
    if (!url.startsWith(base)) return json(404, { message: "404" });
    const path = url.slice(base.length);
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (init.method === "GET" && path === "") return json(200, state.project);
    if (init.method === "PUT" && path === "") {
      for (const [k, v] of Object.entries(body)) if (!(k === "pages_access_level" && opts.pagesLocked)) state.project[k] = v;
      return json(200, state.project);
    }
    if (path === "/protected_branches/main" && init.method === "GET") return state.pb ? json(200, state.pb) : json(404, { message: "404 Not found" });
    if (path === "/protected_branches/main" && init.method === "DELETE") {
      state.pb = null;
      return json(204, undefined);
    }
    if (path === "/protected_branches" && init.method === "POST") {
      if (state.pb) return json(409, { message: "already protected" });
      state.pb = { push_access_levels: [{ access_level: Number(body.push_access_level) }], merge_access_levels: [{ access_level: Number(body.merge_access_level) }], allow_force_push: body.allow_force_push === true };
      return json(201, state.pb);
    }
    if (path.startsWith("/variables")) return json(200, opts.variables ?? []);
    if (path.startsWith("/pipeline_schedules")) return json(200, opts.schedules ?? []);
    if (path.startsWith("/members/all")) return json(200, opts.members ?? [{ access_level: 50 }, { access_level: 40 }, { access_level: 30 }, { access_level: 10 }, { access_level: 10 }]);
    return json(404, { message: "404" });
  };
  return { fetch, state, calls };
}

const args = ["--api", "https://g.local", "--project", "grp/yn"];
const env = { GITLAB_TOKEN: "tok" };

async function run(f: ReturnType<typeof fakeGitLab>, extra: string[] = [], e: Record<string, string> = env) {
  const out: string[] = [];
  const code = await main([...args, ...extra], e, f.fetch, (s) => out.push(s), "/nonexistent");
  return { code, text: out.join("\n") };
}

describe("gitlab:setup の確認（既定は何も変えない）", () => {
  it("新規プロジェクトは直すところを一覧にし、終了コード 1。変更の API は呼ばない", async () => {
    const f = fakeGitLab();
    const { code, text } = await run(f);
    expect(code).toBe(1);
    expect(text).toContain("✗ プロジェクトの公開範囲 = Private（今: internal）");
    expect(text).toContain("✗ main への直接プッシュ = No one（今: Maintainers）");
    expect(text).toContain("✓ main へのマージ = Maintainers");
    expect(text).toContain("メンバー: Guest 2 人、Developer 1 人、Maintainer 1 人、Owner 1 人");
    expect(text).toContain("--apply");
    expect(f.calls.every((c) => c.startsWith("GET "))).toBe(true);
  });
  it("--apply で直し、確認し直してすべて ✓（終了コード 0）", async () => {
    const f = fakeGitLab();
    const { code, text } = await run(f, ["--apply"]);
    expect(code).toBe(0);
    expect(text).toContain("すべて推奨どおりです。");
    for (const [k, v] of Object.entries(DESIRED_PROJECT)) expect(f.state.project[k]).toBe(v);
    expect(f.state.pb).toEqual({ push_access_levels: [{ access_level: 0 }], merge_access_levels: [{ access_level: 40 }], allow_force_push: false });
    // 2 回目は何も変えない（冪等）
    const again = fakeGitLab({ project: { ...f.state.project }, pb: f.state.pb });
    expect((await run(again, ["--apply"])).code).toBe(0);
    expect(again.calls.every((c) => c.startsWith("GET "))).toBe(true);
  });
  it("保護されていないブランチは保護する（外す操作はしない）", async () => {
    const f = fakeGitLab({ pb: null });
    expect((await run(f, ["--apply"])).code).toBe(0);
    expect(f.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    expect(f.state.pb?.push_access_levels).toEqual([{ access_level: 0 }]);
  });
  it("Pages のアクセス制御が無効な GitLab では、適用後も ✗ が残り管理者への依頼を示す", async () => {
    const f = fakeGitLab({ pagesLocked: true });
    const { code, text } = await run(f, ["--apply"]);
    expect(code).toBe(1);
    expect(text).toContain("✗ Pages の閲覧 = Only Project Members");
    expect(text).toContain("access_control");
  });
  it("トークン無効・プロジェクトが無いは終了コード 2", async () => {
    expect((await run(fakeGitLab({ token: "other" }))).text).toContain("トークンが無効");
    expect((await run(fakeGitLab({ token: "other" }))).code).toBe(2);
    const out: string[] = [];
    expect(await main(["--api", "https://g.local", "--project", "nope/x"], env, fakeGitLab().fetch, (s) => out.push(s), "/nonexistent")).toBe(2);
    expect(out.join("")).toContain("見つからない");
  });
});

describe("gitlab:setup の引数", () => {
  it("--api に /api/v4 を補い、既定のブランチは main", () => {
    expect(parseArgs(args, env)).toMatchObject({ api: "https://g.local/api/v4", project: "grp/yn", branch: "main", apply: false, token: "tok" });
  });
  it("config.json → GitLab CI の変数の順で補う", () => {
    expect(parseArgs([], env, { apiBaseUrl: "https://c.local/api/v4/", projectId: 12, targetBranch: "prod" })).toMatchObject({ api: "https://c.local/api/v4", project: "12", branch: "prod" });
    expect(parseArgs([], { ...env, CI_API_V4_URL: "https://ci.local/api/v4", CI_PROJECT_PATH: "a/b" })).toMatchObject({ api: "https://ci.local/api/v4", project: "a/b" });
  });
  it("トークンは環境変数だけ（--token は拒否）。足りなければ理由を出す", () => {
    expect(() => parseArgs([...args, "--token", "x"], env)).toThrow(/GITLAB_TOKEN/);
    expect(() => parseArgs(args, {})).toThrow(/GITLAB_TOKEN/);
    expect(() => parseArgs(["--project", "a/b"], env)).toThrow(/--api/);
  });
});

describe("gitlab:setup の判定", () => {
  it("既定ブランチの違い・保護の細部", () => {
    expect(projectChecks({ ...DESIRED_PROJECT, default_branch: "master" }, "main").find((i) => i.id === "default_branch")?.ok).toBe(false);
    const forced = branchChecks({ push_access_levels: [{ access_level: 0 }], merge_access_levels: [{ access_level: 40 }], allow_force_push: true }, "main");
    expect(forced.filter((i) => !i.ok).map((i) => i.id)).toEqual(["protected_force"]);
    const devMerge = branchChecks({ push_access_levels: [{ access_level: 0 }], merge_access_levels: [{ access_level: 30 }] }, "main");
    expect(devMerge.find((i) => i.id === "protected_merge")).toMatchObject({ ok: false, current: "Developers + Maintainers" });
  });
  it("スケジュールがあるのに GIT_PUSH_TOKEN が無い・保護されていない変数は手で直す項目", () => {
    expect(ciChecks([], [{ active: true }])).toMatchObject([{ id: "git_push_token", ok: false, fixable: false }]);
    expect(ciChecks([], [])).toEqual([]);
    expect(ciChecks([{ key: "GIT_PUSH_TOKEN", protected: true, masked: true }, { key: "WORKLOG_API_TOKEN", protected: false, masked: true }], [])).toMatchObject([
      { id: "git_push_token", ok: true },
      { id: "worklog_api_token", ok: false },
    ]);
    expect(ciChecks(null, null)).toEqual([]);
  });
  it("取り込みの MR 用のプロジェクトアクセストークン: 有効・Maintainer 以上・write_repository があり、期限が 30 日より先か（SPEC §104）", () => {
    const today = "2030-01-01";
    const ok = { active: true, revoked: false, access_level: 40, scopes: ["write_repository"], expires_at: "2030-06-01" };
    expect(accessTokenChecks([ok], true, today)).toMatchObject([{ id: "access_token_expiry", ok: true }]);
    expect(accessTokenChecks([{ ...ok, expires_at: "2030-01-20" }], true, today)).toMatchObject([{ id: "access_token_expiry", ok: false, current: "2030-01-20（あと 19 日）" }]);
    // 期限なしのものがあれば通す
    expect(accessTokenChecks([{ ...ok, expires_at: "2030-01-20" }, { ...ok, expires_at: null }], true, today)[0]?.ok).toBe(true);
    for (const bad of [{ ...ok, access_level: 30 }, { ...ok, scopes: ["read_repository"] }, { ...ok, active: false }, { ...ok, revoked: true }]) {
      expect(accessTokenChecks([bad], true, today)).toMatchObject([{ id: "access_token", ok: false, fixable: false }]);
    }
    expect(accessTokenChecks([], false, today)).toEqual([]);
    expect(accessTokenChecks(null, true, today)).toEqual([]);
    expect(ciChecks([{ key: "PROJECT_API_TOKEN", protected: false, masked: true }], [])).toMatchObject([{ id: "project_api_token", ok: false }]);
  });
  it("Maintainer 以上がいなければ ✗", () => {
    expect(memberChecks([{ access_level: 30 }]).items[0]?.ok).toBe(false);
    expect(memberChecks(null).items).toEqual([]);
  });
});
