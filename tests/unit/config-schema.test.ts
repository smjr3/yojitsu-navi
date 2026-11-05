/**
 * config.json の互換確認（SPEC §96、scripts/lib/config-schema.mjs）。
 * 設定の項目を足したらスキーマにも足すこと（リポジトリの config.json・テスト用の設定・全項目入りの設定が通るかで確かめる）
 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkConfig, formatConfigIssues, parseConfigText } from "../../scripts/lib/config-schema.mjs";
import { runValidation } from "../../scripts/validate-data.js";
import { createTestProject, testConfig } from "../fixtures/project.js";

const ROOT = join(import.meta.dirname, "..", "..");
const repoConfig = () => JSON.parse(readFileSync(join(ROOT, "config.json"), "utf-8"));
/** 結果の一覧（並びは見ない） */
const codes = (c: unknown) => checkConfig(c).map((i) => `${i.level}:${i.code}:${i.path}`).sort();

/** 任意の項目をすべて書いた本番向けの設定（項目を足したらここにも足す） */
function fullConfig(): Record<string, any> {
  const c = repoConfig();
  c._comment = "メモは見ない";
  c.worklogSource.adapter = "http";
  Object.assign(c.worklogSource.http, {
    url: "https://worklog.example.local/api",
    authScheme: "Bearer",
    dataPath: "data.items",
    method: "GET",
    pagination: { type: "page", pageParam: "page", stopWhen: "empty", maxPages: 5000, startPage: 1 },
    query: "from={fromDate}",
    filters: [{ column: "status", equals: "done" }, { column: "kind", in: ["a", 1, true] }, { column: "x", notEquals: 0 }],
    encoding: "auto",
    dateFormat: "YYYY-MM-DD",
    hoursUnit: "minutes",
    members: { param: "ids", style: "join", separator: ",", chunkSize: 50 },
  });
  c.worklogSource.http.columns.taskCode = ["task_code", "code"];
  c.memberSource = {
    adapter: "http",
    csv: { path: "data/hr/members.csv", encoding: "shift_jis" },
    http: { url: "https://hr.example.local/api", authHeader: "Authorization", pagination: { type: "offset", offsetParam: "o", limitParam: "l", limit: 100 } },
    columns: { memberId: "id", name: "name", kind: "kind", title: "title", division: "d1", department: "d2", section: "d3" },
    kindMap: { 正社員: "employee", 委託: "partner" },
    filters: [{ column: "retired", equals: false }],
  };
  c.masterEdit.gitlab.projectId = 123;
  return c;
}

describe("config.json の互換確認（§96）", () => {
  it("リポジトリの config.json・テスト用の設定・全項目入りの設定は問題なし（設定の項目を足したらスキーマにも足す）", () => {
    expect(checkConfig(repoConfig())).toEqual([]);
    expect(checkConfig(testConfig())).toEqual([]);
    expect(checkConfig(fullConfig())).toEqual([]);
    for (const type of ["none", "link"]) expect(checkConfig({ ...fullConfig(), worklogSource: { ...fullConfig().worklogSource, http: { ...fullConfig().worklogSource.http, pagination: { type } } } })).toEqual([]);
    const cursor = fullConfig();
    cursor.worklogSource.http.pagination = { type: "cursor", cursorPath: "next", cursorParam: "cursor", maxPages: 10 };
    expect(checkConfig(cursor)).toEqual([]);
  });

  it("必須の項目が無い・型が違う・決まった値でない・範囲の外はエラー", () => {
    const c = fullConfig();
    delete c.forecastRecentMonths;
    c.fiscalYearStartMonth = 13;
    c.standardHoursPerMonth = "160";
    c.taskCodeCheck.onChange = "halt";
    c.worklogSource.http.pagination = { type: "page", stopWhen: "emptyy" };
    c.worklogSource.http.members.chunkSize = 0;
    c.worklogSource.http.columns.hours = [];
    c.costTypes = [{ id: "labor" }];
    expect(codes(c)).toEqual([
      "error:CONFIG_RANGE:fiscalYearStartMonth",
      "error:CONFIG_TYPE:standardHoursPerMonth",
      "error:CONFIG_MISSING:forecastRecentMonths",
      "error:CONFIG_TYPE:worklogSource.http.columns.hours",
      "error:CONFIG_MISSING:worklogSource.http.pagination.pageParam",
      "error:CONFIG_VALUE:worklogSource.http.pagination.stopWhen",
      "error:CONFIG_RANGE:worklogSource.http.members.chunkSize",
      "error:CONFIG_MISSING:costTypes[0].label",
      "error:CONFIG_VALUE:taskCodeCheck.onChange",
    ].sort());
    const lines = formatConfigIssues(checkConfig(c));
    expect(lines[0]).toBe("エラー（直すまで CI が止まります）: 9 件");
    expect(lines.join("\n")).toContain('taskCodeCheck.onChange: "warn" / "stop" のどれかにしてください（今: "halt"）');
  });

  it("取得元の URL・列は adapter が http のときだけ必須", () => {
    const c = repoConfig();
    delete c.worklogSource.http;
    expect(checkConfig(c)).toEqual([]);
    c.worklogSource.adapter = "http";
    expect(codes(c)).toEqual(["error:CONFIG_MISSING:worklogSource.http"]);
    c.worklogSource.http = { refetchMonths: 3 };
    expect(codes(c)).toEqual(["error:CONFIG_MISSING:worklogSource.http.authHeader", "error:CONFIG_MISSING:worklogSource.http.columns", "error:CONFIG_MISSING:worklogSource.http.url"]);
    const m = repoConfig();
    m.memberSource = { adapter: "csv" };
    expect(codes(m)).toEqual([]);
    m.memberSource.csv = {};
    m.memberSource.columns = {};
    expect(codes(m)).toEqual(["error:CONFIG_MISSING:memberSource.columns.memberId", "error:CONFIG_MISSING:memberSource.columns.name", "error:CONFIG_MISSING:memberSource.csv.path"]);
  });

  it("この版で使わない項目は注意だけ（止めない）。「_」で始まる項目はメモとして見ない", () => {
    const c = repoConfig();
    c.oldSetting = 1;
    c.worklogSource.http.pagination = { type: "page", pageParam: "page", sizee: 100 };
    c.memberSource.kindMap = { 正社員: "staff" };
    c._note = "x";
    expect(codes(c)).toEqual(["error:CONFIG_VALUE:memberSource.kindMap.正社員", "warning:CONFIG_UNKNOWN:worklogSource.http.pagination.sizee", "warning:CONFIG_UNKNOWN:oldSetting"].sort());
  });

  it("廃止・名前の変わった項目は注意で移し方を出す", () => {
    const schema = { type: "object", props: { a: { type: "string", deprecated: "b に名前が変わりました。b に移してください" }, b: { type: "string" } } };
    expect(checkConfig({ a: "x" }, schema)).toEqual([{ level: "warning", code: "CONFIG_DEPRECATED", path: "a", message: "b に名前が変わりました。b に移してください" }]);
  });

  it("JSON として読めないもの・BOM 付き", () => {
    expect(parseConfigText("﻿{}").config).toEqual({});
    expect(parseConfigText("{,}").error).toContain("JSON として読めません");
    expect(codes([])).toEqual(["error:CONFIG_TYPE:"]);
  });

  it("npm run config:check（scripts/check-config.mjs）はエラーで終了コード 1。npm run validate もエラーにする", () => {
    const root = createTestProject("config-check-");
    try {
      const run = () => spawnSync(process.execPath, [join(ROOT, "scripts", "check-config.mjs"), "--root", root], { encoding: "utf-8" });
      let r = run();
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("問題ありません");
      const c = testConfig();
      c.taskCodeCheck.onUnregistered = "error";
      c.unknownKey = true;
      writeFileSync(join(root, "config.json"), JSON.stringify(c));
      r = run();
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("taskCodeCheck.onUnregistered");
      expect(r.stdout).toContain("unknownKey");
      const v = runValidation(root);
      expect(v.errors.map((i) => i.code)).toContain("CONFIG_VALUE");
      expect(v.warnings.map((i) => i.code)).toContain("CONFIG_UNKNOWN");
      expect(v.text).toContain("config.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
