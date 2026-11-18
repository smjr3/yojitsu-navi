/**
 * 承認済みでまだ公開されていないマスタ・計画を編集画面で先に出す（SPEC §149）
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resolveMasterEdit, saveToGitLab, getMergeRequest, mergeMergeRequest, mergeRequestFileChanges } from "../../src/core/gitlab.js";
import type { FetchLike } from "../../src/core/gitlab.js";
import { createGitLabMock } from "../../src/core/gitlab-mock.js";
import { fetchLatestMasters } from "../../src/core/latestMasters.js";

const demo = resolveMasterEdit({ mode: "demo" });
const RATES = "data/masters/rates.csv";
const TEAMS = "data/masters/teams.csv";
const ratesText = "key,hourly_rate,effective_from\n部長,12000,2025-04\n";
const teamsText = "team_id,name\nT1,一課\n";
const BUILT_HEAD = "a".repeat(40);

describe("fetchLatestMasters（§149）", () => {
  let mem: Map<string, string>;
  let calls: string[];
  const base = { [RATES]: { text: ratesText, lastCommitId: "c1" }, [TEAMS]: { text: teamsText, lastCommitId: "c2" } };
  const mock = (): FetchLike => {
    const f = createGitLabMock({ storage: { get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v) }, baseFiles: base, baseHead: BUILT_HEAD, canMerge: () => true });
    return async (url, init) => {
      calls.push(`${init.method} ${decodeURIComponent(new URL(url).pathname.replace(/^.*\/projects\/[^/]+/, ""))}`);
      return f(url, init);
    };
  };
  const inputs = [
    { id: "rates", path: RATES, text: ratesText, lastCommitId: "c1" },
    { id: "teams", path: TEAMS, text: teamsText, lastCommitId: "c2" },
  ];
  beforeEach(() => {
    mem = new Map();
    calls = [];
  });

  it("本体の先頭がビルドと同じなら、問い合わせ 1 回で何も変えない", async () => {
    const r = await fetchLatestMasters(mock(), demo, "demo", BUILT_HEAD, inputs);
    expect(r).toEqual({ head: BUILT_HEAD, files: {} });
    expect(calls).toEqual([`GET /repository/branches/main`]);
  });

  it("ビルドのコミットが分からない（浅いクローン・git なし）ときは問い合わせず null", async () => {
    expect(await fetchLatestMasters(mock(), demo, "demo", null, inputs)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("承認（マージ）したファイルだけ、本体の今の中身と最終コミットを返す", async () => {
    const next = `${ratesText}部長,13000,2026-04\n`;
    await saveToGitLab(mock(), { config: demo, token: "demo", message: "単価", files: [{ path: RATES, content: next, lastCommitId: "c1" }], now: new Date("2026-10-28T00:00:00Z") });
    const d = await getMergeRequest(mock(), demo, "demo", 1);
    await mergeMergeRequest(mock(), demo, "demo", 1, d.headSha);
    calls = [];
    const r = await fetchLatestMasters(mock(), demo, "demo", BUILT_HEAD, inputs);
    expect(r?.head).not.toBe(BUILT_HEAD);
    expect(Object.keys(r!.files)).toEqual(["rates"]);
    expect(r!.files.rates!.text).toBe(next);
    expect(r!.files.rates!.lastCommitId).not.toBe("c1");
    // 変わっていないファイルは中身を読まない
    expect(calls.filter((c) => c.startsWith("GET /repository/files/"))).toEqual([`GET /repository/files/${RATES}`]);
    // 新しい最終コミットを土台にすれば、続けて保存しても競合しない。古い土台のままだと競合
    await expect(saveToGitLab(mock(), { config: demo, token: "demo", message: "単価2", files: [{ path: RATES, content: `${next}課長,9000,2026-04\n`, lastCommitId: "c1" }], now: new Date("2026-10-28T00:01:00Z") })).rejects.toMatchObject({ kind: "conflict" });
    await expect(saveToGitLab(mock(), { config: demo, token: "demo", message: "単価2", files: [{ path: RATES, content: `${next}課長,9000,2026-04\n`, lastCommitId: r!.files.rates!.lastCommitId }], now: new Date("2026-10-28T00:02:00Z") })).resolves.toMatchObject({ commitMode: "mr" });
  });

  it("申請中（未承認）の変更は返さない", async () => {
    await saveToGitLab(mock(), { config: demo, token: "demo", message: "単価", files: [{ path: RATES, content: `${ratesText}部長,13000,2026-04\n`, lastCommitId: "c1" }], now: new Date("2026-10-28T00:00:00Z") });
    expect(await fetchLatestMasters(mock(), demo, "demo", BUILT_HEAD, inputs)).toEqual({ head: BUILT_HEAD, files: {} });
  });

  it("最終コミットの無いファイル・リポジトリに無いファイルは比べない", async () => {
    mem.set("yojitsu-navi:gitlab-demo:v1", JSON.stringify({ seq: 1, branches: {}, mrs: [], main: { head: "demo1", files: { [RATES]: { text: "x", lastCommitId: "demo1" } } } }));
    const r = await fetchLatestMasters(mock(), demo, "demo", BUILT_HEAD, [
      { id: "rates", path: RATES, text: ratesText, lastCommitId: null },
      { id: "teams", path: TEAMS, text: teamsText, lastCommitId: "c2", exists: false },
    ]);
    expect(r).toEqual({ head: "demo1", files: {} });
  });

  it("同じファイルを変えた申請が 2 本あれば、片方を承認するともう片方は「競合あり」で承認できない（先の変更を消さない）", async () => {
    const save = (line: string, at: string) => saveToGitLab(mock(), { config: demo, token: "demo", message: line, files: [{ path: RATES, content: `${ratesText}${line}\n`, lastCommitId: "c1" }], now: new Date(at) });
    await save("部長,13000,2026-04", "2026-10-28T00:00:00Z");
    await save("課長,9000,2026-04", "2026-10-28T00:01:00Z");
    const d1 = await getMergeRequest(mock(), demo, "demo", 1);
    expect(d1.hasConflicts).toBe(false);
    await mergeMergeRequest(mock(), demo, "demo", 1, d1.headSha);
    const d2 = await getMergeRequest(mock(), demo, "demo", 2);
    expect(d2.hasConflicts).toBe(true);
    await expect(mergeMergeRequest(mock(), demo, "demo", 2, d2.headSha)).rejects.toMatchObject({ kind: "conflict" });
    // 変更の内容の「前」は作ったときの本体（先に承認した行は 2 本目の変更に数えない）
    const ch = await mergeRequestFileChanges(mock(), demo, "demo", d2, [RATES]);
    expect(ch[0]!.before).toBe(ratesText);
    const r = await fetchLatestMasters(mock(), demo, "demo", BUILT_HEAD, inputs);
    expect(r!.files.rates!.text).toContain("部長,13000,2026-04");
    expect(r!.files.rates!.text).not.toContain("課長,9000");
  });

  it("UTF-8 でないファイル（Shift_JIS のままなど）は差し替えない", async () => {
    const sjis = btoa(String.fromCharCode(0x6b, 0x65, 0x79, 0x0a, 0x95, 0x94, 0x92, 0xb7, 0x0a));
    const f: FetchLike = async (url) => {
      const body = url.includes("/repository/branches/") ? { commit: { id: "h2" } } : url.includes("/repository/commits?") ? [{ id: url.includes("rates") ? "new" : "c2" }] : { encoding: "base64", content: sjis, last_commit_id: "new" };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    expect(await fetchLatestMasters(f, demo, "demo", BUILT_HEAD, inputs)).toEqual({ head: "h2", files: {} });
  });

  it("通信に失敗したら例外（呼び出し側はビルドの中身のまま）", async () => {
    const broken: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(fetchLatestMasters(broken, demo, "demo", BUILT_HEAD, inputs)).rejects.toMatchObject({ kind: "network" });
  });
});

describe("本物の GitLab への問い合わせの形（§149）", () => {
  const cfg = resolveMasterEdit({ mode: "gitlab", gitlab: { apiBaseUrl: "https://g.local/api/v4", projectId: "grp/yn", targetBranch: "main", commitMode: "mr" } });
  it("先頭 → ファイルごとの最終コミット（先頭の時点）→ 変わったファイルだけ中身", async () => {
    const urls: string[] = [];
    const head = "b".repeat(40);
    const f: FetchLike = async (url) => {
      urls.push(url);
      const body = url.includes("/repository/branches/") ? { commit: { id: head } } : url.includes("/repository/commits?") ? (url.includes("rates") ? [{ id: "new1" }] : [{ id: "c2" }]) : { encoding: "base64", content: btoa("key\n"), last_commit_id: "new1" };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const r = await fetchLatestMasters(f, cfg, "tok", "a".repeat(40), [
      { id: "rates", path: "data/masters/rates.csv", text: "", lastCommitId: "c1" },
      { id: "teams", path: "data/masters/teams.csv", text: "", lastCommitId: "c2" },
    ]);
    expect(r).toEqual({ head, files: { rates: { text: "key\n", lastCommitId: "new1" } } });
    expect(urls[0]).toBe("https://g.local/api/v4/projects/grp%2Fyn/repository/branches/main");
    expect(urls).toContain(`https://g.local/api/v4/projects/grp%2Fyn/repository/commits?ref_name=${head}&path=data%2Fmasters%2Frates.csv&per_page=1`);
    expect(urls).toContain(`https://g.local/api/v4/projects/grp%2Fyn/repository/files/data%2Fmasters%2Frates.csv?ref=${head}`);
    expect(urls.filter((u) => u.includes("/repository/files/"))).toHaveLength(1);
  });
});
