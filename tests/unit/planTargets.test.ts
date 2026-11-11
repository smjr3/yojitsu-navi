/**
 * リソース計画の目標の警告（SPEC §110）: 今の計画（編集中は編集後）のままだと未達見込みになる目標と、目安の上限を超える月
 */
import { describe, expect, it } from "vitest";
import { buildModel } from "../../src/core/model.js";
import { parseDataset, type DatasetFiles } from "../../src/core/csv.js";
import { createMasterIndex } from "../../src/core/masters.js";
import type { PlanInputs } from "../../src/core/planImpact.js";
import { planTargetAlerts } from "../../src/core/planTargets.js";
import { baseConfig } from "./fixtures.js";

const A_HEADER = "member_id,contract_id,start_month,end_month,allocation\n";
const T_HEADER = "target_type,target_id,end_month,remaining_rate,start_month,note\n";

/** C1（T1）・C2（T2）は 2026-04〜2027-09（月 100 万円）。M1 = SE 5,000 円、M2 = PM 8,000 円。基準日 2026-10-15、作業実績なし */
function files(assignments: string, targets?: string): DatasetFiles {
  return {
    config: baseConfig,
    contracts:
      "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\n" +
      "C1,A社,保守,T1,2026-04,2027-09,18000000\n" +
      "C2,Ｂ商事,運用,T2,2026-04,2027-09,18000000\n",
    mapping: "worklog_customer_name,worklog_project_name,contract_id\n",
    assignments: A_HEADER + assignments,
    teams: "team_id,name,parent_team_id,effective_from\nHQ,本部,,2025-04\nT1,開発,HQ,2025-04\nT2,運用,HQ,2025-04\n",
    members: "member_id,name,kind,title,department,section,team_id,effective_from\nM1,山田,employee,SE,,,T1,2025-04\nM2,佐藤,employee,PM,,,T2,2025-04\n",
    rates: "key,hourly_rate,effective_from\nSE,5000,2025-04\nPM,8000,2025-04\n",
    holidays: "date,name\n",
    worklogs: [],
    ...(targets === undefined ? {} : { targets: T_HEADER + targets }),
  };
}
const BASE = "M1,C1,2026-04,2027-09,0.5\nM2,C2,2026-04,2027-09,0.1\n";
const modelOf = (targets?: string, assignments = BASE) => buildModel(parseDataset(files(assignments, targets)).dataset, { asOf: "2026-10-15", generatedAt: "t" });
const inputs = (assignments: string): PlanInputs => {
  const ds = parseDataset(files(assignments)).dataset;
  return { masters: createMasterIndex(ds), assignments: ds.assignments };
};
const all = { teamId: null };
const ids = (list: ReturnType<typeof planTargetAlerts>) => list.map((a) => `${a.kind}:${a.evaluation.target.targetId}:${a.evaluation.target.endMonth}`);
const FY_REST = ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"];

describe("planTargetAlerts", () => {
  it("目標が無ければ何も出さない", () => {
    expect(planTargetAlerts(modelOf(), null, all)).toEqual([]);
  });

  it("計画値の着地で残予算率が目標を下回る目標だけ出す（C1: 年度の予算 1,200 万円・計画 6 か月 × 40 万円 → 80%）", () => {
    const m = modelOf("project,C1,2027-03,90,,\nproject,C1,2027-09,50,2026-04,\n");
    const r = planTargetAlerts(m, null, all);
    expect(ids(r)).toEqual(["project:C1:2027-03"]);
    expect(r[0]!.evaluation.status).toBe("atRisk");
    expect(r[0]!.evaluation.rate).toBeCloseTo(0.8, 9);
    // 月の目安の上限 = 100 万円 × (1 − 90%) = 10 万円 < 計画 40 万円 → 基準月から終了月まで全部
    expect(r[0]!.overMonths).toEqual(FY_REST);
  });

  it("画面の着地見込みの方式に関係なく計画値で判定する（作業実績が無いと他の方式は着地 0 で達成見込みになる）", () => {
    const m = modelOf("project,C1,2027-03,90,,\n");
    expect(m.contracts[0]!.forecasts.recent3.forecastCost).toBe(0);
    expect(planTargetAlerts(m, null, all)).toHaveLength(1);
  });

  it("終了月が基準月より前の目標（実績で確定）は出さない", () => {
    expect(planTargetAlerts(modelOf("project,C1,2026-09,99,2026-04,\n"), null, all)).toEqual([]);
  });

  it("超える月は、その月の計画が予算 ×（1 − 目標）を超える月だけ。続いていなくてもよい", () => {
    const a = "M1,C1,2026-04,2026-11,1.0\nM1,C1,2027-02,2027-02,1.0\nM2,C2,2026-04,2027-09,0.1\n";
    const r = planTargetAlerts(modelOf("project,C1,2027-03,90,,\n", a), null, all);
    expect(r).toHaveLength(1);
    expect(r[0]!.overMonths).toEqual(["2026-10", "2026-11", "2027-02"]);
  });

  it("マイナスの目標（改善目標）は上限が予算を超える", () => {
    // C1 は 80% なので -10% の目標は達成見込み。人月を増やして着地が予算の 110% を超えると下回る
    expect(planTargetAlerts(modelOf("project,C1,2027-03,-10,,\n"), null, all)).toEqual([]);
    const r = planTargetAlerts(modelOf("project,C1,2027-03,-10,,\n"), inputs("M1,C1,2026-04,2027-09,2.0\nM2,C2,2026-04,2027-09,0.1\n"), all);
    // 6 か月 × 160 万円 = 960 万円 → 20%。まだ達成見込み
    expect(r).toEqual([]);
    const r2 = planTargetAlerts(modelOf("project,C1,2027-03,-10,,\n"), inputs("M1,C1,2026-04,2027-09,3.0\nM2,C2,2026-04,2027-09,0.1\n"), all);
    // 6 か月 × 240 万円 = 1,440 万円 → -20% < -10%。月の上限は 110 万円
    expect(ids(r2)).toEqual(["project:C1:2027-03"]);
    expect(r2[0]!.overMonths).toEqual(FY_REST);
  });

  it("編集後の計画を渡すと、その計画で判定する（編集前は達成見込みでも、増やすと未達見込み）", () => {
    const m = modelOf("project,C1,2027-03,70,,\n");
    expect(planTargetAlerts(m, null, all)).toEqual([]);
    expect(planTargetAlerts(m, inputs(BASE), all)).toEqual([]);
    const r = planTargetAlerts(m, inputs("M1,C1,2026-04,2027-09,1.0\nM2,C2,2026-04,2027-09,0.1\n"), all);
    expect(ids(r)).toEqual(["project:C1:2027-03"]);
    expect(r[0]!.evaluation.rate).toBeCloseTo(0.6, 9);
    // 減らせば消える
    expect(planTargetAlerts(modelOf("project,C1,2027-03,90,,\n"), inputs("M1,C1,2026-04,2027-09,0.1\nM2,C2,2026-04,2027-09,0.1\n"), all)).toEqual([]);
  });

  it("組織を選ぶと、その組織と配下の組織の目標、担当案件を含む顧客・案件の目標だけ（上位の組織の目標は出さない）", () => {
    const targets = "team,HQ,2027-03,95,,\nteam,T1,2027-03,95,,\nteam,T2,2027-03,95,,\ncustomer,A社,2027-03,95,,\nproject,C2,2027-03,95,,\n";
    const m = modelOf(targets);
    expect(ids(planTargetAlerts(m, null, all))).toHaveLength(5);
    expect(ids(planTargetAlerts(m, null, { teamId: "HQ" })).sort()).toEqual(["customer:A社:2027-03", "project:C2:2027-03", "team:HQ:2027-03", "team:T1:2027-03", "team:T2:2027-03"]);
    expect(ids(planTargetAlerts(m, null, { teamId: "T1" })).sort()).toEqual(["customer:A社:2027-03", "team:T1:2027-03"]);
    expect(ids(planTargetAlerts(m, null, { teamId: "T2" })).sort()).toEqual(["project:C2:2027-03", "team:T2:2027-03"]);
  });

  it("上位のチームの目標は配下の案件をまとめて判定する（T2 の余裕で T1 の超過を吸収できれば出さない）", () => {
    // C1 80%（0.5 人月）・C2 は 0.1 人月 × 8,000 円 = 12.8 万円/月 → 約 93.6%。合計 約 86.8%
    const m = modelOf("team,HQ,2027-03,85,,\nteam,T1,2027-03,85,,\n");
    expect(ids(planTargetAlerts(m, null, all))).toEqual(["team:T1:2027-03"]);
  });

  it("終了月の順に並べる", () => {
    const m = modelOf("project,C1,2027-03,90,,\nproject,C1,2026-12,90,2026-10,\n");
    expect(ids(planTargetAlerts(m, null, all))).toEqual(["project:C1:2026-12", "project:C1:2027-03"]);
  });
});
