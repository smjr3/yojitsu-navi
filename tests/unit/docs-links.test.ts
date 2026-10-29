/**
 * 文書の古いリンクを残さない・画像を置かない（CONTRIBUTING.md「ドキュメントは同じ変更の中で直す」）
 *   - README・CONTRIBUTING・docs/*.md・tests/e2e/README.md の相対リンクの参照先が存在する
 *   - 文書に画像（スクリーンショット）を載せない。リポジトリに画像ファイルを置かない（画面を変えるたびに古くなるため）
 *   - npm run の名前が package.json にある
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

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

/** コミット済み＋これからコミットされうるファイル（.gitignore の生成物・依存・テスト結果は除く） */
const repoFiles = () =>
  execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf-8" })
    .split("\n")
    .filter((f) => f && existsSync(join(ROOT, f)));

it("リポジトリに画像ファイルを置いていない", () => {
  expect(repoFiles().filter((f) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f))).toEqual([]);
});
