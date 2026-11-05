/**
 * 正式な案件の一覧の取り込み（SPEC §98）: projects.csv を作り、案件ID のある契約の顧客名・案件名だけをそろえる。
 * テスト用のプロジェクト（tests/fixtures/project.ts。プロジェクトの config.json・data/ は使わない）を一時ディレクトリに作り、
 * global fetch を差し替えたモック API で通しで動かす。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { csvParse } from "d3-dsv";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchProjects, parseArgs, summaryLines } from "../../scripts/fetch-projects.js";
import { createProjectHttpAdapter } from "../../scripts/adapters/projects.js";
import { loadDataset } from "../../scripts/lib/load.js";
import { createTestProject } from "../fixtures/project.js";

const TOKEN = "tok-PROJECT-4242";
const ENV = { PROJECT_API_TOKEN: TOKEN } as NodeJS.ProcessEnv;
const URL_BASE = "https://projects.example.local/api/projects";

let root: string;
beforeEach(() => {
  root = createTestProject("yojitsu-projects-");
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
const contractsPath = () => join(root, "data/contracts.csv");
const readContracts = () => csvParse(readFileSync(contractsPath(), "utf-8"));
const contract = (id: string) => readContracts().find((r) => r.contract_id === id) as Record<string, string>;

/** 取得元の API の行（入れ子の属性で保守・受注を持つ） */
const API_ROWS = [
  { id: "EX-1", customer: { name: "青葉物流株式会社" }, name: "倉庫管理システム保守（正式名）", attrs: { category: "保守", active: true } },
  { id: "EX-2", customer: { name: "みなと銀行" }, name: "勘定系周辺システム保守", attrs: { category: "保守", active: true } },
  { id: "EX-3", customer: { name: "さくら製菓" }, name: "ECサイト保守", attrs: { category: "保守", active: true } },
  { id: "EX-4", customer: { name: "さくら製菓" }, name: "ECサイト保守", attrs: { category: "保守", active: true } },
  // サーバー側で絞れず返ってくる、保守でない・受注していない案件
  { id: "EX-8", customer: { name: "北斗建設" }, name: "基幹システム構築", attrs: { category: "構築", active: true } },
  { id: "EX-9", customer: { name: "北斗建設" }, name: "クラウド基盤運用", attrs: { category: "保守", active: false } },
  { id: "EX-5", customer: { name: "やまびこ通信" }, name: "監視基盤更改", attrs: { category: "保守", active: "true" } },
];

function useHttp(extra: (ps: Record<string, any>) => void = () => {}) {
  setConfig((c) => {
    c.projectSource = {
      adapter: "http",
      http: { url: URL_BASE, authHeader: "Authorization", dataPath: "data" },
      columns: { projectId: "id", customerName: "customer.name", projectName: "name" },
      filters: [
        { column: "attrs.category", equals: "保守" },
        { column: "attrs.active", equals: true },
      ],
    };
    extra(c.projectSource);
  });
}

function api(rows: unknown[], urls: string[] = [], status = 200) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    if (status !== 200) return new Response("error", { status });
    return new Response(JSON.stringify({ data: rows }), { status: 200, headers: { "content-type": "application/json" } });
  });
}

describe("fetch:projects（§98）", () => {
  it("ページングなしで 1 回だけ取り、取得後の filters で絞って projects.csv を作る", async () => {
    useHttp();
    const urls: string[] = [];
    vi.stubGlobal("fetch", api(API_ROWS, urls));
    const r = await fetchProjects({ rootDir: root }, ENV);
    // ページングの設定が無ければ page・per_page などを付けない（付けると 500 になる API がある）
    expect(urls).toEqual([URL_BASE]);
    expect(r.imported).toBe(5);
    const projects = csvParse(readFileSync(join(root, "data/projects.csv"), "utf-8"));
    expect(projects.columns).toEqual(["project_id", "customer_name", "project_name"]);
    expect(projects.map((p) => p.project_id)).toEqual(["EX-1", "EX-2", "EX-3", "EX-4", "EX-5"]);
    // 案件ID の無い契約（今のデータはすべて）は触らない。列も足さない
    expect(r.sync?.changes).toEqual([]);
    expect(readContracts().columns).not.toContain("project_id");
    expect(r.written).toEqual(["data/projects.csv"]);
  });

  it("案件ID のある契約だけ顧客名・案件名を一覧の値にし、期間・金額・担当チーム・メモは触らない", async () => {
    useHttp();
    const text = readFileSync(contractsPath(), "utf-8")
      .replace("contract_id,customer_name", "contract_id,project_id,customer_name")
      .replace(/\n(C\d+),/g, (_m, id: string) => `\n${id},${id === "C001" || id === "C002" ? "EX-1" : id === "C003" ? "EX-404" : ""},`);
    writeFileSync(contractsPath(), text);
    const before = contract("C001");
    vi.stubGlobal("fetch", api(API_ROWS));
    const r = await fetchProjects({ rootDir: root }, ENV);
    const after = contract("C001");
    expect(after.customer_name).toBe("青葉物流株式会社");
    expect(after.project_name).toBe("倉庫管理システム保守（正式名）");
    for (const k of ["team_id", "start_month", "end_month", "total_amount", "note"]) expect(after[k]).toBe(before[k]);
    expect(contract("C002").project_name).toBe("倉庫管理システム保守（正式名）");
    // 一覧に無い案件ID は名前を変えず、検証の警告になる
    expect(contract("C003").customer_name).toBe("みなと銀行");
    expect(r.check?.unknown).toBe(1);
    expect(r.check?.linked).toBe(3);
    const issues = loadDataset(root).issues;
    expect(issues.some((i) => i.code === "PROJECT_ID_UNKNOWN" && i.ref?.contractId === "C003")).toBe(true);
    expect(issues.some((i) => i.code === "PROJECT_NAME_MISMATCH")).toBe(false);
    expect(issues.some((i) => i.severity === "error")).toBe(false);
    // もう一度流しても変わらない（冪等）
    const again = await fetchProjects({ rootDir: root }, ENV);
    expect(again.written).toEqual([]);
  });

  it("見出しの前後に空白があっても、データの読み込みと同じ列として扱う", async () => {
    useHttp();
    const text = readFileSync(contractsPath(), "utf-8")
      .replace("contract_id,customer_name,project_name,", "contract_id, project_id , customer_name , project_name ,")
      .replace(/\n(C001|C002),/g, (_m, id: string) => `\n${id},EX-1,`)
      .replace(/\n(C(?!001|002)\d+),/g, (_m, id: string) => `\n${id},,`);
    writeFileSync(contractsPath(), text);
    vi.stubGlobal("fetch", api(API_ROWS));
    await fetchProjects({ rootDir: root }, ENV);
    expect(readContracts().columns.slice(0, 4)).toEqual(["contract_id", "project_id", "customer_name", "project_name"]);
    expect(contract("C001")).toMatchObject({ project_id: "EX-1", customer_name: "青葉物流株式会社", project_name: "倉庫管理システム保守（正式名）" });
    expect(loadDataset(root).issues.some((i) => i.severity === "error")).toBe(false);
  });

  it("--link-exact は案件名が 1 件だけ同じときだけ案件ID を入れ、複数・なしは保留にする", async () => {
    useHttp();
    vi.stubGlobal("fetch", api(API_ROWS));
    const r = await fetchProjects({ rootDir: root, linkExact: true }, ENV);
    expect(readContracts().columns.slice(0, 2)).toEqual(["contract_id", "project_id"]);
    expect(contract("C003").project_id).toBe("EX-2");
    // 案件名が同じ案件が 2 件（EX-3・EX-4）→ 入れない
    expect(contract("C005").project_id).toBe("");
    expect(r.sync?.ambiguous.find((a) => a.contractId === "C005")?.candidates).toEqual(["EX-3", "EX-4"]);
    // 正式名と違う案件名（倉庫管理システム保守）は照合しない
    expect(contract("C001").project_id).toBe("");
    expect(summaryLines(r).join("\n")).toContain("同じ案件名の案件が複数あるため入れていません");
  });

  it("--id-from-note はメモの案件ID を project_id に移し、メモから消す", async () => {
    useHttp();
    writeFileSync(contractsPath(), readFileSync(contractsPath(), "utf-8").replace("C001,青葉物流,倉庫管理システム保守,T111,2025-04,2026-03,48000000,FY2025", "C001,青葉物流,倉庫管理システム保守,T111,2025-04,2026-03,48000000,FY2025 ID:EX-1"));
    vi.stubGlobal("fetch", api(API_ROWS));
    const r = await fetchProjects({ rootDir: root, idFromNote: "ID:(\\S+)" }, ENV);
    expect(contract("C001").project_id).toBe("EX-1");
    expect(contract("C001").note).toBe("FY2025");
    expect(contract("C001").project_name).toBe("倉庫管理システム保守（正式名）");
    expect(r.sync?.changes.map((c) => c.kind)).toEqual(["linkedFromNote", "renamed"]);
  });

  it("--dry-run は書かずに列の対応表と変更を出す", async () => {
    useHttp();
    const before = readFileSync(contractsPath(), "utf-8");
    vi.stubGlobal("fetch", api(API_ROWS));
    const r = await fetchProjects({ rootDir: root, dryRun: true, linkExact: true, sample: 2 }, ENV);
    expect(existsSync(join(root, "data/projects.csv"))).toBe(false);
    expect(readFileSync(contractsPath(), "utf-8")).toBe(before);
    const out = summaryLines(r).join("\n");
    expect(out).toContain("[dry-run]");
    expect(out).toContain("customer.name");
    expect(out).not.toContain(TOKEN);
  });

  it("失敗・0 件のときは CSV を書き換えず記録し、次に成功すると消える", async () => {
    useHttp();
    writeFileSync(join(root, "data/projects.csv"), "project_id,customer_name,project_name\nEX-1,青葉物流,倉庫管理システム保守\n");
    const before = readFileSync(join(root, "data/projects.csv"), "utf-8");
    const contractsBefore = readFileSync(contractsPath(), "utf-8");
    const adapter = createProjectHttpAdapter({ sleep: async () => {} });
    vi.stubGlobal("fetch", api(API_ROWS, [], 500));
    await expect(fetchProjects({ rootDir: root, adapter }, ENV)).rejects.toThrow(/HTTP 500/);
    expect(readFileSync(join(root, "data/projects.csv"), "utf-8")).toBe(before);
    expect(readFileSync(contractsPath(), "utf-8")).toBe(contractsBefore);
    const meta = JSON.parse(readFileSync(join(root, "data/_projects-meta.json"), "utf-8"));
    expect(meta.lastFailure.message).not.toContain(TOKEN);
    expect(loadDataset(root).issues.find((i) => i.code === "PROJECT_FETCH_FAILED")?.severity).toBe("warning");

    // filters に 1 件も合わない（設定の誤り）も失敗にして、今の一覧を消さない
    vi.stubGlobal("fetch", api(API_ROWS.filter((r) => r.attrs.category === "構築")));
    await expect(fetchProjects({ rootDir: root }, ENV)).rejects.toThrow(/0 件/);
    expect(readFileSync(join(root, "data/projects.csv"), "utf-8")).toBe(before);

    vi.stubGlobal("fetch", api(API_ROWS));
    await fetchProjects({ rootDir: root }, ENV);
    expect(existsSync(join(root, "data/_projects-meta.json"))).toBe(false);
  });

  it("トークン・列の設定が無ければ通信前に止め、adapter none は何もしない", async () => {
    const r = await fetchProjects({ rootDir: root }, ENV);
    expect(r.skipped).toBe(true);
    expect(existsSync(join(root, "data/projects.csv"))).toBe(false);
    useHttp((ps) => delete ps.columns.projectName);
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(fetchProjects({ rootDir: root }, ENV)).rejects.toThrow(/columns.projectName/);
    useHttp();
    await expect(fetchProjects({ rootDir: root }, {})).rejects.toThrow(/PROJECT_API_TOKEN/);
    expect(f).not.toHaveBeenCalled();
  });

  it("列が応答に無ければ列名の一覧つきで止める", async () => {
    useHttp((ps) => (ps.columns.projectId = "project_code"));
    vi.stubGlobal("fetch", api(API_ROWS));
    await expect(fetchProjects({ rootDir: root }, ENV)).rejects.toThrow(/projectId（候補: project_code）/);
  });

  it("引数", () => {
    expect(parseArgs(["--dry-run", "--link-exact", "--id-from-note", "ID:(\\S+)", "--sample=3"])).toMatchObject({ dryRun: true, linkExact: true, idFromNote: "ID:(\\S+)", sample: 3 });
    expect(parseArgs(["--id-from-note=X(\\d+)"]).idFromNote).toBe("X(\\d+)");
    expect(() => parseArgs(["--unknown"])).toThrow(/知らないオプション/);
  });
});
