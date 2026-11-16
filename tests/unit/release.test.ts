/**
 * 版上げと自動の公開（SPEC §121、docs/RELEASE.md）
 * - version:bump が次の版を決め、CHANGELOG の「## 次の版」を版の番号にする
 * - リリースの説明は CHANGELOG のその版の中身
 * - publish-npm は main の packages/app/package.json の変更で動き、公開済みなら依存を入れずに終わる
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nextVersion, releaseNotes, renameNextHeading } from "../../scripts/lib/release.mjs";

const ROOT = join(import.meta.dirname, "..", "..");

describe("版上げ", () => {
  it("patch・minor・major・x.y.z から次の版を決める", () => {
    expect(nextVersion("0.3.9", "patch")).toBe("0.3.10");
    expect(nextVersion("0.3.9", "minor")).toBe("0.4.0");
    expect(nextVersion("0.3.9", "major")).toBe("1.0.0");
    expect(nextVersion("0.3.9", "2.0.1")).toBe("2.0.1");
    expect(() => nextVersion("0.3.9", undefined)).toThrow();
    expect(() => nextVersion("0.3.9", "v1")).toThrow();
  });

  it("「## 次の版」を「## <版>」にする。無ければ止める", () => {
    expect(renameNextHeading("# 変更履歴\r\n\r\n## 次の版\r\n### 変更\r\n- a\r\n## 0.3.0\r\n", "0.4.0")).toBe("# 変更履歴\r\n\r\n## 0.4.0\r\n### 変更\r\n- a\r\n## 0.3.0\r\n");
    expect(() => renameNextHeading("## 0.3.0\n", "0.4.0")).toThrow(/次の版/);
  });
});

describe("リリースの説明", () => {
  const text = ["# 変更履歴", "## 0.10.0（大きな版）", "### 変更", "- c", "", "## 0.1.0", "### 変更", "- old"].join("\n");

  it("その版の見出しから次の版の見出しの前まで。似た番号の版は取らない", () => {
    expect(releaseNotes(text, "0.10.0")).toBe("### 変更\n- c");
    expect(releaseNotes(text, "0.1.0")).toBe("### 変更\n- old");
    expect(releaseNotes(text, "0.1")).toBe("");
  });

  it("リポジトリの CHANGELOG.md に今の版の説明がある", () => {
    const v = JSON.parse(readFileSync(join(ROOT, "packages", "app", "package.json"), "utf-8")).version;
    expect(releaseNotes(readFileSync(join(ROOT, "CHANGELOG.md"), "utf-8"), v)).not.toBe("");
  });
});

describe("publish-npm のワークフロー", () => {
  const yml = readFileSync(join(ROOT, ".github", "workflows", "publish-npm.yml"), "utf-8");

  it("main の packages/app/package.json の変更と手動で動く（タグの push では動かない）", () => {
    expect(yml).toMatch(/branches: \[main\]\s+paths: \["packages\/app\/package.json"\]/);
    expect(yml).toContain("workflow_dispatch:");
    expect(yml).not.toMatch(/tags:/);
  });

  it("タグ・リリースを作る権限と OIDC の権限があり、provenance は付けない", () => {
    expect(yml).toContain("contents: write");
    expect(yml).toContain("id-token: write");
    expect(yml).toMatch(/NPM_CONFIG_PROVENANCE: "false"/);
  });

  it("公開が要るかを依存のインストールより前に調べ、要らなければ後を飛ばす", () => {
    const check = yml.indexOf("publish-npm.mjs --check");
    const install = yml.indexOf("npm ci");
    expect(check).toBeGreaterThan(0);
    expect(install).toBeGreaterThan(check);
    expect(yml.match(/if: steps\.check\.outputs\.needed == 'true'/g)).toHaveLength(2);
  });
});
