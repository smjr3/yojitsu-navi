/**
 * マージ待ちの変更がある行の印（SPEC §126.3）
 *
 * マージ待ちの MR の行の差分（§26 の「内容を見る」と同じ形）から、ファイルごとに「対象のキー（台帳の 1 行目の列 = 社員番号・単価のキーなど）→ その対象を変える MR」を作る。
 * マスタ編集の台帳・リソース計画の人の行に「マージ待ち」の印を出し、同じ人を続けて直して重なるのを防ぐ。
 */
import { MASTER_FILES } from "./masterEdit.js";
import type { MasterFileId } from "./masterEdit.js";

export interface PendingMr {
  iid: number;
  title: string;
  /** 作成者の表示名 */
  author: string;
}

type Rec = Record<string, string | undefined>;
export interface PendingFileDiff {
  id?: MasterFileId | string;
  diff: { added: Array<{ after: Rec }>; changed: Array<{ before: Rec; after: Rec }>; removed: Array<{ before: Rec }> } | null;
}

/** ファイル → キー → そのキーを変える MR（同じ MR は 1 回） */
export type PendingKeys = Partial<Record<MasterFileId, Map<string, PendingMr[]>>>;

export function pendingKeysOf(entries: ReadonlyArray<{ mr: PendingMr; files: readonly PendingFileDiff[] }>): PendingKeys {
  const out: PendingKeys = {};
  for (const { mr, files } of entries) {
    for (const f of files) {
      const id = f.id as MasterFileId | undefined;
      if (!id || !f.diff || !MASTER_FILES[id]) continue;
      const def = MASTER_FILES[id];
      // 目標はキーの 1 列目（種類）では対象が決まらないので、種類と対象の 2 列でまとめる
      const keyOf = (r: Rec) => (id === "targets" ? [r.target_type, r.target_id].map((v) => (v ?? "").trim()).join("\u0001") : (r[def.keyColumns[0] as string] ?? "").trim());
      const keys = new Set<string>();
      for (const r of f.diff.added) keys.add(keyOf(r.after));
      for (const r of f.diff.changed) {
        keys.add(keyOf(r.before));
        keys.add(keyOf(r.after));
      }
      for (const r of f.diff.removed) keys.add(keyOf(r.before));
      keys.delete("");
      keys.delete("\u0001");
      if (keys.size === 0) continue;
      const map = (out[id] ??= new Map());
      for (const k of keys) {
        const list = map.get(k) ?? [];
        if (!list.some((x) => x.iid === mr.iid)) list.push(mr);
        map.set(k, list);
      }
    }
  }
  return out;
}

/** キーを変えるマージ待ちの MR（複数ファイル分をまとめ、同じ MR は 1 回） */
export function pendingFor(pending: PendingKeys, fileIds: readonly MasterFileId[], key: string): PendingMr[] {
  const out: PendingMr[] = [];
  for (const id of fileIds) for (const mr of pending[id]?.get(key) ?? []) if (!out.some((x) => x.iid === mr.iid)) out.push(mr);
  return out;
}
