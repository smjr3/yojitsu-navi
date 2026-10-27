/**
 * 文字コードの自動判定つきテキスト読み込み（Node 側専用）
 *
 * 社内で Excel から保存した CSV は Shift_JIS（CP932）のことがあるため、
 * UTF-8（BOM あり／なし）として厳密にデコードできなければ Shift_JIS として読む。
 * 戻り値の文字列からは BOM を取り除く。
 */
import { readFileSync } from "node:fs";

export type DetectedEncoding = "utf-8" | "utf-8-bom" | "shift_jis";

export interface DecodedText {
  text: string;
  encoding: DetectedEncoding;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

/** バイト列を文字コード判定つきでデコードする */
export function decodeAuto(bytes: Uint8Array): DecodedText {
  const hasBom = bytes.length >= 3 && bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2];
  const body = hasBom ? bytes.subarray(3) : bytes;
  try {
    // fatal: true → 不正なバイト列があれば例外（= UTF-8 ではない）
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    return { text, encoding: hasBom ? "utf-8-bom" : "utf-8" };
  } catch {
    // Node の TextDecoder は "shift_jis" ラベルで CP932 相当をデコードできる（full ICU 同梱時）
    const text = new TextDecoder("shift_jis").decode(body);
    return { text, encoding: "shift_jis" };
  }
}

/** ファイルを読み、文字コードを自動判定して文字列にする */
export function readTextAuto(path: string): string {
  return decodeAuto(readFileSync(path)).text;
}

/** 判定結果も返したいとき用 */
export function readTextAutoDetailed(path: string): DecodedText {
  return decodeAuto(readFileSync(path));
}
