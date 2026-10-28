/**
 * 閲覧画面の表示ルール（レビュー指摘 M5 / L4）
 *  - 差額に添える文は表示（丸め後）の値で判定する（SPEC §12）
 *  - メンバー別のチーム絞り込みは期間全体の人で決める
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error 画面側の JS（型定義なし）
import { varianceNote, moneySigned } from "../../src/components/format.js";
// @ts-expect-error 画面側の JS（型定義なし）
import { memberIdsInTeam } from "../../src/components/analysis.js";
import { UNASSIGNED_TEAM_ID } from "../../src/core/index.js";

describe("varianceNote: 丸め後の値で判定", () => {
  it("+40,000円 は円なら『少ない』、百万円では ±0.0 なので『計画どおり』", () => {
    expect(varianceNote(40_000, "yen")).toBe("計画より原価が少ない");
    expect(moneySigned(40_000, "m")).toBe("±0.0百万円");
    expect(varianceNote(40_000, "m")).toBe("計画どおり");
    expect(varianceNote(-40_000, "m")).toBe("計画どおり");
  });
  it("丸めても 0 にならなければ符号どおり", () => {
    expect(varianceNote(60_000, "m")).toBe("計画より原価が少ない"); // 0.1百万円
    expect(varianceNote(-60_000, "m")).toBe("計画より原価が多い");
    expect(varianceNote(1_000, "k")).toBe("計画より原価が少ない");
    expect(varianceNote(400, "k")).toBe("計画どおり"); // 0千円
  });
  it("ちょうど 0 と数値でない値", () => {
    expect(varianceNote(0, "yen")).toBe("計画どおり");
    expect(varianceNote(null, "yen")).toBe("");
    expect(varianceNote(Number.NaN, "m")).toBe("");
  });
});

describe("memberIdsInTeam: チーム絞り込み（L4）", () => {
  const tree = {
    D1: { descendantIds: ["D1", "T1", "T2"] },
    T1: { descendantIds: ["T1"] },
    T2: { descendantIds: ["T2"] },
  };
  // 期間全体で集計した人（M3 は未来月にだけアサインがある人）
  const members = [
    { memberId: "M1", teamId: "T1" },
    { memberId: "M2", teamId: "T2" },
    { memberId: "M3", teamId: "T1" },
    { memberId: "M4", teamId: null },
    { memberId: "M5", teamId: "GONE" }, // 木に無いチーム
  ];
  it("team が空なら絞らない（null）", () => {
    expect(memberIdsInTeam(members, "", tree)).toBeNull();
  });
  it("上位チームは配下を含む。期間全体の人が漏れない", () => {
    expect(memberIdsInTeam(members, "D1", tree)).toEqual(["M1", "M2", "M3"]);
    expect(memberIdsInTeam(members, "T1", tree)).toEqual(["M1", "M3"]);
  });
  it("未設定は所属が空か木に無い人", () => {
    expect(memberIdsInTeam(members, UNASSIGNED_TEAM_ID, tree)).toEqual(["M4", "M5"]);
  });
  it("木に無いチームは誰も該当しない", () => {
    expect(memberIdsInTeam(members, "NOPE", tree)).toEqual([]);
  });
});
