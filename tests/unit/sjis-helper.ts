/** テスト用: 文字列を Shift_JIS のバイト列にする（TextDecoder の逆引き。使う文字だけ対応表を作る） */
export function sjis(text: string): Uint8Array {
  // Shift_JIS のバイト列を Node の iconv 相当なしで作る: TextDecoder の逆引きで対応表を作る
  const map = new Map<string, number[]>();
  const dec = new TextDecoder("shift_jis");
  const chars = new Set(text);
  for (const ch of chars) {
    if (ch.charCodeAt(0) < 0x80) map.set(ch, [ch.charCodeAt(0)]);
  }
  for (let b = 0xa1; b <= 0xdf; b++) {
    const s = dec.decode(new Uint8Array([b]));
    if (chars.has(s) && !map.has(s)) map.set(s, [b]);
  }
  for (let hi = 0x81; hi <= 0xfc; hi++) {
    if (hi >= 0xa0 && hi <= 0xdf) continue;
    for (let lo = 0x40; lo <= 0xfc; lo++) {
      if (lo === 0x7f) continue;
      const s = dec.decode(new Uint8Array([hi, lo]));
      if (s.length === 1 && chars.has(s) && !map.has(s)) map.set(s, [hi, lo]);
    }
  }
  const out: number[] = [];
  for (const ch of text) {
    const b = map.get(ch);
    if (!b) throw new Error(`Shift_JIS 化できない文字: ${ch}`);
    out.push(...b);
  }
  return new Uint8Array(out);
}
