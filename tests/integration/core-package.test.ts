/**
 * 計算コアの npm パッケージ（@yojitsu-navi/core、SPEC §43）
 * - npm run core:build が通り、dist の公開 API が src/core/index.ts と同じであること
 * - src/core が読むのは src/core と src/i18n だけ（ほかを読むとパッケージで壊れる）
 * - パッケージに入るファイル（dist と README だけ。テスト・データ・画面は入らない）
 * - 別プロジェクトから入れたときに、Node で読み込めて型も解決できること（NodeNext）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { npm } from "../../scripts/lib/npm.mjs";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as src from "../../src/core/index.js";

const ROOT = join(__dirname, "..", "..");
const PKG = join(ROOT, "packages", "core");
const pkgJson = JSON.parse(readFileSync(join(PKG, "package.json"), "utf-8"));
let consumer = "";

beforeAll(() => {
  execFileSync(process.execPath, [join(ROOT, "scripts", "build-core.mjs")], { cwd: ROOT, stdio: "pipe" });
  // 別プロジェクトに入れた状態を再現する（node_modules/@yojitsu-navi/core → packages/core）
  consumer = mkdtempSync(join(tmpdir(), "yojitsu-core-"));
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  mkdirSync(join(consumer, "node_modules", "@yojitsu-navi"), { recursive: true });
  // Windows は管理者権限なしでシンボリックリンクを作れないので、ジャンクションにする
  symlinkSync(PKG, join(consumer, "node_modules", "@yojitsu-navi", "core"), process.platform === "win32" ? "junction" : "dir");
}, 60_000);

afterAll(() => {
  if (consumer) rmSync(consumer, { recursive: true, force: true });
});

describe("@yojitsu-navi/core", () => {
  it("名前は社内グループのスコープ、ルートの版と独立した版を持つ", () => {
    expect(pkgJson.name).toBe("@yojitsu-navi/core");
    expect(pkgJson.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkgJson.dependencies ?? {}).toEqual({});
  });

  it("src/core が読むのは src/core と src/i18n（パッケージに入るもの）だけ", () => {
    const dir = join(ROOT, "src", "core");
    const bad: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      for (const m of readFileSync(join(dir, f), "utf-8").matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']/gm)) {
        const spec = (m[1] ?? m[2] ?? m[3])!;
        if (spec.startsWith("./") || spec === "../i18n/index.js") continue;
        bad.push(`${f}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("dist の公開 API が src/core/index.ts と同じ", async () => {
    const dist = await import(pathToFileURL(join(PKG, "dist", "core", "index.js")).href);
    expect(Object.keys(dist).sort()).toEqual(Object.keys(src).sort());
  });

  it("パッケージに入るのは dist・README・LICENSE だけ", () => {
    const out = String(npm(["pack", "--dry-run", "--json"], { cwd: PKG, encoding: "utf-8" }));
    const files: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
    expect(files).toContain("dist/core/index.js");
    expect(files).toContain("dist/core/index.d.ts");
    expect(files).toContain("dist/i18n/ja.js");
    expect(files).toContain("README.md");
    expect(files).toContain("LICENSE");
    expect(files.filter((f) => !f.startsWith("dist/") && !["README.md", "LICENSE", "package.json"].includes(f))).toEqual([]);
    expect(files.some((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))).toBe(false);
  });

  it("別プロジェクトから Node で読み込める（ルートと個別のモジュール）", () => {
    const script = [
      'import { monthRange, formatYen, buildModel } from "@yojitsu-navi/core";',
      'import { effectiveSaveMode } from "@yojitsu-navi/core/gitlab";',
      'console.log(JSON.stringify([monthRange("2026-03", "2026-05"), formatYen(1234567, "millionYen"), typeof buildModel, typeof effectiveSaveMode]));',
    ].join("\n");
    writeFileSync(join(consumer, "run.mjs"), script);
    const r = spawnSync(process.execPath, ["run.mjs"], { cwd: consumer, encoding: "utf-8" });
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual([["2026-03", "2026-04", "2026-05"], src.formatYen(1234567, "millionYen"), "function", "function"]);
  });

  it("別プロジェクトの TypeScript で型が解決できる（型の誤りは誤りとして出る）", () => {
    const ok = [
      'import { monthRange, type Contract, type MoneyUnit } from "@yojitsu-navi/core";',
      'import type { MasterEditConfig } from "@yojitsu-navi/core/types";',
      'const m: string[] = monthRange("2026-04", "2026-06");',
      'const u: MoneyUnit = "thousandYen";',
      "const c: Contract | undefined = undefined;",
      "const e: MasterEditConfig | undefined = undefined;",
      "export { m, u, c, e };",
    ].join("\n");
    writeFileSync(join(consumer, "ok.ts"), ok);
    writeFileSync(join(consumer, "ng.ts"), 'import { monthRange } from "@yojitsu-navi/core";\nexport const n: number = monthRange("2026-04", "2026-06");\n');
    const tsc = (file: string) =>
      spawnSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", file], { cwd: consumer, encoding: "utf-8" });
    const good = tsc("ok.ts");
    expect(good.stdout + good.stderr).toBe("");
    expect(good.status).toBe(0);
    const bad = tsc("ng.ts");
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toMatch(/TS2322/);
  }, 60_000);
});
