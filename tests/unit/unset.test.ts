/**
 * 確認要求からマスタ修正へ（SPEC §103）:
 * 未設定・仮の値の一覧、案件ID の続き番号、顧客の既定の担当チーム、仮の単価、契約期間外の実績の契約期間・月ごとの時間
 */
import { describe, expect, it } from "vitest";
import { applyCustomerTeams, customerTeamIndex, isProvisionalCell, parseDataset } from "../../src/core/csv.js";
import { mapWorklogs } from "../../src/core/mapping.js";
import { addRow, docFromDraft, draftFileOf, emptyMasterText, parseDraft, parseMasterDoc, planSourcesFromDocs, rebaseDraftFile, serializeMasterDoc, updateRow, withColumn } from "../../src/core/masterEdit.js";
import { findUnsetItems, nextContractId } from "../../src/core/unset.js";
import { validateDataset } from "../../src/core/validate.js";
import { baseConfig, contract, dataset, member, rate, rule, team, worklog } from "./fixtures.js";

describe("findUnsetItems", () => {
  it("担当チームが空・金額が 0 の案件、単価の無い役職、仮の単価を挙げる", () => {
    const items = findUnsetItems({
      contracts: [contract({ contractId: "C1", teamId: null, totalAmount: 0 }), contract({ contractId: "C2", teamId: "T1", totalAmount: 100 }), contract({ contractId: "C3", teamId: "", totalAmount: Number.NaN })],
      members: [member({ memberId: "M1", title: "SE" }), member({ memberId: "M2", title: "PM" }), member({ memberId: "M3", title: "PM" }), member({ memberId: "M4", title: "" }), member({ memberId: "P1", title: "パートナー" })],
      rates: [rate("SE", 5000), { ...rate("P1", 7000), provisional: true }, { ...rate("P1", 7100, "2026-04"), provisional: true }],
    });
    expect(items).toEqual([
      { kind: "contractTeam", key: "C1", customerName: "ABC株式会社", projectName: "保守" },
      { kind: "contractAmount", key: "C1", customerName: "ABC株式会社", projectName: "保守" },
      { kind: "contractTeam", key: "C3", customerName: "ABC株式会社", projectName: "保守" },
      { kind: "contractAmount", key: "C3", customerName: "ABC株式会社", projectName: "保守" },
      // 役職の無い人（M4）はメンバーの側で直すので入れない。個人単価のある人（P1）も入れない
      { kind: "rateMissing", key: "PM", count: 2 },
      { kind: "rateProvisional", key: "P1" },
    ]);
  });

  it("顧客の既定の担当チームが入った案件は未設定に入れない", () => {
    const contracts = [contract({ contractId: "C1", customerName: "ＡＢＣ株式会社", totalAmount: 100 })];
    applyCustomerTeams(contracts, [{ customerName: "ABC株式会社", teamId: "T1" }]);
    expect(findUnsetItems({ contracts, members: [], rates: [] })).toEqual([]);
    expect(contracts[0]).toMatchObject({ teamId: "T1", teamFromCustomer: true });
  });
});

describe("nextContractId", () => {
  it("最も多い接頭辞の最大の番号の次（桁数をそろえる）", () => {
    expect(nextContractId(["C001", "C002", "C010", "X9"])).toBe("C011");
    expect(nextContractId(["K-0099", "K-0100"])).toBe("K-0101");
  });
  it("形が無ければ C001", () => {
    expect(nextContractId([])).toBe("C001");
    expect(nextContractId(["abc"])).toBe("C001");
  });
});

describe("顧客の既定の担当チーム（customer-teams.csv）", () => {
  const base = {
    config: baseConfig,
    contracts: "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\nC1,A社,保守,,2026-04,2027-03,1200000\nC2,A社,別件,T2,2026-04,2027-03,1200000\nC3,B社,保守,,2026-04,2027-03,1200000\n",
    mapping: "worklog_customer_name,worklog_project_name,contract_id\n",
    assignments: "member_id,contract_id,start_month,end_month,allocation\n",
    teams: "team_id,name,parent_team_id,effective_from\nT1,一課,,2025-04\nT2,二課,,2025-04\n",
    members: "member_id,name,kind,title,department,section,team_id,effective_from\n",
    rates: "key,hourly_rate,effective_from\n",
    holidays: "date,name\n",
    worklogs: [],
  };
  it("team_id が空の案件だけ顧客の既定（書いた案件は例外としてそのまま）。正規化して完全一致", () => {
    const { dataset: ds, issues } = parseDataset({ ...base, customerTeams: "customer_name,team_id\nＡ社,T1\n" });
    expect(ds.contracts.map((c) => [c.contractId, c.teamId, c.teamFromCustomer ?? false])).toEqual([
      ["C1", "T1", true],
      ["C2", "T2", false],
      ["C3", null, false],
    ]);
    expect(issues.filter((i) => i.file === "customer-teams.csv")).toEqual([]);
  });
  it("ファイルが無ければ何もしない", () => {
    const { dataset: ds } = parseDataset(base);
    expect(ds.customerTeams).toBeUndefined();
    expect(ds.contracts[0]?.teamId).toBeNull();
  });
  it("検証: 存在しないチーム・重複・空は error、案件の無い顧客は warning。存在しない既定のチームを案件の行のエラーにしない", () => {
    const { issues } = parseDataset({ ...base, customerTeams: "customer_name,team_id\nA社,T9\nA社,T1\n,T1\nZ社,T1\nB社,\n" });
    const mine = issues.filter((i) => i.file === "customer-teams.csv").map((i) => [i.severity, i.code, i.row]);
    expect(mine).toEqual([
      ["error", "CUSTOMER_TEAM_UNKNOWN_TEAM", 2],
      ["error", "CUSTOMER_TEAM_DUPLICATE", 3],
      ["error", "CUSTOMER_TEAM_EMPTY", 4],
      ["warning", "CUSTOMER_TEAM_UNKNOWN_CUSTOMER", 5],
      ["error", "CUSTOMER_TEAM_EMPTY", 6],
    ]);
    expect(issues.some((i) => i.code === "CONTRACT_UNKNOWN_TEAM")).toBe(false);
  });
  it("索引は最初の行（空のチームは使わない）", () => {
    expect([...customerTeamIndex([{ customerName: "A社", teamId: "" }, { customerName: "A社", teamId: "T1" }, { customerName: "A社", teamId: "T2" }])]).toEqual([["a社", "T1"]]);
  });
});

describe("仮の単価（rates.csv の provisional）", () => {
  it("1・true・yes・仮 は仮、空・0 は本番の値", () => {
    expect(["1", "true", "YES", " 仮 ", "１"].map(isProvisionalCell)).toEqual([true, true, true, true, true]);
    expect(["", "0", "no", "本番"].map(isProvisionalCell)).toEqual([false, false, false, false]);
  });
  it("読み込みで provisional を持ち、計算には使う（検証は通る）", () => {
    const ds = dataset({ rates: [{ ...rate("SE", 1000), provisional: true }], members: [member({ memberId: "M1" })], teams: [team("T1", null)] });
    expect(validateDataset(ds).filter((i) => i.severity === "error")).toEqual([]);
  });
  it("列の無いファイルは、値を入れたときだけ見出しの末尾に足す（触らない行はそのまま）", () => {
    const text = "key,hourly_rate,effective_from\nSE,1000,2025-04\nPM,2000,2025-04\n";
    const doc = parseMasterDoc("rates", text);
    expect(doc.header).toEqual(["key", "hourly_rate", "effective_from"]);
    expect(serializeMasterDoc(doc).text).toBe(text);
    const widened = withColumn(doc, "provisional");
    expect(withColumn(widened, "provisional")).toBe(widened);
    expect(serializeMasterDoc(updateRow(widened, "o0", { provisional: "1" })).text).toBe("key,hourly_rate,effective_from,provisional\nSE,1000,2025-04,1\nPM,2000,2025-04\n");
  });
  it("顧客のファイルの空の土台", () => {
    expect(emptyMasterText("customerTeams")).toBe("customer_name,team_id,note\n");
  });
});

describe("契約期間外の実績（OUT_OF_PERIOD）", () => {
  it("名前が合った契約の期間と、月ごとの時間を持つ", () => {
    const C1 = contract({ contractId: "C1", startMonth: "2026-04", endMonth: "2027-03" });
    const C0 = contract({ contractId: "C0", startMonth: "2025-04", endMonth: "2025-09" });
    const r = mapWorklogs(
      [worklog({ date: "2025-12-01", memberId: "M1", hours: 2 }), worklog({ date: "2026-01-15", memberId: "M2", hours: 3 }), worklog({ date: "2025-12-20", memberId: "M1", hours: 1 }), worklog({ date: "2026-05-01", memberId: "M1", hours: 4 })],
      [rule("ABC株式会社", "", "C1"), rule("ABC株式会社", "", "C0")],
      [C1, C0],
    );
    expect(r.unmapped).toHaveLength(1);
    expect(r.unmapped[0]).toMatchObject({
      reason: "OUT_OF_PERIOD",
      hours: 6,
      firstDate: "2025-12-01",
      lastDate: "2026-01-15",
      contracts: [
        { contractId: "C0", startMonth: "2025-04", endMonth: "2025-09" },
        { contractId: "C1", startMonth: "2026-04", endMonth: "2027-03" },
      ],
      months: [
        { month: "2025-12", hours: 3 },
        { month: "2026-01", hours: 3 },
      ],
    });
  });
  it("作業ごとに候補の契約が違っても（キーワードの行）、同じまとまりに全部の契約を並べる", () => {
    const C1 = contract({ contractId: "C1", startMonth: "2026-04", endMonth: "2027-03" });
    const C2 = contract({ contractId: "C2", startMonth: "2026-04", endMonth: "2027-03" });
    const r = mapWorklogs(
      [worklog({ date: "2025-12-01", memberId: "M1", hours: 2, task: "保守A" }), worklog({ date: "2025-12-02", memberId: "M1", hours: 3, task: "保守B" })],
      [{ ...rule("ABC株式会社", "", "C1"), taskInclude: ["A"] }, { ...rule("ABC株式会社", "", "C2"), taskInclude: ["B"] }],
      [C1, C2],
    );
    const g = r.unmapped.filter((u) => u.reason === "OUT_OF_PERIOD");
    expect(g).toHaveLength(1);
    expect(g[0]?.hours).toBe(5);
    expect(g[0]?.contracts?.map((c) => c.contractId).sort()).toEqual(["C1", "C2"]);
  });
  it("ほかの理由のまとまりには契約・月を付けない", () => {
    const r = mapWorklogs([worklog({ date: "2026-05-01", memberId: "M1", hours: 1, customerName: "無い顧客" })], [], []);
    expect(r.unmapped[0]?.reason).toBe("NO_RULE");
    expect(r.unmapped[0]?.contracts).toBeUndefined();
    expect(r.unmapped[0]?.months).toBeUndefined();
  });
});

describe("下書きと見出しに足した列（Codex の指摘）", () => {
  const text = "key,hourly_rate,effective_from\nSE,1000,2025-04\nPM,2000,2025-04\n";
  it("仮にした行の provisional 列は下書きの保存・復元・当て直しで消えない", () => {
    const doc = updateRow(withColumn(parseMasterDoc("rates", text), "provisional"), "o0", { provisional: "1" });
    const f = draftFileOf(doc, { text, lastCommitId: null });
    expect(f.columns).toEqual(["provisional"]);
    const restored = parseDraft(JSON.stringify({ version: 2, savedAt: "t", files: { rates: f } }))!.files.rates!;
    expect(serializeMasterDoc(docFromDraft("rates", restored)).text).toBe(serializeMasterDoc(doc).text);
    // 最新の土台に行が増えていても列と値は残る
    const latest = text + "主任,800,2025-04\n";
    const r = rebaseDraftFile("rates", restored, latest);
    expect(serializeMasterDoc(r.doc).text).toBe("key,hourly_rate,effective_from,provisional\nSE,1000,2025-04,1\nPM,2000,2025-04\n主任,800,2025-04\n");
  });
  it("列を足していない下書きは columns を持たない", () => {
    expect(draftFileOf(updateRow(parseMasterDoc("rates", text), "o0", { hourly_rate: "1100" }), { text, lastCommitId: null }).columns).toBeUndefined();
  });
  it("正式な案件ID の列が無い contracts.csv でも、値を入れた新しい案件は列を足して残す", () => {
    const c = "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount,note\n";
    const doc = addRow(withColumn(parseMasterDoc("contracts", c), "project_id"), { contract_id: "C1", customer_name: "A社", project_name: "保守", project_id: "PJ-1", start_month: "2026-04", end_month: "2027-03", total_amount: "1" }).doc;
    expect(serializeMasterDoc(doc).text).toBe(c.replace("note\n", "note,project_id\n") + "C1,A社,保守,,2026-04,2027-03,1,,PJ-1\n");
  });
});

describe("リソース計画の担当チームも顧客の既定を使う（Codex の指摘）", () => {
  it("planSourcesFromDocs: team_id が空なら顧客の既定、書いた案件はそのまま", () => {
    const docs = {
      teams: parseMasterDoc("teams", "team_id,name,parent_team_id,effective_from\nT1,一課,,2025-04\n"),
      members: parseMasterDoc("members", "member_id,name,kind,title,department,section,team_id,effective_from\n"),
      assignments: parseMasterDoc("assignments", "member_id,contract_id,start_month,end_month,allocation\n"),
      customerTeams: parseMasterDoc("customerTeams", "customer_name,team_id,note\nＡ社,T1,\n"),
    };
    const contracts = "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\nC1,A社,保守,,2026-04,2027-03,1\nC2,A社,別件,T2,2026-04,2027-03,1\nC3,B社,保守,,2026-04,2027-03,1\n";
    expect([...planSourcesFromDocs(docs, contracts).contractTeams]).toEqual([
      ["C1", "T1"],
      ["C2", "T2"],
      ["C3", null],
    ]);
  });
});
