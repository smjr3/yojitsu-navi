/**
 * 実行環境の差を吸収するテストの設定（tests/test-env.ts、SPEC §79.1）
 * - 性能テストの判定（loose 既定・strict・report）と上限
 * - 性能を測るテストは measure を使う（performance.now() で直接比べると Windows の Runner で落ちる）
 * - 別プロセスを長く待つテストは runAsync を使う（spawnSync で止めると Vitest のワーカーの通信がタイムアウトする）
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { defaultMaxWorkers, perfLimit, perfMode, runAsync, runOk } from "../test-env.js";

const ROOT = join(__dirname, "..", "..");

describe("同時に動かすワーカーの数", () => {
  it("Windows は既定 2。VITEST_MAX_FORKS を設定したらその数。VITEST_MAX_WORKERS は Vitest に任せる。ほかの OS は Vitest の既定", () => {
    expect(defaultMaxWorkers("win32", {})).toBe(2);
    expect(defaultMaxWorkers("win32", { VITEST_MAX_FORKS: "" })).toBe(2);
    expect(defaultMaxWorkers("win32", { VITEST_MAX_FORKS: "1" })).toBe(1);
    expect(defaultMaxWorkers("linux", { VITEST_MAX_FORKS: "3" })).toBe(3);
    expect(defaultMaxWorkers("win32", { VITEST_MAX_WORKERS: "4", VITEST_MAX_FORKS: "1" })).toBeUndefined();
    expect(defaultMaxWorkers("linux", { VITEST_MAX_FORKS: "abc" })).toBeUndefined();
    expect(defaultMaxWorkers("linux", {})).toBeUndefined();
  });
});

describe("性能テストの判定", () => {
  it("既定は目安の 3 倍まで、strict は目安どおり、report は判定しない", () => {
    expect(perfMode({})).toBe("loose");
    expect(perfMode({ YOJITSU_PERF: "STRICT " })).toBe("strict");
    expect(perfMode({ YOJITSU_PERF: "report" })).toBe("report");
    expect(perfMode({ YOJITSU_PERF: "nope" })).toBe("loose");
    expect(perfLimit(2000, {})).toBe(6000);
    expect(perfLimit(2000, { YOJITSU_PERF_FACTOR: "5" })).toBe(10_000);
    expect(perfLimit(2000, { YOJITSU_PERF_FACTOR: "-1" })).toBe(6000);
    expect(perfLimit(2000, { YOJITSU_PERF: "strict", YOJITSU_PERF_FACTOR: "5" })).toBe(2000);
    expect(perfLimit(2000, { YOJITSU_PERF: "report" })).toBe(Number.POSITIVE_INFINITY);
  });

  it("性能を測るテストは measure を使い、performance.now() で直接比べない", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
    const bad = ["unit", "integration", "property", "fuzz"]
      .flatMap((d) => files(join(ROOT, "tests", d)))
      .filter((f) => !f.endsWith("test-env.test.ts") && readFileSync(f, "utf-8").includes("performance.now("))
      .map((f) => relative(ROOT, f).split(sep).join("/"));
    expect(bad).toEqual([]);
  });
});

describe("別プロセスを待つ", () => {
  it("標準出力・標準エラー・終了コードを返し、失敗は runOk で例外になる", async () => {
    const r = await runAsync(process.execPath, ["-e", "process.stdout.write('出力'); process.stderr.write('e'); process.exit(3)"]);
    expect(r).toEqual({ status: 3, stdout: "出力", stderr: "e" });
    await expect(runOk(process.execPath, ["-e", "process.exit(0)"])).resolves.toBe("");
    await expect(runOk(process.execPath, ["-e", "console.error('だめ'); process.exit(1)"])).rejects.toThrow(/だめ/);
  });
});
