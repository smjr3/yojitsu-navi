/**
 * コミットの作者・Co-authored-by の検査（SPEC §151、scripts/check-commit-authors.mjs）
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error 型定義の無い .mjs
import { allowedEmail, commitProblems, parseLog } from "../../scripts/check-commit-authors.mjs";

describe("コミットの作者の検査", () => {
  it("Claude・GitHub の noreply・bot は通す", () => {
    for (const e of ["noreply@anthropic.com", "noreply@github.com", "12345+someone@users.noreply.github.com", "someone@users.noreply.github.com", "41898283+github-actions[bot]@users.noreply.github.com"]) {
      expect(allowedEmail(e), e).toBe(true);
    }
  });

  it("仮の名前・個人のアドレスは止める", () => {
    for (const e of ["x@x", "t@example.com", "test@example.local", "someone@gmail.com", "noreply@anthropic.com.evil", ""]) {
      expect(allowedEmail(e), e).toBe(false);
    }
  });

  it("Co-authored-by の仮のアドレスを見つける（大文字小文字を問わない）", () => {
    const ok = { authorEmail: "noreply@github.com", committerEmail: "noreply@github.com" };
    expect(commitProblems({ ...ok, body: "件名\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n" })).toEqual([]);
    expect(commitProblems({ ...ok, body: "件名\n\nCo-authored-by: Claude <noreply@anthropic.com>\nCo-authored-by: x <x@x>\n" })).toEqual(["Co-authored-by"]);
    expect(commitProblems({ authorEmail: "x@x", committerEmail: "x@x", body: "Merge" })).toEqual(["作者", "コミッター"]);
  });

  it("git log の出力を 1 件ずつに分ける", () => {
    const text = "a1\x1fx@x\x1fnoreply@github.com\x1fMerge\n\x1e\nb2\x1fnoreply@anthropic.com\x1fnoreply@anthropic.com\x1f件名\n\x1e\n";
    expect(parseLog(text).map((c: { sha: string; authorEmail: string }) => [c.sha, c.authorEmail])).toEqual([["a1", "x@x"], ["b2", "noreply@anthropic.com"]]);
  });
});
