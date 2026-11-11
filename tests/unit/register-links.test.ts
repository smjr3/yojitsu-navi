/** データ確認の「案件に登録」のリンク（SPEC §103.3） */
import { describe, expect, it } from "vitest";
import { contractListText, mastersHref, officialProjectLookup, registerContractHref, unlinkedByCandidate } from "../../src/components/register-links.js";

const params = (href: string) => Object.fromEntries(new URLSearchParams(href.split("?")[1]));

describe("register-links", () => {
  it("mastersHref は空の値を付けない", () => {
    expect(mastersHref("contracts", { q: "C001", unset: "", x: null, y: undefined })).toBe("./masters?view=contracts&q=C001");
  });

  it("未紐付けの行: 顧客名・案件名と、作業実績の最初の月を開始月に入れる（終了月・金額は入れない）", () => {
    const p = params(registerContractHref({ customerName: "顧客A", projectName: "案件X", firstDate: "2026-08-17" }));
    expect(p).toEqual({ view: "contracts", new: "1", customer_name: "顧客A", project_name: "案件X", start_month: "2026-08" });
  });

  it("未紐付けの行: 正式な案件が案件名で 1 件に決まればその ID・顧客名・案件名", () => {
    const lookup = officialProjectLookup([{ projectId: "PJ-1", customerName: "正式顧客", projectName: "案件Ｘ" }]);
    const p = params(registerContractHref({ customerName: "作業実績の顧客", projectName: "案件X", firstDate: "2026-08-01" }, lookup));
    expect(p).toMatchObject({ customer_name: "正式顧客", project_name: "案件Ｘ", project_id: "PJ-1", start_month: "2026-08" });
  });

  it("同じ案件名の正式な案件が 2 件以上なら決めない（推測しない）", () => {
    const lookup = officialProjectLookup([
      { projectId: "PJ-1", customerName: "A", projectName: "案件X" },
      { projectId: "PJ-2", customerName: "B", projectName: "案件X" },
    ]);
    expect(lookup("案件X")).toBeNull();
    const p = params(registerContractHref({ customerName: "顧客A", projectName: "案件X", firstDate: "2026-08-01" }, lookup));
    expect(p.project_id).toBeUndefined();
    expect(p.customer_name).toBe("顧客A");
  });

  it("正式な案件の行: そのまま入れる。日付の無い行は開始月を入れない", () => {
    const p = params(registerContractHref({ projectId: "PJ-9", customerName: "C", projectName: "P" }));
    expect(p).toEqual({ view: "contracts", new: "1", customer_name: "C", project_name: "P", project_id: "PJ-9" });
    expect(params(registerContractHref({ customerName: "C", projectName: "P", firstDate: "" })).start_month).toBeUndefined();
  });

  it("unlinkedByCandidate: 正式な案件ID → それを候補に持つ案件。表には「顧客名（案件ID）」", () => {
    const m = unlinkedByCandidate([
      { contractId: "C009", customerName: "顧客A", candidates: ["PJ-7"] },
      { contractId: "C020", customerName: "", candidates: ["PJ-7", "PJ-8"] },
      { contractId: "C030", customerName: "顧客C", candidates: [] },
    ]);
    expect(m.get("PJ-7")?.map((c) => c.contractId)).toEqual(["C009", "C020"]);
    expect(m.get("PJ-8")?.map((c) => c.contractId)).toEqual(["C020"]);
    expect(m.has("PJ-9")).toBe(false);
    expect(contractListText(m.get("PJ-7"))).toBe("顧客A（C009）、C020");
    expect(contractListText(undefined)).toBe("");
  });
});
