/**
 * 年度の直書きが無いことの確認（SPEC §49）: 計算基準日を翌年度以降にしても、ダミーデータの生成・検証・計算・
 * 期間プリセットが同じ形で通る。基準日 2026-10-27 の結果（tests/integration/dummy-data.test.ts）と同じ内訳になることを見る。
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generate, writeDummy } from "../../scripts/generate-dummy.js";
import { loadDataset } from "../../scripts/lib/load.js";
import { fiscalYearMonths, monthRange } from "../../src/core/calendar.js";
import { buildModel } from "../../src/core/model.js";
import { hasErrors, validateDataset } from "../../src/core/validate.js";
// @ts-expect-error -- 画面側の JS モジュール（型定義なし）
import { defaultPeriod, periodPresets } from "../../src/components/state.js";

const REPO = join(import.meta.dirname, "..", "..");
const BASE_AS_OF = "2026-10-27";
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const countBy = (codes: string[]): Record<string, number> => codes.reduce<Record<string, number>>((a, c) => ((a[c] = (a[c] ?? 0) + 1), a), {});

/** 文字列中の年を n 年ずらす（年月・年度の表記ごと） */
function shiftYears<T>(rows: T[], n: number): T[] {
  return JSON.parse(JSON.stringify(rows).replace(/(?<!\d)20\d\d(?!\d)/g, (y) => String(Number(y) + n))) as T[];
}

function build(asOf: string) {
  const root = mkdtempSync(join(tmpdir(), "yojitsu-fy-"));
  dirs.push(root);
  cpSync(join(REPO, "config.json"), join(root, "config.json"));
  writeDummy({ seed: 42, asOf, outDir: join(root, "data") });
  const { dataset } = loadDataset(root);
  return { dataset, model: buildModel(dataset, { asOf, generatedAt: `${asOf}T00:00:00Z` }), issues: validateDataset(dataset) };
}

describe("基準日を翌年度（2027-10-27）にしても同じ形で通る", () => {
  const base = build(BASE_AS_OF);
  const next = build("2027-10-27");

  it("年度・年度の 12 か月・データの月の範囲が 1 年後ろへずれる", () => {
    expect(next.model.meta.fiscalYear).toBe(2027);
    expect(next.model.meta.fiscalYearMonths).toEqual(fiscalYearMonths(2027, 4));
    expect(next.model.meta.minMonth).toBe("2025-04");
    expect(next.model.meta.maxMonth).toBe("2029-03");
    expect(base.model.meta.minMonth).toBe("2024-04");
  });

  it("検証はエラー 0 件、警告の内訳は基準日 2026-10-27 と同じ。祝日表は足りている", () => {
    expect(hasErrors(next.issues)).toBe(false);
    expect(countBy(next.issues.map((i) => i.code))).toEqual(countBy(base.issues.map((i) => i.code)));
    expect(countBy(next.model.warnings.map((w) => w.code))).toEqual(countBy(base.model.warnings.map((w) => w.code)));
    expect(next.model.warnings.some((w) => w.code === "HOLIDAYS_AUTO")).toBe(false);
    // 単価なしの人は前年度 4 月〜基準月の全月
    const months = new Set(next.issues.filter((i) => i.code === "RATE_MISSING").map((i) => String(i.ref?.month)));
    expect([...months].sort()).toEqual(monthRange("2026-04", "2027-10"));
  });

  it("基本シナリオのマスタ・契約・アサインは、年を 1 つ足しただけで同じ", () => {
    const a = generate({ seed: 42, asOf: BASE_AS_OF, scale: "base" });
    const b = generate({ seed: 42, asOf: "2027-10-27", scale: "base" });
    for (const key of ["teams", "members", "rates", "contracts", "assignments", "outsidePlans"] as const) {
      expect(b[key], key).toEqual(shiftYears(a[key] as unknown[], 1));
    }
  });

  it("実運用規模の契約も期間は 1 年後ろへずれる（金額は工数から決めるので見ない）", () => {
    const pick = (rows: Array<{ contract_id: string; start_month: string; end_month: string }>) => rows.map(({ contract_id, start_month, end_month }) => ({ contract_id, start_month, end_month }));
    expect(pick(generate({ seed: 42, asOf: "2027-10-27" }).contracts)).toEqual(shiftYears(pick(generate({ seed: 42, asOf: BASE_AS_OF }).contracts), 1));
  });

  it("期間の既定・プリセットは基準日の年度（今年度 2027・前年度 2026）", () => {
    expect(defaultPeriod(next.model)).toEqual({ from: "2027-04", to: "2028-03" });
    const presets = Object.fromEntries(periodPresets(next.model).map((p: { id: string; label: string; period: unknown }) => [p.id, p]));
    expect(presets.fy.period).toEqual({ from: "2027-04", to: "2028-03" });
    expect(presets.fy.label).toContain("2027");
    expect(presets.prevFy.period).toEqual({ from: "2026-04", to: "2027-03" });
    expect(presets.prevFy.label).toContain("2026");
    expect(presets.thisMonth.period).toEqual({ from: "2027-10", to: "2027-10" });
  });
});

describe("年度の初め（2028-05-15）でも通る", () => {
  const early = build("2028-05-15");
  it("今年度は 2028、作業実績は前年度 4 月から基準日まで", () => {
    expect(hasErrors(early.issues)).toBe(false);
    expect(early.model.meta.fiscalYear).toBe(2028);
    const months = [...new Set(early.dataset.worklogs.map((w) => w.date.slice(0, 7)))].sort();
    expect(months[0]).toBe("2027-04");
    expect(months.at(-1)).toBe("2028-05");
    expect(early.model.warnings.some((w) => w.code === "HOLIDAYS_AUTO")).toBe(false);
  });
});
