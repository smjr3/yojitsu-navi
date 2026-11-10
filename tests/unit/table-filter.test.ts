/**
 * 表の列ごとの絞り込み（SPEC §70）の判定: 値の一覧・検索語・数値の範囲
 */
import { describe, expect, it } from "vitest";
import { matchesFilter, parseDateFilterInput, treeFilteredRows } from "../../src/components/table.js";

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
    // 印が無い行（空の配列）は（空白）で選べる
    expect(matchesFilter(status, { values: [""] }, { chips: [] }, "m")).toBe(true);
    expect(matchesFilter(status, { values: [""] }, row, "m")).toBe(false);
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

describe("日付・年月の絞り込み（以降〜以前。SPEC §109）", () => {
  const date = { key: "date", label: "日付", type: "text" };
  const month = { key: "month", label: "月", type: "text" };
  const period = { key: "p", label: "期間", type: "text", dateValue: (r: any) => [r.from, r.to] };

  it("入力は年・年月・日のどれでも読み、形を揃える。読めないものは undefined、空は null", () => {
    expect(parseDateFilterInput("")).toBe(null);
    expect(parseDateFilterInput(" ")).toBe(null);
    expect(parseDateFilterInput("2031")).toBe("2031");
    expect(parseDateFilterInput("２０３１年")).toBe("2031");
    expect(parseDateFilterInput("2031-4")).toBe("2031-04");
    expect(parseDateFilterInput("2031/04")).toBe("2031-04");
    expect(parseDateFilterInput("2031年4月")).toBe("2031-04");
    expect(parseDateFilterInput("203104")).toBe("2031-04");
    expect(parseDateFilterInput("2031/4/5")).toBe("2031-04-05");
    expect(parseDateFilterInput("2031年4月5日")).toBe("2031-04-05");
    expect(parseDateFilterInput("20310405")).toBe("2031-04-05");
    expect(parseDateFilterInput("2031-13")).toBe(undefined);
    expect(parseDateFilterInput("2031-02-30")).toBe(undefined);
    expect(parseDateFilterInput("2032-02-29")).toBe("2032-02-29");
    expect(parseDateFilterInput("4月")).toBe(undefined);
  });

  it("年・年月で入れると、その年・月を丸ごと含める（以降はその始まりから、以前はその終わりまで）", () => {
    expect(matchesFilter(date, { from: "2031-04" }, { date: "2031-04-01" }, "m")).toBe(true);
    expect(matchesFilter(date, { from: "2031-04" }, { date: "2031-03-31" }, "m")).toBe(false);
    expect(matchesFilter(date, { to: "2031-04" }, { date: "2031-04-30" }, "m")).toBe(true);
    expect(matchesFilter(date, { to: "2031-04" }, { date: "2031-05-01" }, "m")).toBe(false);
    expect(matchesFilter(date, { from: "2031", to: "2031" }, { date: "2031-12-31" }, "m")).toBe(true);
    expect(matchesFilter(date, { from: "2031", to: "2031" }, { date: "2032-01-01" }, "m")).toBe(false);
    expect(matchesFilter(date, { from: "2031-04-10", to: "2031-04-10" }, { date: "2031-04-10" }, "m")).toBe(true);
    expect(matchesFilter(date, { from: "2031-04-10" }, { date: "2031-04-09" }, "m")).toBe(false);
  });

  it("年月の列は、その月が範囲に掛かれば残す。日付が無い行は外す", () => {
    expect(matchesFilter(month, { from: "2031-04-15" }, { month: "2031-04" }, "m")).toBe(true);
    expect(matchesFilter(month, { to: "2031-03" }, { month: "2031-04" }, "m")).toBe(false);
    expect(matchesFilter(month, { from: "2031" }, { month: "" }, "m")).toBe(false);
    expect(matchesFilter(month, { from: "2031" }, { month: null }, "m")).toBe(false);
  });

  it("期間の列は範囲と重なれば残す", () => {
    const row = { from: "2031-04", to: "2032-03" };
    expect(matchesFilter(period, { from: "2032", to: "2032" }, row, "m")).toBe(true);
    expect(matchesFilter(period, { from: "2032-04" }, row, "m")).toBe(false);
    expect(matchesFilter(period, { to: "2031-03" }, row, "m")).toBe(false);
    expect(matchesFilter(period, { to: "2031-04" }, row, "m")).toBe(true);
  });
});

describe("treeFilteredRows（木構造の表の絞り込み）", () => {
  const rows = [
    { key: "D1", parentKey: null, name: "第1部" },
    { key: "S11", parentKey: "D1", name: "第1課" },
    { key: "T111", parentKey: "S11", name: "Web保守" },
    { key: "T112", parentKey: "S11", name: "基盤" },
    { key: "S12", parentKey: "D1", name: "第2課" },
    { key: "D2", parentKey: null, name: "第2部" },
  ];
  const pick = (...keys: string[]) => rows.filter((r) => keys.includes(r.key));

  it("一致した行と祖先を元の並びで残し、子の残る行を返す", () => {
    let matched: Set<string> = new Set();
    let parents: Set<string> = new Set();
    const out = treeFilteredRows(rows, pick("T112"), (k: Set<string>, p: Set<string>) => {
      matched = k;
      parents = p;
    });
    expect(out.map((r) => r.key)).toEqual(["D1", "S11", "T112"]);
    expect([...matched]).toEqual(["T112"]);
    expect([...parents].sort()).toEqual(["D1", "S11"]);
  });

  it("親そのものが一致しても子は足さない（一致した行だけ）", () => {
    const out = treeFilteredRows(rows, pick("S12", "D2"));
    expect(out.map((r) => r.key)).toEqual(["D1", "S12", "D2"]);
  });

  it("一致なしは空", () => {
    expect(treeFilteredRows(rows, [])).toEqual([]);
  });
});
