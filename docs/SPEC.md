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
- 表示は **百万円（既定、2026-10-28 決定）**／千円／円を切替。百万円は `Math.round(yen / 100000) / 10` を小数1桁で表示（例 `12.3百万円`）、千円は `Math.round(yen / 1000)`。
- 計算根拠パネルの「実際に使った値」（契約総額・単価・作業ログの金額など）は単位に関係なく円で表示する（根拠は丸めない）。
- 明細の表（作業ログ、原価行＝メンバー×月の原価、メンバー×月・メンバー×契約の計画/実績、単価）は 1 行の金額が小さく百万円では 0.0 になるため、**選択単位に関係なく円** で表示し、見出しに「（円）」と書く。選択単位に従うのは KPI・一覧（契約・チーム・顧客・メンバーの集計行）・月次推移。
- 金額に添える文（「計画より原価が少ない」等）の判定は、表示に丸めた後の値で行う（「±0.0百万円」なのに「少ない」と出さない）。
- Excel 出力の金額は単位に関係なく円の整数。
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

---

# 2回目リリースの追加仕様（2026-10-28）

範囲: チーム詳細（§16）、顧客別（§17）、メンバー別（§18）、マスタ編集（§19）、本番APIの列名対応（§20）。
画面の共通ルール（数値列の並び・赤の条件・根拠ボタン・Excel 出力・URL 状態）は初回と同じ（`docs/UI_NOTES.md`）。

## 16. チーム詳細 `/team?id=<teamId>`

問い: 「このチームはなぜ悪いか」。
- 母集団 = §11 と同じ（`contract.teamId` が自分または配下の契約。組織の基準月は `min(期間の終了月, asOf 月)`）。`id=__unassigned__` は「未設定」グループ。
- 構成: パンくず（上位チームを辿れる）→ KPI（初回の全体サマリーと同じ5枚）→ 月次推移 → 配下チーム（直下の子ごとの行。子が無ければ出さない）→ 契約一覧（チームの契約のみ）→ メンバー別原価（このチームの契約に工数を付けた人。所属チームが別でも含める＝作業実績軸）→ 組織の変遷（期間内に親・名前が変わった場合だけ、月と内容を列挙）。
- 存在しない ID・期間内に存在しないチームは空状態で「このチームは選択期間の組織にありません」とし、チーム一覧へのリンクを出す。
- チーム一覧の行・全体サマリーのチーム別の行からチーム詳細に遷移できるようにする（初回の「契約一覧に絞り込み」はチーム詳細内のリンクに移す）。

## 17. 顧客別 `/customers`、`/customer?key=<customerKey>`

問い: 「どの顧客が悪いか」「この顧客の契約はどうか」。
- 顧客キー `customerKey = normalizeName(contract.customerName)`（§4.1）。表示名はそのキーの契約のうち **契約ID昇順で最初の契約の `customerName`**。キーが空の契約は「顧客名なし」グループ（キー `__none__`）。
- 一覧: 顧客ごとに契約数（期間内）・標準数値列（予算・原価・粗利・粗利率・消化率・着地粗利）・状態チップ（赤字見込み件数・予算超過）。チームで絞り込める（チームの契約に限定した顧客集計）。検索欄（`normalizeName` で部分一致）。
- 詳細: KPI → 月次推移 → 契約一覧（その顧客の契約）→ 担当チーム別（契約の `teamId` ごと）。
- 前年同期比は初回と同じ規則で KPI に出す（前年データが無い間は「比較データなし」）。

## 18. メンバー別（人ごとの予実） `/members`、`/member?id=<memberId>`

要件: 人ごとの予＝配分人月×基準時間×単価（2026-10-27 決定）。実＝その人の工数原価。

### 18.1 計算
メンバー x、月 m、契約 c:
```
plannedHours(x,c,m) = Σ_{a: a.memberId=x, a.contractId=c, a.startMonth<=m<=a.endMonth} a.allocation × standardHoursPerMonth
plannedCost(x,c,m)  = round(plannedHours(x,c,m) × 単価(x,m))        // §6 の単価。行(x,c,m)ごとに四捨五入
actualHours(x,c,m)  = 契約 c・月 m の CostLine のうち memberId=x の hours
actualCost(x,c,m)   = 同 CostLine の amount
```
- 契約期間外の月のアサインは数えない（`plannedHours = 0`。`CONTRACT_INVALID` の契約も同様）。
- メンバー月の合計 = Σ_c。`variance = plannedCost − actualCost`（正 = 計画より原価が少ない）。
- 稼働率 `utilization = actualHours / plannedHours`（分母 0 → null）。100% 超を赤にはしない（赤は §12 の 2 つだけ）。表示のみ。
- 未アサインの工数（アサインの無い契約に付けた工数）は `unplannedHours / unplannedCost` として別に持つ。
- メンバーの所属・役職・単価は §5 の有効レコード（当時の値）。所属チームは期間の終了月の値で表示し、月ごとの値は内訳に出す。
- `members.csv` に無いが工数のある ID も行に出す（名前は作業ログの `member_name`、`UNKNOWN_MEMBER` と同じ扱い）。
- 計算はコアに置く: `Model.memberMonths: MemberMonth[]`（x, m ごと。契約別の内訳 `byContract[]` を持つ）を `buildModel` で作り、画面は期間で合算する `aggregateMembers(model, scope)` を使う。

### 18.2 画面
- 一覧 `/members`: メンバーごとに 所属チーム・役職・計画時間・実績時間・稼働率・計画原価・実績原価・差額。チーム絞り込みは「所属チーム（期間の終了月）」。検索欄。
- 詳細 `/member?id=`: 基本情報（所属の変遷）→ KPI（計画原価・実績原価・差額・稼働率）→ 月次推移（計画と実績の時間）→ 契約別（計画・実績・差額。アサイン無しの契約は「アサインなし」チップ）→ 単価の変遷。
- 計画・実績の数値はすべて根拠ボタン（`allocation × 基準時間 × 単価`、CostLine）を持つ。
- 比較（計画・実績・差額・稼働率）の母集団は **経過月**（期間内で `m <= asOf 月`。§11 の消化率と同じ）。未来月には実績が無いので、期間全体の計画と比べると稼働率・差額が見かけ上よくなるため。期間全体の計画は KPI の補足と月次推移で別に示す。期間がすべて未来のときは期間全体（実績 0）で表示し、その旨を注記する。（2026-10-28 追記）

## 19. マスタ編集 `/masters`

対象: `data/masters/members.csv`（所属・役職・チーム）、`data/masters/rates.csv`（単価）、`data/masters/teams.csv`（チーム）、`data/assignments.csv`（アサイン）。編集はリーダー層（GitLab の Developer 以上）だけが実際に保存できる。閲覧は誰でも可。

### 19.1 編集の考え方
- 履歴マスタ（§5）は **行を追加する** のが基本操作（「4月から単価変更」= 新しい `effective_from` の行を足す）。既存行の修正・削除もできるが、過去月の数値が変わる操作には確認ダイアログで「過去の計算結果が変わります（影響: N か月）」と出す。
- 確認ダイアログの「何が変わるか」は、過去の月で **実際に値が変わる列** に応じて出し分ける（一律に「原価・粗利など」と書かない）:
  - メンバーの `title`（役職）・単価の行 → 時間単価と、原価・粗利・消化率・着地見込み
  - メンバーの `team_id` → 所属チームによる組織別の集計（メンバー別の所属・チームでの絞り込み、チーム詳細の応援の区別）。`department` / `section` → 部署・課の表示。`name` → 氏名の表示。`kind` → 区分の表示。これらだけの変更では「原価・粗利・消化率・着地見込みは変わりません」と明記する
  - チームの `parent_team_id` → 組織の木と上位組織の合計。`name` → チーム名の表示
  - アサイン → 着地見込み（アサイン方式）とメンバー別の計画
  - その月の有効な行が増える・無くなる（キー・適用開始月の変更、追加・削除）ときは、無い側を全列空として比べ、キー列（登録の有無）も変わったものとして扱う。`effective_from` だけが変わり値が同じ月は「変わる月」に数えない
- 保存前にブラウザ内で `parseDataset` + `validateDataset`（§14 と同じ）を編集後のデータに対して実行し、error があれば保存ボタンを押せない（理由を行に表示）。warning は表示のみ。
- 変更差分（追加・変更・削除の行）を保存前に一覧で見せる。
- CSV の書き出しは列順・改行コード（LF）・UTF-8（BOM なし）を固定し、変更していない行はバイト単位で元のまま残す（差分を最小にする）。

### 19.2 保存方式（config `masterEdit`）
```jsonc
"masterEdit": {
  "mode": "gitlab",           // "gitlab" | "download"
  "gitlab": {
    "apiBaseUrl": "",         // 例 https://gitlab.example.local/api/v4（空なら Pages の URL から推定しない。download に自動で落とす）
    "projectId": "",          // 数値ID または "group/project"
    "targetBranch": "main",
    "commitMode": "mr"        // "mr"（ブランチを作り MR を作成）| "direct"（targetBranch へ直接コミット）
  }
}
```
- `gitlab` モード: 利用者が自分の Personal Access Token（scope `api`）を入力する。トークンは `sessionStorage` にのみ保存し（タブを閉じると消える）、画面に再表示しない。`POST /projects/:id/repository/commits`（`actions[]` で複数ファイルを1コミット、各 action に `last_commit_id` を付けて競合を検出）。`mr` のときは `start_branch=targetBranch`、`branch=masters/<YYYYMMDD-HHmmss>-<user>` で新ブランチにコミットし、`POST /projects/:id/merge_requests` で MR を作る。結果画面に MR/コミットのリンクを出す。
- 競合（他の人が先に更新、HTTP 400 で last_commit_id 不一致）・権限不足（401/403）・ネットワーク/CORS 失敗は、それぞれ人が読める文で案内し、**編集内容を失わない**。CORS/ネットワーク失敗時は「CSV をダウンロードして GitLab 画面からアップロード」に切り替えるボタンを出す。
- `download` モード（または API が使えないとき）: 変更したファイルを CSV でダウンロードさせ、GitLab の Web IDE／ファイル画面でアップロードする手順を画面に表示する。
- ビルド時に `src/data/masters.json.ts` が各ファイルの生テキストと、そのファイルの最終コミットID（`git log -1 --format=%H -- <path>`。取れなければ null）を出す。編集の土台はこの生テキスト。
- 編集中の内容は `localStorage`（`yojitsu-navi:masters-draft:v1`）に下書き保存し、再訪時に復元を提案する。下書きは **「土台（生テキストと最終コミットID）＋差分（追加・変更・削除の行）」** として持つ。
- 土台が今のビルドと違う（他の人が先に更新した）下書きを復元するときは、「元データが更新されています」と示したうえで、下書きの差分を **最新の土台に当て直す**（rebase）。復元後の編集・保存・ダウンロードの土台は常に最新のビルドで、古い土台のまま保存・ダウンロードすることはない。
  - 当て直しは決定的な純粋関数で行う。下書きの土台と最新の土台の行を対応付け（同じ内容の行を順序を保って最長一致で対応させ、対応しない行は同じキー列の行どうしを対にする）、最新側で変わっていない行には下書きの変更・削除をそのまま当てる。追加した行は末尾に足す。
  - 下書きで変更・削除した行が、最新側でも変更・削除されていれば **衝突** とし、行ごとに「自分の下書き」と「最新のデータ」を並べて、どちらを残すか利用者に選ばせる（全部選ぶまで復元しない）。両方が同じ値に変えた・両方が削除した行は衝突にしない。
  - 当て直した結果を同じ土台でもう一度当て直しても結果は変わらない（冪等）。
- GitLab 保存が競合で止まったときは「他の人の更新がビルドされたあとに再読み込みすると、下書きを最新のデータに当て直して復元できる」と案内する。`download` モードでは、画面の元データのコミットIDを示し、GitLab 上のファイルがそれより新しければアップロードせずに再読み込みするよう案内する。

## 20. 本番 API の列名対応（取り込みアダプタの設定化）

本番の作業実績 API・所属データの仕様は本番でしか確認できないため、**コードを変えずに config だけで合わせられる** ようにする。

### 20.1 作業実績（`worklogSource.http` の拡張）
| 項目 | 意味 | 既定 |
|---|---|---|
| `columns.<field>` | 取得元の列名。ドット区切りで入れ子（`member.id`）。配列で複数候補（最初に値があるもの） | 現行どおり |
| `dateFormat` | `YYYY-MM-DD` / `YYYY/MM/DD` / `YYYYMMDD` / `ISO8601`（時刻付き。JST に変換して日付） / `epochMillis` | 自動判定（左から順に試す） |
| `hoursUnit` | `hours` / `minutes` / `seconds` | `hours` |
| `pagination` | `{ type: "none" }` / `{ type: "page", pageParam, sizeParam, size, startPage }` / `{ type: "offset", offsetParam, limitParam, limit }` / `{ type: "link" }`（`Link: rel="next"`）/ `{ type: "cursor", cursorPath, cursorParam }` | `none` |
| `query` | 追加のクエリ文字列（固定値）。`{from}` `{to}` `{fromDate}` `{toDate}` を置換 | 無し |
| `filters` | 取り込まない行の条件 `[{ column, equals | notEquals | in }]` | 無し |
| `encoding` | CSV 応答の文字コード（`auto` / `utf-8` / `shift_jis`） | `auto` |
- 列が見つからないときはエラーで止め、**応答の最初の1行の列名一覧** を出す（設定ミスを見つけやすくする。値は出さない）。
- `npm run fetch -- --dry-run --sample=5` で、取得→変換結果の先頭 N 行と列の対応表を表示し、ファイルを書かない（本番での初回設定用）。
- 設定は `config.json`（コミットする）、トークンは環境変数のみ。

### 20.2 所属・役職の取り込み（`memberSource`）
所属部署・課・役職は人事系の元データから取り込む（2026-10-27 決定）。`memberSource` は `worklogSource` と同じ仕組み（`adapter: csv | http | none`、`columns`、`pagination` 等）で `memberId, name, kind, title, department, section` を取得し、`npm run fetch:members` で `data/masters/members.csv` を更新する。
- `team_id` は取り込まない（画面で手入力）。取り込み結果と現在の有効レコードを比べ、`name/kind/title/department/section` のどれかが変わった人だけ `effective_from = 取り込み実行月` の新しい行を追加する（`team_id` は直前の有効レコードを引き継ぐ）。変化が無ければ何もしない（冪等）。
- 取り込みに無い既存メンバーは削除しない（退職者の過去月を壊さない）。件数を表示する。
- `memberSource.adapter = "none"`（既定）の間は従来どおり手入力。マスタ編集画面は `memberSource.adapter != "none"` のとき取り込み対象列を読み取り専用にする。
