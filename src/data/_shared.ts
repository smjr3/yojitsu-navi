/**
 * データローダ共通: data/ を読んで Model を作る（Node 側専用。画面からは import しない）
 *
 * asOf は環境変数 YOJITSU_AS_OF（YYYY-MM-DD）、無ければ今日（JST）。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModel, type Model, type ContractResult } from "../core/index.js";
import { loadDataset } from "../../scripts/lib/load.js";
import type { ParsedDataset } from "../core/csv.js";

export const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 今日の日付（JST）を YYYY-MM-DD で返す */
export function todayJst(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

export function resolveAsOf(): string {
  const env = process.env.YOJITSU_AS_OF?.trim();
  return env && /^\d{4}-\d{2}-\d{2}$/.test(env) ? env : todayJst();
}

export function loadParsed(): ParsedDataset {
  return loadDataset(ROOT_DIR);
}

export function buildModelFromData(parsed: ParsedDataset = loadParsed()): Model {
  return buildModel(parsed.dataset, { asOf: resolveAsOf() });
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
