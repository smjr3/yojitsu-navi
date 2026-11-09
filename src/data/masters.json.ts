/**
 * マスタ編集画面用: 編集対象のファイルの生テキストと最終コミット ID、保存方式の設定（SPEC §19.2）。中身は _outputs.ts
 */
import { emitJson } from "./_shared.js";
import { AGGREGATE_OUTPUTS, createContext } from "./_outputs.js";

emitJson(() => AGGREGATE_OUTPUTS.masters(createContext()));
