/**
 * データローダを実際に別プロセスで動かす（Framework がするのと同じ呼び方）
 *   - 標準出力が JSON だけで、入力の指紋（_build）が入る
 *   - 契約ごとの作業ログ明細は作り置きを使い、2 回目以降も同じ内容を返す
 *   - 引数が無い・壊れた呼び方は非 0 で終わり、標準出力に何も書かない
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { worklogKey } from "../../src/components/worklog-key.js";

const ROOT = join(__dirname, "..", "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const HASH = "e".repeat(64);
const ENV = { ...process.env, YOJITSU_AS_OF: "2026-10-27", YOJITSU_INPUT_HASH: HASH };
const MEMO = join(ROOT, "src", ".observablehq", "cache", ".yojitsu", `worklogs-${HASH.slice(0, 16)}`);

const run = (file: string, args: string[] = []) => spawnSync(file.endsWith(".js") ? process.execPath : TSX, [join(ROOT, file), ...args], { cwd: ROOT, env: ENV, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });

afterAll(() => rmSync(MEMO, { recursive: true, force: true }));

describe("データローダ（別プロセス）", () => {
  it.each(["src/data/model.json.ts", "src/data/dataset-issues.json.ts", "src/data/masters.json.ts"])("%s は JSON だけを出し、指紋と計算基準日を持つ", (file) => {
    const r = run(file);
    expect(r.status, r.stderr).toBe(0);
    const v = JSON.parse(r.stdout);
    expect(v._build).toEqual({ inputHash: HASH, asOf: "2026-10-27" });
  }, 120_000);

  it("作業ログ明細: 1 回目で全契約分を作り置きし、2 回目はそれを読む（同じ内容）", () => {
    rmSync(MEMO, { recursive: true, force: true });
    const file = "src/data/worklogs/[contractId].json.js";
    const first = run(file, ["--contractId=C001"]);
    expect(first.status, first.stderr).toBe(0);
    expect(existsSync(join(MEMO, ".complete"))).toBe(true);
    const ids = execFileSync("node", ["-e", "process.stdout.write(require('fs').readFileSync('data/contracts.csv','utf8'))"], { cwd: ROOT, encoding: "utf-8" })
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.split(",")[0]!);
    expect(readdirSync(MEMO).filter((n) => n.endsWith(".json")).sort()).toEqual([...new Set(ids)].map((id) => `${worklogKey(id)}.json`).sort());
    const again = run(file, ["--contractId=C001"]);
    expect(again.stdout).toBe(first.stdout);
    const v = JSON.parse(first.stdout);
    expect(v).toMatchObject({ contractId: "C001", _build: { inputHash: HASH } });
    expect(v.months.length).toBeGreaterThan(0);
    // 作り置きに無い ID でも落ちずに notFound を返す
    const unknown = run(file, ["--contractId=NOPE"]);
    expect(unknown.status).toBe(0);
    expect(JSON.parse(unknown.stdout)).toMatchObject({ contractId: "NOPE", notFound: true });
  }, 180_000);

  it("引数が無いと非 0 で終わり、標準出力は空", () => {
    const r = run("src/data/worklogs/[contractId].json.js");
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  }, 60_000);
});
