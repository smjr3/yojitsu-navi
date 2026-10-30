/**
 * 表の列ごとの絞り込み（SPEC §67）の判定: 値の一覧・検索語・数値の範囲
 */
import { describe, expect, it } from "vitest";
import { matchesFilter } from "../../src/components/table.js";

const text = { key: "task", label: "作業内容", type: "text" };
const money = { key: "budget", label: "予算", type: "money" };
const status = { key: "status", label: "状態", type: "status", get: (r: any) => r.chips };

describe("matchesFilter", () => {
  it("絞り込みなしは常に通す", () => {
    expect(matchesFilter(text, null, { task: "テスト" }, "m")).toBe(true);
  });

  it("値の一覧: 選んだ値だけ通し、空は（空白）として選べる", () => {
    const f = { q: "", values: ["テスト", ""] };
    expect(matchesFilter(text, f, { task: "テスト" }, "m")).toBe(true);
    expect(matchesFilter(text, f, { task: "改修" }, "m")).toBe(false);
    expect(matchesFilter(text, f, { task: "" }, "m")).toBe(true);
    expect(matchesFilter(text, f, { task: null }, "m")).toBe(true);
  });

  it("検索語は部分一致で、全角・半角と大文字・小文字を区別しない", () => {
    expect(matchesFilter(text, { q: "ｐｏｓ" }, { task: "POS改修" }, "m")).toBe(true);
    expect(matchesFilter(text, { q: "2026-10" }, { task: "2026-10-03" }, "m")).toBe(true);
    expect(matchesFilter(text, { q: "保守" }, { task: "POS改修" }, "m")).toBe(false);
  });

  it("状態列はチップのどれかが選んだ値なら通す", () => {
    const row = { chips: [{ kind: "danger", text: "超過見込み" }, { kind: "danger", text: "消化率超過" }] };
    expect(matchesFilter(status, { values: ["消化率超過"] }, row, "m")).toBe(true);
    expect(matchesFilter(status, { values: ["問題なし"] }, row, "m")).toBe(false);
  });

  it("数値の範囲は元の値（円）で比べ、端を含む。値が無い行は外す", () => {
    const f = { min: 10_000_000, max: 20_000_000 };
    expect(matchesFilter(money, f, { budget: 10_000_000 }, "m")).toBe(true);
    expect(matchesFilter(money, f, { budget: 20_000_000 }, "m")).toBe(true);
    expect(matchesFilter(money, f, { budget: 9_999_999 }, "m")).toBe(false);
    expect(matchesFilter(money, f, { budget: null }, "m")).toBe(false);
    expect(matchesFilter(money, { min: -5_000_000 }, { budget: -1 }, "m")).toBe(true);
    expect(matchesFilter(money, { max: 0 }, { budget: 1 }, "m")).toBe(false);
  });

  it("filterValue を指定した列はその値で絞る", () => {
    const col = { ...text, filterValue: (r: any) => [r.a, r.b] };
    expect(matchesFilter(col, { values: ["B"] }, { a: "A", b: "B" }, "m")).toBe(true);
  });
});
