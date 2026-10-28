/**
 * データ検証（CI で止める）
 *
 *   npm run validate            # data/ を検証。error が1件でもあれば終了コード 1
 *   npx tsx scripts/validate-data.ts --root path/to/repo
 *
 * 読み込み（scripts/lib/load.ts → src/core/csv.ts parseDataset）で見つかった問題と、
 * src/core/validate.ts validateDataset の結果を、重要度→ファイル順にまとめて表示する。
 * warning（未紐付け工数・単価なし等）は表示するだけで止めない。
 */
import { fileURLToPath } from "node:url";
import type { ValidationIssue } from "../src/core/validate.js";
import { loadDataset } from "./lib/load.js";

export interface Report {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  text: string;
}

/** 同じ内容の問題（parseDataset と validateDataset の両方が報告するもの）をまとめる */
function dedupe(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  const out: ValidationIssue[] = [];
  for (const i of issues) {
    const key = `${i.severity}|${i.code}|${i.file ?? ""}|${i.row ?? ""}|${i.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  return out;
}

function groupByFile(issues: ValidationIssue[]): Map<string, ValidationIssue[]> {
  const map = new Map<string, ValidationIssue[]>();
  for (const i of issues) {
    const f = i.file ?? "(全体)";
    let list = map.get(f);
    if (!list) map.set(f, (list = []));
    list.push(i);
  }
  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function formatIssue(i: ValidationIssue): string {
  const row = i.row !== undefined ? ` ${i.row}行目` : "";
  return `  - [${i.code}]${row} ${i.message}`;
}

export function buildReport(issues: ValidationIssue[], summary: { contracts: number; members: number; worklogs: number }): Report {
  const all = dedupe(issues);
  const errors = all.filter((i) => i.severity === "error");
  const warnings = all.filter((i) => i.severity === "warning");
  const lines: string[] = [];
  lines.push("== 予実ナビ データ検証 ==");
  lines.push(`契約 ${summary.contracts} 件 / メンバー ${summary.members} 行 / 作業実績 ${summary.worklogs} 行`);
  lines.push("");

  const section = (title: string, list: ValidationIssue[]) => {
    lines.push(`${title}: ${list.length} 件`);
    for (const [file, items] of groupByFile(list)) {
      lines.push(` ${file}`);
      for (const i of items) lines.push(formatIssue(i));
    }
    lines.push("");
  };
  section("エラー（CI を止めます）", errors);
  section("警告（表示のみ）", warnings);
  lines.push(errors.length === 0 ? "結果: OK（エラーなし）" : `結果: NG（エラー ${errors.length} 件）`);
  return { errors, warnings, text: lines.join("\n") };
}

export function runValidation(rootDir: string): Report {
  // parseDataset（loadDataset）は validateDataset の結果も含む（壊れたファイル起因の大量のエラーは除いた上で）。
  // ここで validateDataset をもう一度かけると、同じ問題が文面違いで二重に出て、除いたエラーも戻ってしまう
  const { dataset, issues } = loadDataset(rootDir);
  return buildReport(issues, {
    contracts: dataset.contracts.length,
    members: dataset.members.length,
    worklogs: dataset.worklogs.length,
  });
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const idx = process.argv.indexOf("--root");
  const rootDir = idx >= 0 && process.argv[idx + 1] ? (process.argv[idx + 1] as string) : process.cwd();
  try {
    const report = runValidation(rootDir);
    console.log(report.text);
    process.exit(report.errors.length > 0 ? 1 : 0);
  } catch (e) {
    console.error(`検証を実行できませんでした: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exit(1);
  }
}
