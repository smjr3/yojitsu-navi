/**
 * 年度・年月の直書きをさせない（SPEC §49）。画面・計算・データ生成・CI の設定に「2026-04」「FY2026」「2026年度」のような
 * 固定の年を書くと、来年度にそのまま使えなくなる。年は計算基準日（YOJITSU_AS_OF／今日）から求める。
 * コメントの中の書式の例（"2026-10" → "2026年10月" など）は対象外。テストは基準日を固定しているので対象外。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
const ROOTS = ["src", "scripts", "packages/app/bin", "packages/app/lib", ".github", "config.json", "observablehq.config.js", ".gitlab-ci.yml"];
const SKIP_DIRS = new Set(["node_modules", "dist", "fonts", ".observablehq"]);
const EXT = /\.(js|mjs|ts|md|txt|json|ya?ml|sh|css)$/;
/** 年月（2026-04）・年（2026年）・年度（2026年度）・FY2026。金額や ID の数字列の一部は拾わない */
export const FIXED_YEAR = /(?<!\d)20\d\d(?:-(?:0[1-9]|1[0-2])(?!\d)|年)|FY20\d\d/;

function files(): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isDirectory()) {
      for (const f of readdirSync(p).sort()) if (!SKIP_DIRS.has(f)) walk(join(p, f));
    } else if (EXT.test(p)) out.push(p);
  };
  for (const r of ROOTS) walk(join(REPO, r));
  return out;
}

/** コメント（// …、/* … *\/、# …、<!-- … -->）を除いた行 */
export function codeLines(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let inBlock = false;
  text.split("\n").forEach((raw, i) => {
    let t = raw.trim();
    if (inBlock) {
      if (t.includes("*/")) inBlock = false;
      return;
    }
    if (t.startsWith("/*")) {
      if (!t.includes("*/")) inBlock = true;
      return;
    }
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("#") || t.startsWith("<!--")) return;
    t = t.replace(/\s\/\/\s.*$/, "");
    out.push({ line: i + 1, text: t });
  });
  return out;
}

describe("年度・年月の直書きが無い", () => {
  it("検出の正規表現（拾うもの・拾わないもの）", () => {
    for (const s of ['"2026-04"', "FY2026 更新", "2026年度", "2026年4月"]) expect(FIXED_YEAR.test(s), s).toBe(true);
    for (const s of ["total_amount: 42000000", "YYYY-MM", "c.m(0, 4)", "12026-04x", "2026-13"]) expect(FIXED_YEAR.test(s), s).toBe(false);
  });

  it("src・scripts・パッケージ・CI 設定のコード（コメント以外）に固定の年が無い", () => {
    const hits: string[] = [];
    for (const f of files()) {
      for (const l of codeLines(readFileSync(f, "utf-8"))) if (FIXED_YEAR.test(l.text)) hits.push(`${relative(REPO, f)}:${l.line}: ${l.text.slice(0, 120)}`);
    }
    expect(hits).toEqual([]);
  });
});
