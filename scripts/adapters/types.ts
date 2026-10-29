/**
 * 作業実績アダプタの共通インターフェース
 *
 * アダプタは「期間（年月 from〜to）の作業実績を Worklog[] で返す」だけを担当する。
 * ファイルへの書き出しや _meta.json の更新は scripts/fetch-worklogs.ts が行う。
 */
import type { Config, Worklog, YearMonth } from "../../src/core/types.js";
import type { FetchReport } from "./http-source.js";

export interface FetchOptions {
  /** 取得開始月（含む） */
  from: YearMonth;
  /** 取得終了月（含む） */
  to: YearMonth;
  /** 取得の基準日 YYYY-MM-DD（dummy アダプタが生成の基準日に使う） */
  asOf?: string;
  config: Config;
  /** 認証トークンなどは環境変数から受け取る（config.json には書かない） */
  env: NodeJS.ProcessEnv;
  /** リポジトリのルート（既定: カレントディレクトリ） */
  rootDir?: string;
  /** 進捗ログの出力先（既定: console.error）。トークン等の秘密は絶対に出さないこと */
  log?: (message: string) => void;
  /** 列の対応表などの診断情報の受け取り先（--dry-run 用。http アダプタだけが呼ぶ） */
  report?: (r: FetchReport) => void;
}

export interface WorklogAdapter {
  /** config.worklogSource.adapter に書く名前 */
  name: string;
  fetch(opts: FetchOptions): Promise<Worklog[]>;
}
