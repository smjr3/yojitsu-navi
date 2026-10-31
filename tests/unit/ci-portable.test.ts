/**
 * Windows・Linux のどちらでも動くこと（本番の GitLab Runner は Windows。Linux に変わることもある）
 *   - .gitlab-ci.yml の script は sh と PowerShell のどちらでも同じ意味になるコマンドだけ
 *   - 改行は LF 固定（core.autocrlf=true の Windows でも CSV が CRLF にならない）
 *   - 作業実績の並び順が OS の言語設定で変わらない
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sortWorklogs } from "../../scripts/lib/csv.js";
import type { Worklog } from "../../src/core/types.js";

const ROOT = join(__dirname, "..", "..");

describe("Windows・Linux の両方で動く", () => {
  it(".gitlab-ci.yml の script は node scripts/ci/*.mjs・npm run・npx だけ（シェルの if・変数の展開・find などを書かない）", () => {
    const lines = readFileSync(join(ROOT, ".gitlab-ci.yml"), "utf-8").split("\n");
    const cmds: string[] = [];
    let inScript = false;
    for (const l of lines) {
      if (/^\s*(before_|after_)?script:\s*$/.test(l)) inScript = true;
      else if (inScript && /^\s*- /.test(l)) cmds.push(l.replace(/^\s*- /, "").trim());
      else if (inScript && !/^\s*#/.test(l) && l.trim() !== "") inScript = false;
    }
    expect(cmds.length).toBeGreaterThan(5);
    const ok = /^(node scripts\/ci\/[\w-]+\.mjs( [\w-]+)*|npm run [\w:]+|npx vitest run( --[\w=/.-]+)*)$/;
    expect(cmds.filter((c) => !ok.test(c))).toEqual([]);
    expect(lines.some((l) => /\bbash\b|\.sh\b/.test(l) && !/^\s*#/.test(l))).toBe(false);
  });

  it("改行は LF に固定している（.gitattributes）", () => {
    expect(readFileSync(join(ROOT, ".gitattributes"), "utf-8")).toMatch(/^\* text=auto eol=lf$/m);
    const attr = execFileSync("git", ["check-attr", "eol", "--", "data/masters/rates.csv", "scripts/ci/fetch-data.mjs"], { cwd: ROOT, encoding: "utf-8" });
    expect(attr.trim().split("\n").every((l) => l.endsWith(": eol: lf"))).toBe(true);
  });

  it("作業実績の並び順は OS の言語設定によらない（半角カナと全角カナ）", () => {
    const row = (projectName: string): Worklog => ({ date: "2026-04-01", memberId: "M1", customerName: "顧客", projectName, task: "t", hours: 1 }) as Worklog;
    const sorted = sortWorklogs([row("データ分析基盤運用"), row("ﾃﾞｰﾀ分析基盤運用")]).map((r) => r.projectName);
    // en-US の順（ja-JP では逆になる）
    expect(sorted).toEqual(["データ分析基盤運用", "ﾃﾞｰﾀ分析基盤運用"]);
  });
});
