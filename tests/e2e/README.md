# E2E テスト（Playwright）

ビルド済みの `dist/` を静的サーバで配信し、Chromium（headless）で画面を検証する。
計算の期待値は `data/` から計算コア（`src/core`）で作った Model（`buildModel(dataset, {asOf: "2026-10-27"})`）なので、
**画面の数値は必ず core と一致**しなければならない。

```bash
npm run test:e2e                      # = playwright test -c tests/e2e/playwright.config.ts
```

## 流れ

1. `global-setup.ts` が `YOJITSU_AS_OF=2026-10-27 npm run build` を 1 回実行（`E2E_SKIP_BUILD=1` で省略。dist が無ければ結局ビルドする）
2. `webServer` が `node tests/e2e/serve.mjs dist 4173` を起動（cleanUrls: `/teams` → `teams.html`、無いものは 404、`/__health` は常に 200）
3. 各 spec が `http://127.0.0.1:4173` を開いて検証

## 環境変数

| 変数 | 意味 |
|---|---|
| `PW_CHROMIUM_PATH` | Chromium の実行ファイル。Playwright の版と同梱ブラウザの版がずれている環境（例: `/opt/pw-browsers/chromium`）で設定する。CI は `npx playwright install --with-deps chromium` 済みなので**未設定**でよい |
| `E2E_SKIP_BUILD=1` | ビルドを省略して既存の `dist/` を使う（ローカルで繰り返すとき） |
| `E2E_PORT` | 配信ポート（既定 4173） |
| `MONKEY_SEEDS` | モンキーテストのシード。`1,2,3`（既定）のような一覧か、`10` のような個数 |
| `MONKEY_ACTIONS` | モンキーテストの 1 ページあたりの操作回数（既定 150） |
| `CI` | 設定時: retries 1、workers 2、`test.only` 禁止、既存サーバの再利用なし |

例（この開発コンテナ）:

```bash
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium E2E_SKIP_BUILD=1 npx playwright test -c tests/e2e/playwright.config.ts numbers   # 1 ファイルだけ
```

## スイート

| ファイル | 内容 |
|---|---|
| `smoke.spec.ts` | 全ページ（`/`, `/teams`, `/contracts`, `/contract?id=C008`, `/contract?id=NOPE`, `/rules`, `/data-check`）がエラー 0・失敗リクエスト 0 で開き、h1 と 計算基準日 2026-10-27 がある |
| `numbers.spec.ts` | KPI・チーム行・契約行・契約詳細の月行が core の `aggregate` / `forecastTotals` / `ContractMonth` と一致。既定単位（百万円）の検証、百万円→千円→円の往復、0.0百万円の丸め、期間プリセット、from/to、着地方式、チーム絞り込み、URL ⇄ 状態、localStorage |
| `breakdown.spec.ts` | 内訳パネル: 実績（契約ごとの合計 = 表示値）、作業ログの遅延読み込み、予算の月割り（C005: 3,166,666 / 最終月 3,166,674）、消化率、着地見込みの算術、Esc・フォーカス復帰・フォーカストラップ |
| `navigation.spec.ts` | チーム → 契約一覧（team=）→ 契約詳細、パンくず、同じチームの契約一覧、木の折りたたみ、並べ替え（aria-sort・数値順）、絞り込みチップ・検索、Excel 出力（`xlsx` で読み戻して見出し・数値を照合） |
| `a11y.spec.ts` | Tab 到達、aria-sort、dialog の role / aria-labelledby、img / svg の代替、状態チップの文字、390px 幅で横スクロール無し、ダークモード、印刷メディア |
| `customers.spec.ts` | 顧客別（`/customers`・`/customer?key=`）: core との突合、内訳パネル、検索・チーム絞り込み、遷移、Excel、記号を含む顧客名の URL 往復、ダーク・狭幅 |
| `members.spec.ts` | メンバー別（`/members`・`/member?id=`）: core との突合、計画・実績の内訳、遷移、Excel、ダーク・390px |
| `team-detail.spec.ts` | チーム詳細（`/team?id=`）: core との突合、配下チーム、契約一覧、メンバー別実績、組織の変遷、Excel |
| `workload.spec.ts` | 工数（`/workload`）: 軸ごとの表・作業種別の表が core と一致、契約外は契約の実績に入らない、Excel、ダーク・390px |
| `detail-view.spec.ts` | 閲覧画面のレビュー指摘（単位・単価なしの色・絞り込みの引き継ぎ等）の回帰 |
| `ui-controls.spec.ts` | テーマ切替・期間の「今月」とカレンダー指定・見出し横の「?」。各画面幅・ライト/ダークではみ出さない |
| `qa-regressions.spec.ts` | 実操作 QA で見つかった不具合の再発防止（URL の不正値、狭い幅のタブ、並べ替えの保持など） |
| `masters.spec.ts` | マスタ編集（台帳: 1 対象 1 行・変更の履歴・＋ 変更）。追加・修正・削除の確認と影響月、検証エラーで保存不可、差分、ダウンロードの中身、下書きの復元と当て直し、gitlab モード（API を `page.route` でモック）、取り込みモード、a11y・ダーク・390px |
| `gitlab-merge.spec.ts` | GitLab へのマージ方式: デモで CSV 編集 → MR → マージ待ち一覧・ヘッダーの件数 → マージ／取り下げ、can_merge の出し分け、設定画面、はみ出し |
| `plan.spec.ts` | 稼働計画: 組織の月合計が core（`planView`）＋契約外予定と一致、時間で入力して人月で保存、1.0 超、組織の種別とリーダー |
| `plan-cells.spec.ts` | 稼働計画のセル: 内訳の吹き出し、その場の修正（この月だけ／以降）、案件で選ぶ追加、過去月の確認、キーボード、候補の入力欄、ID を出さない表示 |
| `plan-history.spec.ts` | 稼働計画の持ち方（SPEC §32）: 人 → 案件・契約外予定の行、「＋ 変更」（期間を分ける・0 で外す・過去は確認）、変更の履歴からの修正・削除、契約外予定の CSV、旧 URL の転送と画面の行き来（下書きを聞かずに続き）、台帳の「＋ 変更」、人の絞り込み、各幅のはみ出し |
| `monkey.spec.ts` | シード付きランダム操作（クリック・キー・select・リサイズ・戻る/進む）。毎操作後に 例外 0・console.error 0・`NaN/undefined/null/Infinity/[object Object]` 非表示・`—円` 非表示・h1 あり・ダイアログが Esc で閉じる、を確認。失敗時は操作履歴をメッセージと添付に出す |

## 失敗したとき

- レポート: `tests/e2e/report/index.html`（`npx playwright show-report tests/e2e/report`）。CI で保存するなら `tests/e2e/report/` をアーティファクトにする
- スクリーンショットとトレース: `tests/e2e/test-results/`（トレースは CI のリトライ時のみ `trace: on-first-retry`）
- モンキーの再現: `MONKEY_SEEDS=<seed> npx playwright test -c tests/e2e/playwright.config.ts monkey -g "seed=<seed>"`。エラーメッセージの trace が操作の順序

## 設計メモ

- セレクタは `docs/UI_NOTES.md` のもの（`.yn-kpi .yn-kpi-value`、`.yn-seg-btn[data-preset|data-unit]`、`#yn-filter-from/to/team`、`input[name=yn-method]`、`dialog.yn-dialog[open]`、`table tbody tr[data-key]`、`.yn-row-link`、`.yn-tree-toggle`、`.yn-table-toolbar .yn-export`、`#yn-f-*`、`.yn-forecast-card.is-selected`）。表の列は**見出しの文字**（予算・実績・残予算…）で引くので列の追加・並び替えに強い
- 単位: 画面の既定は百万円（`DEFAULT_UNIT` は config から導出）。厳密に突き合わせるテストは URL に `unit=yen` を付けて円で比べ、既定単位の画面は `yen(v, DEFAULT_UNIT)` で比べる。計算根拠 dialog と Excel の金額は常に円（`yen(v, "yen")`）
- `helpers/app.ts` の `test` は auto フィクスチャで console.error / pageerror / 失敗リクエストを集め、テスト終了時に 0 件を要求する
- `helpers/core.ts` が `src/core` と `scripts/lib/load.ts` を直接 import する（Playwright の TS ローダが `.js` 拡張子の import を `.ts` に解決する）
