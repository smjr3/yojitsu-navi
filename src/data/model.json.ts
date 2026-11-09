/**
 * 画面が読む Model（作業ログ明細は除く。明細は data/worklogs/[contractId].json で遅延取得）。中身は _outputs.ts
 *
 *   YOJITSU_AS_OF=2026-10-27 npm run build   # 計算基準日を固定する
 */
import { emitJson } from "./_shared.js";
import { AGGREGATE_OUTPUTS, createContext } from "./_outputs.js";

emitJson(() => AGGREGATE_OUTPUTS.model(createContext()));
