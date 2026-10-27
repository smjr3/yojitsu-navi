import { describe, expect, it } from "vitest";
import { mapWorklogs, unmappedReasonLabel } from "../../src/core/mapping.js";
import { contract, rule, worklog } from "./fixtures.js";

const C1 = contract({ contractId: "C1", startMonth: "2026-04", endMonth: "2027-03" });

describe("作業実績の紐付け (SPEC §4.2)", () => {
  it("(顧客, 案件) の完全一致ルールで紐付く（表記ゆれは正規化で吸収）", () => {
    const r = mapWorklogs([worklog({ date: "2026-05-10", memberId: "M1", hours: 1, customerName: "（株）ＡＢＣ", projectName: "保守" })], [rule("ABC株式会社", "保守", "C1")], [C1]);
    expect(r.assigned).toHaveLength(1);
    expect(r.assigned[0]?.contractId).toBe("C1");
    expect(r.assigned[0]?.month).toBe("2026-05");
    expect(r.unmapped).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("案件一致が無ければ (顧客, \"\") のルールにフォールバック", () => {
    const r = mapWorklogs([worklog({ date: "2026-05-10", memberId: "M1", hours: 1, projectName: "別案件" })], [rule("ABC株式会社", "", "C1")], [C1]);
    expect(r.assigned[0]?.contractId).toBe("C1");
  });

  it("案件一致ルールが顧客全体ルールより優先", () => {
    const C2 = contract({ contractId: "C2" });
    const r = mapWorklogs([worklog({ date: "2026-05-10", memberId: "M1", hours: 1, projectName: "保守" })], [rule("ABC株式会社", "", "C1"), rule("ABC株式会社", "保守", "C2")], [C1, C2]);
    expect(r.assigned[0]?.contractId).toBe("C2");
    expect(r.warnings).toEqual([]);
  });

  it("顧客名が空（正規化後に空）の工数は除外し EXCLUDED_NO_CUSTOMER を 1 件", () => {
    const r = mapWorklogs(
      [
        worklog({ date: "2026-05-10", memberId: "M1", hours: 2, customerName: "" }),
        worklog({ date: "2026-05-11", memberId: "M1", hours: 3, customerName: "　" }),
        worklog({ date: "2026-05-12", memberId: "M1", hours: 4, customerName: "株式会社" }),
      ],
      [rule("ABC株式会社", "", "C1")],
      [C1],
    );
    expect(r.assigned).toEqual([]);
    expect(r.excludedHours).toBe(9);
    expect(r.unmapped).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({ code: "EXCLUDED_NO_CUSTOMER", hours: 9, count: 3 });
    expect(r.mappings.every((m) => m.kind === "excluded")).toBe(true);
  });

  it("ルール無し → NO_RULE でまとめる（元の表記・時間・件数・最初と最後の日付）", () => {
    const r = mapWorklogs(
      [
        worklog({ date: "2026-05-20", memberId: "M1", hours: 1, customerName: "XYZ", projectName: "P" }),
        worklog({ date: "2026-05-01", memberId: "M2", hours: 2.5, customerName: "XYZ", projectName: "P" }),
        worklog({ date: "2026-06-01", memberId: "M2", hours: 1, customerName: "XYZ", projectName: "Q" }),
      ],
      [],
      [C1],
    );
    expect(r.unmapped).toEqual([
      { customerName: "XYZ", projectName: "P", hours: 3.5, count: 2, firstDate: "2026-05-01", lastDate: "2026-05-20", reason: "NO_RULE" },
      { customerName: "XYZ", projectName: "Q", hours: 1, count: 1, firstDate: "2026-06-01", lastDate: "2026-06-01", reason: "NO_RULE" },
    ]);
    expect(r.warnings.filter((w) => w.code === "UNMAPPED_WORKLOG")).toHaveLength(2);
  });

  it("期間外 → OUT_OF_PERIOD（開始月の前月・終了月の翌月の境界）", () => {
    const logs = [
      worklog({ date: "2026-03-31", memberId: "M1", hours: 1 }), // 開始月の前日
      worklog({ date: "2026-04-01", memberId: "M1", hours: 1 }), // 開始月の初日
      worklog({ date: "2027-03-31", memberId: "M1", hours: 1 }), // 終了月の末日
      worklog({ date: "2027-04-01", memberId: "M1", hours: 1 }), // 終了月の翌日
    ];
    const r = mapWorklogs(logs, [rule("ABC株式会社", "", "C1")], [C1]);
    expect(r.mappings.map((m) => m.kind)).toEqual(["unmapped", "assigned", "assigned", "unmapped"]);
    expect(r.unmapped[0]?.reason).toBe("OUT_OF_PERIOD");
    expect(r.unmapped[0]?.hours).toBe(2);
  });

  it("複数契約が期間に該当 → 契約ID昇順の先頭 + MAPPING_AMBIGUOUS", () => {
    const C2 = contract({ contractId: "C2" });
    const C0 = contract({ contractId: "C0", startMonth: "2027-01", endMonth: "2027-12" });
    const r = mapWorklogs(
      [worklog({ date: "2026-05-10", memberId: "M1", hours: 2 }), worklog({ date: "2027-02-10", memberId: "M1", hours: 1 })],
      [rule("ABC株式会社", "", "C2"), rule("ABC株式会社", "", "C1"), rule("ABC株式会社", "", "C0")],
      [C1, C2, C0],
    );
    expect(r.assigned.map((a) => a.contractId)).toEqual(["C1", "C0"]); // 2026-05 は C1/C2 → C1、2027-02 は C0/C1/C2 → C0
    const amb = r.warnings.filter((w) => w.code === "MAPPING_AMBIGUOUS");
    expect(amb).toHaveLength(2);
    expect(amb.map((w) => w.ref?.contractId)).toEqual(["C1", "C0"]);
  });

  it("同じルールが重複していても曖昧にはならない", () => {
    const r = mapWorklogs([worklog({ date: "2026-05-10", memberId: "M1", hours: 1 })], [rule("ABC株式会社", "", "C1"), rule("abc", "", "C1")], [C1]);
    expect(r.warnings).toEqual([]);
    expect(r.assigned).toHaveLength(1);
  });

  it("ルールが同じ顧客で複数契約を指すが 1 つだけ期間内 → 曖昧でない", () => {
    const C2 = contract({ contractId: "C2", startMonth: "2027-04", endMonth: "2028-03" });
    const r = mapWorklogs([worklog({ date: "2026-05-10", memberId: "M1", hours: 1 })], [rule("ABC株式会社", "", "C1"), rule("ABC株式会社", "", "C2")], [C1, C2]);
    expect(r.assigned[0]?.contractId).toBe("C1");
    expect(r.warnings).toEqual([]);
  });

  it("存在しない契約ID → MAPPING_UNKNOWN_CONTRACT（実績が無くても）、工数は UNKNOWN_CONTRACT", () => {
    const r = mapWorklogs([worklog({ date: "2026-05-10", memberId: "M1", hours: 1 })], [rule("ABC株式会社", "", "NOPE")], [C1]);
    expect(r.warnings.map((w) => w.code)).toContain("MAPPING_UNKNOWN_CONTRACT");
    expect(r.unmapped[0]?.reason).toBe("UNKNOWN_CONTRACT");
    const r2 = mapWorklogs([], [rule("ABC株式会社", "", "NOPE")], [C1]);
    expect(r2.warnings.map((w) => w.code)).toEqual(["MAPPING_UNKNOWN_CONTRACT"]);
  });

  it("存在しない契約と存在する契約を同じキーが指す → 存在するものだけ使う", () => {
    const r = mapWorklogs([worklog({ date: "2026-05-10", memberId: "M1", hours: 1 })], [rule("ABC株式会社", "", "NOPE"), rule("ABC株式会社", "", "C1")], [C1]);
    expect(r.assigned[0]?.contractId).toBe("C1");
    expect(r.warnings.map((w) => w.code)).toEqual(["MAPPING_UNKNOWN_CONTRACT"]);
  });

  it("hours が 0 以下・NaN・非数値の行は無視（警告なし）", () => {
    const r = mapWorklogs(
      [
        worklog({ date: "2026-05-10", memberId: "M1", hours: 0 }),
        worklog({ date: "2026-05-10", memberId: "M1", hours: -1 }),
        worklog({ date: "2026-05-10", memberId: "M1", hours: Number.NaN }),
        worklog({ date: "2026-05-10", memberId: "M1", hours: "3" as unknown as number }),
        worklog({ date: "2026-05-10", memberId: "M1", hours: 0.25 }),
      ],
      [rule("ABC株式会社", "", "C1")],
      [C1],
    );
    expect(r.ignoredCount).toBe(4);
    expect(r.assigned).toHaveLength(1);
    expect(r.assigned[0]?.worklog.hours).toBe(0.25);
    expect(r.warnings).toEqual([]);
  });

  it("日付が不正な行は無視", () => {
    const r = mapWorklogs(
      [worklog({ date: "2026-02-30", memberId: "M1", hours: 1 }), worklog({ date: "2026/05/10", memberId: "M1", hours: 1 }), worklog({ date: "", memberId: "M1", hours: 1 })],
      [rule("ABC株式会社", "", "C1")],
      [C1],
    );
    expect(r.ignoredCount).toBe(3);
    expect(r.mappings.every((m) => m.kind === "ignored" && m.reason === "INVALID_DATE")).toBe(true);
  });

  it("mappings は入力と同じ順序・件数", () => {
    const logs = [worklog({ date: "2026-05-10", memberId: "M1", hours: 1 }), worklog({ date: "x", memberId: "M1", hours: 1 }), worklog({ date: "2026-05-10", memberId: "M1", hours: 1, customerName: "" })];
    const r = mapWorklogs(logs, [rule("ABC株式会社", "", "C1")], [C1]);
    expect(r.mappings.map((m) => m.worklog)).toEqual(logs);
    expect(r.mappings.map((m) => m.kind)).toEqual(["assigned", "ignored", "excluded"]);
  });

  it("未紐付け理由の表示名", () => {
    expect(unmappedReasonLabel("NO_RULE")).toBe("マッピングルールなし");
    expect(unmappedReasonLabel("OUT_OF_PERIOD")).toBe("契約期間外");
    expect(unmappedReasonLabel("UNKNOWN_CONTRACT")).toBe("存在しない契約ID");
  });
});
