import { describe, expect, it } from "vitest";
import { normalizeName } from "../../src/core/normalize.js";

describe("normalizeName (SPEC §4.1)", () => {
  it("全角英数を半角にして小文字化する", () => {
    expect(normalizeName("ＡＢＣ")).toBe("abc");
  });

  it("前後の株式会社・(株)・（株）・㈱ を除く（表記違いが同じキーになる）", () => {
    const variants = ["ＡＢＣ株式会社", "abc", "（株）ABC", "(株)ABC", "㈱ABC", "株式会社ABC", "株式会社　ABC", "ABC　株式会社", " abc "];
    for (const v of variants) expect(normalizeName(v), v).toBe("abc");
  });

  it("全角スペースを含む名前は連続空白を半角1つにする", () => {
    expect(normalizeName("株式会社　ＡＢＣ　　商事")).toBe("abc 商事");
    expect(normalizeName("abc \t\n def")).toBe("abc def");
  });

  it("中間の法人格は残す", () => {
    expect(normalizeName("abc株式会社東京")).toBe("abc株式会社東京");
    expect(normalizeName("abc 株式会社 東京")).toBe("abc 株式会社 東京");
  });

  it("有限会社・(有)・㈲・合同会社も除く", () => {
    expect(normalizeName("有限会社ABC")).toBe("abc");
    expect(normalizeName("ABC（有）")).toBe("abc");
    expect(normalizeName("㈲ABC")).toBe("abc");
    expect(normalizeName("合同会社ABC")).toBe("abc");
  });

  it("英語の法人格（Inc. / Co., Ltd. / Ltd. / Corp. / LLC）を除く", () => {
    expect(normalizeName("ABC Inc.")).toBe("abc");
    expect(normalizeName("ABC Co., Ltd.")).toBe("abc");
    expect(normalizeName("ABC Ltd.")).toBe("abc");
    expect(normalizeName("ABC Corp.")).toBe("abc");
    expect(normalizeName("ABC LLC")).toBe("abc");
  });

  it("英語の法人格は単語境界が必要（allc から llc を削らない）", () => {
    expect(normalizeName("allc")).toBe("allc");
    expect(normalizeName("princ.")).toBe("princ.");
  });

  it("複数重なった法人格も前後から繰り返し除く", () => {
    expect(normalizeName("株式会社ABC Inc.")).toBe("abc");
  });

  it("法人格だけの名前は空文字になる", () => {
    expect(normalizeName("株式会社")).toBe("");
    expect(normalizeName("（株）")).toBe("");
  });

  it("空・空白・null・undefined は空文字", () => {
    expect(normalizeName("")).toBe("");
    expect(normalizeName("   ")).toBe("");
    expect(normalizeName("　")).toBe("");
    expect(normalizeName(null)).toBe("");
    expect(normalizeName(undefined)).toBe("");
  });

  it("半角カナは全角カナに統一される", () => {
    expect(normalizeName("ｱｲｳ")).toBe(normalizeName("アイウ"));
  });

  it("冪等である", () => {
    for (const v of ["ＡＢＣ株式会社", "(株) ABC Co., Ltd.", "株式会社", "abc 株式会社 def", "  a   b  "]) {
      const once = normalizeName(v);
      expect(normalizeName(once)).toBe(once);
    }
  });
});
