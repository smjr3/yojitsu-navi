/**
 * メンバー別（§18）の性能: perf.test.ts と同じ規模（作業ログ 5 万件 × 契約 100 件 × 200 人）に
 * アサイン 400 行を加えても Model 構築が同じ予算（2 秒）に収まり、メンバー月の構築と集計が軽いこと。
 */
import { describe, expect, it } from "vitest";
import { buildModel } from "../../src/core/model.js";
import { createMasterIndex } from "../../src/core/masters.js";
import { aggregateMembers, buildMemberMonths, memberMonthlySeries } from "../../src/core/members.js";
import { createMonthHours } from "../../src/core/monthHours.js";
import type { Assignment, Contract, MappingRule, MemberRecord, Worklog } from "../../src/core/types.js";
import { dataset, rate, team } from "./fixtures.js";
import { measure } from "../test-env.js";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function bigDataset(contractCount: number, worklogCount: number, assignmentCount: number) {
  const rnd = lcg(42);
  const contracts: Contract[] = [];
  const mappings: MappingRule[] = [];
  for (let i = 0; i < contractCount; i++) {
    const id = `C${String(i).padStart(4, "0")}`;
    const startYear = 2025 + Math.floor(rnd() * 2);
    const startMonth = `${startYear}-${String(1 + Math.floor(rnd() * 12)).padStart(2, "0")}`;
    contracts.push({ contractId: id, customerName: `顧客${i}`, projectName: `案件${i}`, teamId: `T${i % 10}`, startMonth, endMonth: `${startYear + 1}-${startMonth.slice(5)}`, totalAmount: Math.floor(rnd() * 10_000_000) });
    mappings.push({ worklogCustomerName: `顧客${i}`, worklogProjectName: "", contractId: id });
  }
  const members: MemberRecord[] = Array.from({ length: 200 }, (_, i) => ({ memberId: `M${i}`, name: `名前${i}`, kind: "employee", title: `T${i % 5}`, department: "", section: "", teamId: `T${i % 10}`, effectiveFrom: "2000-01" }));
  const worklogs: Worklog[] = [];
  for (let i = 0; i < worklogCount; i++) {
    const c = Math.floor(rnd() * contractCount);
    const year = 2025 + Math.floor(rnd() * 3);
    const month = 1 + Math.floor(rnd() * 12);
    const day = 1 + Math.floor(rnd() * 28);
    worklogs.push({ date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, memberId: `M${Math.floor(rnd() * 200)}`, memberName: "", customerName: `顧客${c}`, projectName: "", task: "", hours: 0.25 * (1 + Math.floor(rnd() * 32)) });
  }
  const assignments: Assignment[] = [];
  for (let i = 0; i < assignmentCount; i++) {
    const c = contracts[Math.floor(rnd() * contractCount)]!;
    assignments.push({ memberId: `M${Math.floor(rnd() * 200)}`, contractId: c.contractId, startMonth: c.startMonth, endMonth: c.endMonth, allocation: 0.1 * (1 + Math.floor(rnd() * 5)) });
  }
  return dataset({
    contracts,
    mappings,
    members,
    assignments,
    rates: Array.from({ length: 5 }, (_, i) => rate(`T${i}`, 3000 + i * 500)),
    teams: Array.from({ length: 10 }, (_, i) => team(`T${i}`, null)),
    worklogs,
  });
}

describe("性能（メンバー別）", () => {
  it("作業ログ 5 万件 × 契約 100 件 × アサイン 400 行の Model 構築（メンバー月を含む）が 2 秒以内、メンバー月の構築だけなら 300ms 以内", () => {
    const ds = bigDataset(100, 50_000, 400);
    // 時間の判定は実行環境に合わせる（tests/test-env.ts の measure）
    const model = measure("Model 構築（メンバー月を含む）", 2000, () => buildModel(ds, { asOf: "2026-10-27" }));
    expect(model.memberMonths.length).toBeGreaterThan(4000);

    const masters = createMasterIndex(ds);
    const again = measure("メンバー月の構築", 300, () => buildMemberMonths(model.contracts, ds.assignments, masters, createMonthHours(ds.holidays, ds.config.hoursPerBusinessDay)));
    expect(again).toEqual(model.memberMonths);
  });

  it("集計は Model に対して高速（aggregateMembers 200 回 ＋ 月次推移 200 人分で 2 秒以内）", () => {
    const model = buildModel(bigDataset(100, 20_000, 400), { asOf: "2026-10-27" });
    const period = { from: "2026-04", to: "2027-03" };
    measure("メンバー別の集計", 2000, () => {
      for (let i = 0; i < 200; i++) aggregateMembers(model, i % 2 ? { period, teamIds: ["T1", "T2"] } : { period });
      for (let i = 0; i < 200; i++) memberMonthlySeries(model, `M${i}`, period);
    });
  });
});
