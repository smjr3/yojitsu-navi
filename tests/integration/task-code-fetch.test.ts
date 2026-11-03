/**
 * 取り込み時の作業コード（SPEC §92）: API の作業コード列・CSV への書き出し・未登録や作業名の変更で止める設定
 * 一時ディレクトリに最小のデータを作り、global fetch を差し替えたモック API で通しで動かす。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapRow } from "../../scripts/adapters/http.js";
import { fetchWorklogs, formatDryRun, parseArgs } from "../../scripts/fetch-worklogs.js";
import { formatWorklogCsv, parseWorklogCsv } from "../../scripts/lib/csv.js";

const REPO = join(import.meta.dirname, "..", "..");
const ENV = { WORKLOG_API_TOKEN: "tok-CODE-1234" } as NodeJS.ProcessEnv;
const AS_OF = "2026-10-27";
const HEADER = "date,member_id,member_name,customer_name,project_name,task,hours,task_code\n";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yojitsu-taskcode-"));
  mkdirSync(join(root, "data", "worklogs"), { recursive: true });
  cpSync(join(REPO, "config.json"), join(root, "config.json"));
  setConfig((c) => {
    c.worklogSource.adapter = "http";
    c.worklogSource.http.url = "https://worklog.example.local/api?from={from}&to={to}";
    c.worklogSource.http.refetchMonths = 1;
    c.worklogSource.http.columns.taskCode = "task_code";
    c.taskCodeCheck = { include: ["_保守対応"] };
    delete c.worklogSource.http.members;
  });
  writeFileSync(join(root, "data", "mapping.csv"), "worklog_customer_name,worklog_project_name,contract_id,task_code,start_month,end_month\n,,C1,W-01,,\n");
  // 前回までに取り込んだ月
  writeFileSync(join(root, "data", "worklogs", "2026-09.csv"), HEADER + "2026-09-01,M1,a,ABC,基幹,障害対応_保守対応,1,W-01\n");
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

function setConfig(patch: (c: Record<string, any>) => void) {
  const p = join(root, "config.json");
  const c = JSON.parse(readFileSync(p, "utf-8"));
  patch(c);
  writeFileSync(p, JSON.stringify(c, null, 2));
}
function api(rows: Array<Record<string, unknown>>) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } })));
}
const row = (date: string, task: string, code: string) => ({ date, member_id: "M1", member_name: "a", customer_name: "ABC", project_name: "基幹", task, hours: 2, task_code: code });
const october = () => readFileSync(join(root, "data", "worklogs", "2026-10.csv"), "utf-8");
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

describe("作業コードの列", () => {
  it("columns.taskCode を設定したときだけ読む。CSV には作業コードがある月だけ task_code 列を付け、読み戻せる", () => {
    const raw = { d: "2026-10-01", m: "M1", n: "a", c: "ABC", p: "基幹", t: "x", h: 1, code: " W-01 " };
    const cols = { date: "d", memberId: "m", memberName: "n", customerName: "c", projectName: "p", task: "t", hours: "h" };
    expect(mapRow(raw, cols).taskCode).toBeUndefined();
    expect(mapRow(raw, { ...cols, taskCode: "code" }).taskCode).toBe("W-01");
    const w = mapRow(raw, { ...cols, taskCode: "code" });
    const csv = formatWorklogCsv([w]);
    expect(csv.split("\n")[0]).toBe(HEADER.trim());
    expect(parseWorklogCsv(csv)).toEqual([w]);
    expect(formatWorklogCsv([{ ...w, taskCode: "" }]).split("\n")[0]).toBe("date,member_id,member_name,customer_name,project_name,task,hours");
  });

  it("設定した作業コードの列が応答に無ければ止める（列名の一覧つき）", async () => {
    quiet();
    api([{ date: "2026-10-01", member_id: "M1", member_name: "a", customer_name: "ABC", project_name: "基幹", task: "x", hours: 1 }]);
    await expect(fetchWorklogs({ rootDir: root, asOf: AS_OF }, ENV)).rejects.toThrow(/taskCode/);
  });
});

describe("取り込み時の点検（taskCodeCheck）", () => {
  it("既定（warn）は取り込み、警告をログと結果に出す", async () => {
    const log = quiet();
    api([row("2026-10-01", "新しい監視_保守対応", "W-09")]);
    const r = await fetchWorklogs({ rootDir: root, asOf: AS_OF }, ENV);
    expect(october()).toContain("W-09");
    expect(r.taskCodeWarnings).toEqual(["作業コード W-09（新しい監視_保守対応）は運用保守のキーワードに合いますが、mapping.csv にありません（1 件・2 時間、2026-10-01〜2026-10-01）"]);
    expect(log.mock.calls.some(([m]) => String(m).includes("警告: 作業コード W-09"))).toBe(true);
  });

  it("onUnregistered=stop: 未登録の作業コードがあれば月ファイルを書かずに止め、失敗を記録する", async () => {
    quiet();
    setConfig((c) => (c.taskCodeCheck.onUnregistered = "stop"));
    api([row("2026-10-01", "新しい監視_保守対応", "W-09")]);
    await expect(fetchWorklogs({ rootDir: root, asOf: AS_OF }, ENV, () => new Date("2026-10-27T00:00:00Z"))).rejects.toThrow(/未登録の作業コードが 1 件.*W-09/);
    expect(() => october()).toThrow();
    const meta = JSON.parse(readFileSync(join(root, "data", "worklogs", "_meta.json"), "utf-8"));
    expect(meta.lastFailure.message).toContain("W-09");
  });

  it("onUnregistered=stop: mapping.csv のヘッダの前後に空白があっても画面と同じく読む（期間外は止める）", async () => {
    quiet();
    setConfig((c) => (c.taskCodeCheck.onUnregistered = "stop"));
    writeFileSync(join(root, "data", "mapping.csv"), "worklog_customer_name, worklog_project_name, contract_id, task_code , start_month ,end_month\n,,C1,W-01,,\n,,C1, W-09 ,2026-11,\n");
    api([row("2026-10-01", "新しい監視_保守対応", "W-09")]);
    await expect(fetchWorklogs({ rootDir: root, asOf: AS_OF }, ENV)).rejects.toThrow(/未登録の作業コードが 1 件.*W-09/);
  });

  it("onUnregistered=stop: mapping.csv に足せば通る", async () => {
    quiet();
    setConfig((c) => (c.taskCodeCheck.onUnregistered = "stop"));
    writeFileSync(join(root, "data", "mapping.csv"), "worklog_customer_name,worklog_project_name,contract_id,task_code,start_month,end_month\n,,C1,W-01,,\n,,C1,W-09,2026-10,\n");
    api([row("2026-10-01", "新しい監視_保守対応", "W-09")]);
    const r = await fetchWorklogs({ rootDir: root, asOf: AS_OF }, ENV);
    expect(r.taskCodeWarnings).toBeUndefined();
    expect(october()).toContain("W-09");
  });

  it("onChange=stop: 新しい作業名の変更で止め、FETCH_ACCEPT_TASK_CHANGES=1 で通す。一度取り込んだ変更では止めない", async () => {
    quiet();
    setConfig((c) => (c.taskCodeCheck.onChange = "stop"));
    api([row("2026-10-01", "障害対応（夜間含む）", "W-01")]);
    await expect(fetchWorklogs({ rootDir: root, asOf: AS_OF }, ENV)).rejects.toThrow(/作業名が変わった作業コードが 1 件（うちキーワードの一致が変わったもの 1 件）.*FETCH_ACCEPT_TASK_CHANGES=1/);
    expect(() => october()).toThrow();

    const accepted = parseArgs([], { FETCH_ACCEPT_TASK_CHANGES: "1" });
    expect(accepted.acceptTaskChanges).toBe(true);
    const r = await fetchWorklogs({ ...accepted, rootDir: root, asOf: AS_OF }, ENV);
    expect(r.taskCodeWarnings).toEqual(["作業コード W-01 の作業名が 2026-10-01 から「障害対応_保守対応」→「障害対応（夜間含む）」に変わり、運用保守のキーワードに合わなくなりました"]);
    // 次の取り込み: 同じ変更はもう取り込み済みなので止めない
    const again = await fetchWorklogs({ rootDir: root, asOf: AS_OF }, ENV);
    expect(again.taskCodeWarnings).toBeUndefined();
  });

  it("onChange=stop: 取り直しで古い作業名の行がすべて置き換わっても、作業名の変更として止める", async () => {
    quiet();
    setConfig((c) => {
      c.taskCodeCheck.onChange = "stop";
      c.worklogSource.http.refetchMonths = 2;
    });
    api([row("2026-09-01", "障害対応（夜間含む）", "W-01")]);
    await expect(fetchWorklogs({ rootDir: root, asOf: AS_OF }, ENV)).rejects.toThrow(/作業名が変わった作業コードが 1 件/);
  });

  it("--members と --dry-run: 書き込むときと同じく指定外の人の既存行を残して点検する", async () => {
    quiet();
    // 2026-09 の M1 の行（障害対応_保守対応）は残るので、M2 の新しい作業名は変更として出る
    api([{ ...row("2026-09-02", "障害対応（夜間含む）", "W-01"), member_id: "M2", member_name: "b" }]);
    const r = await fetchWorklogs({ rootDir: root, asOf: AS_OF, from: "2026-09", to: "2026-09", members: ["M2"], dryRun: true }, ENV);
    expect(r.taskCodeWarnings).toEqual(["作業コード W-01 の作業名が 2026-09-02 から「障害対応_保守対応」→「障害対応（夜間含む）」に変わり、運用保守のキーワードに合わなくなりました"]);
  });

  it("--dry-run は止めずに点検の結果を表示する", async () => {
    quiet();
    setConfig((c) => (c.taskCodeCheck.onUnregistered = "stop"));
    api([row("2026-10-01", "新しい監視_保守対応", "W-09")]);
    const r = await fetchWorklogs({ rootDir: root, asOf: AS_OF, dryRun: true }, ENV);
    const text = formatDryRun(r).join("\n");
    expect(text).toContain("作業コードの点検（1 件）");
    expect(text).toContain("\tW-09");
  });
});
