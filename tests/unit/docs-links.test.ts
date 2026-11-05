/**
 * 文書の古いリンクを残さない・画像を置かない（CONTRIBUTING.md「ドキュメントは同じ変更の中で直す」）
 *   - README・CONTRIBUTING・docs/*.md・tests/e2e/README.md の相対リンクの参照先が存在する
 *   - 文書に画像（スクリーンショット・バッジ）を載せない。リポジトリに画像ファイルを置かない
 *     （画面を変えるたびに古くなり、npm パッケージも無駄に大きくなるため）。拡張子と中身（先頭のバイト）の両方で調べ、
 *     どうしても必要なものだけ IMAGE_ALLOWLIST（scripts/lib/image-detect.mjs）に理由つきで足す（今はファビコンだけ）
 *   - npm run の名前が package.json にある
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
// @ts-expect-error 型定義の無い .mjs（scripts/build-app.mjs と共通）
import { IMAGE_ALLOWLIST as ALLOW, isImage } from "../../scripts/lib/image-detect.mjs";

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
    const images = [...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)|<img\b[^>]*>|<picture\b[^>]*>|<svg\b[^>]*>|^\[[^\]]+\]:\s*\S+\.(?:png|jpe?g|gif|webp|svg|avif)\b/gim)].map((m) => m[0]);
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

/**
 * リポジトリに置いてよい画像（パス → 理由）。どうしても必要なときだけ理由つきで足す。npm パッケージの検査と共通。
 * 今はファビコン（src/icons/。SPEC §89）だけ。フォントは画像ではない
 */
const IMAGE_ALLOWLIST = ALLOW as Record<string, string>;

it("リポジトリに画像ファイルを置いていない（拡張子・中身の両方。許可リスト以外）", () => {
  const images = repoFiles().filter((f) => !(f in IMAGE_ALLOWLIST) && isImage(f, join(ROOT, f)));
  expect(images).toEqual([]);
});

it("画像の許可リストに理由があり、実在する", () => {
  for (const [f, why] of Object.entries(IMAGE_ALLOWLIST)) {
    expect(why.trim(), f).not.toBe("");
    expect(existsSync(join(ROOT, f)), f).toBe(true);
  }
});
