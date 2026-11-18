/**
 * 稼働実績の計画との比較・案件のまとめ・応援／ヘルプ・単位の切り替え（SPEC §150）
 */
import { describe, expect, it } from "vitest";
import {
  UNASSIGNED_WORK_KEY,
  aggregateWork,
  bucketWork,
  compareWorkPlan,
  decodeWorkPlans,
  decodeWorkRows,
  encodeWorkRows,
  groupWorkPlans,
  isUnknownMember,
  memberLeftAt,
  teamAncestry,
  workGuests,
  workPlanRows,
  workTeamOf,
  type WorkPlanRow,
  type WorkSeriesMonth,
} from "../../src/core/index.js";
import type { MemberRecord, TeamNode, WorkRow } from "../../src/core/types.js";
import { member } from "./fixtures.js";

const row = (o: Partial<WorkRow> & { month: string; memberId: string; hours: number }): WorkRow => ({
  memberName: o.memberId,
  teamId: null,
  contractId: null,
  customerKey: "",
  customerName: "",
  task: "保守",
  category: "contract",
  unclassified: false,
  amount: null,
  ...o,
});
const plan = (month: string, memberId: string, contractId: string, hours: number): WorkPlanRow => ({ month, memberId, contractId, hours });
const meta = { asOfMonth: "2026-11", lastFinalMonth: "2026-09" } as const;

describe("workPlanRows / encode・decode", () => {
  it("運用保守の計画だけを取り出し（運用保守以外・0 は除く）、work-hours.json に詰めて戻せる", () => {
    const plans = workPlanRows([
      {
        month: "2026-09",
        memberId: "M1",
        byContract: [
          { contractId: "C1", plannedHours: 80.123, actualHours: 0 } as never,
          { contractId: "~outside:提案", outsideType: "提案", plannedHours: 16, actualHours: 0 } as never,
          { contractId: "C2", plannedHours: 0, actualHours: 5 } as never,
        ],
      },
    ]);
    expect(plans).toEqual([{ month: "2026-09", memberId: "M1", contractId: "C1", hours: 80.123 }]);
    const rows = [row({ month: "2026-09", memberId: "M1", contractId: "C1", hours: 70 })];
    const enc = encodeWorkRows(rows, plans);
    expect(decodeWorkRows(enc)).toEqual(rows);
    expect(decodeWorkPlans(enc)).toEqual([{ month: "2026-09", memberId: "M1", contractId: "C1", hours: 80.12 }]);
    // 計画が無ければ従来どおりの形（p なし）
    expect(encodeWorkRows(rows).p).toBeUndefined();
    expect(decodeWorkPlans(encodeWorkRows(rows))).toEqual([]);
  });
});

describe("compareWorkPlan", () => {
  const judged = { from: "2026-08", to: "2026-09" };
  it("確定した月だけで差を出し、速報の月は判定しない（運用保守以外は数えない）", () => {
    const rows = [
      row({ month: "2026-08", memberId: "M1", hours: 100 }),
      row({ month: "2026-09", memberId: "M1", hours: 160 }),
      row({ month: "2026-09", memberId: "M1", hours: 50, category: "outside" }),
      row({ month: "2026-10", memberId: "M1", hours: 200 }),
    ];
    const c = compareWorkPlan([plan("2026-08", "M1", "C1", 100), plan("2026-09", "M1", "C1", 100), plan("2026-10", "M1", "C1", 100)], rows, judged);
    expect(c.plannedHours).toBe(200);
    expect(c.actualHours).toBe(260);
    expect(c.diffHours).toBe(60);
    expect(c.kind).toBe("over");
    expect(c.byMonth.get("2026-08")!.kind).toBeNull();
    expect(c.byMonth.get("2026-09")!.kind).toBe("over");
    expect(c.byMonth.get("2026-10")).toMatchObject({ judged: false, kind: null, actualHours: 200 });
  });
  it("計画が無く実績がある → 計画なし。確定した月が無ければ判定しない", () => {
    const rows = [row({ month: "2026-09", memberId: "M1", hours: 40 })];
    expect(compareWorkPlan([], rows, judged).kind).toBe("unplanned");
    const none = compareWorkPlan([], rows, null);
    expect(none.kind).toBeNull();
    expect(none.plannedHours).toBe(0);
    expect(none.byMonth.get("2026-09")!.actualHours).toBe(40);
  });
});

describe("groupWorkPlans / teamAncestry", () => {
  const tree: Record<string, TeamNode> = {
    ROOT: { teamId: "ROOT", parentTeamId: null } as TeamNode,
    T1: { teamId: "T1", parentTeamId: "ROOT" } as TeamNode,
    T11: { teamId: "T11", parentTeamId: "T1" } as TeamNode,
  };
  it("チームは所属の組織と上位すべてに数える", () => {
    expect(teamAncestry(tree, "T11")).toEqual(["T11", "T1", "ROOT"]);
    expect(teamAncestry(tree, "X")).toEqual([]);
    expect(teamAncestry(tree, null)).toEqual([]);
    const by = groupWorkPlans([plan("2026-09", "M1", "C1", 10), plan("2026-09", "M2", "C1", 5)], (p) => (p.memberId === "M1" ? teamAncestry(tree, "T11") : null));
    expect([...by.keys()]).toEqual(["T11", "T1", "ROOT"]);
    expect(by.get("ROOT")!.map((p) => p.hours)).toEqual([10]);
  });
});

describe("aggregateWork（案件）", () => {
  it("案件ごとに時間の多い順、関連する案件の無い運用保守以外は末尾", () => {
    const rows = [
      row({ month: "2026-09", memberId: "M1", contractId: "C1", hours: 10 }),
      row({ month: "2026-09", memberId: "M2", contractId: "C2", hours: 30 }),
      row({ month: "2026-09", memberId: "M1", contractId: "C1", hours: 5, category: "outside" }),
      row({ month: "2026-09", memberId: "M1", hours: 50, category: "outside" }),
    ];
    const g = aggregateWork({ meta: { asOfMonth: "2026-11" } as never, members: [] }, rows, { period: { from: "2026-04", to: "2027-03" }, axis: "contract", unassignedLabel: "なし", contractLabel: (id) => `顧客 / ${id}` });
    expect(g.map((x) => [x.key, x.label, x.totals.contractHours, x.totals.outsideHours])).toEqual([
      ["C2", "顧客 / C2", 30, 0],
      ["C1", "顧客 / C1", 10, 5],
      [UNASSIGNED_WORK_KEY, "なし", 0, 50],
    ]);
  });
});

describe("workGuests / メンバーの状態", () => {
  const members: MemberRecord[] = [
    member({ memberId: "OWN", teamId: "T1" }),
    member({ memberId: "SUP", teamId: "T2" }),
    member({ memberId: "MOVED", teamId: "T1", effectiveFrom: "2026-01" }),
    member({ memberId: "MOVED", teamId: "T2", effectiveFrom: "2026-10" }),
    member({ memberId: "BOSS", teamId: "ROOT" }),
    member({ memberId: "NOTEAM", teamId: null }),
    member({ memberId: "LEFT", teamId: "T2", effectiveFrom: "2000-01" }),
    member({ memberId: "LEFT", teamId: "T2", effectiveFrom: "2026-08", status: "left" } as never),
  ];
  const model = { members };
  const scope = { ownIds: new Set(["OWN"]), contractIds: new Set(["C1"]), ownScope: new Set(["T1", "ROOT"]), baseMonth: "2026-10" };
  it("チームの案件に入った他チームの人は応援、所属の無い人・マスタに無い人はヘルプ、上位の組織の人・異動前の作業は付けない", () => {
    const rows = [
      row({ month: "2026-09", memberId: "OWN", teamId: "T1", contractId: "C1", hours: 10 }),
      row({ month: "2026-09", memberId: "SUP", teamId: "T2", contractId: "C1", hours: 10 }),
      row({ month: "2026-09", memberId: "MOVED", teamId: "T1", contractId: "C1", hours: 10 }),
      row({ month: "2026-09", memberId: "BOSS", teamId: "ROOT", contractId: "C1", hours: 10 }),
      row({ month: "2026-09", memberId: "NOTEAM", contractId: "C1", hours: 10 }),
      row({ month: "2026-09", memberId: "GHOST", contractId: "C1", hours: 10 }),
      row({ month: "2026-09", memberId: "OTHER", teamId: "T2", contractId: "C9", hours: 10 }),
      row({ month: "2026-09", memberId: "SUP", teamId: "T2", contractId: "C1", hours: 10, category: "outside" }),
    ];
    const g = workGuests(model, rows, [], scope);
    expect(Object.fromEntries(g)).toEqual({ SUP: "support", NOTEAM: "help", GHOST: "help" });
    // 計画だけの人も応援
    const p = workGuests(model, [], [plan("2026-10", "SUP", "C1", 10)], scope);
    expect(Object.fromEntries(p)).toEqual({ SUP: "support" });
    expect(workGuests(model, rows, [], { ...scope, contractIds: new Set() }).size).toBe(0);
  });
  it("所属・マスタに無い人・不在", () => {
    expect(workTeamOf(model, "MOVED", "2026-09")).toBe("T1");
    expect(workTeamOf(model, "MOVED", "2026-10")).toBe("T2");
    expect(workTeamOf(model, "NOTEAM", "2026-10")).toBeNull();
    expect(isUnknownMember(model, "GHOST")).toBe(true);
    expect(isUnknownMember(model, "OWN")).toBe(false);
    expect(memberLeftAt(model, "LEFT", "2026-10")).toBe("2026-08");
    expect(memberLeftAt(model, "LEFT", "2026-07")).toBeNull();
    expect(memberLeftAt(model, "OWN", "2026-10")).toBeNull();
  });
});

describe("bucketWork", () => {
  const series: WorkSeriesMonth[] = [
    { month: "2026-04", status: "final", contractHours: 100, outsideHours: 10, plannedHours: 90 },
    { month: "2026-05", status: "final", contractHours: 80, outsideHours: 0, plannedHours: 90 },
    { month: "2026-07", status: "preliminary", contractHours: 50, outsideHours: 5, plannedHours: 90 },
  ];
  it("四半期・年度は月を足す", () => {
    const q = bucketWork(series, "quarter", { startMonth: 4 });
    expect(q.map((b) => [b.key, b.contractHours, b.outsideHours, b.plannedHours, b.status])).toEqual([
      ["2026-Q1", 180, 10, 180, "final"],
      ["2026-Q2", 50, 5, 90, "preliminary"],
    ]);
    expect(bucketWork(series, "year", { startMonth: 4 })[0]).toMatchObject({ key: "2026", contractHours: 230, status: null });
  });
  it("日: メンバーの月の時間を日ごとの割合で配り（足すと月の値）、計画は営業日に均等。人ごとの内訳を持つ", () => {
    const monthHours = new Map<string, Map<string, readonly [number, number]>>([
      ["M1", new Map([["2026-04", [60, 10]]])],
      ["M2", new Map([["2026-04", [40, 0]]])],
    ]);
    const days = { M1: { "2026-04": { a: [[1, 2, 0], [2, 1, 1]] as Array<[number, number, number]> } } };
    const b = bucketWork([series[0]!], "day", { startMonth: 4, days, monthHours, holidays: [], asOf: "2026-04-30" });
    expect(b).toHaveLength(30);
    const sum = (k: "contractHours" | "outsideHours" | "plannedHours") => b.reduce((s, x) => s + x[k], 0);
    expect(sum("contractHours")).toBeCloseTo(100);
    expect(sum("outsideHours")).toBeCloseTo(10);
    expect(sum("plannedHours")).toBeCloseTo(90);
    const d1 = b.find((x) => x.from === "2026-04-01")!;
    expect(d1.members!.get("M1")![0]).toBeCloseTo(40);
    expect(d1.members!.get("M1")![1]).toBeCloseTo(0);
    // 土日（4/4・4/5）は計画も日ごとの値の無い人の実績も配らない
    const sat = b.find((x) => x.from === "2026-04-04")!;
    expect(sat.businessDay).toBe(false);
    expect(sat.plannedHours).toBe(0);
    expect(sat.members!.size).toBe(0);
    // 週は月曜始まり
    const w = bucketWork([series[0]!], "week", { startMonth: 4, days, monthHours, holidays: [], asOf: "2026-04-30" });
    expect(w[0]!.key).toBe("2026-03-30");
    expect(w.reduce((s, x) => s + x.contractHours, 0)).toBeCloseTo(100);
  });
});
