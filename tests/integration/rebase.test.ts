/**
 * 計算基準日の置き換え（SPEC §75）: ビルドした日の Model を、画面で開いた人の今日に置き換える。
 * 置き換えた Model は、その日にビルドした Model と（作業ログから作る値はそのままで）同じになる。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { buildModel } from "../../src/core/model.js";
import { addMonths, isWorklogStale, rebaseModel, todayJst, viewerAsOf } from "../../src/core/index.js";
import type { Dataset, Model } from "../../src/core/types.js";
import { loadDataset } from "../../scripts/lib/load.js";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..");
const BASE = "2026-10-27";
const GEN = `${BASE}T00:00:00Z`;

/** BASE から n 日後（YYYY-MM-DD） */
function plusDays(n: number): string {
  const [y, m, d] = BASE.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

let dataset: Dataset;
let base: Model;
beforeAll(() => {
  dataset = loadDataset(REPO).dataset;
  base = buildModel(dataset, { asOf: BASE, generatedAt: GEN });
});

/** 比べる値（作業ログ明細・警告・生成時刻は除く） */
function comparable(m: Model) {
  return {
    meta: { ...m.meta, generatedAt: null, asOfFixed: undefined },
    contracts: m.contracts.map((r) => ({
      id: r.contract.contractId,
      status: r.months.map((cm) => `${cm.month}:${cm.status}`),
      forecasts: r.forecasts,
      plan: r.assignmentPlan,
    })),
    teamTree: m.teamTree,
    rootTeamIds: m.rootTeamIds,
  };
}

describe("rebaseModel", () => {
  it.each([
    ["同じ月の数日後（取り込みが止まった）", 4],
    ["翌月（工数の確定日の前後）", 6],
    ["翌月の確定日の後", 10],
    ["2 か月後", 45],
    ["翌年度", 170],
  ])("%s: その日にビルドした Model と同じ", (_label, days) => {
    const asOf = plusDays(days);
    const rebased = rebaseModel(base, asOf);
    const fresh = buildModel(dataset, { asOf, generatedAt: GEN });
    expect(comparable(rebased)).toEqual(comparable(fresh));
  });

  it("同じ日なら元の Model をそのまま返し、元の Model は変えない", () => {
    expect(rebaseModel(base, BASE)).toBe(base);
    const before = JSON.stringify(comparable(base));
    rebaseModel(base, plusDays(40));
    expect(JSON.stringify(comparable(base))).toBe(before);
  });

  it("実績・予算（作業ログから作る値）と取得日時は変わらない", () => {
    const rebased = rebaseModel(base, plusDays(40));
    expect(rebased.meta.worklogFetchedAt).toBe(base.meta.worklogFetchedAt);
    rebased.contracts.forEach((r, i) => {
      expect(r.months.map((m) => [m.cost, m.budget, m.hours])).toEqual(base.contracts[i]!.months.map((m) => [m.cost, m.budget, m.hours]));
    });
  });

  it("不正な日付は受け付けない", () => {
    expect(() => rebaseModel(base, "2026-13-01")).toThrow(RangeError);
  });
});

describe("viewerAsOf", () => {
  const now = new Date(Date.UTC(2026, 10, 3, 16, 0)); // 日本時間では 11 月 4 日 1 時
  it("固定していなければ日本時間の今日（端末のタイムゾーンに依らない）", () => {
    expect(todayJst(now)).toBe("2026-11-04");
    expect(viewerAsOf({ asOf: BASE }, now)).toBe("2026-11-04");
  });
  it("YOJITSU_AS_OF で固定したビルドはそのまま", () => {
    expect(viewerAsOf({ asOf: BASE, asOfFixed: true }, now)).toBe(BASE);
  });
  it("端末の時計がビルドした日より前でも、ビルドした日より前に戻さない", () => {
    expect(viewerAsOf({ asOf: "2026-11-10" }, now)).toBe("2026-11-10");
  });
  it("基準月が進むと期間の既定（今月）も進む", () => {
    const rebased = rebaseModel(base, viewerAsOf({ asOf: BASE }, now));
    expect(rebased.meta.asOfMonth).toBe(addMonths(base.meta.asOfMonth, 1));
  });
});

describe("isWorklogStale", () => {
  it("最後の取得が今日か昨日（日本時間）なら止まっていない、それより前なら止まっている", () => {
    // 2026-10-26T22:00Z = 日本時間 10 月 27 日 7 時
    const meta = { worklogFetchedAt: "2026-10-26T22:00:00Z" };
    expect(isWorklogStale({ ...meta, asOf: "2026-10-27" })).toBe(false);
    expect(isWorklogStale({ ...meta, asOf: "2026-10-28" })).toBe(false);
    expect(isWorklogStale({ ...meta, asOf: "2026-10-29" })).toBe(true);
    // 月をまたぐ
    expect(isWorklogStale({ worklogFetchedAt: "2026-10-30T15:30:00Z", asOf: "2026-11-01" })).toBe(false);
    expect(isWorklogStale({ worklogFetchedAt: "2026-10-30T14:30:00Z", asOf: "2026-11-01" })).toBe(true);
  });
  it("取得したことが無い・日時が壊れているときは止まっていない扱い（「未取得」と出す）", () => {
    expect(isWorklogStale({ worklogFetchedAt: null, asOf: BASE })).toBe(false);
    expect(isWorklogStale({ worklogFetchedAt: "x", asOf: BASE })).toBe(false);
  });
});
