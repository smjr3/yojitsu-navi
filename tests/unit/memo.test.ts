/**
 * 覚えた結果を返す関数（SPEC §129）: normalizeName・isValidISODate は、覚えない計算（〜Uncached）といつも同じ結果を返す。
 * 何回呼んでも・どの順で呼んでも・上限を超えて捨てたあとでも変わらないことを確かめる
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isValidISODate, isValidISODateUncached } from "../../src/core/calendar.js";
import { MEMO_MAX, normalizeName, normalizeNameUncached } from "../../src/core/normalize.js";

const NAMES = ["", " ", "　", "株式会社サンプル", "サンプル株式会社", "㈱サンプル", "(株) サンプル　商事", "ＡＢＣ Co., Ltd.", "abc inc.", "allc", "llc", "株式会社", "ｻﾝﾌﾟﾙ", "Sample  Corp.", "サンプル\t商事\n", "__proto__", "constructor", "undefined", "null"];
const DATES = ["2026-02-28", "2026-02-29", "2028-02-29", "2100-02-29", "2000-02-29", "0000-02-29", "0004-02-29", "0099-12-31", "9999-12-31", "2026-00-10", "2026-13-01", "2026-04-31", "2026-04-00", "2026-4-1", "2026/04/01", "20260401", " 2026-04-01", "2026-04-01 ", "2026-04-01\n", "", "abcd-ef-gh", "２０２６-０４-０１"];

describe("normalizeName は覚えない計算と同じ結果を返す", () => {
  it("代表的な名称: 1 回目も 2 回目以降も同じ", () => {
    for (let round = 0; round < 3; round++) {
      for (const s of NAMES) expect(normalizeName(s)).toBe(normalizeNameUncached(s));
    }
  });

  it("null・undefined・文字列以外も同じ", () => {
    expect(normalizeName(null)).toBe("");
    expect(normalizeName(undefined)).toBe("");
    for (const v of [0, 123, true, false] as unknown as string[]) {
      expect(normalizeName(v)).toBe(normalizeNameUncached(v));
      expect(normalizeName(v)).toBe(normalizeNameUncached(v));
    }
  });

  it("任意の文字列（同じ値を混ぜて何度も呼ぶ）", () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.string(), fc.string({ unit: "grapheme" }), fc.constantFrom(...NAMES)), { maxLength: 30 }), (list) => {
        for (const s of [...list, ...list]) expect(normalizeName(s)).toBe(normalizeNameUncached(s));
      }),
      { numRuns: 300 },
    );
  });

  it("上限を超えて捨てたあとも同じ（捨てる前に覚えた値も、捨てたあとに覚え直す値も）", () => {
    const before = NAMES.map((s) => normalizeName(s));
    for (let i = 0; i < MEMO_MAX + 10; i++) normalizeName(`上限の確認 ${i}`);
    expect(NAMES.map((s) => normalizeName(s))).toEqual(before);
    expect(NAMES.map((s) => normalizeName(s))).toEqual(NAMES.map((s) => normalizeNameUncached(s)));
    expect(normalizeName("上限の確認 0")).toBe(normalizeNameUncached("上限の確認 0"));
  });
});

describe("isValidISODate は覚えない判定と同じ結果を返す", () => {
  it("代表的な日付: 1 回目も 2 回目以降も同じ", () => {
    for (let round = 0; round < 3; round++) {
      for (const s of DATES) expect(isValidISODate(s)).toBe(isValidISODateUncached(s));
    }
  });

  it("文字列以外は false（覚えない）", () => {
    for (const v of [null, undefined, 0, 20260401, true, {}, [], new Date(0)]) {
      expect(isValidISODate(v)).toBe(false);
      expect(isValidISODate(v)).toBe(isValidISODateUncached(v));
    }
  });

  it("すべての年月日の組み合わせ（うるう年の境目を含む年）", () => {
    const pad = (n: number, w: number): string => String(n).padStart(w, "0");
    for (const y of [0, 4, 99, 100, 400, 1900, 2000, 2024, 2025, 2026, 2027, 2028, 2100, 9999]) {
      for (let m = 0; m <= 13; m++) {
        for (let d = 0; d <= 32; d++) {
          const s = `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
          const want = isValidISODateUncached(s);
          expect(isValidISODate(s)).toBe(want);
          expect(isValidISODate(s)).toBe(want);
        }
      }
    }
  });

  it("任意の文字列・日付らしい文字列（同じ値を混ぜて何度も呼ぶ）", () => {
    const dateLike = fc.tuple(fc.integer({ min: 0, max: 9999 }), fc.integer({ min: 0, max: 19 }), fc.integer({ min: 0, max: 39 })).map(([y, m, d]) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.string(), dateLike, fc.constantFrom(...DATES)), { maxLength: 30 }), (list) => {
        for (const s of [...list, ...list]) expect(isValidISODate(s)).toBe(isValidISODateUncached(s));
      }),
      { numRuns: 300 },
    );
  });

  it("上限を超えて捨てたあとも同じ", () => {
    const before = DATES.map((s) => isValidISODate(s));
    for (let i = 0; i < MEMO_MAX + 10; i++) isValidISODate(`x${i}`);
    expect(DATES.map((s) => isValidISODate(s))).toEqual(before);
    expect(DATES.map((s) => isValidISODate(s))).toEqual(DATES.map((s) => isValidISODateUncached(s)));
  });
});
