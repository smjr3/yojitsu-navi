/**
 * 「競合あり」のマージリクエストを最新に載せ直す（SPEC §120）
 *
 * MR の変更（土台 base_sha → head_sha）を行の差分にし、本体（targetBranch）の今の中身に行単位で当て直す。
 * 当て直しの規則は下書きの当て直し（§19.2 rebaseDraftFile）と同じ。同じ行を両方が変えたときだけ人が選ぶ。
 * 当て直した内容で新しい MR を作り（本体の今の last_commit_id を付ける）、元の MR は取り下げる。
 *
 *   const plan = await prepareRemake(fetch, cfg, token, mr)        // 各ファイルの土台・MR・本体の今の中身
 *   const r = rebaseRemake(plan, choices)                          // 衝突と、選んだ結果の中身（純粋）
 *   await remakeMergeRequest(fetch, cfg, token, mr, r, { message, description })
 */
import { GitLabError, closeMergeRequest, fetchFileForUpdate, getMergeRequest, mergeRequestFileChanges, saveToGitLab } from "./gitlab.js";
import { T } from "../i18n/index.js";
import type { FetchLike, MergeRequestDetail, SaveResult } from "./gitlab.js";
import type { MasterEditConfig } from "./types.js";
import { MASTER_FILES, MASTER_FILE_IDS, diffMasterDoc, draftFileOf, emptyMasterText, parseMasterDoc, rebaseDraftFile, serializeMasterDoc, withColumn } from "./masterEdit.js";
import { STAMP_COLUMNS } from "./masterEdit.js";
import type { ConflictChoice, DraftFile, MasterFileId, RebaseResult } from "./masterEdit.js";
import { docFromCsvText } from "./csvEdit.js";

export interface RemakeFile {
  fileId: MasterFileId;
  path: string;
  /** MR の土台（base_sha）の中身。null = MR で作ったファイル */
  before: string | null;
  /** MR の中身（head_sha）。null = MR で消したファイル */
  after: string | null;
  /** 本体の今の中身。null = 本体に無い */
  latest: string | null;
  latestCommitId: string | null;
}

export interface RemakePlan {
  files: RemakeFile[];
  /** 読んだときの MR の head（載せ直す前に変わっていないか確かめる） */
  headSha?: string | null;
}

export interface RemakeFileResult {
  fileId: MasterFileId;
  path: string;
  /** 当て直しの結果（衝突・件数）。null = 載せ直せない（error） */
  result: RebaseResult | null;
  /** 保存する中身（選んでいない衝突が無いとき） */
  text: string | null;
  /** 当て直した結果が本体の今の中身と違うか（違うファイルだけ保存する） */
  changed: boolean;
  create: boolean;
  lastCommitId: string | null;
  error?: "deleted" | "unreadable";
}

export interface RemakeRebase {
  files: RemakeFileResult[];
  /** 選んでいない衝突の数 */
  unresolved: number;
  /** 載せ直せない理由があるか */
  blocked: boolean;
  /** 当て直すと本体と同じになる（MR の変更はすべて本体に入っている） */
  empty: boolean;
}

/** MR の変更と本体の今の中身を読む */
export async function prepareRemake(
  fetchImpl: FetchLike,
  cfg: MasterEditConfig,
  token: string,
  mr: Pick<MergeRequestDetail, "baseSha" | "headSha">,
  paths: Partial<Record<MasterFileId, string>> = {},
): Promise<RemakePlan> {
  const pathOf = (id: MasterFileId) => paths[id] ?? MASTER_FILES[id].path;
  const changes = await mergeRequestFileChanges(fetchImpl, cfg, token, mr, MASTER_FILE_IDS.map(pathOf));
  const files = await Promise.all(
    changes.map(async (c) => {
      const fileId = MASTER_FILE_IDS.find((id) => pathOf(id) === c.path) as MasterFileId;
      const latest = await fetchFileForUpdate(fetchImpl, cfg, token, c.path, cfg.gitlab.targetBranch);
      return { fileId, path: c.path, before: c.before, after: c.after, latest: latest?.text ?? null, latestCommitId: latest?.lastCommitId ?? null };
    }),
  );
  return { files, headSha: mr.headSha };
}

/**
 * MR で足した行のうち、本体でも（別の MR などで）既に足されている行を外す。
 * 本体で土台より増えた同じ内容の行（変更者・変更日の列は比べない）の数だけ外す（同じ行を 2 本足すと人月が二重になるため）
 */
function withoutAlreadyAdded(fileId: MasterFileId, draft: DraftFile, beforeText: string, latestText: string | null): DraftFile {
  if (latestText === null || draft.added.length === 0) return draft;
  const latest = parseMasterDoc(fileId, latestText);
  const header = latest.header;
  const skip = new Set<string>([STAMP_COLUMNS.by, STAMP_COLUMNS.at]);
  const sigBy = (hdr: readonly string[]) => (cells: readonly string[]) => header.filter((h) => !skip.has(h)).map((h) => (cells[hdr.indexOf(h)] ?? "").trim()).join("\u0001");
  const count = new Map<string, number>();
  const sigLatest = sigBy(header);
  for (const r of latest.rows) count.set(sigLatest(r.cells), (count.get(sigLatest(r.cells)) ?? 0) + 1);
  const before = parseMasterDoc(fileId, beforeText);
  const sigBefore = sigBy(before.header);
  for (const r of before.rows) count.set(sigBefore(r.cells), (count.get(sigBefore(r.cells)) ?? 0) - 1);
  const draftHeader = draft.columns?.length ? [...before.header, ...draft.columns.filter((c) => !before.header.includes(c))] : before.header;
  const sigDraft = sigBy(draftHeader);
  const added: string[][] = [];
  const addedAfter: number[] = [];
  draft.added.forEach((cells, k) => {
    const s = sigDraft(cells);
    const n = count.get(s) ?? 0;
    if (n > 0) {
      count.set(s, n - 1);
      return;
    }
    added.push(cells);
    if (draft.addedAfter) addedAfter.push(draft.addedAfter[k] as number);
  });
  return { ...draft, added, ...(draft.addedAfter ? { addedAfter } : {}) };
}

/** 1 ファイルの当て直し（純粋）。choices = 衝突 id → mine（この MR）| theirs（本体の今） */
export function rebaseRemakeFile(f: RemakeFile, choices: Readonly<Record<string, ConflictChoice>> = {}): RemakeFileResult {
  const base = { fileId: f.fileId, path: f.path, create: f.latest === null, lastCommitId: f.latestCommitId };
  if (f.after === null) return { ...base, result: null, text: null, changed: false, error: "deleted" };
  const beforeText = f.before ?? emptyMasterText(f.fileId);
  let source = parseMasterDoc(f.fileId, beforeText);
  // MR で見出しに足した列（§103.5 の provisional など）は土台にも足してから読む
  const afterHeader = parseMasterDoc(f.fileId, f.after).header;
  for (const c of afterHeader) if (!source.header.includes(c)) source = withColumn(source, c);
  const imported = docFromCsvText(source, f.after);
  if (!imported.doc) return { ...base, result: null, text: null, changed: false, error: "unreadable" };
  const draft = withoutAlreadyAdded(f.fileId, draftFileOf(imported.doc, { text: beforeText, lastCommitId: null }), beforeText, f.latest);
  const result = rebaseDraftFile(f.fileId, draft, f.latest ?? emptyMasterText(f.fileId), choices);
  const changed = diffMasterDoc(result.doc).count > 0 || (f.latest === null && result.doc.rows.length > 0);
  return { ...base, result, text: result.unresolved.length === 0 ? serializeMasterDoc(result.doc).text : null, changed };
}

/** すべてのファイルを当て直す（純粋） */
export function rebaseRemake(plan: RemakePlan, choices: Readonly<Partial<Record<MasterFileId, Record<string, ConflictChoice>>>> = {}): RemakeRebase {
  const files = plan.files.map((f) => rebaseRemakeFile(f, choices[f.fileId] ?? {}));
  const unresolved = files.reduce((n, f) => n + (f.result?.unresolved.length ?? 0), 0);
  const blocked = files.some((f) => f.error);
  const empty = !blocked && unresolved === 0 && files.every((f) => !f.changed);
  return { files, unresolved, blocked, empty };
}

/**
 * 当て直した中身で新しい MR を作り、元の MR を取り下げる。closeError = 新しい MR はできたが取り下げに失敗した。
 * 読んだあとに元の MR が更新された・閉じられたときは何もせずに止める（GitLabError conflict）。
 * 設定が直接コミット（commitMode: direct）でも、載せ直しは必ず MR にする（確かめずに本体へ入れない）
 */
export async function remakeMergeRequest(
  fetchImpl: FetchLike,
  cfg: MasterEditConfig,
  token: string,
  mr: Pick<MergeRequestDetail, "iid">,
  rebased: RemakeRebase,
  opts: { message: string; description: string; now?: Date; headSha?: string | null },
): Promise<{ result: SaveResult; closeError: unknown }> {
  const current = await getMergeRequest(fetchImpl, cfg, token, mr.iid);
  if ((current.state !== "" && current.state !== "opened") || (opts.headSha !== undefined && current.headSha !== opts.headSha)) throw new GitLabError("conflict", T.mr.remakeStale);
  const files = rebased.files
    .filter((f) => f.text !== null && f.changed)
    .map((f) => ({ path: f.path, content: f.text as string, lastCommitId: f.lastCommitId, create: f.create }));
  const mrConfig: MasterEditConfig = { ...cfg, gitlab: { ...cfg.gitlab, commitMode: "mr" } };
  const result = await saveToGitLab(fetchImpl, { config: mrConfig, token, files, message: opts.message, description: opts.description, ...(opts.now ? { now: opts.now } : {}) });
  let closeError: unknown = null;
  try {
    await closeMergeRequest(fetchImpl, cfg, token, mr.iid);
  } catch (e) {
    closeError = e;
  }
  return { result, closeError };
}
