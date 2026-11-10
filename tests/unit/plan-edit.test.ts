import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { contractSegments, contractsCover, editMonthAllocation, mergeAdjacent, projectKey } from "../../src/core/plan.js";
import { addMonths, monthRange } from "../../src/core/calendar.js";

const C = (contractId: string, startMonth: string, endMonth: string) => ({ contractId, startMonth, endMonth });

describe("contractsCover（§31.6 案件の候補の「契約期間外」）", () => {
  const renewal = [C("C001", "2025-04", "2026-03"), C("C002", "2026-04", "2027-03")];
  it("期間に 1 か月でも契約が掛かれば期間中", () => {
    expect(contractsCover(renewal, "2026-03", "2026-03")).toBe(true);
    expect(contractsCover(renewal, "2027-03", "2027-08")).toBe(true);
    expect(contractsCover(renewal, "2024-10", "2025-04")).toBe(true);
  });
  it("契約の前・後・契約の切れ目だけなら期間外", () => {
    expect(contractsCover(renewal, "2027-04", "2027-06")).toBe(false);
    expect(contractsCover(renewal, "2025-01", "2025-03")).toBe(false);
    expect(contractsCover([C("A", "2026-04", "2026-06"), C("B", "2026-10", "2027-03")], "2026-07", "2026-09")).toBe(false);
  });
  it("月が不正・逆順・契約 0 件・契約の月が不正なら期間外", () => {
    expect(contractsCover(renewal, "", "2026-05")).toBe(false);
    expect(contractsCover(renewal, "2026-06", "2026-05")).toBe(false);
    expect(contractsCover([], "2026-05", "2026-05")).toBe(false);
    expect(contractsCover([C("X", "2026-13", "2027-03")], "2026-05", "2026-05")).toBe(false);
  });
});

describe("contractSegments（§31.3 案件 → 契約）", () => {
  const renewal = [C("C001", "2025-04", "2026-03"), C("C002", "2026-04", "2027-03")];

  it("1 つの契約に収まる期間は 1 行", () => {
    expect(contractSegments(renewal, "2026-05", "2026-12")).toEqual([C("C002", "2026-05", "2026-12")]);
  });
  it("契約の切り替わりをまたぐと契約ごとに分ける", () => {
    expect(contractSegments(renewal, "2026-01", "2026-06")).toEqual([C("C001", "2026-01", "2026-03"), C("C002", "2026-04", "2026-06")]);
  });
  it("契約の後ろにはみ出した月は最後に終わった契約へ", () => {
    expect(contractSegments(renewal, "2027-01", "2027-06")).toEqual([C("C002", "2027-01", "2027-06")]);
  });
  it("契約より前の月は最初に始まる契約へ", () => {
    expect(contractSegments(renewal, "2024-10", "2025-05")).toEqual([C("C001", "2024-10", "2025-05")]);
  });
  it("契約のすき間の月は前に終わった契約へ", () => {
    const gap = [C("A", "2025-04", "2025-06"), C("B", "2025-10", "2026-03")];
    expect(contractSegments(gap, "2025-05", "2025-11")).toEqual([C("A", "2025-05", "2025-09"), C("B", "2025-10", "2025-11")]);
  });
  it("重なる契約は開始月が遅いほう", () => {
    const overlap = [C("A", "2025-04", "2026-03"), C("B", "2025-10", "2026-09")];
    expect(contractSegments(overlap, "2025-08", "2025-11")).toEqual([C("A", "2025-08", "2025-09"), C("B", "2025-10", "2025-11")]);
  });
  it("契約なし・逆順・不正な月は空", () => {
    expect(contractSegments([], "2025-04", "2025-05")).toEqual([]);
    expect(contractSegments(renewal, "2026-05", "2026-04")).toEqual([]);
    expect(contractSegments(renewal, "2026-13", "2027-01")).toEqual([]);
    expect(contractSegments([C("X", "bad", "2025-01")], "2025-01", "2025-02")).toEqual([]);
  });
  it("性質: 全月をすき間なく重なりなく覆い、各区間は 1 契約", () => {
    const ym = fc.tuple(fc.integer({ min: 2024, max: 2028 }), fc.integer({ min: 1, max: 12 })).map(([y, m]) => `${y}-${String(m).padStart(2, "0")}`);
    const contract = fc.tuple(ym, fc.integer({ min: 0, max: 30 }), fc.constantFrom("A", "B", "C", "D")).map(([s, n, id]) => C(id, s, addMonths(s, n)));
    fc.assert(
      fc.property(fc.array(contract, { minLength: 1, maxLength: 5 }), ym, fc.integer({ min: 0, max: 40 }), (cs, from, n) => {
        const to = addMonths(from, n);
        const segs = contractSegments(cs, from, to);
        const covered = segs.flatMap((s) => monthRange(s.startMonth, s.endMonth));
        expect(covered).toEqual(monthRange(from, to));
        for (let i = 1; i < segs.length; i++) expect(segs[i]!.contractId).not.toBe(segs[i - 1]!.contractId);
        for (const s of segs) expect(cs.some((c) => c.contractId === s.contractId)).toBe(true);
      }),
    );
  });
});

describe("editMonthAllocation（§31.4 月ごとの修正）", () => {
  const row = { startMonth: "2026-04", endMonth: "2027-03", allocation: "0.5" };
  it("この月だけ: 前・その月・後の 3 行に分ける", () => {
    expect(editMonthAllocation(row, "2026-06", "0.3", "month")).toEqual([
      { startMonth: "2026-04", endMonth: "2026-05", allocation: "0.5" },
      { startMonth: "2026-06", endMonth: "2026-06", allocation: "0.3" },
      { startMonth: "2026-07", endMonth: "2027-03", allocation: "0.5" },
    ]);
  });
  it("この月以降: 前と以降の 2 行", () => {
    expect(editMonthAllocation(row, "2026-10", "0.2", "after")).toEqual([
      { startMonth: "2026-04", endMonth: "2026-09", allocation: "0.5" },
      { startMonth: "2026-10", endMonth: "2027-03", allocation: "0.2" },
    ]);
  });
  it("最初の月・最後の月は端の行を作らない", () => {
    expect(editMonthAllocation(row, "2026-04", "0.1", "month")).toHaveLength(2);
    expect(editMonthAllocation(row, "2027-03", "0.1", "month")).toHaveLength(2);
    expect(editMonthAllocation(row, "2026-04", "0.1", "after")).toEqual([{ startMonth: "2026-04", endMonth: "2027-03", allocation: "0.1" }]);
  });
  it("0 や空はその部分を外す（全部 0 なら行が消える）", () => {
    expect(editMonthAllocation(row, "2026-06", "0", "month").map((p) => p.startMonth)).toEqual(["2026-04", "2026-07"]);
    expect(editMonthAllocation(row, "2026-04", "", "after")).toEqual([]);
    expect(editMonthAllocation({ ...row, startMonth: "2026-06", endMonth: "2026-06" }, "2026-06", "0.0", "month")).toEqual([]);
  });
  it("行の外の月・不正な月は元のまま", () => {
    expect(editMonthAllocation(row, "2027-04", "0.1", "month")).toEqual([row]);
    expect(editMonthAllocation(row, "2026-00", "0.1", "month")).toEqual([row]);
  });
  it("数値でない値はそのまま残す（検証でエラーにする）", () => {
    expect(editMonthAllocation(row, "2026-06", "abc", "month")[1]!.allocation).toBe("abc");
  });
});

describe("mergeAdjacent（§31.4 行のまとめ直し）", () => {
  const r = (id: string, startMonth: string, endMonth: string, allocation: string) => ({ id, startMonth, endMonth, allocation });
  it("隣り合って同じ配分の行を 1 行に", () => {
    const out = mergeAdjacent([r("n1", "2026-06", "2026-06", "0.5"), r("o1", "2026-04", "2026-05", "0.5"), r("n2", "2026-07", "2027-03", "0.50")], new Set(["o1"]));
    expect([...out.keep]).toEqual([["o1", { startMonth: "2026-04", endMonth: "2027-03" }]]);
    expect(out.drop.sort()).toEqual(["n1", "n2"]);
  });
  it("配分が違う・すき間がある行はまとめない", () => {
    const out = mergeAdjacent([r("a", "2026-04", "2026-05", "0.5"), r("b", "2026-06", "2026-06", "0.3"), r("c", "2026-08", "2026-09", "0.3")]);
    expect(out.keep.size).toBe(0);
    expect(out.drop).toEqual([]);
  });
  it("元の行が無ければ期間の最初の行を残す", () => {
    const out = mergeAdjacent([r("n2", "2026-05", "2026-05", "1"), r("n1", "2026-04", "2026-04", "1")]);
    expect([...out.keep.keys()]).toEqual(["n1"]);
  });
  it("修正して元の値に戻すと 1 行に戻る（往復）", () => {
    const row = { startMonth: "2026-04", endMonth: "2027-03", allocation: "0.5" };
    const split = editMonthAllocation(row, "2026-06", "0.3", "month");
    const back = split.flatMap((p) => (p.startMonth === "2026-06" ? editMonthAllocation(p, "2026-06", "0.5", "month") : [p]));
    const out = mergeAdjacent(back.map((p, i) => ({ ...p, id: `r${i}` })));
    expect([...out.keep.values()]).toEqual([{ startMonth: "2026-04", endMonth: "2027-03" }]);
    expect(out.drop).toHaveLength(2);
  });
});

describe("projectKey", () => {
  it("前後の空白を無視し、顧客と案件を区別する", () => {
    expect(projectKey(" 青葉物流", "保守 ")).toBe(projectKey("青葉物流", "保守"));
    expect(projectKey("a", "bc")).not.toBe(projectKey("ab", "c"));
  });
});
