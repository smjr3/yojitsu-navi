/**
 * 工数の明細（SPEC §30.2）。工数画面と詳細画面の「作業種別の内訳」だけが読む。
 * 行数が多いので辞書＋配列に詰めて配る（画面側は decodeWorkRows で WorkRow[] に戻す）。
 */
import { encodeWorkRows } from "../core/index.js";
import { buildModelFromData, buildStamp, emitJson } from "./_shared.js";

emitJson(() => {
  const model = buildModelFromData();
  return { asOf: model.meta.asOf, ...encodeWorkRows(model.workRows), _build: buildStamp() };
});
