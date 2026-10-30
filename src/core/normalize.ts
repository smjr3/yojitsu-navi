/**
 * 名称の正規化（SPEC §4.1）
 *
 * 顧客名・案件名を照合用のキーに変換する。
 * 1. Unicode NFKC
 * 2. 前後の空白除去、連続空白（全角含む）を半角空白1つに
 * 3. 小文字化
 * 4. 法人格を前後から除去（中間は残す）
 * 5. 空になったら空文字
 */

/** 前後から除去する法人格表記（NFKC・小文字化後の表記で照合する） */
const CORPORATE_SUFFIXES: readonly string[] = [
  // 長いものを先に（"co., ltd." が "ltd." より優先される）
  "co., ltd.",
  "co.,ltd.",
  "株式会社",
  "有限会社",
  "合同会社",
  "corp.",
  "inc.",
  "ltd.",
  "(株)",
  "(有)",
  "llc",
];

/** 法人格の除去を最長一致で試みる。除去が起きれば true */
function stripOnce(value: string, atStart: boolean): string | null {
  for (const suffix of CORPORATE_SUFFIXES) {
    if (atStart && value.startsWith(suffix) && hasBoundary(value, suffix, suffix.length)) {
      return value.slice(suffix.length).trim();
    }
    if (!atStart && value.endsWith(suffix) && hasBoundary(value, suffix, value.length - suffix.length - 1)) {
      return value.slice(0, value.length - suffix.length).trim();
    }
  }
  return null;
}

/**
 * 英字の法人格（inc. / llc など）は単語境界が必要（"allc" から "llc" を削らない）。
 * 日本語の法人格は境界不要（"株式会社abc" → "abc"）。
 */
function hasBoundary(value: string, suffix: string, neighborIndex: number): boolean {
  if (!/^[a-z]/.test(suffix)) return true;
  const neighbor = value[neighborIndex];
  return neighbor === undefined || neighbor === " ";
}

/** 名称を照合用に正規化する。冪等（2回かけても同じ結果）。 */
export function normalizeName(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  // 1. NFKC（全角英数→半角、半角カナ→全角カナ、㈱→(株)、㈲→(有)、全角空白→半角空白）
  let value = String(raw).normalize("NFKC");
  // 2. 空白の整理（NFKC で全角空白は半角になるが、念のため全角空白も対象）
  value = value.replace(/[\s　]+/g, " ").trim();
  // 3. 小文字化
  value = value.toLowerCase();
  // 4. 法人格を前後から繰り返し除去
  let changed = true;
  while (changed && value.length > 0) {
    changed = false;
    const head = stripOnce(value, true);
    if (head !== null) {
      value = head;
      changed = true;
    }
    const tail = stripOnce(value, false);
    if (tail !== null) {
      value = tail;
      changed = true;
    }
  }
  // 5. 空になったら空文字
  return value.trim();
}

/**
 * 作業名とキーワードの部分一致用の正規化（§62）。NFKC・小文字化・空白はすべて取り除く。
 * 法人格は除かない（作業名の一部なので）。
 */
export function normalizeKeyword(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  return String(raw).normalize("NFKC").toLowerCase().replace(/[\s　]+/g, "");
}

/** キーワードのセル（"保守|定例"。全角の ｜ も可）を分ける。空のキーワードは捨てる */
export function splitKeywords(cell: string | null | undefined): string[] {
  if (cell === null || cell === undefined) return [];
  return String(cell)
    .normalize("NFKC")
    .split("|")
    .map((k) => k.trim())
    .filter((k) => normalizeKeyword(k) !== "");
}

/** 作業名（正規化済み）がキーワードのどれかを含むか */
export function includesAnyKeyword(normalizedTask: string, keywords: readonly string[]): boolean {
  return keywords.some((k) => normalizedTask.includes(normalizeKeyword(k)));
}
