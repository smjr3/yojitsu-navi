/**
 * 変更履歴（CHANGELOG.md）と、update が出す「更新後に行うこと」（SPEC §91.2）
 * - 版ごと・小見出しごとに読む。「次の版」は出さない。版の範囲は「今の版より新しく、新しい版以下」
 * - 設定の表は導入先の config.json の今の値を添える
 * - リポジトリの CHANGELOG.md に今の版の見出しがあり、設定の表の 1 列目が config.json の項目になっている
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NOTE_HEADINGS, configValue, parseChangelog, settingLines, updateNotes, versionsBetween } from "../../packages/app/lib/changelog.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const TEXT = readFileSync(join(ROOT, "CHANGELOG.md"), "utf-8");

describe("変更履歴の読み取り", () => {
  const text = ["# 変更履歴", "前書き", "## 次の版", "### 更新後に行うこと", "- n", "## 0.10.0（大きな版）", "### 更新後に行うこと", "", "- a", "", "### 変更", "- c", "## 0.9.1", "### テスト・CI の前提", "- t"].join("\r\n");

  it("版ごと・小見出しごとに分け、前後の空行を除く（CRLF でもよい）", () => {
    const e = parseChangelog(text);
    expect(e.map((x) => x.version)).toEqual(["次の版", "0.10.0", "0.9.1"]);
    expect(e[1]!.sections.get("更新後に行うこと")).toEqual(["- a"]);
    expect([...e[1]!.sections.keys()]).toEqual(["更新後に行うこと", "変更"]);
  });

  it("版の範囲は今の版より新しく新しい版以下、古い順。「次の版」は入れない（数字で比べる）", () => {
    const e = parseChangelog(text);
    expect(versionsBetween(e, "0.9.0", "0.10.0").map((x) => x.version)).toEqual(["0.9.1", "0.10.0"]);
    expect(versionsBetween(e, "0.9.1", "0.10.0").map((x) => x.version)).toEqual(["0.10.0"]);
    expect(versionsBetween(e, "0.10.0", "0.10.0")).toEqual([]);
  });

  it("設定の値と、設定の表（今の値・未設定のときは書かないときの値）", () => {
    expect(configValue({ a: { b: { c: false } } }, "a.b.c")).toBe(false);
    expect(configValue({ a: 1 }, "a.b")).toBeUndefined();
    const lines = ["| 項目 | 書かないとき | 推奨 | 理由・いつ |", "|---|---|---|---|", "| `a.b` | `short` | `empty` | 理由 |", "| `x` | 5000 | そのまま | |"];
    expect(settingLines(lines, { a: { b: "empty" } })).toEqual(['- a.b  今: "empty" / 推奨: empty（理由）', "- x  今: 未設定（書かないとき: 5000） / 推奨: そのまま"]);
    expect(settingLines(lines, null)[0]).toContain("未設定（書かないとき: short）");
  });

  it("update が出す文章: 3 つの小見出しだけを、版ごとに出す", () => {
    expect(updateNotes(text, "0.9.0", "0.10.0", null)).toEqual(["0.9.1:", "  [テスト・CI の前提]", "    - t", "0.10.0:", "  [更新後に行うこと]", "    - a"]);
  });
});

describe("リポジトリの CHANGELOG.md", () => {
  const entries = parseChangelog(TEXT);
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).version;

  it("今の版（package.json）の見出しがある（版を上げたら「次の版」を版の番号にする。docs/RELEASE.md）", () => {
    expect(entries.map((e) => e.version)).toContain(version);
  });

  it("小見出しは決まったものだけ。設定の表の 1 列目は config.json の項目（`a.b`）", () => {
    for (const e of entries) {
      for (const h of e.sections.keys()) expect([...NOTE_HEADINGS, "変更"], `${e.version} の ${h}`).toContain(h);
      const rows = (e.sections.get("新しい設定と推奨値") ?? []).filter((l) => /^\|/.test(l)).slice(2);
      for (const r of rows) expect(r, e.version).toMatch(/^\|\s*`[\w.]+`/);
    }
  });

  it("0.2.0 の案内に stopWhen の推奨が入っている（導入先で手で設定が要った）", () => {
    const notes = updateNotes(TEXT, "0.1.0", "0.2.0", {}).join("\n");
    expect(notes).toContain("worklogSource.http.pagination.stopWhen  今: 未設定（書かないとき: short）");
  });
});
