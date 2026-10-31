/**
 * 期間プリセット（今年度・今月・先月・今後3か月・直近12か月・前年度）と、期間の値の検証（範囲外・逆順）
 * カレンダーで選んだ日付も、URL で渡された期間も、最後は sanitize でデータ範囲に収まる
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error -- 画面側の JS モジュール（型定義なし）。node でも読み込める純粋な関数だけを使う
import { periodPresets, sanitize } from "../../src/components/state.js";

function makeModel({ asOfMonth = "2026-10", minMonth = "2025-04", maxMonth = "2027-12", fiscalYear = 2026 } = {}) {
  const fiscalYearMonths = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(fiscalYear, 3 + i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  return {
    meta: { asOfMonth, minMonth, maxMonth, fiscalYear, fiscalYearMonths },
    config: { fiscalYearStartMonth: 4, currency: { defaultUnit: "million" }, forecastMethodDefault: "recent3" },
    teams: [],
    teamTree: {},
  } as never;
}

const byId = (model: ReturnType<typeof makeModel>) => Object.fromEntries(periodPresets(model).map((p: { id: string; period: unknown }) => [p.id, p.period]));

describe("periodPresets", () => {
  it("今月は基準月の 1 か月だけ", () => {
    expect(byId(makeModel()).thisMonth).toEqual({ from: "2026-10", to: "2026-10" });
  });

  it("並びは 今年度・今月・先月・今後3か月・直近12か月・前年度（前年度は右端）", () => {
    expect(periodPresets(makeModel()).map((p: { id: string }) => p.id)).toEqual(["fy", "thisMonth", "lastMonth", "next3", "recent12", "prevFy"]);
  });

  it("先月は基準月の前の 1 か月だけ（年またぎも）", () => {
    expect(byId(makeModel()).lastMonth).toEqual({ from: "2026-09", to: "2026-09" });
    expect(byId(makeModel({ asOfMonth: "2027-01" })).lastMonth).toEqual({ from: "2026-12", to: "2026-12" });
  });

  it("基準月がデータの最初の月なら、先月はデータの最初の月に収まる", () => {
    expect(byId(makeModel({ asOfMonth: "2025-04" })).lastMonth).toEqual({ from: "2025-04", to: "2025-04" });
  });

  it("基準月がデータ範囲より後なら、今月はデータの最終月に収まる", () => {
    expect(byId(makeModel({ asOfMonth: "2028-05" })).thisMonth).toEqual({ from: "2027-12", to: "2027-12" });
  });

  it("どのプリセットも from <= to で、データ範囲に収まる", () => {
    for (const asOfMonth of ["2025-04", "2026-01", "2026-10", "2027-12"]) {
      const model = makeModel({ asOfMonth });
      for (const p of periodPresets(model)) {
        expect(p.period.from <= p.period.to, `${asOfMonth} ${p.id}`).toBe(true);
        expect(p.period.from >= "2025-04" && p.period.to <= "2027-12", `${asOfMonth} ${p.id}`).toBe(true);
      }
    }
  });

  it("今後3か月は今月から 2 か月先まで（過去の月を含まない）", () => {
    expect(byId(makeModel()).next3).toEqual({ from: "2026-10", to: "2026-12" });
  });

  it("年またぎ: 11 月の今後3か月は翌年 1 月まで", () => {
    expect(byId(makeModel({ asOfMonth: "2026-11" })).next3).toEqual({ from: "2026-11", to: "2027-01" });
  });

  it("データの最終月を越える分は最終月で止める", () => {
    expect(byId(makeModel({ asOfMonth: "2027-11" })).next3).toEqual({ from: "2027-11", to: "2027-12" });
  });
});

describe("sanitize（期間）", () => {
  const model = makeModel();
  it("範囲外の月はデータ範囲の端に収める", () => {
    expect(sanitize(model, { from: "2001-01", to: "2099-12" })).toMatchObject({ from: "2025-04", to: "2027-12" });
  });
  it("開始が終了より後なら入れ替える", () => {
    expect(sanitize(model, { from: "2026-09", to: "2026-05" })).toMatchObject({ from: "2026-05", to: "2026-09" });
  });
  it("形式が違う値（日付・13月・空）は既定の期間のまま", () => {
    for (const bad of ["2026-05-17", "2026-13", "", "abc"]) {
      expect(sanitize(model, { from: bad, to: bad }), bad).toMatchObject({ from: "2026-04", to: "2027-03" });
    }
  });
});
