/**
 * 壊れたファイルを残さない書き込み（Node 側専用）
 *
 * - writeFileAtomic: 同じフォルダの一時ファイルに書いて fsync → rename。途中で落ちても元のファイルはそのまま
 * - writeFilesAtomic: 複数ファイルを「全部書けたら全部差し替える」。1 つでも書けなければ何も差し替えない
 *   （作業実績の月ファイルが一部の月だけ新しくなる、といった中途半端な状態を作らない）
 *
 * 一時ファイル名は `<name>.tmp-<pid>-<乱数>`。異常終了で残った一時ファイルは listStaleTempFiles で見つけて消せる。
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
  for (const s of staged) renameSync(s.temp, s.path);
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
