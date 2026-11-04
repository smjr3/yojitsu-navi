/**
 * パッケージの組み立て（scripts/build-app.mjs）は開発元のリポジトリ専用（SPEC §84.1）
 *   - init で作ったプロジェクト（.yojitsu-navi.json がある）では止める
 *   - 社内の接続先・証明書・鍵・利用環境の記録が紛れていたら止める
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInternalFile, packageGuardProblems, PROJECT_MANIFEST } from "../../scripts/lib/package-guard.mjs";

const REPO = join(__dirname, "..", "..");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yn-guard-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("packageGuardProblems", () => {
  it("開発元のリポジトリ（今の git 管理ファイル）なら止めない", () => {
    const files = execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf-8" }).split(/\r?\n/).filter(Boolean);
    expect(packageGuardProblems(REPO, files)).toEqual([]);
  });

  it("init で作ったプロジェクト（記録がある）では止める", () => {
    writeFileSync(join(dir, PROJECT_MANIFEST), "{}");
    const problems = packageGuardProblems(dir, ["package.json"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("開発元のリポジトリ専用");
  });

  it.each([".npmrc", "packages/app/.npmrc", ".yarnrc.yml", ".env", ".env.local", "certs/corp-root.crt", "ca.PEM", "id.key", ".yojitsu-navi.json", ".yojitsu-navi-backup/2026/x", "vendor/npm-cache/index", "a\\.npmrc"])(
    "%s は入れない",
    (f) => {
      expect(isInternalFile(f)).toBe(true);
      expect(packageGuardProblems(dir, ["package.json", f])[0]).toContain(f);
    },
  );

  it.each(["package.json", "config.json", "docs/OPERATIONS.md", "scripts/ci/install.mjs", ".gitlab-ci.yml", "src/environment.ts", "keys.ts"])("%s は止めない", (f) => {
    expect(isInternalFile(f)).toBe(false);
  });
});
