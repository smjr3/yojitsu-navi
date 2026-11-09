/**
 * データローダのキャッシュ（src/.observablehq/cache）の掃除（Node 側専用）
 *
 * prepareLoaderCache(root, fingerprint, opts):
 *   1. 前回の記録（.yojitsu-inputs.json）が無い・読めない・プログラムの指紋（codeHash）が違う・opts.full なら、全部捨てる（フルビルド）
 *      （_npm/ は scripts/seed-npm-cache.mjs が作る空のバージョン記録なので残す）
 *   2. プログラムは同じでデータだけ違うなら、Framework が作る依存ライブラリの束（_node/・_observablehq/）は残し、ほかを捨てる（増分ビルド。SPEC §102）。
 *      opts.keepDataOutputs（npm run build）のときはローダの出力（data/）と出力の記録も残す。
 *      ビルドは続けて scripts/prebuild-data.ts で全出力を作り、中身が変わったファイルだけを書き換える
 *   3. 指紋が同じでも、Framework が失敗時に残す *.err と、異常終了で残った一時ファイル（<name>.<pid>）は必ず消す
 *      （*.err が新しいと Framework は「直前に失敗した」としてローダを動かさない）
 *   4. 今回の指紋を原子的に書く
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import type { Fingerprint } from "./inputs.js";

export const CACHE_DIR = join("src", ".observablehq", "cache");
export const STAMP_FILE = ".yojitsu-inputs.json";
/** ローダの出力の記録（scripts/prebuild-data.ts が書く。各出力のハッシュ） */
export const MANIFEST_FILE = ".yojitsu-outputs.json";
/** 消さないもの（seed-npm-cache.mjs が作る npm のバージョン記録） */
const KEEP = new Set(["_npm", STAMP_FILE]);
/** データだけが変わったときに残すもの（依存ライブラリの束。プログラム＝package-lock.json が同じなら中身も同じ） */
const KEEP_ON_DATA = new Set([...KEEP, "_node", "_observablehq"]);
/** 上に加えて npm run build が残すもの（ローダの出力。prebuild-data.ts が全部作り直し、変わったファイルだけ書き換える） */
const KEEP_OUTPUTS = new Set([...KEEP_ON_DATA, "data", MANIFEST_FILE]);

export interface PrepareResult {
  /** 何か捨てたか */
  cleared: boolean;
  /** 全部捨てたか（フルビルド） */
  full: boolean;
  /** first: 初回、code: プログラムが変わった、data: データだけ変わった、unreadable: 前回の記録が読めない、forced: 指定でフルビルド、same: 同じ */
  reason: "first" | "code" | "data" | "unreadable" | "forced" | "same";
  /** 消した *.err・一時ファイルの数 */
  removedLeftovers: number;
}

function readStamp(path: string): { hash?: unknown; codeHash?: unknown } | null | "unreadable" {
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

export function prepareLoaderCache(rootDir: string, fp: Fingerprint, opts: { full?: boolean; keepDataOutputs?: boolean } = {}): PrepareResult {
  const dir = join(rootDir, CACHE_DIR);
  const stampPath = join(dir, STAMP_FILE);
  const stamp = readStamp(stampPath);
  let reason: PrepareResult["reason"];
  if (stamp === null) reason = existsSync(dir) && readdirSync(dir).some((n) => !KEEP.has(n)) ? "unreadable" : "first";
  else if (stamp === "unreadable" || typeof stamp.codeHash !== "string") reason = "unreadable";
  else if (stamp.codeHash !== fp.codeHash) reason = "code";
  else reason = stamp.hash === fp.hash ? "same" : "data";
  if (opts.full && reason !== "first" && reason !== "unreadable" && reason !== "code") reason = "forced";

  const cleared = reason !== "same";
  const full = cleared && reason !== "data";
  const keep = !full ? (opts.keepDataOutputs ? KEEP_OUTPUTS : KEEP_ON_DATA) : KEEP;
  if (cleared && existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (keep.has(name)) continue;
      rmSync(join(dir, name), { recursive: true, force: true });
    }
  }
  const removedLeftovers = removeLeftovers(dir);
  if (cleared) {
    // 指紋は掃除が終わってから書く（掃除の途中で落ちたら、次回も「違う」と判定されてやり直す）
    rmSync(stampPath, { force: true });
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(stampPath, JSON.stringify({ hash: fp.hash, codeHash: fp.codeHash, asOf: fp.asOf, files: fp.files, at: new Date().toISOString() }, null, 2) + "\n");
  }
  return { cleared, full, reason, removedLeftovers };
}
