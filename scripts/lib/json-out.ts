/**
 * ローダの出力を JSON にする前の検査（Node 側専用。src/data/_shared.ts の emitJson が使う）
 */

/**
 * JSON に出せない値（NaN・±Infinity・undefined・関数・BigInt・循環参照）を探す。見つけたらその場所を返す
 * （JSON.stringify は NaN を黙って null にするため、画面で 0 円や空欄に化けるのを防ぐ）
 */
export function findInvalidJsonValue(value: unknown): string | null {
  const stack: Array<{ v: unknown; path: string }> = [{ v: value, path: "$" }];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const { v, path } = stack.pop()!;
    if (v === null || typeof v === "string" || typeof v === "boolean") continue;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return `${path} = ${String(v)}`;
      continue;
    }
    if (typeof v !== "object") return `${path} = ${typeof v}`;
    if (seen.has(v)) return `${path}（循環参照）`;
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        if (v[i] === undefined) return `${path}[${i}] = undefined`;
        stack.push({ v: v[i], path: `${path}[${i}]` });
      }
    } else {
      for (const [k, x] of Object.entries(v)) {
        if (x === undefined) continue; // オブジェクトの undefined は JSON で項目ごと消えるだけ（省略可能な項目）
        stack.push({ v: x, path: `${path}.${k}` });
      }
    }
  }
  return null;
}

/** 検査してから JSON 文字列にする。問題があれば例外 */
export function serializeChecked(value: unknown): string {
  const bad = findInvalidJsonValue(value);
  if (bad) throw new Error(`JSON に出せない値があります: ${bad}`);
  const text = JSON.stringify(value);
  if (!text || text.length < 2) throw new Error("出力が空です");
  return text;
}
