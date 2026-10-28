/**
 * マスタ編集の下書きの当て直し（SPEC §19.2）のプロパティテスト
 * - 任意の土台の変更（他の人の変更・削除・挿入）と下書きの差分で、衝突しない行は必ず保たれる
 * - 衝突は「両方が同じ行を違う結果にした」行ちょうど。選んだ側が採られる
 * - 当て直しは決定的で冪等（結果を下書きにしてもう一度当て直しても同じ）
 * - 土台が変わっていなければ、下書きを作った文書そのものに戻る
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MASTER_FILES,
  addRow,
  deleteRow,
  draftFileOf,
  formatCsvRecord,
  parseMasterDoc,
  rebaseDraftFile,
  serializeMasterDoc,
  updateRow,
  type ConflictChoice,
  type MasterDoc,
} from "../../src/core/masterEdit.js";

const HEADER = MASTER_FILES.members.columns.map((c) => c.name);
const W = HEADER.length;
const NAME = HEADER.indexOf("name");
const TEAM = HEADER.indexOf("team_id");

const valueArb = fc.constantFrom("", "a", "b", "c", "部長", "S11", "x,y", 'q"q', "2026-04");
const toText = (rows: readonly string[][]): string => [HEADER.join(","), ...rows.map((r) => formatCsvRecord(r))].join("\n") + "\n";
const rowsOf = (doc: MasterDoc): string[][] => doc.rows.map((r) => r.cells.map((c) => c.trim()));

/** 1 行に対する操作（none / 変更 = 氏名と所属チームを変える / 削除） */
type Act = { kind: "none" } | { kind: "change"; name: string; team: string } | { kind: "delete" };
const actArb: fc.Arbitrary<Act> = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ kind: "none" } as Act) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("change" as const), name: valueArb, team: valueArb }) },
  { weight: 1, arbitrary: fc.constant({ kind: "delete" } as Act) },
);

const scenarioArb = fc
  .integer({ min: 0, max: 12 })
  .chain((n) =>
    fc.record({
      // キー（member_id）は行ごとに一意。他の列は自由
      base: fc.array(fc.array(valueArb, { minLength: W, maxLength: W }), { minLength: n, maxLength: n }),
      mine: fc.array(actArb, { minLength: n, maxLength: n }),
      theirs: fc.array(actArb, { minLength: n, maxLength: n }),
      added: fc.array(fc.array(valueArb, { minLength: W, maxLength: W }), { maxLength: 3 }),
      inserted: fc.array(fc.record({ at: fc.nat({ max: n }), cells: fc.array(valueArb, { minLength: W, maxLength: W }) }), { maxLength: 3 }),
      pick: fc.array(fc.constantFrom<ConflictChoice>("mine", "theirs"), { minLength: n, maxLength: n }),
    }),
  );

function withKey(cells: string[], key: string): string[] {
  const c = cells.slice();
  c[0] = key;
  c[HEADER.indexOf("effective_from")] = "2026-04";
  return c;
}

/** 操作を当てた行（null = 削除。値が元と同じ変更は none 扱い） */
function result(row: string[], act: Act): string[] | null {
  if (act.kind === "delete") return null;
  if (act.kind === "none") return row;
  const c = row.slice();
  c[NAME] = act.name;
  c[TEAM] = act.team;
  return c;
}
const same = (a: string[] | null, b: string[] | null) => JSON.stringify(a) === JSON.stringify(b);

describe("rebaseDraftFile（下書きの当て直し）", () => {
  it("衝突しない行は必ず保たれ、衝突は両方が同じ行を違う結果にした行ちょうど。選んだ側が採られる", () => {
    fc.assert(
      fc.property(scenarioArb, (sc) => {
        const n = sc.base.length;
        const baseRows = sc.base.map((r, i) => withKey(r, `M${i}`));
        const baseText = toText(baseRows);
        // 下書き: 土台の文書に mine の操作を当てる
        let doc = parseMasterDoc("members", baseText);
        for (let i = 0; i < n; i++) {
          const act = sc.mine[i]!;
          if (act.kind === "change") doc = updateRow(doc, `o${i}`, { name: act.name, team_id: act.team });
          else if (act.kind === "delete") doc = deleteRow(doc, `o${i}`);
        }
        const addedRows = sc.added.map((r, k) => withKey(r, `A${k}`));
        for (const r of addedRows) doc = addRow(doc, Object.fromEntries(HEADER.map((h, i) => [h, r[i]!]))).doc;
        const draft = draftFileOf(doc, { text: baseText, lastCommitId: null });

        // 最新の土台: theirs の操作 ＋ 他の人の挿入
        const theirRows = baseRows.map((r, i) => result(r, sc.theirs[i]!));
        const latestRows: string[][] = [];
        const inserts = sc.inserted.map((x, k) => ({ at: x.at, cells: withKey(x.cells, `T${k}`) }));
        for (let i = 0; i <= n; i++) {
          for (const x of inserts) if (x.at === i) latestRows.push(x.cells);
          if (i < n && theirRows[i]) latestRows.push(theirRows[i]!);
        }
        const latestText = toText(latestRows);

        // 期待: 行ごとに、衝突なら選んだ側、そうでなければ変えた側
        const choices: Record<string, ConflictChoice> = {};
        const expectedConflicts: string[] = [];
        const mineRows = baseRows.map((r, i) => result(r, sc.mine[i]!));
        for (let i = 0; i < n; i++) {
          const m = mineRows[i]!;
          const t = theirRows[i]!;
          const mineActs = !same(m, baseRows[i]!);
          const theirActs = !same(t, baseRows[i]!);
          if (mineActs && theirActs && !same(m, t)) {
            expectedConflicts.push(String(i));
            choices[String(i)] = sc.pick[i]!;
          }
        }
        const r = rebaseDraftFile("members", draft, latestText, choices);
        expect(r.conflicts.map((c) => c.id)).toEqual(expectedConflicts);
        expect(r.unresolved).toEqual([]);

        // 期待する行の並び: 最新の並び（挿入を含む）に各行の結果、末尾に「最新で削除済みだが自分を選んだ行」→ 追加行
        const expected: string[][] = [];
        const appended: string[][] = [];
        for (let i = 0; i <= n; i++) {
          for (const x of inserts) if (x.at === i) expected.push(x.cells);
          if (i === n) break;
          const m = mineRows[i]!;
          const t = theirRows[i]!;
          const conflict = expectedConflicts.includes(String(i));
          const out = conflict ? (choices[String(i)] === "mine" ? m : t) : !same(m, baseRows[i]!) ? m : t;
          if (out === null) continue;
          if (t === null) appended.push(out); // 最新で削除・自分の変更を残した
          else expected.push(out);
        }
        expect(rowsOf(r.doc)).toEqual([...expected, ...appended, ...addedRows]);
      }),
      { numRuns: 400 },
    );
  });

  it("決定的で冪等: 同じ入力は同じ結果。結果を下書きにして同じ土台へもう一度当て直しても変わらず、衝突も無い", () => {
    // キーが重複しうる任意のデータ
    const rowsArb = fc.array(fc.array(fc.constantFrom("", "a", "b", "M1", "M2", "2026-04"), { minLength: W, maxLength: W }), { maxLength: 8 });
    const editArb = fc.array(
      fc.oneof(
        fc.record({ k: fc.constant("u" as const), row: fc.nat(), col: fc.nat({ max: W - 1 }), v: fc.constantFrom("", "a", "z") }),
        fc.record({ k: fc.constant("d" as const), row: fc.nat() }),
        fc.record({ k: fc.constant("a" as const), cells: fc.array(fc.constantFrom("a", "M3", "2026-05"), { minLength: W, maxLength: W }) }),
      ),
      { maxLength: 6 },
    );
    const edit = (doc: MasterDoc, ops: Array<{ k: string; row?: number; col?: number; v?: string; cells?: string[] }>): MasterDoc => {
      let d = doc;
      for (const op of ops) {
        if (op.k === "a") d = addRow(d, Object.fromEntries(HEADER.map((h, i) => [h, op.cells![i]!]))).doc;
        else if (d.rows.length > 0) {
          const row = d.rows[op.row! % d.rows.length]!;
          d = op.k === "u" ? updateRow(d, row.id, { [HEADER[op.col!]!]: op.v! }) : deleteRow(d, row.id);
        }
      }
      return d;
    };
    fc.assert(
      fc.property(rowsArb, editArb, editArb, fc.constantFrom<ConflictChoice>("mine", "theirs"), (rows, mineOps, theirOps, choice) => {
        const baseText = toText(rows);
        const mine = edit(parseMasterDoc("members", baseText), mineOps);
        const draft = draftFileOf(mine, { text: baseText, lastCommitId: null });
        // 土台が同じなら、下書きを作った文書そのもの
        const own = rebaseDraftFile("members", draft, baseText);
        expect(own.conflicts).toEqual([]);
        expect(own.stale).toBe(false);
        expect(serializeMasterDoc(own.doc).text).toBe(serializeMasterDoc(mine).text);

        const latestText = serializeMasterDoc(edit(parseMasterDoc("members", baseText), theirOps)).text;
        const first = rebaseDraftFile("members", draft, latestText);
        const choices = Object.fromEntries(first.conflicts.map((c) => [c.id, choice]));
        const r1 = rebaseDraftFile("members", draft, latestText, choices);
        const r1b = rebaseDraftFile("members", draft, latestText, choices);
        expect(JSON.stringify(r1b)).toBe(JSON.stringify(r1));
        expect(r1.unresolved).toEqual([]);
        // 冪等
        const again = draftFileOf(r1.doc, { text: latestText, lastCommitId: null });
        const r2 = rebaseDraftFile("members", again, latestText);
        expect(r2.conflicts).toEqual([]);
        expect(serializeMasterDoc(r2.doc).text).toBe(serializeMasterDoc(r1.doc).text);
        const r3 = rebaseDraftFile("members", draftFileOf(r2.doc, { text: latestText, lastCommitId: null }), latestText);
        expect(serializeMasterDoc(r3.doc).text).toBe(serializeMasterDoc(r1.doc).text);
      }),
      { numRuns: 400 },
    );
  });
});
