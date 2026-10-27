# 画面（UI）実装メモ

Observable Framework 1.13 で作った画面側の構成と決定事項。計算は `src/core/`（純粋関数）に任せ、画面は「どの契約を・どの期間で」を決めて表示するだけにしている。

## 全体像

```
src/
  data/
    _shared.ts                   データローダ共通（data/ を読んで buildModel。asOf = YOJITSU_AS_OF か今日(JST)）
    model.json.ts                画面が読む Model。ContractMonth.worklogs を空にして軽量化（540 KB / ダミーデータ）
    worklogs/[contractId].json.ts 契約ごとの作業ログ明細（遅延取得用）。observablehq.config.js の dynamicPaths で列挙
    dataset-issues.json.ts       データ確認ページ用: CSV 読み込みの問題 + validateDataset（validate-data.ts と同じ内容）
  components/                    フレームワーク非依存の ESM（htl の html`` で DOM を組む）
    format.js      金額・割合・時間・月・日時の書式。単位 "yen" | "k"（千円）を core の MoneyUnit に変換
    state.js       期間・チーム・単位・着地方式の状態 ⇄ URL クエリ ⇄ localStorage
    analysis.js    scope（期間×チーム）の決定、前年同期比、契約行／チーム行の組み立て、見込み原価の月割り
    layout.js      ページヘッダ（基準日・取得日時・速報バッジ・パンくず）、空／エラー／読み込み状態、loadJson
    kpi.js         KPI タイル（値・ラベル・比較・状態チップ）
    breakdown.js   計算根拠パネル（<dialog>）と各 spec の組み立て、作業ログ明細の遅延取得
    table.js       一覧表（並べ替え・固定ヘッダ・右寄せ・状態チップ・行クリック・Excel 出力・木構造）
    charts.js      Observable Plot のグラフ（月次推移）、凡例、表の双子、消化率メーター
    filters.js     フィルタ行（期間＋プリセット、チーム、着地方式、単位）
  index.md / teams.md / contracts.md / contract.md / rules.md / data-check.md
  style.css        デザイントークン（ライト／ダーク）とスタイル
```

## ページの構成（一画面一問）

| ページ | 問い | 構成 |
|---|---|---|
| `/` 全体サマリー | 会社全体（or 選んだチーム）は今どうか | KPI 5 枚（年度予算・原価・粗利＋粗利率・消化率・着地見込み粗利＋赤字件数）→ 月次推移 → 赤字見込み契約 → チーム別 |
| `/teams` チーム一覧 | どの組織が悪いか | 組織木（折りたたみ可、上位は配下の合計）＋ 未設定。行クリックで契約一覧に絞り込み |
| `/contracts` 契約一覧 | どの契約が悪いか | 並べ替え可能な一覧 ＋ 絞り込み（赤字見込み／消化率超過／速報含む／期間外も表示／検索）＋ 合計行 |
| `/contract?id=` 契約詳細 | この契約はなぜ悪いか | 基本情報 → KPI → 月次推移 → 月ごとの予実 → メンバー別原価 → 3 方式の着地比較 → 作業ログ（遅延読み込み） |
| `/rules` 計算ルール | 数値はどう計算されているか | SPEC を人向けに。config.json の値を `${...}` で差し込む |
| `/data-check` データ確認 | 数値の精度を下げている要因は何か | 未紐付け・単価なし・不明メンバー・除外・警告一覧・検証結果 |

すべての一覧の数値列は同じ順序: **予算・原価・粗利・粗利率・消化率・着地粗利**（`table.js` の `standardColumns()`）。
赤は **消化率 > 閾値** と **着地が赤字** の 2 つだけ（色 ＋ ▲ ＋ 文字）。黄色は使わない。速報は点線のチップ、確定は ●。

## 状態と URL

`state.js` の `createStore(model)`:

| キー | 値 | 既定 |
|---|---|---|
| `from`, `to` | `YYYY-MM`（`meta.minMonth`〜`maxMonth` に収める。逆転は入れ替え） | asOf の年度をデータ範囲に収めたもの |
| `team` | チームID / `""`（全体）/ `__unassigned__`（未設定） | `""` |
| `unit` | `yen` / `k`（千円） | `config.currency.defaultUnit` |
| `method` | `recent3` / `all` / `assignment` | `config.forecastMethodDefault` |

優先順位は **URL クエリ > localStorage（`yojitsu-navi:state:v1`） > 既定値**。変更は `history.replaceState` で URL に、同時に localStorage に書く。初回表示でも URL を正規化するので、そのまま共有できる。
フィルタ変更は履歴に積まない（`replaceState`）設計なので、ブラウザの「戻る」は直前の条件ではなく前のページに戻る（条件を残したいときは URL をそのまま共有・ブックマークする）。
契約詳細の `id`、契約一覧の `f`（`deficit|over|prelim`）と `q`（検索）はストアの外（ページ固有）。`store.href("./contracts", {team}, {id})` で状態を引き継いだリンクを作る。

ページでは `Generators.observe` でストアを反応的な値 `state` にし、`vm`（view model）セルで `scopeFor()` → 集計 → 各セルが再描画される。フィルタ行は 1 回だけ描き、ストアを購読して自分の表示を同期する（フォーカスを失わない）。契約一覧の絞り込みフォーム（チップ・検索欄）も `model` だけに依存して 1 回だけ描き、検索は 150ms デバウンス、両辺をコアの `normalizeName()`（NFKC・小文字化・法人格除去）で正規化して部分一致する。

`scopeFor()` が返す組織木の基準月は **`min(期間の終了月, 基準月)`**（未来に発効する組織では集計しない）。選んだチームがその月の組織に無いときは `scope.teamMissing` で注記を出す。「未設定」（チーム無し）の行は、全体サマリーとチーム一覧とも **期間内に契約があるときだけ末尾に表示** する。

> 注意: Observable のセル名に `view`, `width`, `dark`, `html`, `Plot` など組み込み名を使わない（`view` を使うと組み込みの `view()` と衝突して undefined になる）。

## ライブラリの読み込み（CDN なし）

- `html` は `import {html} from "htl"`、Plot は `import * as Plot from "@observablehq/plot"`、Excel は `await import("xlsx")`（表の Excel 出力時に初めて読む）。いずれも node_modules から `dist/_node/` に同梱される。
- 組み込みの `html` / `Plot` / `d3` / `Inputs` を **暗黙に** 使うと `npm:` 経由（CDN）になるので、必ず明示的に import する。`FileAttachment`, `Generators`, `resize`, `dark` は Framework 組み込み（CDN 不要）。
- 計算コアは `import {...} from "./core/index.js"`（拡張子は `.js`。Framework が `.ts` を見つけてトランスパイルする。`.ts` と書くと解決されない）。
- ビルド後の `dist/` に `_npm/` が無いことが「CDN 不要」の確認になる。

## データの流れ

1. `npm run build` → `src/data/model.json.ts` が `data/` を読み `buildModel()`。`asOf` は `YOJITSU_AS_OF`（CI で固定したい場合）か今日（JST）。
2. `model.json` には `worklogs` 明細を含めない（`costLines` までは含む）。明細は `src/data/worklogs/[contractId].json.ts` が契約ごとに出力し、`observablehq.config.js` の `dynamicPaths` が `data/contracts.csv` の契約ID から `/data/worklogs/<id>.json` を列挙する。
3. 画面は `breakdown.js` の `fetchWorklogs(id)` で必要なときだけ取得する。ビルド済みサイトでは `/data/worklogs/<id>.json`、`npm run dev` では `/_file/data/worklogs/<id>.json` で配信されるので順に試す（プレビューでは最初の 404 がコンソールに出るが動作に影響なし）。契約 ID はパスに入れる前に `encodeURIComponent` する（`dynamicPaths` 側も同じ。ローダは `decodeURIComponent` で元に戻す）ので、`/` や空白を含む ID でも列挙から漏れない。Excel のファイル名も `safeFileName()` で `\ / : * ? " < > |` を `_` に置換する。
4. 生成物の大きさ（ダミーデータ）: `model.json` 540 KB、`dataset-issues.json` 6 KB、作業ログ明細は契約ごとに 1 KB〜650 KB（合計約 4.3 MB、`dist/` 全体 6.3 MB）。

## 計算根拠パネル（breakdown.js）

数値は `numberButton(text, spec)` で描く（`<button class="yn-num">`）。`spec` は `{title, formula[], rows[{label,value,note}], sections[{title,text,table,lazy}], note}`。関数を渡すと開いたときに計算する（表の全セルで事前計算しない）。
spec の組み立て関数: `budgetMonthSpec` / `budgetAggregateSpec` / `costMonthSpec`（原価行 → 作業ログを遅延読み込み）/ `costAggregateSpec` / `grossProfitSpec` / `marginSpec` / `burnRateSpec` / `forecastSpec`（方式・月・平均・アサイン明細）/ `forecastTotalsSpec` / `hoursSpec`。
`<dialog>` は 1 つを使い回す。`showModal()` なので Esc で閉じる・フォーカスがダイアログ内に閉じる・閉じたら元のボタンに戻るのはブラウザ標準。

## 表（table.js）

`dataTable({columns, rows, unit, sort, rowHref, caption, exportName, tree, summary, summaryBreakdown, maxHeight})`。
列は `{key, label, sublabel, type: money|percent|hours|int|status|text, get, render, sortValue, exportValue, breakdown, hideOnPhone, hideNarrow}`。`sublabel` は見出しの 2 行目（「（期間内）」「（年度内）」など母集団の注記。幅を増やさない）。
`<th scope="col">` にソートボタンと `aria-sort`、先頭列は `<th scope="row">`。行クリックは `rowHref` のリンク（キーボードはリンクで到達）＋行全体のクリック。並べ替え・木の開閉で thead/tbody を描き直したあとは `data-key` で同じボタンにフォーカスを戻す（キーボード操作が途切れない）。
合計行（`summary`）は行用の `breakdown(row)` を使わず、`summaryBreakdown(col)` が spec を返す列だけ根拠ボタンになる（契約一覧は表示中の契約 ID を母集団に `aggregate()` / `forecastTotals()` で合計し、同じ ID 集合で根拠を開く。契約詳細の月表の合計行は KPI と同じ `Totals` を表示し、根拠ボタンは付けない）。
Excel 出力は **今見えている行（並べ替え・絞り込み後）** を `.xlsx` に。金額は **表示単位に関係なく常に円の整数**（列名「…（円）」、1 行目に「単位: 円」の注記、2 行目が見出し）。千円表示は画面だけの都合で、行ごとに丸めた値を出力して合計がずれることを避ける。割合は % の数値、月は `YYYY-MM`。
幅の工夫（1280px・サイドバー開で標準列がスクロール無しで収まるように）: 先頭列は `position: sticky`（横スクロール時も名前が残る）、横スクロールが必要なときは両端に影とツールバーに「横にスクロールできます」を出す（`.yn-table-scroll.is-scrollable`）。契約一覧・赤字一覧は「顧客 / 案件」と「ID・チーム・期間（YY/MM）」の 2 行セル（`contractNameCell()`、`title` に正式表記、Excel には別列で出力 = `exportOnly`）。コンテナ幅 820px 以下で `hideNarrow` 列（契約数・状態・時間など）を隠し、700px 以下で文字 11.5px/余白 3px に詰める。
状態チップ（`rowStatus()`）は配列で、契約は「赤字見込み」「予算超過」、チーム行は「赤字 N件」（配下の赤字見込み契約数）「予算超過」。既定の並びは `statusSortValue()`（赤を先頭、その中は消化率の高い順）。
契約詳細の月表は、予定（future）の月に選択方式の見込み原価（`forecastMonthlyCost`）を斜体＋「見込」チップで表示し、粗利・粗利率もそれに基づく（実績の無い月に 100% を出さない）。年度外の未来月（着地見込みの対象外）は状態を「年度外」とし、原価・粗利・粗利率は「—」（根拠ボタン無し）。月次推移の表とグラフも同じ扱い（グラフは予算棒をさらに薄くし、下に注記）。合計行の原価・粗利は実績月のみ。
チーム行の「契約数」は期間内の契約、「着地粗利」は年度に掛かる契約が母集団で別物。見出しの 2 行目で「（期間内）」「（年度内）」と示し、着地粗利セルの 2 行目に年度内の件数を併記する（Excel には「契約数（年度内）」列）。
粗利率は画面で再計算しない: `Totals` がある場面は `totals.grossMargin`、無い場面（月ごと・見込み）は `analysis.grossMarginOf()` の 1 か所（コアと同じ「予算 0 は null」）。マイナス記号はコアの `formatYen` / `formatPercent` の出力（Intl ja-JP の `-`）に統一し、`moneySigned` / `pointsSigned` も `+` を足すだけで記号を組み立てない。

## グラフ（charts.js）

dataviz スキルの既定パレットで 3 系列: 予算 = 青 `#2a78d6`、原価 = 橙 `#eb6834`、粗利 = 青緑 `#1baf7a`（ダークは `#3987e5 / #d95926 / #199e70`）。`validate_palette.js` でライト／ダークとも全チェック通過（青緑はライトで 3:1 未満の WARN → 表の双子と凡例で補う）。
基準月以降は見込み（薄い塗り ＋ 破線枠、折れ線は破線、背景に薄い帯）。見込み原価の月割りは `analysis.forecastMonthlyCost()`: 契約ごとに **コアの `remainingCost` を残り月で均等割り（端数は最終月）**、assignment は明細を月で合算。どちらも契約ごとの月割りの合計がコアの `remainingCost` と一致する（KPI の着地原価と表の合計が一致する）。ツールチップは `Plot.tip` + `pointerX`（1 本の縦線で全系列）。軸の単位は最大値で 百万円／万円／円 を自動選択。

## スタイル（style.css）

- `observablehq:default.css` と air / near-midnight テーマを読み込んだ上で `--theme-*` と `--yn-*` トークンを上書き。ダークは `prefers-color-scheme` と `[data-theme="dark"]` の両方。
- フォント: `system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", Meiryo, "Noto Sans JP"…`（Web フォント無し）。数値列・KPI は `tabular-nums`。
- 8px グリッド、カード角 8px、KPI は `auto-fit minmax(230px)`（コンテナ 1180px 以上で 5 列）。
- 文字の赤は `#b32d2d`（ライト 6.1:1）/ `#ee7a7a`（ダーク 6.4:1）。マークの赤は `#d03b3b`。
- `@media print` でサイドバー・フィルタ・ボタンを隠し、表の固定ヘッダを解除。

## ページを追加するには

1. `src/<name>.md` を作り、先頭に front matter（`title`）と読み込み中スケルトン（`<div id="page-skeleton" class="yn-skeleton">`）を置く。
2. 最初の `js` セルで `htl` / components / core を import。`const model = await loadJson(FileAttachment("./data/model.json"), {skeleton: "page-skeleton"})`、`const store = model ? createStore(model) : null`、`state = Generators.observe(...)`（既存ページからコピー）。
3. `pageHeader({...})` → `filterBar(store, model, {show: [...]})` → 本文。セルは `if (vm) {...}` で囲み、`display()` で描く。
4. サイドバーに出すなら `observablehq.config.js` の `pages` に追加（出さないページもビルドされる。契約詳細がその例）。
5. 新しいデータが必要なら `src/data/<name>.json.ts` を追加（Node で動く。`_shared.ts` を使う）。

## 検証の仕方

```bash
YOJITSU_AS_OF=2026-10-27 npm run build      # 警告 0、dist/_npm が無いこと
node serve.mjs dist 3000                     # 任意の静的サーバ（/contracts → contracts.html）
```
Playwright のスモークテスト（全ページのコンソールエラー 0、KPI が core の `aggregate()` / `forecastTotals()` と一致、内訳パネル、チーム→契約→詳細の遷移、Excel ダウンロード、ダーク、390px 幅）は `tests/e2e/` に置く予定。ブラウザは `PLAYWRIGHT_BROWSERS_PATH` にある chromium を `executablePath` で指定すると、`playwright` のバージョンと同梱ブラウザの版がずれていても動く。

## 計算コアに欲しいもの（API の隙間）

画面側で回避済み。コアを変えるときの参考。

| 欲しいもの | 現在の回避 |
|---|---|
| 残り月ごとの見込み原価（グラフ用）。`ForecastBreakdown` は合計 `remainingCost` と平均しか持たない | `analysis.forecastMonthlyCost()` で `remainingCost` を残り月に均等割り（端数は最終月）／アサイン明細の月合算。合計は `remainingCost` に一致。コアに `remainingCostByMonth` があれば置き換える |
| `forecastTotals()` に「年度に掛かる契約数」 | `contractCount` は選んだ契約の数。年度対象外（`contractMonthsInFY` が空）の契約は内訳で除外して数えている |
| `TeamTreeResult` の `rootTeamIds`（`teamTreeForMonth()` は `tree` だけ返す） | `parentTeamId === null` のノードを拾って順序は `Object.values` 順（ファイル初出順）に依存 |
| `Totals` に「期間内の契約ID一覧」 | 契約一覧では契約ごとに `aggregate()` を呼び `contractCount > 0` で期間内判定（21 契約なら問題ない。数百契約なら 1 回の走査にまとめたい） |
| 前年同期比の定義 | 画面側で「経過月（from〜asOf月）の累計と、同じ月を 12 か月前にずらした累計を比べる」と決めた（タイルの値＝期間全体とは母集団が違うので、タイルの文で「4〜10月の累計を前年同期と比較」と明示）。前年のデータが途中からしか無いときは両方をデータのある月に詰め、`partial` で「前年はデータのある月のみ」と注記。`hasPriorYearData` に加えて前期の予算・原価が 0 なら「比較データなし」 |
| `ForecastTotals` に「年度に掛かる契約数」 | `teamRow()` が `contractMonthsInFY` の有無で `fyContractCount` を数えている |
| `Warning` に `row` | データ確認では `ref` を文字列化して表示 |
| `Model.worklogDetailPath` | `model.json.ts` が付けている（`"data/worklogs/{contractId}.json"`）。型には無い |
