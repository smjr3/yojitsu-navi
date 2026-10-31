/**
 * ビルド（npm run build）: キャッシュの点検 → observable build → ビルド結果の検証
 *
 *   npm run build                                  # 計算基準日は今日（JST）
 *   YOJITSU_AS_OF=2026-10-27 npm run build         # 計算基準日を固定
 *
 * Observable Framework の `observable build` は、ローダのキャッシュが残っていれば入力（CSV など）が変わっていても
 * そのまま使う。ここで入力の指紋を取り、前回と違えばキャッシュを捨ててからビルドする（docs/DATA_LOADERS.md）。
 * 指紋と計算基準日は環境変数で全ローダに渡すので、ビルドの途中で日付が変わっても混ざらない。
 * 検証で問題が見つかったら dist/ を消して失敗する（壊れた・古いデータの dist/ を公開に回さない）。
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeFingerprint, isAsOfFixed, resolveAsOf } from "./lib/inputs.js";
import { prepareLoaderCache } from "./lib/loader-cache.js";
import { verifyDist } from "./verify-dist.js";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const OBSERVABLE = join(ROOT, "node_modules", "@observablehq", "framework", "dist", "bin", "observable.js");

function run(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [OBSERVABLE, ...args], { cwd: ROOT, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function main(): Promise<number> {
  const asOf = resolveAsOf();
  const fp = computeFingerprint(ROOT, { asOf });
  const prep = prepareLoaderCache(ROOT, fp);
  const why = { first: "初回", changed: "入力が変わった", unreadable: "前回の記録が読めない", same: "" }[prep.reason];
  console.log(
    `[build] 計算基準日 ${asOf}、入力 ${fp.files} ファイル、指紋 ${fp.hash.slice(0, 12)}… — ` +
      (prep.cleared ? `ローダのキャッシュを捨てて作り直します（${why}）` : "前回と同じ入力なのでキャッシュを使います") +
      (prep.removedLeftovers ? `。失敗・中断の残り ${prep.removedLeftovers} 件を消しました` : ""),
  );
  // 日付はローダ全体で揃えるため必ず渡す。呼び出し側が固定したか（画面で今日に置き換えるか。SPEC §75）は別に渡す
  const code = await run(["build"], { ...process.env, YOJITSU_AS_OF: asOf, YOJITSU_AS_OF_FIXED: isAsOfFixed() ? "1" : "0", YOJITSU_INPUT_HASH: fp.hash });
  if (code !== 0) {
    console.error(`[build] observable build が失敗しました（終了コード ${code}）`);
    return code;
  }
  const after = computeFingerprint(ROOT, { asOf });
  const problems = after.hash === fp.hash ? verifyDist(ROOT, fp) : ["ビルドの途中で入力ファイル（data/ など）が変わりました。もう一度ビルドしてください"];
  if (problems.length > 0) {
    console.error(`[build] ビルド結果の検証で ${problems.length} 件の問題が見つかったため dist/ を消しました:`);
    for (const p of problems) console.error(`  - ${p}`);
    rmSync(join(ROOT, "dist"), { recursive: true, force: true });
    return 1;
  }
  console.log(`[build] ビルド結果を検証しました（全出力が指紋 ${fp.hash.slice(0, 12)}… と一致）`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`[build] 失敗: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
