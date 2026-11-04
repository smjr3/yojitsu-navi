/**
 * 取り込み・データ検証のテスト用のプロジェクト（SPEC §93）。
 * プロジェクトの config.json・data/ は使わない（利用環境では本番の設定・データに入れ替わっているので）。
 * 設定はここで一通り定義し、データは tests/fixtures/project/data/（テスト専用の小さなデータ）を一時フォルダに写す。
 *
 * tests/fixtures/project/data/ はダミーデータ（seed 42・基準日 2026-10-27）から作った固定のもの:
 *   マスタ・案件・対応表などはそのまま、作業実績は 2026-08〜2026-10 の各月 1〜5 日だけ。ダミーデータの生成を変えても作り直さない。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** テスト用のデータ（data/ にあたるフォルダ） */
export const FIXTURE_DATA = join(import.meta.dirname, "project", "data");

/** テスト用の設定（config.json の既定と同じ形。取り込みは CSV、人事取り込みなし） */
export function testConfig(): Record<string, any> {
  return {
    fiscalYearStartMonth: 4,
    standardHoursPerMonth: 160,
    hoursPerBusinessDay: 8,
    burnRateDangerThreshold: 1.0,
    closingBusinessDay: 3,
    forecastMethodDefault: "assignment",
    forecastRecentMonths: 3,
    currency: { code: "JPY", defaultUnit: "millionYen" },
    labels: { customer: "顧客", project: "案件", contract: "契約", team: "チーム", member: "メンバー" },
    worklogSource: {
      adapter: "csv",
      csv: { path: "data/worklogs" },
      http: {
        url: "",
        authHeader: "Authorization",
        refetchMonths: 3,
        columns: { date: "date", memberId: "member_id", memberName: "member_name", customerName: "customer_name", projectName: "project_name", task: "task", hours: "hours" },
      },
    },
    memberSource: {
      adapter: "none",
      csv: { path: "data/hr/members.csv" },
      columns: { memberId: "member_id", name: "name", kind: "kind", title: "title" },
    },
    taskCodeCheck: { include: ["_保守対応"], exclude: [], onUnregistered: "warn", onChange: "warn" },
    costTypes: [{ id: "labor", label: "工数" }],
    masterEdit: { mode: "gitlab", gitlab: { apiBaseUrl: "", projectId: "", targetBranch: "main", commitMode: "mr", tokenUrl: "" } },
  };
}

/**
 * 一時フォルダにテスト用のプロジェクト（config.json と data/）を作る。
 * data: true ならテスト用のデータを写す。false なら空の data/worklogs/ だけ
 */
export function createTestProject(prefix: string, o: { data?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  if (o.data ?? true) cpSync(FIXTURE_DATA, join(root, "data"), { recursive: true });
  else mkdirSync(join(root, "data", "worklogs"), { recursive: true });
  writeFileSync(join(root, "config.json"), JSON.stringify(testConfig(), null, 2));
  return root;
}

/** テスト用のデータのファイル（data/ からの相対パス）の中身 */
export const fixtureText = (path: string) => readFileSync(join(FIXTURE_DATA, path), "utf-8");
