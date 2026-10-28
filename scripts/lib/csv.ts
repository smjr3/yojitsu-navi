/**
 * CSV の読み書きユーティリティ（Node 側専用）
 *
 * 計算コア（src/core/csv.ts）は文字列→Dataset の変換を担当する。
 * ここでは「文字列 ⇄ 行オブジェクト」の薄い変換だけを置き、
 * アダプタやダミー生成で共通に使う。
 */
import { csvFormat, csvParse } from "d3-dsv";
import type { Worklog } from "../../src/core/types.js";
import { normalizeWorklogDate, parseNumberCell } from "../../src/core/csv.js";

/** 作業実績CSVの列順（docs/DATA.md の定義どおり） */
export const WORKLOG_COLUMNS = [
  "date",
  "member_id",
  "member_name",
  "customer_name",
  "project_name",
  "task",
  "hours",
] as const;

/** Worklog[] → CSV 文字列（ヘッダ付き、UTF-8、改行 LF） */
export function formatWorklogCsv(rows: Worklog[]): string {
  const objs = rows.map((w) => ({
    date: w.date,
    member_id: w.memberId,
    member_name: w.memberName,
    customer_name: w.customerName,
    project_name: w.projectName,
    task: w.task,
    hours: formatHours(w.hours),
  }));
  return csvFormat(objs, [...WORKLOG_COLUMNS]) + "\n";
}

/** CSV 文字列 → Worklog[]（列名は docs/DATA.md のもの。余分な列は無視） */
export function parseWorklogCsv(text: string): Worklog[] {
  const body = stripBom(text);
  if (body.trim() === "") return [];
  const rows = csvParse(body);
  const out: Worklog[] = [];
  for (const r of rows) {
    // 空行・空白だけの行は無視
    if (Object.values(r).every((v) => (v ?? "").trim() === "")) continue;
    out.push({
      date: normalizeWorklogDate((r.date ?? "").trim()),
      memberId: (r.member_id ?? "").trim(),
      memberName: (r.member_name ?? "").trim(),
      customerName: r.customer_name ?? "",
      projectName: r.project_name ?? "",
      task: r.task ?? "",
      hours: parseNumberCell(r.hours ?? ""),
    });
  }
  return out;
}

/** 先頭の BOM を取り除く */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 時間を "7.25" のような最短表記にする（0.1 のような浮動小数の誤差を抑える）。
 * 分・秒単位の API（10 分 = 0.1667h）を行ごとに 0.01h へ丸めると合計がずれるため、小数 4 桁まで残す。
 */
export function formatHours(h: number): string {
  return String(Math.round(h * 10000) / 10000);
}

/** 安定した順序（日付→メンバー→顧客→案件→時間）に並べ替えた新しい配列を返す。生成と取得で共通に使う */
export function sortWorklogs(rows: readonly Worklog[]): Worklog[] {
  return [...rows].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.memberId.localeCompare(b.memberId) ||
      a.customerName.localeCompare(b.customerName) ||
      a.projectName.localeCompare(b.projectName) ||
      a.hours - b.hours ||
      a.task.localeCompare(b.task),
  );
}
