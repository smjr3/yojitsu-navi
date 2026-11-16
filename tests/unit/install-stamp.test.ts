/**
 * 依存を入れ直さなくてよいかの印（scripts/lib/install-stamp.mjs。CI の scripts/ci/install.mjs と yojitsu-navi upgrade が使う。SPEC §126）
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearInstallStamp, installKey, installUpToDate, writeInstallStamp } from "../../scripts/lib/install-stamp.mjs";

const dirs: string[] = [];
function project(lock = '{"lockfileVersion":3}'): string {
  const dir = mkdtempSync(join(tmpdir(), "yn-stamp-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package-lock.json"), lock);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("依存の印（SPEC §126）", () => {
  it("入れ終わって印を書けば、同じ lock・Node・OS のあいだは入れ直さない", () => {
    const dir = project();
    expect(installUpToDate(dir)).toBe(false);
    mkdirSync(join(dir, "node_modules"));
    writeInstallStamp(dir);
    expect(installUpToDate(dir)).toBe(true);
  });

  it("package-lock.json・Node の主な版・OS・依存込みのキャッシュの有無のどれかが変われば入れ直す", () => {
    const dir = project();
    mkdirSync(join(dir, "node_modules"));
    writeInstallStamp(dir);
    expect(installUpToDate(dir, installKey(dir, "v99.0.0"))).toBe(false);
    expect(installUpToDate(dir, installKey(dir, process.version, "other-x64"))).toBe(false);
    mkdirSync(join(dir, "vendor", "npm-cache"), { recursive: true });
    expect(installUpToDate(dir)).toBe(false);
    rmSync(join(dir, "vendor"), { recursive: true });
    writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3,"x":1}');
    expect(installUpToDate(dir)).toBe(false);
  });

  it("入れ始めに印を消すので、途中で止まった node_modules は使わない。node_modules が無ければ印を書かない", () => {
    const dir = project();
    writeInstallStamp(dir);
    expect(installUpToDate(dir)).toBe(false);
    mkdirSync(join(dir, "node_modules"));
    writeInstallStamp(dir);
    clearInstallStamp(dir);
    expect(installUpToDate(dir)).toBe(false);
  });
});
