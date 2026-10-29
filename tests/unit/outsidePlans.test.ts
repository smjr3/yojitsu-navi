/**
 * 契約外予定（SPEC §30.5・§36）: 読み込み・検証・マスタ編集での扱い・GitLab への新規作成
 */
import { describe, expect, it } from "vitest";
import { parseDataset, type DatasetFiles } from "../../src/core/csv.js";
import { buildCommitPayload } from "../../src/core/gitlab.js";
import { MASTER_FILES, MASTER_FILE_IDS, addRow, describeImpactEffects, emptyMasterText, impactBetween, parseMasterDoc, updateRow, validateEdited, type MasterDoc, type MasterFileId } from "../../src/core/masterEdit.js";
import { baseConfig } from "./fixtures.js";

/** 種別の列（§48）が無い旧形式の見出し。読み込みは従来どおり（種別なし） */
const HEADER = "member_id,start_month,end_month,person_months,note\n";
const NEW_HEADER = "member_id,type,start_month,end_month,person_months,note\n";

function files(outsidePlans?: string): DatasetFiles {
  return {
    config: baseConfig,
    contracts: "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\nC1,A社,保守,T1,2026-04,2027-03,1200000\n",
    mapping: "worklog_customer_name,worklog_project_name,contract_id\nA社,,C1\n",
    assignments: "member_id,contract_id,start_month,end_month,allocation\nM1,C1,2026-04,2027-03,0.9\n",
    teams: "team_id,name,parent_team_id,effective_from\nT1,開発,,2025-04\n",
    members: "member_id,name,kind,title,department,section,team_id,effective_from\nM1,山田,employee,SE,,,T1,2025-04\n",
    rates: "key,hourly_rate,effective_from\nSE,5000,2025-04\n",
    holidays: "date,name\n",
    worklogs: [],
    ...(outsidePlans === undefined ? {} : { outsidePlans }),
  };
}
const codes = (text: string) => parseDataset(files(text)).issues.filter((i) => i.file === "outside-plans.csv").map((i) => `${i.code}@${i.row}`);

describe("契約外予定の読み込み", () => {
  it("省略・空・見出しだけなら無し（エラーにしない）", () => {
    for (const t of [undefined, "", "  \n", HEADER]) {
      const r = parseDataset(files(t));
      expect(r.dataset.outsidePlans).toBeUndefined();
      expect(r.issues.filter((i) => i.file === "outside-plans.csv")).toEqual([]);
    }
  });

  it("行を読み、メモは省略できる", () => {
    const r = parseDataset(files(`${HEADER}M1,2026-11,2027-01,0.2,"提案, 準備"\n`));
    expect(r.dataset.outsidePlans).toEqual([{ memberId: "M1", type: "", startMonth: "2026-11", endMonth: "2027-01", personMonths: 0.2, note: "提案, 準備" }]);
    // 種別の列（§48.1）
    const typed = parseDataset(files(`${NEW_HEADER}M1,会社業務,2026-11,2027-01,0.2,\n`));
    expect(typed.dataset.outsidePlans?.[0]).toMatchObject({ memberId: "M1", type: "会社業務", personMonths: 0.2 });
    const r2 = parseDataset(files("member_id,start_month,end_month,person_months\nM1,2026-11,2026-11,1\n"));
    expect(r2.dataset.outsidePlans?.[0]).toMatchObject({ personMonths: 1, note: "" });
    expect(r2.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("必須列が無ければ MISSING_COLUMN", () => {
    expect(codes("member_id,start_month,end_month\nM1,2026-11,2026-12\n")).toContain("MISSING_COLUMN@1");
  });

  it("保守の配分との合計が 1.0 を超えてもエラーにしない（画面のチップだけ。§30.5）", () => {
    expect(codes(`${HEADER}M1,2026-04,2027-03,0.5,\n`)).toEqual([]);
  });
});

describe("契約外予定の検証", () => {
  it("存在しないメンバー・不正な月・逆順・範囲外・数値でない", () => {
    const text = `${HEADER}MX,2026-04,2026-05,0.1,\nM1,4月,2026-05,0.1,\nM1,2026-04,2026-13,0.1,\nM1,2026-09,2026-08,0.1,\nM1,2027-01,2027-01,1.5,\nM1,2027-02,2027-02,abc,\nM1,2027-03,2027-03,-0.1,\n`;
    expect(codes(text)).toEqual([
      "OUTSIDE_UNKNOWN_MEMBER@2",
      "INVALID_MONTH@3",
      "INVALID_MONTH@4",
      "OUTSIDE_PERIOD_INVERTED@5",
      "OUTSIDE_OUT_OF_RANGE@6",
      "OUTSIDE_OUT_OF_RANGE@7",
      "OUTSIDE_OUT_OF_RANGE@8",
    ]);
  });

  it("同じ人・同じ月が複数の行にあれば、重なりごとに 1 件の OUTSIDE_OVERLAP", () => {
    const issues = parseDataset(files(`${HEADER}M1,2026-04,2026-09,0.1,\nM1,2026-06,2026-12,0.2,\nM1,2027-01,2027-03,0.1,\n`)).issues.filter((i) => i.code === "OUTSIDE_OVERLAP");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", row: 3, ref: { memberId: "M1", month: "2026-06" } });
    expect(issues[0]?.message).toContain("2, 3");
  });

  it("隣り合う期間（重ならない）はエラーにしない", () => {
    expect(codes(`${HEADER}M1,2026-04,2026-09,0.1,\nM1,2026-10,2027-03,0.2,\n`)).toEqual([]);
  });
});

describe("マスタ編集での契約外予定", () => {
  it("ファイルの定義: 期間付き・値の列は person_months・省略可", () => {
    expect(MASTER_FILE_IDS).toContain("outside");
    expect(MASTER_FILES.outside).toMatchObject({ path: "data/outside-plans.csv", history: "period", valueColumn: "person_months", optional: true, keyColumns: ["member_id", "type"] });
    expect(emptyMasterText("outside")).toBe(NEW_HEADER);
    // 旧形式のファイルは見出しの末尾に type を足して読む（行は種別なし）
    const old = parseMasterDoc("outside", `${HEADER}M1,2026-04,2027-03,0.1,\n`);
    expect(old.header).toEqual(["member_id", "start_month", "end_month", "person_months", "note", "type"]);
  });

  const range = { fromMonth: "2026-04", toMonth: "2026-10" };
  it("影響月は person_months で数え、「何が変わるか」は超過の判定だけ（計画額・着地見込みは変わらない）", () => {
    const before = parseMasterDoc("outside", `${HEADER}M1,2026-04,2027-03,0.1,\n`);
    const after = updateRow(before, "o0", { person_months: "0.2" });
    const impact = impactBetween(before, after, range);
    expect(impact.months).toHaveLength(7);
    expect(impact.columns).toEqual(["person_months"]);
    const eff = describeImpactEffects("outside", impact.columns);
    expect(eff.costChanges).toBe(false);
    expect(eff.effects.join("")).toContain("超過");
    // 未来の月だけなら影響なし
    expect(impactBetween(before, addRow(before, { member_id: "M2", start_month: "2026-11", end_month: "2026-12", person_months: "0.1" }).doc, range).months).toEqual([]);
  });

  it("validateEdited が契約外予定の誤りを行に結び付ける", () => {
    const f = files();
    const docs: Record<MasterFileId, MasterDoc> = {
      members: parseMasterDoc("members", f.members),
      rates: parseMasterDoc("rates", f.rates),
      teams: parseMasterDoc("teams", f.teams),
      assignments: parseMasterDoc("assignments", f.assignments),
      outside: parseMasterDoc("outside", HEADER),
    };
    const { doc, rowId } = addRow(docs.outside, { member_id: "NOBODY", start_month: "2026-11", end_month: "2026-12", person_months: "0.1" });
    const v = validateEdited({ ...docs, outside: doc }, { contracts: f.contracts, mapping: f.mapping, holidays: f.holidays }, baseConfig);
    expect(v.byRow.outside[rowId]?.map((i) => i.code)).toEqual(["OUTSIDE_UNKNOWN_MEMBER"]);
    expect(v.texts.outside).toBe("member_id,start_month,end_month,person_months,note,type\nNOBODY,2026-11,2026-12,0.1,,\n");
  });
});

describe("GitLab: まだ無いファイルは create", () => {
  it("create のファイルは action create（last_commit_id を付けない）", () => {
    const p = buildCommitPayload({
      files: [
        { path: "data/outside-plans.csv", content: HEADER, lastCommitId: "abc", create: true },
        { path: "data/assignments.csv", content: "x", lastCommitId: "def" },
      ],
      message: "m",
      branch: "b",
    });
    expect(p.actions).toEqual([
      { action: "create", file_path: "data/outside-plans.csv", content: HEADER, encoding: "text" },
      { action: "update", file_path: "data/assignments.csv", content: "x", encoding: "text", last_commit_id: "def" },
    ]);
  });
});
