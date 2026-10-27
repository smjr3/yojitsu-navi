# UI レビュー（画面層の指摘）

対象: `src/components/*.js`, `src/*.md`, `src/data/*.ts`, `observablehq.config.js`, `src/style.css`（2026-10-27 時点の作業ツリー）。
重大度順。各項目に 再現シナリオ / 期待と実際 / 最小の修正案 を書く。

## High

### 1. 合計行（tfoot）の数値ボタンが壊れている（クリックで例外、または 0 件の内訳）
- **場所**: `src/components/table.js:285-292`（`cellNode(col, summary)` を行と同じ `breakdown(row)` で呼ぶ）、`src/contracts.md:470-512`、`src/contract.md:179-200`
- **シナリオ**: 契約一覧の合計行で「着地粗利」をクリック → `bd.forecastSpec({forecast: undefined})` → `forecast.breakdown` で TypeError、ダイアログが開かない（コンソールエラー）。同じ合計行の「予算」「原価」は `contractIds: [undefined]` で集計されるため「対象契約 0件・合計 0円」と表示され、セルの数値と矛盾する。契約詳細の「月ごとの予実」合計行の「予算」「原価」も `cm: undefined` で `cm.budgetBreakdown` の TypeError。
- **期待**: 合計行は根拠なし（プレーン表示）か、合計用の spec（`budgetAggregateSpec({contractIds: 表示中の契約ID})` など）を開く。
- **修正案**: `dataTable` に `summaryBreakdown?: (col) => spec` を追加し、`summary` 行では `col.breakdown` を使わない（`cellNode` に `isSummary` を渡して `breakdown` をスキップ）。contracts.md では合計行用に `budgetAggregateSpec({contractIds: rows.map(r=>r.contractId)})` 等を渡す。

### 2. 年度外の未来月が「原価（実績）0円・粗利=予算」として表示される
- **場所**: `src/components/analysis.js:96-104`（`forecastCost` は `remainingMonths`＝年度内のみ）、`src/components/charts.js:132-145`（`seriesTable` は `forecastCost === null` を「実績」とみなす）、`charts.js:33,79-80`
- **シナリオ**: 契約期間 2026-10〜2027-09 の契約詳細で期間を 2027-09 まで広げる（または全体サマリーで `to=2027-09` を指定し、データ範囲がそこまである場合）。2027-04 以降は `status: future`、`forecastCost: null` → 表では「原価（実績）0円」「粗利 = 予算額」、グラフは予算棒だけで原価も粗利線も無し。
- **期待**: 年度外の未来月は「原価 —／粗利 —（見込み対象外）」と明示する。
- **修正案**: `seriesTable` で `d.status === "future" && d.forecastCost === null` のとき cost/grossProfit を `null` にし「年度外」と注記。グラフでも同じ月は予算棒を薄くするか注記を出す。

## Medium

### 3. 前年同期比の差分が、タイルに表示している値と別の集計で計算されている
- **場所**: `src/index.md:77-95`、`src/components/analysis.js:109-121`
- **シナリオ**: 既定（FY2026 全期間、asOf 2026-10）。「年度予算」タイルは 12 か月分の予算、下の「+1,234,000円 前年同期（2025年4月〜2025年10月）比」は **経過 7 か月分** の差。粗利タイルも同様。値と差分の母集団が違うのでミスリード。
- **期待**: 差分は表示値と同じ集計（期間全体）か、タイル側に「経過月ベース」と明記。
- **修正案**: `cmp()` のテキストを「経過月（4〜10月）累計の前年同期比」にする、または前年同期比の `current` を `scope.period` 全体にし、未来月は予算のみ比較する。

### 4. 前年同期のデータが部分的にしか無いと黙って「比較データなし」
- **場所**: `src/components/analysis.js:116`（`prior.from < meta.minMonth → null`）
- **シナリオ**: 契約データが 2025-06 から始まる。既定期間 2026-04〜 の経過月は 2026-04〜2026-10 → 前年 2025-04〜2025-10、`prior.from(2025-04) < minMonth(2025-06)` で null。`hasPriorYearData` は true なのに全タイルが「前年同期の比較データなし」。
- **期待**: 比較可能な月だけで比較し「一部の月のみ（2025-06〜）」と注記する、もしくは理由を表示する。
- **修正案**: `prior.from` を `max(prior.from, minMonth)`、`current.from` も同じ分ずらして比較し、`partial: true` を返して UI で注記する。

### 5. グラフ用の月割り見込み原価がコアの `remainingCost` と一致しない（UI_NOTES の「最大 1 円」は誤り）
- **場所**: `src/components/analysis.js:78-88`
- **シナリオ**: recent3 で平均 0.5 円（極端だが整数の端数は常に起こる）、残り 5 か月。コア `remainingCost = round(0.5×5) = 3`。画面は月ごとに `round(0.5)=1` を 5 回 → 5。契約数×残り月数に比例してずれるので、月次推移表の「原価（見込み）」合計と KPI の着地原価が数円〜数十円ずれる。
- **期待**: 月割りの合計 = `remainingCost`。
- **修正案**: 契約ごとに残り月に `remainingCost` を均等割り（最終月に端数）してから月ごとに合算する（予算の月割りと同じ規則）。コアに `remainingCostByMonth` を追加するのが本筋。

### 6. キーボード操作で並べ替え・木の開閉をするとフォーカスが消える
- **場所**: `src/components/table.js:177-182`（`renderHead()` が thead を丸ごと差し替え）、`table.js:215-220`（`renderBody()` が押したボタンを破棄）
- **シナリオ**: チーム一覧で Tab で「▾ 事業部の配下を閉じる」に移動し Enter → 行が再描画され `document.activeElement` が body に戻る。次の Tab はページ先頭から。契約一覧のソートボタンも同様。
- **期待**: 操作後も同じボタンにフォーカスが残る。
- **修正案**: 再描画後に `thead.querySelector(`[data-key="${col.key}"] button`)?.focus()` / `tbody.querySelector(`tr[data-key="${row.key}"] .yn-tree-toggle`)?.focus()` を呼ぶ。または `aria-expanded`/テキストだけを更新して行を差し替えない。

### 7. 作業ログ明細の動的パスは英数字・`_`・`-` の契約IDしか生成しない
- **場所**: `observablehq.config.js:131-132`、`src/components/breakdown.js:496`、`src/contract.md:319`（Excel のファイル名）
- **シナリオ**: `contract_id = "C2026/01"` や `"契約001"`。ビルドは成功するが `dist/data/worklogs/` に出ないので、契約詳細の「作業ログを読み込む」と原価内訳の「作業ログを読み込む」が常に HTTP 404。`validate-data` も止めない。Excel のファイル名 `contract_C2026/01_monthly.xlsx` も `/` で保存失敗になるブラウザがある。
- **期待**: ID 制約を validate-data で検証するか、どの ID でも配信できる。
- **修正案**: `contractIds()` の正規表現を外して `encodeURIComponent(id)` をパスに使う（`[contractId].json.ts` 側は `decodeURIComponent`）。`exportName` は `id.replace(/[\\/:*?"<>|]/g, "_")`。

### 8. チーム選択肢は asOf 時点の組織、集計は期間終了月の組織（さらに既定では未来月）
- **場所**: `src/components/filters.js:173-190`、`src/components/analysis.js:46-56`、`src/teams.md:303-305`
- **シナリオ A**: 2026-11 に新設されたチーム（`effectiveFrom=2026-11`）を選び、期間を「直近3か月」（〜2026-10）にする → `tree` に無く `contractsForTeam` が `[]` → KPI 全部 0 円、「配下のチームはありません」。なぜ 0 かの説明が無い。
- **シナリオ B**: teams.csv に 2027-04 の組織改編を先行登録。既定期間（FY2026 → `to=2027-03`）は影響しないが、`to` を 2027-04 以降にすると **まだ発効していない組織**で集計される。teams.md の注記は `to !== asOfMonth` で出るので、既定状態（to=2027-03）でも「過去月の組織は…」と出て内容が合わない。
- **期待**: 組織の基準月を `min(period.to, asOfMonth)` にする（未来の組織は使わない）。選んだチームが基準月に存在しないときは注記を出す。
- **修正案**: `scopeFor` の `treeAt(model, period.to)` を `treeAt(model, period.to < asOfMonth ? period.to : asOfMonth)` に。`state.team && !tree[state.team]` のとき `note("選択したチームは <月> 時点の組織に存在しません")`。teams.md の注記条件は `period.to < asOfMonth`。

### 9. 契約一覧の検索は 1 文字ごとに表全体を作り直し、フィルタ変更で検索欄も作り直す
- **場所**: `src/contracts.md:411-447`（`chips` セルが `vm` に依存）、`contracts.md:451-515`（`listState` が変わるたび `dataTable` 全体を再構築）
- **シナリオ**: 契約が 300 件になると、1 文字入力ごとに 300 行 × 10 列の `numberButton` を生成（数千ノード）。また期間や単位を変えると `chips` セルが再評価され、検索欄が再生成されてフォーカスを失う（値は `listFilter` に残る）。
- **期待**: 入力はデバウンスし、検索欄は 1 回だけ描く。
- **修正案**: `chips` の依存を `model` だけにする（`vm` の null チェックを `model` に）。`text` の `input` を 150ms デバウンス。`dataTable` に `setRows(rows)` を追加して行だけ差し替える。

## Low

### 10. マイナス記号が 2 種類混在する
- **場所**: `src/core/money.ts:22`（Intl ja-JP は U+002D "-634,200円"）と `src/components/format.js:411,420`（U+2212 "−"）
- **シナリオ**: 粗利タイルの値が「-634,200円」、下の前年比が「−12,000円」。同じタイルで記号が違う。
- **修正案**: `formatYen`/`formatPercent` の結果で先頭の "-" を "−" に置換するか、`moneySigned` も "-" に統一する。

### 11. Excel 出力の千円は行ごとに丸めるので合計が合わない
- **場所**: `src/components/table.js:46`
- **シナリオ**: 単位=千円で作業ログ表を出力。400 円の行は 0 千円、合計を Excel で SUM すると画面の合計と数千円ずれる。
- **修正案**: 金額は常に円で出力し列名を「（円）」にする（単位は表示だけの都合）。千円が必要なら Excel 側で割る。

### 12. 月次推移表の「原価（実績）」列の Excel 値が表示と違う
- **場所**: `src/components/charts.js:143`（render は速報値を出すが export は `r.cost = null` → 空欄）
- **修正案**: `exportValue: (r) => r.cost ?? r.actualCostPrelim` を追加。

### 13. ダークモードの「問題なし／確定」チップのコントラストが 4.3:1
- **場所**: `src/style.css:80-81, 112-113`（`#0ca30c` on `#10300f`、12px semi-bold）
- **期待**: 4.5:1 以上。
- **修正案**: `--yn-good-text: #2fbf4a` 程度に明るくする（約 6:1）。

### 14. チーム行の「契約数」と「着地粗利」の母集団が違う
- **場所**: `src/components/analysis.js:154-180`
- **シナリオ**: 期間を前年度にすると `contractCount`（期間内の契約）は 3 件、`forecastTotals` は当年度の全契約（期間外含む）で計算。契約数 0 でも着地粗利が出る。
- **修正案**: 列ラベルを「契約数（期間内）」にし、着地側の件数を内訳に出す（既に forecastTotalsSpec にはある）。

### 15. 合計行の消化率が「—」固定
- **場所**: `src/contracts.md:498`
- **修正案**: `aggregate(model, {period, contractIds: rows.map(r => r.contractId)})` の `burnRate` を使う（1 回の走査）。

### 16. URL に一部のキーしか無いと残りは閲覧者の localStorage で埋まる
- **場所**: `src/components/state.js:326-328`
- **シナリオ**: 手で `?team=T111` だけ共有 → 受け取った人の前回の期間・単位で表示される。アプリが作る URL は常に 5 キー揃うので通常は起きない。
- **修正案**: クエリに 1 つでもキーがあれば localStorage を無視する（`fromQuery ? {...defaults, ...fromQuery} : fromStorage`）。

### 17. フィルタ変更は replaceState なので「戻る」で元の条件に戻れない
- **場所**: `src/components/state.js:312-316`
- **シナリオ**: 期間を 3 回変えて Back → 前のページへ移動。設計判断としては妥当だが、UI_NOTES に明記されていない。
- **修正案**: 現状維持なら UI_NOTES に記載。pushState にするなら `popstate` で `store.set(readQuery())`。

### 18. 速報月（基準月）の実績原価がグラフの棒に出ない
- **場所**: `src/components/charts.js:33,75`（`isActual = month < asOfMonth`）
- **シナリオ**: 10 月 27 日時点で 10 月の原価が既に予算を超えていても、棒は「見込み（平均）」だけで、実績はツールチップの「速報実績」にしか出ない。
- **修正案**: 基準月は実績棒（点線枠）＋見込み棒を重ねるか、`max(実績, 見込み)` を使う。

### 19. 検索が NFKC 正規化されない
- **場所**: `src/contracts.md:454,460`
- **シナリオ**: 顧客名「ＡＢＣ商事」を "abc" で検索してもヒットしない（コアには `normalizeName` がある）。
- **修正案**: 両辺を `normalizeName()` で比較する。

### 20. 未設定グループの扱いがページで違う
- **場所**: `src/index.md:196-199`（契約が無ければ非表示）、`src/teams.md:274-275`（常に表示）
- **修正案**: どちらかに揃える（SPEC §11 は「末尾に表示」なので teams.md に合わせ、index も 0 件で表示するか、両方で非表示にする）。

### 21. 細かい重複実装（コアと同じ式を画面で再計算）
- `src/contracts.md:498`、`src/contract.md:172,199`、`src/components/breakdown.js:664-673` で `grossMargin = (budget-cost)/budget` を再計算。`src/index.md:101` で `cost/budget`。今は一致しているが、コアが変わると追従漏れの温床。
- **修正案**: 合計行は `aggregate()` の結果（Totals）を渡す。`marginSpec` は `totals.grossMargin` を受け取る。

### 22. 無意味なコード
- `src/contract.md:30` `createStore(model, result ? { initial: {} } : {})` は `createStore(model)` と同じ。
- `src/components/filters.js:276` `filterSummary` は未使用。

## 確認して問題なかった点（記録のみ）
- URL > localStorage > 既定の優先順位、from/to の clamp と逆転の入れ替え、未知チーム・不正 unit/method の既定化（`state.js:263-278`）。
- 千円表示は「合計してから丸める」（表の合計行・作業ログ合計・KPI）。
- `burnRate`/`grossMargin` null → "—"、0 予算契約の扱い。
- `<dialog>` は 1 つを使い回し、`showModal` + 閉じたら opener にフォーカスを戻す。リスナーの増殖なし。フィルタ行は `store` のみに依存し 1 回だけ描画。
- 組み込み名（`view`, `html`, `Plot`）との衝突なし。外部 URL（CDN・Web フォント）なし。絶対パス `/...` や `location.origin` の使用なし。作業ログの取得は `import.meta.url` 相対でサブパス配信に耐える。
- `contracts.csv` の BOM / CRLF は `observablehq.config.js:125-126` で処理済み。
- 並べ替えは元の順序で安定化（`table.js:162-165`）、null は常に末尾。
- 契約 ID 未指定・不明、契約 0 件、期間と重ならない契約の空状態あり。
