/**
 * 配色（SPEC §53）: 表示モード・差し色の決め方、GitLab の設定の読み取り、描画前スクリプト
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCENTS, ACCENT_KEY, GITLAB_LOOK_KEY, THEME_KEY, appearanceConfig, appearanceScript, lookFromGitlab, resolveLook, runAppearance } from "../../src/components/appearance.js";
import type { AppearanceApi } from "../../src/components/appearance.js";
import { TOKEN_STORAGE_KEY } from "../../src/components/gitlab-client.js";
import { DEMO_USER } from "../../src/core/gitlab-mock.js";

function fakeWindow(opts: { local?: Record<string, string>; session?: Record<string, string>; osDark?: boolean; blocked?: boolean; fetch?: (url: string, init: unknown) => Promise<unknown> }) {
  const mk = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init));
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), map: m };
  };
  const local = mk(opts.local);
  const session = mk(opts.session);
  const root = { dataset: {} as Record<string, string> };
  const events: string[] = [];
  let mqListener: (() => void) | null = null;
  const mq = { matches: !!opts.osDark, addEventListener: (_: string, f: () => void) => void (mqListener = f) };
  const w: Record<string, unknown> = {
    document: { documentElement: root, addEventListener: () => {} },
    get localStorage() {
      if (opts.blocked) throw new Error("blocked");
      return local;
    },
    sessionStorage: session,
    matchMedia: () => mq,
    CustomEvent: class {
      constructor(public type: string) {}
    },
    dispatchEvent: (e: { type: string }) => void events.push(e.type),
    fetch: opts.fetch,
  };
  return { w, root, local, events, mq, osChange: () => mqListener?.() };
}
const run = (f: ReturnType<typeof fakeWindow>, api = "") => {
  runAppearance(lookFromGitlab, resolveLook, { api }, f.w);
  return f.w.ynAppearance as AppearanceApi;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("lookFromGitlab（GET /user）", () => {
  it("テーマ ID を差し色に、カラーモード ID を表示モードにする", () => {
    expect(lookFromGitlab({ theme_id: 1 })).toEqual({ mode: null, accent: "indigo" });
    expect(lookFromGitlab({ theme_id: 10, color_mode_id: 2 })).toEqual({ mode: "dark", accent: "red" });
    expect(lookFromGitlab({ theme_id: 7, color_mode_id: 1 })).toEqual({ mode: "light", accent: "blue" });
    expect(lookFromGitlab({ theme_id: 8, color_mode_id: 3 })).toEqual({ mode: "auto", accent: "green" });
    expect(lookFromGitlab({ theme_id: 3 })).toEqual({ mode: null, accent: "gray" });
  });
  it("古い GitLab のダークテーマ（11）はダーク、知らない値・壊れた値は null", () => {
    expect(lookFromGitlab({ theme_id: 11 })).toEqual({ mode: "dark", accent: null });
    expect(lookFromGitlab({ theme_id: 99, color_mode_id: 9 })).toEqual({ mode: null, accent: null });
    expect(lookFromGitlab(null)).toEqual({ mode: null, accent: null });
    expect(lookFromGitlab("x")).toEqual({ mode: null, accent: null });
  });
});

describe("resolveLook（設定画面 → GitLab → PC → 既定）", () => {
  const none = { theme: null, accent: null, gitlab: null, osDark: false };
  it("何も無ければライト・ブルー、PC がダークならダーク", () => {
    expect(resolveLook(none)).toEqual({ theme: "light", accent: "blue", themeFrom: "os", accentFrom: "default" });
    expect(resolveLook({ ...none, osDark: true }).theme).toBe("dark");
  });
  it("GitLab の設定は PC より優先、GitLab の「自動」は PC に合わせる", () => {
    expect(resolveLook({ ...none, osDark: true, gitlab: { mode: "light", accent: "green" } })).toMatchObject({ theme: "light", themeFrom: "gitlab", accent: "green", accentFrom: "gitlab" });
    expect(resolveLook({ ...none, osDark: true, gitlab: { mode: "auto", accent: null } })).toMatchObject({ theme: "dark", themeFrom: "os", accentFrom: "default" });
  });
  it("設定画面で選んだものが最優先、不正な値は「自動」扱い", () => {
    expect(resolveLook({ theme: "dark", accent: "gray", gitlab: { mode: "light", accent: "red" }, osDark: false })).toMatchObject({ theme: "dark", accent: "gray", themeFrom: "app", accentFrom: "app" });
    expect(resolveLook({ ...none, theme: "purple", accent: "pink" })).toMatchObject({ theme: "light", accent: "blue" });
  });
});

describe("runAppearance（描画前スクリプト）", () => {
  it("PC の設定に追従し、変わったら知らせる", () => {
    const f = fakeWindow({ osDark: true });
    run(f);
    expect(f.root.dataset).toEqual({ theme: "dark", accent: "blue" });
    f.mq.matches = false;
    f.osChange();
    expect(f.root.dataset.theme).toBe("light");
    expect(f.events).toContain("yn-theme");
  });
  it("選んだ値を保存し、次のページでも使う", () => {
    const f = fakeWindow({});
    const api = run(f);
    api.setTheme("dark");
    api.setAccent("green");
    expect(f.local.map.get(THEME_KEY)).toBe("dark");
    expect(f.local.map.get(ACCENT_KEY)).toBe("green");
    const g = fakeWindow({ local: Object.fromEntries(f.local.map) });
    expect(run(g).get()).toMatchObject({ theme: "dark", accent: "green", themePref: "dark", accentPref: "green" });
    api.setTheme("auto");
    expect(f.root.dataset.theme).toBe("light");
  });
  it("ストレージが使えなくてもページ内では切り替わる", () => {
    const f = fakeWindow({ blocked: true });
    const api = run(f);
    expect(f.root.dataset.theme).toBe("light");
    api.setTheme("dark");
    expect(f.root.dataset.theme).toBe("dark");
  });
  it("GitLab の設定を保存して使い、接続をやめたら消す", () => {
    const f = fakeWindow({});
    const api = run(f);
    api.setGitlabUser({ theme_id: 9, color_mode_id: 2 });
    expect(f.root.dataset).toEqual({ theme: "dark", accent: "red" });
    expect(JSON.parse(f.local.map.get(GITLAB_LOOK_KEY)!)).toMatchObject({ mode: "dark", accent: "red" });
    expect(api.get().auto).toMatchObject({ themeFrom: "gitlab", accentFrom: "gitlab" });
    api.setGitlabUser(null);
    expect(f.root.dataset).toEqual({ theme: "light", accent: "blue" });
    expect(f.local.map.has(GITLAB_LOOK_KEY)).toBe(false);
  });
  it("トークンがあれば GitLab の設定を読み直す（1 時間以内は読まない、接続先が無ければ読まない）", async () => {
    const calls: Array<{ url: string; init: unknown }> = [];
    const fetch = async (url: string, init: unknown) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ theme_id: 5 }) };
    };
    const f = fakeWindow({ session: { [TOKEN_STORAGE_KEY]: "tok" }, fetch });
    run(f, "https://g/api/v4");
    await tick();
    await tick();
    expect(calls).toEqual([{ url: "https://g/api/v4/user", init: { headers: { "PRIVATE-TOKEN": "tok" } } }]);
    expect(f.root.dataset.accent).toBe("green");
    // 次のページ: 保存した値を使い、読み直さない
    const g = fakeWindow({ local: Object.fromEntries(f.local.map), session: { [TOKEN_STORAGE_KEY]: "tok" }, fetch });
    run(g, "https://g/api/v4");
    await tick();
    expect(calls).toHaveLength(1);
    expect(g.root.dataset.accent).toBe("green");
    // 接続先が無い（デモ・ダウンロード）・トークンが無い
    run(fakeWindow({ session: { [TOKEN_STORAGE_KEY]: "tok" }, fetch }), "");
    run(fakeWindow({ fetch }), "https://g/api/v4");
    await tick();
    expect(calls).toHaveLength(1);
  });
  it("トークンが無ければ保存してある GitLab の設定を使わない（タブを閉じてトークンが消えた後）", () => {
    const look = JSON.stringify({ mode: "dark", accent: "red", at: Date.now() });
    expect(run(fakeWindow({ local: { [GITLAB_LOOK_KEY]: look } })).get()).toMatchObject({ theme: "light", accent: "blue" });
    expect(run(fakeWindow({ local: { [GITLAB_LOOK_KEY]: look, [TOKEN_STORAGE_KEY]: "tok" } })).get()).toMatchObject({ theme: "dark", accent: "red" });
  });
  it("読めなければ前の値のまま", async () => {
    const f = fakeWindow({ session: { [TOKEN_STORAGE_KEY]: "tok" }, fetch: async () => ({ ok: false, json: async () => ({}) }) });
    run(f, "https://g/api/v4");
    await tick();
    expect(f.root.dataset).toEqual({ theme: "light", accent: "blue" });
  });
});

describe("埋め込み", () => {
  it("接続先は本物の GitLab のときだけ、スクリプトに </script> を含めない", () => {
    expect(appearanceConfig({ mode: "demo", gitlab: { apiBaseUrl: "x" } }).api).toBe("");
    expect(appearanceConfig({ mode: "gitlab", gitlab: { apiBaseUrl: "https://g/api/v4/" } }).api).toBe("https://g/api/v4");
    expect(appearanceConfig(null).api).toBe("");
    const s = appearanceScript({ api: "</script>" });
    expect(s).not.toContain("</script>");
  });
  it("スクリプト内のキー名は他の部品と同じ", () => {
    const src = runAppearance.toString();
    for (const k of [THEME_KEY, ACCENT_KEY, GITLAB_LOOK_KEY, TOKEN_STORAGE_KEY]) expect(src).toContain(`"${k}"`);
    for (const a of ACCENTS) {
      expect(src).toContain(`"${a}"`);
      expect(resolveLook.toString()).toContain(`"${a}"`);
    }
  });
  it("デモの利用者は GitLab の既定テーマ（Indigo）", () => {
    expect(lookFromGitlab(DEMO_USER).accent).toBe("indigo");
  });
});

describe("差し色の色（style.css）", () => {
  const css = readFileSync(new URL("../../src/style.css", import.meta.url), "utf8");
  const L = (h: string) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [L(a), L(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const token = (block: string, name: string) => block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`))?.[1];
  const lightBlock = css.slice(css.indexOf(":root {"), css.indexOf(":root[data-theme=\"dark\"] {"));
  const darkBlock = css.slice(css.indexOf(":root[data-theme=\"dark\"] {"), css.indexOf("/* 差し色（GitLab"));
  const surfaces = {
    light: [token(lightBlock, "--yn-card")!, token(lightBlock, "--theme-background-a")!],
    dark: [token(darkBlock, "--yn-card")!, token(darkBlock, "--theme-background-a")!],
  };
  const accent = (theme: "light" | "dark", a: string) => {
    if (a === "blue") return token(theme === "light" ? lightBlock : darkBlock, "--yn-accent")!;
    const sel = theme === "light" ? `:root[data-accent="${a}"]` : `:root[data-theme="dark"][data-accent="${a}"]`;
    return css.match(new RegExp(`${sel.replace(/[[\]]/g, "\\$&")} \\{ --yn-accent: (#[0-9a-f]{6}); \\}`))?.[1];
  };
  it("ダークの面は真っ黒ではない（ネイビー寄りのグレー）", () => {
    for (const s of surfaces.dark) {
      expect(L(s)).toBeGreaterThan(0.008);
      // 青みがある
      expect(parseInt(s.slice(5, 7), 16)).toBeGreaterThan(parseInt(s.slice(1, 3), 16));
    }
  });
  for (const theme of ["light", "dark"] as const) {
    for (const a of ACCENTS) {
      it(`${theme} ${a}: 文字として面に 6:1 以上、主ボタンの文字にも 6:1 以上`, () => {
        const c = accent(theme, a);
        expect(c, `${theme} ${a} の色が無い`).toMatch(/^#/);
        for (const s of surfaces[theme]) expect(ratio(c!, s)).toBeGreaterThanOrEqual(6);
        expect(ratio(c!, theme === "light" ? "#ffffff" : token(darkBlock, "--yn-on-accent")!)).toBeGreaterThanOrEqual(6);
        // 色見本も同じ色
        const sw = theme === "light" ? `.yn-swatch[data-accent="${a}"] { --sw: ${c}; }` : `:root[data-theme="dark"] .yn-swatch[data-accent="${a}"] { --sw: ${c}; }`;
        expect(css).toContain(sw);
      });
    }
  }
});
