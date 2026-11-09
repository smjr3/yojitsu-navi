/**
 * データ確認ページ用: CSV 読み込み時の問題 ＋ validateDataset の結果（scripts/validate-data.ts と同じ内容）。中身は _outputs.ts
 */
import { emitJson } from "./_shared.js";
import { AGGREGATE_OUTPUTS, createContext } from "./_outputs.js";

emitJson(() => AGGREGATE_OUTPUTS["dataset-issues"](createContext()));
