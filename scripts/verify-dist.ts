/**
 * ビルド結果（dist/）の検証。scripts/build.ts がビルドの直後に呼ぶ（単体でも実行できる）
 *
 *   npx tsx scripts/verify-dist.ts            # 今の data/ と計算基準日で検証
 *
 * 見ること（どれか 1 つでも外れたらビルド失敗。壊れた・古いデータのまま公開しない）:
 *   - ローダの出力（dist/_file/data/*.json、dist/data/worklogs/*.json）がすべて JSON として読める
 *   - 集計の出力の _build.inputHash が今の入力の指紋と一致する（古いキャッシュの混入がない）
 *   - ローダの出力の記録（.yojitsu-outputs.json。scripts/lib/prebuild.ts）が今の指紋のもので、全出力の中身のハッシュが記録と一致する
 *     （作業ログ明細は増分ビルドで変わらなければ書き換えないので、指紋を持たない。古い明細の混入はこちらで見つける。SPEC §102）
 *   - 計算基準日がすべて同じ（ビルドが日付をまたいでも混ざらない）
 *   - 必須の出力（model / member-months / masters / dataset-issues）がちょうど 1 つずつある
 *   - 契約の件数が contracts.csv と一致し、契約ごとの作業ログ明細が過不足なくある
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { computeFingerprint, resolveAsOf, type Fingerprint } from "./lib/inputs.js";
import { loadDataset } from "./lib/load.js";
import { worklogKey } from "../src/components/worklog-key.js";
import { createHash } from "node:crypto";
import { readManifest, type OutputManifest } from "./lib/prebuild.js";

/** ページが必ず読むローダの出力（dist/_file/data/<name>.<hash>.json） */
export const REQUIRED_OUTPUTS = ["model", "member-months", "masters", "dataset-issues", "daily"] as const;

interface Stamped {
  _build?: { inputHash?: unknown; asOf?: unknown };
}

function listJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listJson(p));
    else if (name.endsWith(".json")) out.push(p);
  }
  return out;
}

/**
 * @param manifest ローダの出力の記録。省略するとキャッシュ（src/.observablehq/cache/.yojitsu-outputs.json）から読む。null は「記録なし」
 */
export function verifyDist(rootDir: string, fp: Fingerprint, distDir: string = join(rootDir, "dist"), manifest: OutputManifest | null = readManifest(rootDir)): string[] {
  const problems: string[] = [];
  const rel = (p: string) => relative(rootDir, p);
  if (!manifest) problems.push("ローダの出力の記録（src/.observablehq/cache/.yojitsu-outputs.json）がありません。npm run build でビルドしてください");
  else if (manifest.hash !== fp.hash) problems.push(`ローダの出力の記録は別の入力のものです（指紋 ${manifest.hash.slice(0, 12)}… ≠ 今 ${fp.hash.slice(0, 12)}…）`);
  const outputs = manifest && manifest.hash === fp.hash ? manifest.outputs : null;
  /** dist の中身が記録のハッシュと同じか（key はキャッシュの中のパス data/model.json など） */
  const checkRecorded = (p: string, key: string) => {
    if (!outputs) return;
    const want = outputs[key];
    if (!want) return problems.push(`${rel(p)} はローダの出力の記録にありません（記録の後に作られた・古い出力の可能性）`);
    let got = "";
    try {
      got = createHash("sha256").update(readFileSync(p)).digest("hex");
    } catch {
      return;
    }
    if (got !== want) problems.push(`${rel(p)} の中身がローダの出力の記録と違います（古いキャッシュが混ざっています）`);
  };
  if (!existsSync(join(distDir, "index.html"))) problems.push(`${rel(join(distDir, "index.html"))} がありません`);

  const parsed = new Map<string, unknown>();
  const read = (p: string): unknown => {
    if (parsed.has(p)) return parsed.get(p);
    let v: unknown = undefined;
    try {
      const text = readFileSync(p, "utf-8");
      if (text.trim() === "") problems.push(`${rel(p)} が空です`);
      else v = JSON.parse(text);
    } catch (e) {
      problems.push(`${rel(p)} を JSON として読めません: ${e instanceof Error ? e.message : String(e)}`);
    }
    parsed.set(p, v);
    return v;
  };
  const checkStamp = (p: string, v: unknown, needHash = true) => {
    const b = (v as Stamped | null)?._build;
    if (!b) return problems.push(`${rel(p)} に入力の指紋（_build）がありません（古いローダの出力の可能性）`);
    if ((needHash || b.inputHash !== undefined) && b.inputHash !== fp.hash) problems.push(`${rel(p)} は別の入力から作られています（指紋 ${String(b.inputHash).slice(0, 12)}… ≠ 今 ${fp.hash.slice(0, 12)}…）。古いキャッシュが混ざっています`);
    if (b.asOf !== fp.asOf) problems.push(`${rel(p)} の計算基準日 ${String(b.asOf)} が今回の ${fp.asOf} と違います`);
  };

  // ローダの出力（ページから FileAttachment で読むもの）
  const fileDir = join(distDir, "_file", "data");
  const files = listJson(fileDir).filter((p) => !p.startsWith(join(fileDir, "worklogs")));
  for (const p of files) {
    const v = read(p);
    if (v !== undefined) checkStamp(p, v);
    // dist/_file/data/model.<ハッシュ8桁>.json ← キャッシュの data/model.json
    const m = /^(.+)\.[0-9a-f]{8}\.json$/.exec(basename(p));
    if (m && outputs && `data/${m[1]}.json` in outputs) checkRecorded(p, `data/${m[1]}.json`);
  }
  for (const name of REQUIRED_OUTPUTS) {
    const hits = files.filter((p) => new RegExp(`^${name}\\.[0-9a-f]{8}\\.json$`).test(p.slice(fileDir.length + 1)));
    if (hits.length === 0) problems.push(`dist/_file/data/${name}.<hash>.json がありません（ページから読まれていない、またはローダが失敗）`);
    if (hits.length > 1) problems.push(`dist/_file/data/${name}.*.json が ${hits.length} 個あります（古い出力が混ざっています）`);
  }

  // 契約の件数と作業ログ明細
  const { dataset } = loadDataset(rootDir);
  const ids = [...new Set(dataset.contracts.map((c) => c.contractId))];
  const modelPath = files.find((p) => /^model\.[0-9a-f]{8}\.json$/.test(basename(p)));
  if (modelPath) {
    const model = read(modelPath) as { contracts?: unknown[]; meta?: { asOf?: unknown } } | undefined;
    if (model) {
      if (!Array.isArray(model.contracts)) problems.push(`${rel(modelPath)} に contracts がありません`);
      else if (model.contracts.length !== ids.length) problems.push(`${rel(modelPath)} の契約が ${model.contracts.length} 件ですが contracts.csv は ${ids.length} 件です`);
      if (model.meta?.asOf !== fp.asOf) problems.push(`${rel(modelPath)} の meta.asOf ${String(model.meta?.asOf)} が今回の ${fp.asOf} と違います`);
    }
  }
  const wlDir = join(distDir, "data", "worklogs");
  const expected = new Map(ids.map((id) => [`${worklogKey(id)}.json`, id]));
  const actual = existsSync(wlDir) ? readdirSync(wlDir).filter((n) => n.endsWith(".json")) : [];
  for (const [name, id] of expected) {
    if (!actual.includes(name)) {
      problems.push(`契約 ${id} の作業ログ明細 dist/data/worklogs/${name} がありません`);
      continue;
    }
    const p = join(wlDir, name);
    const v = read(p) as { contractId?: unknown; notFound?: unknown } | undefined;
    if (v === undefined) continue;
    checkStamp(p, v, false);
    checkRecorded(p, `data/worklogs/${name}`);
    if (v.contractId !== id) problems.push(`${rel(p)} の contractId が ${String(v.contractId)} です（${id} のはず）`);
    if (v.notFound) problems.push(`${rel(p)} は契約 ${id} を見つけられませんでした`);
  }
  for (const name of actual) if (!expected.has(name)) problems.push(`dist/data/worklogs/${name} は contracts.csv に無い契約の明細です`);
  // ヘッダー右上の「今月の残り」（§113）。全ページの head のスクリプトが固定のパスで読む
  const myMonth = join(distDir, "data", "my-month.json");
  if (!existsSync(myMonth)) problems.push("dist/data/my-month.json がありません（observablehq.config.js の dynamicPaths）");
  else {
    const v = read(myMonth);
    if (v !== undefined) {
      checkStamp(myMonth, v, true);
      checkRecorded(myMonth, "data/my-month.json");
    }
  }
  return problems;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = join(fileURLToPath(import.meta.url), "..", "..");
  const fp = computeFingerprint(root, { asOf: resolveAsOf() });
  const problems = verifyDist(root, fp);
  if (problems.length > 0) {
    console.error(`ビルド結果の検証で ${problems.length} 件の問題:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`ビルド結果を検証しました（指紋 ${fp.hash.slice(0, 12)}…、計算基準日 ${fp.asOf}）`);
}
