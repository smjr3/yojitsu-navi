/**
 * 極端なデータでの QA で見つかった不具合の再発防止
 */
import { describe, expect, it } from "vitest";
import { parseNumberCell, unclosedQuoteLine } from "../../src/core/csv.js";
import { validateDataset } from "../../src/core/validate.js";
import { contractIdFromWorklogKey, worklogKey } from "../../src/components/worklog-key.js";
import { contract, dataset, member, rate, team } from "./fixtures.js";

const codes = (d: ReturnType<typeof dataset>) => validateDataset(d).map((i) => i.code);

describe("parseNumberCell: カンマは 3 桁区切りだけ", () => {
  it("1,5 は 15 ではなく不正値", () => {
    expect(parseNumberCell("1,5")).toBeNaN();
    expect(parseNumberCell("1,0,0")).toBeNaN();
    expect(parseNumberCell("12,345")).toBe(12345);
    expect(parseNumberCell("１,２３４")).toBe(1234);
  });
});

describe("unclosedQuoteLine", () => {
  it("閉じていない引用符の開始行を返す", () => {
    expect(unclosedQuoteLine('a,b\n1,"x\n2,y\n')).toBe(2);
    expect(unclosedQuoteLine('a,b\n1,"x ""q"" y"\n2,y\n')).toBeNull();
    expect(unclosedQuoteLine('a\n"改\n行"\n')).toBeNull();
  });
});

describe("validateDataset: 重複行・存在しないチーム・巨大な金額", () => {
  it("同じキー・同じ effective_from の重複は error", () => {
    const d = dataset({
      rates: [rate("一般", 6000, "2025-04"), rate("一般", 7000, "2025-04"), rate("一般", 7000, "2026-04")],
      members: [member({ memberId: "M1" }), member({ memberId: "M1", title: "課長" })],
      teams: [team("T1", null, "2025-04"), team("T1", null, "2025-04")],
    });
    const c = codes(d);
    expect(c.filter((x) => x === "DUPLICATE_RATE_ROW")).toHaveLength(1);
    expect(c).toContain("DUPLICATE_MEMBER_ROW");
    expect(c).toContain("DUPLICATE_TEAM_ROW");
  });
  it("契約のチームが teams.csv に無ければ error", () => {
    const d = dataset({ teams: [team("T1", null)], contracts: [contract({ contractId: "C1", teamId: "GHOST" }), contract({ contractId: "C2", teamId: "T1" })] });
    const issues = validateDataset(d).filter((i) => i.code === "CONTRACT_UNKNOWN_TEAM");
    expect(issues.map((i) => i.ref?.contractId)).toEqual(["C1"]);
  });
  it("2^53 を超える金額は error", () => {
    expect(codes(dataset({ contracts: [contract({ contractId: "C1", totalAmount: 2 ** 53 + 2 })] }))).toContain("CONTRACT_AMOUNT_INVALID");
  });
});

describe("worklogKey: 静的サーバで 404 にならないファイル名", () => {
  it("英数字はそのまま、それ以外は ~16進 で往復できる", () => {
    expect(worklogKey("C001")).toBe("C001");
    for (const id of ["契約十一", "N 06", "N/05", "N,10", 'N"12', "<i>N13</i>", "N%09", "~41"]) {
      const key = worklogKey(id);
      expect(key).toMatch(/^[A-Za-z0-9_~-]+$/);
      expect(contractIdFromWorklogKey(key)).toBe(id);
    }
  });
});
