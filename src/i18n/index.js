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
