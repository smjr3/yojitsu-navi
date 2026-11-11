/** 保存前の変更内容の要約（人 × 作業 × 月。SPEC §117） */
import { describe, expect, it } from "vitest";
import { addRow, deleteRow, parseMasterDoc, updateRow } from "../../src/core/masterEdit.js";
import { planChangeSummary } from "../../src/core/index.js";

const COLS = { targetCol: "contract_id", valueCol: "allocation" };
const TEXT = "member_id,contract_id,start_month,end_month,allocation\nM1,C1,2026-04,2027-03,0.9\nM2,C2,2026-04,2026-09,0.5\n";

describe("planChangeSummary", () => {
  it("変更が無ければ空", () => {
    expect(planChangeSummary(parseMasterDoc("assignments", TEXT), COLS)).toEqual([]);
  });

  it("1 か月だけ変えた（期間を 3 行に分けた）ら、その月だけ「前 → 後」", () => {
    let doc = parseMasterDoc("assignments", TEXT);
    const id = doc.rows[0]!.id;
    doc = updateRow(doc, id, { end_month: "2026-10" });
    doc = addRow(doc, { member_id: "M1", contract_id: "C1", start_month: "2026-11", end_month: "2026-11", allocation: "0.5" }).doc;
    doc = addRow(doc, { member_id: "M1", contract_id: "C1", start_month: "2026-12", end_month: "2027-03", allocation: "0.9" }).doc;
    expect(planChangeSummary(doc, COLS)).toEqual([{ memberId: "M1", target: "C1", runs: [{ from: "2026-11", to: "2026-11", before: 0.9, after: 0.5 }] }]);
  });

  it("続いた月で前後が同じならまとめる。行を消すと「→ 0」", () => {
    let doc = parseMasterDoc("assignments", TEXT);
    doc = deleteRow(doc, doc.rows[1]!.id);
    expect(planChangeSummary(doc, COLS)).toEqual([{ memberId: "M2", target: "C2", runs: [{ from: "2026-04", to: "2026-09", before: 0.5, after: 0 }] }]);
  });

  it("行の分け方だけ変えて月の値が同じなら、その人は出さない", () => {
    let doc = parseMasterDoc("assignments", TEXT);
    doc = updateRow(doc, doc.rows[1]!.id, { end_month: "2026-06" });
    doc = addRow(doc, { member_id: "M2", contract_id: "C2", start_month: "2026-07", end_month: "2026-09", allocation: "0.5" }).doc;
    expect(planChangeSummary(doc, COLS)).toEqual([]);
  });

  it("作業を付け替えたら、元の作業は減り、新しい作業は増える", () => {
    let doc = parseMasterDoc("assignments", TEXT);
    doc = updateRow(doc, doc.rows[1]!.id, { contract_id: "C3" });
    expect(planChangeSummary(doc, COLS).map((c) => [c.target, c.runs[0]!.before, c.runs[0]!.after])).toEqual([
      ["C2", 0.5, 0],
      ["C3", 0, 0.5],
    ]);
  });

  it("全角の数値も計算と同じに読む", () => {
    let doc = parseMasterDoc("assignments", TEXT.replace("0.5\n", "０．５\n"));
    doc = deleteRow(doc, doc.rows[1]!.id);
    expect(planChangeSummary(doc, COLS)[0]!.runs[0]!.before).toBe(0.5);
  });

  it("月が誤っている行（2026-13 など）は数えず、例外にしない（検証の一覧で直す）", () => {
    let doc = parseMasterDoc("assignments", TEXT);
    doc = updateRow(doc, doc.rows[1]!.id, { start_month: "2026-13" });
    expect(() => planChangeSummary(doc, COLS)).not.toThrow();
    expect(planChangeSummary(doc, COLS)[0]!.runs[0]).toMatchObject({ from: "2026-04", to: "2026-09", before: 0.5, after: 0 });
  });
});
