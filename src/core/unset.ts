/**
 * 未設定・仮の値の一覧（SPEC §103）: マスタ編集で埋める項目をまとめる。
 *
 * - 案件の担当チームが空（顧客の既定も無い）
 * - 案件の金額が 0・未入力
 * - 単価の無い役職（メンバーが使っている役職に rates.csv の行が無い）
 * - 仮の単価（rates.csv の provisional 列）
 *
 * データは直さない。画面はこの一覧からマスタ編集の該当箇所へ移るだけ（最後に決めるのは人）。
 */
import type { Dataset } from "./types.js";

export type UnsetKind = "contractTeam" | "contractAmount" | "rateMissing" | "rateProvisional";

export interface UnsetItem {
  kind: UnsetKind;
  /** 案件は契約ID、単価は役職（または社員番号） */
  key: string;
  /** 案件: 顧客名 */
  customerName?: string;
  /** 案件: 案件名 */
  projectName?: string;
  /** 単価の無い役職: その役職のメンバーの人数 */
  count?: number;
}

/** 表示の順（種類） */
export const UNSET_KINDS: readonly UnsetKind[] = ["contractTeam", "contractAmount", "rateMissing", "rateProvisional"];

export function findUnsetItems(dataset: Pick<Dataset, "contracts" | "members" | "rates">): UnsetItem[] {
  const out: UnsetItem[] = [];
  for (const c of dataset.contracts) {
    if (c.contractId === "") continue;
    const base = { key: c.contractId, customerName: c.customerName, projectName: c.projectName };
    if (c.teamId === null || c.teamId === "") out.push({ kind: "contractTeam", ...base });
    if (!Number.isFinite(c.totalAmount) || c.totalAmount === 0) out.push({ kind: "contractAmount", ...base });
  }
  // 役職に単価が無い（個人単価も無い）メンバー。役職の無い人はメンバーの側で直すので入れない
  const keys = new Set(dataset.rates.map((r) => r.key));
  const byTitle = new Map<string, Set<string>>();
  for (const m of dataset.members) {
    const title = m.title ?? "";
    if (m.memberId === "" || title === "" || keys.has(m.memberId) || keys.has(title)) continue;
    const ids = byTitle.get(title) ?? new Set<string>();
    ids.add(m.memberId);
    byTitle.set(title, ids);
  }
  for (const [title, ids] of byTitle) out.push({ kind: "rateMissing", key: title, count: ids.size });
  const provisional = new Set<string>();
  for (const r of dataset.rates) if (r.provisional && r.key !== "" && !provisional.has(r.key)) provisional.add(r.key);
  for (const key of provisional) out.push({ kind: "rateProvisional", key });
  return out;
}

/**
 * 新しい契約ID の候補: 今の ID で最も多い「接頭辞＋数字」の形の、いちばん大きい数字の次（桁数はそろえる）。
 * 形が無ければ C001。すでにある ID とは重ならない
 */
export function nextContractId(ids: readonly string[]): string {
  const used = new Set(ids);
  const byPrefix = new Map<string, { n: number; max: number; width: number }>();
  for (const id of ids) {
    const m = /^(.*?)(\d+)$/.exec(id);
    if (!m) continue;
    const prefix = m[1] as string;
    const digits = m[2] as string;
    const p = byPrefix.get(prefix) ?? { n: 0, max: -1, width: digits.length };
    p.n++;
    p.max = Math.max(p.max, Number(digits));
    p.width = Math.max(p.width, digits.length);
    byPrefix.set(prefix, p);
  }
  let best: [string, { n: number; max: number; width: number }] | null = null;
  for (const e of byPrefix) if (!best || e[1].n > best[1].n) best = e;
  const [prefix, p] = best ?? ["C", { n: 0, max: 0, width: 3 }];
  for (let n = p.max + 1; ; n++) {
    const id = `${prefix}${String(n).padStart(p.width, "0")}`;
    if (!used.has(id)) return id;
  }
}
