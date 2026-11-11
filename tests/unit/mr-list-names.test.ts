/**
 * マージ待ちの内容（SPEC §26）: ID ではなく氏名・組織名・「顧客 / 案件名」で出す
 */
import { describe, expect, it } from "vitest";
import { namerFor } from "../../src/components/mr-list.js";
import { MASTER_FILES } from "../../src/core/masterEdit.js";

const names: Record<string, string> = { M001: "佐藤 健一", T01: "第1チーム", C001: "顧客A / 保守" };
const describeNow = { value: (_f: string, _c: string, v: string) => names[v] ?? v, target: (_k: string, id: string) => names[id] ?? "" };
const rec = (o: Record<string, string>) => o;

describe("namerFor", () => {
  it("今の台帳の名前で出す（キーは名前 / 適用開始月）", () => {
    const n = namerFor(describeNow, []);
    expect(n.lead("assignments", MASTER_FILES.assignments, rec({ member_id: "M001", contract_id: "C001", start_month: "2026-04" }))).toBe("佐藤 健一 / 顧客A / 保守 / 2026-04");
    expect(n.lead("rates", MASTER_FILES.rates, rec({ key: "M001", effective_from: "2026-04" }))).toBe("佐藤 健一 / 2026-04");
    expect(n.lead("members", MASTER_FILES.members, rec({ member_id: "M001", name: "佐藤 健一", effective_from: "2026-04" }))).toBe("佐藤 健一 / 2026-04");
    expect(n.lead("contracts", MASTER_FILES.contracts, rec({ contract_id: "C9", customer_name: "顧客B", project_name: "案件X" }))).toBe("顧客B / 案件X");
    expect(n.lead("targets", MASTER_FILES.targets, rec({ target_type: "team", target_id: "T01", end_month: "2027-03" }))).toBe("チーム / 第1チーム / 2027-03");
    expect(n.value("members", "team_id", "T01")).toBe("第1チーム");
  });

  it("同じ MR で足したメンバー・組織・案件の名前を使う", () => {
    const added = (after: Record<string, string>) => ({ rowId: "x", after });
    const files = [
      { id: "members", diff: { added: [added({ member_id: "M900", name: "新人 太郎" })], changed: [], removed: [] } },
      { id: "teams", diff: { added: [added({ team_id: "T900", name: "新チーム" })], changed: [], removed: [] } },
      { id: "contracts", diff: { added: [added({ contract_id: "C900", customer_name: "顧客Z", project_name: "新案件" })], changed: [], removed: [] } },
    ];
    const n = namerFor(describeNow, files);
    expect(n.lead("assignments", MASTER_FILES.assignments, rec({ member_id: "M900", contract_id: "C900", start_month: "2026-05" }))).toBe("新人 太郎 / 顧客Z / 新案件 / 2026-05");
    expect(n.value("members", "team_id", "T900")).toBe("新チーム");
  });
});
