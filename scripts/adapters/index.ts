/**
 * 作業実績アダプタの登録簿
 *
 * config.json の worklogSource.adapter の値でアダプタを選ぶ。
 *
 * ## 新しいアダプタの追加手順
 * 1. scripts/adapters/<name>.ts を作り、`WorklogAdapter`（types.ts）を実装した定数を export する。
 *    - fetch({from, to, config, env}) は期間内の作業実績を Worklog[] で返すだけ。ファイルは書かない。
 *    - 認証情報は env（環境変数）から受け取り、config.json には書かない。ログにも出さない。
 *    - 取得元の列名の違いは config.worklogSource.http.columns のような設定で吸収する。
 * 2. 下の ADAPTERS に追加する。
 * 3. src/core/types.ts の WorklogSourceConfig.adapter にも名前を足す（計算コア側の型）。
 * 4. tests/integration/ にモックを使ったテストを追加する（http-adapter.test.ts を参考に）。
 */
import type { Config } from "../../src/core/types.js";
import { csvAdapter } from "./csv.js";
import { dummyAdapter } from "./dummy.js";
import { httpAdapter } from "./http.js";
import type { WorklogAdapter } from "./types.js";

export const ADAPTERS: Record<string, WorklogAdapter> = {
  [csvAdapter.name]: csvAdapter,
  [dummyAdapter.name]: dummyAdapter,
  [httpAdapter.name]: httpAdapter,
};

/** 設定からアダプタを選ぶ。環境変数 WORKLOG_ADAPTER で上書き可（CI で一時的に切り替える用） */
export function selectAdapter(config: Config, env: NodeJS.ProcessEnv = process.env): WorklogAdapter {
  const name = env.WORKLOG_ADAPTER || config.worklogSource.adapter;
  const adapter = ADAPTERS[name];
  if (!adapter) {
    throw new Error(`不明なアダプタ "${name}"。使用可能: ${Object.keys(ADAPTERS).join(", ")}`);
  }
  return adapter;
}

export type { WorklogAdapter, FetchOptions } from "./types.js";
