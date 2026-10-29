/**
 * 文書の古いリンクを残さない・画像を置かない（CONTRIBUTING.md「ドキュメントは同じ変更の中で直す」）
 *   - README・CONTRIBUTING・docs/*.md・tests/e2e/README.md の相対リンクの参照先が存在する
 *   - 文書に画像（スクリーンショット）を載せない。リポジトリに画像ファイルを置かない（画面を変えるたびに古くなるため）
 *   - npm run の名前が package.json にある
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");
const DOCS = ["README.md", "CONTRIBUTING.md", "tests/e2e/README.md", ...readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as { scripts: Record<string, string> };

/** コードブロックを除いた本文 */
const prose = (text: string) => text.replace(/```[\s\S]*?```/g, "");

describe.each(DOCS)("%s", (file) => {
  const text = prose(readFileSync(join(ROOT, file), "utf-8"));

  it("相対リンクの参照先が存在する", () => {
    const missing: string[] = [];
    for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = m[1]!.split("#")[0]!;
      if (!target || /^[a-z]+:/i.test(target)) continue;
      if (!existsSync(join(ROOT, dirname(file), decodeURIComponent(target)))) missing.push(m[1]!);
    }
    expect(missing).toEqual([]);
  });

  it("画像を載せていない", () => {
    const images = [...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)|<img\b[^>]*>/gi)].map((m) => m[0]);
    expect(images).toEqual([]);
  });

  it("npm run の名前が package.json にある", () => {
    const names = [...readFileSync(join(ROOT, file), "utf-8").matchAll(/npm run ([a-z][a-z0-9:-]*)/g)].map((m) => m[1]!);
    expect(names.filter((n) => !pkg.scripts[n])).toEqual([]);
  });
});

/** 生成物・依存・テスト結果は除く（コミットしないもの） */
const SKIP = new Set([".git", "node_modules", "dist", "test-results", "playwright-report", ".observablehq"]);
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

function images(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP.has(e.name)) return [];
    const path = join(dir, e.name);
    if (e.isDirectory()) return images(path);
    return IMAGE.test(e.name) ? [relative(ROOT, path)] : [];
  });
}

it("リポジトリに画像ファイルを置いていない", () => {
  expect(images(ROOT)).toEqual([]);
});
