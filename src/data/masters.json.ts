/**
 * マスタ編集画面用: 編集対象 4 ファイルの生テキストと最終コミット ID、保存方式の設定（SPEC §19.2）
 */
import { ROOT_DIR } from "./_shared.js";
import { buildMastersPayload } from "./_masters.js";

process.stdout.write(JSON.stringify(buildMastersPayload(ROOT_DIR)));
