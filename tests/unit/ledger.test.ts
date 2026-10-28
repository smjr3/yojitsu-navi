/**
 * 台帳の見せ方（SPEC §32）: 対象ごとのまとまり・期間の変更の並び・期間の置き換え
 */
import { describe, expect, it } from "vitest";
import { ledgerGroups, nextChangeOf, periodHistory, replaceRange, valueAt, type RangeRow } from "../../src/core/ledger.js";

const m = (id: string, record: Record<string, string>) => ({ id, record });

describe("ledgerGroups", () => {
  const rows = [
    m("r1", { member_id: "M1", title: "一般", team_id: "T1", effective_from: "2025-04" }),
    m("r2", { member_id: "M2", title: "主任", team_id: "T1", effective_from: "2025-04" }),
    m("r3", { member_id: "M1", title: "主任", team_id: "T1", effective_from: "2026-07" }),
    m("r4", { member_id: "M1", title: "主任", team_id: "T2", effective_from: "2026-11" }),
  ];

  it("対象ごとに 1 つ、ファイルに最初に出た順にまとめる", () => {
    const g = ledgerGroups(rows, "member_id", "2026-10");
    expect(g.map((x) => x.key)).toEqual(["M1", "M2"]);
    expect(g[0]?.entries.map((e) => e.rowId)).toEqual(["r1", "r3", "r4"]);
  });

  it("基準月に有効な履歴を今の値として出し、後の履歴は予定にする", () => {
    const [g] = ledgerGroups(rows, "member_id", "2026-10");
    expect(g?.shown.rowId).toBe("r3");
    expect(g?.shown.current).toBe(true);
    expect(g?.upcoming.map((e) => e.rowId)).toEqual(["r4"]);
    expect(g?.entries.map((e) => e.future)).toEqual([false, false, true]);
  });

  it("前の履歴から変わった列だけを差分として持つ（適用開始月は除く）", () => {
    const [g] = ledgerGroups(rows, "member_id", "2026-10");
    expect(g?.entries.map((e) => e.changes)).toEqual([[], ["title"], ["team_id"]]);
    expect(g?.entries[1]?.previous?.title).toBe("一般");
  });

  it("全部が予定（基準月より後）なら最初の履歴を出す", () => {
    const [g] = ledgerGroups([m("a", { key: "新役職", hourly_rate: "9000", effective_from: "2027-04" })], "key", "2026-10");
    expect(g?.shown.rowId).toBe("a");
    expect(g?.shown.current).toBe(false);
    expect(g?.upcoming).toHaveLength(1);
  });

  it("同じ適用開始月はファイルの後の行を有効にする（§5 と同じ）", () => {
    const g = ledgerGroups([m("a", { key: "K", hourly_rate: "1", effective_from: "2025-04" }), m("b", { key: "K", hourly_rate: "2", effective_from: "2025-04" })], "key", "2026-10");
    expect(g[0]?.shown.rowId).toBe("b");
  });

  it("キーが空の行は行ごとに別のまとまり。不正な適用開始月は先頭に並べる", () => {
    const g = ledgerGroups(
      [m("a", { team_id: "", name: "x", effective_from: "2025-04" }), m("b", { team_id: "", name: "y", effective_from: "2025-04" }), m("c", { team_id: "T", name: "z", effective_from: "2026-04" }), m("d", { team_id: "T", name: "w", effective_from: "4月" })],
      "team_id",
      "2026-10",
    );
    expect(g).toHaveLength(3);
    expect(g[2]?.entries.map((e) => e.rowId)).toEqual(["d", "c"]);
    expect(g[2]?.entries[0]?.future).toBe(false);
  });

  it("値の前後の空白は差分にしない", () => {
    const g = ledgerGroups([m("a", { key: "K", hourly_rate: "100", effective_from: "2025-04" }), m("b", { key: "K", hourly_rate: " 100 ", effective_from: "2026-04" })], "key", "2026-10");
    expect(g[0]?.entries[1]?.changes).toEqual([]);
  });

  it("nextChangeOf: 列ごとの次の変更（予定）", () => {
    const [g] = ledgerGroups(rows, "member_id", "2026-10");
    expect(nextChangeOf(g!, "team_id")).toEqual({ from: "2026-11", value: "T2" });
    expect(nextChangeOf(g!, "title")).toBeNull();
    const [past] = ledgerGroups(rows, "member_id", "2027-01");
    expect(nextChangeOf(past!, "team_id")).toBeNull();
  });

  it("空の入力", () => {
    expect(ledgerGroups([], "member_id", "2026-10")).toEqual([]);
  });
});

const p = (rowId: string, startMonth: string, endMonth: string, value: number, contractId = "C1") => ({ rowId, contractId, startMonth, endMonth, value });

describe("periodHistory", () => {
  it("開始・変更・契約の切り替わり・終了", () => {
    const h = periodHistory([p("b", "2026-07", "2026-09", 0.3), p("a", "2026-04", "2026-06", 0.5), p("c", "2026-10", "2027-03", 0.3, "C2")]);
    expect(h.map((e) => [e.rowId, e.kind, e.previousValue, e.endsBefore])).toEqual([
      ["a", "start", null, null],
      ["b", "change", 0.5, null],
      ["c", "contract", 0.3, "2027-04"],
    ]);
  });

  it("間が空けば再開。空く前の期間に終了月を付ける", () => {
    const h = periodHistory([p("a", "2026-04", "2026-05", 0.5), p("b", "2026-08", "2026-09", 0.5)]);
    expect(h.map((e) => [e.kind, e.endsBefore])).toEqual([
      ["start", "2026-06"],
      ["restart", "2026-10"],
    ]);
  });

  it("同じ値・同じ契約で続く行は same（まとめられる）", () => {
    expect(periodHistory([p("a", "2026-04", "2026-05", 0.5), p("b", "2026-06", "2026-09", 0.5)]).map((e) => e.kind)).toEqual(["start", "same"]);
  });

  it("重なりと不正な月", () => {
    const h = periodHistory([p("a", "2026-04", "2026-09", 0.5), p("b", "2026-06", "2026-07", 0.2), p("x", "4月", "2026-07", 0.2), p("y", "2026-09", "2026-08", 0.2)]);
    expect(h.map((e) => [e.rowId, e.kind])).toEqual([
      ["a", "start"],
      ["b", "overlap"],
      ["x", "invalid"],
      ["y", "invalid"],
    ]);
    // 重なった行の後ろに続く期間は、重なりの外なので「終了」を付ける
    expect(h[0]?.endsBefore).toBe("2026-10");
  });

  it("数値でない値は変更として扱う", () => {
    expect(periodHistory([p("a", "2026-04", "2026-05", Number.NaN), p("b", "2026-06", "2026-07", 0.5)]).map((e) => e.kind)).toEqual(["start", "change"]);
  });
});

const r = (id: string, startMonth: string, endMonth: string, value: string, contractId = "C1"): RangeRow => ({ id, contractId, startMonth, endMonth, value });
const one = (from: string, to: string) => [{ contractId: "C1", startMonth: from, endMonth: to }];

/** 結果を適用した行（比較しやすい形） */
function apply(rows: RangeRow[], res: ReturnType<typeof replaceRange>): string[] {
  if (!res.ok) throw new Error(res.reason);
  const out: string[] = [];
  for (const x of rows) {
    if (res.edit.deletes.includes(x.id)) continue;
    const u = res.edit.updates.get(x.id);
    out.push(u ? `${x.id}:${u.contractId}:${u.startMonth}~${u.endMonth}=${u.value}` : `${x.id}:${x.contractId}:${x.startMonth}~${x.endMonth}=${x.value}`);
  }
  for (const a of res.edit.adds) out.push(`+:${a.contractId}:${a.startMonth}~${a.endMonth}=${a.value}`);
  return out;
}

describe("replaceRange", () => {
  it("途中から値を変える: 元の行を前半に縮め、後半を新しい行にする", () => {
    const rows = [r("a", "2026-04", "2027-03", "0.5")];
    expect(apply(rows, replaceRange(rows, "2026-07", "2027-03", "0.3", one))).toEqual(["a:C1:2026-04~2026-06=0.5", "+:C1:2026-07~2027-03=0.3"]);
  });

  it("1 か月だけ変える: 前・その月・後の 3 行に分かれる", () => {
    const rows = [r("a", "2026-04", "2027-03", "0.5")];
    expect(apply(rows, replaceRange(rows, "2026-06", "2026-06", "0.3", one))).toEqual(["a:C1:2026-04~2026-05=0.5", "+:C1:2026-06~2026-06=0.3", "+:C1:2026-07~2027-03=0.5"]);
  });

  it("元の値に戻すと元の 1 行に戻る（行は変更なし）", () => {
    const rows = [r("a", "2026-04", "2026-05", "0.5"), r("b", "2026-06", "2026-06", "0.3"), r("c", "2026-07", "2027-03", "0.5")];
    const res = replaceRange(rows, "2026-06", "2026-06", "0.5", one);
    expect(apply(rows, res)).toEqual(["a:C1:2026-04~2027-03=0.5"]);
    if (res.ok) expect(res.edit.deletes.sort()).toEqual(["b", "c"]);
    const single = [r("a", "2026-04", "2027-03", "0.5")];
    const same = replaceRange(single, "2026-06", "2026-09", "0.50", one);
    expect(same.ok && same.edit.updates.size + same.edit.deletes.length + same.edit.adds.length).toBe(0);
  });

  it("0 にすると期間から外す（行の終わりを縮める・行を消す）", () => {
    const rows = [r("a", "2026-04", "2027-03", "0.5")];
    expect(apply(rows, replaceRange(rows, "2026-10", "2027-03", "0", one))).toEqual(["a:C1:2026-04~2026-09=0.5"]);
    expect(apply(rows, replaceRange(rows, "2026-04", "2027-03", "", one))).toEqual([]);
  });

  it("期間の中で消える行は、新しい期間に使い回す（差分が変更になる）", () => {
    const rows = [r("a", "2026-04", "2026-09", "0.5")];
    const res = replaceRange(rows, "2026-04", "2026-09", "0.2", one);
    expect(apply(rows, res)).toEqual(["a:C1:2026-04~2026-09=0.2"]);
    if (res.ok) expect(res.edit.adds).toEqual([]);
  });

  it("計画が無い期間に足す。前に接する同じ値の行は伸ばす", () => {
    expect(apply([], replaceRange([], "2026-04", "2026-06", "0.4", one))).toEqual(["+:C1:2026-04~2026-06=0.4"]);
    const rows = [r("a", "2026-04", "2026-06", "0.4")];
    expect(apply(rows, replaceRange(rows, "2026-07", "2026-09", "0.4", one))).toEqual(["a:C1:2026-04~2026-09=0.4"]);
  });

  it("後ろに接する同じ値の行は前へ伸ばす", () => {
    const rows = [r("a", "2026-07", "2026-09", "0.4")];
    expect(apply(rows, replaceRange(rows, "2026-04", "2026-06", "0.4", one))).toEqual(["a:C1:2026-04~2026-09=0.4"]);
  });

  it("契約の切り替わりをまたぐと契約ごとに行を分ける", () => {
    const seg = (from: string, to: string) => {
      const out = [];
      if (from <= "2026-09") out.push({ contractId: "C1", startMonth: from, endMonth: to < "2026-09" ? to : "2026-09" });
      if (to >= "2026-10") out.push({ contractId: "C2", startMonth: from > "2026-10" ? from : "2026-10", endMonth: to });
      return out;
    };
    const rows = [r("a", "2026-04", "2026-09", "0.5", "C1"), r("b", "2026-10", "2027-03", "0.5", "C2")];
    expect(apply(rows, replaceRange(rows, "2026-07", "2027-03", "0.2", seg))).toEqual(["a:C1:2026-04~2026-06=0.5", "b:C2:2026-10~2027-03=0.2", "+:C1:2026-07~2026-09=0.2"]);
  });

  it("期間の中で行が重なっていれば置き換えない", () => {
    const rows = [r("a", "2026-04", "2026-09", "0.5"), r("b", "2026-06", "2026-07", "0.2")];
    expect(replaceRange(rows, "2026-05", "2026-08", "0.1", one)).toEqual({ ok: false, reason: "overlap" });
    // 重なりが期間の外なら置き換えられる
    expect(replaceRange(rows, "2026-09", "2026-09", "0.1", one).ok).toBe(true);
  });

  it("不正な期間・月の行", () => {
    expect(replaceRange([], "2026-09", "2026-04", "0.1", one)).toEqual({ ok: false, reason: "invalid-range" });
    expect(replaceRange([], "4月", "2026-04", "0.1", one)).toEqual({ ok: false, reason: "invalid-range" });
    const rows = [r("x", "4月", "2026-09", "0.5")];
    const res = replaceRange(rows, "2026-04", "2026-06", "0.3", one);
    expect(apply(rows, res)).toEqual(["x:C1:4月~2026-09=0.5", "+:C1:2026-04~2026-06=0.3"]);
  });
});

describe("valueAt", () => {
  it("月に掛かる行の合計。数値でない行は数えない", () => {
    const rows = [p("a", "2026-04", "2026-06", 0.5), p("b", "2026-06", "2026-09", 0.25), p("c", "2026-06", "2026-06", Number.NaN)];
    expect(valueAt(rows, "2026-06")).toBeCloseTo(0.75);
    expect(valueAt(rows, "2026-03")).toBe(0);
  });
});
