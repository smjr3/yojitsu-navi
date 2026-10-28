/**
 * 顧客の束ね方（SPEC §17）。画面の「顧客別」が使う純粋関数。
 *
 *   customerKey   = normalizeName(顧客名)（§4.1）。空になる契約は「顧客名なし」（NONE_CUSTOMER_KEY）
 *   表示名         = そのキーの契約のうち、契約ID昇順で最初の契約の顧客名
 *   groupByCustomer = 全契約をちょうど 1 つの顧客に振り分ける（順序・重複に依らず決定的）
 */
import { normalizeName } from "./normalize.js";
import { T } from "../i18n/index.js";
import type { Contract } from "./types.js";

/** 「顧客名なし」グループのキー */
export const NONE_CUSTOMER_KEY = "__none__";
export const NONE_CUSTOMER_LABEL = T.numbers.noCustomerName;

export interface CustomerGroup {
  /** URL に載せるキー（呼び出し側で encodeURIComponent する） */
  key: string;
  /** 表示名（顧客名なしは NONE_CUSTOMER_LABEL） */
  label: string;
  /** 契約ID昇順 */
  contractIds: string[];
}

/**
 * 顧客キー。normalizeName の結果をそのまま使うが、予約キーとの衝突だけは避ける:
 * 正規化結果が "__" で始まるときは "_" を 1 つ足す（"__none__" という顧客名が「顧客名なし」と混ざらない。
 * 足したキーは必ず "___" で始まるので、予約キーとも他の顧客のキーとも衝突しない = 単射）。
 */
export function customerKey(customerName: string | null | undefined): string {
  const normalized = normalizeName(customerName);
  if (normalized === "") return NONE_CUSTOMER_KEY;
  return normalized.startsWith("__") ? `_${normalized}` : normalized;
}

type ContractLike = Pick<Contract, "contractId" | "customerName">;

/** 契約IDの昇順（ロケールに依らないコード単位比較） */
const byContractId = (a: ContractLike, b: ContractLike): number => (a.contractId < b.contractId ? -1 : a.contractId > b.contractId ? 1 : 0);

/**
 * 契約を顧客ごとに束ねる。
 * - 全契約がちょうど 1 つのグループに属する（契約ID が重複する入力は先頭の 1 件だけを数える）
 * - 入力の並びに依らない: グループはキー順（コード単位）、「顧客名なし」は末尾
 */
export function groupByCustomer(contracts: readonly ContractLike[]): CustomerGroup[] {
  const seen = new Set<string>();
  const unique: ContractLike[] = [];
  for (const c of contracts) {
    if (seen.has(c.contractId)) continue;
    seen.add(c.contractId);
    unique.push(c);
  }
  unique.sort(byContractId);
  const groups = new Map<string, CustomerGroup>();
  for (const c of unique) {
    const key = customerKey(c.customerName);
    let g = groups.get(key);
    if (!g) {
      // unique は契約ID昇順なので、最初に見た契約が表示名の元になる
      g = { key, label: key === NONE_CUSTOMER_KEY ? NONE_CUSTOMER_LABEL : c.customerName, contractIds: [] };
      groups.set(key, g);
    }
    g.contractIds.push(c.contractId);
  }
  const rank = (k: string): number => (k === NONE_CUSTOMER_KEY ? 1 : 0);
  return [...groups.values()].sort((a, b) => rank(a.key) - rank(b.key) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
