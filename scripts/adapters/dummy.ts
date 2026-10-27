/**
 * dummy アダプタ: scripts/generate-dummy.ts のシナリオから作業実績を生成する（開発用）
 *
 * 環境変数:
 *   DUMMY_SEED   乱数シード（既定 42）
 *   DUMMY_AS_OF  生成基準日 YYYY-MM-DD（既定 2026-10-27）
 */
import { generateWorklogs } from "../generate-dummy.js";
import type { Worklog } from "../../src/core/types.js";
import type { WorklogAdapter } from "./types.js";

export const dummyAdapter: WorklogAdapter = {
  name: "dummy",
  async fetch({ from, to, env }): Promise<Worklog[]> {
    const seed = env.DUMMY_SEED !== undefined && env.DUMMY_SEED !== "" ? Number(env.DUMMY_SEED) : 42;
    const asOf = env.DUMMY_AS_OF && /^\d{4}-\d{2}-\d{2}$/.test(env.DUMMY_AS_OF) ? env.DUMMY_AS_OF : "2026-10-27";
    return generateWorklogs({ seed, asOf, from, to });
  },
};
