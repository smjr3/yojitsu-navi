/**
 * 取り込みアダプタの設定化（docs/SPEC.md §20）の単体テスト
 * 日付形式・単位換算・入れ子と複数候補・filters・ページング 5 種・Shift_JIS・エラー文
 */
import { describe, expect, it, vi } from "vitest";
import { createHttpAdapter, mapRow } from "../../scripts/adapters/http.js";
import {
  assertColumns,
  buildRequestUrl,
  fetchRawRows,
  listColumnNames,
  parseDate,
  parseNextLink,
  passesFilters,
  pickValue,
  redact,
  toHours,
} from "../../scripts/adapters/http-source.js";
import { sjis } from "./sjis-helper.js";
import type { Config, HttpSourceOptions, Worklog } from "../../src/core/types.js";

const TOKEN = "tok-SECRET-9876";
const noSleep = async () => {};
const silent = () => {};

const COLS = { date: "d", memberId: "m", memberName: "n", customerName: "c", projectName: "p", task: "t", hours: "h" };

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
    worklogSource: { adapter: "http", csv: { path: "data/worklogs" }, http: { url: "https://api.example.local/w?from={from}&to={to}", authHeader: "Authorization", refetchMonths: 3, columns: COLS, ...http } as never },
    costTypes: [{ id: "labor", label: "工数原価" }],
  };
}

const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

async function run(http: Record<string, unknown>, fetchImpl: typeof fetch, from = "2026-09", to = "2026-09"): Promise<Worklog[]> {
  return createHttpAdapter({ fetchImpl, sleep: noSleep }).fetch({ from, to, config: config(http), env: { WORKLOG_API_TOKEN: TOKEN }, log: silent });
}

const row = (i: number) => ({ d: "2026-09-01", m: `M${i}`, n: `名前${i}`, c: "顧客", p: "案件", t: "作業", h: i });

describe("日付", () => {
  it.each([
    ["YYYY-MM-DD", "2026-09-01", "2026-09-01"],
    ["YYYY/MM/DD", "2026/9/1", "2026-09-01"],
    ["YYYYMMDD", "20260901", "2026-09-01"],
    ["ISO8601", "2026-08-31T15:30:00Z", "2026-09-01"], // UTC 15:30 = JST 翌日 00:30
    ["ISO8601", "2026-09-01T23:30:00+09:00", "2026-09-01"],
    ["ISO8601", "2026-09-01T10:00:00", "2026-09-01"], // 時刻のみで zone なし = JST
    ["ISO8601", "2026-09-01T00:30:00-05:00", "2026-09-01"],
    ["epochMillis", 1788220800000, "2026-09-01"], // 2026-09-01T00:00:00Z = JST 09:00
    ["epochMillis", "1788220800000", "2026-09-01"],
    ["epochMillis", 1788134400000 + 15 * 3600 * 1000, "2026-09-01"], // 8/31 15:00Z = 9/1 00:00 JST
  ] as const)("%s: %s -> %s", (fmt, input, expected) => {
    expect(parseDate(input, fmt)).toBe(expected);
  });

  it("指定形式に合わない値・存在しない日付は null", () => {
    expect(parseDate("2026/09/01", "YYYY-MM-DD")).toBeNull();
    expect(parseDate("2026-02-30", "YYYY-MM-DD")).toBeNull();
    expect(parseDate("20261301", "YYYYMMDD")).toBeNull();
    expect(parseDate("abc", "ISO8601")).toBeNull();
    expect(parseDate("abc", "epochMillis")).toBeNull();
  });

  it("自動判定: 左から順に試す。従来の「先頭10文字・/ を -」と同じ結果", () => {
    expect(parseDate("2026-09-01")).toBe("2026-09-01");
    expect(parseDate("2026-09-01T23:59:59Z")).toBe("2026-09-01"); // 従来どおり先頭 10 文字
    expect(parseDate("2026/09/01")).toBe("2026-09-01");
    expect(parseDate("2026/9/1")).toBe("2026-09-01");
    expect(parseDate("20260901")).toBe("2026-09-01");
    expect(parseDate("1788220800000")).toBe("2026-09-01");
    expect(parseDate(1788220800000)).toBe("2026-09-01");
    expect(parseDate("さっぱり")).toBe("さっぱり");
  });

  it("dateFormat 指定で読めないときは行番号つきのエラー（値は出さない）", async () => {
    const f = vi.fn(async () => json([{ ...row(1), d: "SECRET-VALUE" }]));
    const err = await run({ dateFormat: "YYYYMMDD" }, f as never).then(() => new Error("成功してしまった"), (e: unknown) => e as Error);
    expect(err.message).toMatch(/1 行目.*YYYYMMDD/);
    expect(err.message).not.toContain("SECRET-VALUE");
  });
});

describe("時間の単位", () => {
  it("hours / minutes / seconds", () => {
    expect(toHours("2.5")).toBe(2.5);
    expect(toHours(90, "minutes")).toBe(1.5);
    expect(toHours("45", "minutes")).toBe(0.75);
    expect(toHours(5400, "seconds")).toBe(1.5);
    expect(toHours("abc", "minutes")).toBeNaN();
  });
  it("mapRow に hoursUnit が効く", () => {
    expect(mapRow(row(1), COLS, { hoursUnit: "minutes" }).hours).toBeCloseTo(1 / 60);
  });
});

describe("入れ子・複数候補の列", () => {
  const nested = { date: "2026-09-01", member: { id: "M1", profile: { name: "山田" } }, customer: null, client: "青葉", proj: "保守", task: "", time: { minutes: 30 } };
  it("ドット区切りで入れ子をたどる", () => {
    expect(pickValue(nested, "member.profile.name")).toBe("山田");
    expect(pickValue(nested, "member.zzz")).toBeUndefined();
  });
  it("列名にドットを含む CSV 列はそのまま引ける", () => {
    expect(pickValue({ "a.b": "x" }, "a.b")).toBe("x");
  });
  it("複数候補は最初に値があるもの（null・空文字は飛ばす）", () => {
    expect(pickValue(nested, ["customer", "client"])).toBe("青葉");
    expect(pickValue({ a: "", b: "  ", c: 0 }, ["a", "b", "c"])).toBe(0);
    expect(pickValue({}, ["a", "b"])).toBeUndefined();
  });
  it("mapRow が入れ子・候補を使って Worklog にする", () => {
    const w = mapRow(nested, { date: "date", memberId: "member.id", memberName: ["name", "member.profile.name"], customerName: ["customer", "client"], projectName: "proj", task: "task", hours: "time.minutes" }, { hoursUnit: "minutes" });
    expect(w).toEqual({ date: "2026-09-01", memberId: "M1", memberName: "山田", customerName: "青葉", projectName: "保守", task: "", hours: 0.5 });
  });
  it("列名一覧は入れ子の葉までドット区切り（値は含まない）", () => {
    expect(listColumnNames(nested)).toEqual(["date", "member.id", "member.profile.name", "customer", "client", "proj", "task", "time.minutes"]);
  });
});

describe("列が見つからないときのエラー", () => {
  it("列名一覧だけを出し、値は出さない", async () => {
    const f = vi.fn(async () => json([{ work_date: "2026-09-01", emp: "VALUE-X", hrs: 1 }]));
    const err = await run({}, f as never).then(() => new Error("成功してしまった"), (e: unknown) => e as Error);
    expect(err.message).toMatch(/列が見つかりません/);
    expect(err.message).toContain("date（候補: d）");
    expect(err.message).toContain("応答の最初の1行の列名: work_date, emp, hrs");
    expect(err.message).not.toContain("VALUE-X");
  });
  it("候補のどれか 1 つが見つかればよい。filters の列も確かめる", () => {
    expect(() => assertColumns({ a: 1 }, [{ field: "x", spec: ["zz", "a"] }])).not.toThrow();
    expect(() => assertColumns({ a: 1 }, [{ field: "x", spec: "a" }], [{ column: "nai", equals: 1 }])).toThrow(/filters\(nai\)/);
    expect(() => assertColumns(undefined, [{ field: "x", spec: "a" }])).not.toThrow(); // 0 行は確かめようがない
  });
});

describe("filters", () => {
  const r = { status: "done", dept: { code: "A1" }, n: 5 };
  it("equals / notEquals / in（入れ子の列、数値は文字列比較）", () => {
    expect(passesFilters(r, [{ column: "status", equals: "done" }])).toBe(true);
    expect(passesFilters(r, [{ column: "status", notEquals: "done" }])).toBe(false);
    expect(passesFilters(r, [{ column: "dept.code", in: ["A1", "B2"] }])).toBe(true);
    expect(passesFilters(r, [{ column: "dept.code", in: ["B2"] }])).toBe(false);
    expect(passesFilters(r, [{ column: "n", equals: 5 }])).toBe(true);
  });
  it("複数条件はすべて満たす行だけ", () => {
    expect(passesFilters(r, [{ column: "status", equals: "done" }, { column: "n", notEquals: 5 }])).toBe(false);
    expect(passesFilters(r, undefined)).toBe(true);
  });
  it("アダプタが除外した行を取り込まない", async () => {
    const rows = [row(1), { ...row(2), s: "cancel" }, { ...row(3), s: "ok" }].map((x) => ({ s: "ok", ...x }));
    const out = await run({ filters: [{ column: "s", equals: "ok" }] }, (async () => json(rows)) as never);
    expect(out.map((w) => w.memberId)).toEqual(["M1", "M3"]);
  });
});

describe("query", () => {
  it("プレースホルダを置換し、? の有無で & を使い分ける", () => {
    expect(buildRequestUrl({ url: "https://x/a", query: "kind=work&d1={fromDate}&d2={toDate}" }, "2026-02", "2026-02")).toBe("https://x/a?kind=work&d1=2026-02-01&d2=2026-02-28");
    expect(buildRequestUrl({ url: "https://x/a?from={from}", query: "?to={to}" }, "2026-09", "2026-10")).toBe("https://x/a?from=2026-09&to=2026-10");
    expect(buildRequestUrl({ url: "https://x/a" }, "2026-09", "2026-09")).toBe("https://x/a");
    expect(buildRequestUrl({ url: "https://x/a", query: "t={toDate}" }, "2024-02", "2024-02")).toBe("https://x/a?t=2024-02-29");
  });
});

describe("ページング", () => {
  const ALL = Array.from({ length: 7 }, (_, i) => row(i + 1));
  const ids = (w: Worklog[]) => w.map((x) => x.memberId);

  it("none: 1 回だけ", async () => {
    const f = vi.fn(async () => json(ALL));
    expect(await run({ pagination: { type: "none" } }, f as never)).toHaveLength(7);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("page: 満たない件数のページで終わる。startPage・パラメータ名が効く", async () => {
    const urls: string[] = [];
    const f = vi.fn(async (u: string) => {
      urls.push(u);
      const url = new URL(u);
      const p = Number(url.searchParams.get("pg"));
      const size = Number(url.searchParams.get("sz"));
      return json(ALL.slice((p - 0) * size, (p - 0) * size + size));
    });
    const out = await run({ pagination: { type: "page", pageParam: "pg", sizeParam: "sz", size: 3, startPage: 0 } }, f as never);
    expect(ids(out)).toEqual(ALL.map((r) => r.m));
    expect(f).toHaveBeenCalledTimes(3);
    expect(urls[0]).toContain("pg=0");
    expect(urls[0]).toContain("from=2026-09"); // 元のクエリを保つ
  });

  it("page: ちょうど割り切れるときは空ページで終わる", async () => {
    const six = ALL.slice(0, 6);
    const f = vi.fn(async (u: string) => {
      const p = Number(new URL(u).searchParams.get("page"));
      return json(six.slice((p - 1) * 3, p * 3));
    });
    const out = await run({ pagination: { type: "page", pageParam: "page", sizeParam: "size", size: 3 } }, f as never);
    expect(out).toHaveLength(6);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("offset", async () => {
    const f = vi.fn(async (u: string) => {
      const url = new URL(u);
      const o = Number(url.searchParams.get("offset"));
      const l = Number(url.searchParams.get("limit"));
      return json(ALL.slice(o, o + l));
    });
    const out = await run({ pagination: { type: "offset", offsetParam: "offset", limitParam: "limit", limit: 4 } }, f as never);
    expect(out).toHaveLength(7);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("link: Link ヘッダの rel=next をたどる（相対 URL も可）", async () => {
    const f = vi.fn(async (u: string) => {
      const n = Number(new URL(u).searchParams.get("n") ?? "0");
      const chunk = ALL.slice(n * 3, n * 3 + 3);
      const headers: Record<string, string> = n < 2 ? { link: `</w?n=${n + 1}>; rel="next", </w?n=0>; rel="first"` } : {};
      return json(chunk, headers);
    });
    const out = await run({ pagination: { type: "link" } }, f as never);
    expect(out).toHaveLength(7);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("link: 別のサーバを指す next には（トークンを送らず）従わない", async () => {
    const f = vi.fn(async () => json(ALL.slice(0, 1), { link: '<https://evil.example/steal>; rel="next"' }));
    await expect(run({ pagination: { type: "link" } }, f as never)).rejects.toThrow(/別のサーバ/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("cursor: cursorPath の値を cursorParam で渡し、空で終わる", async () => {
    const f = vi.fn(async (u: string) => {
      const c = new URL(u).searchParams.get("after");
      const start = c === null ? 0 : Number(c);
      const next = start + 3 < ALL.length ? String(start + 3) : null;
      return json({ data: { items: ALL.slice(start, start + 3) }, meta: { next } });
    });
    const out = await run({ dataPath: "data.items", pagination: { type: "cursor", cursorPath: "meta.next", cursorParam: "after" } }, f as never);
    expect(out).toHaveLength(7);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("cursor: 同じカーソルの繰り返しで止まる", async () => {
    const f = vi.fn(async () => json({ items: ALL.slice(0, 2), next: "same" }));
    await expect(run({ dataPath: "items", pagination: { type: "cursor", cursorPath: "next", cursorParam: "c" } }, f as never)).rejects.toThrow(/同じカーソル/);
    expect(f.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("link: 同じ URL の繰り返しで止まる", async () => {
    const f = vi.fn(async (u: string) => json(ALL.slice(0, 1), { link: `<${u}>; rel="next"` }));
    await expect(run({ pagination: { type: "link" } }, f as never)).rejects.toThrow(/繰り返し/);
  });

  it("page: ページ指定が効かず同じ内容が返り続けるときは止まる", async () => {
    const f = vi.fn(async () => json(ALL.slice(0, 3)));
    await expect(run({ pagination: { type: "page", pageParam: "p", sizeParam: "s", size: 3 } }, f as never)).rejects.toThrow(/同じ内容/);
    expect(f.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("上限ページ数（maxPages）を超えたら止まる", async () => {
    let n = 0;
    const f = vi.fn(async () => json([{ ...row(1), m: `M${n++}` }]));
    await expect(run({ pagination: { type: "page", pageParam: "p", sizeParam: "s", size: 1, maxPages: 5 } }, f as never)).rejects.toThrow(/上限/);
    expect(f).toHaveBeenCalledTimes(5);
  });

  it("各ページでも 5xx は再試行する", async () => {
    let calls = 0;
    const f = vi.fn(async (u: string) => {
      calls++;
      if (calls === 2) return new Response("busy", { status: 503 });
      const p = Number(new URL(u).searchParams.get("p"));
      return json(ALL.slice((p - 1) * 5, p * 5));
    });
    const out = await run({ pagination: { type: "page", pageParam: "p", sizeParam: "s", size: 5 } }, f as never);
    expect(out).toHaveLength(7);
    expect(f).toHaveBeenCalledTimes(3);
  });
});

describe("parseNextLink", () => {
  it("rel の書き方いろいろ", () => {
    expect(parseNextLink('<https://a/b?p=2>; rel="next"')).toBe("https://a/b?p=2");
    expect(parseNextLink('<https://a/1>; rel=prev, <https://a/3>; rel=next')).toBe("https://a/3");
    expect(parseNextLink('<https://a/1>; rel="prev"')).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });
});

describe("文字コード（CSV 応答）", () => {
  const csv = "d,m,n,c,p,t,h\n2026-09-02,P001,岡田,やまびこ通信株式会社,拠点ネットワーク保守,監視,0.25\n";
  const res = (bytes: Uint8Array) => new Response(bytes as unknown as BodyInit, { status: 200, headers: { "content-type": "text/csv" } });

  it("encoding=shift_jis と auto の両方で Shift_JIS を読める", async () => {
    for (const encoding of ["shift_jis", "auto"]) {
      const out = await run({ encoding }, (async () => res(sjis(csv))) as never);
      expect(out[0]?.memberName).toBe("岡田");
      expect(out[0]?.customerName).toBe("やまびこ通信株式会社");
    }
  });
  it("UTF-8（BOM あり）も auto / utf-8 で読める", async () => {
    const bytes = new TextEncoder().encode("﻿" + csv);
    for (const encoding of ["auto", "utf-8"]) {
      const out = await run({ encoding }, (async () => res(bytes)) as never);
      expect(out[0]?.projectName).toBe("拠点ネットワーク保守");
    }
  });
});

describe("トークンを出さない", () => {
  it("redact: そのままと URL エンコードの両方を隠す", () => {
    expect(redact(`a ${TOKEN} b ${encodeURIComponent("t k/en")}`, "t k/en")).toBe(`a ${TOKEN} b ***`);
    expect(redact(`x ${TOKEN}`, TOKEN)).toBe("x ***");
  });
  it("ネットワークエラーの文にトークンが入っていても、例外・ログから除かれる", async () => {
    const logs: string[] = [];
    const f = vi.fn(async () => {
      throw new TypeError(`connect failed for https://x/?key=${TOKEN}`);
    });
    const err = await fetchRawRows(
      { url: "https://x/y", authHeader: "Authorization" } as HttpSourceOptions,
      { from: "2026-09", to: "2026-09", token: TOKEN, log: (m) => logs.push(m), deps: { fetchImpl: f as never, sleep: async () => {}, baseDelayMs: 0 } },
    ).then(() => new Error("成功してしまった"), (e: unknown) => e as Error);
    expect(err.message).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(err.message).toContain("***");
  });
  it("4xx の本文にトークンが反射されても除かれる", async () => {
    const f = vi.fn(async () => new Response(`bad token ${TOKEN}`, { status: 403, statusText: "Forbidden" }));
    const err = await run({}, f as never).then(() => new Error("成功してしまった"), (e: unknown) => e as Error);
    expect(err.message).toMatch(/HTTP 403/);
    expect(err.message).not.toContain(TOKEN);
  });
  it("ページングのログにも URL のホストとパスだけ", async () => {
    const logs: string[] = [];
    const f = vi.fn(async () => json([]));
    await createHttpAdapter({ fetchImpl: f as never, sleep: noSleep }).fetch({
      from: "2026-09",
      to: "2026-09",
      config: config({ query: `k=${TOKEN}`, pagination: { type: "page", pageParam: "p", sizeParam: "s", size: 10 } }),
      env: { WORKLOG_API_TOKEN: TOKEN },
      log: (m) => logs.push(m),
    });
    expect(logs.join("\n")).not.toContain(TOKEN);
  });
});

describe("後方互換: 既定の設定は従来と同じ結果", () => {
  it("従来の mapRow の結果と一致する", () => {
    const columns = { date: "work_date", memberId: "emp_no", memberName: "emp_name", customerName: "client", projectName: "project", task: "task", hours: "hours" };
    const w = mapRow({ work_date: "2026/09/01", emp_no: " M010 ", emp_name: " x ", client: " c ", project: "p", task: "t", hours: "abc" }, columns);
    expect(w).toEqual({ date: "2026-09-01", memberId: "M010", memberName: "x", customerName: " c ", projectName: "p", task: "t", hours: NaN });
    expect(mapRow({ work_date: "2026-09-01T10:00:00Z", emp_no: "a", emp_name: "b", client: "c", project: "p", task: "t", hours: "" }, columns).hours).toBe(0);
  });
});

describe("コマンドライン引数", () => {
  it("--dry-run --sample=N（fetch / fetch:members 共通）", async () => {
    const { parseArgs } = await import("../../scripts/fetch-worklogs.js");
    const { parseArgs: parseMembersArgs } = await import("../../scripts/fetch-members.js");
    expect(parseArgs(["--dry-run", "--sample=5"])).toMatchObject({ dryRun: true, sample: 5 });
    expect(parseArgs([]).dryRun).toBeUndefined();
    expect(() => parseArgs(["--sample=abc"])).toThrow(/--sample/);
    expect(parseMembersArgs(["--dry-run", "--sample=3", "--asOf", "2026-10-27"])).toMatchObject({ dryRun: true, sample: 3, asOf: "2026-10-27" });
  });
});
