/**
 * データローダを実際に別プロセスで動かす（Framework がするのと同じ呼び方）
 *   - 標準出力が JSON だけで、入力の指紋（_build）が入る
 *   - 契約ごとの作業ログ明細は作り置きを使い、2 回目以降も同じ内容を返す
 *   - 引数が無い・壊れた呼び方は非 0 で終わり、標準出力に何も書かない
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { worklogKey } from "../../src/components/worklog-key.js";
import { runAsync, scaled } from "../test-env.js";

const ROOT = join(__dirname, "..", "..");
// tsx は node --import tsx で動かす（node_modules/.bin/tsx は Windows では .cmd で、直接起動できない）
const TSX_ARGS = ["--import", "tsx"];
const HASH = "e".repeat(64);
const ENV = { ...process.env, YOJITSU_AS_OF: "2026-10-27", YOJITSU_INPUT_HASH: HASH };
const MEMO = join(ROOT, "src", ".observablehq", "cache", ".yojitsu", `worklogs-${HASH.slice(0, 16)}`);

// 別プロセスを待つ間も Vitest のワーカーを止めない（spawnSync だと遅い環境でワーカーの通信がタイムアウトする。tests/test-env.ts）
const run = (file: string, args: string[] = [], extra: Record<string, string> = {}) =>
  runAsync(process.execPath, [...(file.endsWith(".js") ? [] : TSX_ARGS), join(ROOT, file), ...args], { cwd: ROOT, env: { ...ENV, ...extra } });

afterAll(() => rmSync(MEMO, { recursive: true, force: true }));

describe("データローダ（別プロセス）", () => {
  it.each(["src/data/model.json.ts", "src/data/dataset-issues.json.ts", "src/data/masters.json.ts"])("%s は JSON だけを出し、指紋と計算基準日を持つ", async (file) => {
    const r = await run(file);
    expect(r.status, r.stderr).toBe(0);
    const v = JSON.parse(r.stdout);
    expect(v._build).toEqual({ inputHash: HASH, asOf: "2026-10-27" });
  }, scaled(120_000));

  it("model.json の asOfFixed: build.ts は日付を必ず渡すので、呼び出し側が固定したかは YOJITSU_AS_OF_FIXED で決まる（§75）", async () => {
    const meta = async (extra: Record<string, string>) => {
      const r = await run("src/data/model.json.ts", [], extra);
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout).meta;
    };
    // 本番（YOJITSU_AS_OF を指定せずに npm run build）: 画面で今日に置き換える
    expect((await meta({ YOJITSU_AS_OF_FIXED: "0" })).asOfFixed).toBeUndefined();
    // テスト・試用版（YOJITSU_AS_OF=… npm run build）
    expect((await meta({ YOJITSU_AS_OF_FIXED: "1" })).asOfFixed).toBe(true);
  }, scaled(240_000));

  it("作業ログ明細: 1 回目で全契約分を作り置きし、2 回目はそれを読む（同じ内容）", async () => {
    rmSync(MEMO, { recursive: true, force: true });
    const file = "src/data/worklogs/[contractId].json.js";
    const first = await run(file, ["--contractId=C001"]);
    expect(first.status, first.stderr).toBe(0);
    expect(existsSync(join(MEMO, ".complete"))).toBe(true);
    const ids = readFileSync(join(ROOT, "data", "contracts.csv"), "utf-8")
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.split(",")[0]!);
    expect(readdirSync(MEMO).filter((n) => n.endsWith(".json")).sort()).toEqual([...new Set(ids)].map((id) => `${worklogKey(id)}.json`).sort());
    const again = await run(file, ["--contractId=C001"]);
    expect(again.stdout).toBe(first.stdout);
    const v = JSON.parse(first.stdout);
    expect(v).toMatchObject({ contractId: "C001", _build: { inputHash: HASH } });
    expect(v.months.length).toBeGreaterThan(0);
    // 作り置きに無い ID でも落ちずに notFound を返す
    const unknown = await run(file, ["--contractId=NOPE"]);
    expect(unknown.status).toBe(0);
    expect(JSON.parse(unknown.stdout)).toMatchObject({ contractId: "NOPE", notFound: true });
  }, scaled(180_000));

  it("引数が無いと非 0 で終わり、標準出力は空", async () => {
    const r = await run("src/data/worklogs/[contractId].json.js");
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  }, scaled(60_000));
});
