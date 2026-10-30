/**
 * style.css の構文: 閉じ忘れた { は CSS の入れ子として黙って後ろの規則を飲み込み、効かなくなる（マージで起きた）。
 * コメント・文字列を除いた波かっこの対応を確かめる
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("style.css", () => {
  it("波かっこが対応している（最上位で閉じ過ぎ・閉じ忘れが無い）", () => {
    const css = readFileSync(new URL("../../src/style.css", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
    let depth = 0;
    for (const ch of css) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});
