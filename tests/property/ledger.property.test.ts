/**
 * 期間の置き換え（SPEC §32 replaceRange）のプロパティテスト
 * - 期間の外の月は元のまま、期間の中の月は指定の値（0 なら計画なし）
 * - 結果の行は重ならない。同じ契約・同じ値で接する行は新しい期間の前後で残らない
 * - 同じ置き換えをもう一度しても何も変わらない（冪等）
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addMonths, monthRange } from "../../src/core/calendar.js";
import { replaceRange, type RangeRow, type RangeSegment } from "../../src/core/ledger.js";

const BASE = "2026-01";
const ym = (i: number) => addMonths(BASE, i);
/** 案件の契約: 0〜8 か月目 = C1、9 か月目〜 = C2 */
const contractOf = (m: string) => (m <= ym(8) ? "C1" : "C2");
const segments = (from: string, to: string): RangeSegment[] => {
  const out: RangeSegment[] = [];
  for (const m of monthRange(from, to)) {
    const c = contractOf(m);
    const last = out[out.length - 1];
    if (last && last.contractId === c) last.endMonth = m;
    else out.push({ contractId: c, startMonth: m, endMonth: m });
  }
  return out;
};

/** 重ならない行（契約は月に合わせる） */
const rowsArb = fc
  .array(fc.record({ len: fc.integer({ min: 1, max: 6 }), gap: fc.integer({ min: 0, max: 3 }), v: fc.constantFrom("0.1", "0.2", "0.5", "0.50", "1") }), { maxLength: 5 })
  .map((parts) => {
    const rows: RangeRow[] = [];
    let i = 0;
    parts.forEach((p, k) => {
      i += p.gap;
      // 契約の境目で分ける
      for (const sg of segments(ym(i), ym(i + p.len - 1))) rows.push({ id: `r${k}-${sg.contractId}`, contractId: sg.contractId, startMonth: sg.startMonth, endMonth: sg.endMonth, value: p.v });
      i += p.len;
    });
    return rows;
  });

function applyEdit(rows: RangeRow[], res: ReturnType<typeof replaceRange>): RangeRow[] {
  if (!res.ok) throw new Error(res.reason);
  const out: RangeRow[] = [];
  for (const r of rows) {
    if (res.edit.deletes.includes(r.id)) continue;
    const u = res.edit.updates.get(r.id);
    out.push(u ? { id: r.id, ...u } : r);
  }
  res.edit.adds.forEach((a, i) => out.push({ id: `new${i}-${Math.random()}`, ...a }));
  return out;
}

const valueMap = (rows: RangeRow[]) => {
  const m = new Map<string, string[]>();
  for (const r of rows) for (const x of monthRange(r.startMonth, r.endMonth)) m.set(x, [...(m.get(x) ?? []), `${r.contractId}=${Number(r.value)}`]);
  return m;
};

describe("replaceRange（プロパティ）", () => {
  it("期間の外は元のまま・中は指定の値・重ならない・冪等", () => {
    fc.assert(
      fc.property(rowsArb, fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 8 }), fc.constantFrom("0", "", "0.2", "0.5", "1"), (rows, a, len, value) => {
        const from = ym(a);
        const to = ym(a + len);
        const res = replaceRange(rows, from, to, value, segments);
        expect(res.ok).toBe(true);
        const after = applyEdit(rows, res);
        const before = valueMap(rows);
        const got = valueMap(after);
        for (let i = 0; i < 45; i++) {
          const m = ym(i);
          const g = got.get(m) ?? [];
          // 重ならない
          expect(g.length).toBeLessThanOrEqual(1);
          if (m < from || m > to) expect(g).toEqual(before.get(m) ?? []);
          else expect(g).toEqual(value === "" || Number(value) === 0 ? [] : [`${contractOf(m)}=${Number(value)}`]);
        }
        // 行の期間は正しい向き
        for (const r of after) expect(r.startMonth <= r.endMonth).toBe(true);
        // 冪等: もう一度同じ置き換えをしても変わらない
        const again = replaceRange(after, from, to, value, segments);
        expect(again.ok && again.edit.updates.size + again.edit.deletes.length + again.edit.adds.length).toBe(0);
      }),
      { numRuns: 400 },
    );
  });
});
