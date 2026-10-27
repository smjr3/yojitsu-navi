import { describe, expect, it } from "vitest";
import { createEffectiveIndex, createMasterIndex, effectiveRecordAt, memberAt, rateFor, teamTreeAt } from "../../src/core/masters.js";
import { dataset, member, rate, team } from "./fixtures.js";

describe("有効レコード (SPEC §5)", () => {
  it("effectiveFrom <= m のうち最大のものを返す", () => {
    const idx = createEffectiveIndex(
      [rate("SE", 1000, "2026-01"), rate("SE", 2000, "2026-06"), rate("SE", 3000, "2027-01")],
      (r) => r.key,
      (r) => r.effectiveFrom,
    );
    expect(idx.at("SE", "2026-05")?.hourlyRate).toBe(1000);
    expect(idx.at("SE", "2026-06")?.hourlyRate).toBe(2000); // 適用開始月ちょうど
    expect(idx.at("SE", "2026-12")?.hourlyRate).toBe(2000);
    expect(idx.at("SE", "2027-01")?.hourlyRate).toBe(3000);
  });

  it("effectiveFrom > m しか無ければ null", () => {
    const idx = createEffectiveIndex([rate("SE", 1000, "2026-06")], (r) => r.key, (r) => r.effectiveFrom);
    expect(idx.at("SE", "2026-05")).toBeNull();
    expect(idx.has("SE")).toBe(true);
    expect(idx.at("PG", "2026-05")).toBeNull();
    expect(idx.has("PG")).toBe(false);
  });

  it("ファイルの並びが降順でも正しく選ぶ", () => {
    const idx = createEffectiveIndex(
      [rate("SE", 3000, "2027-01"), rate("SE", 1000, "2026-01"), rate("SE", 2000, "2026-06")],
      (r) => r.key,
      (r) => r.effectiveFrom,
    );
    expect(idx.at("SE", "2026-08")?.hourlyRate).toBe(2000);
  });

  it("同じ effectiveFrom が複数なら後の行を採用", () => {
    const idx = createEffectiveIndex(
      [rate("SE", 1000, "2026-01"), rate("SE", 1500, "2026-01")],
      (r) => r.key,
      (r) => r.effectiveFrom,
    );
    expect(idx.at("SE", "2026-03")?.hourlyRate).toBe(1500);
  });

  it("effectiveRecordAt は二分探索でも線形と同じ答え", () => {
    const list = Array.from({ length: 40 }, (_, i) => rate("k", i, `20${String(10 + Math.floor(i / 12)).padStart(2, "0")}-${String((i % 12) + 1).padStart(2, "0")}`));
    for (const m of ["2009-12", "2010-01", "2010-07", "2012-01", "2013-04", "2099-01"]) {
      const linear = [...list].filter((r) => r.effectiveFrom <= m).pop() ?? null;
      expect(effectiveRecordAt(list, m, (r) => r.effectiveFrom)).toEqual(linear);
    }
  });

  it("keys は初出順", () => {
    const idx = createEffectiveIndex([rate("b", 1), rate("a", 1), rate("b", 2, "2026-01")], (r) => r.key, (r) => r.effectiveFrom);
    expect(idx.keys()).toEqual(["b", "a"]);
  });
});

describe("時間単価 (SPEC §6)", () => {
  const ds = dataset({
    members: [
      member({ memberId: "M1", title: "SE", effectiveFrom: "2026-01" }),
      member({ memberId: "M1", title: "PM", effectiveFrom: "2026-07" }),
      member({ memberId: "M2", title: "PG", kind: "partner" }),
      member({ memberId: "M3", title: "" }),
      member({ memberId: "M4", title: "SE", effectiveFrom: "2026-10" }),
    ],
    rates: [rate("SE", 5000), rate("PM", 8000), rate("PG", 3000), rate("M2", 4000), rate("SE", 5500, "2026-09")],
  });
  const idx = createMasterIndex(ds);

  it("役職の単価を引く", () => {
    const r = rateFor(idx, "M1", "2026-04");
    expect(r).toEqual({ hourlyRate: 5000, rateSource: { key: "SE", effectiveFrom: "2000-01" }, rateMissing: false, memberUnknown: false });
  });

  it("役職の改定月ちょうど（m）と前月（m-1）", () => {
    expect(rateFor(idx, "M1", "2026-08").hourlyRate).toBe(8000); // 2026-07 から PM
    expect(rateFor(idx, "M1", "2026-06").hourlyRate).toBe(5000);
    expect(rateFor(idx, "M1", "2026-07").hourlyRate).toBe(8000);
  });

  it("単価テーブル側の改定: 2026-09 から SE は 5500", () => {
    expect(rateFor(idx, "M4", "2026-10").hourlyRate).toBe(5500);
    expect(rateFor(idx, "M4", "2026-10").rateSource).toEqual({ key: "SE", effectiveFrom: "2026-09" });
  });

  it("個人単価（パートナー）が役職より優先", () => {
    const r = rateFor(idx, "M2", "2026-04");
    expect(r.hourlyRate).toBe(4000);
    expect(r.rateSource?.key).toBe("M2");
  });

  it("役職が無い／役職に単価が無い → 0・rateMissing", () => {
    expect(rateFor(idx, "M3", "2026-04")).toEqual({ hourlyRate: 0, rateSource: null, rateMissing: true, memberUnknown: false });
    const idx2 = createMasterIndex(dataset({ members: [member({ memberId: "X", title: "Unknown" })], rates: [] }));
    expect(rateFor(idx2, "X", "2026-04").rateMissing).toBe(true);
  });

  it("メンバーが有効になる前の月（effectiveFrom > m）は役職が引けない", () => {
    const r = rateFor(idx, "M4", "2026-09");
    expect(r.rateMissing).toBe(true);
    expect(r.memberUnknown).toBe(false);
    expect(memberAt(idx, "M4", "2026-09")).toBeNull();
    expect(memberAt(idx, "M4", "2026-10")?.title).toBe("SE");
  });

  it("メンバー未登録 → 個人単価のみ試す", () => {
    const idx3 = createMasterIndex(dataset({ members: [], rates: [rate("GHOST", 1234), rate("SE", 5000)] }));
    expect(rateFor(idx3, "GHOST", "2026-04")).toEqual({ hourlyRate: 1234, rateSource: { key: "GHOST", effectiveFrom: "2000-01" }, rateMissing: false, memberUnknown: true });
    expect(rateFor(idx3, "NOBODY", "2026-04")).toEqual({ hourlyRate: 0, rateSource: null, rateMissing: true, memberUnknown: true });
  });
});

describe("チーム階層 (SPEC §11)", () => {
  it("親子・深さ・子孫", () => {
    const { tree, rootTeamIds, warnings } = teamTreeAt(
      dataset({ teams: [team("ROOT", null), team("A", "ROOT"), team("B", "ROOT"), team("A1", "A")] }),
      "2026-10",
    );
    expect(warnings).toEqual([]);
    expect(rootTeamIds).toEqual(["ROOT"]);
    expect(tree.ROOT?.children).toEqual(["A", "B"]);
    expect(tree.ROOT?.descendantIds).toEqual(["ROOT", "A", "A1", "B"]);
    expect(tree.A?.depth).toBe(1);
    expect(tree.A1?.depth).toBe(2);
    expect(tree.A1?.descendantIds).toEqual(["A1"]);
  });

  it("複数の最上位はファイル初出順", () => {
    const { rootTeamIds } = teamTreeAt(dataset({ teams: [team("Z", null), team("A", null)] }), "2026-10");
    expect(rootTeamIds).toEqual(["Z", "A"]);
  });

  it("存在しない親 → UNKNOWN_TEAM、最上位扱い", () => {
    const { tree, rootTeamIds, warnings } = teamTreeAt(dataset({ teams: [team("A", "NOPE")] }), "2026-10");
    expect(rootTeamIds).toEqual(["A"]);
    expect(tree.A?.parentTeamId).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("UNKNOWN_TEAM");
    expect(warnings[0]?.ref?.parentTeamId).toBe("NOPE");
  });

  it("循環 A→B→A は切って警告（ID 最小が最上位）", () => {
    const { tree, rootTeamIds, warnings } = teamTreeAt(dataset({ teams: [team("B", "A"), team("A", "B")] }), "2026-10");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("UNKNOWN_TEAM");
    expect(warnings[0]?.message).toContain("循環");
    expect(rootTeamIds).toEqual(["A"]);
    expect(tree.A?.children).toEqual(["B"]);
    expect(tree.B?.parentTeamId).toBe("A");
    expect(tree.A?.descendantIds).toEqual(["A", "B"]);
  });

  it("自分自身が親 → 切って最上位", () => {
    const { tree, rootTeamIds, warnings } = teamTreeAt(dataset({ teams: [team("A", "A")] }), "2026-10");
    expect(rootTeamIds).toEqual(["A"]);
    expect(tree.A?.parentTeamId).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it("3 つの循環 A→B→C→A と、そこにぶら下がる D", () => {
    const { tree, rootTeamIds, warnings } = teamTreeAt(
      dataset({ teams: [team("A", "C"), team("B", "A"), team("C", "B"), team("D", "C")] }),
      "2026-10",
    );
    expect(warnings).toHaveLength(1);
    expect(rootTeamIds).toEqual(["A"]);
    expect(tree.A?.descendantIds).toEqual(["A", "B", "C", "D"]);
    expect(tree.D?.depth).toBe(3);
  });

  it("月によって組織が変わる（effectiveFrom が月より後のレコードは無視）", () => {
    const ds = dataset({ teams: [team("ROOT", null), team("A", "ROOT", "2026-01"), team("A", null, "2026-07")] });
    expect(teamTreeAt(ds, "2026-06").tree.A?.parentTeamId).toBe("ROOT");
    expect(teamTreeAt(ds, "2026-07").tree.A?.parentTeamId).toBeNull();
    expect(teamTreeAt(ds, "2025-12").tree.A).toBeUndefined();
    expect(teamTreeAt(ds, "2025-12").rootTeamIds).toEqual(["ROOT"]);
  });

  it("親が将来にしか存在しない → その月は未知の親", () => {
    const ds = dataset({ teams: [team("P", null, "2027-01"), team("A", "P", "2026-01")] });
    const r = teamTreeAt(ds, "2026-06");
    expect(r.rootTeamIds).toEqual(["A"]);
    expect(r.warnings[0]?.code).toBe("UNKNOWN_TEAM");
  });

  it("チームが 0 件でも動く", () => {
    expect(teamTreeAt(dataset(), "2026-10")).toEqual({ tree: {}, rootTeamIds: [], warnings: [] });
  });
});
