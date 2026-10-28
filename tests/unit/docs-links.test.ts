/**
 * 文書の古いリンク・古い画像を残さない（CONTRIBUTING.md「ドキュメントは同じ変更の中で直す」）
 *   - README・CONTRIBUTING・docs/*.md・tests/e2e/README.md の相対リンクと画像の参照先が存在する
 *   - docs/screenshots/ の画像はすべて README から参照されている（使っていない古い画像を置かない）
 *   - npm run の名前が package.json にある
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const DOCS = ["README.md", "CONTRIBUTING.md", "tests/e2e/README.md", ...readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as { scripts: Record<string, string> };

/** コードブロックを除いた本文 */
const prose = (text: string) => text.replace(/```[\s\S]*?```/g, "");

describe.each(DOCS)("%s", (file) => {
  const text = prose(readFileSync(join(ROOT, file), "utf-8"));

  it("相対リンク・画像の参照先が存在する", () => {
    const missing: string[] = [];
    for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = m[1]!.split("#")[0]!;
      if (!target || /^[a-z]+:/i.test(target)) continue;
      if (!existsSync(join(ROOT, dirname(file), decodeURIComponent(target)))) missing.push(m[1]!);
    }
    expect(missing).toEqual([]);
  });

  it("npm run の名前が package.json にある", () => {
    const names = [...readFileSync(join(ROOT, file), "utf-8").matchAll(/npm run ([a-z][a-z0-9:-]*)/g)].map((m) => m[1]!);
    expect(names.filter((n) => !pkg.scripts[n])).toEqual([]);
  });
});

it("docs/screenshots の画像はすべて README から参照されている", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
  const shots = readdirSync(join(ROOT, "docs", "screenshots")).filter((f) => /\.(png|jpe?g|gif|webp)$/.test(f));
  expect(shots.filter((f) => !readme.includes(`docs/screenshots/${f}`))).toEqual([]);
});
