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

## メンバー別（SPEC §18.1）— `src/core/members.ts`

`buildModel` が `Model.memberMonths: MemberMonth[]`（メンバー×月、`byContract[]` に契約別の内訳）を作る。画面は `aggregateMembers(model, scope)`（期間・メンバー・契約・所属チームで合算）と `memberMonthlySeries(model, memberId, period, contractIds?)` を使う。単価は §6 の `rateFor` をそのまま使い、計画と実績で同じ単価になる（重複実装なし）。

| 項目 | 決定 |
|---|---|
| 行を作る（x, m） | アサインが掛かる月（契約期間内）か、CostLine がある月だけ。どちらも無い月は作らない（`memberMonthlySeries` は 0 で埋める） |
| 計画の対象 | `buildModel` の計算対象の契約（`CONTRACT_INVALID`・重複を除いた `model.contracts`）だけ。未知の契約ID・契約期間外の月・`allocation` が数値でないアサインは数えない（§10 assignment と同じ） |
| 丸め | 同じ（x, c, m）の `allocation` を合計してから `round(Σallocation × 基準時間 × 単価)` を 1 回。メンバー月の `plannedCost` は行の丸めた額の合計（全体で丸め直さない）。着地見込み assignment 方式はアサイン行ごとに丸めるので、同じ（x, c, m）にアサイン行が複数あると最大 0.5 円/行ずれる（ダミーデータでは一致することを結合テストで確認） |
| 実績 | 契約・月の CostLine のうち `memberId = x`。原価の種類を問わない（Σ メンバー実績 = Σ 契約原価 が常に成り立つ） |
| 未アサイン（unplanned） | （x, c, m）に掛かるアサイン行が **0 件** の実績。配分 0 のアサインは「アサインあり（計画 0）」として unplanned に入れない。`assignmentCount` で区別 |
| 所属・役職・区分（月ごと） | その月の有効レコード。空文字のチーム・役職は null |
| 名前 | 当月のマスタ名 → 作業ログの `member_name`（CostLine.memberName）→ ID |
| 未登録メンバー | `memberUnknown = true`。個人単価があれば使い、無ければ 0・`rateMissing`（§6 手順 4 と同じ） |
| 所属チームの基準月（集計） | `memberBaseMonth = min(period.to, asOfMonth)`（§11 の組織木と同じ。未来の組織で集計しない）。基準月に有効レコードが無ければ期間内の最後の MemberMonth の値 |
| `aggregateMembers` の `teamIds` | 基準月の所属チームがこの集合に入るメンバーだけ（配下を含めるなら呼び出し側が `descendantIds` を渡す）。`includeNoTeam` で未所属も含める |
| `contractIds` | byContract をその契約に絞って数える（チーム詳細の「このチームの契約に工数を付けた人」に使える） |
| `includesPreliminary` | 実績時間 > 0 の速報月を含むか |
| 並び | memberMonths は memberId → month 昇順、byContract は contractId 昇順。`aggregateMembers` の members は memberId 昇順 |
| 単価の変遷 | `memberRateHistory(dataset | MasterIndex, memberId, period)`。月ごとに `rateFor` を引き、単価・出どころ・役職が同じ月をまとめる。マスタにあるが入社前の月は飛ばす。`Model` は単価マスタを持たない（NaN 単価を Model に漏らさないため `Model.rates` は足さなかった）ので Dataset から計算する |

### model.json のサイズ

`memberMonths` はダミーデータで 603 行・契約別 1,920 行、JSON で **486 KB**（model.json 540 KB の 9 割）。全ページが読む model.json に入れると倍近くなるため、`src/data/model.json.ts` では `memberMonths: []` にし、`src/data/member-months.json.ts`（`{asOf, memberMonths, rateHistory}`、503 KB・gzip 25 KB）でメンバー別の画面だけに配る。型（`Model.memberMonths`）は変えず、画面で `{...model, memberMonths}` に戻して core の関数にそのまま渡す。

### 性能

`tests/unit/members.perf.test.ts`: perf.test.ts と同じ規模（作業ログ 5 万件 × 契約 100 件 × 200 人）＋アサイン 400 行で、memberMonths を含む Model 構築 2 秒以内（実測 約 0.6〜1 秒）、`buildMemberMonths` 単体 300ms 以内、`aggregateMembers` 200 回 ＋ 月次推移 200 人分で 2 秒以内。
