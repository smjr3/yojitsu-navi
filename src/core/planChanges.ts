/**
 * 保存前の変更内容の要約（リソース計画。SPEC §117）
 *
 * CSV の行の差分（期間を分けた 3 行など）ではなく、「誰の・どの作業の・何月が・何人月 → 何人月」で見せる。
 * 編集前と編集後の全行から、人 × 作業 × 月の人月を足し上げて比べる（行の分け方が変わっても、月の値が同じなら変更なし）。
 */
import { addMonths, isValidYearMonth, monthRange } from "./calendar.js";
import { parseNumberCell } from "./csv.js";
import type { YearMonth } from "./types.js";
import type { MasterDoc } from "./masterEdit.js";
import { rowRecord, diffMasterDoc } from "./masterEdit.js";

export interface PlanChangeRun {
  from: YearMonth;
  to: YearMonth;
  /** 編集前・編集後の人月（その月の行の合計。行が無ければ 0） */
  before: number;
  after: number;
}
export interface PlanChange {
  memberId: string;
  /** 作業（アサインは案件 ID、運用保守以外は種別） */
  target: string;
  runs: PlanChangeRun[];
}

/** 人月の比較は小数第 4 位で丸める（0.1 + 0.2 などの誤差で「変更あり」にしない） */
const round = (v: number): number => Math.round(v * 10000) / 10000;

function monthlyOf(records: ReadonlyArray<Record<string, string>>, targetCol: string, valueCol: string, keys: ReadonlySet<string>): Map<string, Map<YearMonth, number>> {
  const out = new Map<string, Map<YearMonth, number>>();
  for (const r of records) {
    const key = `${(r.member_id ?? "").trim()}\u0000${(r[targetCol] ?? "").trim()}`;
    if (!keys.has(key)) continue;
    const from = (r.start_month ?? "").trim();
    const to = (r.end_month ?? "").trim();
    // 数値・年月の読み方は計算・計画の画面と同じ（全角の数字も読む。月が 13 などの誤りは数えず、検証の一覧に任せる）
    const v = parseNumberCell(r[valueCol] ?? "");
    if (!isValidYearMonth(from) || !isValidYearMonth(to) || from > to || !Number.isFinite(v)) continue;
    let m = out.get(key);
    if (!m) out.set(key, (m = new Map()));
    for (const month of monthRange(from as YearMonth, to as YearMonth)) m.set(month, round((m.get(month) ?? 0) + v));
  }
  return out;
}

/**
 * リソース計画のファイル（assignments / outside）の変更を、人 × 作業ごとの月の人月の変化にまとめる。
 * 続いた月で前後の値が同じものは 1 つ（from〜to）にまとめる。並びは変更のあった行の順。
 */
export function planChangeSummary(doc: MasterDoc, { targetCol, valueCol }: { targetCol: string; valueCol: string }): PlanChange[] {
  const diff = diffMasterDoc(doc);
  if (diff.count === 0) return [];
  const keyOf = (r: Record<string, string>) => `${(r.member_id ?? "").trim()}\u0000${(r[targetCol] ?? "").trim()}`;
  const order: string[] = [];
  const keys = new Set<string>();
  const touch = (r: Record<string, string>) => {
    const k = keyOf(r);
    if (!keys.has(k)) {
      keys.add(k);
      order.push(k);
    }
  };
  for (const c of diff.changed) {
    touch(c.before);
    touch(c.after);
  }
  for (const a of diff.added) touch(a.after);
  for (const r of diff.removed) touch(r.before);
  const beforeRecords = Object.values(doc.originals).map((o) => rowRecord(doc, { cells: o.cells }));
  const afterRecords = doc.rows.map((r) => rowRecord(doc, r));
  const before = monthlyOf(beforeRecords, targetCol, valueCol, keys);
  const after = monthlyOf(afterRecords, targetCol, valueCol, keys);
  const out: PlanChange[] = [];
  for (const key of order) {
    const b = before.get(key) ?? new Map<YearMonth, number>();
    const a = after.get(key) ?? new Map<YearMonth, number>();
    const months = [...new Set([...b.keys(), ...a.keys()])].sort();
    const runs: PlanChangeRun[] = [];
    let prev: YearMonth | null = null;
    for (const month of months) {
      const bv = b.get(month) ?? 0;
      const av = a.get(month) ?? 0;
      if (bv === av) {
        prev = null;
        continue;
      }
      const last = runs[runs.length - 1];
      const next: YearMonth | null = prev ? addMonths(prev, 1) : null;
      if (last && prev && next === month && last.before === bv && last.after === av) last.to = month;
      else runs.push({ from: month, to: month, before: bv, after: av });
      prev = month;
    }
    if (runs.length === 0) continue;
    const [memberId, target] = key.split("\u0000") as [string, string];
    out.push({ memberId, target, runs });
  }
  return out;
}
