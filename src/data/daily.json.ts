/**
 * 今月の進捗（SPEC §61）。asOf の月の、案件ごと・日ごとの実績（速報）。
 * 全体・チーム・顧客・案件の詳細の「今月の進捗」だけが読む。
 */
import { encodeDaily } from "../core/index.js";
import { buildModelFromData, buildStamp, emitJson } from "./_shared.js";

emitJson(() => {
  const model = buildModelFromData();
  return { ...encodeDaily(model), _build: buildStamp() };
});
