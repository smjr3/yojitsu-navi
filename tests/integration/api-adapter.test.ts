/**
 * 取り込みアダプタの結合テスト（docs/SPEC.md §20）
 * リポジトリのダミーデータを一時ディレクトリにコピーし、global fetch を差し替えたモック API から
 * fetch-worklogs / fetch-members を通しで動かす。生成ファイルが validate を通ることまで確認する。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { csvParse } from "d3-dsv";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMembers, summaryLines } from "../../scripts/fetch-members.js";
import { fetchWorklogs, formatDryRun } from "../../scripts/fetch-worklogs.js";
import { runValidation } from "../../scripts/validate-data.js";
import { parseWorklogCsv } from "../../scripts/lib/csv.js";
import { sjis } from "../unit/sjis-helper.js";

const REPO = join(import.meta.dirname, "..", "..");
const TOKEN = "tok-INTEG-5555";
const AS_OF = "2026-10-27";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yojitsu-api-"));
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
const MONTHS = ["2026-08", "2026-09", "2026-10"];
const original = (ym: string) => parseWorklogCsv(readFileSync(join(REPO, "data/worklogs", `${ym}.csv`), "utf-8"));

describe("fetch-worklogs を本番風の API 形式で通す", () => {
  it("入れ子・分単位・epochMillis・カーソル・filters・候補列 → 元のダミーデータと同じ月ファイルになる", async () => {
    const all = MONTHS.flatMap((ym) => original(ym));
    // 本番風の応答: 入れ子の JSON、日付は epochMillis（JST 正午）、時間は分、取り消し行を混ぜる
    const apiRows = [
      ...all.map((w) => ({
        record: { id: 1, workedAt: Date.parse(`${w.date}T12:00:00+09:00`), minutes: Math.round(w.hours * 60), state: "ok" },
        worker: { code: w.memberId, displayName: w.memberName },
        client: { name: w.customerName },
        job: { title: w.projectName, memo: w.task },
      })),
      { record: { workedAt: Date.parse("2026-10-05T12:00:00+09:00"), minutes: 600, state: "cancelled" }, worker: { code: "M004", displayName: "x" }, client: { name: "x" }, job: { title: "x", memo: "x" } },
    ];
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("Authorization") });
      const u = new URL(url);
      const start = Number(u.searchParams.get("cursor") ?? "0");
      const size = 100;
      const items = apiRows.slice(start, start + size);
      const next = start + size < apiRows.length ? String(start + size) : null;
      return new Response(JSON.stringify({ result: { rows: items }, paging: { next } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    setConfig((c) => {
      c.worklogSource.adapter = "http";
      c.worklogSource.http = {
        url: "https://worklog.example.local/v2/records",
        authHeader: "X-Api-Key",
        refetchMonths: 3,
        dataPath: "result.rows",
        query: "from={fromDate}&to={toDate}&fmt=json",
        pagination: { type: "cursor", cursorPath: "paging.next", cursorParam: "cursor" },
        filters: [{ column: "record.state", notEquals: "cancelled" }],
        dateFormat: "epochMillis",
        hoursUnit: "minutes",
        columns: {
          date: "record.workedAt",
          memberId: ["worker.code", "worker.id"],
          memberName: "worker.displayName",
          customerName: "client.name",
          projectName: "job.title",
          task: "job.memo",
          hours: "record.minutes",
        },
      };
    });

    const res = await fetchWorklogs({ rootDir: root, asOf: AS_OF }, { WORKLOG_API_TOKEN: TOKEN } as NodeJS.ProcessEnv);
    expect(res.months).toEqual(MONTHS);
    for (const ym of MONTHS) expect(readMonth(ym)).toBe(readFileSync(join(REPO, "data/worklogs", `${ym}.csv`), "utf-8"));

    expect(seen.length).toBeGreaterThan(2);
    expect(seen.every((s) => s.auth === null)).toBe(true); // X-Api-Key で送っている
    expect(seen[0]?.url).toContain("from=2026-08-01&to=2026-10-31&fmt=json");
    expect(JSON.parse(readFileSync(join(root, "data/worklogs/_meta.json"), "utf-8")).adapter).toBe("http");
    const report = runValidation(root);
    expect(report.errors).toEqual([]);
  });

  it("Shift_JIS の CSV + ページ番号方式でも通る（auto 判定）", async () => {
    const all = MONTHS.flatMap((ym) => original(ym));
    const header = "作業日,社員番号,氏名,顧客,案件,作業内容,時間(h)";
    const pageSize = 200;
    const lines = all.map((w) => [w.date.replaceAll("-", "/"), w.memberId, w.memberName, w.customerName, w.projectName, w.task, w.hours].join(","));
    const fetchMock = vi.fn(async (url: string) => {
      const p = Number(new URL(url).searchParams.get("page"));
      const body = [header, ...lines.slice((p - 1) * pageSize, p * pageSize)].join("\r\n") + "\r\n";
      return new Response(sjis(body) as unknown as BodyInit, { status: 200, headers: { "content-type": "text/csv; charset=Shift_JIS" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    setConfig((c) => {
      c.worklogSource.adapter = "http";
      c.worklogSource.http = {
        url: "https://worklog.example.local/csv?from={from}&to={to}",
        authHeader: "Authorization",
        refetchMonths: 3,
        encoding: "auto",
        pagination: { type: "page", pageParam: "page", sizeParam: "size", size: pageSize },
        columns: { date: "作業日", memberId: "社員番号", memberName: "氏名", customerName: "顧客", projectName: "案件", task: "作業内容", hours: "時間(h)" },
      };
    });
    await fetchWorklogs({ rootDir: root, asOf: AS_OF }, { WORKLOG_API_TOKEN: TOKEN } as NodeJS.ProcessEnv);
    for (const ym of MONTHS) expect(readMonth(ym)).toBe(readFileSync(join(REPO, "data/worklogs", `${ym}.csv`), "utf-8"));
    expect(runValidation(root).errors).toEqual([]);
  });

  it("--dry-run: ファイルを書かず、対応表と先頭 N 行を出す。値でなく列名だけの案内", async () => {
    const before = MONTHS.map(readMonth);
    const metaBefore = readFileSync(join(root, "data/worklogs/_meta.json"), "utf-8");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([{ work_date: "2026-10-02", emp_no: "M004", emp_name: "田中 さくら", client: "株式会社青葉物流", project: "倉庫管理システム保守", task: "定例", hours: 1.5 }]), { status: 200, headers: { "content-type": "application/json" } })),
    );
    setConfig((c) => {
      c.worklogSource.adapter = "http";
      c.worklogSource.http.url = "https://worklog.example.local/x?from={from}&to={to}";
      c.worklogSource.http.columns = { date: ["work_date"], memberId: "emp_no", memberName: "emp_name", customerName: "client", projectName: "project", task: "task", hours: "hours" };
    });
    const res = await fetchWorklogs({ rootDir: root, asOf: AS_OF, dryRun: true, sample: 5 }, { WORKLOG_API_TOKEN: TOKEN } as NodeJS.ProcessEnv);
    expect(MONTHS.map(readMonth)).toEqual(before);
    expect(readFileSync(join(root, "data/worklogs/_meta.json"), "utf-8")).toBe(metaBefore);
    const text = formatDryRun(res).join("\n");
    expect(text).toContain("date");
    expect(text).toContain("<- work_date");
    expect(text).toContain("[使う列: emp_no]");
    expect(text).toContain("2026-10-02\tM004\t田中 さくら");
    expect(text).not.toContain(TOKEN);
  });

  it("列名が違うとき、列名一覧つきで止まりファイルは書かれない", async () => {
    const before = MONTHS.map(readMonth);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ a: "SECRET1", b: { c: "SECRET2" } }]), { status: 200, headers: { "content-type": "application/json" } })));
    setConfig((c) => {
      c.worklogSource.adapter = "http";
      c.worklogSource.http.url = "https://worklog.example.local/x";
    });
    const err = await fetchWorklogs({ rootDir: root, asOf: AS_OF }, { WORKLOG_API_TOKEN: TOKEN } as NodeJS.ProcessEnv).then(
      () => new Error("成功してしまった"),
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain("応答の最初の1行の列名: a, b.c");
    expect(err.message).not.toMatch(/SECRET/);
    expect(MONTHS.map(readMonth)).toEqual(before);
  });
});

describe("fetch-members を通しで", () => {
  const memberRows = () => {
    const rows = csvParse(readFileSync(join(REPO, "data/masters/members.csv"), "utf-8"));
    return rows;
  };
  const readMembers = () => csvParse(readFileSync(join(root, "data/masters/members.csv"), "utf-8"));

  it("adapter none: 何もしない", async () => {
    const before = readFileSync(join(root, "data/masters/members.csv"), "utf-8");
    const r = await fetchMembers({ rootDir: root, asOf: AS_OF }, {});
    expect(r.skipped).toBe(true);
    expect(summaryLines(r)[0]).toContain("none");
    expect(readFileSync(join(root, "data/masters/members.csv"), "utf-8")).toBe(before);
  });

  it("csv アダプタ（Shift_JIS の人事 CSV）: 変わった人だけ実行月の行を追加、team_id 引き継ぎ、再実行で変化なし", async () => {
    // 現在の有効レコードをもとに人事 CSV を作る。M004 は課長→部長に昇進、M005 は部署異動、新規 X001 を追加、退職者（取り込み元に無い人）は残す
    const cur = memberRows();
    const latest = new Map<string, Record<string, string>>();
    for (const r of cur) latest.set(r.member_id ?? "", r as Record<string, string>);
    // 人事データには在籍者だけが載る（退職者 status=退職 は載らない。§32）
    const retired = [...latest.values()].filter((r) => r.status === "退職").length;
    expect(retired).toBeGreaterThan(0);
    const hr = [...latest.values()]
      .filter((r) => r.member_id !== "M027" && r.status !== "退職")
      .map((r) => ({
        社員番号: r.member_id,
        氏名: r.name,
        区分: r.kind === "partner" ? "委託" : "正社員",
        役職: r.member_id === "M004" ? "部長" : r.title,
        部: r.member_id === "M005" ? "第2事業部" : r.department,
        課: r.section,
      }));
    hr.push({ 社員番号: "X001", 氏名: "新井 一", 区分: "正社員", 役職: "一般", 部: "第1事業部", 課: "第1課" });
    const csv = ["社員番号,氏名,区分,役職,部,課", ...hr.map((r) => Object.values(r).join(","))].join("\r\n") + "\r\n";
    mkdirSync(join(root, "data/hr"), { recursive: true });
    writeFileSync(join(root, "data/hr/members.csv"), sjis(csv));
    setConfig((c) => {
      c.memberSource = {
        adapter: "csv",
        csv: { path: "data/hr/members.csv" },
        columns: { memberId: "社員番号", name: "氏名", kind: "区分", title: "役職", department: "部", section: "課" },
        kindMap: { 正社員: "employee", 委託: "partner" },
      };
    });
    const before = [...readMembers()];
    const r1 = await fetchMembers({ rootDir: root, asOf: AS_OF }, {});
    expect(r1.merge).toMatchObject({ added: 1, changed: 2, keptNotInSource: 1 + retired });
    const after = readMembers();
    expect(after.length).toBe(before.length + 3);
    expect([...after].slice(0, before.length)).toEqual(before); // 既存の行は変わらない
    const added = [...after].slice(before.length);
    expect(added.every((r) => r.effective_from === "2026-10")).toBe(true);
    const m004prev = latest.get("M004");
    expect(added.find((r) => r.member_id === "M004")).toMatchObject({ title: "部長", team_id: m004prev?.team_id });
    expect(added.find((r) => r.member_id === "X001")).toMatchObject({ team_id: "", kind: "employee" });
    expect(added.find((r) => r.member_id === "M005")?.department).toBe("第2事業部");
    expect(after.some((r) => r.member_id === "M027")).toBe(true); // 削除しない
    expect(summaryLines(r1).join("\n")).toMatch(/新規 1 人 \/ 変更 2 人/);

    // 冪等: もう一度流してもファイルは変わらない
    const bytes = readFileSync(join(root, "data/masters/members.csv"), "utf-8");
    const r2 = await fetchMembers({ rootDir: root, asOf: AS_OF }, {});
    expect(r2.merge).toMatchObject({ added: 0, changed: 0 });
    expect(r2.written).toBe(false);
    expect(readFileSync(join(root, "data/masters/members.csv"), "utf-8")).toBe(bytes);

    // validate を通る（未知のチーム等のエラーが出ない）
    expect(runValidation(root).errors).toEqual([]);
  });

  it("--dry-run はファイルを書かない", async () => {
    mkdirSync(join(root, "data/hr"), { recursive: true });
    writeFileSync(join(root, "data/hr/members.csv"), "member_id,name,kind,title,department,section\nZ001,新人,employee,一般,第1事業部,第1課\n");
    setConfig((c) => {
      c.memberSource.adapter = "csv";
    });
    const before = readFileSync(join(root, "data/masters/members.csv"), "utf-8");
    const r = await fetchMembers({ rootDir: root, asOf: AS_OF, dryRun: true, sample: 3 }, {});
    expect(r.merge?.added).toBe(1);
    expect(r.written).toBe(false);
    expect(readFileSync(join(root, "data/masters/members.csv"), "utf-8")).toBe(before);
    expect(summaryLines(r).join("\n")).toContain("[dry-run]");
  });

  it("http アダプタ: ページング + filters（退職者除外）+ 入れ子の列。トークンは MEMBER_API_TOKEN", async () => {
    const people = [
      { emp: { no: "H001" }, nm: "人事 一郎", org: { dept: "第1事業部", sec: "第1課" }, post: "課長", status: "active" },
      { emp: { no: "H002" }, nm: "人事 二郎", org: { dept: "第2事業部", sec: "" }, post: "一般", status: "active" },
      { emp: { no: "H003" }, nm: "退職 者", org: { dept: "第2事業部", sec: "" }, post: "一般", status: "retired" },
    ];
    const f = vi.fn(async (url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
      const o = Number(new URL(url).searchParams.get("offset"));
      return new Response(JSON.stringify({ items: people.slice(o, o + 2) }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", f);
    setConfig((c) => {
      c.memberSource = {
        adapter: "http",
        http: { url: "https://hr.example.local/api/employees", authHeader: "Authorization", dataPath: "items", pagination: { type: "offset", offsetParam: "offset", limitParam: "limit", limit: 2 } },
        columns: { memberId: "emp.no", name: "nm", title: "post", department: "org.dept", section: "org.sec" },
        filters: [{ column: "status", equals: "active" }],
      };
    });
    const r = await fetchMembers({ rootDir: root, asOf: AS_OF }, { MEMBER_API_TOKEN: TOKEN } as NodeJS.ProcessEnv);
    expect(r.merge?.added).toBe(2);
    expect(f).toHaveBeenCalledTimes(2);
    const rows = readMembers();
    expect(rows.some((x) => x.member_id === "H003")).toBe(false);
    expect(rows.find((x) => x.member_id === "H001")).toMatchObject({ name: "人事 一郎", title: "課長", kind: "employee", effective_from: "2026-10" });
    // トークン未設定なら通信せずに止まる
    f.mockClear();
    await expect(fetchMembers({ rootDir: root, asOf: AS_OF }, {})).rejects.toThrow(/MEMBER_API_TOKEN/);
    expect(f).not.toHaveBeenCalled();
  });

  it("列名が違うときは列名一覧つきで止まる（値は出さない）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ id: "PRIVATE-NAME" }]), { status: 200, headers: { "content-type": "application/json" } })));
    setConfig((c) => {
      c.memberSource = { adapter: "http", http: { url: "https://hr.example.local/x", authHeader: "Authorization" }, columns: { memberId: "emp_no", name: "name" } };
    });
    const err = await fetchMembers({ rootDir: root, asOf: AS_OF }, { MEMBER_API_TOKEN: TOKEN } as NodeJS.ProcessEnv).then(
      () => new Error("成功してしまった"),
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain("応答の最初の1行の列名: id");
    expect(err.message).not.toContain("PRIVATE-NAME");
    expect(existsSync(join(root, "data/masters/members.csv"))).toBe(true);
  });
});
