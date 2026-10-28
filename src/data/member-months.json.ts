/**
 * メンバー別の画面（/members, /member）が読むデータ（SPEC §18）
 *
 * Model.memberMonths は model.json に入れると全ページの読み込みが倍近くになる（ダミーデータで +486 KB）ため、
 * model.json では空にして、メンバー別の画面だけがこのファイルを追加で読む。
 *   memberMonths  Model.memberMonths そのもの（aggregateMembers / memberMonthlySeries にそのまま渡せる）
 *   rateHistory   メンバーごとの単価の変遷（memberRateHistory。Model は単価マスタを持たないためここで計算する）
 */
import { memberRateHistory } from "../core/index.js";
import { buildModelFromData, buildStamp, emitJson, loadParsed } from "./_shared.js";

emitJson(() => {
  const parsed = loadParsed();
  const model = buildModelFromData(parsed);
  const ids = new Set<string>();
  for (const mm of model.memberMonths) ids.add(mm.memberId);
  for (const m of parsed.dataset.members) ids.add(m.memberId);
  const period = { from: model.meta.minMonth, to: model.meta.maxMonth };
  const rateHistory: Record<string, ReturnType<typeof memberRateHistory>> = {};
  for (const id of [...ids].sort()) rateHistory[id] = memberRateHistory(parsed.dataset, id, period);

  return { asOf: model.meta.asOf, memberMonths: model.memberMonths, rateHistory, _build: buildStamp() };
});
