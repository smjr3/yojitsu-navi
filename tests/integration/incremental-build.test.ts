/**
 * 増分ビルド（SPEC §102、scripts/lib/prebuild.ts）
 *   - 全ローダの出力を 1 回の計算で作り、キャッシュ（src/.observablehq/cache/data/）に置く。記録（.yojitsu-outputs.json）に各出力のハッシュを書く
 *   - 2 回目は中身が変わったファイルだけを書き換える（同じ中身のファイルは更新時刻も変えない）
 *   - データの一部（1 件の作業実績・1 つの契約の金額）だけを変えると、作業ログ明細は影響のある契約の分だけ書き換わる
 *   - 作るべき出力に無いもの（消えた契約の明細・失敗の記録）は消す
 *   - 集計の出力の一覧（AGGREGATE_OUTPUTS）は src/data のローダと過不足なく対応する
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestProject } from "../fixtures/project.js";
import { CACHE_DIR, MANIFEST_FILE } from "../../scripts/lib/loader-cache.js";
import { prebuildOutputs, readManifest } from "../../scripts/lib/prebuild.js";
import { AGGREGATE_OUTPUTS } from "../../src/data/_outputs.js";
import { scaled } from "../test-env.js";

const REPO = join(__dirname, "..", "..");
const FP = (hash: string) => ({ hash: hash.repeat(64), codeHash: "0".repeat(64), asOf: "2026-10-27" });
let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const cacheFile = (rel: string) => join(dir, CACHE_DIR, ...rel.split("/"));
const mtimes = () => {
  const m = readManifest(dir)!;
  return Object.fromEntries(Object.keys(m.outputs).map((k) => [k, statSync(cacheFile(k)).mtimeMs]));
};
/** 更新時刻を過去にしておく（書き換えたかどうかを更新時刻で見分ける） */
const age = () => {
  const old = new Date(Date.now() - 3600_000);
  for (const k of Object.keys(readManifest(dir)!.outputs)) utimesSync(cacheFile(k), old, old);
};

describe("増分ビルド: ローダの出力をまとめて作り、変わったものだけ書き換える", () => {
  it("1 回目は全部書き、記録に全出力のハッシュが入る。同じ入力の 2 回目は何も書き換えない", () => {
    dir = createTestProject("yn-incr-");
    const first = prebuildOutputs(dir, FP("a"));
    const keys = Object.keys(first.outputs);
    expect(keys.filter((k) => !k.startsWith("data/worklogs/")).sort()).toEqual(Object.keys(AGGREGATE_OUTPUTS).map((n) => `data/${n}.json`).sort());
    expect(first.stats.details).toBeGreaterThan(5);
    expect(first.stats).toMatchObject({ written: keys.length, unchanged: 0, detailsWritten: first.stats.details });
    expect(existsSync(join(dir, CACHE_DIR, MANIFEST_FILE))).toBe(true);
    // 集計は入力の指紋を持ち、明細は持たない（計算基準日だけ）
    expect(JSON.parse(readFileSync(cacheFile("data/model.json"), "utf-8"))._build).toEqual({ inputHash: "a".repeat(64), asOf: "2026-10-27" });
    const detail = JSON.parse(readFileSync(cacheFile(keys.find((k) => k.startsWith("data/worklogs/"))!), "utf-8"));
    expect(detail._build).toEqual({ asOf: "2026-10-27" });

    age();
    const before = mtimes();
    const again = prebuildOutputs(dir, FP("a"));
    // model.json は作った時刻（meta.generatedAt）を持つので毎回書き換わる。ほかは同じ中身
    expect(again.stats.detailsWritten).toBe(0);
    const after = mtimes();
    const touched = keys.filter((k) => after[k] !== before[k]);
    expect(touched.every((k) => !k.startsWith("data/worklogs/"))).toBe(true);
  }, scaled(60_000));

  it("契約の金額だけを変えると、作業ログ明細は 1 件も書き換えない（明細は入力の指紋を持たないので）", () => {
    dir = createTestProject("yn-incr-");
    prebuildOutputs(dir, FP("a"));
    age();
    const before = mtimes();
    const path = join(dir, "data", "contracts.csv");
    writeFileSync(path, readFileSync(path, "utf-8").replace(/^(C002,.*),60000000,/m, "$1,61000000,"));
    const m = prebuildOutputs(dir, FP("b"));
    expect(m.stats.detailsWritten).toBe(0);
    expect(m.hash).toBe("b".repeat(64));
    const after = mtimes();
    expect(after["data/model.json"]).not.toBe(before["data/model.json"]);
    expect(JSON.parse(readFileSync(cacheFile("data/model.json"), "utf-8"))._build.inputHash).toBe("b".repeat(64));
  }, scaled(60_000));

  it("作業実績を 1 行だけ変えると、その契約の明細だけが書き換わる", () => {
    dir = createTestProject("yn-incr-");
    const first = prebuildOutputs(dir, FP("a"));
    age();
    const before = mtimes();
    const path = join(dir, "data", "worklogs", "2026-10.csv");
    const lines = readFileSync(path, "utf-8").split("\n");
    // 先頭の行（青葉物流の倉庫管理システム保守）の時間を変える
    lines[1] = lines[1]!.replace(/,3,$/, ",4,");
    expect(lines[1]).toMatch(/,4,$/);
    writeFileSync(path, lines.join("\n"));
    const m = prebuildOutputs(dir, FP("b"));
    expect(m.stats.detailsWritten).toBe(1);
    const after = mtimes();
    const changed = Object.keys(first.outputs).filter((k) => k.startsWith("data/worklogs/") && after[k] !== before[k]);
    expect(changed).toHaveLength(1);
    expect(m.outputs[changed[0]!]).not.toBe(first.outputs[changed[0]!]);
  }, scaled(60_000));

  it("消えた契約の明細・ローダの失敗の記録・知らない出力は消す。記録は最初に消して最後に書く（途中で失敗したら残らない）", () => {
    dir = createTestProject("yn-incr-");
    const first = prebuildOutputs(dir, FP("a"));
    writeFileSync(cacheFile("data/model.json.123.err"), "");
    writeFileSync(cacheFile("data/unknown.json"), "{}");
    const path = join(dir, "data", "contracts.csv");
    const rows = readFileSync(path, "utf-8").trim().split("\n");
    const dropped = rows.pop()!.split(",")[0]!;
    writeFileSync(path, `${rows.join("\n")}\n`);
    const m = prebuildOutputs(dir, FP("b"));
    expect(m.stats.removed).toBe(3);
    expect(Object.keys(m.outputs)).toHaveLength(Object.keys(first.outputs).length - 1);
    expect(existsSync(cacheFile(`data/worklogs/${dropped}.json`))).toBe(false);
    expect(existsSync(cacheFile("data/unknown.json"))).toBe(false);

    // 壊れたデータで失敗したら、記録は残らない（次のビルドは必ず作り直す）
    writeFileSync(join(dir, "config.json"), "{broken");
    expect(() => prebuildOutputs(dir, FP("c"))).toThrow();
    expect(readManifest(dir)).toBeNull();
  }, scaled(60_000));

  it("集計の出力の一覧は src/data のローダ（*.json.ts）と過不足なく対応する（ローダを足したら _outputs.ts にも足す）", () => {
    const loaders = readdirSync(join(REPO, "src", "data"))
      .filter((n) => /^[^_].*\.json\.ts$/.test(n))
      .map((n) => n.replace(/\.json\.ts$/, ""))
      .sort();
    expect(Object.keys(AGGREGATE_OUTPUTS).sort()).toEqual(loaders);
    for (const n of loaders) expect(readFileSync(join(REPO, "src", "data", `${n}.json.ts`), "utf-8")).toContain("AGGREGATE_OUTPUTS");
  });
});

