/**
 * 承認済みでまだ公開されていないマスタ・計画を、編集画面で先に出す（SPEC §149）
 *
 * 承認（マージ）してから CI が画面を作り直して公開するまで数分かかる。そのあいだもリソース計画・マスタ編集では
 * 既定ブランチの今の中身を土台にする（承認した計画がすぐ見え、続けて直しても古い土台との競合にならない）。
 * - 既定ブランチの先頭がこのビルドのコミットと同じなら、問い合わせは 1 回で終わる（ふだんはこれだけ）
 * - 違えば、ファイルごとに最後に変えたコミットを比べ、変わったファイルだけ中身を読む
 * - 読めない・分からない（トークンなし・浅いクローンでコミット ID が無い・通信の失敗）ときは何も変えない（ビルドの中身のまま）
 */
import type { FetchLike } from "./gitlab.js";
import type { MasterEditConfig } from "./types.js";
import { fetchBranchHead, fetchFileForUpdate, fetchLastCommitForPath } from "./gitlab.js";

export interface LatestFileInput {
  id: string;
  /** リポジトリ内のパス */
  path: string;
  /** このビルドの中身 */
  text: string;
  /** このビルドでそのファイルを最後に変えたコミット（無ければ比べられないので読まない） */
  lastCommitId: string | null;
  /** リポジトリにあるか（無いファイルは読まない） */
  exists?: boolean;
}

export interface LatestMasters {
  /** 既定ブランチの先頭のコミット */
  head: string;
  /** ビルドより新しくなったファイル（id → 既定ブランチの中身と最終コミット）。中身が同じでもコミットが変われば入る（保存の土台を新しくするため） */
  files: Record<string, { text: string; lastCommitId: string | null }>;
}

/**
 * 既定ブランチの今の中身のうち、このビルドと違うもの。変わっていなければ files は空。
 * builtHead が無い（git が無い・浅いクローン）ときは null（比べられない）
 */
export async function fetchLatestMasters(
  fetchImpl: FetchLike,
  cfg: MasterEditConfig,
  token: string,
  builtHead: string | null,
  inputs: readonly LatestFileInput[],
  /** 最終コミットの分からないファイルも比べる（デモの模擬だけ。本物は浅いクローンでどれも分からないので比べない） */
  opts: { includeUnknown?: boolean } = {},
): Promise<LatestMasters | null> {
  if (!builtHead) return null;
  const branch = cfg.gitlab.targetBranch;
  const head = await fetchBranchHead(fetchImpl, cfg, token, branch);
  if (!head) return null;
  if (head === builtHead) return { head, files: {} };
  const targets = inputs.filter((f) => (f.lastCommitId || opts.includeUnknown) && f.exists !== false);
  const found = await Promise.all(
    targets.map(async (f) => {
      // 調べているあいだに次の承認が入っても、先頭（head）時点の中身で比べてそろえる
      const last = await fetchLastCommitForPath(fetchImpl, cfg, token, f.path, head);
      if (!last || last === f.lastCommitId) return null;
      const latest = await fetchFileForUpdate(fetchImpl, cfg, token, f.path, head);
      return latest ? ([f.id, { text: latest.text, lastCommitId: latest.lastCommitId ?? last }] as const) : null;
    }),
  );
  return { head, files: Object.fromEntries(found.filter((x) => x !== null)) };
}
