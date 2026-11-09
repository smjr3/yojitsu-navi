/**
 * ビルド（npm run build）: キャッシュの点検 → observable build → ビルド結果の検証
 *
 *   npm run build                                  # 計算基準日は今日（JST）
 *   YOJITSU_AS_OF=2026-10-27 npm run build         # 計算基準日を固定
 *
 *   YOJITSU_FULL_BUILD=1 npm run build             # キャッシュを使わずに全部作り直す
 *
 * Observable Framework の `observable build` は、ローダのキャッシュが残っていれば入力（CSV など）が変わっていても
 * そのまま使う。ここで入力の指紋を取り、プログラムが変わっていればキャッシュを全部捨て（フルビルド）、
 * データだけが変わっていれば依存ライブラリの束を残す（増分ビルド）。続けてローダの出力を 1 つのプロセスでまとめて作り、
 * 変わったファイルだけをキャッシュに書く（scripts/prebuild-data.ts。docs/DATA_LOADERS.md、SPEC §102）。
 * 指紋と計算基準日は環境変数で全ローダに渡すので、ビルドの途中で日付が変わっても混ざらない。
 * 検証で問題が見つかったら、キャッシュを使っていれば 1 回だけフルビルドでやり直し、それでも駄目なら dist/ を消して失敗する
 * （壊れた・古いデータの dist/ を公開に回さない）。
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeFingerprint, isAsOfFixed, resolveAsOf } from "./lib/inputs.js";
import { prepareLoaderCache } from "./lib/loader-cache.js";
import { readManifest, type PrebuildStats } from "./lib/prebuild.js";
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

interface Attempt {
  code: number;
  /** 検証の問題（空なら成功） */
  problems: string[];
  /** キャッシュを全部捨ててから作ったか */
  full: boolean;
}

/** 前処理（scripts/prebuild-data.ts）を別プロセスで動かし、件数を返す */
function prebuild(env: NodeJS.ProcessEnv): Promise<PrebuildStats | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "prebuild-data.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (d: string) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return resolve(null);
      try {
        resolve(JSON.parse(out.trim().split("\n").pop() ?? "") as PrebuildStats);
      } catch {
        resolve(null);
      }
    });
  });
}

async function attempt(asOf: string, forceFull: boolean): Promise<Attempt> {
  const fp = computeFingerprint(ROOT, { asOf });
  const prep = prepareLoaderCache(ROOT, fp, { full: forceFull, keepDataOutputs: true });
  const why = { first: "初回", code: "プログラムが変わった", unreadable: "前回の記録が読めない", forced: "フルビルドの指定", data: "", same: "" }[prep.reason];
  const kind = prep.full ? `フルビルド（${why}。キャッシュを捨てて作り直します）` : prep.reason === "data" ? "増分ビルド（データだけが変わった。変わった出力だけ作り直します）" : "入力が前回と同じ";
  console.log(
    `[build] 計算基準日 ${asOf}、入力 ${fp.files} ファイル、指紋 ${fp.hash.slice(0, 12)}… — ${kind}` + (prep.removedLeftovers ? `。失敗・中断の残り ${prep.removedLeftovers} 件を消しました` : ""),
  );
  // 日付はローダ全体で揃えるため必ず渡す。呼び出し側が固定したか（画面で今日に置き換えるか。SPEC §75）は別に渡す
  const env = { ...process.env, YOJITSU_AS_OF: asOf, YOJITSU_AS_OF_FIXED: isAsOfFixed() ? "1" : "0", YOJITSU_INPUT_HASH: fp.hash, YOJITSU_CODE_HASH: fp.codeHash };
  // ローダの出力は 1 つのプロセスでまとめて作る（SPEC §102）。前回の記録が今の指紋のものなら作り直さない
  const manifest = readManifest(ROOT);
  if (manifest?.hash === fp.hash) console.log(`[build] ローダの出力は前回のものを使います（${Object.keys(manifest.outputs).length} 件）`);
  else {
    const started = Date.now();
    const stats = await prebuild(env);
    if (!stats) {
      console.error("[build] ローダの出力を作れませんでした（上のエラーを見てください）");
      return { code: 1, problems: [], full: prep.full };
    }
    console.log(
      `[build] ローダの出力を作りました（${((Date.now() - started) / 1000).toFixed(1)} 秒）: 集計 ${stats.aggregates} 件、作業ログ明細 ${stats.details} 件のうち ${stats.detailsWritten} 件を更新` +
        `（同じ中身で触らなかったもの ${stats.unchanged} 件${stats.removed ? `、消したもの ${stats.removed} 件` : ""}）`,
    );
  }
  const code = await run(["build"], env);
  if (code !== 0) {
    console.error(`[build] observable build が失敗しました（終了コード ${code}）`);
    return { code, problems: [], full: prep.full };
  }
  const after = computeFingerprint(ROOT, { asOf });
  const problems = after.hash === fp.hash ? verifyDist(ROOT, fp) : ["ビルドの途中で入力ファイル（data/ など）が変わりました。もう一度ビルドしてください"];
  if (problems.length === 0) console.log(`[build] ビルド結果を検証しました（全出力が指紋 ${fp.hash.slice(0, 12)}… の入力から作られたもの）`);
  return { code: problems.length ? 1 : 0, problems, full: prep.full };
}

async function main(): Promise<number> {
  const asOf = resolveAsOf();
  // YOJITSU_FULL_BUILD=1 でキャッシュを使わずに作る（CI/CD 変数・Run pipeline でも渡せる）
  const forceFull = process.env.YOJITSU_FULL_BUILD?.trim() === "1";
  let r = await attempt(asOf, forceFull);
  // キャッシュを使ったビルドが検証で落ちたら、キャッシュが壊れていた（CI のキャッシュの戻し損ねなど）とみなし、1 回だけ全部作り直す
  if (r.code !== 0 && r.problems.length > 0 && !r.full) {
    console.error(`[build] ビルド結果の検証で ${r.problems.length} 件の問題が見つかりました。キャッシュを捨ててフルビルドでやり直します:`);
    for (const p of r.problems.slice(0, 10)) console.error(`  - ${p}`);
    r = await attempt(asOf, true);
  }
  if (r.problems.length > 0) {
    console.error(`[build] ビルド結果の検証で ${r.problems.length} 件の問題が見つかったため dist/ を消しました:`);
    for (const p of r.problems) console.error(`  - ${p}`);
    rmSync(join(ROOT, "dist"), { recursive: true, force: true });
  }
  return r.code;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`[build] 失敗: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
