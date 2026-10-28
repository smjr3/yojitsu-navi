/**
 * ヘッダーのマージ待ち件数バッジ（SPEC §27）
 */
import { describe, expect, it } from "vitest";
import { badgeConfig, mrBadgeScript, runMrBadge } from "../../src/components/header-badge.js";
import { MR_COUNT_KEY, TOKEN_STORAGE_KEY } from "../../src/components/gitlab-client.js";
import { DEMO_STORAGE_KEY } from "../../src/core/gitlab-mock.js";
import { MASTER_BRANCH_PREFIX } from "../../src/core/gitlab.js";

function fakeWindow(opts: { token?: string; local?: Record<string, string>; fetch?: (url: string) => Promise<unknown> }) {
  const mk = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init));
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
  };
  const badge = { hidden: true, n: { textContent: "" }, sr: { textContent: "" }, querySelector: (s: string) => (s === ".yn-mr-badge-n" ? badge.n : badge.sr) };
  const listeners: Record<string, (e: { detail: unknown }) => void> = {};
  const w = {
    sessionStorage: mk(opts.token ? { [TOKEN_STORAGE_KEY]: opts.token } : {}),
    localStorage: mk(opts.local),
    document: { readyState: "complete", querySelectorAll: () => [badge], addEventListener: () => {} },
    addEventListener: (t: string, f: (e: { detail: unknown }) => void) => void (listeners[t] = f),
    fetch: opts.fetch,
  };
  return { w, badge, listeners };
}

const cfg = badgeConfig({ mode: "gitlab", gitlab: { apiBaseUrl: "https://g/api/v4/", projectId: "a/b", targetBranch: "main" } }, "マージ待ち {n} 件");
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("badgeConfig", () => {
  it("接続先が無ければ無効、demo は有効", () => {
    expect(badgeConfig({}, "").enabled).toBe(false);
    expect(badgeConfig({ mode: "download", gitlab: { apiBaseUrl: "x", projectId: "y" } }, "").enabled).toBe(false);
    expect(badgeConfig({ mode: "demo" }, "").enabled).toBe(true);
    expect(cfg).toMatchObject({ enabled: true, api: "https://g/api/v4", targetBranch: "main" });
  });
  it("埋め込みスクリプトにトークンや </script> を含めない", () => {
    const s = mrBadgeScript({ ...cfg, label: "</script>" });
    expect(s).not.toContain("</script>");
    expect(s).toContain(MASTER_BRANCH_PREFIX);
    expect(s).toContain(MR_COUNT_KEY);
    expect(s).toContain(DEMO_STORAGE_KEY);
  });
});

describe("runMrBadge", () => {
  it("トークンが無ければ取得せず隠す", () => {
    let called = false;
    const { w, badge } = fakeWindow({ fetch: async () => ((called = true), null) });
    runMrBadge(cfg, w);
    expect(called).toBe(false);
    expect(badge.hidden).toBe(true);
  });
  it("API の件数（masters/ の MR だけ）を出し、60 秒保持する", async () => {
    const urls: string[] = [];
    const list = [
      { source_branch: "masters/a", target_branch: "main", state: "opened" },
      { source_branch: "masters/b", target_branch: "main", state: "opened" },
      { source_branch: "fix", target_branch: "main", state: "opened" },
    ];
    const { w, badge } = fakeWindow({ token: "t", fetch: async (u) => (urls.push(u), { ok: true, json: async () => list }) });
    runMrBadge(cfg, w);
    await tick();
    await tick();
    expect(badge.hidden).toBe(false);
    expect(badge.n.textContent).toBe("2");
    expect(badge.sr.textContent).toBe("マージ待ち 2 件");
    expect(urls[0]).toContain("/projects/a%2Fb/merge_requests?state=opened&target_branch=main");
    // 2 回目（別ページ）はキャッシュ
    runMrBadge(cfg, w);
    await tick();
    expect(urls).toHaveLength(1);
  });
  it("失敗は出さない・通知で更新する", async () => {
    const { w, badge, listeners } = fakeWindow({ token: "t", fetch: async () => { throw new Error("cors"); } });
    runMrBadge(cfg, w);
    await tick();
    expect(badge.hidden).toBe(true);
    listeners["yn-mr-count"]!({ detail: 120 });
    expect(badge.n.textContent).toBe("99+");
    listeners["yn-mr-count"]!({ detail: null });
    expect(badge.hidden).toBe(true);
  });
  it("demo はブラウザ内の模擬の件数", () => {
    const store = { seq: 1, branches: {}, mrs: [{ source_branch: "masters/x", target_branch: "main", state: "opened" }, { source_branch: "masters/y", target_branch: "main", state: "merged" }] };
    const { w, badge } = fakeWindow({ token: "demo", local: { [DEMO_STORAGE_KEY]: JSON.stringify(store) } });
    runMrBadge(badgeConfig({ mode: "demo" }, "{n}"), w);
    expect(badge.n.textContent).toBe("1");
  });
});
