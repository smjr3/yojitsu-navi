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
import { csvFormat } from "d3-dsv";
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
