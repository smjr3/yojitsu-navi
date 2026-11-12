/**
 * 目標（SPEC §63）: targets.csv の読み込み・検証・評価（達成／未達／達成見込み／未達見込み）・一覧に出す 1 件
 */
import { describe, expect, it } from "vitest";
import { buildModel } from "../../src/core/model.js";
import { parseDataset, parsePercentCell, type DatasetFiles } from "../../src/core/csv.js";
import { evaluateTarget, headlineTarget, isUsableTarget, targetContractIds, targetStartMonth, targetsOf } from "../../src/core/targets.js";
import type { Target } from "../../src/core/types.js";
import { baseConfig, budgetIn, contract } from "./fixtures.js";

const HEADER = "target_type,target_id,end_month,remaining_rate,start_month,note\n";

/** 年 1,200 万円の予算（12 か月、営業日で按分 §118）、2026-04〜2026-09 に毎月 100 時間 × 5,000 円 = 50 万円の実績。基準日 2026-10-15 */
function files(targets?: string): DatasetFiles {
  const worklogs = ["04", "05", "06", "07", "08", "09"].map((m) => `date,member_id,member_name,customer_name,project_name,task,hours\n2026-${m}-10,M1,山田,A社,保守,定例,100\n`);
  return {
    config: baseConfig,
    contracts:
      "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\n" +
      "C1,A社,保守,T1,2026-04,2027-03,12000000\n" +
      "C2,Ｂ商事,運用,T2,2026-04,2027-03,12000000\n",
    mapping: "worklog_customer_name,worklog_project_name,contract_id\nA社,,C1\n",
    assignments: "member_id,contract_id,start_month,end_month,allocation\n",
    teams: "team_id,name,parent_team_id,effective_from\nHQ,本部,,2025-04\nT1,開発,HQ,2025-04\nT2,運用,HQ,2025-04\n",
    members: "member_id,name,kind,title,department,section,team_id,effective_from\nM1,山田,employee,SE,,,T1,2025-04\n",
    rates: "key,hourly_rate,effective_from\nSE,5000,2025-04\n",
    holidays: "date,name\n",
    worklogs,
    worklogNames: worklogs.map((_, i) => `2026-0${4 + i}.csv`),
    ...(targets === undefined ? {} : { targets }),
  };
}
const codes = (text: string) => parseDataset(files(text)).issues.filter((i) => i.file === "targets.csv").map((i) => `${i.code}@${i.row}`);
const modelOf = (text: string) => buildModel(parseDataset(files(text)).dataset, { asOf: "2026-10-15", generatedAt: "t" });
const target = (o: Partial<Target>): Target => ({ kind: "team", targetId: "T1", startMonth: "", endMonth: "2027-03", remainingRate: 0.2, note: "", ...o });

describe("目標の読み込み", () => {
  it("省略・空・見出しだけなら無し", () => {
    for (const t of [undefined, "", HEADER]) {
      const r = parseDataset(files(t));
      expect(r.dataset.targets).toBeUndefined();
      expect(r.issues.filter((i) => i.file === "targets.csv")).toEqual([]);
    }
  });

  it("残予算率は % の数値（20・20%・全角）を割合にする。開始月・メモは省略できる", () => {
    const r = parseDataset(files("target_type,target_id,end_month,remaining_rate\nteam,T1,2027-03,20\ncustomer,A社,2027-03,１５％\n"));
    expect(r.dataset.targets).toEqual([
      { kind: "team", targetId: "T1", startMonth: "", endMonth: "2027-03", remainingRate: 0.2, note: "" },
      { kind: "customer", targetId: "A社", startMonth: "", endMonth: "2027-03", remainingRate: 0.15, note: "" },
    ]);
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(parsePercentCell("-5")).toBe(-0.05);
    // 超過を減らす目標（マイナス）: 全角・数学のマイナス・会計の ▲ / △ も負の数
    for (const neg of ["-50", "－50", "\u221250", "▲50", "△50%", "▲ 50"]) expect(parsePercentCell(neg)).toBe(-0.5);
    for (const bad of ["", "abc", "1,5", "%"]) expect(parsePercentCell(bad)).toBeNaN();
  });

  it("必須列が無ければ MISSING_COLUMN", () => {
    expect(codes("target_type,target_id,end_month\nteam,T1,2027-03\n")).toContain("MISSING_COLUMN@1");
  });
});

describe("目標の検証", () => {
  it("種類・対象・月・逆順・率の誤りはエラー、見つからない対象は警告", () => {
    expect(
      codes(
        HEADER +
          "group,T1,2027-03,20,,\n" + // 2: 種類
          "team,,2027-03,20,,\n" + // 3: 対象なし
          "team,T9,2027-03,20,,\n" + // 4: 無いチーム（警告）
          "team,T1,2027-3,20,,\n" + // 5: 終了月
          "team,T1,2027-03,20,2027-04,\n" + // 6: 開始月が終了月より後
          "team,T1,2026-12,abc,,\n" + // 7: 率が数値でない
          "team,T1,2026-11,120,,\n" + // 8: 100% 超
          "customer,Ｃ社,2027-03,20,,\n" + // 9: 無い顧客（警告）
          "project,C9,2027-03,20,,\n", // 10: 無い案件（警告）
      ),
    ).toEqual(["TARGET_INVALID_KIND@2", "TARGET_MISSING_ID@3", "TARGET_UNKNOWN@4", "INVALID_MONTH@5", "TARGET_PERIOD_INVERTED@6", "TARGET_RATE_INVALID@7", "TARGET_RATE_INVALID@8", "TARGET_UNKNOWN@9", "TARGET_UNKNOWN@10"]);
  });

  it("同じ対象・同じ終了月は重複エラー（顧客名は正規化して比べる）。終了月が違えば別の目標", () => {
    expect(codes(`${HEADER}customer,Ｂ商事,2027-03,20,,\ncustomer,B商事,2027-03,10,,\ncustomer,B商事,2026-09,10,,\n`)).toEqual(["TARGET_DUPLICATE@3"]);
    expect(codes(`${HEADER}team,T1,2026-09,20,,\nteam,T1,2027-03,20,,\nproject,C1,2027-03,20,,\n`)).toEqual([]);
  });
});

describe("目標の評価", () => {
  const model = modelOf("");

  it("期間の開始は空なら終了月を含む年度の最初の月", () => {
    expect(targetStartMonth({ startMonth: "", endMonth: "2027-03" }, 4)).toBe("2026-04");
    expect(targetStartMonth({ startMonth: "", endMonth: "2026-04" }, 4)).toBe("2026-04");
    expect(targetStartMonth({ startMonth: "2025-10", endMonth: "2027-03" }, 4)).toBe("2025-10");
    expect(isUsableTarget(target({ startMonth: "2027-04" }), 4)).toBe(false);
    expect(isUsableTarget(target({ kind: "x" }), 4)).toBe(false);
    expect(isUsableTarget(target({ remainingRate: Number.NaN }), 4)).toBe(false);
  });

  it("対象の案件: チームは配下を含む、顧客は名前を正規化、案件は契約ID", () => {
    expect(targetContractIds(model, "team", "HQ")).toEqual(["C1", "C2"]);
    expect(targetContractIds(model, "team", "T1")).toEqual(["C1"]);
    expect(targetContractIds(model, "customer", "B商事")).toEqual(["C2"]);
    expect(targetContractIds(model, "project", "C1")).toEqual(["C1"]);
    expect(targetContractIds(model, "project", "C9")).toEqual([]);
  });

  it("終了月が過ぎた目標は実績で確定（ちょうど目標なら達成）", () => {
    // 2026-04〜09: 予算（約 600 万）、実績 300 万 → 残予算率 約 50%
    const budget = budgetIn(contract({ contractId: "C1", startMonth: "2026-04", endMonth: "2027-03", totalAmount: 12_000_000 }), "2026-04", "2026-09");
    const rate = 1 - 3_000_000 / budget;
    const ok = evaluateTarget(model, target({ endMonth: "2026-09", remainingRate: rate }), "recent3");
    expect(ok).toMatchObject({ period: { from: "2026-04", to: "2026-09" }, contractIds: ["C1"], budget, actualCost: 3_000_000, forecastCost: 3_000_000, settled: true, status: "achieved" });
    expect(ok.rate).toBeCloseTo(rate);
    expect(evaluateTarget(model, target({ endMonth: "2026-09", remainingRate: rate + 0.01 }), "recent3").status).toBe("missed");
  });

  it("終了月が先の目標は着地見込みで判定（方式で変わる）", () => {
    // 直近 3 か月平均 50 万 × 残り 6 か月 = 300 万 → 着地 600 万 / 予算 1,200 万 → 50%
    const ev = evaluateTarget(model, target({ remainingRate: 0.4 }), "recent3");
    expect(ev).toMatchObject({ settled: false, status: "onTrack", budget: 12_000_000, actualCost: 3_000_000, forecastCost: 6_000_000 });
    expect(ev.gap).toBeCloseTo(0.1);
    expect(evaluateTarget(model, target({ remainingRate: 0.55 }), "recent3").status).toBe("atRisk");
    // 計画値（アサインなし）は残りの見込み 0 → 着地 300 万 → 75%
    expect(evaluateTarget(model, target({ remainingRate: 0.55 }), "assignment").rate).toBeCloseTo(0.75);
  });

  it("マイナスの目標（超過を減らす）: 残予算率が目標以上なら達成。検証エラーにもならない", () => {
    // 2026-04〜09: 予算 600 万、実績 300 万 → 50%。-50% の目標は達成、60% は未達
    expect(evaluateTarget(model, target({ endMonth: "2026-09", remainingRate: -0.5 }), "recent3")).toMatchObject({ status: "achieved" });
    expect(codes(`${HEADER}team,T1,2027-03,-100,,\nproject,C1,2027-03,▲50,,\n`)).toEqual([]);
    // 超過している対象: 予算の 2 倍使う（月 200 万の実績）と残予算率 -100%。-50% の目標は未達、-150% は達成
    const over = modelOf("");
    for (const r of over.contracts) for (const mm of r.months) if (mm.month <= "2026-09" && r.contract.contractId === "C1") mm.cost = mm.budget * 2;
    expect(evaluateTarget(over, target({ endMonth: "2026-09", remainingRate: -0.5 }), "recent3").rate).toBeCloseTo(-1);
    expect(evaluateTarget(over, target({ endMonth: "2026-09", remainingRate: -0.5 }), "recent3").status).toBe("missed");
    expect(evaluateTarget(over, target({ endMonth: "2026-09", remainingRate: -1.5 }), "recent3").status).toBe("achieved");
  });

  it("予算 0（対象の案件が無い・期間外）は「予算なし」", () => {
    expect(evaluateTarget(model, target({ kind: "project", targetId: "C9" }), "recent3")).toMatchObject({ rate: null, gap: null, status: "noBudget" });
    expect(evaluateTarget(model, target({ endMonth: "2025-12", startMonth: "2025-06" }), "recent3")).toMatchObject({ status: "noBudget", contractIds: [] });
  });

  it("targetsOf は計算できる目標だけを終了月の順に。一覧の 1 件は基準月以降で最も近い終了月、無ければ最後", () => {
    const m = modelOf(`${HEADER}team,T1,2027-03,20,,\nteam,T1,2026-09,20,,\nteam,T1,abc,20,,\ncustomer,b商事,2027-03,20,,\n`);
    expect(targetsOf(m, "team", "T1").map((t) => t.endMonth)).toEqual(["2026-09", "2027-03"]);
    expect(targetsOf(m, "customer", "Ｂ商事")).toHaveLength(1);
    expect(targetsOf(m, "team", "T2")).toEqual([]);
    const list = targetsOf(m, "team", "T1");
    expect(headlineTarget(list, "2026-10")?.endMonth).toBe("2027-03");
    expect(headlineTarget(list, "2027-04")?.endMonth).toBe("2027-03");
    expect(headlineTarget(list, "2026-05")?.endMonth).toBe("2026-09");
    expect(headlineTarget([], "2026-10")).toBeNull();
  });
});
