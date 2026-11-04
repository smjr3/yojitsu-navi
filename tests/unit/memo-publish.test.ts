/**
 * 作業ログ明細の作り置きフォルダの置き方（src/data/_shared.ts publishMemoDir・scripts/lib/atomic.ts renameWithRetry）
 *   - 置けたら一時フォルダは残らない
 *   - 別のプロセスが先に置き終えていた（.complete がある）ときだけ黙って捨てる
 *   - それ以外の失敗は止める（黙って続けない）
 *   - Windows の一時的な失敗（EPERM 等）は待ってやり直す
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renameWithRetry } from "../../scripts/lib/atomic.js";
import { publishMemoDir } from "../../src/data/_shared.js";

let root: string;
let temp: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yn-memo-"));
  temp = join(root, "worklogs-x.tmp-1-00000000");
  dir = join(root, "worklogs-x");
  mkdirSync(temp);
  writeFileSync(join(temp, "C001.json"), "mine");
  writeFileSync(join(temp, ".complete"), "ok\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const errno = (code: string) => Object.assign(new Error(code), { code });

describe("publishMemoDir", () => {
  it("置けたら作り置きフォルダになり、一時フォルダは残らない", () => {
    publishMemoDir(temp, dir);
    expect(existsSync(join(dir, ".complete"))).toBe(true);
    expect(existsSync(temp)).toBe(false);
  });

  it("別のプロセスが先に置き終えていたら、そちらを残してこちらを捨てる", () => {
    mkdirSync(dir);
    writeFileSync(join(dir, "C001.json"), "other");
    writeFileSync(join(dir, ".complete"), "ok\n");
    publishMemoDir(temp, dir);
    expect(readFileSync(join(dir, "C001.json"), "utf-8")).toBe("other");
    expect(existsSync(temp)).toBe(false);
  });

  it(".complete の無いフォルダが残っていたら止める（作り置き無しで進まない）", () => {
    mkdirSync(dir);
    writeFileSync(join(dir, "C001.json"), "half");
    expect(() => publishMemoDir(temp, dir)).toThrow(/作り置きを置けませんでした/);
    expect(existsSync(temp)).toBe(false);
  });
});

describe("renameWithRetry", () => {
  it("一時的な失敗（EPERM・EACCES・EBUSY）は待ってやり直す", () => {
    const codes = ["EPERM", "EACCES", "EBUSY"];
    let calls = 0;
    const flaky = (a: string, b: string) => {
      if (calls < codes.length) throw errno(codes[calls++]!);
      calls++;
      renameSync(a, b);
    };
    expect(renameWithRetry(temp, dir, undefined, flaky)).toBe(true);
    expect(calls).toBe(4);
    expect(existsSync(join(dir, ".complete"))).toBe(true);
  });

  it("一時的な失敗が続けば最後の例外を投げる", () => {
    let calls = 0;
    const always = () => {
      calls++;
      throw errno("EPERM");
    };
    expect(() => renameWithRetry(temp, dir, undefined, always)).toThrow("EPERM");
    expect(calls).toBeGreaterThan(1);
  });

  it("一時的でない失敗はやり直さずに投げる", () => {
    let calls = 0;
    const fail = () => {
      calls++;
      throw errno("ENOSPC");
    };
    expect(() => renameWithRetry(temp, dir, undefined, fail)).toThrow("ENOSPC");
    expect(calls).toBe(1);
  });

  it("失敗しても目的の状態になっていれば（done）false を返す", () => {
    const fail = () => {
      throw errno("EPERM");
    };
    expect(renameWithRetry(temp, dir, () => true, fail)).toBe(false);
  });
});
