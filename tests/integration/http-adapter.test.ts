/**
 * http アダプタのテスト。global fetch をモックして、JSON / CSV / 再試行 / 認証ヘッダを確認する
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpAdapter, extractArray, mapRow } from "../../scripts/adapters/http.js";
import type { Config } from "../../src/core/types.js";

function makeConfig(httpOverrides: Record<string, unknown> = {}): Config {
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
    worklogSource: {
      adapter: "http",
      csv: { path: "data/worklogs" },
      http: {
        url: "https://worklog.example.local/api/export?from={from}&to={to}",
        authHeader: "Authorization",
        refetchMonths: 3,
        columns: {
          date: "work_date",
          memberId: "emp_no",
          memberName: "emp_name",
          customerName: "client",
          projectName: "project",
          task: "task",
          hours: "hours",
        },
        ...httpOverrides,
      },
    },
    costTypes: [{ id: "labor", label: "工数原価" }],
  };
}

const ENV = { WORKLOG_API_TOKEN: "secret-token-123" };
const noSleep = async () => {};
const silent = () => {};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const ROWS = [
  { work_date: "2026-09-01", emp_no: "M010", emp_name: "中村 拓也", client: "株式会社青葉物流", project: "倉庫管理システム保守", task: "定例", hours: 2.5 },
  { work_date: "2026-10-05", emp_no: "M011", emp_name: "小林 玲奈", client: "青葉物流", project: "倉庫管理システム保守", task: "調査", hours: "3" },
  { work_date: "2026-11-01", emp_no: "M012", emp_name: "範囲外", client: "x", project: "y", task: "z", hours: 1 },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("http アダプタ", () => {
  it("JSON 配列を列マッピングで Worklog にし、期間外の行は捨てる", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(ROWS));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createHttpAdapter({ sleep: noSleep });
    const rows = await adapter.fetch({ from: "2026-09", to: "2026-10", config: makeConfig(), env: ENV, log: silent });
    expect(rows).toEqual([
      { date: "2026-09-01", memberId: "M010", memberName: "中村 拓也", customerName: "株式会社青葉物流", projectName: "倉庫管理システム保守", task: "定例", hours: 2.5 },
      { date: "2026-10-05", memberId: "M011", memberName: "小林 玲奈", customerName: "青葉物流", projectName: "倉庫管理システム保守", task: "調査", hours: 3 },
    ]);
    // URL の置換と認証ヘッダ
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://worklog.example.local/api/export?from=2026-09&to=2026-10");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer secret-token-123");
  });

  it("dataPath で入れ子の配列を取り出せる", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { items: ROWS.slice(0, 1) }, total: 1 })));
    const adapter = createHttpAdapter({ sleep: noSleep });
    const rows = await adapter.fetch({ from: "2026-09", to: "2026-09", config: makeConfig({ dataPath: "data.items" }), env: ENV, log: silent });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.memberId).toBe("M010");
  });

  it("CSV 応答（text/csv, BOM あり）も読める", async () => {
    const csv = "﻿work_date,emp_no,emp_name,client,project,task,hours\n2026-09-02,P001,岡田,やまびこ通信株式会社,拠点ネットワーク保守,監視・運用,0.25\n";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(csv, { status: 200, headers: { "content-type": "text/csv" } })));
    const adapter = createHttpAdapter({ sleep: noSleep });
    const rows = await adapter.fetch({ from: "2026-09", to: "2026-09", config: makeConfig(), env: ENV, log: silent });
    expect(rows).toEqual([{ date: "2026-09-02", memberId: "P001", memberName: "岡田", customerName: "やまびこ通信株式会社", projectName: "拠点ネットワーク保守", task: "監視・運用", hours: 0.25 }]);
  });

  it("独自ヘッダ名のときは接頭辞なしでトークンを送る", async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createHttpAdapter({ sleep: noSleep });
    await adapter.fetch({ from: "2026-09", to: "2026-09", config: makeConfig({ authHeader: "X-Api-Key" }), env: ENV, log: silent });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe("secret-token-123");
  });

  it("5xx は指数バックオフで再試行し、3回目で成功すれば返す", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(ROWS.slice(0, 1)));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = vi.fn(async (_ms: number) => {});
    const logs: string[] = [];
    const adapter = createHttpAdapter({ sleep, baseDelayMs: 100 });
    const rows = await adapter.fetch({ from: "2026-09", to: "2026-09", config: makeConfig(), env: ENV, log: (m) => logs.push(m) });
    expect(rows).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
    // トークンはログに出ない
    expect(logs.join("\n")).not.toContain("secret-token-123");
  });

  it("3回とも 5xx なら失敗する", async () => {
    const fetchMock = vi.fn(async () => new Response("down", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createHttpAdapter({ sleep: noSleep });
    await expect(adapter.fetch({ from: "2026-09", to: "2026-09", config: makeConfig(), env: ENV, log: silent })).rejects.toThrow(/HTTP 500/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("4xx は再試行しない（トークンは例外メッセージに含まれない）", async () => {
    const fetchMock = vi.fn(async () => new Response("unauthorized", { status: 401, statusText: "Unauthorized" }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createHttpAdapter({ sleep: noSleep });
    const err = await adapter.fetch({ from: "2026-09", to: "2026-09", config: makeConfig(), env: ENV, log: silent }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/HTTP 401/);
    expect((err as Error).message).not.toContain("secret-token-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("トークンや URL が無ければ fetch せずに失敗する", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createHttpAdapter({ sleep: noSleep });
    await expect(adapter.fetch({ from: "2026-09", to: "2026-09", config: makeConfig(), env: {}, log: silent })).rejects.toThrow(/WORKLOG_API_TOKEN/);
    await expect(adapter.fetch({ from: "2026-09", to: "2026-09", config: makeConfig({ url: "" }), env: ENV, log: silent })).rejects.toThrow(/url/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("補助関数", () => {
  it("extractArray: dataPath が無い・配列でないときはエラー", () => {
    expect(extractArray([1], undefined)).toEqual([1]);
    expect(extractArray({ a: { b: [2] } }, "a.b")).toEqual([2]);
    expect(() => extractArray({ a: {} }, "a.b")).toThrow(/dataPath/);
    expect(() => extractArray({ a: 1 }, "a")).toThrow(/配列/);
  });

  it("mapRow: 日付のスラッシュを直し、数値でない時間は NaN にする", () => {
    const columns = makeConfig().worklogSource.http.columns;
    const w = mapRow({ work_date: "2026/09/01", emp_no: " M010 ", emp_name: "x", client: "c", project: "p", task: "t", hours: "abc" }, columns);
    expect(w.date).toBe("2026-09-01");
    expect(w.memberId).toBe("M010");
    expect(Number.isNaN(w.hours)).toBe(true);
  });
});
