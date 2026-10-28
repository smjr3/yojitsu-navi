/**
 * 画面文言ファイル（src/i18n/ja.js）の検査
 *  - コードが参照している T.xxx.yyy（設定ファイルは ja.xxx.yyy）がすべて ja.js にある
 *  - fmt(T.xxx, { a, b }) で、文言の {名前} がすべて差し込まれる（書き換えで {名前} を打ち間違えたら気付く）
 *  - 文言はすべて空でない文字列
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { T, fmt } from "../../src/i18n/index.js";

const ROOT = new URL("../../", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "i18n") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(js|ts|md)$/.test(name)) out.push(p);
  }
  return out;
}

const FILES = [...sourceFiles(join(ROOT, "src")), ...sourceFiles(join(ROOT, "scripts")), join(ROOT, "observablehq.config.js")].map((p) => ({
  path: p.slice(ROOT.length),
  text: readFileSync(p, "utf-8"),
}));

function lookup(path: string[]): unknown {
  let v: unknown = T;
  for (const k of path) {
    if (v === null || typeof v !== "object" || !(k in (v as object))) return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

/** ネストした文言をすべて [キー, 値] で */
function leaves(obj: unknown, prefix = ""): Array<[string, unknown]> {
  if (obj === null || typeof obj !== "object") return [[prefix, obj]];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

describe("画面文言 ja.js", () => {
  it("コードが参照するキーがすべてある", () => {
    const missing: string[] = [];
    for (const f of FILES) {
      const re = f.path === "observablehq.config.js" ? /\bja((?:\.\w+)+)(?![\w"'])/g : /\bT((?:\.\w+)+)(?![\w"'])/g;
      for (const m of f.text.matchAll(re)) {
        const keys = (m[1] as string).slice(1).split(".");
        // T.xxx.yyy.length などの末尾のプロパティ参照は除いて探す
        const found = [keys, keys.slice(0, -1)].some((k) => k.length > 0 && lookup(k) !== undefined);
        if (!found) missing.push(`${f.path}: T.${keys.join(".")}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("fmt(T.xxx, {…}) の差し込み口 {名前} がすべて渡されている", () => {
    const problems: string[] = [];
    for (const f of FILES) {
      for (const m of f.text.matchAll(/fmt\(\s*T((?:\.\w+)+)\s*,\s*\{([^{}]*)\}\s*\)/g)) {
        const template = lookup((m[1] as string).slice(1).split("."));
        if (typeof template !== "string") continue;
        const given = new Set([...(m[2] as string).matchAll(/(?:^|,)\s*(\w+)\s*(?=:|,|$)/g)].map((x) => x[1]));
        for (const p of template.matchAll(/\{(\w+)\}/g)) {
          if (!given.has(p[1] as string)) problems.push(`${f.path}: T${m[1]} の {${p[1]}} が渡されていない`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("文言はすべて空でない文字列", () => {
    const bad = leaves(T).filter(([, v]) => typeof v !== "string" || v.trim() === "");
    expect(bad).toEqual([]);
  });

  it("fmt は {名前} を値に置き換え、渡されていない {名前} はそのまま残す", () => {
    expect(fmt("{a} と {b}", { a: 1 })).toBe("1 と {b}");
    expect(fmt("{n}件", { n: 0 })).toBe("0件");
  });

  it("計算ルールの本文 rules.txt: 差し込み口はすべて既知の名前（未知の {名前} が画面にそのまま出ない）", () => {
    const page = execFileSync(process.execPath, [join(ROOT, "src", "rules.md.js")], { encoding: "utf-8" });
    const prose = page.slice(page.indexOf('<div class="yn-prose">')).replace(/```[\s\S]*?```/g, "");
    expect([...prose.matchAll(/(?<!\$)\{(\w+)\}/g)].map((m) => m[0])).toEqual([]);
    expect(page).toContain("${contract}");
  });
});
