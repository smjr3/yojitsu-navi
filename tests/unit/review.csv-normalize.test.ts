/**
 * レビュー: SPEC §4.1 正規化・§15 CSV の境界ケースの固定（現状の挙動が SPEC どおりであることを固定する）
 */
import { describe, expect, it } from "vitest";
import { parseCsvTable, parseCsvText, parseNumberCell } from "../../src/core/csv.js";
import { normalizeName } from "../../src/core/normalize.js";

describe("§4.1 normalizeName", () => {
  it.each([
    ["（株）さくら製菓", "さくら製菓"],
    ["㈱さくら製菓", "さくら製菓"],
    ["さくら製菓（株）", "さくら製菓"],
    ["Sakura Co., Ltd.", "sakura"],
    ["SAKURA LTD.", "sakura"],
    ["Sakura Inc.", "sakura"],
    ["ＳＡＫＵＲＡ　Ｉｎｃ．", "sakura"],
    ["Sakura Corp.", "sakura"],
    ["Sakura LLC", "sakura"],
    ["株式会社株式会社abc", "abc"],
    ["株式会社 ABC 株式会社", "abc"],
    ["abc株式会社def", "abc株式会社def"], // 中間は残す
    ["青葉物流株式会社 第二営業所", "青葉物流株式会社 第二営業所"],
    ["株式会社", ""],
    ["(株)", ""],
    ["株式会社（株）", ""],
    ["   ", ""],
    ["北斗建設  株式会社", "北斗建設"],
    ["北斗建設　株式会社", "北斗建設"],
    ["ﾃﾞｰﾀ分析基盤運用", "データ分析基盤運用"],
    ["ＥＣサイト保守 ", "ecサイト保守"],
    ["allc", "allc"], // 英字の法人格は単語境界が必要
    ["sakurainc.", "sakurainc."],
  ])("%s → %s", (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });
  it("null / undefined は空文字", () => {
    expect(normalizeName(null)).toBe("");
    expect(normalizeName(undefined)).toBe("");
  });
});

describe("§15 CSV", () => {
  it("BOM 付き・引用符付きヘッダ・CR のみの改行・末尾カンマ", () => {
    const t = parseCsvTable('﻿"date","name"\r2026-01-01,元日,\r2026-01-02,"年末,年始"\r');
    expect(t.header).toEqual(["date", "name"]);
    expect(t.rows.map((r) => [r.row, r.get("date"), r.get("name")])).toEqual([
      [2, "2026-01-01", "元日"],
      [3, "2026-01-02", "年末,年始"],
    ]);
  });
  it("空行・空白だけの行・カンマだけの行は捨てる。無い列は空文字", () => {
    const t = parseCsvTable("a,b\n\n  \n,,\n1,2\n");
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]!.get("zzz")).toBe("");
  });
  it("セル内の BOM（連結ファイル）は trim で消える", () => {
    expect(parseCsvText("a,b\n1,2\n﻿c,d")).toEqual([["a", "b"], ["1", "2"], ["﻿c", "d"]]);
    expect(parseCsvTable("a,b\n﻿c,d").rows[0]!.get("a")).toBe("c");
  });
  it("数値セル: 引用符付き 1,000・全角数字・全角カンマ・指数表記は不可", () => {
    expect(parseCsvTable('n\n"1,000"').rows[0]!.get("n")).toBe("1,000");
    expect(parseNumberCell("1,000")).toBe(1000);
    expect(parseNumberCell("１２３")).toBe(123);
    expect(parseNumberCell("１，０００")).toBe(1000);
    expect(parseNumberCell("0.25")).toBe(0.25);
    expect(parseNumberCell("-5")).toBe(-5);
    expect(parseNumberCell("1e3")).toBeNaN();
    expect(parseNumberCell("")).toBeNaN();
    expect(parseNumberCell("1 000")).toBeNaN();
  });
});
