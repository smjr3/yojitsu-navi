/**
 * 画面が読む Model（作業ログ明細は除く。明細は data/worklogs/[contractId].json で遅延取得）
 *
 *   YOJITSU_AS_OF=2026-10-27 npm run build   # 計算基準日を固定する
 */
import { buildModelFromData, stripWorklogs } from "./_shared.js";

const model = buildModelFromData();
const lean = {
  ...model,
  contracts: model.contracts.map(stripWorklogs),
  /** 作業ログ明細の取得先（契約IDごと）。画面側は相対パスで fetch する */
  worklogDetailPath: "data/worklogs/{contractId}.json",
};
process.stdout.write(JSON.stringify(lean));
