/**
 * csv アダプタ: data/worklogs/YYYY-MM.csv をそのまま読む（パススルー）
 *
 * API が無く、各拠点が月次 CSV を手でアップロードする運用向け。
 * fetch しても内容は変わらない（既存ファイルを読み返すだけ）。
 */
import { parseWorklogCsv } from "../lib/csv.js";
import { readTextAuto } from "../lib/encoding.js";
import { listWorklogFiles, worklogDir } from "../lib/load.js";
import type { Worklog } from "../../src/core/types.js";
import type { WorklogAdapter } from "./types.js";

export const csvAdapter: WorklogAdapter = {
  name: "csv",
  async fetch({ from, to, config, rootDir }): Promise<Worklog[]> {
    const dir = worklogDir(rootDir ?? process.cwd(), config);
    const out: Worklog[] = [];
    for (const f of listWorklogFiles(dir)) {
      if (f.month < from || f.month > to) continue;
      out.push(...parseWorklogCsv(readTextAuto(f.path)));
    }
    return out;
  },
};
