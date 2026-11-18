/** 案件一覧の「期間」表示の並べ方・印（SPEC §132） */
import { describe, expect, it } from "vitest";
import { addMonths } from "../../src/core/index.js";
import { END_SOON_MONTHS, arrangeTimeline, isEnded, isEndingSoon, loadTimelinePrefs, monthBars, saveTimelinePrefs } from "../../src/components/contract-timeline.js";

// 年月は基準月からの相対で作る（固定の年月を書かない）
const NOW = "2030-06";
const m = (n: number) => addMonths(NOW, n);
const row = (id: string, start: number, end: number, extra: Record<string, unknown> = {}) => ({
  contractId: id,
  customerName: (extra.customerName as string) ?? "顧客A",
  projectName: `案件${id}`,
  teamId: (extra.teamId as string) ?? "T1",
  teamName: (extra.teamName as string) ?? "チーム1",
  startMonth: m(start),
  endMonth: m(end),
  totalAmount: (extra.totalAmount as number) ?? 1000,
  burnRate: (extra.burnRate as number | null) ?? null,
});

describe("終了・終了が近い", () => {
  it("終了は終了月が今月より前", () => {
    expect(isEnded(row("a", -12, -1), NOW)).toBe(true);
    expect(isEnded(row("a", -12, 0), NOW)).toBe(false);
  });
  it("終了が近いは今月から END_SOON_MONTHS か月先まで（終わった案件は含めない）", () => {
    expect(isEndingSoon(row("a", -12, 0), NOW)).toBe(true);
    expect(isEndingSoon(row("a", -12, END_SOON_MONTHS), NOW)).toBe(true);
    expect(isEndingSoon(row("a", -12, END_SOON_MONTHS + 1), NOW)).toBe(false);
    expect(isEndingSoon(row("a", -12, -1), NOW)).toBe(false);
  });
});

describe("arrangeTimeline", () => {
  const rows = [
    row("old", -24, -13, { customerName: "顧客B" }),
    row("late", -2, 9, { customerName: "顧客A", totalAmount: 500, burnRate: 0.5 }),
    row("soon", -10, 1, { customerName: "顧客B", totalAmount: 9000, burnRate: 1.2 }),
    row("mid", -5, 4, { customerName: "顧客A", teamId: "T2", teamName: "チーム2", totalAmount: 3000 }),
  ];
  it("終了が近い順: 終わる月の順、終わった案件は最後。まとまりは最初の行の順", () => {
    const g = arrangeTimeline(rows, { group: "customer", sort: "end", asOfMonth: NOW });
    expect(g.map((x) => x.label)).toEqual(["顧客B", "顧客A"]);
    expect(g[0]!.rows.map((r) => r.contractId)).toEqual(["soon", "old"]);
    expect(g[1]!.rows.map((r) => r.contractId)).toEqual(["mid", "late"]);
  });
  it("まとめなし・総額の大きい順でも終わった案件は後ろ", () => {
    const g = arrangeTimeline(rows, { group: "none", sort: "amount", asOfMonth: NOW });
    expect(g).toHaveLength(1);
    expect(g[0]!.rows.map((r) => r.contractId)).toEqual(["soon", "mid", "late", "old"]);
  });
  it("消化率の高い順（消化率の無い案件は後ろ）・開始が早い順", () => {
    expect(arrangeTimeline(rows, { group: "none", sort: "burn", asOfMonth: NOW })[0]!.rows.map((r) => r.contractId)).toEqual(["soon", "late", "mid", "old"]);
    expect(arrangeTimeline(rows, { group: "none", sort: "start", asOfMonth: NOW })[0]!.rows.map((r) => r.contractId)).toEqual(["soon", "mid", "late", "old"]);
  });
  it("チームでまとめる", () => {
    const g = arrangeTimeline(rows, { group: "team", sort: "end", asOfMonth: NOW });
    expect(g.map((x) => x.label)).toEqual(["チーム1", "チーム2"]);
  });
  it("知らない並べ方は終了が近い順", () => {
    expect(arrangeTimeline(rows, { group: "none", sort: "xxx", asOfMonth: NOW })[0]!.rows[0]!.contractId).toBe("soon");
  });
});

describe("monthBars", () => {
  const months = [
    { month: m(-3), status: "final", budget: 100, cost: 50 },
    { month: m(-2), status: "final", budget: 100, cost: 150 },
    { month: m(-1), status: "final", budget: 0, cost: 10 },
    { month: m(0), status: "preliminary", budget: 100, cost: 20 },
    { month: m(1), status: "future", budget: 100, cost: 0 },
  ];
  it("確定した月・予算のある月・見えている範囲だけ。超過の印", () => {
    const bars = monthBars(months, { from: m(-2), to: m(1) });
    expect(bars).toEqual([{ month: m(-2), ratio: 1.5, over: true, budget: 100, cost: 150 }]);
  });
});

describe("まとめ方・並べ方の保存", () => {
  it("保存して読める。壊れた値・読めないときは既定", () => {
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadTimelinePrefs(s)).toEqual({ group: "customer", sort: "end" });
    saveTimelinePrefs({ group: "team", sort: "amount" }, s);
    expect(loadTimelinePrefs(s)).toEqual({ group: "team", sort: "amount" });
    store.set("yojitsu-navi:contract-timeline", "{bad");
    expect(loadTimelinePrefs(s)).toEqual({ group: "customer", sort: "end" });
    expect(loadTimelinePrefs({ getItem: () => { throw new Error("x"); } })).toEqual({ group: "customer", sort: "end" });
    expect(() => saveTimelinePrefs({ group: "team", sort: "end" }, { setItem: () => { throw new Error("x"); } })).not.toThrow();
  });
});
