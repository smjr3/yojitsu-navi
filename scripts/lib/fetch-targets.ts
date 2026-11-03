/**
 * 作業実績 API の取得対象（社員番号）をメンバーマスタから作る（Node 側専用。SPEC §87）
 *
 * 社員番号は data/masters/members.csv だけで管理し、API の設定には書かない。
 *
 * 対象者の決め方:
 *   - 取得する期間（from〜to）のどこか 1 か月でも在籍している人
 *   - 期間の最初の月に不在になった人（前月は在籍）も入れる（不在した月の作業実績を拾うため。§35）
 *   - 区分（社員・パートナー）、チームの有無（他部署のヘルプ）は問わない
 *   - 期間の後に入社した人・期間の前に不在になった人は入れない
 *   → 退職者・異動者の過去の実績も、その期間を指定して取り直せば自動で対象に入る
 */
import { parseDataset } from "../../src/core/csv.js";
import { addMonths, monthRange } from "../../src/core/calendar.js";
import { createEffectiveIndex, isLeftRecord } from "../../src/core/masters.js";
import type { Config, MemberRecord, YearMonth } from "../../src/core/types.js";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readTextAuto } from "./encoding.js";
import { DATA_FILES } from "./load.js";

/** 期間 from〜to の取得対象の社員番号（重複なし・昇順。ロケールに依らない並び） */
export function targetMemberIds(members: readonly MemberRecord[], from: YearMonth, to: YearMonth): string[] {
  const index = createEffectiveIndex(members, (m) => m.memberId.trim(), (m) => m.effectiveFrom);
  const ids = new Set(members.map((m) => m.memberId.trim()).filter((id) => id !== ""));
  // 期間の前月から見る: 前月に在籍していれば、期間の最初の月に不在になっていても対象
  const months = monthRange(addMonths(from, -1), to);
  const out: string[] = [];
  for (const id of ids) {
    if (months.some((m) => {
      const rec = index.at(id, m);
      return rec !== null && rec !== undefined && !isLeftRecord(rec);
    })) out.push(id);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** data/masters/members.csv を読んでメンバーの行を返す（無ければ空） */
export function readMemberRecords(rootDir: string, config: Config): MemberRecord[] {
  const path = join(rootDir, DATA_FILES.members);
  if (!existsSync(path)) return [];
  return parseDataset({ config, contracts: "", mapping: "", assignments: "", teams: "", members: readTextAuto(path), rates: "", holidays: "", worklogs: [] }).dataset.members;
}

/** 社員番号を n 人ずつに分ける */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** --members の値（カンマ・空白・改行区切り）を社員番号の一覧にする */
export function parseMemberList(text: string): string[] {
  return [...new Set(text.split(/[\s,、]+/).map((s) => s.trim()).filter((s) => s !== ""))];
}
