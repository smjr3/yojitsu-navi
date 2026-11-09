/**
 * 正式な案件の一覧を data/projects.csv と data/contracts.csv に反映する（純粋関数。ファイルは触らない。SPEC §98）
 *
 * - projects.csv は取り込んだ一覧で置き換える（案件ID順。並べ替えは言語に依らない）
 * - contracts.csv は project_id のある行の customer_name・project_name だけを一覧の値にする。
 *   期間・金額・担当チーム・メモなどの手入力の列は触らない。行の追加・削除もしない
 * - project_id の無い行は保留のまま（推測で入れない）。ただし次の 2 つは指示されたときだけ行う（移行用）
 *   - idFromNote: メモ（note）に書いていた案件 ID を正規表現で取り出して project_id に移し、メモから消す
 *   - linkExact : 案件名（§4.1 の正規化）が同じ正式な案件がちょうど 1 件のときだけ project_id を入れる
 */
import { csvFormat, csvFormatRows, csvParseRows } from "d3-dsv";
import { normalizeName } from "../../src/core/normalize.js";
import { projectNameIndex } from "../../src/core/projects.js";
import type { Project } from "../../src/core/types.js";

export const PROJECT_CSV_COLUMNS = ["project_id", "customer_name", "project_name"] as const;

export type ContractCsvRow = Record<string, string>;

export interface ContractChange {
  contractId: string;
  kind: "renamed" | "linkedFromNote" | "linkedByName";
  /** renamed: 変わった列。linked*: 入れた案件ID */
  detail: string[];
}

export interface SyncOptions {
  idFromNote?: RegExp;
  linkExact?: boolean;
}

export interface SyncResult {
  rows: ContractCsvRow[];
  headers: string[];
  changes: ContractChange[];
  /** linkExact で、同じ案件名の案件が複数あって入れなかった契約（契約ID → 候補） */
  ambiguous: Array<{ contractId: string; candidates: string[] }>;
}

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** projects.csv の中身（案件ID順） */
export function formatProjectsCsv(projects: readonly Project[]): string {
  const rows = [...projects].sort((a, b) => byCode(a.projectId, b.projectId)).map((p) => ({ project_id: p.projectId, customer_name: p.customerName, project_name: p.projectName }));
  return csvFormat(rows, [...PROJECT_CSV_COLUMNS]) + "\n";
}

/** contracts.csv の中身。project_id の列が無ければ contract_id の次に足す */
export function formatContractsCsv(rows: readonly ContractCsvRow[], headers: readonly string[]): string {
  return csvFormat(rows as ContractCsvRow[], [...headers]) + "\n";
}

/** CSV の文字列をレコード（行）の生の文字列に分ける（引用符の中の改行は分けない）。末尾の空行は含めない */
export function splitCsvRecords(text: string): { records: string[]; eol: string } {
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const records: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === "\n" && !quoted) {
      records.push(text.slice(start, i > start && text[i - 1] === "\r" ? i - 1 : i));
      start = i + 1;
    }
  }
  if (start < text.length) records.push(text.slice(start));
  return { records, eol };
}

/**
 * contracts.csv の中身を、変わった行だけ書き換えて作る（§101.4）。ほかの行は元の文字列のまま（引用符・改行コードも）。
 * 見出しが変わった・行の数が合わないときは全体を書き直す
 */
export function formatContractsCsvKeeping(originalText: string, before: readonly ContractCsvRow[], after: readonly ContractCsvRow[], headers: readonly string[], afterHeaders: readonly string[]): string {
  const full = () => formatContractsCsv(after, afterHeaders);
  if (headers.length !== afterHeaders.length || before.length !== after.length) return full();
  const text = originalText.replace(/^\uFEFF/, "");
  const { records, eol } = splitCsvRecords(text);
  const [head, ...body] = records;
  if (head === undefined) return full();
  const isData = (rec: string) => (csvParseRows(rec)[0] ?? []).some((v) => v.trim() !== "");
  const dataIdx = body.map((r, i) => (isData(r) ? i : -1)).filter((i) => i >= 0);
  if (dataIdx.length !== after.length) return full();
  const out = [...body];
  dataIdx.forEach((bodyIndex, k) => {
    const a = after[k] as ContractCsvRow;
    const b = before[k] as ContractCsvRow;
    if (headers.every((h) => (a[h] ?? "") === (b[h] ?? ""))) return;
    out[bodyIndex] = csvFormatRows([headers.map((h) => a[h] ?? "")]);
  });
  // 見出しの前後の空白は除いた名前にそろえる（データの読み込みと同じ）
  const rawHead = csvParseRows(head)[0] ?? [];
  const outHead = rawHead.some((h) => h !== h.trim()) ? csvFormatRows([[...afterHeaders]]) : head;
  return [outHead, ...out].join(eol) + eol;
}

/** projects.csv の前後の違いの件数（追加・削除・名前の変更。§101.4） */
export function diffProjects(beforeText: string, after: readonly Project[]): { added: number; removed: number; renamed: number } {
  const rows = csvParseRows(beforeText.replace(/^\uFEFF/, ""));
  const head = (rows[0] ?? []).map((h) => h.trim());
  const at = (name: string) => head.indexOf(name);
  const prev = new Map<string, string>();
  for (const r of rows.slice(1)) {
    const id = (r[at("project_id")] ?? "").trim();
    if (id !== "") prev.set(id, `${r[at("customer_name")] ?? ""}\u0000${r[at("project_name")] ?? ""}`);
  }
  let added = 0;
  let renamed = 0;
  const seen = new Set<string>();
  for (const p of after) {
    seen.add(p.projectId);
    const old = prev.get(p.projectId);
    if (old === undefined) added++;
    else if (old !== `${p.customerName}\u0000${p.projectName}`) renamed++;
  }
  let removed = 0;
  for (const id of prev.keys()) if (!seen.has(id)) removed++;
  return { added, removed, renamed };
}

export function withProjectIdColumn(headers: readonly string[]): string[] {
  if (headers.includes("project_id")) return [...headers];
  const out = [...headers];
  const at = out.indexOf("contract_id");
  out.splice(at < 0 ? 0 : at + 1, 0, "project_id");
  return out;
}

export function syncContracts(input: readonly ContractCsvRow[], headers: readonly string[], projects: readonly Project[], opts: SyncOptions = {}): SyncResult {
  const official = new Map(projects.map((p) => [p.projectId, p]));
  const names = projectNameIndex(projects);
  const changes: ContractChange[] = [];
  const ambiguous: SyncResult["ambiguous"] = [];
  const rows = input.map((r) => ({ ...r }));
  let needColumn = false;
  for (const r of rows) {
    const contractId = r.contract_id ?? "";
    let pid = (r.project_id ?? "").trim();
    if (pid === "" && opts.idFromNote) {
      const note = r.note ?? "";
      const m = opts.idFromNote.exec(note);
      opts.idFromNote.lastIndex = 0;
      const id = (m?.[1] ?? m?.[0] ?? "").trim();
      if (m && id !== "") {
        pid = id;
        r.project_id = id;
        r.note = (note.slice(0, m.index) + note.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
        needColumn = true;
        changes.push({ contractId, kind: "linkedFromNote", detail: [id] });
      }
    }
    if (pid === "" && opts.linkExact) {
      const candidates = [...(names.get(normalizeName(r.project_name ?? "")) ?? [])].sort(byCode);
      if (candidates.length === 1 && candidates[0] !== undefined) {
        pid = candidates[0];
        r.project_id = pid;
        needColumn = true;
        changes.push({ contractId, kind: "linkedByName", detail: [pid] });
      } else if (candidates.length > 1) {
        ambiguous.push({ contractId, candidates });
      }
    }
    if (pid === "") continue;
    const p = official.get(pid);
    if (!p) continue;
    const fields: string[] = [];
    if ((r.customer_name ?? "") !== p.customerName) {
      r.customer_name = p.customerName;
      fields.push("customer_name");
    }
    if ((r.project_name ?? "") !== p.projectName) {
      r.project_name = p.projectName;
      fields.push("project_name");
    }
    if (fields.length > 0) changes.push({ contractId, kind: "renamed", detail: fields });
  }
  const outHeaders = needColumn ? withProjectIdColumn(headers) : [...headers];
  return { rows, headers: outHeaders, changes, ambiguous };
}
