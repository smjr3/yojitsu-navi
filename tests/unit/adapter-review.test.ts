/**
 * 独立レビュー指摘（取り込みアダプタ分）の再現テスト: H1 M1 M2 M6 L5 L7 L8
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHttpAdapter } from "../../scripts/adapters/http.js";
import { fetchRawRows, parseDate } from "../../scripts/adapters/http-source.js";
import { importMembers, mapMemberRow } from "../../scripts/adapters/members.js";
import { fetchWorklogs } from "../../scripts/fetch-worklogs.js";
import { formatHours } from "../../scripts/lib/csv.js";
import { mergeMembers } from "../../scripts/lib/members-merge.js";
import type { Config, HttpSourceOptions } from "../../src/core/types.js";

const TOKEN = "tok-SECRET-1";
const noSleep = async () => {};
const COLS = { date: "d", memberId: "m", memberName: "n", customerName: "c", projectName: "p", task: "t", hours: "h" };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function config(http: Record<string, unknown> = {}): Config {
  return {
    fiscalYearStartMonth: 4,
    standardHoursPerMonth: 160,
    hoursPerBusinessDay: 8,
    burnRateDangerThreshold: 1,
    closingBusinessDay: 3,
    forecastMethodDefault: "recent3",
    forecastRecentMonths: 3,
    currency: { code: "JPY", defaultUnit: "yen" },
    labels: { customer: "顧客", project: "案件", contract: "契約", team: "チーム", member: "メンバー" },
    worklogSource: { adapter: "http", csv: { path: "data/worklogs" }, http: { url: "https://api.example.local/w?from={from}&to={to}", authHeader: "Authorization", refetchMonths: 1, columns: COLS, ...http } as never },
    costTypes: [{ id: "labor", label: "工数原価" }],
  } as Config;
}

const ctxOf = (fetchImpl: typeof fetch) => ({ token: TOKEN, log: () => {}, from: "2026-09", to: "2026-09", deps: { fetchImpl, sleep: noSleep } });

describe("H1 数値の日付 YYYYMMDD", () => {
  it("自動判定で 8 桁の数値は YYYYMMDD", () => {
    expect(parseDate(20261027)).toBe("2026-10-27");
    expect(parseDate("20261027")).toBe("2026-10-27");
  });
  it("エポックミリ秒は従来どおり", () => {
    expect(parseDate(Date.UTC(2026, 9, 27, 0, 0, 0))).toBe("2026-10-27");
  });
  it("数値日付の API から行が取れる", async () => {
    const rows = await createHttpAdapter({ fetchImpl: async () => json([{ d: 20260915, m: "M1", n: "a", c: "c", p: "p", t: "t", h: 1 }]), sleep: noSleep }).fetch({
      from: "2026-09",
      to: "2026-09",
      config: config(),
      env: { WORKLOG_API_TOKEN: TOKEN },
      log: () => {},
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.date).toBe("2026-09-15");
  });
  it("期間外で捨てた件数をログし、全部捨てるならエラー", async () => {
    const logs: string[] = [];
    const mk = (rows: unknown[]) =>
      createHttpAdapter({ fetchImpl: async () => json(rows), sleep: noSleep }).fetch({ from: "2026-09", to: "2026-09", config: config(), env: { WORKLOG_API_TOKEN: TOKEN }, log: (m) => logs.push(m) });
    const ok = await mk([
      { d: "2026-09-01", m: "M1", n: "a", c: "c", p: "p", t: "t", h: 1 },
      { d: "2026-07-01", m: "M1", n: "a", c: "c", p: "p", t: "t", h: 1 },
    ]);
    expect(ok).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/期間外.*1/);
    await expect(mk([{ d: "2026-07-01", m: "M1", n: "a", c: "c", p: "p", t: "t", h: 1 }])).rejects.toThrow(/期間外/);
  });
  it("fetch-worklogs は取得行があるのに全て対象月外なら月ファイルを書かない", async () => {
    const root = mkdtempSync(join(tmpdir(), "fw-"));
    mkdirSync(join(root, "data/worklogs"), { recursive: true });
    const keep = "date,member_id,member_name,customer_name,project_name,task,hours\n2026-10-01,M1,a,c,p,t,1\n";
    writeFileSync(join(root, "data/worklogs/2026-10.csv"), keep);
    writeFileSync(join(root, "config.json"), JSON.stringify(config({ url: "http://x/{from}" })));
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => json([{ d: "2020-01-01", m: "M1", n: "a", c: "c", p: "p", t: "t", h: 1 }])) as typeof fetch;
    try {
      await expect(fetchWorklogs({ rootDir: root, asOf: "2026-10-27" }, { WORKLOG_API_TOKEN: TOKEN })).rejects.toThrow();
    } finally {
      globalThis.fetch = orig;
    }
    expect(readFileSync(join(root, "data/worklogs/2026-10.csv"), "utf8")).toBe(keep);
  });
});

describe("M1 リダイレクトで別オリジンへ認証ヘッダを送らない", () => {
  const http = (extra: Partial<HttpSourceOptions> = {}) => ({ url: "https://a.example.local/w", authHeader: "X-API-Key", columns: COLS, ...extra }) as HttpSourceOptions;

  it("別オリジンへのリダイレクトは追わずエラー（トークンも出さない）", async () => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(url);
      return new Response(null, { status: 302, headers: { location: "https://evil.example.local/x" } });
    }) as unknown as typeof fetch;
    const err = await fetchRawRows(http(), ctxOf(f)).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/リダイレクト/);
    expect((err as Error).message).not.toContain(TOKEN);
    expect(calls).toEqual(["https://a.example.local/w"]);
  });
  it("同一オリジンのリダイレクトは追う。fetch には redirect:manual を渡す", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const f = (async (url: string, init?: RequestInit) => {
      seen.push(init);
      if (url === "https://a.example.local/w") return new Response(null, { status: 301, headers: { location: "/w2" } });
      return json([{ d: "2026-09-01" }]);
    }) as unknown as typeof fetch;
    const rows = await fetchRawRows(http(), ctxOf(f));
    expect(rows).toHaveLength(1);
    expect(seen.every((i) => i?.redirect === "manual")).toBe(true);
  });
  it("リダイレクトの繰り返しは打ち切る", async () => {
    const f = (async () => new Response(null, { status: 302, headers: { location: "/w" } })) as unknown as typeof fetch;
    await expect(fetchRawRows(http(), ctxOf(f))).rejects.toThrow(/リダイレクト/);
  });
});

describe("M2 分・秒単位の換算を丸めすぎない", () => {
  it("10 分は 0.1667h（0.17 にしない）", () => {
    expect(formatHours(10 / 60)).toBe("0.1667");
    expect(formatHours(7 / 60)).toBe("0.1167");
  });
  it("従来の値は同じ表記", () => {
    expect(formatHours(7.25)).toBe("7.25");
    expect(formatHours(0.1 + 0.2)).toBe("0.3");
    expect(formatHours(1)).toBe("1");
  });
  it("10 分 x 6 行 = 1 時間（行ごと丸めの誤差が出ない）", () => {
    const sum = Array.from({ length: 6 }, () => Number(formatHours(10 / 60))).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(0.001);
  });
});

describe("M6 取り込み元の氏名が空でも既存氏名を消さない", () => {
  const ms = { columns: { memberId: "id", name: "nm", title: "ti" } } as never;
  it("mapMemberRow: 空の氏名は未指定扱い", () => {
    expect(mapMemberRow({ id: "M1", nm: "  ", ti: "課長" }, ms)?.name).toBeUndefined();
    expect(mapMemberRow({ id: "M1", nm: "山田", ti: "課長" }, ms)?.name).toBe("山田");
  });
  it("importMembers: 空の氏名の件数を警告", () => {
    const logs: string[] = [];
    importMembers([{ id: "M1", nm: "", ti: "a" }, { id: "M2", nm: "x", ti: "b" }], ms, undefined, (m) => logs.push(m));
    expect(logs.join("\n")).toMatch(/氏名.*1/);
  });
  it("mergeMembers: 既存氏名を空で上書きしない", () => {
    const existing = [{ member_id: "M1", name: "山田", kind: "employee", title: "", department: "", section: "", team_id: "t1", effective_from: "2026-04" }];
    const r = mergeMembers(existing, [{ memberId: "M1", title: "課長" }], "2026-10");
    expect(r.rows.every((x) => x.name === "山田")).toBe(true);
    expect(r.rows).toHaveLength(2);
  });
  it("新しい人で氏名が空なら空のまま追加（欠落は validate が指摘）", () => {
    const r = mergeMembers([], [{ memberId: "M9" }], "2026-10");
    expect(r.rows[0]?.name).toBe("");
  });
});

describe("L5 未来日付の行", () => {
  const base = { kind: "employee", title: "", department: "", section: "", team_id: "t1" };
  it("有効な行が未来日付しか無いとき、実行月の行を足す（チームは引き継ぐ）。再実行しても増えない", () => {
    const existing = [{ ...base, member_id: "M1", name: "山田", effective_from: "2027-01" }];
    const r = mergeMembers(existing, [{ memberId: "M1", name: "山田" }], "2026-10");
    expect(r.rows.map((x) => x.effective_from).sort()).toEqual(["2026-10", "2027-01"]);
    expect(r.rows.find((x) => x.effective_from === "2026-10")?.team_id).toBe("t1");
    const again = mergeMembers(r.rows, [{ memberId: "M1", name: "山田" }], "2026-10");
    expect(again.rows).toEqual(r.rows);
    expect(again.unchanged).toBe(1);
  });
  it("現在の値が変わったとき、旧値を引き継いでいる未来行も新しい値にする（旧値へ戻さない）", () => {
    const existing = [
      { ...base, member_id: "M1", name: "旧姓", effective_from: "2026-04" },
      { ...base, member_id: "M1", name: "旧姓", team_id: "t2", effective_from: "2027-01" },
    ];
    const r = mergeMembers(existing, [{ memberId: "M1", name: "新姓" }], "2026-10");
    const future = r.rows.find((x) => x.effective_from === "2027-01");
    expect(future?.name).toBe("新姓");
    expect(future?.team_id).toBe("t2");
  });
  it("未来行が別の値を持っているなら（予定された変更）触らない", () => {
    const existing = [
      { ...base, member_id: "M1", name: "旧姓", title: "主任", effective_from: "2026-04" },
      { ...base, member_id: "M1", name: "旧姓", title: "課長", effective_from: "2027-01" },
    ];
    const r = mergeMembers(existing, [{ memberId: "M1", name: "旧姓", title: "係長" }], "2026-10");
    expect(r.rows.find((x) => x.effective_from === "2027-01")?.title).toBe("課長");
  });
});

describe("L7 ページングは既存クエリ文字列を保つ", () => {
  const paged = { type: "page", pageParam: "page", sizeParam: "size", size: 2 };
  const run = async (url: string) => {
    const urls: string[] = [];
    const f = (async (u: string) => {
      urls.push(u);
      return json(urls.length === 1 ? [{ a: 1 }, { a: 2 }] : [{ a: 3 }]);
    }) as unknown as typeof fetch;
    await fetchRawRows({ url, authHeader: "Authorization", columns: COLS, pagination: paged } as HttpSourceOptions, ctxOf(f));
    return urls;
  };
  it("カンマなどの符号化を変えない", async () => {
    const urls = await run("https://a.example.local/w?fields=a,b&q=x");
    expect(urls[1]).toBe("https://a.example.local/w?fields=a,b&q=x&page=2&size=2");
  });
  it("同名パラメータが既にあれば置き換える", async () => {
    const urls = await run("https://a.example.local/w?page=1&k=a,b");
    expect(urls[1]).toBe("https://a.example.local/w?k=a,b&page=2&size=2");
  });
});

describe("L8 README に dateFormat: ISO8601 の推奨", () => {
  it("UTC 表記の時刻付き日付の注意がある", () => {
    const readme = readFileSync(join(__dirname, "../../README.md"), "utf8");
    expect(readme).toMatch(/dateFormat[^\n]{0,60}ISO8601[^\n]*推奨|推奨[^\n]*dateFormat[^\n]{0,60}ISO8601/);
    expect(readme).toMatch(/UTC/);
  });
});
