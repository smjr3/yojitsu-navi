/**
 * ダミーデータ全体で顧客別の束ね方を確かめる（SPEC §17）。
 * 顧客の合計 = 全体の合計、チーム絞り込みの合計 = チームの合計、重複する顧客名の揺れが 1 つに束ねられること。
 */
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { aggregate, contractsForTeam, forecastTotals, teamTreeForMonth } from "../../src/core/aggregate.js";
import { NONE_CUSTOMER_KEY, customerKey, groupByCustomer } from "../../src/core/customers.js";
import { buildModel } from "../../src/core/model.js";
import type { Model } from "../../src/core/types.js";
import { loadDataset } from "../../scripts/lib/load.js";

const REPO = join(import.meta.dirname, "..", "..");
let model: Model;

beforeAll(() => {
  model = buildModel(loadDataset(REPO).dataset, { asOf: "2026-10-27", generatedAt: "2026-10-27T00:00:00Z" });
});

const period = () => ({ from: model.meta.fiscalYearMonths[0]!, to: model.meta.fiscalYearMonths.at(-1)! });

describe("顧客別（ダミーデータ）", () => {
  it("全契約がちょうど 1 つの顧客に属する", () => {
    const groups = groupByCustomer(model.contracts.map((r) => r.contract));
    const ids = groups.flatMap((g) => g.contractIds);
    expect(ids.length).toBe(model.contracts.length);
    expect(new Set(ids).size).toBe(model.contracts.length);
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.length).toBeLessThan(model.contracts.length); // 更新契約で同じ顧客が複数契約を持つ
  });

  it("顧客の合計 = 全体の合計（予算・原価・粗利・時間・着地）", () => {
    const groups = groupByCustomer(model.contracts.map((r) => r.contract));
    const p = period();
    const whole = aggregate(model, { period: p });
    const parts = groups.map((g) => aggregate(model, { period: p, contractIds: g.contractIds }));
    for (const k of ["budget", "cost", "grossProfit", "contractCount"] as const) expect(parts.reduce((a, t) => a + t[k], 0)).toBe(whole[k]);
    expect(parts.reduce((a, t) => a + t.hours, 0)).toBeCloseTo(whole.hours, 6);
    for (const method of ["recent3", "all", "assignment"] as const) {
      const f = forecastTotals(model, undefined, method);
      const fs = groups.map((g) => forecastTotals(model, g.contractIds, method));
      expect(fs.reduce((a, t) => a + t.forecastGrossProfit, 0)).toBe(f.forecastGrossProfit);
      expect(fs.reduce((a, t) => a + t.deficitContractIds.length, 0)).toBe(f.deficitContractIds.length);
    }
  });

  it("更新契約は同じ顧客に束なる（青葉物流 = 倉庫管理の C001 + C002 ＋ 別チームの輸配送管理の契約）", () => {
    const groups = groupByCustomer(model.contracts.map((r) => r.contract));
    const aoba = groups.find((g) => g.key === customerKey("青葉物流"));
    expect(aoba?.label).toBe("青葉物流");
    const byProject = (p: string) => model.contracts.filter((r) => r.contract.customerName === "青葉物流" && r.contract.projectName === p).map((r) => r.contract.contractId);
    expect(byProject("倉庫管理システム保守")).toEqual(["C001", "C002"]);
    expect(byProject("輸配送管理システム保守").length).toBeGreaterThan(0);
    expect(aoba?.contractIds).toEqual([...byProject("倉庫管理システム保守"), ...byProject("輸配送管理システム保守")].sort());
  });

  it("チームで絞ると、顧客の契約はそのチームの契約だけになり、合計はチームの合計に一致", () => {
    const tree = teamTreeForMonth({ teams: model.teams }, model.meta.asOfMonth);
    const teamIds = contractsForTeam(model, "T211", tree).map((c) => c.contractId);
    expect(teamIds.length).toBeGreaterThan(0);
    const set = new Set(teamIds);
    const groups = groupByCustomer(model.contracts.map((r) => r.contract))
      .map((g) => ({ ...g, contractIds: g.contractIds.filter((id) => set.has(id)) }))
      .filter((g) => g.contractIds.length > 0);
    const p = period();
    const sum = groups.reduce((a, g) => a + aggregate(model, { period: p, contractIds: g.contractIds }).budget, 0);
    expect(sum).toBe(aggregate(model, { period: p, contractIds: teamIds }).budget);
  });

  it("顧客名が空の契約は「顧客名なし」に入る", () => {
    const groups = groupByCustomer([{ contractId: "X1", customerName: "" }, ...model.contracts.map((r) => r.contract)]);
    expect(groups.at(-1)!.key).toBe(NONE_CUSTOMER_KEY);
    expect(groups.at(-1)!.contractIds).toEqual(["X1"]);
  });
});
