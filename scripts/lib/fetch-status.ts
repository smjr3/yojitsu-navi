/**
 * 取り込みの失敗の記録（Node 側専用。SPEC §87）
 *
 * 取り込み（作業実績・人事）が途中で失敗したときは、既存の CSV を書き換えずに失敗だけを記録する。
 * 記録はデータ確認画面の「データの検証」に警告として出る（scripts/lib/load.ts → parseDataset）。次に成功すると消える。
 *
 *   作業実績: data/worklogs/_meta.json の lastFailure（fetchedAt は前回成功のまま）
 *   人事    : data/masters/_members-meta.json の lastFailure
 *
 * メッセージは長さを切り、トークンを伏せてから書く（リポジトリに残るため）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FetchFailure } from "../../src/core/types.js";
import { writeFileAtomic } from "./atomic.js";

/** 人事の取り込みの記録 */
export const MEMBERS_META = "data/masters/_members-meta.json";

const MAX_MESSAGE = 300;

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 記録に書けるメッセージ（秘密を伏せ、改行をまとめ、長さを切る） */
export function safeMessage(message: string, secrets: Array<string | undefined>): string {
  let out = message;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join("***");
    const enc = encodeURIComponent(s);
    if (enc !== s) out = out.split(enc).join("***");
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE)}…` : out;
}

/** meta ファイルの lastFailure を読む（無ければ null） */
export function readFailure(path: string, source: FetchFailure["source"]): FetchFailure | null {
  const f = readJson(path).lastFailure;
  if (f === null || typeof f !== "object") return null;
  const { at, message } = f as Record<string, unknown>;
  if (typeof at !== "string" || typeof message !== "string") return null;
  return { source, at, message };
}

/** lastFailure を書く（他のキーは残す） */
export function writeFailure(path: string, at: string, message: string, extra: Record<string, unknown> = {}): void {
  const meta = { ...readJson(path), lastFailure: { at, message, ...extra } };
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(meta, null, 2) + "\n");
}

/** lastFailure を消す。他のキーが無ければファイルごと消す。消したら true */
export function clearFailure(path: string): boolean {
  const meta = readJson(path);
  if (!("lastFailure" in meta)) return false;
  delete meta.lastFailure;
  if (Object.keys(meta).length === 0) rmSync(path, { force: true });
  else writeFileAtomic(path, JSON.stringify(meta, null, 2) + "\n");
  return true;
}

/** 作業実績と人事の失敗の記録をまとめて読む（データ確認画面用） */
export function readFetchFailures(rootDir: string, worklogMetaPath: string): FetchFailure[] {
  const out: FetchFailure[] = [];
  const w = readFailure(worklogMetaPath, "worklogs");
  if (w) out.push(w);
  const m = readFailure(join(rootDir, MEMBERS_META), "members");
  if (m) out.push(m);
  return out;
}
