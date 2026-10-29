/**
 * マスタ編集画面（SPEC §19）の土台: 4 ファイルの生テキストと最終コミット ID（Node 側専用）
 *
 * - 生テキストは文字コードを自動判定してデコードしたもの（BOM は除く）。画面はこれを土台に編集し、
 *   書き出しは UTF-8（BOM なし）・LF に固定する。元が Shift_JIS / BOM 付き / CRLF なら画面で注記する
 * - 最終コミット ID は `git log -1 --format=%H -- <path>`。git が無い・浅いクローン・未コミットなら null
 *   （浅いクローンでは履歴の境界のコミットを誤って返すため使わない。GitLab CI では GIT_DEPTH: 0 を推奨）
 * - 検証（parseDataset + validateDataset）に使う contracts / mapping / holidays の生テキストも渡す
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeAuto, type DetectedEncoding } from "../../scripts/lib/encoding.js";
import { DATA_FILES, loadConfig } from "../../scripts/lib/load.js";
import { MASTER_FILES, MASTER_FILE_IDS, emptyMasterText, type MasterFileId } from "../core/masterEdit.js";
import { resolveMasterEdit } from "../core/gitlab.js";
import { withGitLabEnv } from "../components/gitlab-env.js";
import type { MasterEditConfig } from "../core/types.js";

export interface MasterFilePayload {
  /** プロジェクトルートからのパス（data/masters/members.csv） */
  path: string;
  /** GitLab のリポジトリ内のパス（プロジェクトがリポジトリのサブフォルダにある場合はその分の接頭辞付き） */
  repoPath: string;
  text: string;
  lastCommitId: string | null;
  exists: boolean;
  encoding: DetectedEncoding | null;
  /** 元の改行コード（CRLF が 1 つでもあれば "crlf"） */
  lineEnding: "lf" | "crlf";
}

export interface MastersPayload {
  files: Record<MasterFileId, MasterFilePayload>;
  context: { contracts: string; mapping: string; holidays: string };
  masterEdit: MasterEditConfig;
  /** memberSource.adapter（§20.2。config に無ければ "none"） */
  memberSourceAdapter: string;
  /** 最終コミット ID を取れたか（false なら競合の検出ができない） */
  gitAvailable: boolean;
}

function git(rootDir: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: rootDir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function readText(path: string): { text: string; encoding: DetectedEncoding | null; exists: boolean; crlf: boolean } {
  if (!existsSync(path)) return { text: "", encoding: null, exists: false, crlf: false };
  const d = decodeAuto(readFileSync(path));
  return { text: d.text, encoding: d.encoding, exists: true, crlf: d.text.includes("\r\n") };
}

export function buildMastersPayload(rootDir: string): MastersPayload {
  const config = loadConfig(rootDir);
  const inRepo = git(rootDir, ["rev-parse", "--is-inside-work-tree"]) === "true";
  const shallow = inRepo && git(rootDir, ["rev-parse", "--is-shallow-repository"]) === "true";
  const prefix = inRepo ? (git(rootDir, ["rev-parse", "--show-prefix"]) ?? "") : "";
  const files = {} as Record<MasterFileId, MasterFilePayload>;
  for (const id of MASTER_FILE_IDS) {
    const path = MASTER_FILES[id].path;
    const r = readText(join(rootDir, path));
    let lastCommitId: string | null = null;
    if (inRepo && !shallow && r.exists) {
      const h = git(rootDir, ["log", "-1", "--format=%H", "--", path]);
      lastCommitId = h && /^[0-9a-f]{40}$/.test(h) ? h : null;
    }
    // 省略可のファイル（§36）が無ければ見出しだけの空のファイルを土台にする（保存すると新しく作る）
    const text = !r.exists && MASTER_FILES[id].optional ? emptyMasterText(id) : r.text;
    files[id] = { path, repoPath: `${prefix}${path}`, text, lastCommitId, exists: r.exists, encoding: r.encoding, lineEnding: r.crlf ? "crlf" : "lf" };
  }
  const ctx = (p: string) => readText(join(rootDir, p)).text;
  const adapter = config.memberSource?.adapter;
  return {
    files,
    context: { contracts: ctx(DATA_FILES.contracts), mapping: ctx(DATA_FILES.mapping), holidays: ctx(DATA_FILES.holidays) },
    // 接続先が空なら GitLab CI の値（YOJITSU_GITLAB_*）で補う（§38.1）
    masterEdit: resolveMasterEdit(withGitLabEnv(config.masterEdit, process.env) as MasterEditConfig | undefined),
    memberSourceAdapter: adapter ?? "none",
    gitAvailable: inRepo && !shallow,
  };
}
