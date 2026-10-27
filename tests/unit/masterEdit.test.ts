/**
 * マスタ編集（SPEC §19.1）: CSV の行編集と書き出し、差分、過去月への影響、編集後の検証、下書き
 */
import { describe, expect, it } from "vitest";
import { parseCsvText } from "../../src/core/csv.js";
import {
  DRAFT_STORAGE_KEY,
  addRow,
  cellOf,
  deleteRow,
  describeImpactMonths,
  diffMasterDoc,
  docFromDraft,
  escapeCsvCell,
  formatCsvRecord,
  impactBetween,
  impactOfChange,
  isPristine,
  issueText,
  makeDraft,
  parseDraft,
  parseMasterDoc,
  restoreRow,
  revertRow,
  rowState,
  serializeMasterDoc,
  splitCsvRecords,
  staleDraftFiles,
  updateRow,
  validateEdited,
  type MasterDoc,
  type MasterFileId,
} from "../../src/core/masterEdit.js";
import { baseConfig } from "./fixtures.js";

const RATES = "key,hourly_rate,effective_from\n本部長,15000,2025-04\n部長,12000,2025-04\n主任,8000,2025-04\n部長,13000,2026-04\n";
const range = { fromMonth: "2025-04", toMonth: "2026-10" };

describe("splitCsvRecords", () => {
  it("引用符内のカンマ・改行・二重引用符を 1 セルとして読み、元テキストも返す", () => {
    const text = 'a,b\r\n"x,1","line1\nline2"\n"say ""hi""",z';
    const recs = splitCsvRecords(text);
    expect(recs.map((r) => r.cells)).toEqual([
      ["a", "b"],
      ["x,1", "line1\nline2"],
      ['say "hi"', "z"],
    ]);
    expect(recs.map((r) => r.raw)).toEqual(["a,b", '"x,1","line1\nline2"', '"say ""hi""",z']);
  });

  it("BOM を除き、空行・空白だけの行は捨てる（core の parseCsvText と同じセル）", () => {
    const text = "﻿a,b\n\n  \n1,2\n,\n3,4";
    expect(splitCsvRecords(text).map((r) => r.cells)).toEqual(parseCsvText(text));
  });

  it("末尾改行の有無に関係なく同じ", () => {
    expect(splitCsvRecords("a\n1\n")).toEqual(splitCsvRecords("a\n1"));
  });
});

describe("escapeCsvCell / formatCsvRecord", () => {
  it("カンマ・引用符・改行を含むときだけ引用符で囲む", () => {
    expect(escapeCsvCell("abc")).toBe("abc");
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell('a"b')).toBe('"a""b"');
    expect(escapeCsvCell("a\nb")).toBe('"a\nb"');
    expect(escapeCsvCell("a\rb")).toBe('"a\rb"');
    expect(escapeCsvCell("")).toBe("");
    expect(formatCsvRecord(["x", "y,z", ""])).toBe('x,"y,z",');
  });
});

describe("parseMasterDoc / serializeMasterDoc", () => {
  it("編集しなければ元テキスト（LF・末尾改行あり）と完全に同じ", () => {
    const doc = parseMasterDoc("rates", RATES);
    expect(serializeMasterDoc(doc).text).toBe(RATES);
    expect(isPristine(doc)).toBe(true);
  });

  it("未変更行は引用符の付け方・空白まで元のまま。変更した行だけ書き直す", () => {
    const text = 'key,hourly_rate,effective_from\n"本部長", 15000 ,2025-04\n"部長",12000,2025-04\n';
    let doc = parseMasterDoc("rates", text);
    doc = updateRow(doc, "o1", { hourly_rate: "12500" });
    const out = serializeMasterDoc(doc).text;
    expect(out).toBe('key,hourly_rate,effective_from\n"本部長", 15000 ,2025-04\n部長,12500,2025-04\n');
  });

  it("CRLF・BOM の元ファイルは LF・BOM なしに揃える（未変更行の中身は同じ）", () => {
    const text = "﻿key,hourly_rate,effective_from\r\n部長,12000,2025-04\r\n";
    const out = serializeMasterDoc(parseMasterDoc("rates", text)).text;
    expect(out).toBe("key,hourly_rate,effective_from\n部長,12000,2025-04\n");
    expect(out.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("値にカンマ・引用符・改行を含む行は正しくエスケープされ、読み直すと同じ値", () => {
    let doc = parseMasterDoc("members", "member_id,name,kind,title,department,section,team_id,effective_from\n");
    doc = addRow(doc, { member_id: "M9", name: '山田, "太郎"', kind: "employee", title: "主任", department: "第1\n事業部", section: "", team_id: "", effective_from: "2026-11" }).doc;
    const out = serializeMasterDoc(doc).text;
    expect(out).toContain('M9,"山田, ""太郎""",employee,主任,"第1\n事業部",,,2026-11');
    const re = parseMasterDoc("members", out);
    expect(cellOf(re, re.rows[0]!, "name")).toBe('山田, "太郎"');
    expect(cellOf(re, re.rows[0]!, "department")).toBe("第1\n事業部");
  });

  it("列順は元ファイルのヘッダ順。足りない必須列は末尾に足す", () => {
    const doc = parseMasterDoc("rates", "effective_from,key\n2025-04,部長\n");
    expect(doc.header).toEqual(["effective_from", "key", "hourly_rate"]);
    const d2 = updateRow(doc, "o0", { hourly_rate: "100" });
    expect(serializeMasterDoc(d2).text).toBe("effective_from,key,hourly_rate\n2025-04,部長,100\n");
  });

  it("空ファイル・ヘッダだけでも書き出せる", () => {
    expect(serializeMasterDoc(parseMasterDoc("teams", "")).text).toBe("team_id,name,parent_team_id,effective_from\n");
    expect(serializeMasterDoc(parseMasterDoc("teams", "team_id,name,parent_team_id,effective_from")).text).toBe("team_id,name,parent_team_id,effective_from\n");
  });

  it("すべて空の追加行は書き出さない", () => {
    const doc = addRow(parseMasterDoc("rates", RATES), { key: "", hourly_rate: "", effective_from: "" }).doc;
    expect(serializeMasterDoc(doc).text).toBe(RATES);
    expect(diffMasterDoc(doc).count).toBe(0);
  });

  it("余分な列は残す（未変更ならそのまま、変更しても後ろに残る）", () => {
    const text = "key,hourly_rate,effective_from,memo\n部長,12000,2025-04,a\n";
    const doc = updateRow(parseMasterDoc("rates", text), "o0", { hourly_rate: "1" });
    expect(serializeMasterDoc(doc).text).toBe("key,hourly_rate,effective_from,memo\n部長,1,2025-04,a\n");
  });
});

describe("行の操作", () => {
  it("追加は末尾。rowState は added / changed / unchanged", () => {
    let doc = parseMasterDoc("rates", RATES);
    const r = addRow(doc, { key: "課長", hourly_rate: "11000", effective_from: "2026-11" });
    doc = r.doc;
    expect(r.rowId).toBe("n1");
    expect(doc.rows.at(-1)!.id).toBe("n1");
    expect(rowState(doc, doc.rows.at(-1)!)).toBe("added");
    doc = updateRow(doc, "o0", { hourly_rate: "16000" });
    expect(rowState(doc, doc.rows[0]!)).toBe("changed");
    expect(rowState(doc, doc.rows[1]!)).toBe("unchanged");
    expect(serializeMasterDoc(doc).text).toBe("key,hourly_rate,effective_from\n本部長,16000,2025-04\n部長,12000,2025-04\n主任,8000,2025-04\n部長,13000,2026-04\n課長,11000,2026-11\n");
  });

  it("値を元に戻せば unchanged（元テキストで書き戻す）", () => {
    let doc = updateRow(parseMasterDoc("rates", RATES), "o1", { hourly_rate: "1" });
    doc = updateRow(doc, "o1", { hourly_rate: "12000" });
    expect(rowState(doc, doc.rows[1]!)).toBe("unchanged");
    expect(isPristine(doc)).toBe(true);
  });

  it("入力値は前後の空白を除く", () => {
    const doc = addRow(parseMasterDoc("rates", RATES), { key: " 課長 ", hourly_rate: " 1 ", effective_from: "2026-11" }).doc;
    expect(doc.rows.at(-1)!.cells).toEqual(["課長", "1", "2026-11"]);
  });

  it("revertRow / deleteRow / restoreRow", () => {
    let doc = parseMasterDoc("rates", RATES);
    doc = updateRow(doc, "o2", { hourly_rate: "1" });
    doc = revertRow(doc, "o2");
    expect(isPristine(doc)).toBe(true);
    doc = addRow(doc, { key: "x", hourly_rate: "1", effective_from: "2026-11" }).doc;
    doc = deleteRow(doc, "o1");
    expect(doc.rows.map((r) => r.id)).toEqual(["o0", "o2", "o3", "n1"]);
    doc = restoreRow(doc, "o1");
    expect(doc.rows.map((r) => r.id)).toEqual(["o0", "o1", "o2", "o3", "n1"]);
    doc = revertRow(doc, "n1");
    expect(isPristine(doc)).toBe(true);
    // 末尾の元行
    doc = restoreRow(deleteRow(doc, "o3"), "o3");
    expect(doc.rows.map((r) => r.id)).toEqual(["o0", "o1", "o2", "o3"]);
    // 存在しない ID・既にある行は何もしない
    expect(restoreRow(doc, "o1")).toBe(doc);
    expect(restoreRow(doc, "zz")).toBe(doc);
  });

  it("元の文書は変えない（イミュータブル）", () => {
    const doc = parseMasterDoc("rates", RATES);
    const snapshot = JSON.stringify(doc);
    updateRow(doc, "o0", { hourly_rate: "1" });
    addRow(doc, { key: "a" });
    deleteRow(doc, "o0");
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

describe("diffMasterDoc", () => {
  it("追加・変更（変わった列）・削除を元の順で返す", () => {
    let doc = parseMasterDoc("rates", RATES);
    doc = addRow(doc, { key: "課長", hourly_rate: "11000", effective_from: "2026-11" }).doc;
    doc = updateRow(doc, "o1", { hourly_rate: "12500", effective_from: "2025-05" });
    doc = deleteRow(doc, "o3");
    doc = deleteRow(doc, "o0");
    const d = diffMasterDoc(doc);
    expect(d.count).toBe(4);
    expect(d.added).toEqual([{ rowId: "n1", after: { key: "課長", hourly_rate: "11000", effective_from: "2026-11" } }]);
    expect(d.changed).toEqual([
      { rowId: "o1", before: { key: "部長", hourly_rate: "12000", effective_from: "2025-04" }, after: { key: "部長", hourly_rate: "12500", effective_from: "2025-05" }, columns: ["hourly_rate", "effective_from"] },
    ]);
    expect(d.removed.map((r) => r.rowId)).toEqual(["o0", "o3"]);
  });

  it("編集なしなら 0 件", () => {
    expect(diffMasterDoc(parseMasterDoc("rates", RATES)).count).toBe(0);
  });
});

describe("impactOfChange（過去月への影響）", () => {
  const before = parseMasterDoc("rates", RATES);

  it("未来の適用開始月の行を足しても過去は変わらない", () => {
    const after = addRow(before, { key: "部長", hourly_rate: "14000", effective_from: "2026-11" }).doc;
    expect(impactBetween(before, after, range).months).toEqual([]);
  });

  it("「4月から単価変更」= 2026-04 の行を足すと 2026-04〜基準月が変わる", () => {
    const after = addRow(before, { key: "主任", hourly_rate: "8500", effective_from: "2026-04" }).doc;
    const imp = impactBetween(before, after, range);
    expect(imp.months).toEqual(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(imp.keys).toEqual(["主任"]);
    expect(describeImpactMonths(imp.months)).toBe("2026-04〜2026-10（7か月）");
  });

  it("既存行の修正は、その行が有効な月だけ（後の行で上書きされた月は変わらない）", () => {
    // 部長 12000 は 2025-04〜2026-03 に有効（2026-04 からは 13000）
    const after = updateRow(before, "o1", { hourly_rate: "12100" });
    expect(impactBetween(before, after, range).months).toHaveLength(12);
  });

  it("削除: 最初の行を消すと、その月から次の行まで「存在しない」に変わる", () => {
    const after = deleteRow(before, "o0");
    expect(impactBetween(before, after, range).months).toHaveLength(19);
  });

  it("キーを変えると旧キー・新キーの両方を調べる", () => {
    const after = updateRow(before, "o2", { key: "主任補" });
    const imp = impactBetween(before, after, range);
    expect(imp.keys).toEqual(["主任", "主任補"]);
    expect(imp.months).toHaveLength(19);
  });

  it("同じキー・同じ適用開始月の行の順序を入れ替えると、後の行が有効になるので影響あり", () => {
    const text = "key,hourly_rate,effective_from\nA,1,2025-04\nA,2,2025-04\n";
    const b = parseMasterDoc("rates", text);
    const swapped: MasterDoc = { ...b, rows: [b.rows[1]!, b.rows[0]!] };
    expect(impactBetween(b, swapped, range).months).toHaveLength(19);
  });

  it("範囲外・不正な範囲は 0 件。形式不正の適用開始月は「存在しない」とみなす", () => {
    const after = addRow(before, { key: "主任", hourly_rate: "1", effective_from: "2026-4" }).doc;
    expect(impactBetween(before, after, range).months).toEqual([]);
    expect(impactBetween(before, updateRow(before, "o0", { hourly_rate: "1" }), { fromMonth: "2026-10", toMonth: "2026-01" }).months).toEqual([]);
  });

  it("アサイン: 期間が過去に掛かる月だけ", () => {
    const text = "member_id,contract_id,start_month,end_month,allocation\nM1,C1,2026-01,2027-03,0.5\n";
    const b = parseMasterDoc("assignments", text);
    expect(impactBetween(b, updateRow(b, "o0", { allocation: "0.6" }), range).months).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(impactBetween(b, addRow(b, { member_id: "M1", contract_id: "C2", start_month: "2026-11", end_month: "2027-03", allocation: "0.2" }).doc, range).months).toEqual([]);
    expect(impactBetween(b, addRow(b, { member_id: "M1", contract_id: "C2", start_month: "2026-09", end_month: "2027-03", allocation: "0.2" }).doc, range).months).toEqual(["2026-09", "2026-10"]);
    // 終了月を未来側に延ばすだけなら過去は不変
    expect(impactBetween(b, updateRow(b, "o0", { end_month: "2027-06" }), range).months).toEqual([]);
  });

  it("impactOfChange はセル配列でも使える（変化なしは 0 件）", () => {
    expect(impactOfChange("rates", ["key", "hourly_rate", "effective_from"], [["a", "1", "2025-04"]], [["a", "1", "2025-04"]], range)).toEqual({ months: [], keys: [] });
    expect(describeImpactMonths([])).toBe("なし");
    expect(describeImpactMonths(["2026-10"])).toBe("2026-10（1か月）");
  });
});

describe("validateEdited", () => {
  const members = "member_id,name,kind,title,department,section,team_id,effective_from\nM1,佐藤,employee,部長,,,T1,2025-04\n";
  const teams = "team_id,name,parent_team_id,effective_from\nT1,本部,,2025-04\n";
  const assignments = "member_id,contract_id,start_month,end_month,allocation\nM1,C1,2025-04,2026-03,0.5\n";
  const context = {
    contracts: "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\nC1,A社,保守,T1,2025-04,2026-03,1200000\n",
    mapping: "worklog_customer_name,worklog_project_name,contract_id\nA社,,C1\n",
    holidays: "date,name\n2025-05-05,こどもの日\n",
  };
  const docs = (): Record<MasterFileId, MasterDoc> => ({
    members: parseMasterDoc("members", members),
    rates: parseMasterDoc("rates", RATES),
    teams: parseMasterDoc("teams", teams),
    assignments: parseMasterDoc("assignments", assignments),
  });

  it("元データはエラー 0", () => {
    const v = validateEdited(docs(), context, baseConfig);
    expect(v.errors).toBe(0);
    expect(v.texts.rates).toBe(RATES);
  });

  it("エラーを編集した行に結び付ける（行番号 → 行 id。削除・空行があってもずれない）", () => {
    const d = docs();
    d.rates = deleteRow(d.rates, "o0");
    d.rates = addRow(d.rates, { key: "", hourly_rate: "", effective_from: "" }).doc; // 空行は書き出さない
    const r = addRow(d.rates, { key: "課長", hourly_rate: "abc", effective_from: "2026-13" });
    d.rates = r.doc;
    d.assignments = updateRow(d.assignments, "o0", { member_id: "M404", allocation: "1.5" });
    const v = validateEdited(d, context, baseConfig);
    expect(v.errors).toBeGreaterThanOrEqual(4);
    const rateIssues = v.byRow.rates[r.rowId]!.map((i) => i.code).sort();
    expect(rateIssues).toEqual(["INVALID_MONTH", "RATE_INVALID"]);
    const asg = v.byRow.assignments.o0!.map((i) => i.code).sort();
    expect(asg).toEqual(["ALLOCATION_OUT_OF_RANGE", "ASSIGNMENT_UNKNOWN_MEMBER"]);
    expect(issueText(v.byRow.assignments.o0!.find((i) => i.code === "ASSIGNMENT_UNKNOWN_MEMBER")!)).toBe("メンバーID M404 は members.csv に存在しません");
  });

  it("行に結び付かない問題（循環）は general", () => {
    const d = docs();
    d.teams = addRow(d.teams, { team_id: "T2", name: "子", parent_team_id: "T1", effective_from: "2025-04" }).doc;
    d.teams = updateRow(d.teams, "o0", { parent_team_id: "T2" });
    const v = validateEdited(d, context, baseConfig);
    expect(v.general.some((i) => i.code === "TEAM_CYCLE")).toBe(true);
    expect(v.errors).toBeGreaterThan(0);
  });

  it("チームを消すと、それを参照するメンバー行にエラー", () => {
    const d = docs();
    d.teams = deleteRow(d.teams, "o0");
    const v = validateEdited(d, context, baseConfig);
    expect(v.byRow.members.o0!.map((i) => i.code)).toContain("MEMBER_UNKNOWN_TEAM");
  });

  it("issueText はファイル名と行番号の接頭辞を外す", () => {
    expect(issueText({ message: "masters/rates.csv 3 行目: key が空です" })).toBe("key が空です");
    expect(issueText({ message: "masters/teams.csv: 循環しています" })).toBe("循環しています");
    expect(issueText({ message: "そのまま" })).toBe("そのまま");
  });
});

describe("下書き", () => {
  const bases = {
    members: { text: "member_id,name,kind,title,department,section,team_id,effective_from\n", lastCommitId: "a" },
    rates: { text: RATES, lastCommitId: "b" },
    teams: { text: "team_id,name,parent_team_id,effective_from\n", lastCommitId: "c" },
    assignments: { text: "member_id,contract_id,start_month,end_month,allocation\n", lastCommitId: null },
  };
  const pristine = (): Record<MasterFileId, MasterDoc> => ({
    members: parseMasterDoc("members", bases.members.text),
    rates: parseMasterDoc("rates", bases.rates.text),
    teams: parseMasterDoc("teams", bases.teams.text),
    assignments: parseMasterDoc("assignments", bases.assignments.text),
  });

  it("キーは yojitsu-navi:masters-draft:v1", () => {
    expect(DRAFT_STORAGE_KEY).toBe("yojitsu-navi:masters-draft:v1");
  });

  it("編集が無ければ null、あれば編集したファイルだけ保存し、往復で同じ文書に戻る", () => {
    expect(makeDraft(pristine(), bases, "t")).toBeNull();
    const docs = pristine();
    docs.rates = deleteRow(addRow(updateRow(docs.rates, "o0", { hourly_rate: "1" }), { key: "x", hourly_rate: "2", effective_from: "2026-11" }).doc, "o2");
    const draft = makeDraft(docs, bases, "2026-10-27T00:00:00Z")!;
    expect(Object.keys(draft.files)).toEqual(["rates"]);
    const restored = parseDraft(JSON.stringify(draft))!;
    const doc = docFromDraft("rates", restored.files.rates!);
    expect(serializeMasterDoc(doc).text).toBe(serializeMasterDoc(docs.rates).text);
    expect(diffMasterDoc(doc)).toEqual(diffMasterDoc(docs.rates));
    expect(doc.nextId).toBe(docs.rates.nextId);
    expect(staleDraftFiles(restored, bases)).toEqual([]);
  });

  it("土台のコミット ID か本文が変わっていれば stale", () => {
    const docs = pristine();
    docs.rates = updateRow(docs.rates, "o0", { hourly_rate: "1" });
    const draft = makeDraft(docs, bases, "t")!;
    expect(staleDraftFiles(draft, { ...bases, rates: { text: RATES, lastCommitId: "zzz" } })).toEqual(["rates"]);
    expect(staleDraftFiles(draft, { ...bases, rates: { text: RATES + "x,1,2026-01\n", lastCommitId: "b" } })).toEqual(["rates"]);
    // コミット ID が取れない（null）ときは本文だけで判定
    expect(staleDraftFiles(draft, { ...bases, rates: { text: RATES, lastCommitId: null } })).toEqual([]);
  });

  it("壊れた下書きは null", () => {
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft("{")).toBeNull();
    expect(parseDraft(JSON.stringify({ version: 2, files: {} }))).toBeNull();
    expect(parseDraft(JSON.stringify({ version: 1, files: { bogus: {} } }))).toBeNull();
    expect(parseDraft(JSON.stringify({ version: 1, files: { rates: { baseText: "", rows: [{ id: 1, cells: [] }] } } }))).toBeNull();
    expect(parseDraft(JSON.stringify({ version: 1, files: { rates: { baseText: "", rows: [{ id: "n1", cells: [1] }] } } }))).toBeNull();
    expect(parseDraft(JSON.stringify({ version: 1, savedAt: "t", files: {} }))).not.toBeNull();
  });
});
