/**
 * リソース計画の変更の影響（SPEC §65）: 保存前に、案件の着地見込み（計画値）・残予算・目標が前後でどう変わるか
 */
import { describe, expect, it } from "vitest";
import { buildModel } from "../../src/core/model.js";
import { parseDataset, type DatasetFiles } from "../../src/core/csv.js";
import { createMasterIndex } from "../../src/core/masters.js";
import { fiscalYearMonths } from "../../src/core/calendar.js";
import { planImpact, type PlanInputs } from "../../src/core/planImpact.js";
import { baseConfig } from "./fixtures.js";

const A_HEADER = "member_id,contract_id,start_month,end_month,allocation\n";

/** C1・C2 は 2026-04〜2027-09（月 100 万円）、C3 は計画なし。M1 = SE 5,000 円、M2 = PM 8,000 円。基準日 2026-10-15 */
function files(assignments: string, targets?: string): DatasetFiles {
  return {
    config: baseConfig,
    contracts:
      "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\n" +
      "C1,A社,保守,T1,2026-04,2027-09,18000000\n" +
      "C2,Ｂ商事,運用,T2,2026-04,2027-09,18000000\n" +
      "C3,A社,監視,T1,2026-04,2027-03,12000000\n",
    mapping: "worklog_customer_name,worklog_project_name,contract_id\n",
    assignments: A_HEADER + assignments,
    teams: "team_id,name,parent_team_id,effective_from\nHQ,本部,,2025-04\nT1,開発,HQ,2025-04\nT2,運用,HQ,2025-04\n",
    members: "member_id,name,kind,title,department,section,team_id,effective_from\nM1,山田,employee,SE,,,T1,2025-04\nM2,佐藤,employee,PM,,,T2,2025-04\n",
    rates: "key,hourly_rate,effective_from\nSE,5000,2025-04\nPM,8000,2025-04\n",
    holidays: "date,name\n",
    worklogs: [],
    ...(targets === undefined ? {} : { targets }),
  };
}
const BASE = "M1,C1,2026-04,2027-09,0.5\nM2,C2,2026-04,2027-09,0.5\n";
const inputs = (assignments: string): PlanInputs => {
  const ds = parseDataset(files(assignments)).dataset;
  return { masters: createMasterIndex(ds), assignments: ds.assignments };
};
const modelOf = (targets?: string) => buildModel(parseDataset(files(BASE, targets)).dataset, { asOf: "2026-10-15", generatedAt: "t" });
const FY = fiscalYearMonths(2026, 4);
const std = baseConfig.standardHoursPerMonth;

describe("planImpact", () => {
  it("変更が無ければ何も出さない", () => {
    const r = planImpact(modelOf(), inputs(BASE), inputs(BASE), FY);
    expect(r.rows).toEqual([]);
    expect(r.targets).toEqual([]);
  });

  it("配分を上げると、期間の残り月と案件終了までの計画値の分だけ着地が増え、残予算が減る。前の値は画面の値と同じ", () => {
    const model = modelOf();
    const after = "M1,C1,2026-04,2026-12,0.5\nM1,C1,2027-01,2027-09,1.0\nM2,C2,2026-04,2027-09,0.5\n";
    const r = planImpact(model, inputs(BASE), inputs(after), FY);
    expect(r.rows.map((x) => x.contractId)).toEqual(["C1"]);
    const row = r.rows[0]!;
    // 期間（年度）では 2027-01〜03 の 3 か月、終了時点では 2027-01〜09 の 9 か月 × 0.5 人月 × 5,000 円
    expect(row.after.forecastCost - row.before.forecastCost).toBe(3 * 0.5 * std * 5000);
    expect(row.endAfter.forecastCost - row.endBefore.forecastCost).toBe(9 * 0.5 * std * 5000);
    expect(row.before.forecastCost).toBe(model.contracts[0]!.forecasts.assignment.forecastCost);
    expect(row.after.forecastGrossProfit).toBe(row.before.forecastGrossProfit - 3 * 0.5 * std * 5000);
    expect(row.customerName).toBe("A社");
  });

  it("期間の外の月だけ変えたときも、案件終了時点が変われば出す", () => {
    const after = "M1,C1,2026-04,2027-03,0.5\nM1,C1,2027-04,2027-09,0.2\nM2,C2,2026-04,2027-09,0.5\n";
    const r = planImpact(modelOf(), inputs(BASE), inputs(after), FY);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.after.forecastCost).toBe(r.rows[0]!.before.forecastCost);
    expect(r.rows[0]!.endAfter.forecastCost).toBeLessThan(r.rows[0]!.endBefore.forecastCost);
  });

  it("過去の月だけの変更（実績で確定）は影響なし。人を差し替えて単価が同じなら出さない", () => {
    expect(planImpact(modelOf(), inputs(BASE), inputs("M1,C1,2026-04,2026-06,0.9\nM1,C1,2026-07,2027-09,0.5\nM2,C2,2026-04,2027-09,0.5\n"), FY).rows).toEqual([]);
  });

  it("計画の無い案件に人を入れる・計画を消すと出す。着地の増減が大きい順", () => {
    const after = "M1,C1,2026-04,2027-09,0.5\nM1,C3,2026-10,2027-03,0.1\n";
    const r = planImpact(modelOf(), inputs(BASE), inputs(after), FY);
    expect(r.rows.map((x) => x.contractId)).toEqual(["C2", "C3"]);
    expect(r.rows[0]!.after.forecastCost).toBeLessThan(r.rows[0]!.before.forecastCost);
    expect(r.rows[1]!.after.forecastCost).toBeGreaterThan(r.rows[1]!.before.forecastCost);
  });

  it("変わった案件を含む目標だけ、前後の残予算率と状況を出す（終わった目標は出さない）", () => {
    const t = "target_type,target_id,end_month,remaining_rate\nproject,C1,2027-03,70\nteam,T1,2027-03,70\nteam,T2,2027-03,10\ncustomer,A社,2026-09,10\n";
    const after = "M1,C1,2026-04,2027-09,1.0\nM2,C2,2026-04,2027-09,0.5\n";
    const r = planImpact(modelOf(t), inputs(BASE), inputs(after), FY);
    expect(r.targets.map((x) => `${x.kind}:${x.before.target.targetId}`)).toEqual(["project:C1", "team:T1"]);
    const p = r.targets[0]!;
    expect(p.after.rate!).toBeLessThan(p.before.rate!);
    expect(p.before.status).toBe("onTrack");
    expect(p.after.status).toBe("atRisk");
  });
});
