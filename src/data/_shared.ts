/**
 * データローダ共通: data/ を読んで Model を作る（Node 側専用。画面からは import しない）
 *
 * asOf は環境変数 YOJITSU_AS_OF（YYYY-MM-DD）、無ければ今日（JST）。
 * 固定しないビルドの asOf はビルドした日で、画面が開いた人の今日（JST）に置き換える（SPEC §74）。
 *
 * 壊れた出力を出さないための決まり（docs/DATA_LOADERS.md）:
 *   - 標準出力には成果物（JSON）だけを書く。console.log は標準エラーに回す（ログが JSON に混ざらない）
 *   - 出力は emitJson で書く。NaN・Infinity・undefined を含む値は黙って null にせず失敗させる
 *   - 失敗したら非 0 で終わる（Framework は失敗した出力をキャッシュに残さない）
 *   - 出力には入力の指紋（_build.inputHash）を入れ、ビルド後の検証（scripts/verify-dist.ts）で古い出力の混入を見つける
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModel, type Model, type ContractResult } from "../core/index.js";
import { loadDataset } from "../../scripts/lib/load.js";
import { computeFingerprint, isAsOfFixed, resolveAsOf as resolveAsOfEnv, todayJst as todayJstNow } from "../../scripts/lib/inputs.js";
import { writeFileAtomic } from "../../scripts/lib/atomic.js";
import { serializeChecked } from "../../scripts/lib/json-out.js";

export { findInvalidJsonValue, serializeChecked } from "../../scripts/lib/json-out.js";
import type { ParsedDataset } from "../core/csv.js";
import { worklogKey } from "../components/worklog-key.js";

// 計算コアや読み込み処理が console.log しても、成果物（標準出力）を汚さない
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);

export const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 今日の日付（JST）を YYYY-MM-DD で返す */
export function todayJst(): string {
  return todayJstNow();
}

export function resolveAsOf(): string {
  return resolveAsOfEnv(process.env);
}

let inputHashMemo: string | null = null;
/** 入力の指紋。scripts/build.ts が環境変数 YOJITSU_INPUT_HASH で渡す。単体実行のときはここで計算する */
export function inputHash(): string {
  if (inputHashMemo) return inputHashMemo;
  const env = process.env.YOJITSU_INPUT_HASH?.trim();
  inputHashMemo = env && /^[0-9a-f]{64}$/.test(env) ? env : computeFingerprint(ROOT_DIR, { asOf: resolveAsOf() }).hash;
  return inputHashMemo;
}

/** ローダの出力に付ける版情報（画面は読まない。検証と、ブラウザのキャッシュ避けに使う） */
export function buildStamp(): { inputHash: string; asOf: string } {
  return { inputHash: inputHash(), asOf: resolveAsOf() };
}

export function loadParsed(): ParsedDataset {
  return loadDataset(ROOT_DIR);
}

export function buildModelFromData(parsed: ParsedDataset = loadParsed()): Model {
  return buildModel(parsed.dataset, { asOf: resolveAsOf(), asOfFixed: isAsOfFixed(process.env) });
}

/** 画面用に worklogs（元の作業ログ）を落とした ContractResult */
export function stripWorklogs(r: ContractResult): ContractResult {
  return {
    ...r,
    months: r.months.map((m) => ({ ...m, worklogs: [] })),
  };
}

/** 引数 --name=value を読む（パラメータ付きローダ用） */
export function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

/** 成果物を標準出力に書いて終わる。失敗したら理由を標準エラーに出して非 0 で終わる */
export function emitJson(produce: () => unknown): void {
  emitText(() => serializeChecked(produce()));
}

/** 検査済みの JSON 文字列をそのまま出す版（作業ログ明細の作り置き用） */
export function emitText(produce: () => string): void {
  let text: string;
  try {
    text = produce();
    if (!text || text.length < 2) throw new Error("出力が空です");
  } catch (error) {
    console.error(`[loader] 失敗: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  }
  process.stdout.write(text, (error) => {
    if (error) {
      console.error(`[loader] 書き込みに失敗: ${error.message}`);
      process.exit(1);
    }
  });
}

// ---------------------------------------------------------------------------
// 作業ログ明細（契約ごと）の作り置き
//
// dynamicPaths の契約ごとのローダは契約の数だけ別プロセスで動く。毎回 Model を作り直すと
// 契約 100 件で数分かかるので、最初の 1 回で全契約分を作ってキャッシュの中に置き、2 回目以降はそれを読む。
// 置き場所は入力の指紋ごとのフォルダ（指紋が変われば別フォルダ = 古いものは使われない）で、
// 一時フォルダに全部書いてから rename するので、途中で落ちても中途半端なフォルダは使われない。
// ---------------------------------------------------------------------------

export interface WorklogDetail {
  contractId: string;
  asOf: string;
  worklogFetchedAt: string | null;
  months: Array<{ month: string; status: string; worklogs: unknown[] }>;
  notFound?: true;
  _build: { inputHash: string; asOf: string };
}

function worklogDetailOf(model: Model, contractId: string): WorklogDetail {
  const result = model.contracts.find((r) => r.contract.contractId === contractId);
  const base = { contractId, asOf: model.meta.asOf, worklogFetchedAt: model.meta.worklogFetchedAt, _build: buildStamp() };
  return result
    ? { ...base, months: result.months.map((m) => ({ month: m.month, status: m.status, worklogs: m.worklogs })) }
    : { ...base, months: [], notFound: true };
}

/** 作り置きフォルダ（src/.observablehq/cache/.yojitsu/worklogs-<指紋先頭16桁>） */
export function worklogMemoDir(rootDir: string = ROOT_DIR): string {
  return join(rootDir, "src", ".observablehq", "cache", ".yojitsu", `worklogs-${inputHash().slice(0, 16)}`);
}

/** 契約 1 件分の明細 JSON（文字列）。作り置きがあれば読み、無ければ全契約分を作ってから返す */
export function worklogDetailJson(contractId: string, rootDir: string = ROOT_DIR): string {
  const dir = worklogMemoDir(rootDir);
  const file = join(dir, `${worklogKey(contractId)}.json`);
  const complete = join(dir, ".complete");
  if (existsSync(complete)) {
    if (existsSync(file)) return readFileSync(file, "utf-8");
    // 作り置きに無い契約（contracts.csv に無い ID）: 作り置きを使わずその場で作る
    return serializeChecked(worklogDetailOf(buildModelFromData(), contractId));
  }
  const model = buildModelFromData();
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  const temp = `${dir}.tmp-${process.pid}-${Date.now().toString(16).slice(-8).padStart(8, "0")}`;
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  let own = "";
  try {
    for (const r of model.contracts) {
      const id = r.contract.contractId;
      const text = serializeChecked(worklogDetailOf(model, id));
      writeFileAtomic(join(temp, `${worklogKey(id)}.json`), text);
      if (id === contractId) own = text;
    }
    writeFileAtomic(join(temp, ".complete"), "ok\n");
    try {
      renameSync(temp, dir);
    } catch {
      // 同時に別のプロセスが作り終えていた（同じ指紋なので中身は同じ）。こちらは捨てる
      rmSync(temp, { recursive: true, force: true });
    }
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
  return own || serializeChecked(worklogDetailOf(model, contractId));
}
