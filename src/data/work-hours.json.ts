/**
 * 工数の明細（SPEC §30.2）。工数画面と詳細画面の「作業種別の内訳」だけが読む。
 * 行数が多いので辞書＋配列に詰めて配る（画面側は decodeWorkRows で WorkRow[] に戻す）。
 */
import { encodeWorkRows } from "../core/index.js";
import { buildModelFromData } from "./_shared.js";

const model = buildModelFromData();
process.stdout.write(JSON.stringify({ asOf: model.meta.asOf, ...encodeWorkRows(model.workRows) }));
