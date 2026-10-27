/**
 * マスタ編集（SPEC §19.1）のプロパティテスト
 * - CSV 書き出し → 再読み込みで同じ値
 * - 変更していない行はバイト単位で元のまま
 * - 任意の編集列で差分（変わった列・追加・削除）が正しい
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseCsvText } from "../../src/core/csv.js";
import {
  MASTER_FILES,
  addRow,
  deleteRow,
  diffMasterDoc,
  parseMasterDoc,
  rowState,
  serializeMasterDoc,
  splitCsvRecords,
  updateRow,
  type MasterDoc,
} from "../../src/core/masterEdit.js";

const HEADER = MASTER_FILES.members.columns.map((c) => c.name);
const W = HEADER.length;

/** カンマ・引用符・改行・空白・全角を含みうるセル */
const cellArb = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.constantFrom("", ",", '"', '""', "\n", "\r\n", "a,b", 'x"y', " 前後 ", "第1\n事業部", "株式会社テスト", "2026-04"),
  fc.array(fc.constantFrom("a", ",", '"', "\n", "\r", " ", "あ"), { maxLength: 6 }).map((a) => a.join("")),
);
const rowArb = fc.array(cellArb, { minLength: W, maxLength: W }).filter((cells) => cells.some((c) => c.trim() !== ""));

/** 元ファイルの書き方の揺れ: 不要な引用符を付ける／付けない、改行 CRLF/LF、BOM、末尾改行 */
function writeOriginal(rows: string[][], style: { quoteAll: boolean[]; crlf: boolean; bom: boolean; trailing: boolean }): string {
  const q = (c: string, force: boolean) => (force || /[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  const lines = [HEADER.join(","), ...rows.map((r, i) => r.map((c) => q(c, style.quoteAll[i % Math.max(1, style.quoteAll.length)] ?? false)).join(","))];
  const nl = style.crlf ? "\r\n" : "\n";
  return (style.bom ? "﻿" : "") + lines.join(nl) + (style.trailing ? nl : "");
}
const styleArb = fc.record({ quoteAll: fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }), crlf: fc.boolean(), bom: fc.boolean(), trailing: fc.boolean() });

type Op = { kind: "update"; row: number; col: number; value: string } | { kind: "add"; cells: string[] } | { kind: "delete"; row: number };
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("update" as const), row: fc.nat(), col: fc.nat({ max: W - 1 }), value: cellArb }),
  fc.record({ kind: fc.constant("add" as const), cells: rowArb }),
  fc.record({ kind: fc.constant("delete" as const), row: fc.nat() }),
);

/** 操作を順に適用する（update は入力値の trim が入るので、期待値も trim 後で持つ） */
function apply(doc: MasterDoc, ops: Op[]): MasterDoc {
  let d = doc;
  for (const op of ops) {
    if (d.rows.length === 0 && op.kind !== "add") continue;
    if (op.kind === "update") {
      const row = d.rows[op.row % d.rows.length]!;
      d = updateRow(d, row.id, { [HEADER[op.col]!]: op.value });
    } else if (op.kind === "add") {
      d = addRow(d, Object.fromEntries(HEADER.map((h, i) => [h, op.cells[i]!]))).doc;
    } else {
      d = deleteRow(d, d.rows[op.row % d.rows.length]!.id);
    }
  }
  return d;
}

describe("CSV 書き出し → 再読み込み", () => {
  it("書き出したテキストを core の parseCsvText で読むと、各行のセルが文書の値と一致（空行は除く）", () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 8 }), styleArb, fc.array(opArb, { maxLength: 10 }), (rows, style, ops) => {
        const doc = apply(parseMasterDoc("members", writeOriginal(rows, style)), ops);
        const out = serializeMasterDoc(doc);
        const parsed = parseCsvText(out.text);
        expect(parsed[0]).toEqual(HEADER);
        const expected = doc.rows.filter((r) => r.cells.some((c) => c.trim() !== "")).map((r) => r.cells);
        expect(parsed.slice(1)).toEqual(expected);
        expect(out.rowIds).toHaveLength(expected.length);
        // LF・BOM なし・末尾改行 1 つ（行の中の改行は引用符の中だけ）
        expect(out.text.charCodeAt(0)).not.toBe(0xfeff);
        expect(out.text.endsWith("\n")).toBe(true);
        // もう一度読み込んで書き出すと同じ（冪等）
        expect(serializeMasterDoc(parseMasterDoc("members", out.text)).text).toBe(out.text);
      }),
      { numRuns: 300 },
    );
  });

  it("編集しなければ、元テキストの各レコードはそのまま（LF に揃える以外は同じ）", () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 8 }), styleArb, (rows, style) => {
        const text = writeOriginal(rows, style);
        const out = serializeMasterDoc(parseMasterDoc("members", text)).text;
        expect(out).toBe(splitCsvRecords(text).map((r) => r.raw).join("\n") + "\n");
        if (!style.crlf && !style.bom && style.trailing) expect(out).toBe(text);
      }),
      { numRuns: 300 },
    );
  });
});

describe("未変更行のバイト保持", () => {
  it("任意の編集のあと、値が元と同じ行は元のレコードのテキストで書き出される", () => {
    fc.assert(
      fc.property(fc.array(rowArb, { minLength: 1, maxLength: 8 }), styleArb, fc.array(opArb, { maxLength: 10 }), (rows, style, ops) => {
        const text = writeOriginal(rows, style);
        const base = parseMasterDoc("members", text);
        const doc = apply(base, ops);
        const out = serializeMasterDoc(doc);
        const outRecords = splitCsvRecords(out.text).slice(1);
        out.rowIds.forEach((id, i) => {
          const row = doc.rows.find((r) => r.id === id)!;
          if (rowState(doc, row) === "unchanged") expect(outRecords[i]!.raw).toBe(base.originals[id]!.raw);
        });
        // 元の行の相対順は変わらない（追加行は末尾）
        const origOrder = out.rowIds.filter((id) => id.startsWith("o")).map((id) => base.originals[id]!.index);
        expect(origOrder).toEqual([...origOrder].sort((a, b) => a - b));
      }),
      { numRuns: 300 },
    );
  });
});

describe("差分", () => {
  it("任意の編集列で、changed の columns = 値が変わった列、added = 追加行（空行除く）、removed = 消えた元行", () => {
    fc.assert(
      fc.property(fc.array(rowArb, { minLength: 1, maxLength: 8 }), fc.array(opArb, { maxLength: 12 }), (rows, ops) => {
        const base = parseMasterDoc("members", writeOriginal(rows, { quoteAll: [false], crlf: false, bom: false, trailing: true }));
        const doc = apply(base, ops);
        const d = diffMasterDoc(doc);
        const present = new Set(doc.rows.map((r) => r.id));
        expect(d.removed.map((r) => r.rowId).sort()).toEqual(Object.keys(base.originals).filter((id) => !present.has(id)).sort());
        expect(d.added.map((a) => a.rowId)).toEqual(doc.rows.filter((r) => !base.originals[r.id] && r.cells.some((c) => c.trim() !== "")).map((r) => r.id));
        for (const row of doc.rows) {
          const o = base.originals[row.id];
          if (!o) continue;
          const cols = HEADER.filter((_, i) => o.cells[i] !== row.cells[i]);
          const hit = d.changed.find((c) => c.rowId === row.id);
          if (cols.length === 0) expect(hit).toBeUndefined();
          else {
            expect(hit!.columns).toEqual(cols);
            for (const c of cols) {
              expect(hit!.before[c]).toBe(o.cells[HEADER.indexOf(c)]);
              expect(hit!.after[c]).toBe(row.cells[HEADER.indexOf(c)]);
            }
          }
        }
        expect(d.count).toBe(d.added.length + d.changed.length + d.removed.length);
      }),
      { numRuns: 300 },
    );
  });
});
