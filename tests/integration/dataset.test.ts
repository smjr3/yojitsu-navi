/**
 * ダミー生成 → 読み込み（loadDataset）→ 検証（validate-data）→ 取得スクリプト（fetch-worklogs）の結合テスト
 * 一時ディレクトリに生成するので、リポジトリの data/ は触らない
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate, writeDummy } from "../../scripts/generate-dummy.js";
import { loadDataset, readDatasetFiles } from "../../scripts/lib/load.js";
import { runValidation } from "../../scripts/validate-data.js";
import { fetchWorklogs, recentMonths } from "../../scripts/fetch-worklogs.js";

const REPO = join(import.meta.dirname, "..", "..");

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "yojitsu-data-"));
  cpSync(join(REPO, "config.json"), join(root, "config.json"));
  writeDummy({ seed: 42, asOf: "2026-10-27", outDir: join(root, "data") });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("generate-dummy", () => {
  it("同じ seed なら同じ出力（決定的）", () => {
    const a = generate({ seed: 7, asOf: "2025-06-30" });
    const b = generate({ seed: 7, asOf: "2025-06-30" });
    expect([...a.worklogsByMonth.entries()]).toEqual([...b.worklogsByMonth.entries()]);
    const c = generate({ seed: 8, asOf: "2025-06-30" });
    expect([...c.worklogsByMonth.values()].flat()).not.toEqual([...a.worklogsByMonth.values()].flat());
  });

  it("asOf までの平日・非祝日だけに作業実績がある", () => {
    const g = generate({ seed: 42, asOf: "2025-05-15" });
    const months = [...g.worklogsByMonth.keys()].sort();
    expect(months).toEqual(["2025-04", "2025-05"]);
    const holidays = new Set(g.holidays.map((h) => h.date));
    for (const w of [...g.worklogsByMonth.values()].flat()) {
      expect(w.date <= "2025-05-15").toBe(true);
      const dow = new Date(w.date + "T00:00:00Z").getUTCDay();
      expect(dow).not.toBe(0);
      expect(dow).not.toBe(6);
      expect(holidays.has(w.date)).toBe(false);
    }
  });

  it("祝日に振替休日・国民の休日・会社休日が含まれる", () => {
    const g = generate({ seed: 1, asOf: "2025-04-01" });
    const byDate = new Map(g.holidays.map((h) => [h.date, h.name]));
    expect(byDate.get("2025-05-06")).toBe("振替休日");
    expect(byDate.get("2026-09-22")).toBe("国民の休日");
    expect(byDate.get("2027-03-22")).toBe("振替休日");
    expect(byDate.get("2026-01-01")).toBe("元日");
    expect(byDate.get("2026-01-02")).toBe("年末年始休暇");
    expect(byDate.get("2026-08-14")).toBe("夏季休暇");
  });
});

describe("loadDataset / validate", () => {
  it("生成データを読み込める（作業実績・メタ情報込み）", () => {
    const { dataset, issues } = loadDataset(root);
    expect(dataset.contracts.length).toBeGreaterThanOrEqual(14);
    // 実運用規模（基本シナリオ約 1.8 万行の約 5 倍。docs/DUMMY_DATA.md）
    expect(dataset.worklogs.length).toBeGreaterThan(80000);
    expect(dataset.worklogs.length).toBeLessThan(130000);
    expect(dataset.worklogFetchedAt).toBe("2026-10-27T09:00:00+09:00");
    expect(dataset.holidays.some((h) => h.date === "2026-09-22")).toBe(true);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("検証はエラー 0 件で、狙った警告が出る", () => {
    const report = runValidation(root);
    expect(report.errors).toEqual([]);
    const codes = new Set(report.warnings.map((w) => w.code));
    expect(codes.has("UNKNOWN_MEMBER")).toBe(true);
    expect(codes.has("RATE_MISSING")).toBe(true);
    expect(codes.has("UNMAPPED_WORKLOG")).toBe(true);
    expect(codes.has("EXCLUDED_NO_CUSTOMER")).toBe(true);
    expect(report.text).toContain("結果: OK");
  });

  it("worklogs ディレクトリが無くても落ちない", () => {
    const empty = mkdtempSync(join(tmpdir(), "yojitsu-empty-"));
    try {
      cpSync(join(REPO, "config.json"), join(empty, "config.json"));
      cpSync(join(root, "data"), join(empty, "data"), { recursive: true });
      rmSync(join(empty, "data", "worklogs"), { recursive: true, force: true });
      const files = readDatasetFiles(empty);
      expect(files.worklogs).toEqual([]);
      expect(files.worklogFetchedAt).toBeUndefined();
      const { dataset } = loadDataset(empty);
      expect(dataset.worklogs).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("壊れた契約（期間逆転）はエラーになる", () => {
    const broken = mkdtempSync(join(tmpdir(), "yojitsu-broken-"));
    try {
      cpSync(join(REPO, "config.json"), join(broken, "config.json"));
      cpSync(join(root, "data"), join(broken, "data"), { recursive: true });
      const p = join(broken, "data", "contracts.csv");
      writeFileSync(p, readFileSync(p, "utf-8") + "C999,壊れた契約,テスト,T111,2026-12,2026-01,1000,\n");
      const report = runValidation(broken);
      expect(report.errors.length).toBeGreaterThan(0);
      expect(report.text).toContain("結果: NG");
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});

describe("fetch-worklogs", () => {
  it("recentMonths は基準日を含む直近 n か月（年またぎ）", () => {
    expect(recentMonths("2026-01-15", 3)).toEqual(["2025-11", "2025-12", "2026-01"]);
    expect(recentMonths("2026-10-27", 1)).toEqual(["2026-10"]);
  });

  it("dummy アダプタで直近3か月だけ書き換え、他の月は触らない。冪等", async () => {
    const work = mkdtempSync(join(tmpdir(), "yojitsu-fetch-"));
    try {
      cpSync(join(REPO, "config.json"), join(work, "config.json"));
      mkdirSync(join(work, "data", "worklogs"), { recursive: true });
      const before = readFileSync(join(root, "data", "worklogs", "2026-07.csv"), "utf-8");
      writeFileSync(join(work, "data", "worklogs", "2026-07.csv"), "date,member_id,member_name,customer_name,project_name,task,hours\n2026-07-01,X,X,X,X,X,1\n");
      const fixedNow = () => new Date("2026-10-27T01:00:00Z");
      const r1 = await fetchWorklogs({ rootDir: work, asOf: "2026-10-27", adapter: "dummy" }, { DUMMY_SEED: "42" }, fixedNow);
      expect(r1.months).toEqual(["2026-08", "2026-09", "2026-10"]);
      for (const m of r1.months) {
        expect(readFileSync(join(work, "data", "worklogs", `${m}.csv`), "utf-8")).toBe(readFileSync(join(root, "data", "worklogs", `${m}.csv`), "utf-8"));
      }
      // 対象外の月は手で置いた内容のまま
      expect(readFileSync(join(work, "data", "worklogs", "2026-07.csv"), "utf-8")).not.toBe(before);
      expect(readFileSync(join(work, "data", "worklogs", "2026-07.csv"), "utf-8")).toContain("2026-07-01,X");
      const meta1 = JSON.parse(readFileSync(join(work, "data", "worklogs", "_meta.json"), "utf-8")) as { fetchedAt: string; adapter: string };
      expect(meta1).toMatchObject({ fetchedAt: "2026-10-27T01:00:00.000Z", adapter: "dummy" });

      // もう一度実行しても同じ内容（冪等）
      const snapshot = r1.months.map((m) => readFileSync(join(work, "data", "worklogs", `${m}.csv`), "utf-8"));
      await fetchWorklogs({ rootDir: work, asOf: "2026-10-27", adapter: "dummy" }, { DUMMY_SEED: "42" }, fixedNow);
      expect(r1.months.map((m) => readFileSync(join(work, "data", "worklogs", `${m}.csv`), "utf-8"))).toEqual(snapshot);
      expect(existsSync(join(work, "data", "worklogs", "2026-06.csv"))).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("csv アダプタはパススルー（既存ファイルを読み返すだけ）", async () => {
    const work = mkdtempSync(join(tmpdir(), "yojitsu-csv-"));
    try {
      cpSync(join(REPO, "config.json"), join(work, "config.json"));
      cpSync(join(root, "data"), join(work, "data"), { recursive: true });
      const original = readFileSync(join(work, "data", "worklogs", "2026-10.csv"), "utf-8");
      await fetchWorklogs({ rootDir: work, asOf: "2026-10-27", adapter: "csv" }, {}, () => new Date("2026-10-27T01:00:00Z"));
      expect(readFileSync(join(work, "data", "worklogs", "2026-10.csv"), "utf-8")).toBe(original);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
