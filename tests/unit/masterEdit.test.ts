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
  describeImpactEffects,
  describeImpactMonths,
  diffMasterDoc,
  docFromDraft,
  draftFileCount,
  draftFileOf,
  escapeCsvCell,
  formatCsvRecord,
  impactBetween,
  impactOfChange,
  isPristine,
  issueText,
  makeDraft,
  parseDraft,
  parseMasterDoc,
  rebaseDraftFile,
  restoreRow,
  revertRow,
  rowState,
  serializeMasterDoc,
  splitCsvRecords,
  stampChangedRows,
  staleDraftFiles,
  updateRow,
  validateEdited,
  type MasterDoc,
  type MasterFileId,
} from "../../src/core/masterEdit.js";
import { baseConfig } from "./fixtures.js";

const RATES = "key,hourly_rate,effective_from\n本部長,15000,2025-04\n部長,12000,2025-04\n主任,8000,2025-04\n部長,13000,2026-04\n";
const range = { fromMonth: "2025-04", toMonth: "2026-10" };

/** 契約外予定（§36）の空のファイル */
const OUTSIDE_EMPTY = "member_id,start_month,end_month,person_months,note\n";
const TARGETS_EMPTY = "target_type,target_id,end_month,remaining_rate,start_month,note\n";

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
    const header = "team_id,name,parent_team_id,effective_from,level,leader_member_id";
    expect(serializeMasterDoc(parseMasterDoc("teams", "")).text).toBe(`${header}\n`);
    expect(serializeMasterDoc(parseMasterDoc("teams", header)).text).toBe(`${header}\n`);
  });

  it("種別・リーダーの列が無い古い組織ファイル: ヘッダの末尾に列を足し、既存の行はそのまま残す（§21・§22）", () => {
    const old = "team_id,name,parent_team_id,effective_from\nROOT,全社,,2025-04\n";
    const doc = parseMasterDoc("teams", old);
    expect(doc.header).toEqual(["team_id", "name", "parent_team_id", "effective_from", "level", "leader_member_id"]);
    expect(serializeMasterDoc(doc).text).toBe("team_id,name,parent_team_id,effective_from,level,leader_member_id\nROOT,全社,,2025-04\n");
    const edited = updateRow(doc, doc.rows[0]!.id, { level: "本部" });
    expect(serializeMasterDoc(edited).text).toBe("team_id,name,parent_team_id,effective_from,level,leader_member_id\nROOT,全社,,2025-04,本部,\n");
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
    expect(impactOfChange("rates", ["key", "hourly_rate", "effective_from"], [["a", "1", "2025-04"]], [["a", "1", "2025-04"]], range)).toEqual({ months: [], keys: [], columns: [] });
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
    outside: parseMasterDoc("outside", OUTSIDE_EMPTY),
    targets: parseMasterDoc("targets", TARGETS_EMPTY),
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
    expect(issueText(v.byRow.assignments.o0!.find((i) => i.code === "ASSIGNMENT_UNKNOWN_MEMBER")!)).toBe("社員番号 M404 は members.csv に存在しません");
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
    outside: { text: OUTSIDE_EMPTY, lastCommitId: null },
    targets: { text: TARGETS_EMPTY, lastCommitId: null },
  };
  const pristine = (): Record<MasterFileId, MasterDoc> => ({
    members: parseMasterDoc("members", bases.members.text),
    rates: parseMasterDoc("rates", bases.rates.text),
    teams: parseMasterDoc("teams", bases.teams.text),
    assignments: parseMasterDoc("assignments", bases.assignments.text),
    outside: parseMasterDoc("outside", bases.outside.text),
    targets: parseMasterDoc("targets", bases.targets.text),
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
    expect(parseDraft(JSON.stringify({ version: 3, files: {} }))).toBeNull();
    expect(parseDraft(JSON.stringify({ version: 1, files: { bogus: {} } }))).toBeNull();
    expect(parseDraft(JSON.stringify({ version: 1, files: { rates: { baseText: "", rows: [{ id: 1, cells: [] }] } } }))).toBeNull();
    expect(parseDraft(JSON.stringify({ version: 1, files: { rates: { baseText: "", rows: [{ id: "n1", cells: [1] }] } } }))).toBeNull();
    expect(parseDraft(JSON.stringify({ version: 1, savedAt: "t", files: {} }))).not.toBeNull();
  });
});

describe("下書きの形式（土台 ＋ 差分）", () => {
  it("差分だけを持つ（変更は土台の行番号、削除は行番号、追加はセル）", () => {
    let doc = parseMasterDoc("rates", RATES);
    doc = updateRow(doc, "o1", { hourly_rate: "12500" });
    doc = deleteRow(doc, "o2");
    doc = addRow(doc, { key: "課長", hourly_rate: "11000", effective_from: "2026-11" }).doc;
    const f = draftFileOf(doc, { text: RATES, lastCommitId: "b" });
    expect(f).toEqual({ baseText: RATES, baseCommitId: "b", changed: [{ baseIndex: 1, cells: ["部長", "12500", "2025-04"] }], removed: [2], added: [["課長", "11000", "2026-11"]] });
    expect(draftFileCount(f)).toBe(3);
  });

  it("以前の形式（version 1: 編集後の全行）は差分の形に直して読む", () => {
    let doc = parseMasterDoc("rates", RATES);
    doc = deleteRow(updateRow(doc, "o0", { hourly_rate: "1" }), "o3");
    const v1 = { version: 1, savedAt: "t", files: { rates: { baseText: RATES, baseCommitId: null, rows: doc.rows, nextId: 1 } } };
    const d = parseDraft(JSON.stringify(v1))!;
    expect(d.version).toBe(2);
    expect(d.files.rates).toEqual({ baseText: RATES, baseCommitId: null, changed: [{ baseIndex: 0, cells: ["本部長", "1", "2025-04"] }], removed: [3], added: [] });
    expect(serializeMasterDoc(docFromDraft("rates", d.files.rates!)).text).toBe(serializeMasterDoc(doc).text);
  });

  it("version 2 の壊れた差分は null", () => {
    const ok = { baseText: "", baseCommitId: null, changed: [], removed: [], added: [] };
    expect(parseDraft(JSON.stringify({ version: 2, savedAt: "t", files: { rates: ok } }))).not.toBeNull();
    expect(parseDraft(JSON.stringify({ version: 2, files: { rates: { ...ok, removed: [-1] } } }))).toBeNull();
    expect(parseDraft(JSON.stringify({ version: 2, files: { rates: { ...ok, changed: [{ baseIndex: 0, cells: [1] }] } } }))).toBeNull();
    expect(parseDraft(JSON.stringify({ version: 2, files: { rates: { ...ok, added: "x" } } }))).toBeNull();
  });
});

describe("rebaseDraftFile（古い下書きを最新の土台に当て直す）", () => {
  // 下書き: 部長 12000 → 12500（o1）、主任（o2）を削除、課長を追加
  const mine = () => {
    let doc = parseMasterDoc("rates", RATES);
    doc = updateRow(doc, "o1", { hourly_rate: "12500" });
    doc = deleteRow(doc, "o2");
    return addRow(doc, { key: "課長", hourly_rate: "11000", effective_from: "2026-11" }).doc;
  };
  const draft = () => draftFileOf(mine(), { text: RATES, lastCommitId: "b" });
  const keys = (doc: MasterDoc) => doc.rows.map((r) => r.cells.join(","));

  it("土台が同じなら下書きを作った文書そのもの（stale でない）", () => {
    const r = rebaseDraftFile("rates", draft(), RATES);
    expect(r.stale).toBe(false);
    expect(r.conflicts).toEqual([]);
    expect(r.applied).toBe(3);
    expect(serializeMasterDoc(r.doc).text).toBe(serializeMasterDoc(mine()).text);
  });

  it("他の人が別の行を変え・行を足していても、下書きの変更は最新の土台に当て直され、他の人の変更も残る", () => {
    // 最新: 先頭に一般を挿入、本部長を 15500 に、末尾にパートナー行
    const latest = "key,hourly_rate,effective_from\n一般,6000,2025-04\n本部長,15500,2025-04\n部長,12000,2025-04\n主任,8000,2025-04\n部長,13000,2026-04\nP009,9000,2026-01\n";
    const r = rebaseDraftFile("rates", draft(), latest);
    expect(r.stale).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(r.applied).toBe(3);
    expect(keys(r.doc)).toEqual(["一般,6000,2025-04", "本部長,15500,2025-04", "部長,12500,2025-04", "部長,13000,2026-04", "P009,9000,2026-01", "課長,11000,2026-11"]);
    // 文書は最新の土台に対する編集（差分は自分の 3 件だけ）
    const d = diffMasterDoc(r.doc);
    expect([d.added.length, d.changed.length, d.removed.length]).toEqual([1, 1, 1]);
    expect(serializeMasterDoc(r.doc).text.startsWith("key,hourly_rate,effective_from\n一般,6000,2025-04\n本部長,15500,2025-04\n")).toBe(true);
  });

  it("同じ行を両方が変えたら衝突。選ばなければ最新のまま・unresolved、選んだ側が採られる", () => {
    const latest = RATES.replace("部長,12000,2025-04", "部長,12800,2025-04");
    const r = rebaseDraftFile("rates", draft(), latest);
    expect(r.conflicts).toEqual([
      { id: "1", kind: "both-changed", base: { key: "部長", hourly_rate: "12000", effective_from: "2025-04" }, mine: { key: "部長", hourly_rate: "12500", effective_from: "2025-04" }, theirs: { key: "部長", hourly_rate: "12800", effective_from: "2025-04" }, columns: ["hourly_rate"] },
    ]);
    expect(r.unresolved).toEqual(["1"]);
    expect(keys(r.doc)).toContain("部長,12800,2025-04");
    const m = rebaseDraftFile("rates", draft(), latest, { "1": "mine" });
    expect(m.unresolved).toEqual([]);
    expect(keys(m.doc)).toContain("部長,12500,2025-04");
    expect(keys(m.doc)).not.toContain("部長,12800,2025-04");
    const t = rebaseDraftFile("rates", draft(), latest, { "1": "theirs" });
    expect(keys(t.doc)).toContain("部長,12800,2025-04");
    // 主任の削除・課長の追加は衝突せずに当たる
    expect(keys(t.doc).some((k) => k.startsWith("主任"))).toBe(false);
    expect(keys(t.doc)).toContain("課長,11000,2026-11");
  });

  it("両方が同じ値に変えた・両方が削除した行は衝突にしない", () => {
    const latest = RATES.replace("部長,12000,2025-04", "部長,12500,2025-04").replace("主任,8000,2025-04\n", "");
    const r = rebaseDraftFile("rates", draft(), latest);
    expect(r.conflicts).toEqual([]);
    expect(r.applied).toBe(3);
    expect(diffMasterDoc(r.doc).count).toBe(1); // 追加だけが残る
  });

  it("自分が変えた行を他の人が削除・自分が消した行を他の人が変えた → それぞれ衝突（自分を選ぶと行を戻す／消す）", () => {
    const latest = RATES.replace("部長,12000,2025-04\n", "").replace("主任,8000,2025-04", "主任,8200,2025-04");
    const r = rebaseDraftFile("rates", draft(), latest);
    expect(r.conflicts.map((c) => [c.id, c.kind, c.mine === null, c.theirs === null])).toEqual([
      ["1", "changed-vs-deleted", false, true],
      ["2", "deleted-vs-changed", true, false],
    ]);
    const m = rebaseDraftFile("rates", draft(), latest, { "1": "mine", "2": "mine" });
    expect(keys(m.doc)).toEqual(["本部長,15000,2025-04", "部長,13000,2026-04", "部長,12500,2025-04", "課長,11000,2026-11"]);
    const t = rebaseDraftFile("rates", draft(), latest, { "1": "theirs", "2": "theirs" });
    expect(keys(t.doc)).toEqual(["本部長,15000,2025-04", "主任,8200,2025-04", "部長,13000,2026-04", "課長,11000,2026-11"]);
  });

  it("最新側で列が増えても、列名で当て直す（下書きに無い列は最新の値）", () => {
    const text = "member_id,name,kind,title,department,section,team_id,effective_from\nE1,山田,employee,主任,,,S11,2025-04\nE2,佐藤,employee,課長,,,S12,2025-04\n";
    let doc = parseMasterDoc("members", text);
    doc = updateRow(doc, "o1", { team_id: "S11" });
    const f = draftFileOf(doc, { text, lastCommitId: null });
    const latest = "member_id,name,kind,title,department,section,team_id,effective_from,note\nE1,山田,employee,主任,,,S11,2025-04,x\nE2,佐藤,employee,課長,,,S12,2025-04,y\n";
    const r = rebaseDraftFile("members", f, latest);
    // 列が増えたので全行の内容が変わった扱い。E2 は同じキーの行と対になり、衝突として出る（note は最新側の値を引き継ぐ）
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.mine).toMatchObject({ member_id: "E2", team_id: "S11", note: "y" });
    expect(r.conflicts[0]!.columns).toEqual(["team_id"]);
    const m = rebaseDraftFile("members", f, latest, { [r.conflicts[0]!.id]: "mine" });
    // 末尾は省略可の列 division（§60）と status（§35）。どちらの版にも無いので空
    expect(keys(m.doc)).toEqual(["E1,山田,employee,主任,,,S11,2025-04,x,,", "E2,佐藤,employee,課長,,,S11,2025-04,y,,"]);
  });

  it("土台にない行番号は無視する（壊れた下書きでも落ちない）", () => {
    const f = { baseText: RATES, baseCommitId: null, changed: [{ baseIndex: 99, cells: ["x", "1", "2026-01"] }], removed: [42], added: [] };
    const r = rebaseDraftFile("rates", f, RATES);
    expect(r.conflicts).toEqual([]);
    expect(serializeMasterDoc(r.doc).text).toBe(RATES);
  });
});

describe("影響ダイアログの「何が変わるか」", () => {
  const MEMBERS = "member_id,name,kind,title,department,section,team_id,effective_from\nE1,山田,employee,主任,第1事業部,1課,S11,2025-04\n";
  const m = parseMasterDoc("members", MEMBERS);

  it("所属チームだけを変える行の追加 → 列は team_id だけ。原価・粗利は変わらないと明記", () => {
    const after = addRow(m, { member_id: "E1", name: "山田", kind: "employee", title: "主任", department: "第1事業部", section: "1課", team_id: "S12", effective_from: "2026-04" }).doc;
    const imp = impactBetween(m, after, range);
    expect(imp.months).toHaveLength(7);
    expect(imp.columns).toEqual(["team_id"]);
    const e = describeImpactEffects("members", imp.columns);
    expect(e.costChanges).toBe(false);
    expect(e.effects.join("")).toContain("組織別の集計");
    expect(e.effects.join("")).not.toContain("原価・粗利");
    expect(e.note).toContain("実績・残予算・消化率・着地見込みは変わりません");
  });

  it("部署・課だけ → 部署・課の表示。役職 → 単価と実績・残予算・消化率・着地見込み（先頭）", () => {
    const dept = updateRow(m, "o0", { department: "第2事業部", section: "2課" });
    expect(impactBetween(m, dept, range).columns).toEqual(["department", "section"]);
    expect(describeImpactEffects("members", ["department", "section"]).effects).toEqual(["メンバー詳細の事業本部・部・課の表示"]);
    expect(describeImpactEffects("members", ["division"]).effects).toEqual(["メンバー詳細の事業本部・部・課の表示"]);
    const title = updateRow(m, "o0", { title: "課長", team_id: "S12" });
    const cols = impactBetween(m, title, range).columns;
    expect(cols).toEqual(["title", "team_id"]);
    const e = describeImpactEffects("members", cols);
    expect(e.costChanges).toBe(true);
    expect(e.effects[0]).toBe("時間単価と、実績・残予算・消化率・着地見込み");
    expect(e.note).toBeNull();
  });

  it("行が増える・無くなる月はキー列も変わった列に含める。値が同じで適用開始月だけ違う月は数えない", () => {
    const del = deleteRow(m, "o0");
    expect(impactBetween(m, del, range).columns).toEqual(["member_id", "name", "kind", "title", "department", "section", "team_id"]);
    const same = addRow(m, { member_id: "E1", name: "山田", kind: "employee", title: "主任", department: "第1事業部", section: "1課", team_id: "S11", effective_from: "2026-04" }).doc;
    expect(impactBetween(m, same, range)).toEqual({ months: [], keys: ["E1"], columns: [] });
  });

  it("単価・チーム・アサイン", () => {
    const before = parseMasterDoc("rates", RATES);
    const imp = impactBetween(before, updateRow(before, "o0", { hourly_rate: "1" }), range);
    expect(imp.columns).toEqual(["hourly_rate"]);
    expect(describeImpactEffects("rates", imp.columns).costChanges).toBe(true);
    expect(describeImpactEffects("teams", ["name"]).effects).toEqual(["チーム名の表示"]);
    expect(describeImpactEffects("teams", ["parent_team_id"]).effects[0]).toContain("上位組織の合計");
    expect(describeImpactEffects("assignments", ["allocation"]).effects[0]).toContain("着地見込み（計画値）");
    expect(describeImpactEffects("rates", [])).toEqual({ effects: ["その月の行の値"], costChanges: false, note: null });
  });
});

describe("stampChangedRows（変更者・変更日、§56）", () => {
  const ASSIGN = "member_id,contract_id,start_month,end_month,allocation\nM1,C1,2025-04,2025-09,0.5\n\"M2\",C1,2025-04,2025-09,0.3\n";

  it("見出しに列を足し、追加・変更した行だけに書く。変えていない行は元のテキストのまま", () => {
    let doc = parseMasterDoc("assignments", ASSIGN);
    doc = updateRow(doc, "o0", { allocation: "0.6" });
    doc = addRow(doc, { member_id: "M3", contract_id: "C1", start_month: "2025-10", end_month: "2025-10", allocation: "0.2" }).doc;
    const text = serializeMasterDoc(stampChangedRows(doc, "taro", "2025-10-01")).text;
    expect(text).toBe(
      "member_id,contract_id,start_month,end_month,allocation,updated_by,updated_at\n" +
        "M1,C1,2025-04,2025-09,0.6,taro,2025-10-01\n" +
        '"M2",C1,2025-04,2025-09,0.3\n' +
        "M3,C1,2025-10,2025-10,0.2,taro,2025-10-01\n",
    );
  });

  it("列が既にあれば見出しはそのまま。前の記録は上書きする", () => {
    let doc = parseMasterDoc("assignments", "member_id,contract_id,start_month,end_month,allocation,updated_by,updated_at\nM1,C1,2025-04,2025-09,0.5,hanako,2025-04-01\nM2,C1,2025-04,2025-09,0.3,hanako,2025-04-01\n");
    doc = updateRow(doc, "o1", { allocation: "0.4" });
    const text = serializeMasterDoc(stampChangedRows(doc, "taro", "2025-10-01")).text;
    expect(text).toBe("member_id,contract_id,start_month,end_month,allocation,updated_by,updated_at\nM1,C1,2025-04,2025-09,0.5,hanako,2025-04-01\nM2,C1,2025-04,2025-09,0.4,taro,2025-10-01\n");
  });

  it("変更が無い・対象外のファイルは何もしない", () => {
    const doc = parseMasterDoc("assignments", ASSIGN);
    expect(stampChangedRows(doc, "taro", "2025-10-01")).toBe(doc);
    let rates = parseMasterDoc("rates", RATES);
    rates = updateRow(rates, "o0", { hourly_rate: "16000" });
    expect(stampChangedRows(rates, "taro", "2025-10-01")).toBe(rates);
  });

  it("元の文書は変えない", () => {
    let doc = parseMasterDoc("outside", "member_id,type,start_month,end_month,person_months,note\nM1,提案,2025-04,2025-04,0.1,\n");
    doc = updateRow(doc, "o0", { person_months: "0.2" });
    const before = JSON.stringify(doc);
    const stamped = stampChangedRows(doc, "", "2025-10-01");
    expect(JSON.stringify(doc)).toBe(before);
    expect(serializeMasterDoc(stamped).text).toBe("member_id,type,start_month,end_month,person_months,note,updated_by,updated_at\nM1,提案,2025-04,2025-04,0.2,,,2025-10-01\n");
  });
});
