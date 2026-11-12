/**
 * 取り込んだメンバーを data/masters/members.csv に反映する（純粋関数。ファイルは触らない）
 *
 * 規則（docs/SPEC.md §20.2）:
 * - 現在の有効レコード = そのメンバーの effective_from <= 実行月 で最新の行。
 *   未来日付の行しか無い人は、いちばん早い行を土台に実行月の行を足す
 * - 実行月より後の行は残すが、旧値をそのまま引き継いでいる項目は新しい値に揃える
 * - name / kind / title / division / department / section のどれかが違う人だけ、effective_from = 実行月の行を追加
 *   （team_id など取り込まない列は直前の有効レコードを引き継ぐ）
 * - 実行月の行がすでにある人が同じ月にまた変わったときは、その行を更新する（同じ月に 2 行にしない）
 * - 取り込み元に無い既存メンバーは削除しない
 * - 取り込み元に無い新しい人は team_id 空で追加
 * - 同じ入力をもう一度流しても何も変わらない（冪等）
 */
import { csvFormat } from "d3-dsv";
import type { MemberImport } from "../adapters/members.js";

export const MEMBER_CSV_COLUMNS = ["member_id", "name", "kind", "title", "division", "department", "section", "team_id", "effective_from", "status"] as const;

export type MemberCsvRow = Record<string, string>;

export interface MemberChange {
  memberId: string;
  kind: "added" | "changed";
  /** 変わった項目（CSV の列名） */
  fields: string[];
}

export interface MergeResult {
  rows: MemberCsvRow[];
  added: number;
  changed: number;
  unchanged: number;
  /** 取り込み元に無く、そのまま残した人数 */
  keptNotInSource: number;
  changes: MemberChange[];
}

const FIELD_COLUMN: Array<[keyof MemberImport, string]> = [
  ["name", "name"],
  ["kind", "kind"],
  ["title", "title"],
  ["division", "division"],
  ["department", "department"],
  ["section", "section"],
];

type Rec = { row: MemberCsvRow; idx: number };

function sortedByFrom(rows: Rec[]): Rec[] {
  return [...rows].sort((a, b) => (a.row.effective_from ?? "").localeCompare(b.row.effective_from ?? "") || a.idx - b.idx);
}

/**
 * 実行月時点の有効レコード（effective_from <= 実行月で最新）。
 * 実行月より前の行が 1 つも無い（未来日付の行しか無い）ときは undefined。
 */
function currentRecord(rows: Rec[], month: string): Rec | undefined {
  const upToNow = sortedByFrom(rows).filter((r) => (r.row.effective_from ?? "") <= month);
  return upToNow[upToNow.length - 1];
}

export function mergeMembers(existing: readonly MemberCsvRow[], imported: readonly MemberImport[], month: string): MergeResult {
  const rows: MemberCsvRow[] = existing.map((r) => ({ ...r }));
  const byId = new Map<string, Array<{ row: MemberCsvRow; idx: number }>>();
  rows.forEach((row, idx) => {
    const id = (row.member_id ?? "").trim();
    const list = byId.get(id) ?? [];
    list.push({ row, idx });
    byId.set(id, list);
  });

  let added = 0;
  let changed = 0;
  let unchanged = 0;
  const changes: MemberChange[] = [];
  const importedIds = new Set<string>();

  for (const m of imported) {
    importedIds.add(m.memberId);
    const history = byId.get(m.memberId);
    if (!history) {
      const row: MemberCsvRow = {
        member_id: m.memberId,
        name: m.name ?? "",
        kind: m.kind ?? "employee",
        title: m.title ?? "",
        division: m.division ?? "",
        department: m.department ?? "",
        section: m.section ?? "",
        team_id: "",
        effective_from: month,
        status: "",
      };
      rows.push(row);
      byId.set(m.memberId, [{ row, idx: rows.length - 1 }]);
      added++;
      changes.push({ memberId: m.memberId, kind: "added", fields: [] });
      continue;
    }
    // 未来日付の行しか無い人は、いちばん早い行を土台に実行月の行を足す（チームなどを引き継ぐ）
    const curRec = currentRecord(history, month);
    const cur = curRec?.row ?? (sortedByFrom(history)[0] as Rec).row;
    const diff: string[] = [];
    for (const [key, col] of FIELD_COLUMN) {
      const v = m[key];
      if (v === undefined) continue;
      if ((cur[col] ?? "").trim() !== v) diff.push(col);
    }
    // 在籍状態（§35）は取り込みで変えない。取り込み元に無い人を不在にはせず（一時的な欠けで不在扱いにしないため）、
    // 不在の人が取り込み元にいても在籍に戻さない（休職中の人も載っているため。復帰は台帳で在籍の行を足す）
    if (diff.length === 0 && curRec) {
      unchanged++;
      continue;
    }
    changed++;
    changes.push({ memberId: m.memberId, kind: "changed", fields: diff });
    // 実行月より後の行（予定された変更）は残す。ただし旧値をそのまま引き継いでいる項目は新しい値に揃える
    // （揃えないと、その日付になった時点で古い値に戻ってしまう）
    const oldValues = { ...cur };
    for (const f of history) {
      if ((f.row.effective_from ?? "") <= month) continue;
      for (const [key, col] of FIELD_COLUMN) {
        const v = m[key];
        if (v !== undefined && (f.row[col] ?? "").trim() === (oldValues[col] ?? "").trim()) f.row[col] = v;
      }
    }
    const apply = (target: MemberCsvRow) => {
      for (const [key, col] of FIELD_COLUMN) {
        const v = m[key];
        if (v !== undefined) target[col] = v;
      }
    };
    if ((cur.effective_from ?? "") === month) {
      apply(cur); // 同じ月の行はその場で更新
    } else {
      const next: MemberCsvRow = { ...cur, effective_from: month };
      // 在籍・不在の開始日（§119）は元の行の月の日なので引き継がない
      if (next.status_date !== undefined) next.status_date = "";
      apply(next);
      rows.push(next);
      history.push({ row: next, idx: rows.length - 1 });
    }
  }

  const keptNotInSource = [...byId.keys()].filter((id) => !importedIds.has(id)).length;
  return { rows, added, changed, unchanged, keptNotInSource, changes };
}

/** members.csv の文字列にする（ヘッダは既存のものを保つ。既存に無い標準列は足す） */
export function formatMembersCsv(rows: readonly MemberCsvRow[], headers: readonly string[]): string {
  const cols = [...headers];
  for (const c of MEMBER_CSV_COLUMNS) if (!cols.includes(c)) cols.push(c);
  return csvFormat(rows as MemberCsvRow[], cols) + "\n";
}
