/** 候補の絞り込み（SPEC §24.2） */
import { describe, expect, it } from "vitest";
import { filterOptions, normalizeQuery } from "../../src/components/combobox.js";

const opts = [
  { value: "M010", label: "中村 拓也", sub: "インフラ保守チーム ・ 主任", search: "M010" },
  { value: "M011", label: "小林 玲奈", sub: "インフラ保守チーム ・ 主任", search: "M011" },
  { value: "M021", label: "清水 莉子", sub: "クラウド運用チーム ・ 主任", search: "M021" },
  { value: "P001", label: "岡田 浩二", sub: "ネットワーク保守チーム ・ パートナー", search: "P001" },
  { value: "X", label: "ABC保守", sub: "ＡＢＣ商事", search: "" },
];

describe("filterOptions", () => {
  it("空なら全件（元の順）", () => {
    expect(filterOptions(opts, "  ").map((o) => o.value)).toEqual(opts.map((o) => o.value));
  });
  it("名前の一部で引ける（空白の有無を問わない）", () => {
    expect(filterOptions(opts, "中村拓").map((o) => o.value)).toEqual(["M010"]);
    expect(filterOptions(opts, "中村 拓").map((o) => o.value)).toEqual(["M010"]);
  });
  it("補足（所属・役職）と検索語（ID）でも引ける", () => {
    expect(filterOptions(opts, "クラウド").map((o) => o.value)).toEqual(["M021"]);
    expect(filterOptions(opts, "p001").map((o) => o.value)).toEqual(["P001"]);
  });
  it("空白で区切った語はすべて含むもの", () => {
    expect(filterOptions(opts, "インフラ 小林").map((o) => o.value)).toEqual(["M011"]);
    expect(filterOptions(opts, "インフラ 清水")).toEqual([]);
  });
  it("全角・半角、大文字・小文字を区別しない", () => {
    expect(filterOptions(opts, "ａｂｃ").map((o) => o.value)).toEqual(["X"]);
    expect(filterOptions(opts, "abc商事").map((o) => o.value)).toEqual(["X"]);
  });
  it("名前の先頭一致を上に", () => {
    const list = [
      { value: "1", label: "第2保守", sub: "", search: "" },
      { value: "2", label: "保守A", sub: "", search: "" },
      { value: "3", label: "運用", sub: "保守", search: "" },
    ];
    expect(filterOptions(list, "保守").map((o) => o.value)).toEqual(["2", "1", "3"]);
  });
  it("normalizeQuery", () => {
    expect(normalizeQuery("　Ａｂ  c ")).toBe("ab c");
    expect(normalizeQuery(undefined)).toBe("");
  });
  it("数百件でも速い", () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({ value: String(i), label: `案件${i}`, sub: `顧客${i % 50}`, search: `C${i}` }));
    const t = performance.now();
    for (let i = 0; i < 50; i++) filterOptions(many, `顧客${i}`);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
