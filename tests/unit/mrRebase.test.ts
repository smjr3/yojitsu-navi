/**
 * マージリクエストの衝突を減らす（SPEC §120）
 * - 追加する行は同じキー（同じ人）の行のすぐ後ろに入る（ファイル末尾どうしで衝突しない）
 * - 「最新に載せ直す」: MR の変更を本体の今の中身に行単位で当て直す
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addRow, deleteRow, insertionIndex, MASTER_FILES, parseMasterDoc, rebaseDraftFile, draftFileOf, restoreRow, serializeMasterDoc, updateRow } from "../../src/core/masterEdit.js";
import { rebaseRemake, rebaseRemakeFile, type RemakeFile } from "../../src/core/mrRebase.js";

const ASSIGN = [
  "member_id,contract_id,start_month,end_month,allocation,updated_by,updated_at",
  "M1,C1,2026-04,2027-03,0.5,a,2026-04-01",
  "M1,C2,2026-04,2027-03,0.5,a,2026-04-01",
  "M2,C1,2026-04,2027-03,1.0,a,2026-04-01",
  "M3,C3,2026-04,2027-03,1.0,a,2026-04-01",
  "M4,C3,2026-04,2027-03,1.0,a,2026-04-01",
  "",
].join("\n");

const lines = (text: string) => text.trimEnd().split("\n");
const add = (text: string, values: Record<string, string>) => serializeMasterDoc(addRow(parseMasterDoc("assignments", text), values).doc).text;

describe("追加する行の位置（insertionIndex）", () => {
  it("同じ人・同じ案件の最後の行の後ろ。同じ案件が無ければ同じ人の最後の行の後ろ。どちらも無ければ末尾", () => {
    expect(lines(add(ASSIGN, { member_id: "M1", contract_id: "C1", start_month: "2026-10", end_month: "2027-03", allocation: "0.3" }))[2]).toBe("M1,C1,2026-10,2027-03,0.3,,");
    expect(lines(add(ASSIGN, { member_id: "M2", contract_id: "C9", start_month: "2026-10", end_month: "2027-03", allocation: "0.3" }))[4]).toBe("M2,C9,2026-10,2027-03,0.3,,");
    expect(lines(add(ASSIGN, { member_id: "M9", contract_id: "C1", start_month: "2026-10", end_month: "2027-03", allocation: "0.3" })).at(-1)).toBe("M9,C1,2026-10,2027-03,0.3,,");
  });

  it("同じキーの行が離れていても最後の行の後ろ（§5 の「同じ適用開始月なら後の行」が変わらない）", () => {
    const rates = "key,hourly_rate,effective_from\n部長,12000,2026-04\n主任,9000,2026-04\n部長,12500,2026-10\n";
    const doc = addRow(parseMasterDoc("rates", rates), { key: "部長", hourly_rate: "13000", effective_from: "2026-10" }).doc;
    expect(lines(serializeMasterDoc(doc).text)).toEqual(["key,hourly_rate,effective_from", "部長,12000,2026-04", "主任,9000,2026-04", "部長,12500,2026-10", "部長,13000,2026-10"]);
  });

  it("続けて足した行は足した順に並ぶ。キーが空の行は末尾", () => {
    let doc = parseMasterDoc("assignments", ASSIGN);
    doc = addRow(doc, { member_id: "M1", contract_id: "C1", start_month: "2026-10", end_month: "2026-12", allocation: "0.1" }).doc;
    doc = addRow(doc, { member_id: "M1", contract_id: "C1", start_month: "2027-01", end_month: "2027-03", allocation: "0.2" }).doc;
    doc = addRow(doc, { member_id: "", contract_id: "" }).doc;
    const out = lines(serializeMasterDoc(doc).text);
    expect(out.slice(1, 4)).toEqual(["M1,C1,2026-04,2027-03,0.5,a,2026-04-01", "M1,C1,2026-10,2026-12,0.1,,", "M1,C1,2027-01,2027-03,0.2,,"]);
    expect(doc.rows.at(-1)!.id).toBe("n3");
  });

  it("案件は同じ顧客の後ろ、組織は同じ親の後ろ（placeAfter）", () => {
    expect(MASTER_FILES.contracts.placeAfter).toEqual(["customer_name"]);
    const header = ["contract_id", "customer_name"];
    const rows = [{ cells: ["C1", "甲"] }, { cells: ["C2", "乙"] }, { cells: ["C3", "丙"] }];
    expect(insertionIndex(MASTER_FILES.contracts, header, rows, ["C9", "乙"])).toBe(2);
    expect(insertionIndex(MASTER_FILES.contracts, header, rows, ["C9", "丁"])).toBe(3);
  });

  it("削除を取り消すと元の位置に戻る（間に足した行があっても）", () => {
    let doc = parseMasterDoc("assignments", ASSIGN);
    doc = addRow(doc, { member_id: "M1", contract_id: "C2", start_month: "2026-10", end_month: "2027-03", allocation: "0.1" }).doc;
    doc = deleteRow(doc, "o2");
    doc = restoreRow(doc, "o2");
    expect(doc.rows.map((r) => r.id)).toEqual(["o0", "o1", "n1", "o2", "o3", "o4"]);
  });

  it("下書きを当て直しても、足した行は同じ人の行の後ろに入る", () => {
    const doc = addRow(parseMasterDoc("assignments", ASSIGN), { member_id: "M2", contract_id: "C1", start_month: "2026-10", end_month: "2027-03", allocation: "0.5" }).doc;
    const draft = draftFileOf(doc, { text: ASSIGN, lastCommitId: null });
    const latest = ASSIGN + "M5,C1,2026-04,2027-03,1.0,b,2026-05-01\n";
    const out = lines(serializeMasterDoc(rebaseDraftFile("assignments", draft, latest).doc).text);
    expect(out[4]).toBe("M2,C1,2026-10,2027-03,0.5,,");
    expect(out.at(-1)).toBe("M5,C1,2026-04,2027-03,1.0,b,2026-05-01");
  });
});

/** git の 3 方向マージ（GitLab のマージと同じ判定）で衝突するか。git が無い環境では null */
function gitConflicts(base: string, ours: string, theirs: string): boolean | null {
  const dir = mkdtempSync(join(tmpdir(), "yn-merge-"));
  try {
    writeFileSync(join(dir, "base"), base);
    writeFileSync(join(dir, "ours"), ours);
    writeFileSync(join(dir, "theirs"), theirs);
    try {
      execFileSync("git", ["merge-file", join(dir, "ours"), join(dir, "base"), join(dir, "theirs")], { stdio: "ignore" });
      return false;
    } catch (e) {
      const status = (e as { status?: number | null }).status;
      if (typeof status === "number" && status > 0) return true;
      return null;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("別々の人を直した 2 本の MR が git で衝突しない", () => {
  it("M1 と M3 にそれぞれ行を足しても、3 方向マージで衝突しない（前は両方とも末尾に足して衝突していた）", () => {
    const a = add(ASSIGN, { member_id: "M1", contract_id: "C2", start_month: "2026-10", end_month: "2027-03", allocation: "0.2" });
    const b = add(ASSIGN, { member_id: "M3", contract_id: "C3", start_month: "2026-10", end_month: "2027-03", allocation: "0.5" });
    const r = gitConflicts(ASSIGN, a, b);
    if (r === null) return; // git が無い
    expect(r).toBe(false);
    const appended = (v: string) => ASSIGN + v + "\n";
    expect(gitConflicts(ASSIGN, appended("M1,C2,2026-10,2027-03,0.2,,"), appended("M3,C3,2026-10,2027-03,0.5,,"))).toBe(true);
  });
});

describe("最新に載せ直す（rebaseRemake）", () => {
  const file = (after: string, latest: string | null, before: string | null = ASSIGN): RemakeFile => ({ fileId: "assignments", path: "data/assignments.csv", before, after, latest, latestCommitId: "L1" });
  // この MR: M1/C1 を 0.5 → 0.6、M4 に行を足す
  const mr = () => {
    let doc = parseMasterDoc("assignments", ASSIGN);
    doc = updateRow(doc, "o0", { allocation: "0.6", updated_by: "suzuki", updated_at: "2026-11-01" });
    doc = addRow(doc, { member_id: "M4", contract_id: "C1", start_month: "2026-10", end_month: "2027-03", allocation: "0.2", updated_by: "suzuki", updated_at: "2026-11-01" }).doc;
    return serializeMasterDoc(doc).text;
  };

  it("本体で別の行が変わっていても、この MR の変更を当て直す。変更者・変更日はこの MR のまま", () => {
    const latest = ASSIGN.replace("M3,C3,2026-04,2027-03,1.0,a,2026-04-01", "M3,C3,2026-04,2027-03,0.8,sato,2026-11-02");
    const r = rebaseRemake({ files: [file(mr(), latest)] });
    expect(r.unresolved).toBe(0);
    expect(r.blocked).toBe(false);
    expect(r.empty).toBe(false);
    const out = lines(r.files[0]!.text!);
    expect(out).toContain("M1,C1,2026-04,2027-03,0.6,suzuki,2026-11-01");
    expect(out).toContain("M3,C3,2026-04,2027-03,0.8,sato,2026-11-02");
    expect(out.at(-1)).toBe("M4,C1,2026-10,2027-03,0.2,suzuki,2026-11-01");
    expect(r.files[0]!.lastCommitId).toBe("L1");
    expect(r.files[0]!.create).toBe(false);
  });

  it("同じ行を本体でも別の値に変えていたら衝突。選ぶまで中身を作らず、選んだ方で作る", () => {
    const latest = ASSIGN.replace("M1,C1,2026-04,2027-03,0.5,a,2026-04-01", "M1,C1,2026-04,2027-03,0.4,sato,2026-11-02");
    const r = rebaseRemake({ files: [file(mr(), latest)] });
    expect(r.unresolved).toBe(1);
    expect(r.files[0]!.text).toBeNull();
    const id = r.files[0]!.result!.conflicts[0]!.id;
    const mine = rebaseRemake({ files: [file(mr(), latest)] }, { assignments: { [id]: "mine" } });
    expect(lines(mine.files[0]!.text!)).toContain("M1,C1,2026-04,2027-03,0.6,suzuki,2026-11-01");
    const theirs = rebaseRemake({ files: [file(mr(), latest)] }, { assignments: { [id]: "theirs" } });
    expect(lines(theirs.files[0]!.text!)).toContain("M1,C1,2026-04,2027-03,0.4,sato,2026-11-02");
    expect(lines(theirs.files[0]!.text!)).toContain("M4,C1,2026-10,2027-03,0.2,suzuki,2026-11-01");
  });

  it("この MR の変更がすべて本体に入っていれば empty。そのファイルは保存しない", () => {
    const changedOnly = ASSIGN.replace("M1,C1,2026-04,2027-03,0.5,a,2026-04-01", "M1,C1,2026-04,2027-03,0.6,suzuki,2026-11-01");
    const r = rebaseRemake({ files: [file(changedOnly, changedOnly)] });
    expect(r.empty).toBe(true);
    expect(r.files[0]!.changed).toBe(false);
  });

  it("MR で作ったファイル（土台に無い）を、本体にもまだ無いなら作る", () => {
    const after = "member_id,type,start_month,end_month,person_months,note,updated_by,updated_at\nM1,提案,2026-11,2026-12,0.2,,suzuki,2026-11-01\n";
    const r = rebaseRemakeFile({ fileId: "outside", path: "data/outside-plans.csv", before: null, after, latest: null, latestCommitId: null });
    expect(r.create).toBe(true);
    expect(r.changed).toBe(true);
    expect(lines(r.text!).at(-1)).toBe("M1,提案,2026-11,2026-12,0.2,,suzuki,2026-11-01");
  });

  it("MR で列を足していても（仮の単価の provisional）読める", () => {
    const before = "key,hourly_rate,effective_from\n部長,12000,2026-04\n";
    const after = "key,hourly_rate,effective_from,provisional\n部長,12000,2026-04,\n主任,9000,2026-04,1\n";
    const latest = "key,hourly_rate,effective_from\n部長,12000,2026-04\n課長,11000,2026-04\n";
    const r = rebaseRemakeFile({ fileId: "rates", path: "data/masters/rates.csv", before, after, latest, latestCommitId: "x" });
    expect(r.error).toBeUndefined();
    expect(lines(r.text!)).toEqual(["key,hourly_rate,effective_from,provisional", "部長,12000,2026-04", "主任,9000,2026-04,1", "課長,11000,2026-04"]);
  });

  it("MR でファイルを消していたら載せ直せない（blocked）", () => {
    const r = rebaseRemake({ files: [file(null as unknown as string, ASSIGN)].map((f) => ({ ...f, after: null })) });
    expect(r.blocked).toBe(true);
    expect(r.files[0]!.error).toBe("deleted");
  });
});
