/**
 * マスタ編集画面用: 編集対象 4 ファイルの生テキストと最終コミット ID、保存方式の設定（SPEC §19.2）
 */
import { ROOT_DIR, buildStamp, emitJson } from "./_shared.js";
import { buildMastersPayload } from "./_masters.js";

emitJson(() => ({ ...buildMastersPayload(ROOT_DIR), _build: buildStamp() }));
