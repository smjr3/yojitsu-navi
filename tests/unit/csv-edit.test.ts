/**
 * CSV で直接編集（SPEC §25）: docFromCsvText / parseCsvOrTsv
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { docFromCsvText, parseCsvOrTsv } from "../../src/core/csvEdit.js";
import { addRow, diffMasterDoc, parseMasterDoc, serializeMasterDoc, updateRow } from "../../src/core/masterEdit.js";

const RATES = 'key,hourly_rate,effective_from\n本部長,15000,2025-04\n"部長",12000,2025-04\n課長,10000,2025-04\n';
const base = () => parseMasterDoc("rates", RATES);

describe("parseCsvOrTsv", () => {
  it("引用符・セル内の改行・CRLF・BOM", () => {
    const r = parseCsvOrTsv('﻿a,b\r\n"x,1","line1\nline2"\r\n');
    expect(r.table?.rows).toEqual([["x,1", "line1\nline2"]]);
    expect(r.table?.delimiter).toBe(",");
  });
  it("見出しにタブがあればタブ区切り（Excel から貼り付け）", () => {
    const r = parseCsvOrTsv("key\thourly_rate\teffective_from\n部長\t13000\t2026-04\n");
    expect(r.table?.delimiter).toBe("\t");
    expect(r.table?.rows).toEqual([["部長", "13000", "2026-04"]]);
  });
  it("閉じていない引用符は行番号つきのエラー", () => {
    const r = parseCsvOrTsv('a,b\n1,2\n"3,4\n5,6\n');
    expect(r.table).toBeNull();
    expect(r.errors[0]!.line).toBe(3);
  });
  it("空はエラー", () => {
    expect(parseCsvOrTsv(" \n\n").errors[0]!.line).toBeNull();
  });
});

describe("docFromCsvText", () => {
  it("同じ内容なら変更なし（元の引用符のまま書き戻す）", () => {
    const r = docFromCsvText(base(), "key,hourly_rate,effective_from\n本部長,15000,2025-04\n部長,12000,2025-04\n課長,10000,2025-04\n");
    expect(r.errors).toEqual([]);
    expect(diffMasterDoc(r.doc!).count).toBe(0);
    expect(serializeMasterDoc(r.doc!).text).toBe(RATES);
    expect(r.stats).toEqual({ added: 0, changed: 0, removed: 0, unchanged: 3 });
  });
  it("値の変更・追加・削除を元の行に対応付ける", () => {
    const r = docFromCsvText(base(), "key,hourly_rate,effective_from\n本部長,15000,2025-04\n部長,12500,2025-04\n主任,8000,2025-04\n");
    const d = diffMasterDoc(r.doc!);
    expect(d.changed.map((c) => [c.before.key, c.columns])).toEqual([["部長", ["hourly_rate"]]]);
    expect(d.added.map((a) => a.after.key)).toEqual(["主任"]);
    expect(d.removed.map((a) => a.before.key)).toEqual(["課長"]);
  });
  it("列の順序が違っても取り込み、ファイルの列順で書く", () => {
    const r = docFromCsvText(base(), "effective_from\thourly_rate\tkey\n2025-04\t15000\t本部長\n2025-04\t12000\t部長\n2025-04\t10000\t課長\n2026-04\t11000\t課長\n");
    expect(r.delimiter).toBe("\t");
    const d = diffMasterDoc(r.doc!);
    expect(d.count).toBe(1);
    expect(d.added[0]!.after).toEqual({ key: "課長", hourly_rate: "11000", effective_from: "2026-04" });
    expect(serializeMasterDoc(r.doc!).text.endsWith("課長,11000,2026-04\n")).toBe(true);
  });
  it("見出しの誤り（足りない・知らない・重複・空）は取り込まない", () => {
    const e = (t: string) => docFromCsvText(base(), t).errors.map((x) => x.message).join("|");
    expect(e("key,hourly_rate\n部長,1\n")).toContain("effective_from");
    expect(e("key,hourly_rate,effective_from,memo\n")).toContain("memo");
    expect(e("key,key,hourly_rate,effective_from\n")).toContain("2 回");
    expect(e("key,,hourly_rate,effective_from\n")).toContain("空の列名");
    expect(docFromCsvText(base(), "key\n").doc).toBeNull();
  });
  it("前に追加した行は同じ id のまま（追加の数が増えない）", () => {
    let doc = base();
    doc = addRow(doc, { key: "主任", hourly_rate: "8000", effective_from: "2025-04" }).doc;
    const r = docFromCsvText(doc, serializeMasterDoc(doc).text);
    expect(r.stats).toEqual({ added: 0, changed: 0, removed: 0, unchanged: 4 });
    expect(r.doc!.rows.map((x) => x.id)).toEqual(doc.rows.map((x) => x.id));
  });
  it("表で変えた行を CSV で元に戻すと変更なし", () => {
    const doc = updateRow(base(), "o1", { hourly_rate: "99999" });
    const r = docFromCsvText(doc, RATES);
    expect(diffMasterDoc(r.doc!).count).toBe(0);
    expect(r.stats.changed).toBe(1);
  });
  it("性質: 今の内容をそのまま反映しても差分は変わらない（冪等）", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.constantFrom("部長", "課長", "主任", "P001"), fc.integer({ min: 0, max: 99999 }), fc.constantFrom("2025-04", "2026-04")), { maxLength: 8 }), (rows) => {
        let doc = base();
        for (const [k, v, m] of rows) doc = addRow(doc, { key: k, hourly_rate: String(v), effective_from: m }).doc;
        const r = docFromCsvText(doc, serializeMasterDoc(doc).text);
        expect(serializeMasterDoc(r.doc!).text).toBe(serializeMasterDoc(doc).text);
        expect(diffMasterDoc(r.doc!).count).toBe(diffMasterDoc(doc).count);
      }),
      { numRuns: 100 },
    );
  });
});

describe("変更者・変更日の列（§56）", () => {
  const A = "member_id,contract_id,start_month,end_month,allocation,updated_by,updated_at\nM1,C1,2025-04,2025-09,0.5,hanako,2025-04-01\nM2,C1,2025-04,2025-09,0.3,hanako,2025-04-01\n";
  it("列を消して貼っても通し、元の行の値を引き継ぐ（変えていない行は変更なし）", () => {
    const doc = parseMasterDoc("assignments", A);
    const r = docFromCsvText(doc, "member_id,contract_id,start_month,end_month,allocation\nM1,C1,2025-04,2025-09,0.5\nM2,C1,2025-04,2025-09,0.4\nM3,C1,2025-10,2025-10,0.2\n");
    expect(r.errors).toEqual([]);
    expect(r.stats).toEqual({ added: 1, changed: 1, removed: 0, unchanged: 1 });
    expect(serializeMasterDoc(r.doc!).text).toBe(
      "member_id,contract_id,start_month,end_month,allocation,updated_by,updated_at\nM1,C1,2025-04,2025-09,0.5,hanako,2025-04-01\nM2,C1,2025-04,2025-09,0.4,hanako,2025-04-01\nM3,C1,2025-10,2025-10,0.2,,\n",
    );
  });
  it("対象外のファイルでは、無い列はこれまでどおりエラー", () => {
    const r = docFromCsvText(base(), "key,hourly_rate\n部長,12000\n");
    expect(r.errors.length).toBeGreaterThan(0);
  });
});
