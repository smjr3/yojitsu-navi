# 画面（UI）実装メモ

Observable Framework 1.13 で作った画面側の構成と決定事項。計算は `src/core/`（純粋関数）に任せ、画面は「どの契約を・どの期間で」を決めて表示するだけにしている。

## 全体像

```
src/
  data/
    _shared.ts                   データローダ共通（data/ を読んで buildModel。asOf = YOJITSU_AS_OF か今日(JST)。画面で開いた人の今日に置き換える（SPEC §75）。出力は emitJson で検査。docs/DATA_LOADERS.md）
    model.json.ts                画面が読む Model。ContractMonth.worklogs を空にして軽量化（約 3.1 MB / 5 倍のダミーデータ）
    worklogs/[contractId].json.js 契約ごとの作業ログ明細（遅延取得用）。observablehq.config.js の dynamicPaths で列挙
    dataset-issues.json.ts       データ確認ページ用: CSV 読み込みの問題 + validateDataset（validate-data.ts と同じ内容）
  components/                    フレームワーク非依存の ESM（htl の html`` で DOM を組む。表の行・マスなど数の多い部品は dom.js の h() で直接作る。SPEC §107）
    format.js      金額・割合・時間・月・日時の書式。単位 "m"（百万円）| "k"（千円）| "yen" を core の MoneyUnit に変換
    state.js       期間・チーム・単位・着地方式の状態 ⇄ URL クエリ ⇄ localStorage
    analysis.js    scope（期間×チーム）の決定、前年同期比、契約行／チーム行の組み立て、見込み額の月割り
    layout.js      ページヘッダ（基準日・取得日時・速報バッジ・パンくず）、空／エラー／読み込み状態、loadJson
    kpi.js         KPI タイル（値・ラベル・比較・状態チップ）
    breakdown.js   計算根拠パネル（<dialog>）と各 spec の組み立て、作業ログ明細の遅延取得
    table.js       一覧表（並べ替え・固定ヘッダ・右寄せ・状態チップ・行クリック・Excel 出力・木構造）
    charts.js      Observable Plot のグラフ（月次推移）、凡例、表の双子、消化率メーター
    chart-zoom.js  グラフの枠（凡例＋「拡大」ボタン＋幅に合わせた再描画）と拡大表示のダイアログ（全グラフ共通。SPEC §33）
    filters.js     フィルタ行（期間＋プリセット、チーム、着地方式、単位）。mountFilterBar() で上部ヘッダの固定バーに差し込む
    dom.js         h(tag, attrs, ...children): 表の行・マスなど数の多い部品を document.createElement で直接作る（html`` と同じ DOM。SPEC §107）
  index.md / teams.md / contracts.md / contract.md / rules.md / data-check.md
  style.css        デザイントークン（ライト／ダーク・テーマカラー・文字の大きさ）とスタイル
```

## ナビゲーション（上部ヘッダ）

左サイドバーは使わない（`sidebar: false`）。`observablehq.config.js` の `header()` が全ページ共通のヘッダを出す。 head には画面の切り替えの先読み（Speculation Rules。マスタ編集・設定は対象外。裏で作る間も計算を進め、表示の状態が変わっていたら表示するときに作り直す。SPEC §108）も入れている。

- 1 段目: ロゴ ＋ **画面タブ**（`NAV`: 全体・チーム・顧客・案件・メンバー・稼働実績。現在のページは `aria-current="page"`）＋ 右上に **作業実績の取得日時**（上段に入る幅だけ。§66）・**表示単位**（`#yn-unit-slot`）と **業務リンク**（`TOOLS`: リソース計画。よく使うので大きめのボタン）、設定・**その他「⋯」**（`MORE`: マスタ編集・使い方・データ確認・計算ルール。目立たせない。マージ待ちの件数は「⋯」の右上とメニューのマスタ編集に出す。§45・§47・§52）のアイコン。単位・リソース計画・アイコンは同じ高さ（`--yn-topbar-ctl-h`。§66）
- 2 段目: **固定フィルタバー**（`#yn-filterbar-slot`）。ページが `mountFilterBar()` を呼んだときだけ表示。期間（開始月・終了月の選択＋カレンダーでの日付指定＋プリセット「今年度・今月・先月・今後3か月・直近12か月・前年度」。データは月単位なので、カレンダーで選んだ日付はその日が属する月として扱う）・チーム・着地見込みを 1 行に並べ（1366px 未満で収まらないときは期間を 1 行目、チームと着地見込みを 2 行目にまとめる。着地見込みだけを次の行に落とさない。§66）、ヘッダごと `position: sticky` で上端に残る。フィルタの無いページ（使い方・計算ルール・データ確認）では出ない
- ファビコンは全ページ共通の `src/icons/`（SVG・32px PNG・iPhone 用 180px PNG。元は `src/components/favicon.js`。§89）
- href は `/teams` のように `/` 始まりで書けば Framework がページごとの相対パスに書き換える（GitLab Pages のサブパス配信でも動く）
- 1024px 未満はタブを 2 段目に回して横スクロール、フィルタも 1 行で横スクロール。1024px 以上はヘッダーが 1 段（単位のボタンも折り返さない）。スマホ幅はロゴと右上のリンク・アイコンを 1 段、タブを 2 段目
- 本文に最大幅を設けない（`--yn-max-width: none`。広い画面でも表・グラフを横いっぱいに使う。読み物の段落だけ 60〜80 文字の上限。§88）
- スマホ（640px 未満）はヘッダを固定しない（固定すると画面の約 1/4 を占めるため）。表示条件はページ上端に戻って変える
- 1 段だけのパンくずはタブと重複するので `pageHeader` は 2 段以上のときだけ出す。タブにないページ（リソース計画・マスタ編集・データ確認・使い方・計算ルール）は全体サマリーを親にしない＝パンくずなし（SPEC §69）

## ページの構成（一画面一問）

| ページ | 問い | 構成 |
|---|---|---|
| `/` 全体サマリー | 会社全体（or 選んだチーム）は今どうか | KPI 5 枚（予算・実績・残予算＋残予算率・消化率・期間の終わりの着地見込みの差＋超過見込み件数。§54）→ 月次推移 → 超過見込み契約 → チーム別 |
| `/teams` チーム一覧 | どの組織が悪いか・どんな体制か | 組織木（折りたたみ可、上位は配下の合計）＋ 未設定。行クリックでチーム詳細へ。「表 / 体制図」の切り替えで、月を選んで組織・メンバー・応援／ヘルプと負荷の色を見る（表示だけ。SPEC §76） |
| `/team?id=` チーム詳細（タブには出さない。「チーム」タブが選択状態） | このチームはなぜ悪いか | パンくず → KPI 5 枚 → 月次推移 → 配下のチーム → 案件一覧 → メンバー別実績 → 組織の変遷 |
| `/contracts` 案件一覧 | どの契約が悪いか | 並べ替え可能な一覧 ＋ 絞り込み（超過見込み／消化率超過／速報含む／期間外も表示／検索）＋ 合計行 |
| `/contract?id=` 案件詳細 | この契約はなぜ悪いか | 基本情報 → KPI → 月次推移 → 月ごとの予実 → メンバー別実績 → 3 方式の着地比較 → 作業ログ（遅延読み込み） |
| `/rules` 計算ルール | 数値はどう計算されているか | SPEC を人向けに。config.json の値を `${...}` で差し込む |
| `/guide` 使い方 | どう見て、どう操作するか | 利用者向けのマニュアル。本文は `src/i18n/guide.txt`、組み立ては計算ルールと共通の `src/prose-page.js`。外部の文書へ誘導しない（§47） |
| `/data-check` データ確認 | 数値の精度を下げている要因は何か | 未紐付け・キーワードに合致しない作業・未登録の作業コード（この 3 つは「作業した人」の列と「案件ごと／人ごと」の切り替え。§100）・作業名が変わった作業コード（§92）・正式な案件IDの無い案件・マスタに無い正式な案件（§98。一覧を取り込んだときだけ。正式な案件IDの無い案件の候補なら「同じ案件名の案件」。§103.3）・単価なし（人ごと）・マスタに無いメンバー（KPI に人数）・除外・警告一覧・検証結果 |

すべての一覧の数値列は同じ順序: **予算・実績・残予算・残予算率・消化率・着地差**（`table.js` の `standardColumns()`）。
赤は **消化率 > 閾値** と **着地が超過** の 2 つだけ（色 ＋ ▲ ＋ 文字）。黄色は使わない。速報は点線のチップ、確定は ●。

## 状態と URL

`state.js` の `createStore(model)`:

| キー | 値 | 既定 |
|---|---|---|
| `from`, `to` | `YYYY-MM`（`meta.minMonth`〜`maxMonth` に収める。逆転は入れ替え） | asOf の年度をデータ範囲に収めたもの |
| `team` | チームID / `""`（全体）/ `__unassigned__`（未設定） | `""` |
| `unit` | `m`（百万円）/ `k`（千円）/ `yen` | `config.currency.defaultUnit`（既定 `millionYen`） |
| `method` | `assignment`（計画値）/ `recent3` / `all`（この順で表示） | `config.forecastMethodDefault`（既定 `assignment`） |

優先順位は **URL クエリ > localStorage（`yojitsu-navi:state:v2`。既定単位を百万円に変えた際に v1 から切替） > 既定値**。変更は `history.replaceState` で URL に、同時に localStorage に書く。初回表示でも URL を正規化するので、そのまま共有できる。
フィルタ変更は履歴に積まない（`replaceState`）設計なので、ブラウザの「戻る」は直前の条件ではなく前のページに戻る（条件を残したいときは URL をそのまま共有・ブックマークする）。
案件詳細の `id`、案件一覧の `f`（`deficit|over|prelim`）と `q`（検索）はストアの外（ページ固有）。`store.href("./contracts", {team}, {id})` で状態を引き継いだリンクを作る。

ページでは `Generators.observe` でストアを反応的な値 `state` にし、`vm`（view model）セルで `scopeFor()` → 集計 → 各セルが再描画される。フィルタ行は 1 回だけ描き、ストアを購読して自分の表示を同期する（フォーカスを失わない）。案件一覧の絞り込みフォーム（チップ・検索欄）も `model` だけに依存して 1 回だけ描き、検索は `onTextInput()` で 150ms デバウンス（日本語の変換中は反映しない。SPEC §105）、両辺をコアの `normalizeName()`（NFKC・小文字化・法人格除去）で正規化して部分一致する。

`scopeFor()` が返す組織木の基準月は **`min(期間の終了月, 基準月)`**（未来に発効する組織では集計しない）。選んだチームがその月の組織に無いときは `scope.teamMissing` で注記を出す。「未設定」（チーム無し）の行は、全体サマリーとチーム一覧とも **期間内に契約があるときだけ末尾に表示** する。

> 注意: Observable のセル名に `view`, `width`, `dark`, `html`, `Plot` など組み込み名を使わない（`view` を使うと組み込みの `view()` と衝突して undefined になる）。

## ライブラリの読み込み（CDN なし）

- `html` は `import {html} from "htl"`、Plot は `import * as Plot from "@observablehq/plot"`、Excel は `await import("xlsx")`（表の Excel 出力時に初めて読む）。いずれも node_modules から `dist/_node/` に同梱される。
- 組み込みの `html` / `Plot` / `d3` / `Inputs` を **暗黙に** 使うと `npm:` 経由（CDN）になるので、必ず明示的に import する。`FileAttachment`, `Generators`, `resize`, `dark` は Framework 組み込み（CDN 不要）。
- 計算コアは `import {...} from "./core/index.js"`（拡張子は `.js`。Framework が `.ts` を見つけてトランスパイルする。`.ts` と書くと解決されない）。
- ビルド後の `dist/` に `_npm/` が無いことが「CDN 不要」の確認になる。

## データの流れ

1. `npm run build` → `src/data/model.json.ts` が `data/` を読み `buildModel()`。`asOf` は `YOJITSU_AS_OF`（テスト・試用版で固定したい場合）か今日（JST）。固定しないビルドは、画面が `model.json` を読んだ直後に開いた人の今日（JST）へ置き換える（`loadModel`→`rebaseModel`。SPEC §75）。
2. `model.json` には `worklogs` 明細を含めない（`costLines` までは含む）。明細は `src/data/worklogs/[contractId].json.js` が契約ごとに出力し、`observablehq.config.js` の `dynamicPaths` が `data/contracts.csv` の契約ID から `/data/worklogs/<id>.json` を列挙する。
3. 画面は `breakdown.js` の `fetchWorklogs(id)` で必要なときだけ取得する。ビルド済みサイトでは `/data/worklogs/<id>.json`、`npm run dev` では `/_file/data/worklogs/<id>.json` で配信されるので順に試す（プレビューでは最初の 404 がコンソールに出るが動作に影響なし）。契約 ID はパスに入れる前に `encodeURIComponent` する（`dynamicPaths` 側も同じ。ローダは `decodeURIComponent` で元に戻す）ので、`/` や空白を含む ID でも列挙から漏れない。Excel のファイル名も `safeFileName()` で `\ / : * ? " < > |` を `_` に置換する。
4. 生成物の大きさ（ダミーデータ）: `model.json` 540 KB、`dataset-issues.json` 6 KB、作業ログ明細は契約ごとに 1 KB〜650 KB（合計約 4.3 MB、`dist/` 全体 6.3 MB）。

## 計算根拠パネル（breakdown.js）

数値は `numberButton(text, spec)` で描く（`<button class="yn-num">`）。`spec` は `{title, formula[], rows[{label,value,note}], sections[{title,text,table,lazy}], note}`。関数を渡すと開いたときに計算する（表の全セルで事前計算しない）。
spec の組み立て関数: `budgetMonthSpec` / `budgetAggregateSpec` / `costMonthSpec`（実績行 → 作業ログを遅延読み込み）/ `costAggregateSpec` / `grossProfitSpec` / `marginSpec` / `burnRateSpec` / `forecastSpec`（方式・月・平均・アサイン明細）/ `forecastTotalsSpec` / `hoursSpec`。
表（`renderTable`、`.yn-bd-table`）: 先頭列は `td.yn-primary-cell`（見出しと同じく `position: sticky`、最大 260px で「…」）、2 列目以降の文字の列は `td.yn-cell-clip`（§106 と同じ上限）。どちらも全文を `title` に入れる。いちばん長い文字の列（12 文字超）は `is-grow`（`width: 100%; max-width: 0; min-width: 12em`）で表の余った幅を受け取る。ダイアログは `.yn-bd-dialog` で最大 1040px（1280px で 7 列が横スクロール無しで収まる）。ダイアログは `#observablehq-main` の外なので、Framework の既定 `table { max-width: 640px }` を `.yn-dialog table` で外している（外さないと表が幅いっぱいに広がらない）。
`<dialog>` は 1 つを使い回す。`showModal()` なので Esc で閉じる・フォーカスがダイアログ内に閉じる・閉じたら元のボタンに戻るのはブラウザ標準。

## 表（table.js）

`dataTable({columns, rows, unit, sort, rowHref, caption, exportName, tree, summary, summaryBreakdown, maxHeight, filter})`。
列は `{key, label, sublabel, type: money|percent|hours|int|status|text, get, render, sortValue, exportValue, breakdown, hideOnPhone, hideNarrow, filter, filterValue}`。`sublabel` は見出しの 2 行目（「（期間内）」「（年度内）」など母集団の注記。幅を増やさない）。
`<th scope="col">` にソートボタンと `aria-sort`、先頭列は `<th scope="row">`。行クリックは `rowHref` のリンク（キーボードはリンクで到達）＋行全体のクリック。並べ替え・木の開閉で thead/tbody を描き直したあとは `data-key` で同じボタンにフォーカスを戻す（キーボード操作が途切れない）。
列ごとの絞り込み（SPEC §70）: 見出しの漏斗ボタンで吹き出し（`body` 直下に fixed。表の横スクロール枠で切られないため）。文字・状態は値の一覧＋検索、数値は以上〜以下（表示単位で入力し、`rangeFactor` で元の値に直して比較）、日付・年月は以降〜以前＋年のボタン（`dateBody`・`parseDateFilterInput`。値がすべて `YYYY-MM(-DD)` の列は自動、期間の列は `dateValue: (r) => [開始, 終了]`。§109）。判定は `matchesFilter(col, f, row, unit)`（ユニットテストあり）。状態は sessionStorage `yojitsu-navi:filter:<path>:<caption>`。木構造の表は `treeFilteredRows` で一致行＋祖先を残し、祖先だけの行に `is-filter-context`（薄く）。`filter: false` には付けない。`summary` に関数 `(shownRows) => row` を渡すと絞り込み後の行で合計行を作り直す（固定の row は絞り込み中は出さない）。
合計行（`summary`）は行用の `breakdown(row)` を使わず、`summaryBreakdown(col, summaryRow)` が spec を返す列だけ根拠ボタンになる（案件一覧は表示中の契約 ID を母集団に `aggregate()` / `forecastTotals()` で合計し、同じ ID 集合で根拠を開く。案件詳細の月表の合計行は KPI と同じ `Totals` を表示し、根拠ボタンは付けない）。
Excel 出力は **今見えている行（並べ替え・絞り込み後）** を `.xlsx` に。金額は **表示単位に関係なく常に円の整数**（列名「…（円）」、1 行目に「単位: 円」の注記、2 行目が見出し）。千円表示は画面だけの都合で、行ごとに丸めた値を出力して合計がずれることを避ける。割合は % の数値、月は `YYYY-MM`。画面に合計行（tfoot）がある表は、最終行に同じ合計を出す。
幅の工夫（1280px で標準列がスクロール無しで収まるように）: 先頭列は `position: sticky`（横スクロール時も名前が残る）、横スクロールが必要なときは両端に影とツールバーに「横にスクロールできます」を出す（`.yn-table-scroll.is-scrollable`）。案件一覧・赤字一覧は「顧客 / 案件」と「ID・チーム・期間（YY/MM）」の 2 行セル（`contractNameCell()`、`title` に正式表記、Excel には別列で出力 = `exportOnly`）。コンテナ幅 820px 以下で `hideNarrow` 列（案件数・状態・時間など）を隠し、700px 以下で文字 11.5px/余白 3px に詰める。

長い名前（5 倍のダミーデータで確認）: 名前列は最大 300px で省略し全文は `title`。「顧客 / 案件」の 2 段表示（`.yn-cell-2line`）は 1200px 以上で最大 320px まで広げる。作業種別名（`.yn-task-name`）は 260px で折り返す。1280px で一覧・顧客詳細・チーム一覧が横スクロールにならないことを `tests/e2e/scale-data.spec.ts` で確かめている。

状態チップ（`rowStatus()`）は配列で、契約は「超過見込み」「消化率超過」、チーム・顧客の行は「超過見込み N件」（配下の超過見込み案件数。合計の着地がマイナスのときだけ赤、マイナスでなければ灰色の「超過案件 N件」。§67）「消化率超過」。既定の並びは `statusSortValue()`（赤を先頭、その中は消化率の高い順）。
案件詳細の月表は、予定（future）の月に選択方式の見込み額（`forecastMonthlyCost`）を斜体＋「見込」チップで表示し、残予算・残予算率もそれに基づく（実績の無い月に 100% を出さない）。着地見込みは選んだ期間の終わりまでなので、期間内の基準月以降はすべて見込みの月（§54。以前の「年度外」表示は廃止）。合計行の実績・残予算は実績月のみ。
チーム行の「案件数」は期間内の契約、「着地差」は年度に掛かる契約が母集団で別物。見出しの 2 行目で「（期間内）」「（年度内）」と示し、着地差セルの 2 行目に年度内の件数を併記する（Excel には「案件数（年度内）」列）。
残予算率は画面で再計算しない: `Totals` がある場面は `totals.grossMargin`、無い場面（月ごと・見込み）は `analysis.grossMarginOf()` の 1 か所（コアと同じ「予算 0 は null」）。マイナス記号はコアの `formatYen` / `formatPercent` の出力（Intl ja-JP の `-`）に統一し、`moneySigned` / `pointsSigned` も `+` を足すだけで記号を組み立てない。

## グラフ（charts.js）

dataviz スキルの既定パレットで 3 系列: 予算 = 青 `#2a78d6`、実績 = 橙 `#eb6834`、残予算 = 青緑 `#1baf7a`（ダークは `#3987e5 / #d95926 / #199e70`）。`validate_palette.js` でライト／ダークとも全チェック通過（青緑はライトで 3:1 未満の WARN → 表の双子と凡例で補う）。
基準月以降は見込み（薄い塗り ＋ 破線枠、折れ線は破線、背景に薄い帯）。見込み額の月割りは `analysis.forecastMonthlyCost()`: 契約ごとに **コアの `remainingCost` を残り月で均等割り（端数は最終月）**、assignment は明細を月で合算。どちらも契約ごとの月割りの合計がコアの `remainingCost` と一致する（KPI の着地実績と表の合計が一致する）。ツールチップは `Plot.tip` + `pointerX`（1 本の縦線で全系列）。向きは `preferredAnchor` で上を優先し、端では枠に収まる向きを自動で選ぶ（右端の月で切れない）。軸の単位は最大値で 百万円／万円／円 を自動選択。

グラフは `chartFigure({ title, subtitle, legend, draw })` で置く（`draw(width, height?)` を幅が変わるたびに呼ぶ。拡大時はダイアログの幅・高さで呼ぶ）。新しいグラフもこれを使えば拡大表示が付く。

## スタイル（style.css）

- `observablehq:default.css` と air テーマを読み込んだ上で `--theme-*` と `--yn-*` トークンを上書き。表示モードとテーマカラーは §53: head のスクリプト（`src/components/appearance.js`）が描画前に `<html data-theme data-accent>` を決める（設定画面 → GitLab → PC の設定 → ライト／ブルー）。ダークの面はネイビー寄りのグレー（ページ `#161c27`・カード `#1e2533`）。テーマカラーはリンク・フォーカス・選択中・主ボタン・ロゴだけに使い、グラフの系列色は変えない。グラフの配色（Framework の `dark`）は `color-scheme` を見て自動で追従する。
- 文字の大きさ（§111）: 文字サイズは px を直書きせず `calc(Npx * var(--yn-fs))`（18px 以上は `var(--yn-fs-big)`、1.1 倍まで）で書く（`tests/unit/style-css.test.ts` が検査）。グラフ（Plot）の文字・余白は `scaledPx()`（`src/components/appearance.js`）で倍率を掛ける。上部（`#observablehq-header`）は倍率 1 に固定。
- フォント: 同梱の BIZ UDPゴシック（`src/fonts/`、SPEC §46）。`--sans-serif` は `"YN BIZ UDPGothic", "BIZ UDPGothic", system-ui, …`。同梱版は「1」の幅を他の数字にそろえてあるので、数字はどこでも桁がそろう。数値列・KPI は `tabular-nums`（フォールバックのシステムフォント用）。フォントの作り直しは `scripts/fonts/build_fonts.py`。
- 8px グリッド、カード角 8px、KPI は `auto-fit minmax(230px)`（コンテナ 1180px 以上で 5 列）。
- 文字の赤は `#b32d2d`（ライト 6.1:1）/ `#ee7a7a`（ダーク 6.4:1）。マークの赤は `#d03b3b`。
- `@media print` で上部ヘッダ・フィルタ・ボタンを隠し、表の固定ヘッダを解除。

## ページを追加するには

1. `src/<name>.md` を作り、先頭に front matter（`title`）と読み込み中スケルトン（`<div id="page-skeleton" class="yn-skeleton">`）を置く。
2. 最初の `js` セルで `htl` / components / core を import。`const model = await loadJson(FileAttachment("./data/model.json"), {skeleton: "page-skeleton"})`、`const store = model ? createStore(model) : null`、`state = Generators.observe(...)`（既存ページからコピー）。
3. `pageHeader({...})` → `mountFilterBar(store, model, {show: [...]})` → 本文。セルは `if (vm) {...}` で囲み、`display()` で描く。
4. `observablehq.config.js` の `pages` に追加し、上部タブに出すなら `NAV`、右上の業務リンクなら `TOOLS`、「⋯」のメニューなら `MORE` にも追加する（詳細画面は親タブの `match` にパスを足すとそのタブが選択状態になる。案件詳細がその例）。
5. 新しいデータが必要なら `src/data/<name>.json.ts` を追加（Node で動く。`_shared.ts` の `emitJson` で出力し `_build: buildStamp()` を付ける。[DATA_LOADERS.md](DATA_LOADERS.md)）。

## 検証の仕方

```bash
YOJITSU_AS_OF=2026-10-27 npm run build      # 警告 0、dist/_npm が無いこと
node serve.mjs dist 3000                     # 任意の静的サーバ（/contracts → contracts.html）
```
Playwright のスモークテスト（全ページのコンソールエラー 0、KPI が core の `aggregate()` / `forecastTotals()` と一致、内訳パネル、チーム→契約→詳細の遷移、Excel ダウンロード、ダーク、390px 幅）は `tests/e2e/`（一覧は `tests/e2e/README.md`）。ブラウザは `PLAYWRIGHT_BROWSERS_PATH` にある chromium を `executablePath` で指定すると、`playwright` のバージョンと同梱ブラウザの版がずれていても動く。

## 計算コアに欲しいもの（API の隙間）

画面側で回避済み。コアを変えるときの参考。

| 欲しいもの | 現在の回避 |
|---|---|
| 残り月ごとの見込み額（グラフ用）。`ForecastBreakdown` は合計 `remainingCost` と平均しか持たない | `analysis.forecastMonthlyCost()` で `remainingCost` を残り月に均等割り（端数は最終月）／アサイン明細の月合算。合計は `remainingCost` に一致。コアに `remainingCostByMonth` があれば置き換える |
| `TeamTreeResult` の `rootTeamIds`（`teamTreeForMonth()` は `tree` だけ返す） | `parentTeamId === null` のノードを拾って順序は `Object.values` 順（ファイル初出順）に依存 |
| `Totals` に「期間内の契約ID一覧」 | 案件一覧では契約ごとに `aggregate()` を呼び `contractCount > 0` で期間内判定（21 契約なら問題ない。数百契約なら 1 回の走査にまとめたい） |
| 前年同期比の定義 | 画面側で「経過月（from〜asOf月）の累計と、同じ月を 12 か月前にずらした累計を比べる」と決めた（タイルの値＝期間全体とは母集団が違うので、タイルの文で「4〜10月の累計を前年同期と比較」と明示）。前年のデータが途中からしか無いときは両方をデータのある月に詰め、`partial` で「前年はデータのある月のみ」と注記。`hasPriorYearData` に加えて前期の予算・実績が 0 なら「比較データなし」 |
| `Warning` に `row` | データ確認では `ref` を文字列化して表示 |
| `Model.worklogDetailPath` | `model.json.ts` が付けている（`"data/worklogs/{contractId}.json"`）。型には無い |

## チーム詳細（`/team?id=`）— 決定事項

- 部品は `components/team-detail.js`（`summaryKpis` = 全体サマリーと同じ KPI 5 枚、`memberCostSpec` = メンバー別実績の根拠、`orgChangeText`）。計算は `core/team-detail.ts`。`index.md` の KPI 組み立てとは重複しているが、既存ページには手を入れていない（共通化は将来）。
- 母集団は `contractsForTeam(model, id, tree)`。組織の基準月は `treeMonthFor`（= `min(期間の終了月, asOf 月)`）。`team` の絞り込み状態（`state.team`）は無視し、`?id=` だけを見る。フィルタ行は 期間・方式・単位。
- 空状態: 基準月の組織に無い ID（履歴にあるが未発効・廃止、履歴にも無い、ID 未指定、`constructor` など）は「このチームは選択期間の組織にありません」＋チーム一覧へのリンク。ID 未指定は「チームIDが指定されていません」。
- 案件一覧は期間内の契約だけ（期間外の件数は注記）。列は `standardColumns()` で他画面と同じ。「案件一覧で絞り込む」（`/contracts?team=`）がここから案件一覧への入口。チーム一覧・全体サマリーの行クリックはこのページへ。
- 配下のチームは直下の子のみ（孫は子の行に合算）。子が無い・未設定では出さない。
- メンバー別実績は作業実績軸（所属が別でも含む）。所属がこのチーム（配下・上位を含む。`ownTeamScope`）の外の作業が 1 時間でもあれば「応援」チップ、所属チームの無い人（他部署）・メンバーマスタに無い人の作業があれば「ヘルプ」チップ（枠線だけ。SPEC §72）。所属は当時の `memberTeamId`、所属チームの無い月は部・課、マスタに無ければ「マスタ未登録」。数値は「時間」「実績」とも実績行（月×契約）の根拠を開く。未設定では「応援」は付けない（「ヘルプ」は付ける）。KPI の実績の下に「うち応援 ○・ヘルプ ○」（どちらも無ければ出さない）。案件詳細のメンバー別の実績も同じ部品（`originChips` / `originOrgText` / `withOrigin`）で、担当組織は主担当チーム。
- 組織の変遷は期間内に変更があるときだけセクションごと出す（未設定は出さない）。内容は `core/team-detail.ts` の `teamOrgChanges`。

## 顧客別（SPEC §17）決定事項

- `/customers`（上部タブ: チームの次）と `/customer?key=`（タブには出さない）。部品は `src/components/customers.js`（`customerHref` / `idsRow` / `groupBreakdowns` / `contractListColumns`）。表は `standardColumns()` を再利用し他画面と列順を揃える（顧客・契約数・予算・実績・残予算・残予算率・消化率・着地差・状態）。
- URL の `key` は `encodeURIComponent`（`customerHref`）。読むのは `URLSearchParams.get`。日本語・記号・空白・`/ # ? % + &` を含む顧客名で往復できる（E2E は model.json を書き換えて確認）。見つからない key・key なしは空状態。
- 一覧: 選んだチーム（配下含む）の契約だけで顧客を集計。期間内に契約が無い顧客は既定で非表示（「期間外の顧客も表示」で出す）。検索は `normalizeName` で両辺を正規化した部分一致（URL の `q` で復元）。合計行は表示中の顧客の全契約を母集団にした `aggregate()` / `forecastTotals()`。着地差は年度に掛かる契約が 0 件の顧客だけ「—」。状態チップはチーム行と同じ（赤字 N件・予算超過）。
- 詳細: KPI 5 枚（全体サマリーと同じ。前年同期比も同じ規則）→ 月次推移 → この顧客の案件（期間外は既定で非表示、切替あり）→ 担当チーム別（契約の `teamId` ごと。配下はまとめない。行クリックは `/contracts?team=&q=<顧客名>`）→ メンバー別の実績（チーム詳細と同じ列・根拠パネル。応援は案件ごとの担当組織で判定、SPEC §74）→ 作業種別の内訳。顧客詳細はチームフィルタを持たない（期間・方式・単位のみ）。
- 案件詳細の顧客名から顧客詳細へのリンク（追加のみ）。

## マスタ編集 `/masters`（2 回目リリース、SPEC §19）

問い: 「マスタを直して、安全に保存するには」。構成: 説明（何を編集すると何が変わるか・履歴は行を追加・保存までの流れ）→ 下書きの復元（あれば）→ 台帳のタブ（メンバー・単価・組織・案件・顧客・目標・祝日）→ 表（1 対象 1 行・開くと変更の履歴）→ 検証 → 変更内容（差分）→ 保存。
- 表の列幅（SPEC §73）: 列見出しの右端の境目をドラッグ／矢印キーで変える（状態・操作の列以外）。幅を決めた列は「…」で切り、全文は title。ファイルごとに localStorage へ覚える。
アサイン・運用保守以外の予定はリソース計画 `/plan`（同じ `mastersEditor` を `views: PLAN_VIEWS` で開く）。台帳とリソース計画の持ち方は下の「台帳とリソース計画（SPEC §36）」。

| ファイル | 役割 |
|---|---|
| `src/core/masterEdit.ts` | 純粋ロジック: 行テキストを保った CSV 読み込み（`splitCsvRecords`）、行の追加・修正・削除・元に戻す、書き出し（`serializeMasterDoc`）、差分（`diffMasterDoc`）、過去月への影響（`impactOfChange` / `impactBetween`）、編集後の `parseDataset`+`validateDataset`（`validateEdited`）、下書き（`makeDraft` / `parseDraft` / `draftFileOf` / `docFromDraft` / `staleDraftFiles`）、下書きの当て直し（`rebaseDraftFile`）、影響ダイアログの文（`describeImpactEffects`） |
| `src/core/gitlab.ts` | GitLab API（fetch を注入）: `saveToGitLab`、`buildCommitPayload`、`masterBranchName`、`classifyHttpError` / `networkError`（conflict / permission / network / other）、`resolveMasterEdit` / `effectiveSaveMode` / `webFileUrl` |
| `src/core/ledger.ts` | 台帳のまとめ（`ledgerGroups`・`nextChangeOf`）、期間の行の履歴（`periodHistory`）・期間の置き換え（`replaceRange`）・月の値（`valueAt`） |
| `src/data/masters.json.ts`（`_masters.ts`） | 8 ファイル（案件 contracts.csv・祝日 holidays.csv を含む。任意の outside-plans.csv・targets.csv は無ければ見出しだけ）の生テキスト・最終コミット ID・リポジトリ内パス・文字コード／改行、検証用の contracts / mapping / holidays、`masterEdit` 設定、`memberSourceAdapter`・`memberImportedColumns` |
| `src/components/masters.js` | 画面（状態を持ち、変わった部分を描き直して `data-fk` でフォーカスを戻す） |
| `src/masters.md` | ページ（model.json は計算基準月・データ最小月・config のためだけに読む） |

core の index.ts には足していない（並行開発の衝突を避けるため、ページ・部品は `./core/masterEdit.js` / `./core/gitlab.js` を直接 import）。

### 決定事項

| 箇所 | 曖昧点 | 決定 |
|---|---|---|
| §19.1「過去月」 | どこまでが過去か | **データの最小月（`meta.minMonth`）〜計算基準月（`meta.asOfMonth`、速報月を含む）**。実績が画面に出ている月を過去とする |
| §19.1 影響月数 | 何を比べるか | 履歴マスタはキー列（member_id / key / team_id）ごとに「月 m の有効レコード（§5、同じ適用開始月は後の行）」の値を、アサインはメンバー×契約ごとに「月 m に掛かる行の allocation の集合」を編集前後で比べ、違う月を数える。キーを変えたら旧・新の両方。その月に工数があって実績が本当に変わるかまでは見ない（画面に作業実績を持たないため） |
| §19.1 確認ダイアログ | どの操作で出すか | 既存行の修正・削除は **常に** 確認（変わる値と影響月数）。追加は過去に影響するときだけ確認、未来の追加はそのまま反映。ブラウザ標準の `confirm()` は使わず `<dialog>`（Esc で閉じる・フォーカスが戻る） |
| §19.1 追加の位置 | 行をどこに入れるか | ファイル末尾（同じキー・同じ適用開始月なら後の行が有効、の規則と一致し、差分も末尾の行だけになる）。台帳の「＋ 変更」は対象の最新の行を写し、適用開始月を基準月の翌月（最新の履歴がそれより後ならその翌月）にする |
| §19.1 書き出し | 未変更行の保持 | 元のレコードのテキスト（引用符の付け方・空白まで）をそのまま使う。変更・追加した行だけ「カンマ・`"`・改行を含むときだけ引用符」で書く。改行は LF、BOM なし、末尾改行 1 つ、列順は元ファイルのヘッダ順（必須列が無ければ末尾に足す）。空行・空白だけの行は書かない（読み込みでも捨てられる行）。元が CRLF / BOM 付き / Shift_JIS なら全行が変わるので画面で注記する |
| §19.1 入力 | 値の正規化 | 入力値は前後の空白を除く（CSV 読み込みも trim するため）。数値・月の形式チェックはダイアログで止めず、`validateEdited`（§14 と同じ検証）のエラーとして行に出す（CI と同じ文言）。必須の未入力だけはダイアログで止める |
| §19.1 検証 | 作業実績 | 画面には作業実績を持たないので `worklogs: []` で検証する（未紐付け・単価なしの警告は保存後の「データ確認」で見る）。編集対象外のファイル（contracts 等）のエラーも保存を止める |
| §19.2 既定 | config.json | `mode: "download"`、gitlab の値は空。`mode: "gitlab"` でも `apiBaseUrl` か `projectId` が空なら download |
| §19.2 認証 | ヘッダ | `PRIVATE-TOKEN`。最初に `GET /user` でトークンを確かめ、username をブランチ名に使う。ブランチ名の日時は JST、user は英数・`._-` 以外を `-` |
| §19.2 401 | トークン | 無効・期限切れなので sessionStorage から消し、再入力を促す |
| §19.2 競合 | 判定 | commits API の 400 で本文が `changed since` / `last_commit_id` 等を含むもの、または 409。404 は「projectId / 権限を確認」（other） |
| §19.2 部分失敗 | コミット成功・MR 作成失敗 | エラー（other / permission）にブランチ名とコミットを添え、「GitLab の画面からこのブランチの MR を作成」と案内（ダウンロード切替は出さない） |
| §19.2 保存後 | 続けて編集 | 保存成功で下書きを消し、編集をロック。「新しく編集を始める（元のデータから）」で元に戻す（同じ変更を 2 度送らない） |
| §19.2 最終コミット ID | 浅いクローン | 浅いクローンでは誤った ID を返しうるので null（競合検出なし。画面に注記）。CI の build ジョブは `GIT_DEPTH: "0"` |
| §19.2 下書き | 形式 | `version: 2` = 土台（生テキスト・最終コミット ID）＋差分（`changed: [{baseIndex, cells}]`・`removed: [baseIndex]`・`added: [cells]`）。キーは `yojitsu-navi:masters-draft:v1` のまま。以前の `version: 1`（編集後の全行）は読み込み時に差分へ直す。復元か破棄を選ぶまで自動保存しない |
| §19.2 下書き | 土台が変わったとき | 復元時に `rebaseDraftFile` で最新の土台（このビルドの元データ）へ当て直す。行の対応は「最新のヘッダの列名で並べ trim した内容」の LCS（前後の共通部分を除いた残りが 4,000,000 セルを超えるときは順序を保つ貪欲法）、対応しなかった行は前後の対応行に挟まれた区間で同じキー（適用開始月／開始月も同じものを優先）の行と対にする。衝突（both-changed / changed-vs-deleted / deleted-vs-changed）は行ごとにラジオで「自分の下書き／最新のデータ」を選ばせ、全部選ぶまで復元しない（押すと案内して最初の未選択へフォーカス）。「自分」を選んだ最新側で削除済みの行は、追加行の手前（末尾）に戻す。画面の `bases` は凍結し、古い土台で保存・ダウンロードする経路を無くした |
| §19.2 download | 他人の更新の上書き | ダウンロードボタンの横に元データのコミット（先頭 8 桁）を出し、手順に「GitLab 上のファイルの最新コミットと違えばアップロードせず、ビルド後に再読み込み」を加えた（ブラウザからは GitLab の最新を確かめられないため、案内で止める） |
| §19.1 影響の文 | 何が変わるか | `impactOfChange` が「変わる月に値が変わる列」（`Impact.columns`）も返し、`describeImpactEffects` で列ごとの文に直す（役職・単価 → 単価と実績・残予算・消化率・着地見込み、所属チーム → 組織別の集計、部署・課・氏名・区分 → 表示、チームの親 → 組織の木と上位の合計、アサイン → 着地見込みと計画）。メンバーで実績が変わらないときは「実績・残予算・消化率・着地見込みは変わりません」と明記。`effective_from` だけが違い値が同じ月は変わる月に数えない |
| §20.2・§81 | 取り込み列 | members の member_id / name は保存済みの行で常に読み取り専用（§81。CSV で編集も無し）。`memberSourceAdapter != "none"` のときは `memberImportedColumns`（config の columns に書いた列）も読み取り専用。既存行は削除不可（取り込みで管理する行のため）。追加は社員番号を選ぶと取り込み列を最新行から写す |
| 色 | エラーの色 | 検証のエラー（保存を止める）は赤（`--yn-danger-*`）、警告（止めない）は黄（`--yn-warn-*`）。どちらも「!」「i」と「エラー」「警告」の文字を付ける（2026-10-29 に変更。§40） |
| §40 検証の一覧 | 探しやすさ | 検証の欄にエラー・警告を名前つきで 1 件 1 行。押すと該当の行へ（他の画面は `?jump=ファイル:行番号`）。ファイル単位の「エラーのあるファイル」は廃止 |
| §41 1.0 未満 | リソース計画の色 | 人の行の月合計が 0 より多く 1.0 未満のセルは青系（`--yn-under-*`）、1.0 超は黄。0 は色なし |
| §58 月別の合計 | リソース計画のグラフ | 表の上に運用保守／運用保守以外の積み上げ棒（`planLoadChart`、`work.js`）＋人数 × 1.0 の破線＋1.0 超の人数「!n人」。表を描き直すたびに高さが 0 にならないよう `.yn-me-plan-chart .yn-chart-plot` に最小の高さ |
| §99 並べ替え・絞り込み | リソース計画の見出し | マスタ編集の台帳と同じ見出しの部品（`sortFilterHead`、並べ替えのボタン＋漏斗。`createFilterPopover`）。月の列は狭いので `th.num.has-filter` の左右の余白を詰め、見出しは「n月」のまま（吹き出し・読み上げは「YYYY年n月」）。開いた明細・変更の履歴は人の行について動く |
| §66 内訳の見分け | リソース計画の開いた内訳 | `.yn-me-plan-sub` は左端の帯（inset box-shadow）・12px の控えめな数値・枠なしの文字ボタン。`renderPanel` は同じ表の描き直しで `.yn-me-table-wrap` のスクロール位置を引き継ぐ |
| §65 変更の影響 | リソース計画の保存の前 | 差分の下・保存の上に「変更の影響」（`renderImpact`、計算は `core/planImpact.ts`）。アサイン・メンバー・単価に変更があるときだけ出す。前の値は muted、後の値は通常の色、マイナスの残予算・増えた着地は赤。表の中の読み上げ用「から」（`position: absolute`）が枠の外へ出て 390px で横スクロールになったので、`.yn-me-impact .yn-table-wrap` に `position: relative` |
| §112 人の行と作業の行 | リソース計画の表 | 開閉は名前の欄のボタン `.yn-me-plan-toggle`（▸/▾ `.yn-me-plan-caret`・作業の数 `.yn-me-plan-count`、`data-fk="plan:toggle:<社員番号>"`）。作業の行は `th::before/::after` で枝の線（最後の作業の行に `is-last`、その後ろの履歴に `is-after-last`）。開いたまとまりの上下に 2px の区切り。「すべて開く」は `data-fk="plan:expand-all"`。開いている人は `plan-list`（sessionStorage）に `open` で覚える |
| §116 計画なしの人 | リソース計画の表 | 判定は `emptyMonthIdx`（core の `planNeededMonths` × 今月以降 × 月の合計 0。人ごと）。名前の横に `.yn-chip-empty`、月のセルに `is-empty`（「なし」・点線）、絞り込みは `data-fk="plan:empty-only"`（`aria-pressed`。`plan-list` に `emptyOnly` で覚える。該当者が 0 人になると外す）。色は `--yn-empty-text/-bg`（赤紫。黄＝1.0 超・青＝1.0 未満・赤＝目標・紫＝運用保守以外のグラフと分ける） |
| §110 目標の警告 | リソース計画の表・グラフの上 | `planAlertsEl`（計算は `core/planTargets.ts`）。未達見込みの目標を 1 件 1 行（`h()` で作る）、3 件まで＋「ほか n件」。月の見出しに `.yn-me-plan-target-mark`。描き直しが多いので `planTargetAlertsFor` で組織・組織の月・`validation` が同じなら前の結果を使う。390px では 1 件が折り返して 3 行になる |
| §113 今月の残り | ヘッダー右上・メンバー詳細 | カードは `myHoursCard`（`components/my-hours.js`。ヘッダーの head のスクリプトでも使うので素の DOM で書き、外の変数を参照しない）。ヘッダーのボタンは `.yn-tools` の先頭に足し、`.yn-topbar.has-my-hours` で「作業実績の取得」を隠す。吹き出しは 640px 以上はボタンの右端に合わせ、それ未満は `position: fixed` で画面の幅（左右 8px）、縦はボタンの下（開くときに `--yn-my-hours-top` を入れる）。案件名は折り返す |
| 単価の表示 | 単位 | 金額の表示単位（円／千円／百万円）の切替に関係なく、CSV の値（円）をそのまま表示・入力する |

### テスト

単体 `tests/unit/masterEdit.test.ts`・`tests/unit/gitlab.test.ts`（モック fetch で全分岐）、プロパティ `tests/property/masterEdit.property.test.ts`（書き出し→再読み込みで同値、未変更行のバイト保持、任意の編集列で差分が正しい）・`tests/property/masterRebase.property.test.ts`（任意の土台の変更と下書きの差分で、衝突しない行は保たれ、衝突は両方が同じ行を違う結果にした行ちょうど。当て直しは決定的・冪等）、結合 `tests/integration/masters.test.ts`（ダミーデータの 4 ファイルで 編集→書き戻し→loadDataset / validate-data / buildModel）、E2E `tests/e2e/masters.spec.ts`（masters.json を `page.route` で書き換えて gitlab モード・取り込みモードを再現し、GitLab API を `page.route` でモック）、モンキー（`/masters` を対象に追加）。

## 台帳とリソース計画（SPEC §36）— 決定事項

| 箇所 | 曖昧点 | 決定 |
|---|---|---|
| 台帳の行 | どの値を出すか | 基準月（`asOfMonth`）に有効な履歴の値。基準月にまだ始まっていない対象は最初の履歴の値と「YYYY年M月から」。基準月より後の履歴は列ごとに「YYYY年M月〜 値」と「予定 n」 |
| 台帳の履歴 | 並び | 適用開始月の順（同じ月はファイルの後の行）。月の誤りの行は最後に。前の履歴から変わった列だけ「前 → 後」、変わらない列は薄く |
| 台帳の名前 | 先頭の列 | メンバー・組織は名前（下に ID を小さく）。履歴で名前が変わったら先頭のセルに「氏名: 前 → 後」。操作ボタンの名前も名前で呼ぶ（ID は出さない。§31.1） |
| リソース計画の行 | まとめる単位 | 人 → 案件（`projectKey` = 顧客 × 案件名。契約の更新で分かれていても 1 行）→ 運用保守以外の種別ごとの行（その人に表示中の期間の計画か実績がある種別だけ。ほかはセルの「作業を追加」か人の行の「＋ 作業」から足す。§50.3・§50.6）。人の行の月の値は保守の配分＋すべての種別の運用保守以外の予定 |
| ＋ 変更 | 何を書き換えるか | `replaceRange`: 期間の外は変えない、中は指定の値（0 で外す）。分けた行の前後で同じ契約・同じ値の行とつなげ、消える行の ID を新しい区間に使い回す（差分が「期間の変更」になり、元に戻すと差分なし）。重なりのある期間は書き換えず案内 |
| 行き来 | 下書きの扱い | sessionStorage に最後に書いた下書きの `savedAt` を置き、同じタブ・土台が同じなら黙って続きから（`DRAFT_SESSION_KEY`）。別のタブ・後日だけ「復元 / 破棄」を聞く |
| 運用保守以外の予定 | ファイルが無い | 見出しだけの空ファイルとして扱い、保存時は GitLab に `create`。CSV 編集では 2 ファイル（アサイン・運用保守以外の予定）を並べる |

## ドキュメントの更新（2026-10-28 指示）

画面・データ・操作を変える PR では、**同じ PR で** README・docs（SPEC・DATA・UI_NOTES・TEXTS・DEPLOY_GITLAB）と `tests/e2e/README.md` を直す。古い説明を残さない。README・docs に画像（スクリーンショット・バッジ）は載せず、リポジトリに画像ファイルを置かない（2026-10-29 指示。画面を変えるたびに古くなり、npm パッケージも大きくなるため）。`tests/unit/docs-links.test.ts` がリポジトリ全体を拡張子と中身（先頭のバイト）で調べ、許可リスト `IMAGE_ALLOWLIST`（`scripts/lib/image-detect.mjs`。今はファビコンの 3 ファイルだけ）以外を落とす。`npm run app:pack` も画像が入ると失敗する。

## メンバー別（`/members`・`/member?id=`、SPEC §18.2）

| ページ | 問い | 構成 |
|---|---|---|
| `/members` メンバー別（上部タブ） | 誰が計画どおりに動いているか | KPI 4 枚（計画額・実績・差額・稼働率）→ 検索 → 一覧（並べ替え・Excel・合計行） |
| `/member?id=` メンバー詳細（タブには出さない） | この人の計画と実績はどうか | 基本情報（所属・役職・所属組織＝事業本部・部・課、所属・役職の変遷は折りたたみ）→ 今月の残り（§113）→ KPI 4 枚 → 月次推移（計画時間＝青・実績時間＝橙の棒 ＋ 月表）→ 契約別 → 単価の変遷 |

### データの流れ

- 両ページは `model.json` と `data/member-months.json`（`src/data/member-months.json.ts`）を `Promise.all` で並行して読み、`{...model, memberMonths}` にして core の `aggregateMembers` / `memberMonthlySeries` に渡す（`loadJson` に `{json: async () => ...}` を渡して読み込み中・エラー表示を共通化）。他のページは member-months.json を読まない（model.json は 540 KB のまま）。チーム一覧は体制図に切り替えたときだけ読む（SPEC §76）。
- 単価の変遷は member-months.json の `rateHistory[memberId]`（ビルド時に `memberRateHistory` で計算）。

### 決定事項

| 箇所 | 決定 |
|---|---|
| 比較の母集団 | **経過月**（期間開始〜`min(期間終了, 基準月)`）。KPI・一覧・契約別・合計行はすべてこの期間を `aggregateMembers` に渡す。期間全体（未来月を含む）の計画は KPI の補足（「期間全体 X円」。一覧・詳細とも）と詳細の月次推移で示す（注記は出さない。SPEC §37）。期間がすべて未来なら期間全体（実績 0）で表示し注記。SPEC §18.2 に追記済み。Excel のファイル名も比較期間（`members_2026-04_2026-10.xlsx`） |
| 稼働率・差額の色 | 色を付けない（赤は §12 の 2 つだけ）。差額は `moneySigned`（+ / − / ±0）。E2E で `.yn-danger-text` 等が 0 件であることを確認 |
| 一覧の列 | メンバー（1 行目 名前、2 行目 ID・所属チーム・役職）／計画時間／実績時間／稼働率／計画額／実績／差額／状態。所属チーム・役職・区分・ID は列を分けると 1280・1024px に収まらないため 2 行目に入れ、Excel には別列（`exportOnly`）で出す。状態（マスタ未登録・単価なし・アサイン外 Nh）はニュートラルのチップで、820px 以下で隠す。速報は行ごとに出さず見出しのバッジだけ（ほぼ全員に付くため） |
| 既定の並び | 差額の昇順（計画より実績が多い人が先頭） |
| チーム絞り込み | 所属チーム（基準月の値、配下を含む）。「未設定」は所属チームが空か基準月の組織に無いメンバー。絞り込みは「全員を集計 → 該当 ID で `aggregateMembers(memberIds)` を呼び直す」（合計もコア） |
| 検索 | 名前・ID・役職・所属チームを `normalizeName` で部分一致（`onTextInput()` で 150ms デバウンス・変換中は反映しない、URL の `q` を初期値に）。合計行は表示中のメンバーで `aggregateMembers` を呼び直す |
| 根拠パネル | `memberPlanSpec`（契約×月ごとの 配分・計画時間・単価・単価の出どころ・計画額）、`memberActualSpec`（契約×月の実績行 → 作業ログを遅延読み込み。契約ごとの `fetchWorklogs` をメンバーで絞る）、`memberVarianceSpec`、`memberUtilizationSpec`、`memberTotalsSpec`（合計行・一覧の KPI）。時間の列も同じ spec を `measure: "hours"` で使う。単位が百万円（`"m"`）のときは根拠パネルだけ円で出す（1 人の金額は小さいため） |
| 詳細の月表 | 期間全体の各月。未来の月は実績・稼働率・差額を「—」（根拠ボタンなし）、計画は表示。合計行は経過月の合計（ラベルに期間を明記） |
| 詳細の契約別 | 経過月。アサインの無い契約は「アサインなし」、アサイン期間外の月に作業があれば「アサイン外 Nh」（ニュートラル）。行クリックで案件詳細 |
| 遷移 | 一覧の行 → 詳細、詳細の契約行 → 案件詳細、案件詳細「メンバー別の実績」の行 → メンバー詳細（`rowHref` を追加しただけ） |
| 存在判定 | members.csv にあるか、memberMonths に出てくれば存在。どちらも無い ID は空状態＋「メンバー別へ戻る」 |
| KPI 4 枚の並び | `.yn-kpi-4`（style.css の members 節）: コンテナ 760px 以上で 4 列、未満は 2×2、480px 以下は 1 列（auto-fit の 3+1 崩れを防ぐ） |
| グラフ | `charts.memberHoursChart`（計画=青＝予、実績=橙＝実。既存の予算／実績と同じ色の意味）。基準月以降は背景を薄く。目盛りは 44px/目盛りで間引く（390px でも重ならない） |

## 閲覧画面のレビュー指摘の反映（M3・M5・L1・L2・L3・L4・L6・L9）— 決定事項

- **明細の金額は円（M5, SPEC §12）**: table.js に列 `type: "moneyYen"` を追加。選択単位に関係なく円で描き、見出しに「（円）」を付ける（Excel の列名も同じ「…（円）」・金額は円の整数）。集計行・KPI・月次推移は従来の `type: "money"`（選択単位に従う）。適用先: 案件詳細の作業ログ（単価・金額）とメンバー別の実績、チーム詳細のメンバー別の実績、メンバー詳細の月ごと・契約別の計画額/実績/差額と単価の変遷。
- **メンバー一覧の行は「集計行」（M5）**: メンバー×期間の計画/実績/差額は 1 人の期間合計で、百万円でも 0.0 だらけにならない（既定期間で 0.1〜数百万円）ので、契約・チーム・顧客の一覧と同じく選択単位に従う。0.0 で読めなくなる粒度（1 か月×1 契約など）はメンバー詳細の明細（円）で見る。
- **差額に添える文は丸め後で判定**（`format.js` の `varianceNote`）。「±0.0百万円」なのに「計画より実績が少ない」と出さない。
- **根拠パネルは常に円（M3）**: チーム詳細のメンバー別実績の根拠（`memberCostSpec`）も、実績合計・実績行・合計を円で出す。
- **「単価なし」は赤にしない（L1）**: チップは neutral、案件一覧の「単価なし含む」は muted。赤は消化率超過と超過見込みだけ（SPEC §12）。
- **案件一覧の顧客絞り込み（L2）**: `/contracts?customer=<顧客キー>`（厳密一致。検索語 `q` の部分一致とは別）。`direct=1` を付けると、`team` の配下を含めず主担当チームがちょうどそのチームの案件だけ。顧客詳細の担当チーム行（契約に登録された主担当チームごと）はこの 2 つで遷移するので、遷移先の件数が行の案件数と一致する。絞り込み中は表の上に注記と「絞り込みを解除」リンク。未知の顧客キーは警告と 0 件。
- **顧客詳細はチーム絞り込みを引き継ぐ（L3）**: 顧客別の一覧と同じ母集団（選択チームの配下を含む契約）で集計し、チーム選択を絞り込みバーに出す。絞っているときは「全 N 件のうち M 件」の注記（M=0 は警告）。外したら注記は消える（Framework の display は出力が無い再実行で前の出力を消さないので、空の要素を出す）。
- **メンバー別のチーム絞り込み（L4）**: 対象の人は期間全体（未来月を含む）で決める（`analysis.js` の `memberIdsInTeam`）。経過月だけで決めると、未来月にだけアサインのある人が期間全体の計画から抜ける。
- **合計行の着地差（L6）**: 年度に掛かる契約が 0 件なら「—」（`forecastTotals.contractCount` は全案件数なので使わない）。table.js の列オプション `summaryDash`（合計行が null のとき空欄でなく「—」）を着地差列に付けた。
- **メンバー一覧（L9）**: 「メンバー」列は名前順（以前は ID 順）。検索欄の案内・aria-label にチームを追加（チーム名でも絞れる）。マスタの影響ダイアログは別担当。

## 説明文を「?」に寄せる — 決定事項

- **画面の本文には説明文を出さない**: ページ冒頭の説明（`pageHeader` の `lead`）とセクション見出しの補足（`sectionTitle` の第 2 引数）は、見出し横の「?」（`layout.js` の `infoTip`）に入れる。カーソルを合わせる・フォーカス・タップで吹き出しが開き、Esc・フォーカス移動・スクロールで閉じる。吹き出しは幅 360px（狭い画面は左右 16px を残す幅）で、下に入らなければボタンの上に出す。それでも入らない長さは画面内に収めて中をスクロールできる（中のスクロールでは閉じない）。
- **見出しの下に残すのは今の状態だけ**: 「期間外の N 件は非表示」などは `sectionTitle` の第 4 引数 `status` で見出しの下に出す。警告・エラー（`yn-note-warn` / `yn-note-danger`）、絞り込み中の注記、計算根拠パネルの注記は従来どおり本文に出す。
- **KPI の前年同期比**: タイルには「前年同期比 ±金額」だけ。比較した期間はカーソルを合わせると出る（`T.kpi.compareText` を title に）。
- **マスタ編集**: 「はじめての方へ」は廃止（SPEC §37）。各タブの「内容・変えると・編集のしかた」はタブ見出し横の「?」。検証・変更内容・保存の補足、CSV ダウンロードの手順も各見出しの「?」。
- **量の上限（SPEC §37）**: `tests/e2e/screen-text.spec.ts` が各画面の本文の文章を数える（合計 120 文字・1 段落 70 文字まで）。超えたら文言を短くするか「?」へ移す。経過月の注記は KPI の「期間全体」に置き換えた。
- **ダイアログ・下書きの欄も同じ（SPEC §42）**: 行の追加・修正・変更、リソース計画のセルのダイアログの説明は見出し横の「?」。別のタブで開いたときの下書きの欄は「いつ・何件」と復元／破棄のボタンだけ。保存のあとの補足も「?」。
- **GitLab の設定は設定画面だけ**: マスタ編集・リソース計画の保存欄にトークンの入力欄は置かない（未登録なら「設定へ」のリンク）。
- **設定の不足は「接続を確認」の結果の中だけ**: 本番の GitLab の設定の不足（SPEC §39.3）は、接続の確認の結果枠の中に警告の一覧として出す（枠は警告色）。直し方の説明は画面に書かず、`docs/DEPLOY_GITLAB.md` に置く。

## 今月の進捗（SPEC §61）— 決定事項

- 部品は `src/components/daily.js`（`loadDaily` / `dailyFor` / `dailySection`）。全体・チーム詳細・顧客詳細・案件詳細が `data/daily.json` を読み、月次推移の下に出す。`dailyFor` が null（今月を含まない期間・今月の予算 0・読めない）なら何も出さない。
- 月次推移（棒グラフ）を上に残す（2026-10-30 依頼者）。今月の進捗はその下。
- 見出しは「今月の進捗」（2026-10-30 依頼者。「今月の進み」から改名）。
- 目標（§63）があると上限が変わる（マイナスの目標なら予算より上）。KPI の補足は「目標の残予算率 n%（予算の m%）」の 1 行だけ（説明は「?」と根拠）。
- グラフの目標（§63.3）: 月次推移に「目標の上限」を赤の破線（予算と実績の棒をまたぐ横線）。凡例・表の列は目標がある対象だけ（無い対象の凡例を増やさない）。今月の進捗の凡例は「上限（目標）」。
- 1 か月分の金額は小さく百万円の小数 1 桁では差が見えないので、この節だけ百万円は小数 2 桁（KPI・グラフ・表。Excel は他の表と同じく円）。
- 赤は「このペースの月末」が上限を超えたときと、今日までの実績が目安を超えたとき（どちらも 100% 超）。黄色は使わない。

列幅（SPEC §77）: `dataTable` の各見出しに `.yn-col-resizer`（`bindColResizer` は `src/components/col-resize.js` でマスタ編集と共通）。境目は右隣の見出しにまたがるので、見出しの `z-index` を左ほど大きくしている（先頭の列は最前面）。幅は `localStorage` `yojitsu-navi:col-width:<path>:<caption>`。描き直しのたびに `applyColWidths()` で全行のセルに幅を当てる。

列の表示・並び順（SPEC §106）: `src/components/column-prefs.js`（`columnsButton`・`arrangeColumns`）。`dataTable` はツールバー右の `.yn-table-actions` に「列」（`.yn-cols-btn`）と Excel 出力を並べ、`visibleCols` を設定から作り直して `renderHead()`/`renderBody()`。マスタ編集の台帳は `drawPanel()` の値の列を並べ替え、描き直しでも一覧を開いたまま（ボタンは `data-fk="cols:<ファイル>"` で付け直す）。設定は `localStorage` `yojitsu-navi:columns:<path>:<caption>`（台帳は `masters:<ファイル>`）。文字だけの列のセルは `.yn-cell-clip`（上限の幅で「…」、title に全文）。 列の `optional: true` は選べる列（既定で出さない。`prefs.shown`）、`exportAlways: true` は画面で隠していても Excel に出す。予実の行の選べる列は `totalsExtraColumns()`（`standardColumns` が足す）、案件の行は `contractInfoColumns()`（§106.1）。

列の絞り込みの吹き出しは `createFilterPopover({ getRows, unit, getFilter, setFilter })`（table.js）に切り出し、一覧表とマスタ編集の表（§73.1、`listFilter[fileId].cols`・`.sort`）で共通。マスタ編集は表ごと描き直すので、描き直したあと `rebind(key, 新しいボタン)` で開いている吹き出しを付け直す。
