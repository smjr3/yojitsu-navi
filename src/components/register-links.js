/**
 * データ確認からマスタ編集の「＋ 新しい案件」へ移るリンク（SPEC §103）
 *
 * 分かっている値だけをダイアログに入れる。保存は人が決める（自動では登録しない）。
 * - 正式な案件（§98）が案件名でちょうど 1 件に決まれば、その正式な案件ID・顧客名・案件名
 * - 作業名から抜き出した案件（§97）は、作業実績の最初の日の月を開始月に入れる（直せる）
 */
import { normalizeName } from "../core/index.js";

/** マスタ編集へのリンク（空の値は付けない） */
export function mastersHref(view, params = {}) {
  const q = new URLSearchParams({ view });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  return `./masters?${q}`;
}

/** 案件名が同じ正式な案件がちょうど 1 件なら、その案件（2 件以上・無しは null） */
export function officialProjectLookup(officialProjects) {
  const map = new Map();
  for (const p of officialProjects ?? []) {
    const k = normalizeName(p.projectName ?? "");
    if (k === "") continue;
    map.set(k, map.has(k) ? null : p);
  }
  return (name) => map.get(normalizeName(name ?? "")) ?? null;
}

const monthOf = (date) => (/^\d{4}-\d{2}/.test(date ?? "") ? date.slice(0, 7) : "");

/** 「案件に登録」のリンク。row は正式な案件（projectId あり）か、未紐付けの行（firstDate あり） */
export function registerContractHref(row, lookup = () => null) {
  const official = row.projectId ? row : lookup(row.projectName);
  return mastersHref("contracts", {
    new: "1",
    customer_name: official?.customerName ?? row.customerName,
    project_name: official?.projectName ?? row.projectName,
    project_id: official?.projectId,
    start_month: monthOf(row.firstDate),
  });
}

/** 正式な案件ID → それを候補に持つ、正式な案件IDの無い案件（§98 の未照合）。表には「顧客名（案件ID）」で出す */
export function unlinkedByCandidate(unlinked) {
  const out = new Map();
  for (const c of unlinked ?? []) for (const id of c.candidates ?? []) out.set(id, [...(out.get(id) ?? []), c]);
  return out;
}

/** 「顧客名（案件ID）」を「、」でつなぐ */
export function contractListText(contracts) {
  return (contracts ?? []).map((c) => (c.customerName ? `${c.customerName}（${c.contractId}）` : c.contractId)).join("、");
}
