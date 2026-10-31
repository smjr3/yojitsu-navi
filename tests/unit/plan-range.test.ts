import { describe, expect, it } from "vitest";
import {
  defaultPlanRange,
  parsePlanRange,
  PLAN_RANGE_DEFAULT_MONTHS,
  PLAN_RANGE_MAX_MONTHS,
  planRangeIncluding,
  planRangeOptions,
  serializePlanRange,
  setPlanRangeFrom,
  setPlanRangeTo,
  shiftPlanRange,
} from "../../src/core/plan";
import { addMonths, monthRange } from "../../src/core/calendar";

// 基準月は固定の年を書かず、任意の月で確かめる（§49）
const AS_OF = addMonths("2000-01", 12 * 30 + 9);
const len = (r: { from: string; to: string }) => monthRange(r.from, r.to).length;

describe("リソース計画の表示する月の範囲（§71）", () => {
  it("既定は基準月から 12 か月（未来寄り）", () => {
    const r = defaultPlanRange(AS_OF);
    expect(r.from).toBe(AS_OF);
    expect(len(r)).toBe(PLAN_RANGE_DEFAULT_MONTHS);
  });

  it("開始月を変えても終了月はそのまま。終了より後なら月数を保って後ろへ。最大を超えたら縮める", () => {
    const r = defaultPlanRange(AS_OF);
    expect(setPlanRangeFrom(r, addMonths(AS_OF, 3))).toEqual({ from: addMonths(AS_OF, 3), to: r.to });
    expect(setPlanRangeFrom(r, addMonths(AS_OF, 20))).toEqual({ from: addMonths(AS_OF, 20), to: addMonths(AS_OF, 31) });
    const wide = setPlanRangeFrom(r, addMonths(AS_OF, -30));
    expect(wide.from).toBe(addMonths(AS_OF, -30));
    expect(len(wide)).toBe(PLAN_RANGE_MAX_MONTHS);
    expect(setPlanRangeFrom(r, "bad")).toBe(r);
  });

  it("終了月を変えても開始月はそのまま。開始より前なら月数を保って前へ。最大を超えたら縮める", () => {
    const r = defaultPlanRange(AS_OF);
    expect(setPlanRangeTo(r, addMonths(AS_OF, 5))).toEqual({ from: AS_OF, to: addMonths(AS_OF, 5) });
    expect(setPlanRangeTo(r, addMonths(AS_OF, -2))).toEqual({ from: addMonths(AS_OF, -13), to: addMonths(AS_OF, -2) });
    const wide = setPlanRangeTo(r, addMonths(AS_OF, 40));
    expect(wide.to).toBe(addMonths(AS_OF, 40));
    expect(len(wide)).toBe(PLAN_RANGE_MAX_MONTHS);
    // 1 か月だけも選べる
    expect(len(setPlanRangeTo(r, AS_OF))).toBe(1);
  });

  it("ずらす・月を含める（月数はそのまま）", () => {
    const r = defaultPlanRange(AS_OF);
    expect(shiftPlanRange(r, -1)).toEqual({ from: addMonths(AS_OF, -1), to: addMonths(AS_OF, 10) });
    expect(planRangeIncluding(r, addMonths(AS_OF, 4))).toBe(r);
    expect(planRangeIncluding(r, addMonths(AS_OF, -5))).toEqual({ from: addMonths(AS_OF, -5), to: addMonths(AS_OF, 6) });
    expect(planRangeIncluding(r, addMonths(AS_OF, 15))).toEqual({ from: addMonths(AS_OF, 4), to: addMonths(AS_OF, 15) });
  });

  it("覚える形は基準月からのずれ。基準月が進むと範囲も進む。読めなければ既定", () => {
    const r = { from: addMonths(AS_OF, -1), to: addMonths(AS_OF, 5) };
    const text = serializePlanRange(r, AS_OF);
    expect(text).toBe("-1:7");
    expect(parsePlanRange(text, AS_OF)).toEqual(r);
    const next = addMonths(AS_OF, 1);
    expect(parsePlanRange(text, next)).toEqual(shiftPlanRange(r, 1));
    for (const bad of [null, "", "x", "0:0", "0:25", "999:3"]) expect(parsePlanRange(bad, AS_OF)).toEqual(defaultPlanRange(AS_OF));
  });

  it("選択肢はデータの最初の月（2 年前まで）〜 3 年先で、表示中の範囲を必ず含む", () => {
    const r = defaultPlanRange(AS_OF);
    const opts = planRangeOptions(AS_OF, addMonths(AS_OF, -6), r);
    expect(opts[0]).toBe(addMonths(AS_OF, -6));
    expect(opts.at(-1)).toBe(addMonths(AS_OF, 36));
    expect(planRangeOptions(AS_OF, addMonths(AS_OF, -100), r)[0]).toBe(addMonths(AS_OF, -24));
    const far = { from: addMonths(AS_OF, -40), to: addMonths(AS_OF, 40) };
    const o2 = planRangeOptions(AS_OF, null, far);
    expect(o2[0]).toBe(far.from);
    expect(o2.at(-1)).toBe(far.to);
  });
});
