# 計算コア 実装メモ（SPEC の解釈と決定事項）

`src/core/` の実装にあたって SPEC.md が曖昧だった点と、採った決定。SPEC を更新する際の参考。

## 解釈・決定事項

| 箇所 | 曖昧点 | 決定 |
|---|---|---|
| §4.2 手順 2 | 完全一致 `(顧客, 案件)` ルールはあるが、その契約が全部期間外のとき `(顧客, "")` にフォールバックするか | **しない**。完全一致ルールが存在すればそれを使い、期間外なら `OUT_OF_PERIOD`。フォールバックは「ルールが無いとき」だけ |
| §4.2 手順 3 | 同じキーのルールが複数行あり別契約を指す場合 | 同じキーの全ルールの契約を候補にし、期間で絞る（2 件以上なら `MAPPING_AMBIGUOUS`） |
| §4.2 手順 5 | 同じキーが存在する契約と存在しない契約の両方を指す | 存在しない契約は `MAPPING_UNKNOWN_CONTRACT` を出して候補から外し、残りで通常の判定。候補が 0 件になった場合だけ `UNKNOWN_CONTRACT` |
| §2 / §4.2 | `CONTRACT_INVALID` / 重複で除外した契約を指すルール | 「存在しない契約」と同じ扱い（`MAPPING_UNKNOWN_CONTRACT`） |
| §4.2 | `UNMAPPED_WORKLOG` 警告の粒度 | 未紐付けグループ `(顧客名, 案件名, 理由)` ごとに 1 件（時間・件数・期間を持つ）。`model.unmapped` と同じ粒度 |
| §4.2 | hours 不正・日付不正の行 | 警告なしで無視。`MappingResult.ignoredCount` に件数だけ持つ（validate では warning `WORKLOG_INVALID_HOURS` / `WORKLOG_INVALID_DATE` として件数を表示） |
| §6 手順 4 | 未登録メンバーで個人単価も無い場合に `RATE_MISSING` も出すか | 出さない。`UNKNOWN_MEMBER`（メンバーごと 1 件）だけ。`CostLine.rateMissing` は true |
| §6 | メンバーの `title` が空 | 役職検索はせず `rateMissing` |
| §7 | `WorklogEntry.amount` の丸め | 作業ログ 1 行ごとに `round(hours × rate)`。`CostLine.amount` は行（メンバー×月）単位で `round(Σhours × rate)` なので、両者の合計は最大 0.5 円/件ずれうる。原価（`cost`）は **CostLine の合計**が正 |
| §7 | `CostLine.memberName` | 当月のメンバーマスタの名前を優先、無ければ作業ログの `member_name` |
| §10 | 平均 × 残り月数 が整数にならない | `remainingCost = Math.round(平均 × 残り月数)`。`averageMonthlyCost` は丸めない値を内訳に持つ |
| §10 assignment | アサインはあるが残り月に 1 件も掛からない | `noAssignments = false`、明細 0 件、残り原価 0（`noAssignments` は「契約にアサインが 1 件も無い」の意味に限定） |
| §8 | `lastFinalMonth` | 契約月の有無に関係なく暦から決める（前月の確定日 <= asOf なら前月、そうでなければ前々月） |
| §11 | `teamTree` の表示順 | teams ファイルでの初出順（最上位・子ともに） |
| §11 | 循環参照の切り方 | 循環に含まれるチームのうち **ID が最小** のものの親リンクを切り最上位にする（決定的） |
| §11 | `Totals.contractCount` | 期間内に 1 か月以上 `ContractMonth` を持つ契約の数（期間外の契約は数えない） |
| §11 | `MonthlyPoint.status` | SPEC どおり asOf 基準で計算。`outside` は返さない（契約の無い月も `final/preliminary/future`） |
| §11 | 未設定グループ | `UNASSIGNED_TEAM_ID = "__unassigned__"` を `contractsForTeam` に渡すと、`teamId` が空か木に無い契約を返す |
| §14 | 重複契約の `row` | 2 回目以降の行を報告。エラー `code` は SPEC に無いので `CONTRACT_PERIOD_INVERTED` / `CONTRACT_AMOUNT_INVALID` / `ASSIGNMENT_UNKNOWN_MEMBER` などを新設（`ValidationIssue.code` は string） |
| §14 | アサインの月合計 > 1.0 | 浮動小数の誤差（0.3+0.7）を許容するため `> 1 + 1e-9` で判定 |
| `meta.generatedAt` | 決定性との両立 | `buildModel(dataset, { asOf, generatedAt? })`。省略時は現在時刻。テストでは固定する。それ以外の出力は完全に決定的 |
| `meta.minMonth/maxMonth` | 契約 0 件のとき | `asOfMonth` |
| CSV | 数値セル | NFKC 正規化 → カンマ除去 → `^[+-]?(\d+\.?\d*|\.\d+)$` のみ許可。それ以外（空・`abc`・`1e3`）は `NaN` にして検証でエラー |
| CSV | `parseDataset().issues` | 必須列の欠落（`MISSING_COLUMN`）に加えて `validateDataset` の結果も含める（呼び出し側が二度呼ばなくてよい） |
| CSV | `members.kind` | 小文字化してから格納（`Employee` → `employee`）。それ以外の値は `MEMBER_KIND_INVALID` |

## 型について（types.ts は変更していない）

- `Model` に `holidays` も `dataset` も無いため、画面側で月の状態を再計算できない。`monthStatusFromMeta(month, meta)` を用意し、`meta.asOfMonth` と `meta.lastFinalMonth` から同じ判定を復元している（`monthlySeries` で使用）。SPEC §11 の `teamTreeAt(model.dataset, month)` は `Model` に `dataset` が無いので、画面側で `Dataset` を別に保持して `teamTreeForMonth(dataset, month)` を呼ぶ必要がある。将来 `ModelMeta` に `holidays: ISODate[]` を、あるいは `Model` に `teams: TeamRecord[]` を加えると画面側が楽になる。
- `Warning` に `row`（元ファイルの行番号）が無い。`MAPPING_UNKNOWN_CONTRACT` では `ref.row` に入れている。
- `MonthlyPoint.status` に `outside` を入れる場面が無い（SPEC §11 の指示どおり asOf 基準）。`MonthStatus` から `outside` を外すか、`monthlySeries` の仕様を「スコープ内に契約月が無ければ outside」に変えるかは画面側の都合で決める。
- `Config.worklogSource.http.columns` は `Record<keyof Worklog, string>` で、計算コアでは使わない。
- `Contract.note?` / `Dataset.worklogFetchedAt?` は `exactOptionalPropertyTypes` のため `undefined` を代入できない。CSV 読み込みでは値が無いときキー自体を省略している。

## 拡張ポイント

- 原価の種類: `CostProvider { costType, compute(contractId, month) }` を `buildModel(dataset, { extraProviders })` で追加できる。`config.costTypes` に ID を足せば `costs` のキーに現れる。
- 性能: 作業ログは `(契約ID, 月)` で索引化（`indexWorklogs`）、マスタは `(キー → effectiveFrom 昇順)` で二分探索。5 万件 × 100 契約で 0.5 秒程度（`tests/unit/perf.test.ts`）。

## 顧客別（SPEC §17）決定事項

実装は `src/core/customers.ts`（`customerKey` / `groupByCustomer`）。

| 箇所 | 曖昧点 | 決定 |
|---|---|---|
| キー | `normalizeName` の結果が `__none__` など予約キーと衝突 | 正規化結果が `__` で始まるときは `_` を 1 つ足す（単射。足したキーは `___` 始まりで予約キー `__none__` と別）。通常の顧客名は正規化結果そのまま |
| 顧客名なし | 空・空白・法人格だけ | キー `__none__`、表示名「顧客名なし」。並びは末尾 |
| 表示名 | 同じキーの契約の表記ゆれ | 契約ID昇順（文字コード順。`C10` は `C2` の前）で最初の契約の `customerName` をそのまま |
| 順序 | 入力順への依存 | グループはキー順（コード単位）・契約IDは昇順。入力の並び・重複契約IDに依らず決定的 |
| 合計 | 顧客の合計と全体 | 全契約がちょうど 1 顧客に属するので、顧客ごとの `aggregate` / `forecastTotals` の合計は全体と一致（プロパティ・結合テストで確認） |
