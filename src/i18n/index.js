/**
 * 画面文言の読み出し口。文言そのものは ja.js（計算ルールの本文は rules.txt）に置く。
 *
 *   import { T, fmt } from "../i18n/index.js";
 *   T.common.loading                        → "読み込み中…"
 *   fmt(T.layout.fetchedAt, { at: "…" })    → "{at}" を値に置き換えた文字列
 */
import ja from "./ja.js";

export const T = ja;

/**
 * 文言の {名前} を params の値に置き換える。params に無い {名前} はそのまま残す（書き間違いに気付けるように）。
 * @param {string} template
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
export function fmt(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) => (Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole));
}

/**
 * <strong> などの HTML タグを含む文言を画面用の要素にする（文言ファイルの中だけで使う。差し込む値はエスケープする）。
 * @param {string} template
 * @param {Record<string, unknown>} [params]
 * @returns {DocumentFragment}
 */
export function rich(template, params = {}) {
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const escaped = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, esc(v)]));
  const t = document.createElement("template");
  t.innerHTML = fmt(template, escaped);
  return t.content;
}
