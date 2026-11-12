/**
 * 在籍・不在の開始日（members.csv の任意列 status_date。SPEC §119）
 *   - CSV の読み方と検証（適用開始月の中の日付だけ）
 *   - 稼働の判定（不在になる日が月の 2 日以降なら、その月は計画・実績が無くても稼働）
 *   - 在籍の営業日の割合（リソース計画の上限・人数 × 1.0、体制図の負荷）
 *   - 不在になった日からの作業実績は警告
 *   - 写した行・人事データの取り込みで日付を引き継がない
 */
import { describe, expect, it } from "vitest";
import { parseDataset } from "../../src/core/csv.js";
import { isWorkingAt, leftDateOf, monthPresenceAt, statusDateOf, workingShareAt } from "../../src/core/masters.js";
import { MASTER_FILES, parseMasterDoc, planSourcesFromDocs } from "../../src/core/masterEdit.js";
import { planView } from "../../src/core/plan.js";
import { loadLevelOf } from "../../src/core/orgChart.js";
import { validateDataset } from "../../src/core/validate.js";
import { mergeMembers } from "../../scripts/lib/members-merge.js";
import type { MemberRecord } from "../../src/core/types.js";
import { contract, dataset, member, rate, rule, worklog } from "./fixtures.js";

// 7 月: 1 日が水曜。土日を除くと 23 営業日（祝日なしで数える）。16 日（木）より前の営業日は 11 日
const LEAVE = "2026-07-16";

function lookup(records: MemberRecord[]) {
  return (id: string, m: string) =>
    records
      .filter((r) => r.memberId === id && r.effectiveFrom <= m)
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))
      .at(-1) ?? null;
}

describe("status_date 列の読み方と検証", () => {
  const base = { config: dataset().config, contracts: "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\n", mapping: "worklog_customer_name,worklog_project_name,contract_id\n", assignments: "member_id,contract_id,start_month,end_month,allocation\n", teams: "team_id,name,parent_team_id,effective_from\nT1,T,,2025-04\n", rates: "key,hourly_rate,effective_from\n", holidays: "date,name\n", worklogs: [] };
  const HEAD = "member_id,name,kind,title,department,section,team_id,effective_from,status,status_date";

  it("列が無いファイル・空のセルは日付なし（月の初めから）", () => {
    const without = parseDataset({ ...base, members: "member_id,name,kind,title,department,section,team_id,effective_from\nM1,A,employee,一般,,,T1,2025-04\n" });
    expect(without.dataset.members[0]!.statusDate).toBeUndefined();
    const empty = parseDataset({ ...base, members: `${HEAD}\nM1,A,employee,一般,,,T1,2025-04,,\n` });
    expect(empty.dataset.members[0]!.statusDate).toBeUndefined();
  });

  it("適用開始月の中の日付なら読む。別の月・形式違いはエラー", () => {
    const ok = parseDataset({ ...base, members: `${HEAD}\nM1,A,employee,一般,,,T1,2025-04,\nM1,A,employee,一般,,,T1,2026-07,退職,${LEAVE}\n` });
    expect(ok.dataset.members[1]!.statusDate).toBe(LEAVE);
    expect(ok.issues.filter((i) => i.code === "MEMBER_STATUS_DATE_INVALID")).toEqual([]);
    for (const bad of ["2026-08-01", "2026/07/16", "2026-07-32"]) {
      const r = parseDataset({ ...base, members: `${HEAD}\nM1,A,employee,一般,,,T1,2025-04,\nM1,A,employee,一般,,,T1,2026-07,退職,${bad}\n` });
      const issue = r.issues.find((i) => i.code === "MEMBER_STATUS_DATE_INVALID");
      expect(issue, bad).toMatchObject({ severity: "error", row: 3, ref: { memberId: "M1" } });
    }
  });

  it("statusDateOf: 適用開始月の中の正しい日付だけ", () => {
    expect(statusDateOf({ effectiveFrom: "2026-07", statusDate: LEAVE })).toBe(LEAVE);
    expect(statusDateOf({ effectiveFrom: "2026-07", statusDate: "2026-08-01" })).toBeNull();
    expect(statusDateOf({ effectiveFrom: "2026-07" })).toBeNull();
  });

  it("マスタ編集のメンバーの列にある（列の無いファイルは入力したときだけ足す）", () => {
    const col = MASTER_FILES.members.columns.find((c) => c.name === "status_date")!;
    expect(col).toMatchObject({ input: "date", required: false, onlyIfPresent: true, addOnInput: true });
  });
});

describe("稼働の判定と在籍の営業日", () => {
  const active = member({ memberId: "M1", effectiveFrom: "2025-04" });

  it("不在になる日が月の 2 日以降なら、計画・実績が無くても稼働。1 日なら計画・実績があっても稼働しない", () => {
    const mid = lookup([active, member({ memberId: "M1", effectiveFrom: "2026-07", status: "left", statusDate: LEAVE })]);
    expect(isWorkingAt(mid, "M1", "2026-07", () => false)).toBe(true);
    expect(isWorkingAt(mid, "M1", "2026-08", () => true)).toBe(false);
    const first = lookup([active, member({ memberId: "M1", effectiveFrom: "2026-07", status: "left", statusDate: "2026-07-01" })]);
    expect(isWorkingAt(first, "M1", "2026-07", () => true)).toBe(false);
    // 日付なしは従来どおり（計画か実績があれば稼働）
    const plain = lookup([active, member({ memberId: "M1", effectiveFrom: "2026-07", status: "left" })]);
    expect(isWorkingAt(plain, "M1", "2026-07", () => true)).toBe(true);
    expect(isWorkingAt(plain, "M1", "2026-07", () => false)).toBe(false);
  });

  it("monthPresenceAt: 不在になる日より前・在籍になる日から の営業日。日付の無い月は null", () => {
    const leave = lookup([active, member({ memberId: "M1", effectiveFrom: "2026-07", status: "left", statusDate: LEAVE })]);
    expect(monthPresenceAt(leave, "M1", "2026-07", [])).toEqual({ present: 11, total: 23 });
    expect(monthPresenceAt(leave, "M1", "2026-06", [])).toBeNull();
    expect(monthPresenceAt(leave, "M1", "2026-08", [])).toBeNull();
    // 入社（最初の行）
    const join = lookup([member({ memberId: "M2", effectiveFrom: "2026-07", statusDate: LEAVE })]);
    expect(monthPresenceAt(join, "M2", "2026-07", [])).toEqual({ present: 12, total: 23 });
    // 復帰（不在の後の在籍の行）
    const back = lookup([active, member({ memberId: "M1", effectiveFrom: "2026-05", status: "left" }), member({ memberId: "M1", effectiveFrom: "2026-07", statusDate: LEAVE })]);
    expect(monthPresenceAt(back, "M1", "2026-07", [])).toEqual({ present: 12, total: 23 });
    // 祝日も除く（7/20 を休みにすると在籍の後半が 1 日減る）
    expect(monthPresenceAt(join, "M2", "2026-07", [{ date: "2026-07-20", name: "休み" }])).toEqual({ present: 11, total: 22 });
    // 在籍・不在が変わらない行の日付は使わない（所属の変更だけなど）
    const same = lookup([active, member({ memberId: "M1", effectiveFrom: "2026-07", teamId: "T2", statusDate: LEAVE })]);
    expect(monthPresenceAt(same, "M1", "2026-07", [])).toBeNull();
  });

  it("workingShareAt: 稼働しない月は 0、日付のある月は割合、それ以外は 1", () => {
    const leave = lookup([active, member({ memberId: "M1", effectiveFrom: "2026-07", status: "left", statusDate: LEAVE })]);
    expect(workingShareAt(leave, "M1", "2026-06", () => false, [])).toBe(1);
    expect(workingShareAt(leave, "M1", "2026-07", () => false, [])).toBeCloseTo(11 / 23);
    expect(workingShareAt(leave, "M1", "2026-08", () => true, [])).toBe(0);
  });

  it("leftDateOf: 不在になった月の行の日付", () => {
    expect(leftDateOf([active, member({ memberId: "M1", effectiveFrom: "2026-07", status: "left", statusDate: LEAVE })])).toBe(LEAVE);
    expect(leftDateOf([active, member({ memberId: "M1", effectiveFrom: "2026-07", status: "left" })])).toBeNull();
    expect(leftDateOf([active])).toBeNull();
  });

  it("体制図の負荷: 稼働できる量を超えたら over", () => {
    expect(loadLevelOf(1, 11 / 23)).toBe("over");
    expect(loadLevelOf(0.4, 0.5)).toBe("under");
    expect(loadLevelOf(0.5, 0.5)).toBe("full");
    expect(loadLevelOf(1)).toBe("full");
  });
});

describe("リソース計画（planView）", () => {
  const TEAMS = "team_id,name,parent_team_id,effective_from\nT1,保守,,2026-04\n";
  const MEMBERS = [
    "member_id,name,kind,title,department,section,team_id,effective_from,status,status_date",
    "M1,在籍,employee,一般,,,T1,2026-04,,",
    `M2,7月16日から休職,employee,一般,,,T1,2026-04,,`,
    `M2,7月16日から休職,employee,一般,,,T1,2026-07,休職,${LEAVE}`,
    `M3,7月16日入社,employee,一般,,,T1,2026-07,,${LEAVE}`,
  ].join("\n");
  const ASSIGN = ["member_id,contract_id,start_month,end_month,allocation", "M1,C1,2026-04,2026-09,1", "M2,C1,2026-04,2026-07,1"].join("\n");
  const CONTRACTS = "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\nC1,顧客,保守,T1,2026-04,2027-03,1200\n";
  const MONTHS = ["2026-06", "2026-07", "2026-08"];
  const view = () => planView({ ...planSourcesFromDocs({ teams: parseMasterDoc("teams", TEAMS), members: parseMasterDoc("members", MEMBERS), assignments: parseMasterDoc("assignments", ASSIGN) }, CONTRACTS), holidays: [] }, "T1", MONTHS);

  it("稼働できる量 capacity は在籍の営業日の割合。1.0 のままの計画は上限超（overMonths）", () => {
    const v = view();
    const row = (id: string) => v.rows.find((r) => r.memberId === id)!;
    expect(row("M1").capacity).toEqual([1, 1, 1]);
    expect(row("M2").capacity[0]).toBe(1);
    expect(row("M2").capacity[1]).toBeCloseTo(11 / 23);
    expect(row("M2").capacity[2]).toBe(0);
    expect(row("M2").presence[1]).toEqual({ present: 11, total: 23 });
    expect(row("M2").overMonths).toEqual(["2026-07"]);
    expect(row("M2")).toMatchObject({ leftFrom: "2026-07", leftDate: LEAVE });
    expect(row("M2").activeMonths).toEqual([true, true, false]);
    // 入社: 7 月は入社日からの割合、6 月は在籍しない
    expect(row("M3").capacity[0]).toBe(0);
    expect(row("M3").capacity[1]).toBeCloseTo(12 / 23);
    expect(row("M3").capacity[2]).toBe(1);
  });

  it("計画が入っているべき月（§116）: 不在になる日より前に在籍していればその月も対象", () => {
    const v = view();
    expect(v.rows.find((r) => r.memberId === "M2")!.planNeededMonths).toEqual([true, true, false]);
    expect(v.rows.find((r) => r.memberId === "M3")!.planNeededMonths).toEqual([false, true, true]);
  });
});

describe("作業実績の警告と取り込み", () => {
  it("不在になった日からの作業実績は WORKLOG_AFTER_LEFT（前日までは警告しない）", () => {
    const ds = (dates: string[]) =>
      dataset({
        contracts: [contract({ contractId: "C1", customerName: "顧客", projectName: "保守", startMonth: "2026-01", endMonth: "2026-12", totalAmount: 1_200_000 })],
        mappings: [rule("顧客", "保守", "C1")],
        members: [member({ memberId: "M1", title: "一般", effectiveFrom: "2025-04" }), member({ memberId: "M1", title: "一般", effectiveFrom: "2026-07", status: "left", statusDate: LEAVE })],
        rates: [rate("一般", 5000, "2025-04")],
        worklogs: dates.map((date) => worklog({ date, memberId: "M1", hours: 2, customerName: "顧客", projectName: "保守" })),
      });
    expect(validateDataset(ds(["2026-07-15"])).some((i) => i.code === "WORKLOG_AFTER_LEFT")).toBe(false);
    const w = validateDataset(ds(["2026-07-15", "2026-07-16", "2026-08-03"])).find((i) => i.code === "WORKLOG_AFTER_LEFT")!;
    expect(w).toMatchObject({ severity: "warning", ref: { memberId: "M1", hours: 4 } });
    expect(w.message).toContain(`${LEAVE} から不在`);
    expect(w.message).toContain("2026-07-16〜2026-08-03");
  });

  it("前月から不在の行の日付は使わない（月の初めからの実績も警告）", () => {
    const issues = validateDataset(
      dataset({
        contracts: [contract({ contractId: "C1", customerName: "顧客", projectName: "保守", startMonth: "2026-01", endMonth: "2026-12", totalAmount: 1_200_000 })],
        mappings: [rule("顧客", "保守", "C1")],
        members: [member({ memberId: "M1", title: "一般", effectiveFrom: "2025-04" }), member({ memberId: "M1", title: "一般", effectiveFrom: "2026-04", status: "left" }), member({ memberId: "M1", title: "主任", effectiveFrom: "2026-07", status: "left", statusDate: LEAVE })],
        rates: [rate("一般", 5000, "2025-04"), rate("主任", 6000, "2025-04")],
        worklogs: [worklog({ date: "2026-07-03", memberId: "M1", hours: 2, customerName: "顧客", projectName: "保守" })],
      }),
    );
    expect(issues.find((i) => i.code === "WORKLOG_AFTER_LEFT")).toMatchObject({ ref: { memberId: "M1", hours: 2 } });
  });

  it("人事データの取り込みで足す行に日付を引き継がない", () => {
    const cols = { member_id: "M1", name: "A", kind: "employee", title: "一般", department: "", section: "", team_id: "T1", effective_from: "2026-07", status: "", status_date: LEAVE };
    const r = mergeMembers([cols], [{ memberId: "M1", name: "A", kind: "employee", title: "主任" }], "2026-10");
    expect(r.rows.at(-1)).toMatchObject({ effective_from: "2026-10", title: "主任", status_date: "" });
    expect(r.rows[0]).toMatchObject({ status_date: LEAVE });
  });
});
