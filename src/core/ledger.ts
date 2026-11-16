/**
 * 台帳の見せ方（SPEC §36）の純粋ロジック — マスタ編集・リソース計画から使う
 *
 * データは従来どおり「適用開始月付きの行」（メンバー・単価・組織）と「期間付きの行」（アサイン・契約外予定）で持つ。
 * 画面では「対象（人・役職・組織・人×案件）ごとに 1 行」を正とし、その中に変更の履歴（いつから何が変わったか）を並べる。
 *
 *  - ledgerGroups:  適用開始月付きの行 → 対象ごとのまとまり（今の値・変更の履歴・前の行との差分）
 *  - periodHistory: 期間付きの行 → 開始・変更・終了の並び（前の期間との差分）
 *  - replaceRange:  期間 [from, to] の値を置き換える（行を分け・まとめ、元の行はできるだけ残す）
 *
 * DOM にも fetch にも依存しない。
 */
import { addMonths, isValidYearMonth, type HolidayLookup } from "./calendar.js";
import { periodBounds, periodShareAt } from "./periodDates.js";
import { parseNumberCell } from "./csv.js";
import type { YearMonth } from "./types.js";

const EPS = 1e-9;

// ---------------------------------------------------------------------------
// 適用開始月付きの行（§5）→ 対象ごとのまとまり
// ---------------------------------------------------------------------------

export interface LedgerRowInput {
  id: string;
  /** 列名 → 値（trim 前でよい） */
  record: Readonly<Record<string, string>>;
}

export interface LedgerEntry {
  rowId: string;
  /** 適用開始月（不正なら元の文字列のまま） */
  from: string;
  record: Record<string, string>;
  /** 1 つ前の履歴から値が変わった列（effective_from を除く）。最初の履歴は [] */
  changes: string[];
  /** 1 つ前の履歴の値（最初の履歴は null） */
  previous: Record<string, string> | null;
  /** 基準月より後に始まる（予定） */
  future: boolean;
  /** 基準月に有効な履歴 */
  current: boolean;
}

export interface LedgerGroup {
  /** キー列の値（空なら行ごとに別のまとまり: "\u0000row:<id>"） */
  key: string;
  /** 適用開始月の順（同じ月はファイルの順） */
  entries: LedgerEntry[];
  /** 画面の 1 行に出す履歴: 基準月に有効なもの。無ければ（全部が予定なら）最初の履歴 */
  shown: LedgerEntry;
  /** 基準月より後の変更（予定） */
  upcoming: LedgerEntry[];
}

function trimRecord(r: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, (v ?? "").trim()]));
}

/**
 * 行を対象（keyColumn の値）ごとにまとめ、適用開始月の順に並べる。
 * まとまりの順 = ファイルに最初に出てきた順。「月 m に有効な行」は §5 と同じ（effective_from <= m の最大、同じなら後の行）
 */
export function ledgerGroups(rows: readonly LedgerRowInput[], keyColumn: string, asOfMonth: YearMonth): LedgerGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, Array<{ index: number; row: LedgerRowInput }>>();
  rows.forEach((row, index) => {
    const k = (row.record[keyColumn] ?? "").trim();
    const key = k === "" ? `\u0000row:${row.id}` : k;
    const list = byKey.get(key);
    if (list) list.push({ index, row });
    else {
      byKey.set(key, [{ index, row }]);
      order.push(key);
    }
  });
  return order.map((key) => {
    const list = (byKey.get(key) ?? []).slice();
    // 不正な適用開始月は先頭に（並べ替えの都合。検証でエラーになる）
    const fromOf = (r: LedgerRowInput) => {
      const f = (r.record.effective_from ?? "").trim();
      return isValidYearMonth(f) ? f : "";
    };
    list.sort((a, b) => {
      const fa = fromOf(a.row);
      const fb = fromOf(b.row);
      return fa < fb ? -1 : fa > fb ? 1 : a.index - b.index;
    });
    let previous: Record<string, string> | null = null;
    let currentIdx = -1;
    const entries: LedgerEntry[] = list.map(({ row }, i) => {
      const record = trimRecord(row.record);
      const from = (row.record.effective_from ?? "").trim();
      const changes = previous === null ? [] : Object.keys(record).filter((c) => c !== "effective_from" && record[c] !== (previous as Record<string, string>)[c]);
      const valid = isValidYearMonth(from);
      if (valid && from <= asOfMonth) currentIdx = i;
      const e: LedgerEntry = { rowId: row.id, from, record, changes, previous, future: valid && from > asOfMonth, current: false };
      previous = record;
      return e;
    });
    if (currentIdx >= 0) (entries[currentIdx] as LedgerEntry).current = true;
    const shown = (currentIdx >= 0 ? entries[currentIdx] : entries[0]) as LedgerEntry;
    return { key, entries, shown, upcoming: entries.filter((e) => e.future) };
  });
}

/**
 * 列 column の、基準月より後の最初の変更（「7月〜 主任」のような予告）。無ければ null
 */
export function nextChangeOf(group: LedgerGroup, column: string): { from: string; value: string; record: Readonly<Record<string, string>> } | null {
  const shownAt = group.entries.indexOf(group.shown);
  let value = group.shown.record[column] ?? "";
  for (const e of group.entries.slice(shownAt + 1)) {
    if (!e.future) continue;
    const v = e.record[column] ?? "";
    if (v !== value) return { from: e.from, value: v, record: e.record };
    value = v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 期間付きの行（アサイン・契約外予定）→ 変更の並び
// ---------------------------------------------------------------------------

export interface PeriodRowInput {
  rowId: string;
  /** 契約外予定は "" */
  contractId: string;
  startMonth: string;
  endMonth: string;
  /** 開始日・終了日（§123。CSV の値） */
  startDate?: string;
  endDate?: string;
  /** 数値でなければ NaN */
  value: number;
}

export type PeriodEntryKind =
  /** 最初の期間 */
  | "start"
  /** 間が空いたあとに再開 */
  | "restart"
  /** 前の期間から値が変わった */
  | "change"
  /** 値は同じで契約だけが切り替わった（案件の契約更新） */
  | "contract"
  /** 値も契約も同じで続いている（1 行にまとめられる） */
  | "same"
  /** 前の期間と月が重なっている */
  | "overlap"
  /** 月が不正（検証でエラー） */
  | "invalid";

export interface PeriodEntry extends PeriodRowInput {
  kind: PeriodEntryKind;
  /** 直前（前月に終わる）の期間の値。無ければ null */
  previousValue: number | null;
  /** この期間のあと、次の期間まで空く（または最後の期間）なら、終わった翌月 */
  endsBefore: YearMonth | null;
}

function sameNumber(a: number, b: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) < EPS : Number.isNaN(a) && Number.isNaN(b);
}

/** 期間の行を開始月の順に並べ、前の期間との関係（開始・変更・再開・終了）を付ける */
export function periodHistory(rows: readonly PeriodRowInput[]): PeriodEntry[] {
  const valid = rows.filter((r) => isValidYearMonth(r.startMonth) && isValidYearMonth(r.endMonth) && r.startMonth <= r.endMonth);
  const invalid = rows.filter((r) => !valid.includes(r));
  // 実際の開始日・終了日の順（同じ月に始まる行も CSV の順に依らない。§123）
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  const sorted = valid.slice().sort((a, b) => cmp(periodBounds(a).from, periodBounds(b).from) || cmp(periodBounds(a).to, periodBounds(b).to) || cmp(a.contractId, b.contractId));
  const out: PeriodEntry[] = [];
  let maxEnd: string | null = null;
  let prev: PeriodRowInput | null = null;
  for (const r of sorted) {
    let kind: PeriodEntryKind;
    let previousValue: number | null = null;
    // 重なりは日付で比べる（同じ月でも、前の行の終了日より後の開始日なら重ならない。§123）
    if (maxEnd !== null && periodBounds(r).from <= maxEnd) kind = "overlap";
    else if (prev === null) kind = "start";
    else if (addMonths(prev.endMonth, 1) !== r.startMonth || (prev.endDate ?? "").trim() !== "" || (r.startDate ?? "").trim() !== "") kind = "restart";
    else {
      previousValue = prev.value;
      kind = !sameNumber(prev.value, r.value) ? "change" : prev.contractId !== r.contractId ? "contract" : "same";
    }
    out.push({ ...r, kind, previousValue, endsBefore: null });
    const to = periodBounds(r).to;
    if (maxEnd === null || to > maxEnd) maxEnd = to;
    prev = r;
  }
  // 翌月にどの期間も掛からない（次の期間まで空く・最後の期間）なら「〜で終了」を付ける
  for (const e of out) {
    const next = addMonths(e.endMonth, 1);
    if (!out.some((x) => x.startMonth <= next && next <= x.endMonth)) e.endsBefore = next;
  }
  return [...out, ...invalid.map((r) => ({ ...r, kind: "invalid" as const, previousValue: null, endsBefore: null }))];
}

// ---------------------------------------------------------------------------
// 期間 [from, to] の値を置き換える
// ---------------------------------------------------------------------------

export interface RangeRow {
  id: string;
  contractId: string;
  startMonth: string;
  endMonth: string;
  /** 開始日・終了日（§123。CSV の値。空・省略 = 月の初めから・終わりまで） */
  startDate?: string;
  endDate?: string;
  /** CSV に書く文字列 */
  value: string;
}

export interface RangeSegment {
  contractId: string;
  startMonth: YearMonth;
  endMonth: YearMonth;
}

export interface RangeEdit {
  /** 書き換える行（id → 新しい期間・値・契約） */
  updates: Map<string, { contractId: string; startMonth: YearMonth; endMonth: YearMonth; startDate: string; endDate: string; value: string }>;
  /** 消す行 */
  deletes: string[];
  /** 足す行 */
  adds: Array<{ contractId: string; startMonth: YearMonth; endMonth: YearMonth; startDate: string; endDate: string; value: string }>;
}

export type RangeEditResult = { ok: true; edit: RangeEdit } | { ok: false; reason: "overlap" | "invalid-range" };

function isZeroText(text: string): boolean {
  const t = text.trim();
  if (t === "") return true;
  const n = parseNumberCell(t);
  return Number.isFinite(n) && Math.abs(n) < EPS;
}

function sameText(a: string, b: string): boolean {
  const x = parseNumberCell(a.trim());
  const y = parseNumberCell(b.trim());
  return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) < EPS : a.trim() === b.trim();
}

/**
 * 1 つの対象（人 × 案件、または人の契約外予定）の行 rows について、期間 [from, to] の値を value にする。
 * value が 0 か空なら、その期間を計画から外す。
 * - 期間に掛かる行は、期間の外の部分だけを残す（前後に分かれれば 2 行に）
 * - 新しい期間は segments(from, to) で契約に割り当てる（契約外予定は 1 つの区間）
 * - 新しい期間と、前後で接する同じ契約・同じ値の行はまとめる（元の値に戻せば元の 1 行に戻る）
 * - 期間の中で消える行は、同じ契約の新しい期間に使い回す（差分が「変更」になり読みやすい）
 * 月が不正な行は触らない。期間の中で行どうしが重なっていれば ok: false（行ごとに直してもらう）
 */
export function replaceRange(
  rows: readonly RangeRow[],
  from: string,
  to: string,
  value: string,
  segments: (from: YearMonth, to: YearMonth) => RangeSegment[],
  dates?: { startDate?: string; endDate?: string },
): RangeEditResult {
  if (!isValidYearMonth(from) || !isValidYearMonth(to) || from > to) return { ok: false, reason: "invalid-range" };
  const valid = rows.filter((r) => isValidYearMonth(r.startMonth) && isValidYearMonth(r.endMonth) && r.startMonth <= r.endMonth);
  const inRange = valid.filter((r) => r.startMonth <= to && r.endMonth >= from);
  // 期間の中の重なり（同じ月に 2 行）は、どれを置き換えるか決められない
  // 実際の開始日の順（同じ月に始まる行も CSV の順に依らない。§123）
  const sorted = inRange.slice().sort((a, b) => {
    const x = periodBounds(a).from;
    const y = periodBounds(b).from;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1] as RangeRow;
    const b = sorted[i] as RangeRow;
    const overlapFrom = b.startMonth > from ? b.startMonth : from;
    const overlapTo = a.endMonth < to ? a.endMonth : to;
    // 同じ月でも日付が重ならなければ（13 日まで・16 日から。§123）重なりではない
    if (b.startMonth <= a.endMonth && overlapFrom <= overlapTo && periodBounds(b).from <= periodBounds(a).to) return { ok: false, reason: "overlap" };
  }

  interface Piece {
    id: string | null;
    contractId: string;
    startMonth: YearMonth;
    endMonth: YearMonth;
    startDate: string;
    endDate: string;
    value: string;
  }
  const sd = (r: RangeRow) => (r.startDate ?? "").trim();
  const ed = (r: RangeRow) => (r.endDate ?? "").trim();
  const pieces: Piece[] = [];
  const freed: RangeRow[] = [];
  for (const r of valid) {
    if (r.endMonth < from || r.startMonth > to) {
      pieces.push({ id: r.id, contractId: r.contractId, startMonth: r.startMonth, endMonth: r.endMonth, startDate: sd(r), endDate: ed(r), value: r.value });
      continue;
    }
    let used = false;
    if (r.startMonth < from) {
      pieces.push({ id: r.id, contractId: r.contractId, startMonth: r.startMonth, endMonth: addMonths(from, -1), startDate: sd(r), endDate: "", value: r.value });
      used = true;
    }
    if (r.endMonth > to) {
      pieces.push({ id: used ? null : r.id, contractId: r.contractId, startMonth: addMonths(to, 1), endMonth: r.endMonth, startDate: "", endDate: ed(r), value: r.value });
      used = true;
    }
    if (!used) freed.push(r);
  }

  const dropped = new Set<string>();
  if (!isZeroText(value)) {
    for (const sg of segments(from, to)) {
      // 期間の端が元の行の端と同じ月なら、その開始日・終了日を引き継ぐ（§123。月の値だけ変えたとき日付が消えないように）
      // ほかの行がその月のもっと前（後）を受け持っていれば引き継がない（別々の期間の内側の端どうしを 1 行にまとめない）
      const sameMonthRows = (m: YearMonth) => inRange.filter((r) => r.contractId === sg.contractId && r.startMonth <= m && m <= r.endMonth);
      const startDate = inRange.find((r) => r.contractId === sg.contractId && r.startMonth === sg.startMonth && sd(r) !== "" && !sameMonthRows(sg.startMonth).some((o) => o !== r && periodBounds(o).from < sd(r)));
      const endDate = inRange.find((r) => r.contractId === sg.contractId && r.endMonth === sg.endMonth && ed(r) !== "" && !sameMonthRows(sg.endMonth).some((o) => o !== r && periodBounds(o).to > ed(r)));
      // 開始日・終了日を指定したとき（§123）は、期間の最初・最後の月にそれを付ける
      const givenStart = dates && sg.startMonth === from ? (dates.startDate ?? "").trim() : null;
      const givenEnd = dates && sg.endMonth === to ? (dates.endDate ?? "").trim() : null;
      const n: Piece = { id: null, contractId: sg.contractId, startMonth: sg.startMonth, endMonth: sg.endMonth, startDate: givenStart ?? (startDate ? sd(startDate) : ""), endDate: givenEnd ?? (endDate ? ed(endDate) : ""), value: value.trim() };
      // 月の途中で終わる・始まる所ではまとめない（まとめると日割りの月が丸 1 か月になる）
      const left = n.startDate === "" ? pieces.find((p) => p.contractId === n.contractId && addMonths(p.endMonth, 1) === n.startMonth && p.endDate === "" && sameText(p.value, n.value)) : undefined;
      const right = n.endDate === "" ? pieces.find((p) => p.contractId === n.contractId && addMonths(n.endMonth, 1) === p.startMonth && p.startDate === "" && sameText(p.value, n.value)) : undefined;
      if (left && right) {
        left.endMonth = right.endMonth;
        left.endDate = right.endDate;
        pieces.splice(pieces.indexOf(right), 1);
        if (right.id !== null) dropped.add(right.id);
      } else if (left) {
        left.endMonth = n.endMonth;
        left.endDate = n.endDate;
      } else if (right) {
        right.startMonth = n.startMonth;
        right.startDate = n.startDate;
        // 右の残り（元の行の後半）の行 id が無ければ、期間の中で消える行を使い回す
        if (right.id === null) {
          const reuse = freed.find((f) => f.contractId === n.contractId);
          if (reuse) {
            right.id = reuse.id;
            freed.splice(freed.indexOf(reuse), 1);
          }
        }
      } else {
        const reuse = freed.find((f) => f.contractId === n.contractId) ?? null;
        if (reuse) {
          n.id = reuse.id;
          freed.splice(freed.indexOf(reuse), 1);
        }
        pieces.push(n);
      }
    }
  }

  const byId = new Map(valid.map((r) => [r.id, r]));
  const edit: RangeEdit = { updates: new Map(), deletes: [], adds: [] };
  for (const p of pieces) {
    if (p.id === null) {
      edit.adds.push({ contractId: p.contractId, startMonth: p.startMonth, endMonth: p.endMonth, startDate: p.startDate, endDate: p.endDate, value: p.value });
      continue;
    }
    const o = byId.get(p.id) as RangeRow;
    if (o.startMonth !== p.startMonth || o.endMonth !== p.endMonth || sd(o) !== p.startDate || ed(o) !== p.endDate || o.contractId !== p.contractId || o.value.trim() !== p.value.trim()) {
      edit.updates.set(p.id, { contractId: p.contractId, startMonth: p.startMonth, endMonth: p.endMonth, startDate: p.startDate, endDate: p.endDate, value: p.value });
    }
  }
  edit.adds.sort((a, b) => (a.startMonth < b.startMonth ? -1 : a.startMonth > b.startMonth ? 1 : 0));
  for (const f of freed) edit.deletes.push(f.id);
  for (const id of dropped) edit.deletes.push(id);
  return { ok: true, edit };
}

/**
 * 月 m の値（期間付きの行の合計。数値でない行は数えない）。
 * holidays を渡すと、開始日・終了日のある端の月は営業日で日割りした値（§123）。省略時は入れた値のまま
 */
export function valueAt(rows: readonly (Pick<PeriodRowInput, "startMonth" | "endMonth" | "value"> & { startDate?: string; endDate?: string })[], month: YearMonth, holidays?: HolidayLookup): number {
  let s = 0;
  for (const r of rows) if (r.startMonth <= month && month <= r.endMonth && Number.isFinite(r.value)) s += holidays ? r.value * periodShareAt(r, month, holidays) : r.value;
  return s;
}
