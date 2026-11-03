/**
 * 作業実績 API の取得対象をメンバーマスタから作る・失敗時に CSV を書き換えない（SPEC §87）
 * リポジトリのダミーデータを一時ディレクトリにコピーし、global fetch を差し替えたモック API で通しで動かす。
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMembers } from "../../scripts/fetch-members.js";
import { fetchWorklogs, parseArgs, targetMonths } from "../../scripts/fetch-worklogs.js";
import { buildRequestUrl, checkMemberTarget } from "../../scripts/adapters/http-source.js";
import { chunk, parseMemberList, readMemberRecords, targetMemberIds } from "../../scripts/lib/fetch-targets.js";
import { safeMessage } from "../../scripts/lib/fetch-status.js";
import { loadDataset } from "../../scripts/lib/load.js";
import { parseWorklogCsv } from "../../scripts/lib/csv.js";
import type { MemberRecord, Worklog } from "../../src/core/types.js";

const REPO = join(import.meta.dirname, "..", "..");
const TOKEN = "tok-TARGET-7777";
const AS_OF = "2026-10-27";
const MONTHS = ["2026-08", "2026-09", "2026-10"];
const ENV = { WORKLOG_API_TOKEN: TOKEN } as NodeJS.ProcessEnv;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yojitsu-targets-"));
  cpSync(join(REPO, "data"), join(root, "data"), { recursive: true });
  cpSync(join(REPO, "config.json"), join(root, "config.json"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

function setConfig(patch: (c: Record<string, any>) => void) {
  const c = JSON.parse(readFileSync(join(root, "config.json"), "utf-8"));
  patch(c);
  writeFileSync(join(root, "config.json"), JSON.stringify(c, null, 2));
}
const readMonth = (ym: string) => readFileSync(join(root, "data/worklogs", `${ym}.csv`), "utf-8");
const readMeta = () => JSON.parse(readFileSync(join(root, "data/worklogs/_meta.json"), "utf-8")) as Record<string, any>;
const original = (ym: string) => parseWorklogCsv(readFileSync(join(REPO, "data/worklogs", `${ym}.csv`), "utf-8"));

const rec = (memberId: string, effectiveFrom: string, status?: string): MemberRecord => ({
  memberId,
  name: memberId,
  kind: "employee",
  title: "一般",
  department: "",
  section: "",
  teamId: null,
  effectiveFrom,
  ...(status ? { status } : {}),
});

/** モック API: member_ids=A,B,... の人の行だけを返す（JSON 配列、ページングなし） */
function memberApi(rows: Worklog[], opts: { failOnCall?: number; seen?: string[][] } = {}) {
  let calls = 0;
  return vi.fn(async (url: string) => {
    calls++;
    if (opts.failOnCall === calls) return new Response("bad request", { status: 400, statusText: "Bad Request" });
    const ids = (new URL(url).searchParams.get("member_ids") ?? "").split(",").filter((s) => s !== "");
    opts.seen?.push(ids);
    const set = new Set(ids);
    const body = rows.filter((w) => set.has(w.memberId)).map((w) => ({ date: w.date, member_id: w.memberId, member_name: w.memberName, customer_name: w.customerName, project_name: w.projectName, task: w.task, hours: w.hours, task_code: w.taskCode ?? "" }));
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

function useMemberApi(chunkSize: number) {
  setConfig((c) => {
    c.worklogSource.adapter = "http";
    c.worklogSource.http.url = "https://worklog.example.local/api?from={from}&to={to}";
    c.worklogSource.http.members = { param: "member_ids", chunkSize };
    c.worklogSource.http.columns.taskCode = "task_code";
  });
}

describe("取得対象の社員番号（メンバーマスタから）", () => {
  it("期間内に 1 か月でも在籍、または期間の最初の月に不在になった人。入社前・不在後は入れない", () => {
    const members = [
      rec("A", "2025-04"), // ずっと在籍
      rec("B", "2025-04"),
      rec("B", "2026-01", "left"), // 期間の前に不在 → 入れない
      rec("C", "2025-04"),
      rec("C", "2026-08", "left"), // 期間の最初の月に不在（前月は在籍）→ 入れる
      rec("D", "2026-11"), // 期間の後に入社 → 入れない
      rec("E", "2025-04"),
      rec("E", "2026-09", "left"), // 期間の途中で不在 → 入れる
      rec("F", "2025-04", "left"),
      rec("F", "2026-10"), // 期間の途中で復帰 → 入れる
      rec(" G ", "2026-10"), // 前後の空白は除く
    ];
    expect(targetMemberIds(members, "2026-08", "2026-10")).toEqual(["A", "C", "E", "F", "G"]);
    // 過去の期間を指定すれば、今は退職している人も入る
    expect(targetMemberIds(members, "2025-10", "2025-12")).toEqual(["A", "B", "C", "E"]);
  });

  it("ダミーデータ: 期間前に退職した人は入らず、期間中に不在になった人は入る", () => {
    const config = JSON.parse(readFileSync(join(root, "config.json"), "utf-8"));
    const ids = targetMemberIds(readMemberRecords(root, config), "2026-08", "2026-10");
    expect(ids.length).toBeGreaterThan(100);
    expect(ids).toContain("M175"); // 2026-10 に退職
    expect(ids).not.toContain("M178"); // 2026-07 から育休（期間の前月から不在）
    expect(ids).not.toContain("M141"); // 2026-01 に退職
    expect(ids).not.toContain("M151"); // 2026-06 に退職
    expect([...ids].sort()).toEqual(ids);
  });

  it("chunk・parseMemberList", () => {
    expect(chunk(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(chunk([], 50)).toEqual([]);
    expect(parseMemberList(" M001, M002\nM003、M001 ")).toEqual(["M001", "M002", "M003"]);
  });

  it("URL: join・repeat・{members}。設定の誤りは止める", () => {
    const http = { url: "https://x.local/api?from={from}", query: "" };
    expect(buildRequestUrl(http, "2026-08", "2026-10", { config: { param: "ids" }, ids: ["A", "B"] })).toBe("https://x.local/api?from=2026-08&ids=A%2CB");
    expect(buildRequestUrl(http, "2026-08", "2026-10", { config: { param: "ids", style: "repeat" }, ids: ["A", "B"] })).toBe("https://x.local/api?from=2026-08&ids=A&ids=B");
    expect(buildRequestUrl({ url: "https://x.local/api", query: "emp={members}" }, "2026-08", "2026-10", { config: { separator: "|" }, ids: ["A", "B"] })).toBe("https://x.local/api?emp=A%7CB");
    expect(buildRequestUrl(http, "2026-08", "2026-10")).toBe("https://x.local/api?from=2026-08");
    expect(() => checkMemberTarget(http, {})).toThrow(/members.param/);
    expect(() => checkMemberTarget({ url: "https://x.local/{members}" }, { style: "repeat" })).toThrow(/repeat/);
    expect(() => checkMemberTarget(http, { param: "ids", chunkSize: 0 })).toThrow(/chunkSize/);
  });

  it("期間の指定（--from / --to）と CI の変数", () => {
    expect(targetMonths({ from: "2025-11", to: "2026-02" }, AS_OF, 3)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(targetMonths({ from: "2026-09" }, AS_OF, 3)).toEqual(["2026-09", "2026-10"]);
    expect(targetMonths({}, AS_OF, 3)).toEqual(MONTHS);
    expect(() => targetMonths({ from: "2026-10", to: "2026-09" }, AS_OF, 3)).toThrow(/より後/);
    const o = parseArgs([], { FETCH_FROM: "2025-04", FETCH_TO: "2025-06", FETCH_MEMBERS: "M001,M002" });
    expect(o).toMatchObject({ from: "2025-04", to: "2025-06", members: ["M001", "M002"] });
    expect(parseArgs(["--from", "2025-05"], { FETCH_FROM: "2025-04" }).from).toBe("2025-05"); // コマンドラインが優先
    expect(() => parseArgs(["--from", "2025-13"])).toThrow(/YYYY-MM/);
    // 空の指定は「指定なし」（全員分の書き直し）に広げない
    expect(() => parseArgs(["--members", " , "])).toThrow(/社員番号がありません/);
    expect(() => parseArgs([], { FETCH_MEMBERS: "," })).toThrow(/社員番号がありません/);
    expect(parseArgs([], { FETCH_MEMBERS: "" }).members).toBeUndefined();
  });

  it("safeMessage: トークンを伏せ、改行をまとめ、長さを切る", () => {
    expect(safeMessage(`HTTP 400\nkey=${TOKEN}`, [TOKEN])).toBe("HTTP 400 key=***");
    expect(safeMessage("x".repeat(500), []).length).toBe(301);
  });
});

describe("fetch-worklogs: メンバーマスタの在籍者を人数ごとに分けて取得", () => {
  it("chunkSize 人ずつ全員分を取得し、在籍者の月ファイルになる", async () => {
    const all = MONTHS.flatMap(original);
    const seen: string[][] = [];
    vi.stubGlobal("fetch", memberApi(all, { seen }));
    useMemberApi(30);
    const config = JSON.parse(readFileSync(join(root, "config.json"), "utf-8"));
    const targets = targetMemberIds(readMemberRecords(root, config), "2026-08", "2026-10");

    const r = await fetchWorklogs({ rootDir: root, asOf: AS_OF }, ENV);
    expect(r.targetCount).toBe(targets.length);
    expect(seen.length).toBe(Math.ceil(targets.length / 30));
    expect(seen.every((ids) => ids.length <= 30)).toBe(true);
    expect(seen.flat()).toEqual(targets);
    const set = new Set(targets);
    for (const ym of MONTHS) {
      const expected = original(ym).filter((w) => set.has(w.memberId));
      expect(parseWorklogCsv(readMonth(ym))).toEqual(expected);
    }
    expect(readMeta().lastFailure).toBeUndefined();
  });

  it("途中の回で失敗したら月ファイルを 1 つも書き換えず、失敗を記録してデータ確認に出す。次に成功すると消える", async () => {
    const before = MONTHS.map(readMonth);
    const metaBefore = readMeta();
    vi.stubGlobal("fetch", memberApi(MONTHS.flatMap(original), { failOnCall: 3 }));
    useMemberApi(20);
    const err = await fetchWorklogs({ rootDir: root, asOf: AS_OF }, ENV).then(
      () => new Error("成功してしまった"),
      (e: unknown) => e as Error,
    );
    expect(err.message).toMatch(/^3\/\d+ 回目（.+）で失敗: HTTP 400/);
    expect(MONTHS.map(readMonth)).toEqual(before);
    const meta = readMeta();
    expect(meta.fetchedAt).toBe(metaBefore.fetchedAt); // 取得日時は前回成功のまま
    expect(meta.lastFailure.message).toContain("HTTP 400");
    expect(JSON.stringify(meta)).not.toContain(TOKEN);
    const issue = loadDataset(root).issues.find((i) => i.code === "WORKLOG_FETCH_FAILED");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("前回取得したデータのまま");

    vi.stubGlobal("fetch", memberApi(MONTHS.flatMap(original)));
    await fetchWorklogs({ rootDir: root, asOf: AS_OF }, ENV);
    expect(readMeta().lastFailure).toBeUndefined();
    expect(loadDataset(root).issues.some((i) => i.code === "WORKLOG_FETCH_FAILED")).toBe(false);
  });

  it("--members が空なら止め、月ファイルを書き換えない", async () => {
    const before = MONTHS.map(readMonth);
    useMemberApi(50);
    await expect(fetchWorklogs({ rootDir: root, asOf: AS_OF, members: [] }, ENV)).rejects.toThrow(/社員番号がありません/);
    expect(MONTHS.map(readMonth)).toEqual(before);
  });

  it("2 回目以降の応答だけ列が欠けていても止め、月ファイルを書き換えない", async () => {
    const before = MONTHS.map(readMonth);
    const all = MONTHS.flatMap(original);
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls++;
      const set = new Set((new URL(url).searchParams.get("member_ids") ?? "").split(","));
      const body = all.filter((w) => set.has(w.memberId)).map((w) => {
        const row: Record<string, unknown> = { date: w.date, member_id: w.memberId, member_name: w.memberName, customer_name: w.customerName, project_name: w.projectName, task: w.task, hours: w.hours, task_code: w.taskCode ?? "" };
        if (calls >= 2) delete row.hours;
        return row;
      });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    useMemberApi(30);
    await expect(fetchWorklogs({ rootDir: root, asOf: AS_OF }, ENV)).rejects.toThrow(/^2\/\d+ 回目.*列が見つかりません: hours/);
    expect(MONTHS.map(readMonth)).toEqual(before);
  });

  it("本番の形（ページ番号だけ・空配列で終了。§90）と組み合わせても、回ごとに全ページを取る", async () => {
    const all = MONTHS.flatMap(original);
    const pageSize = 500;
    const seen: Array<{ ids: string; page: string | null; size: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = new URL(url);
      seen.push({ ids: u.searchParams.get("member_ids") ?? "", page: u.searchParams.get("page"), size: u.searchParams.get("size") });
      const set = new Set((u.searchParams.get("member_ids") ?? "").split(","));
      const mine = all.filter((w) => set.has(w.memberId));
      const p = Number(u.searchParams.get("page"));
      const body = mine.slice((p - 1) * pageSize, p * pageSize).map((w) => ({ date: w.date, member_id: w.memberId, member_name: w.memberName, customer_name: w.customerName, project_name: w.projectName, task: w.task, hours: w.hours, task_code: w.taskCode ?? "" }));
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    useMemberApi(40);
    setConfig((c) => {
      c.worklogSource.http.pagination = { type: "page", pageParam: "page", stopWhen: "empty" };
    });
    const config = JSON.parse(readFileSync(join(root, "config.json"), "utf-8"));
    const set = new Set(targetMemberIds(readMemberRecords(root, config), "2026-08", "2026-10"));
    await fetchWorklogs({ rootDir: root, asOf: AS_OF }, ENV);
    expect(seen.every((s) => s.size === null)).toBe(true); // 件数のパラメータは送らない
    expect(new Set(seen.map((s) => s.ids)).size).toBe(Math.ceil(set.size / 40));
    for (const ym of MONTHS) expect(parseWorklogCsv(readMonth(ym))).toEqual(original(ym).filter((w) => set.has(w.memberId)));
  });

  it("dry-run の失敗は記録しない", async () => {
    const metaBefore = readFileSync(join(root, "data/worklogs/_meta.json"), "utf-8");
    vi.stubGlobal("fetch", memberApi([], { failOnCall: 1 }));
    useMemberApi(50);
    await expect(fetchWorklogs({ rootDir: root, asOf: AS_OF, dryRun: true }, ENV)).rejects.toThrow(/HTTP 400/);
    expect(readFileSync(join(root, "data/worklogs/_meta.json"), "utf-8")).toBe(metaBefore);
  });

  it("--members: 指定した人の行だけ差し替え、他の人の行と取得日時は残す（過去の期間・退職者の取り直し）", async () => {
    const ym = "2026-09";
    const target = original(ym).find((w) => w.memberId === "M141") ?? original(ym)[0]!;
    const id = target.memberId;
    const changed = original(ym).filter((w) => w.memberId === id).map((w) => ({ ...w, hours: 1 }));
    vi.stubGlobal("fetch", memberApi(changed));
    useMemberApi(50);
    const metaBefore = readMeta();
    const r = await fetchWorklogs({ rootDir: root, asOf: AS_OF, from: ym, to: ym, members: [id] }, ENV);
    expect(r).toMatchObject({ months: [ym], partial: true, targetCount: 1 });
    const after = parseWorklogCsv(readMonth(ym));
    expect(after.filter((w) => w.memberId !== id)).toEqual(original(ym).filter((w) => w.memberId !== id));
    expect(after.filter((w) => w.memberId === id).every((w) => w.hours === 1)).toBe(true);
    expect(readMeta().fetchedAt).toBe(metaBefore.fetchedAt);
    // 対象外の月は触らない
    expect(readMonth("2026-10")).toBe(readFileSync(join(REPO, "data/worklogs/2026-10.csv"), "utf-8"));
  });

  it("members を設定しない API はこれまでどおり（社員番号を渡さず全件）", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }));
    setConfig((c) => {
      c.worklogSource.adapter = "http";
      c.worklogSource.http.url = "https://worklog.example.local/api?from={from}&to={to}";
    });
    const r = await fetchWorklogs({ rootDir: root, asOf: AS_OF }, ENV);
    expect(urls).toEqual(["https://worklog.example.local/api?from=2026-08&to=2026-10"]);
    expect(r.targetCount).toBeUndefined();
  });
});

describe("fetch-members: 失敗したら members.csv を書き換えず記録する（横展開）", () => {
  it("失敗の記録 → データ確認に出る → 次に成功すると消える", async () => {
    const path = join(root, "data/masters/members.csv");
    const before = readFileSync(path, "utf-8");
    setConfig((c) => {
      c.memberSource = { adapter: "csv", csv: { path: "data/hr/none.csv" }, columns: { memberId: "社員番号", name: "氏名" } };
    });
    await expect(fetchMembers({ rootDir: root, asOf: AS_OF }, {})).rejects.toThrow();
    expect(readFileSync(path, "utf-8")).toBe(before);
    const metaPath = join(root, "data/masters/_members-meta.json");
    expect(JSON.parse(readFileSync(metaPath, "utf-8")).lastFailure.message).not.toBe("");
    expect(loadDataset(root).issues.find((i) => i.code === "MEMBER_FETCH_FAILED")?.message).toContain("メンバーマスタは前回のまま");

    writeFileSync(join(root, "data/hr-ok.csv"), "社員番号,氏名\r\nM001,佐藤 健一\r\n");
    setConfig((c) => {
      c.memberSource.csv.path = "data/hr-ok.csv";
    });
    await fetchMembers({ rootDir: root, asOf: AS_OF }, {});
    expect(existsSync(metaPath)).toBe(false);
  });
});
