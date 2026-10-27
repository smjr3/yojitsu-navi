# 予実ナビ 計算仕様（実装の正）

要件定義（2026-10-27 確定）を実装可能な粒度に落としたもの。画面・テスト・計算コアはこの仕様に従う。
型は `src/core/types.ts`。設定は `config.json`。

## 1. 用語

| 用語 | 意味 |
|---|---|
| 予（予算） | 保守契約の総額を契約月数で均等割りした月次売上 |
| 実（原価） | 作業時間 × その月に有効な時間単価。種類（`costTypes`）を持つ。当面は `labor` のみ |
| 粗利 | 予算 − 原価。粗利率 = 粗利 ÷ 予算 |
| 消化率 | 経過月の累計原価 ÷ 経過月の累計予算。100%超（`burnRateDangerThreshold`）で赤 |
| 着地見込み | 年度末時点の原価と粗利の予測。契約ごとに赤字／黒字 |
| 年度 | 4月始まり（`fiscalYearStartMonth`）。FY2026 = 2026-04〜2027-03。年度番号は開始年 |
| asOf | 計算基準日。既定は実行日。テストでは固定する |

## 2. 月の扱い

- 年月は `"YYYY-MM"` の文字列。比較は文字列比較で正しい（ゼロ埋め必須）。
- 契約の月数 = 開始月と終了月を**両方含む**月数。`2026-04`〜`2027-03` は 12。
- 月途中開始・終了も均等割り（日割りしない）。
- `startMonth > endMonth` の契約は `CONTRACT_INVALID` 警告を出し、計算から除外する。
- `totalAmount < 0`、数値でない、整数でない場合も `CONTRACT_INVALID`。0 は有効（予算0）。
- 契約IDの重複は `DUPLICATE_CONTRACT_ID`。最初の行だけ採用。

## 3. 月次予算

```
baseMonthly = floor(totalAmount / monthCount)
remainder   = totalAmount - baseMonthly * monthCount
budget(m)   = baseMonthly            (最終月以外)
            = baseMonthly + remainder (最終月)
```
- 全月の合計は必ず `totalAmount` と一致する（テストで保証）。
- 内訳 `BudgetBreakdown` に `totalAmount, monthCount, baseMonthly, remainder, isLastMonth` を入れる。

## 4. 作業実績の紐付け（名称マッピング）

### 4.1 正規化
顧客名・案件名は照合前に `normalizeName()` で正規化する。
1. Unicode NFKC（全角英数・半角カナを統一）
2. 前後の空白を除去、連続する空白（全角含む）を1つの半角空白に
3. 小文字化
4. 法人格の除去: `株式会社`, `(株)`, `（株）`, `㈱`, `有限会社`, `(有)`, `（有）`, `㈲`, `合同会社`, `Inc.`, `Co., Ltd.`, `Ltd.`, `Corp.`, `LLC` を**前後から**除去（中間は残す）。除去後に再度 trim。
5. 空になったら空文字。

### 4.2 照合
1. 顧客名が空（正規化後）の工数は**除外**。`excludedHours` に合算し `EXCLUDED_NO_CUSTOMER` 警告1件（時間と件数）。
2. キー `(顧客, 案件)` の完全一致ルールを探す。無ければ `(顧客, "")` のルールを探す。
3. 該当ルールが指す契約のうち、作業日の月が `startMonth..endMonth` に含まれる契約を選ぶ。
   - 1件 → その契約に紐付け。
   - 0件 → 未紐付け（理由 `OUT_OF_PERIOD`）。
   - 2件以上 → `contractId` 昇順で最初を採用し `MAPPING_AMBIGUOUS` 警告。
4. ルールが無い → 未紐付け（理由 `NO_RULE`）。
5. ルールの `contractId` が存在しない → `MAPPING_UNKNOWN_CONTRACT` 警告、未紐付け（理由 `UNKNOWN_CONTRACT`）。
6. 未紐付けは `(顧客名, 案件名)`（元の表記）でまとめ、時間・件数・最初と最後の日付を持つ。

`hours <= 0` または数値でない工数行は無視し、件数を `UNMAPPED` ではなく警告 `CONTRACT_INVALID` とは別に数えない（単に無視）。`hours` は小数可（0.25 など）。

## 5. 履歴マスタの「有効レコード」

teams / members / rates は `effectiveFrom`（適用開始月）付きの履歴。
**月 m に有効なレコード = 同じキーで `effectiveFrom <= m` のうち `effectiveFrom` が最大のもの**。
同じキー・同じ `effectiveFrom` が複数ある場合は後の行（ファイル末尾側）を採用。
`effectiveFrom > m` しか無ければ「その月には存在しない」。

## 6. 時間単価

月 m のメンバー x の単価:
1. `rates` に `key == memberId` の有効レコードがあればそれ（パートナー個人単価）。
2. 無ければ、月 m に有効な `members` レコードの `title` で `key == title` を探す。
3. 無ければ単価 0、`rateMissing = true`、警告 `RATE_MISSING`（メンバーID・月ごとに1件、時間を合算）。
4. メンバーが `members` に無い → 単価は 1 のルールのみ試し、無ければ 0。警告 `UNKNOWN_MEMBER`（メンバーIDごとに1件）。

単価改定は行を追加する運用。過去月は過去の単価で計算されるので再計算されない。

## 7. 月次原価

契約 c、月 m:
```
costLines = 作業ログを (memberId) でまとめ、
            hours = Σhours, hourlyRate = 単価(member, m),
            amount = round(hours × hourlyRate)   // 円に四捨五入（Math.round）
cost(c,m)  = Σ amount
costs[labor] = cost
```
- 原価の種類: 当面 `labor` のみ。`costs` は `config.costTypes` の全IDをキーに持ち、無い種類は 0。合計 `cost = Σ costs[*]`。
- `costLines` にはそのメンバーの当時のチームID（members 有効レコードの `teamId`）を持たせる。
- `worklogs` に元の作業ログ（契約IDと単価・金額付き）を持つ。
- 作業ログの `date` が不正（`YYYY-MM-DD` でない・存在しない日付）な行は無視する。

## 8. 月の状態（確定・速報・未来）

- `asOfMonth` = asOf の年月。
- 月 m の確定日 = m の翌月の第 `closingBusinessDay` 営業日（営業日 = 土日でも `holidays` でもない日）。
- `status(m)`:
  - `m > asOfMonth` → `future`
  - `m == asOfMonth` → `preliminary`
  - `m < asOfMonth` かつ asOf < 確定日 → `preliminary`
  - それ以外 → `final`
  - 契約期間外の月は `ContractMonth` を作らない（`outside` は集計時の表現用）。
- `meta.lastFinalMonth` = 状態が `final` の最大月（asOf 月の前月か前々月）。

## 9. 営業日数と人月換算

- `businessDays(m)` = m の暦日のうち土日と祝日（`holidays.csv`）を除いた日数。
- 人月（標準）= hours ÷ `standardHoursPerMonth`。
- 人月（カレンダー）= hours ÷ (businessDays(m) × `hoursPerBusinessDay`)。複数月の合計は月ごとの人月を合算。

## 10. 着地見込み（契約ごと・年度ごと）

対象年度 = asOf の年度（`meta.fiscalYear`）。契約 c について:

```
fyMonths        = 年度の12か月
cMonthsInFY     = fyMonths ∩ 契約期間
actualMonths    = cMonthsInFY のうち m < asOfMonth   // 完了した月（速報含む）
remainingMonths = cMonthsInFY のうち m >= asOfMonth  // asOf 月を含む
fyBudget        = Σ budget(c, m)  for m in cMonthsInFY
actualCost      = Σ cost(c, m)    for m in actualMonths
```
残り月の原価の出し方（方式）:
- `recent3`: 契約期間内で `m < asOfMonth` の月（年度をまたいでよい）のうち直近 `forecastRecentMonths` か月の原価平均 × 残り月数。基礎月が 0 → 平均 0、`noActuals = true`。基礎月が 3 未満ならある分で平均。
- `all`: 契約開始月から `m < asOfMonth` までの全月の原価平均 × 残り月数。基礎月 0 → `noActuals`。
- `assignment`: Σ(残り月 m, アサイン a: a.memberId, a.contractId == c, a.startMonth <= m <= a.endMonth) allocation × `standardHoursPerMonth` × 単価(a.memberId, m)。アサインが0件 → `noAssignments = true`、残り原価 0。

```
forecastCost        = actualCost + remainingCost
forecastGrossProfit = fyBudget - forecastCost
isDeficit           = forecastGrossProfit < 0
```
契約が年度に1か月も掛からない場合: `fyBudget = 0, forecastCost = 0, isDeficit = false`、`contractMonthsInFY = []`。
3方式すべてを `forecasts` に入れ、画面で切り替える。

## 11. 集計（画面側）

`aggregate(model, scope)`:
- `scope.period = {from, to}`（両端含む）。`scope.contractIds`（省略 = 全契約）。
- 期間内の `ContractMonth` を合算: budget, costs, cost, grossProfit, hours。
- `grossMargin = grossProfit / budget`（budget 0 → null）。
- 消化率: `elapsedMonths` = 期間内かつ `m <= asOfMonth` の月。`burnRate = Σcost(elapsed) / Σbudget(elapsed)`（分母 0 → null）。`isOverBudget = burnRate != null && burnRate > threshold`。
- `includesPreliminary` = 期間内に `preliminary` の月を含む。
- `monthlySeries(model, scope)` → `MonthlyPoint[]`（期間の全月。契約の無い月は 0・status は asOf 基準で計算）。
- `forecastTotals(model, contractIds, method)` → 契約ごとの着地を合算、`deficitContractIds` を列挙。

### チーム
- `teamTree` は asOf 月に有効な `teams` レコードで作る。親が存在しない `parentTeamId` は `UNKNOWN_TEAM` 警告を出し最上位扱い。循環参照は検出して切る（警告 `UNKNOWN_TEAM` に理由を書く）。
- チームの契約 = `contract.teamId` が自分または配下（`descendantIds`）に含まれる契約。上位組織の数値は配下すべての合計。
- 主担当チームが空・未知の契約は「未設定」という仮想グループに入れる（チーム一覧の末尾に表示）。
- 過去月の組織は当時のもので集計する: `teamTreeAt(model.dataset, month)` を用意し、チーム一覧は期間の終了月の組織で表示する（初回リリースはこれで十分。月ごとの組織差分は2回目以降）。

## 12. 金額・表示

- 内部は常に円の整数（原価は行ごとに四捨五入）。
- 表示は円（既定）／千円を切替。千円は `Math.round(yen / 1000)` で表示。
- 割合は小数1桁（例 103.4%）。
- 赤表示は消化率 > 閾値 と 着地が赤字 のみ。黄色警告は無し。

## 13. 計算根拠（内訳）

すべての表示値は根拠を持つ。
- 予算: `BudgetBreakdown`
- 原価: `CostLine[]` → `WorklogEntry[]` まで辿れる
- 消化率: `burnRateBreakdown`
- 着地: `ForecastBreakdown`
画面の数値をクリックすると内訳パネルに「式 ＋ 実際に使った値」を表示する。

## 14. データ検証（CI で止める）

`scripts/validate-data.ts` は以下で非0終了する:
- 契約: ID重複、期間逆転、金額が数値でない／負
- マッピング: 存在しない契約ID
- アサイン: 未知のメンバーID／契約ID、1人の月合計 allocation > 1.0、allocation が 0〜1 の外
- チーム: 未知の親ID、循環
- メンバー: 未知のチームID、区分が employee/partner 以外
- 単価: 数値でない／負
- 日付・年月の形式不正
警告（未紐付け工数、単価なし）は止めずに表示する。

## 15. CSV の規約

- UTF-8（BOM あり可）。Shift_JIS も読み込み時に自動判定（`scripts/` で対応）。
- 1行目はヘッダ。列名は英語（`contract_id` など）で、`docs/DATA.md` に列定義を置く。
- 空行・空白だけの行は無視。
