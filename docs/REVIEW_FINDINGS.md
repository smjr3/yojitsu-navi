# 計算コア レビュー所見（SPEC.md と src/core の突き合わせ）

レビュー日: 2026-10-27。対象: `src/core/**`。追加したテスト: `tests/unit/review.*.test.ts`、`tests/fuzz/monkey.test.ts`、`tests/integration/dummy-data.test.ts`。
公開関数のシグネチャと `types.ts` は変更していない。

## 修正した不具合

| # | SPEC | 症状 | 修正 | テスト |
|---|---|---|---|---|
| 1 | §8 `meta.lastFinalMonth` = 状態が final の最大月 | `lastFinalMonth()` は前月が final でなければ無条件に前々月を返していた。確定日は翌月の営業日が足りないと翌々月に繰り越す（`nthBusinessDay`）ので、翌月の営業日数 < `closingBusinessDay` のとき前々月も `preliminary` なのに final 扱いになる。結果 `ContractMonth.status`（`monthStatus`）と `monthlySeries().status`（`monthStatusFromMeta`）が食い違う | `status.ts lastFinalMonth`: 前月から final になるまで遡る（上限 120 か月） | `review.status.test.ts`「lastFinalMonth は状態が final の最大月」「closingBusinessDay が大きい設定でも…」「ContractMonth.status と monthlySeries().status が常に一致する」 |
| 2 | §6 単価、§11 `grossMargin`/`burnRate` | `rates.hourlyRate` が NaN/Infinity（CSV の `abc` など。`validateDataset` では `RATE_INVALID`）のとき、`rateFor` がそのまま返し `CostLine.amount`・`cost`・`grossProfit`・`burnRate`・着地見込みに NaN が伝播する。画面は "—" 表示になるが、合計行まで NaN になり他契約の値も壊れる | `masters.ts rateFor`: 有効レコードの単価が有限でなければ「単価なし」（0・`rateMissing`・`RATE_MISSING` 警告） | `review.rates.test.ts`「NaN の個人単価は…」「Infinity の役職単価も単価なし」「NaN 単価が Model・Totals・着地に漏れない」 |
| 3 | §7 `CostLine.memberTeamId`「空 = 非所属」 | `members.teamId` が空文字（CSV 以外の入力や JSON 経由）のとき `memberTeamId` が `""` になり、`null` と混在する | `cost.ts`: 空文字は `null` に揃える | `review.rates.test.ts`「メンバーの teamId が空文字なら null」 |

## 検証して問題なしだったもの（テストで固定）

- 確定日の境界: 2025-12 分は 2026-01-07（1/1〜3 休み、3 日は土曜）、2026-04 分は GW 明け 2026-05-08、asOf = 確定日ちょうどは final、前日は preliminary、うるう年 2028-02-29（`review.status.test.ts`）。
- 正規化: 全角括弧・㈱・㈲、`Co., Ltd.`/`LTD.`/`Inc.`/`Corp.`/`LLC` の大文字小文字、中間の「株式会社」は残す、除去後に空、英字法人格の単語境界（`review.csv-normalize.test.ts`）。
- CSV: BOM、引用符付きヘッダ、CR のみ、末尾カンマ、カンマだけの行、セル内 BOM（trim で消える）、`"1,000"`、全角数字・全角カンマ、指数表記は NaN（同上）。
- ダミーデータ: `docs/DUMMY_DATA.md` の警告内訳・C005 の端数 8・C008 の赤字（作業ログ × 単価の素朴な再計算と一致）・C003/C004 の期間振り分け・M011 昇格・M020 異動・T212 の組織変更・C009 未設定グループ（`tests/integration/dummy-data.test.ts`）。
- モンキーテスト（300 seeds、壊れたデータ込み）: 例外なし、全数値が有限、`cost == Σ costLines.amount`、`Σ budget == totalAmount`、`aggregate == Σ monthlySeries`、`burnRate null ⇔ 累計予算 0`、`forecastCost >= actualCost`、作業ログの行数保存（紐付け＋未紐付け＋除外＋無視 = 入力）、紐付いた作業ログの月が契約期間内、`descendantIds` 一意・自分を含む・循環なし、JSON 往復、決定性、マスタの行順非依存。修正 1〜3 を外すと seed=1 で落ちることを確認済み。

## 修正していない点（API 変更が要る・仕様判断が要る）

1. **`MAPPING_UNKNOWN_CONTRACT` の `ref.row` が 1 始まり（データ行の通し番号）**。`validateDataset` の `row` はヘッダを 1 行目とするファイル行番号（`i + 2`）。画面で行番号を出すなら揃える必要があるが、`Warning.ref` の意味が未定義なので据え置き。
2. **`parseCsvTable().rows[].row` は空行を数えない**（`parseCsvText` が空行を捨てるため）。空行を含む CSV では実ファイルの行番号とずれる。直すには `parseCsvText` の戻り値（`string[][]`）に行番号を付ける API 変更が要る。
3. **作業ログの日付不正は warning**（`WORKLOG_INVALID_DATE`）。SPEC §14「日付・年月の形式不正」は error 扱いとも読めるが、§7「不正な行は無視」と CORE_NOTES の決定に従い warning のまま。
4. **`totalAmount` が整数でない契約**（例 `100.5`）は §2 では有効（数値・非負）だが、§12「内部は常に円の整数」に反する予算が出る。validate で `CONTRACT_AMOUNT_INVALID` にするか、`Math.trunc` するかは仕様判断。
5. **負の `allocation` / 負の `hourlyRate`** は validate で error だが、計算コアはそのまま負の原価を出す（NaN と違い有限なので止めていない）。`forecastCost >= actualCost` の不変条件は validate 通過データでのみ成り立つ。
6. **`CostLine.amount` と `WorklogEntry.amount` の丸めずれ**（CORE_NOTES 記載のとおり最大 0.5 円/行）。また `Math.round(2.675 × 100)` のような浮動小数の .5 境界は JS の丸め結果に依存する。
7. **`Model.teamTree` は asOf 月固定**。§11「チーム一覧は期間の終了月の組織で表示」は画面側で `teamTreeForMonth(dataset, period.to)` を呼ぶ必要がある（`Model.teams` を渡せばよい）。
8. **`docs/DUMMY_DATA.md` の「C012 は noActuals」**は SPEC §10 と合わない。C012（2026-07 開始、実績ゼロ）は 2026-07〜09 が基礎月（原価 0）なので `noActuals = false`・平均 0。`forecastTotals(assignment)` では C013 も赤字（M016 0.05 × 160h × 6,000 = 48,000 円/月 > 予算 10,000 円/月）。テストはこの SPEC どおりの挙動を固定している。
