/**
 * 画面が読む Model（作業ログ明細は除く。明細は data/worklogs/[contractId].json で遅延取得）
 *
 *   YOJITSU_AS_OF=2026-10-27 npm run build   # 計算基準日を固定する
 */
import { buildModelFromData, buildStamp, emitJson, stripWorklogs } from "./_shared.js";

emitJson(() => {
  const model = buildModelFromData();
  return {
    ...model,
    contracts: model.contracts.map(stripWorklogs),
    // メンバー別（§18）は data/member-months.json で別に配る（メンバー別の画面だけが読む）
    memberMonths: [],
    // 工数の明細（§30）は data/work-hours.json で別に配る（工数・詳細画面の作業種別の内訳だけが読む）
    workRows: [],
    /** 作業ログ明細の取得先（契約IDごと）。画面側は相対パスで fetch する */
    worklogDetailPath: "data/worklogs/{contractId}.json",
    /** 入力の指紋（ビルド後の検証と、作業ログ明細の取得でブラウザの古いキャッシュを避けるのに使う） */
    _build: buildStamp(),
  };
});
