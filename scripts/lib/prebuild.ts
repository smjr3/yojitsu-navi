/**
 * 増分ビルドの本体（Node 側専用。scripts/prebuild-data.ts が別プロセスで呼ぶ。SPEC §102）
 *
 * Framework に任せると、ローダは出力 1 つにつき 1 プロセスで動き、集計のローダはそれぞれデータの読み込みと Model の計算をやり直す
 * （契約ごとの作業ログ明細は契約の数だけプロセスが立つ）。ここでは:
 *   1. データの読み込みと Model の計算を 1 回だけして、全ローダの出力（集計と契約ごとの明細）を作る（src/data/_outputs.ts）
 *   2. Framework のキャッシュ（src/.observablehq/cache/data/）と中身を比べ、変わったファイルだけを書き換える
 *      （同じ中身のファイルは触らない。明細には入力の指紋を入れないので、データのほかの所が変わっても書き換わらない）
 *   3. 作るべき出力に無いファイル（消えた契約の明細・失敗の記録など）を消す
 *   4. 各出力のハッシュを記録（.yojitsu-outputs.json）に書く。scripts/verify-dist.ts が dist/ と突き合わせる
 * キャッシュに出力があるので、続く `observable build` はローダを動かさずにそれを使う。
 * 記録は最初に消して最後に書くので、途中で失敗したら次のビルドは必ず作り直す
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { worklogKey } from "../../src/components/worklog-key.js";
import { AGGREGATE_OUTPUTS, createContext, worklogDetailOf } from "../../src/data/_outputs.js";
import { useInputHash } from "../../src/data/_shared.js";
import { serializeChecked } from "./json-out.js";
import { writeFileAtomic } from "./atomic.js";
import { CACHE_DIR, MANIFEST_FILE } from "./loader-cache.js";

export const MANIFEST_VERSION = 1;

export interface OutputManifest {
  version: number;
  /** 作ったときの入力の指紋 */
  hash: string;
  codeHash: string;
  asOf: string;
  /** キャッシュの中のパス（data/model.json・data/worklogs/C001.json）→ 中身の sha256 */
  outputs: Record<string, string>;
  stats: PrebuildStats;
}

export interface PrebuildStats {
  /** 集計の出力の数 */
  aggregates: number;
  /** 契約ごとの明細の数 */
  details: number;
  /** 中身が変わって書き換えた数（集計＋明細） */
  written: number;
  /** 明細のうち書き換えた数 */
  detailsWritten: number;
  /** 前回と同じ中身で触らなかった数 */
  unchanged: number;
  /** 消したファイルの数 */
  removed: number;
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const posix = (p: string) => p.split(sep).join("/");

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

export function manifestPath(rootDir: string): string {
  return join(rootDir, CACHE_DIR, MANIFEST_FILE);
}

/** 記録を読む。無い・壊れているなら null */
export function readManifest(rootDir: string): OutputManifest | null {
  try {
    const v = JSON.parse(readFileSync(manifestPath(rootDir), "utf-8"));
    return v && v.version === MANIFEST_VERSION && typeof v.hash === "string" && v.outputs && typeof v.outputs === "object" ? (v as OutputManifest) : null;
  } catch {
    return null;
  }
}

/**
 * 全ローダの出力を作り、変わったものだけキャッシュに書く。
 * 指紋・計算基準日は呼び出し側（scripts/build.ts）が環境変数で渡したものを使う（ローダと同じ）
 */
export function prebuildOutputs(rootDir: string, fp: { hash: string; codeHash: string; asOf: string }): OutputManifest {
  const cacheDir = join(rootDir, CACHE_DIR);
  rmSync(manifestPath(rootDir), { force: true });

  // 出力に入れる指紋・計算基準日を、渡されたものにそろえる（ローダが環境変数から読むのと同じ値）
  const savedAsOf = process.env.YOJITSU_AS_OF;
  process.env.YOJITSU_AS_OF = fp.asOf;
  useInputHash(fp.hash);
  const texts = new Map<string, string>();
  try {
    const ctx = createContext(rootDir);
    for (const [name, produce] of Object.entries(AGGREGATE_OUTPUTS)) texts.set(`data/${name}.json`, serializeChecked(produce(ctx)));
    const model = ctx.model();
    for (const r of model.contracts) {
      const id = r.contract.contractId;
      texts.set(`data/worklogs/${worklogKey(id)}.json`, serializeChecked(worklogDetailOf(model, id)));
    }
  } finally {
    useInputHash(null);
    if (savedAsOf === undefined) delete process.env.YOJITSU_AS_OF;
    else process.env.YOJITSU_AS_OF = savedAsOf;
  }

  const stats: PrebuildStats = { aggregates: Object.keys(AGGREGATE_OUTPUTS).length, details: texts.size - Object.keys(AGGREGATE_OUTPUTS).length, written: 0, detailsWritten: 0, unchanged: 0, removed: 0 };
  const outputs: Record<string, string> = {};
  for (const [rel, text] of texts) {
    if (!text || text.length < 2) throw new Error(`${rel} の出力が空です`);
    const hash = sha256(text);
    outputs[rel] = hash;
    const abs = join(cacheDir, ...rel.split("/"));
    let same = false;
    try {
      same = sha256(readFileSync(abs)) === hash;
    } catch {
      same = false;
    }
    if (same) {
      stats.unchanged++;
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileAtomic(abs, text);
    stats.written++;
    if (rel.startsWith("data/worklogs/")) stats.detailsWritten++;
  }
  // 作るべき出力に無いもの（消えた契約の明細・ローダの失敗の記録・書きかけ）を消す。
  // 記録に無いローダの出力も消すので、ここで作っていないローダ（足したばかりのもの）は Framework が動かして作り直す
  for (const abs of listFiles(join(cacheDir, "data"))) {
    const rel = posix(relative(cacheDir, abs));
    if (texts.has(rel)) continue;
    rmSync(abs, { force: true });
    stats.removed++;
  }

  const manifest: OutputManifest = { version: MANIFEST_VERSION, hash: fp.hash, codeHash: fp.codeHash, asOf: fp.asOf, outputs, stats };
  mkdirSync(cacheDir, { recursive: true });
  writeFileAtomic(manifestPath(rootDir), `${JSON.stringify(manifest)}\n`);
  return manifest;
}
