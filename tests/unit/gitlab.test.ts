/**
 * マスタ編集の保存（SPEC §19.2）: GitLab API 呼び出しをモック fetch で全分岐
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MASTER_EDIT,
  GitLabError,
  buildCommitPayload,
  classifyHttpError,
  effectiveSaveMode,
  gitlabMessage,
  masterBranchName,
  networkError,
  projectPath,
  resolveMasterEdit,
  saveToGitLab,
  webFileUrl,
  type FetchLike,
} from "../../src/core/gitlab.js";
import type { MasterEditConfig } from "../../src/core/types.js";

const cfg = (over: Partial<MasterEditConfig["gitlab"]> = {}, mode: MasterEditConfig["mode"] = "gitlab"): MasterEditConfig => ({
  mode,
  gitlab: { apiBaseUrl: "https://gitlab.example.local/api/v4", projectId: "grp/yojitsu-navi", targetBranch: "main", commitMode: "mr", ...over },
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** URL・メソッドごとの応答を返すモック fetch。呼び出しを記録する */
function mockFetch(routes: Array<{ match: RegExp; method?: string; status?: number; body?: unknown; throws?: Error; rawBody?: string }>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const r = routes.find((x) => x.match.test(url) && (!x.method || x.method === init.method));
    if (!r) throw new Error(`unexpected ${init.method} ${url}`);
    if (r.throws) throw r.throws;
    const status = r.status ?? 200;
    const text = r.rawBody ?? JSON.stringify(r.body ?? {});
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  return { fetch, calls };
}

const files = [
  { path: "data/masters/rates.csv", content: "key,hourly_rate,effective_from\n部長,13000,2026-04\n", lastCommitId: "abc123" },
  { path: "data/assignments.csv", content: "member_id,contract_id,start_month,end_month,allocation\n", lastCommitId: null },
];
const NOW = new Date("2026-10-27T01:02:03Z"); // JST 10:02:03

describe("設定", () => {
  it("resolveMasterEdit: 無い・壊れた項目は既定値（download / main / mr）。末尾の / を外す", () => {
    expect(resolveMasterEdit(undefined)).toEqual(DEFAULT_MASTER_EDIT);
    expect(resolveMasterEdit({ mode: "x" as never })).toEqual(DEFAULT_MASTER_EDIT);
    expect(resolveMasterEdit({ mode: "gitlab", gitlab: { apiBaseUrl: " https://g/api/v4/ ", projectId: 42 as never, targetBranch: "", commitMode: "direct" } })).toEqual({
      mode: "gitlab",
      gitlab: { apiBaseUrl: "https://g/api/v4", projectId: "42", targetBranch: "main", commitMode: "direct" },
    });
  });

  it("effectiveSaveMode: gitlab でも apiBaseUrl / projectId が空なら download", () => {
    expect(effectiveSaveMode(cfg())).toBe("gitlab");
    expect(effectiveSaveMode(cfg({}, "download"))).toBe("download");
    expect(effectiveSaveMode(cfg({ apiBaseUrl: "" }))).toBe("download");
    expect(effectiveSaveMode(cfg({ projectId: "" }))).toBe("download");
  });

  it("projectPath は group/project を URL エンコード、数値 ID はそのまま", () => {
    expect(projectPath(cfg())).toBe("https://gitlab.example.local/api/v4/projects/grp%2Fyojitsu-navi");
    expect(projectPath(cfg({ projectId: "123" }))).toBe("https://gitlab.example.local/api/v4/projects/123");
  });

  it("webFileUrl は group/project のときだけ作る", () => {
    expect(webFileUrl(cfg(), "data/masters/rates.csv")).toBe("https://gitlab.example.local/grp/yojitsu-navi/-/blob/main/data/masters/rates.csv");
    expect(webFileUrl(cfg({ projectId: "123" }), "x")).toBeNull();
    expect(webFileUrl(cfg({ apiBaseUrl: "" }), "x")).toBeNull();
    expect(webFileUrl(cfg({ apiBaseUrl: "https://g/custom" }), "x")).toBeNull();
  });

  it("masterBranchName: masters/<YYYYMMDD-HHmmss(JST)>-<user>、user の記号は - に", () => {
    expect(masterBranchName(NOW, "taro.yamada")).toBe("masters/20261027-100203-taro.yamada");
    expect(masterBranchName(NOW, "山田 太郎")).toBe("masters/20261027-100203-user");
    expect(masterBranchName(NOW, "a b/c..d")).toBe("masters/20261027-100203-a-b-c.d");
    // 日付をまたぐ（UTC 15 時 = JST 翌 0 時）
    expect(masterBranchName(new Date("2026-12-31T15:00:00Z"), "u")).toBe("masters/20270101-000000-u");
  });
});

describe("buildCommitPayload", () => {
  it("actions に update と last_commit_id（無ければ付けない）、mr なら start_branch", () => {
    const p = buildCommitPayload({ files, message: "msg", branch: "masters/x", startBranch: "main" });
    expect(p).toEqual({
      branch: "masters/x",
      commit_message: "msg",
      start_branch: "main",
      actions: [
        { action: "update", file_path: "data/masters/rates.csv", content: files[0]!.content, encoding: "text", last_commit_id: "abc123" },
        { action: "update", file_path: "data/assignments.csv", content: files[1]!.content, encoding: "text" },
      ],
    });
    expect(buildCommitPayload({ files, message: "m", branch: "main" })).not.toHaveProperty("start_branch");
  });
});

describe("エラーの分類", () => {
  it("401 / 403 → permission", () => {
    expect(classifyHttpError("user", 401, '{"message":"401 Unauthorized"}').kind).toBe("permission");
    const e = classifyHttpError("commit", 403, '{"message":"403 Forbidden"}');
    expect(e.kind).toBe("permission");
    expect(e.detail).toBe("403 Forbidden");
    expect(e.message).toMatch(/Developer 以上/);
  });

  it("commit の 400（last_commit_id 不一致）と 409 → conflict", () => {
    expect(classifyHttpError("commit", 400, '{"message":"You are attempting to update a file that has changed since you started editing it."}').kind).toBe("conflict");
    expect(classifyHttpError("commit", 409, "{}").kind).toBe("conflict");
    expect(classifyHttpError("commit", 400, '{"message":"A branch called masters/x already exists"}').kind).toBe("other");
    // MR の 400 は競合ではない
    expect(classifyHttpError("mr", 400, '{"message":"conflict"}').kind).toBe("other");
  });

  it("404・その他 → other（どの操作かを文に入れる）", () => {
    expect(classifyHttpError("commit", 404, '{"message":"404 Project Not Found"}').message).toMatch(/projectId/);
    expect(classifyHttpError("mr", 422, '{"message":["Another open merge request already exists"]}').message).toMatch(/マージリクエストの作成に失敗.*422/);
    expect(classifyHttpError("user", 500, "oops").message).toMatch(/トークンの確認/);
    expect(classifyHttpError("commit", 500, "").message).toMatch(/コミット/);
  });

  it("gitlabMessage は message / error / 配列 / オブジェクト / 非 JSON を読む", () => {
    expect(gitlabMessage('{"message":"a"}')).toBe("a");
    expect(gitlabMessage('{"error":"invalid_token","error_description":"Token expired"}')).toBe("Token expired");
    expect(gitlabMessage('{"message":["x","y"]}')).toBe("x / y");
    expect(gitlabMessage('{"message":{"branch":["is invalid"]}}')).toBe("branch: is invalid");
    expect(gitlabMessage("<html>bad gateway</html>")).toBe("<html>bad gateway</html>");
    expect(gitlabMessage("{}")).toBe("{}");
  });

  it("networkError → network（CORS の案内付き）", () => {
    const e = networkError(new TypeError("Failed to fetch"));
    expect(e).toBeInstanceOf(GitLabError);
    expect(e.kind).toBe("network");
    expect(e.detail).toBe("Failed to fetch");
    expect(e.message).toMatch(/CORS/);
    expect(networkError("x").detail).toBe("x");
  });
});

describe("saveToGitLab", () => {
  const ok = [
    { match: /\/user$/, method: "GET", body: { username: "taro" } },
    { match: /\/repository\/commits$/, method: "POST", body: { id: "c0ffee", web_url: "https://gitlab.example.local/grp/yojitsu-navi/-/commit/c0ffee" } },
    { match: /\/merge_requests$/, method: "POST", body: { iid: 7, web_url: "https://gitlab.example.local/grp/yojitsu-navi/-/merge_requests/7" } },
  ];

  it("mr: GET /user → 新ブランチにコミット（start_branch=main）→ MR 作成", async () => {
    const { fetch, calls } = mockFetch(ok);
    const r = await saveToGitLab(fetch, { config: cfg(), token: " glpat-xyz ", files, message: "マスタ更新", description: "desc", now: NOW });
    expect(r).toEqual({
      commitMode: "mr",
      branch: "masters/20261027-100203-taro",
      commitId: "c0ffee",
      commitUrl: "https://gitlab.example.local/grp/yojitsu-navi/-/commit/c0ffee",
      mergeRequestUrl: "https://gitlab.example.local/grp/yojitsu-navi/-/merge_requests/7",
      mergeRequestIid: 7,
      user: "taro",
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://gitlab.example.local/api/v4/user",
      "POST https://gitlab.example.local/api/v4/projects/grp%2Fyojitsu-navi/repository/commits",
      "POST https://gitlab.example.local/api/v4/projects/grp%2Fyojitsu-navi/merge_requests",
    ]);
    expect(calls.every((c) => c.headers["PRIVATE-TOKEN"] === "glpat-xyz")).toBe(true);
    expect(calls[0]!.headers["Content-Type"]).toBeUndefined();
    expect(calls[1]!.headers["Content-Type"]).toBe("application/json");
    expect(calls[1]!.body).toMatchObject({ branch: "masters/20261027-100203-taro", start_branch: "main", commit_message: "マスタ更新" });
    expect((calls[1]!.body as { actions: unknown[] }).actions).toHaveLength(2);
    expect(calls[2]!.body).toEqual({ source_branch: "masters/20261027-100203-taro", target_branch: "main", title: "マスタ更新", description: "desc", remove_source_branch: true });
  });

  it("direct: targetBranch に直接コミット（start_branch なし・MR なし）", async () => {
    const { fetch, calls } = mockFetch(ok);
    const r = await saveToGitLab(fetch, { config: cfg({ commitMode: "direct", targetBranch: "develop" }), token: "t", files, message: "m" });
    expect(r.commitMode).toBe("direct");
    expect(r.branch).toBe("develop");
    expect(r.mergeRequestUrl).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toMatchObject({ branch: "develop" });
    expect(calls[1]!.body).not.toHaveProperty("start_branch");
  });

  it("応答に username / id / web_url が無くても落ちない", async () => {
    const { fetch } = mockFetch([
      { match: /\/user$/, body: {} },
      { match: /commits$/, rawBody: "" },
      { match: /merge_requests$/, body: {} },
    ]);
    const r = await saveToGitLab(fetch, { config: cfg(), token: "t", files, message: "m", now: NOW });
    expect(r).toMatchObject({ user: "user", branch: "masters/20261027-100203-user", commitId: null, commitUrl: null, mergeRequestUrl: null, mergeRequestIid: null });
  });

  const fail = async (routes: Parameters<typeof mockFetch>[0], config = cfg()): Promise<GitLabError> => {
    const { fetch } = mockFetch(routes);
    try {
      await saveToGitLab(fetch, { config, token: "t", files, message: "m", now: NOW });
    } catch (e) {
      expect(e).toBeInstanceOf(GitLabError);
      return e as GitLabError;
    }
    throw new Error("例外が出ませんでした");
  };

  it("競合（commit が 400 last_commit_id 不一致）→ conflict", async () => {
    const e = await fail([ok[0]!, { match: /commits$/, status: 400, body: { message: "You are attempting to update a file that has changed since you started editing it." } }]);
    expect(e.kind).toBe("conflict");
    expect(e.status).toBe(400);
  });

  it("トークン無効（GET /user が 401）→ permission。コミットは呼ばない", async () => {
    const { fetch, calls } = mockFetch([{ match: /\/user$/, status: 401, body: { message: "401 Unauthorized" } }]);
    await expect(saveToGitLab(fetch, { config: cfg(), token: "t", files, message: "m" })).rejects.toMatchObject({ kind: "permission", status: 401 });
    expect(calls).toHaveLength(1);
  });

  it("権限不足（commit が 403）→ permission", async () => {
    expect((await fail([ok[0]!, { match: /commits$/, status: 403, body: { message: "403 Forbidden" } }])).kind).toBe("permission");
  });

  it("ネットワーク / CORS（fetch が TypeError）→ network", async () => {
    expect((await fail([{ match: /./, throws: new TypeError("Failed to fetch") }])).kind).toBe("network");
    expect((await fail([ok[0]!, { match: /commits$/, throws: new TypeError("NetworkError") }])).kind).toBe("network");
  });

  it("その他（500・JSON でない成功応答）→ other", async () => {
    expect((await fail([ok[0]!, { match: /commits$/, status: 500, rawBody: "Internal" }])).kind).toBe("other");
    const e = await fail([{ match: /\/user$/, rawBody: "<html>login</html>" }]);
    expect(e.kind).toBe("other");
    expect(e.message).toMatch(/api\/v4/);
  });

  it("本文の読み取りに失敗した成功応答 → network、失敗応答は本文なしで分類", async () => {
    const broken: FetchLike = async (url) => ({
      ok: !/commits/.test(url),
      status: /commits/.test(url) ? 403 : 200,
      text: async () => {
        throw new Error("stream");
      },
    });
    await expect(saveToGitLab(broken, { config: cfg(), token: "t", files, message: "m" })).rejects.toMatchObject({ kind: "network" });
    const brokenErr: FetchLike = async (url) =>
      /\/user$/.test(url)
        ? { ok: true, status: 200, text: async () => '{"username":"u"}' }
        : {
            ok: false,
            status: 403,
            text: async () => {
              throw new Error("stream");
            },
          };
    await expect(saveToGitLab(brokenErr, { config: cfg(), token: "t", files, message: "m" })).rejects.toMatchObject({ kind: "permission" });
  });

  it("MR の作成だけ失敗 → other（ブランチとコミットを partial に。network でもダウンロード切替にしない）", async () => {
    const e = await fail([ok[0]!, ok[1]!, { match: /merge_requests$/, status: 409, body: { message: ["Another open merge request already exists"] } }]);
    expect(e.kind).toBe("other");
    expect(e.partial).toEqual({ branch: "masters/20261027-100203-taro", commitUrl: "https://gitlab.example.local/grp/yojitsu-navi/-/commit/c0ffee" });
    expect(e.message).toMatch(/masters\/20261027-100203-taro/);
    const n = await fail([ok[0]!, ok[1]!, { match: /merge_requests$/, throws: new TypeError("Failed to fetch") }]);
    expect(n.kind).toBe("other");
    const p = await fail([ok[0]!, ok[1]!, { match: /merge_requests$/, status: 403, body: {} }]);
    expect(p.kind).toBe("permission");
    expect(p.partial).not.toBeNull();
  });

  it("前提の不足: 設定なし → other、トークン空 → permission、変更なし → other（どれも通信しない）", async () => {
    const { fetch, calls } = mockFetch(ok);
    await expect(saveToGitLab(fetch, { config: cfg({ apiBaseUrl: "" }), token: "t", files, message: "m" })).rejects.toMatchObject({ kind: "other" });
    await expect(saveToGitLab(fetch, { config: cfg(), token: "  ", files, message: "m" })).rejects.toMatchObject({ kind: "permission" });
    await expect(saveToGitLab(fetch, { config: cfg(), token: "t", files: [], message: "m" })).rejects.toMatchObject({ kind: "other" });
    expect(calls).toHaveLength(0);
  });
});
