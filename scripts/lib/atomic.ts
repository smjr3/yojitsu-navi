/**
 * 壊れたファイルを残さない書き込み（Node 側専用）
 *
 * - writeFileAtomic: 同じフォルダの一時ファイルに書いて fsync → rename。途中で落ちても元のファイルはそのまま
 * - writeFilesAtomic: 複数ファイルを「全部書けたら全部差し替える」。1 つでも書けなければ何も差し替えない
 *   （作業実績の月ファイルが一部の月だけ新しくなる、といった中途半端な状態を作らない）
 *
 * 一時ファイル名は `<name>.tmp-<pid>-<乱数>`。異常終了で残った一時ファイルは listStaleTempFiles で見つけて消せる。
 *
 * rename は renameWithRetry を通す。Windows ではウイルス対策ソフトや別プロセスの読み込みが一時的にファイルを掴み、
 * rename が EPERM・EACCES・EBUSY で失敗することがあるので、少し待ってやり直す（それでも失敗したら例外。黙って続けない）。
 */
import { closeSync, fsyncSync, openSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const TEMP_RE = /\.tmp-\d+-[0-9a-f]{8}$/;

function tempPathFor(path: string): string {
  return join(dirname(path), `${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
}

function writeAndSync(path: string, data: string | Uint8Array): void {
  const fd = openSync(path, "w");
  try {
    const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** 1 ファイルを原子的に書き換える */
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  writeFilesAtomic([{ path, data }]);
}

/** 複数ファイルを全部書けたときだけ差し替える。失敗したら一時ファイルを消して例外を投げ直す */
export function writeFilesAtomic(entries: ReadonlyArray<{ path: string; data: string | Uint8Array }>): void {
  const staged: Array<{ temp: string; path: string }> = [];
  try {
    for (const e of entries) {
      const temp = tempPathFor(e.path);
      staged.push({ temp, path: e.path });
      writeAndSync(temp, e.data);
    }
  } catch (error) {
    for (const s of staged) rmSync(s.temp, { force: true });
    throw error;
  }
  // rename は同じファイルシステム内なら原子的。ここまで来れば全ファイルの中身は書けている
  for (const s of staged) renameWithRetry(s.temp, s.path);
}

/** Windows で一時的に起きる rename の失敗（ほかのプロセスがファイルを掴んでいる） */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_WAITS_MS = [20, 50, 100, 200, 400, 800];

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * rename して、一時的な失敗（EPERM・EACCES・EBUSY）なら少し待ってやり直す。
 * done を渡すと、失敗のたびに「もう目的の状態になっているか」（別のプロセスが先に置いた等）を確かめ、
 * なっていれば false を返す（こちらは置かなかった）。置けたら true。最後まで置けなければ最後の例外を投げる。
 * rename はテストで差し替える用。
 */
export function renameWithRetry(from: string, to: string, done?: () => boolean, rename: (from: string, to: string) => void = renameSync): boolean {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return true;
    } catch (error) {
      if (done?.()) return false;
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!TRANSIENT_RENAME_CODES.has(code) || attempt >= RENAME_WAITS_MS.length) throw error;
      sleepSync(RENAME_WAITS_MS[attempt]!);
    }
  }
}

/** 異常終了で残った一時ファイル（writeFileAtomic が作るもの）を列挙する */
export function listStaleTempFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => TEMP_RE.test(f))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}
