/**
 * 契約ID → 作業ログ明細のファイル名（data/worklogs/<key>.json）
 *
 * 静的サーバは URL をデコードしてからファイルを探すため、encodeURIComponent した名前（%E5… や %2F）は 404 になる。
 * 英数字・_・- だけの ID はそのまま、それ以外（日本語・空白・記号）は "~" ＋ UTF-8 の 16 進にする。
 * observablehq.config.js（dynamicPaths）、ローダ（src/data/worklogs/[contractId].json.ts）、画面（breakdown.js）で共通に使う。
 */
const SAFE = /^[A-Za-z0-9_-]+$/;

export function worklogKey(contractId) {
  const id = String(contractId);
  if (SAFE.test(id)) return id;
  return "~" + [...new TextEncoder().encode(id)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function contractIdFromWorklogKey(key) {
  const k = String(key);
  if (!/^~(?:[0-9a-f]{2})+$/.test(k)) return k;
  const bytes = new Uint8Array(k.slice(1).match(/../g).map((h) => parseInt(h, 16)));
  return new TextDecoder().decode(bytes);
}
