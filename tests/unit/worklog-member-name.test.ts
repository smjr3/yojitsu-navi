/**
 * 作業ログの氏名（SPEC §139）: メンバーマスタの氏名を優先し、マスタに無い人は作業実績の氏名、それも無ければ社員番号
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error 画面側の JS（型定義なし）
import { worklogMemberNamer } from "../../src/components/analysis.js";

const model = {
  members: [
    { memberId: "M1", name: "旧姓 花子", effectiveFrom: "2025-04" },
    { memberId: "M1", name: "新姓 花子", effectiveFrom: "2026-04" },
    { memberId: "M2", name: "", effectiveFrom: "2025-04" },
  ],
};

describe("worklogMemberNamer", () => {
  const nameOf = worklogMemberNamer(model);
  it("取得元の氏名の列が社員番号でも、マスタにある人はその月の氏名", () => {
    expect(nameOf({ memberId: "M1", memberName: "M1", date: "2025-06-01" })).toBe("旧姓 花子");
    expect(nameOf({ memberId: "M1", memberName: "M1", date: "2026-05-10" })).toBe("新姓 花子");
    // 最初の行より前の作業は最も早い行の氏名
    expect(nameOf({ memberId: "M1", memberName: "", date: "2024-12-01" })).toBe("旧姓 花子");
  });
  it("マスタに無い・氏名が空の人は作業実績の氏名、それも無ければ社員番号", () => {
    expect(nameOf({ memberId: "M9", memberName: " 臨時 太郎 ", date: "2026-06-01" })).toBe("臨時 太郎");
    expect(nameOf({ memberId: "M2", memberName: "作業 次郎", date: "2026-06-01" })).toBe("作業 次郎");
    expect(nameOf({ memberId: "M9", memberName: "", date: "2026-06-01" })).toBe("M9");
  });
  it("model が無くても動く", () => {
    expect(worklogMemberNamer(null)({ memberId: "M1", memberName: "名前", date: "2026-01-01" })).toBe("名前");
  });
});
