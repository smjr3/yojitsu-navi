/**
 * アサイン・運用保守以外の予定の開始日・終了日（任意列 start_date / end_date。SPEC §121）
 *   - 日付の読み方・画面の日付 1 欄との変換・検証
 *   - 端の月は営業日で日割り（リソース計画の合計・1.0 超・計画額・着地・メンバー別の計画）
 *   - 月の途中で案件を替えた人は 1.0 超にならない
 *   - 編集（月ごとの修正・期間の置き換え・行のまとめ直し）で日付を失わない・日割りの月をまとめない
 */
import { describe, expect, it } from "vitest";
import { parseDataset } from "../../src/core/csv.js";
import { endDateOf, periodBounds, periodDateErrors, periodPresenceAt, periodShareAt, splitPeriodDate, startDateOf } from "../../src/core/periodDates.js";
import { editMonthAllocation, mergeAdjacent, planView } from "../../src/core/plan.js";
import { periodHistory, replaceRange, valueAt } from "../../src/core/ledger.js";
import { MASTER_FILES, emptyMasterText, parseMasterDoc, planSourcesFromDocs } from "../../src/core/masterEdit.js";
import { validateDataset } from "../../src/core/validate.js";
import { buildModel } from "../../src/core/model.js";
import { assignment, contract, dataset, member, rate, weekdayHours } from "./fixtures.js";

// 11 月（祝日なし）: 1 日が日曜。平日は 21 日。16 日（月）からの平日は 11 日、13 日（金）までの平日は 10 日
const M = "2026-11";

describe("日付の読み方と画面の日付 1 欄", () => {
  it("startDateOf / endDateOf: 月の中の正しい日付で、月の初日・末日でないものだけ", () => {
    expect(startDateOf({ startMonth: M, startDate: "2026-11-16" })).toBe("2026-11-16");
    expect(startDateOf({ startMonth: M, startDate: "2026-11-01" })).toBeNull();
    expect(startDateOf({ startMonth: M, startDate: "2026-12-01" })).toBeNull();
    expect(startDateOf({ startMonth: M })).toBeNull();
    expect(endDateOf({ endMonth: M, endDate: "2026-11-13" })).toBe("2026-11-13");
    expect(endDateOf({ endMonth: M, endDate: "2026-11-30" })).toBeNull();
  });

  it("splitPeriodDate: 月の初日（開始）・末日（終了）・月だけなら日付の列は空", () => {
    expect(splitPeriodDate("2026-11-16", "start")).toEqual({ month: M, date: "2026-11-16" });
    expect(splitPeriodDate("2026-11-01", "start")).toEqual({ month: M, date: "" });
    expect(splitPeriodDate("2026-11-30", "end")).toEqual({ month: M, date: "" });
    expect(splitPeriodDate("2026-11-01", "end")).toEqual({ month: M, date: "2026-11-01" });
    expect(splitPeriodDate("2026-11", "end")).toEqual({ month: M, date: "" });
    expect(splitPeriodDate("2026-13", "start")).toBeNull();
    expect(splitPeriodDate("2026/11/16", "start")).toBeNull();
  });

  it("periodBounds: 日付の無い端は月の初日・末日", () => {
    expect(periodBounds({ startMonth: "2026-04", endMonth: "2027-02" })).toEqual({ from: "2026-04-01", to: "2027-02-28" });
    expect(periodBounds({ startMonth: M, endMonth: M, startDate: "2026-11-16", endDate: "2026-11-20" })).toEqual({ from: "2026-11-16", to: "2026-11-20" });
  });

  it("CSV: 列が無いファイル・空のセルは日付なし。あれば読む", () => {
    const base = { config: dataset().config, contracts: "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\n", mapping: "worklog_customer_name,worklog_project_name,contract_id\n", teams: "team_id,name,parent_team_id,effective_from\n", members: "member_id,name,kind,title,department,section,team_id,effective_from\n", rates: "key,hourly_rate,effective_from\n", holidays: "date,name\n", worklogs: [] };
    const without = parseDataset({ ...base, assignments: "member_id,contract_id,start_month,end_month,allocation\nM1,C1,2026-04,2027-03,1\n" });
    expect(without.dataset.assignments[0]).not.toHaveProperty("startDate");
    const withDates = parseDataset({ ...base, assignments: "member_id,contract_id,start_month,end_month,allocation,start_date,end_date\nM1,C1,2026-11,2027-03,1,2026-11-16,\n", outsidePlans: "member_id,type,start_month,end_month,person_months,note,start_date,end_date\nM1,提案,2026-04,2026-11,0.2,,,2026-11-13\n" });
    expect(withDates.dataset.assignments[0]).toMatchObject({ startDate: "2026-11-16" });
    expect(withDates.dataset.assignments[0]).not.toHaveProperty("endDate");
    expect(withDates.dataset.outsidePlans![0]).toMatchObject({ endDate: "2026-11-13" });
  });

  it("マスタ編集: 列は省略可で、新しく作るファイルの見出しには入れない（使う行が出たときだけ足す）", () => {
    for (const id of ["assignments", "outside"] as const) {
      const names = MASTER_FILES[id].columns.map((c) => c.name);
      expect(names).toEqual(expect.arrayContaining(["start_date", "end_date"]));
      expect(emptyMasterText(id)).not.toContain("start_date");
    }
  });
});

describe("検証", () => {
  const ds = (a: Parameters<typeof assignment>[0]) =>
    dataset({ contracts: [contract({ contractId: "C1" })], members: [member({ memberId: "M1" })], assignments: [assignment(a)] });

  it("開始月・終了月の中の日付でない・開始日が終了日より後はエラー", () => {
    const codes = (a: Parameters<typeof assignment>[0]) => validateDataset(ds(a)).filter((i) => i.code.startsWith("PERIOD_DATE")).map((i) => i.code);
    expect(codes({ memberId: "M1", contractId: "C1", startMonth: M, startDate: "2026-11-16" })).toEqual([]);
    expect(codes({ memberId: "M1", contractId: "C1", startMonth: M, startDate: "2026-12-16" })).toEqual(["PERIOD_DATE_INVALID"]);
    expect(codes({ memberId: "M1", contractId: "C1", endMonth: M, endDate: "2026-11-31" })).toEqual(["PERIOD_DATE_INVALID"]);
    expect(codes({ memberId: "M1", contractId: "C1", startMonth: M, endMonth: M, startDate: "2026-11-20", endDate: "2026-11-10" })).toEqual(["PERIOD_DATE_INVALID".replace("INVALID", "INVERTED")]);
    const o = dataset({ members: [member({ memberId: "M1" })], outsidePlans: [{ memberId: "M1", type: "", startMonth: M, endMonth: M, startDate: "2026-10-01", personMonths: 0.1, note: "" }] });
    expect(validateDataset(o).map((i) => i.code)).toContain("PERIOD_DATE_INVALID");
  });

  it("月の途中で案件を替えた人（13 日まで A、16 日から B、どちらも 1.0）は 1.0 超にならない", () => {
    const d = dataset({
      contracts: [contract({ contractId: "A" }), contract({ contractId: "B", projectName: "保守2" })],
      members: [member({ memberId: "M1" })],
      assignments: [assignment({ memberId: "M1", contractId: "A", startMonth: "2026-04", endMonth: M, endDate: "2026-11-13", allocation: 1 }), assignment({ memberId: "M1", contractId: "B", startMonth: M, endMonth: "2027-03", startDate: "2026-11-16", allocation: 1 })],
    });
    expect(validateDataset(d).filter((i) => i.code === "ALLOCATION_OVER_1")).toEqual([]);
    // 日付が無ければ 11 月は 2.0
    const plain = dataset({ ...d, assignments: d.assignments.map(({ startDate: _s, endDate: _e, ...a }) => a) });
    expect(validateDataset(plain).filter((i) => i.code === "ALLOCATION_OVER_1")).toHaveLength(1);
  });
});

describe("日割り", () => {
  it("端の月は営業日の割合、ほかの月は 1、期間外は 0", () => {
    const p = { startMonth: M, endMonth: "2027-01", startDate: "2026-11-16" };
    expect(periodPresenceAt(p, M, [])).toEqual({ present: 11, total: 21 });
    expect(periodShareAt(p, M, [])).toBeCloseTo(11 / 21);
    expect(periodShareAt(p, "2026-12", [])).toBe(1);
    expect(periodShareAt(p, "2026-10", [])).toBe(0);
    // 祝日も除く（11/23 を休みにすると 16 日からは 10 / 20）
    expect(periodPresenceAt(p, M, [{ date: "2026-11-23", name: "休み" }])).toEqual({ present: 10, total: 20 });
    // 同じ月に開始日と終了日
    expect(periodPresenceAt({ startMonth: M, endMonth: M, startDate: "2026-11-16", endDate: "2026-11-20" }, M, [])).toEqual({ present: 5, total: 21 });
  });

  it("valueAt: holidays を渡したときだけ日割り", () => {
    const rows = [{ startMonth: M, endMonth: "2027-03", startDate: "2026-11-16", value: 1 }];
    expect(valueAt(rows, M)).toBe(1);
    expect(valueAt(rows, M, [])).toBeCloseTo(11 / 21);
  });

  it("リソース計画（planView）: 月の合計と 1.0 超の判定は日割りした人月", () => {
    const docs = {
      teams: parseMasterDoc("teams", "team_id,name,parent_team_id,effective_from\nT1,T,,2025-04\n"),
      members: parseMasterDoc("members", "member_id,name,kind,title,department,section,team_id,effective_from\nM1,A,employee,SE,,,T1,2025-04\n"),
      assignments: parseMasterDoc("assignments", "member_id,contract_id,start_month,end_month,allocation,start_date,end_date\nM1,A,2026-04,2026-11,1,,2026-11-13\nM1,B,2026-11,2027-03,1,2026-11-16,\n"),
    };
    const src = { ...planSourcesFromDocs(docs as never, "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\nA,X,a,T1,2026-04,2027-03,1\nB,X,b,T1,2026-04,2027-03,1\n", []), holidays: [] };
    const view = planView(src, "T1", ["2026-10", M, "2026-12"]);
    const row = view.rows[0]!;
    expect(row.monthly[0]).toBe(1);
    expect(row.monthly[1]).toBeCloseTo(1);
    expect(row.monthly[2]).toBe(1);
    expect(row.overMonths).toEqual([]);
  });

  it("計画額・着地見込み（計画方式）とメンバー別の計画は日割りした人月で数える", () => {
    const d = dataset({
      contracts: [contract({ contractId: "C1", startMonth: "2026-04", endMonth: "2027-03" })],
      members: [member({ memberId: "M1", title: "SE" })],
      rates: [rate("SE", 10_000)],
      assignments: [assignment({ memberId: "M1", contractId: "C1", startMonth: M, endMonth: "2027-03", startDate: "2026-11-16", allocation: 1 })],
    });
    const model = buildModel(d, { asOf: "2026-10-27", generatedAt: "x" });
    const lines = model.contracts[0]!.assignmentPlan.lines.filter((l) => l.month === M);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.allocation).toBeCloseTo(11 / 21);
    expect(lines[0]!.hours).toBeCloseTo(11 * 8);
    expect(lines[0]!.amount).toBe(880_000);
    const dec = model.contracts[0]!.assignmentPlan.lines.find((l) => l.month === "2026-12")!;
    expect(dec.hours).toBe(weekdayHours("2026-12"));
    const mm = model.memberMonths.find((x) => x.memberId === "M1" && x.month === M)!;
    expect(mm.byContract[0]!.allocation).toBeCloseTo(11 / 21);
  });
});

describe("編集で日付を失わない", () => {
  it("月ごとの修正（editMonthAllocation）: 端の月を持つ部分に日付が残る", () => {
    const row = { startMonth: M, endMonth: "2027-03", startDate: "2026-11-16", endDate: "2027-03-15", allocation: "1" };
    expect(editMonthAllocation(row, "2027-01", "0.5", "month")).toEqual([
      { startMonth: M, endMonth: "2026-12", startDate: "2026-11-16", allocation: "1" },
      { startMonth: "2027-01", endMonth: "2027-01", allocation: "0.5" },
      { startMonth: "2027-02", endMonth: "2027-03", endDate: "2027-03-15", allocation: "1" },
    ]);
    // 日付のある月そのものの値を変えても日付は残る
    expect(editMonthAllocation(row, M, "0.5", "month")[0]).toEqual({ startMonth: M, endMonth: M, startDate: "2026-11-16", allocation: "0.5" });
  });

  it("行のまとめ直し（mergeAdjacent）: 月の途中で終わる・始まる所ではまとめない", () => {
    const r = (id: string, s: string, e: string, extra: object = {}) => ({ id, startMonth: s, endMonth: e, allocation: "1", ...extra });
    expect(mergeAdjacent([r("a", "2026-04", "2026-10", { endDate: "2026-10-15" }), r("b", M, "2027-03")]).keep.size).toBe(0);
    expect(mergeAdjacent([r("a", "2026-04", "2026-10"), r("b", M, "2027-03", { startDate: "2026-11-16" })]).keep.size).toBe(0);
    const ok = mergeAdjacent([r("a", "2026-04", "2026-10", { startDate: "2026-04-10" }), r("b", M, "2027-03", { endDate: "2027-03-15" })]);
    expect([...ok.keep.values()]).toEqual([{ startMonth: "2026-04", endMonth: "2027-03", startDate: "2026-04-10", endDate: "2027-03-15" }]);
  });

  it("期間の置き換え（replaceRange）: 残る部分・同じ端の月の新しい期間に日付が残る。指定した日付は端の月に付く", () => {
    const seg = (from: string, to: string) => [{ contractId: "C1", startMonth: from, endMonth: to }];
    const rows = [{ id: "r1", contractId: "C1", startMonth: M, endMonth: "2027-03", startDate: "2026-11-16", value: "1" }];
    const later = replaceRange(rows, "2027-01", "2027-03", "0.5", seg);
    expect(later.ok && [...later.edit.updates.values()]).toEqual([{ contractId: "C1", startMonth: M, endMonth: "2026-12", startDate: "2026-11-16", endDate: "", value: "1" }]);
    const whole = replaceRange(rows, M, "2027-03", "0.5", seg);
    expect(whole.ok && [...whole.edit.updates.values()]).toEqual([{ contractId: "C1", startMonth: M, endMonth: "2027-03", startDate: "2026-11-16", endDate: "", value: "0.5" }]);
    const given = replaceRange([], M, "2027-03", "0.2", seg, { startDate: "2026-11-20", endDate: "" });
    expect(given.ok && given.edit.adds).toEqual([{ contractId: "C1", startMonth: M, endMonth: "2027-03", startDate: "2026-11-20", endDate: "", value: "0.2" }]);
    // 日付のある行とは、同じ値でもまとめない
    const next = replaceRange([{ id: "r1", contractId: "C1", startMonth: "2026-04", endMonth: "2026-10", endDate: "2026-10-15", value: "1" }], M, "2027-03", "1", seg);
    expect(next.ok && next.edit.adds).toHaveLength(1);
  });
});

describe("同じ月の中で終わって・始まる行", () => {
  it("運用保守以外の予定: 日付が重ならなければ重複のエラーにしない", () => {
    const o = (startMonth: string, endMonth: string, extra: object) => ({ memberId: "M1", type: "提案", startMonth, endMonth, personMonths: 0.2, note: "", ...extra });
    const overlap = (plans: ReturnType<typeof o>[]) => validateDataset(dataset({ members: [member({ memberId: "M1" })], outsidePlans: plans })).filter((i) => i.code === "OUTSIDE_OVERLAP");
    expect(overlap([o("2026-04", M, { endDate: "2026-11-13" }), o(M, "2027-03", { startDate: "2026-11-16" })])).toEqual([]);
    expect(overlap([o("2026-04", M, { endDate: "2026-11-16" }), o(M, "2027-03", { startDate: "2026-11-16" })])).toHaveLength(1);
  });

  it("変更の履歴: 重なりでなく「再開」。期間の置き換えも重なりで止めない", () => {
    const rows = [
      { rowId: "a", contractId: "C1", startMonth: "2026-04", endMonth: M, endDate: "2026-11-13", value: 1 },
      { rowId: "b", contractId: "C1", startMonth: M, endMonth: "2027-03", startDate: "2026-11-20", value: 0.5 },
    ];
    expect(periodHistory(rows).map((e) => e.kind)).toEqual(["start", "restart"]);
    const seg = (from: string, to: string) => [{ contractId: "C1", startMonth: from, endMonth: to }];
    const r = replaceRange(rows.map((x) => ({ ...x, id: x.rowId, value: String(x.value) })), "2027-01", "2027-03", "0.3", seg);
    expect(r.ok).toBe(true);
  });
});
