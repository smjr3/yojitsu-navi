/**
 * 実行環境の差（Windows の Runner・遅い PC）を吸収するテストの設定（SPEC §79.1）。
 * vitest.config.ts と各テストが同じ値を使う。
 *
 * - YOJITSU_TEST_TIMEOUT_SCALE: タイムアウトの倍率。既定は Windows で 3、それ以外は 1
 *   （Windows はプロセスの起動・ファイルの読み書きが遅く、ウイルス対策の検査も入るため）
 * - YOJITSU_PERF: 性能テストの判定。
 *     loose（既定）… 目安の YOJITSU_PERF_FACTOR 倍（既定 3）を超えたら失敗。超えたら 3 回まで測り直して最も速い値で判定
 *     strict       … 目安そのもので判定（性能を見るための専用の PC・Runner で使う）
 *     report       … 判定しない。かかった時間を表示するだけ（CI の Runner の性能がばらつくとき）
 */
import { spawn, type SpawnOptions } from "node:child_process";

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
};

export const TIMEOUT_SCALE = num(process.env.YOJITSU_TEST_TIMEOUT_SCALE, process.platform === "win32" ? 3 : 1);

/**
 * 同時に動かすワーカーの数の既定（vitest.config.ts の poolOptions）。Windows は 2（並列が多いとワーカーの通信がタイムアウトする）。
 * VITEST_MAX_FORKS を設定していればそれに任せる（Vitest が読む）。それ以外の OS は Vitest の既定（CPU の数 - 1）
 */
export function defaultForks(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { forks: { maxForks: number } } | undefined {
  if (platform !== "win32" || (env.VITEST_MAX_FORKS ?? "") !== "") return undefined;
  return { forks: { maxForks: 2 } };
}

/** タイムアウト（ミリ秒）に倍率を掛ける */
export const scaled = (ms: number): number => Math.round(ms * TIMEOUT_SCALE);

export type PerfMode = "loose" | "strict" | "report";

export function perfMode(env: NodeJS.ProcessEnv = process.env): PerfMode {
  const m = (env.YOJITSU_PERF ?? "").trim().toLowerCase();
  return m === "strict" || m === "report" ? m : "loose";
}

/** 判定に使う上限（ミリ秒）。report は上限なし */
export function perfLimit(budgetMs: number, env: NodeJS.ProcessEnv = process.env): number {
  const mode = perfMode(env);
  if (mode === "report") return Number.POSITIVE_INFINITY;
  return mode === "strict" ? budgetMs : budgetMs * num(env.YOJITSU_PERF_FACTOR, 3);
}

/**
 * run の時間を測り、目安（budgetMs）に収まるかを確かめて run の戻り値を返す。
 * 上限を超えたら tries 回まで測り直し、最も速い値で判定する（ほかのテストと同時に動いたときの揺れを除く）。
 */
export function measure<T>(label: string, budgetMs: number, run: () => T, tries = 3): T {
  const limit = perfLimit(budgetMs);
  let best = Number.POSITIVE_INFINITY;
  let result!: T;
  for (let i = 0; i < tries; i++) {
    const start = performance.now();
    result = run();
    best = Math.min(best, performance.now() - start);
    if (best < limit) break;
  }
  if (perfMode() === "report" || best >= budgetMs) {
    console.info(`[性能] ${label}: ${Math.round(best)}ms（目安 ${budgetMs}ms・判定 ${perfMode()}）`);
  }
  if (best >= limit) {
    throw new Error(`[性能] ${label}: ${Math.round(best)}ms かかりました（上限 ${Math.round(limit)}ms = 目安 ${budgetMs}ms・判定 ${perfMode()}）`);
  }
  return result;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * 別プロセスを動かして終わるのを待つ（spawnSync の代わり）。
 * spawnSync・execFileSync で数十秒止めると、その間 Vitest のワーカーが本体と通信できず、
 * 遅い環境（Windows）では「[vitest-worker]: Timeout calling …」で落ちる。待つ間もワーカーを止めないためにこちらを使う。
 */
export function runAsync(cmd: string, args: string[], options: SpawnOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on("data", (b: Buffer) => out.push(b));
    child.stderr!.on("data", (b: Buffer) => err.push(b));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout: Buffer.concat(out).toString("utf-8"), stderr: Buffer.concat(err).toString("utf-8") }));
  });
}

/** runAsync して、0 以外で終わったら標準エラーを添えて失敗させる */
export async function runOk(cmd: string, args: string[], options: SpawnOptions = {}): Promise<string> {
  const r = await runAsync(cmd, args, options);
  if (r.status !== 0) throw new Error(`${[cmd, ...args].join(" ")} が ${r.status} で終わりました\n${r.stderr}`);
  return r.stdout;
}
