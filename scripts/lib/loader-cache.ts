/**
 * データローダのキャッシュ（src/.observablehq/cache）の掃除（Node 側専用）
 *
 * prepareLoaderCache(root, fingerprint):
 *   1. 前回の指紋（.yojitsu-inputs.json）と違う・読めないなら、ローダの出力を全部捨てる
 *      （_npm/ は scripts/seed-npm-cache.mjs が作る空のバージョン記録なので残す）
 *   2. 指紋が同じでも、Framework が失敗時に残す *.err と、異常終了で残った一時ファイル（<name>.<pid>）は必ず消す
 *      （*.err が新しいと Framework は「直前に失敗した」としてローダを動かさない）
 *   3. 今回の指紋を原子的に書く
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import type { Fingerprint } from "./inputs.js";

export const CACHE_DIR = join("src", ".observablehq", "cache");
export const STAMP_FILE = ".yojitsu-inputs.json";
/** 消さないもの（seed-npm-cache.mjs が作る npm のバージョン記録） */
const KEEP = new Set(["_npm", STAMP_FILE]);

export interface PrepareResult {
  /** 捨てたか */
  cleared: boolean;
  reason: "first" | "changed" | "unreadable" | "same";
  /** 消した *.err・一時ファイルの数 */
  removedLeftovers: number;
}

function readStamp(path: string): { hash?: unknown } | null | "unreadable" {
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, "utf-8"));
    return v && typeof v === "object" ? v : "unreadable";
  } catch {
    return "unreadable";
  }
}

/** *.err と Framework の一時ファイル（<target>.<pid>）・atomic.ts の一時ファイルを再帰で消す */
function removeLeftovers(dir: string): number {
  let n = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name !== "_npm") n += removeLeftovers(p);
    } else if (/\.err$/.test(name) || /\.(json|csv|txt|md|js)\.\d+$/.test(name) || /\.tmp-\d+-[0-9a-f]{8}$/.test(name)) {
      rmSync(p, { force: true });
      n++;
    }
  }
  return n;
}

export function prepareLoaderCache(rootDir: string, fp: Fingerprint): PrepareResult {
  const dir = join(rootDir, CACHE_DIR);
  const stampPath = join(dir, STAMP_FILE);
  const stamp = readStamp(stampPath);
  let reason: PrepareResult["reason"];
  if (stamp === null) reason = existsSync(dir) && readdirSync(dir).some((n) => !KEEP.has(n)) ? "unreadable" : "first";
  else if (stamp === "unreadable") reason = "unreadable";
  else reason = stamp.hash === fp.hash ? "same" : "changed";

  const cleared = reason !== "same";
  if (cleared && existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (KEEP.has(name)) continue;
      rmSync(join(dir, name), { recursive: true, force: true });
    }
  }
  const removedLeftovers = removeLeftovers(dir);
  if (cleared) {
    // 指紋は掃除が終わってから書く（掃除の途中で落ちたら、次回も「違う」と判定されてやり直す）
    rmSync(stampPath, { force: true });
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(stampPath, JSON.stringify({ hash: fp.hash, asOf: fp.asOf, files: fp.files, at: new Date().toISOString() }, null, 2) + "\n");
  }
  return { cleared, reason, removedLeftovers };
}
