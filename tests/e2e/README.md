# E2E テスト（Playwright）

ビルド済みの `dist/` を静的サーバで配信し、Chromium（headless）で画面を検証する。
計算の期待値は `data/` から計算コア（`src/core`）で作った Model（`buildModel(dataset, {asOf: "2026-10-27"})`）なので、
**画面の数値は必ず core と一致**しなければならない。

```bash
npm run test:e2e                      # 全件 = playwright test -c tests/e2e/playwright.config.ts
npm run test:e2e:smoke                # 縮小版 = 上に --grep @smoke
```

## 縮小版（`@smoke`）

GitHub Actions の分数を節約するため、CI は Pull Request では縮小版、`main` への push（マージ）では全件を走らせる（`.github/workflows/ci.yml`）。
縮小版は `{ tag: "@smoke" }` を付けたテストだけ（約 40 件、ローカル 2 workers で 40 秒前後）:

- `smoke.spec.ts` のすべて（全ページがエラー 0 で開く、404）
- `screen-text.spec.ts` の各画面の説明文の量
- 主要な操作の代表 1〜2 件ずつ: KPI の突合と単位の切替（numbers）、遷移と上部タブ（navigation）、計算根拠（breakdown）、顧客・メンバー・工数の画面、マスタ編集の追加とダウンロード（masters）、デモの保存 → マージ（gitlab-merge）、稼働計画の表示とセルの修正（plan / plan-cells）、検証の一覧から該当の行へ（issue-list）、テーマ切替（ui-controls）

画面幅・ダーク・モンキー・回帰などは全件だけで走る。全件はマージ前にローカルで通す。主要な画面・操作を足したら、その代表のテストに `@smoke` を付ける。

## 流れ

1. `global-setup.ts` が `YOJITSU_AS_OF=2026-10-27 npm run build` を 1 回実行（`E2E_SKIP_BUILD=1` で省略。dist が無ければ結局ビルドする）。入力が変わっていればキャッシュは `npm run build` が捨てる（docs/DATA_LOADERS.md）
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
| `smoke.spec.ts` | 全ページがエラー 0・失敗リクエスト 0 で開き、h1 と計算基準日 2026-10-27 がある（稼働計画・マスタ編集・設定は計算基準日の表示が無いので h1 まで） |
| `numbers.spec.ts` | KPI・チーム行・契約行・案件詳細の月行が core と一致。単位の切替、期間プリセット、着地方式、チーム絞り込み、URL ⇄ 状態 |
| `breakdown.spec.ts` | 計算根拠パネル: 実績・作業ログの遅延読み込み・予算の月割り・消化率・着地見込み、Esc・フォーカス |
| `navigation.spec.ts` | 遷移・パンくず・木の折りたたみ・並べ替え・絞り込み・Excel 出力（読み戻して照合） |
| `customers.spec.ts` / `members.spec.ts` / `team-detail.spec.ts` / `workload.spec.ts` | 顧客別・メンバー別・チーム詳細・工数の各画面（数値の突合・遷移・Excel・狭幅・ダーク） |
| `detail-view.spec.ts` | 閲覧画面のレビュー指摘の回帰（明細は常に円、単価なしは赤くしない、顧客 → 案件一覧の絞り込み など） |
| `masters.spec.ts` / `gitlab-merge.spec.ts` | マスタ編集（追加・修正・削除・下書き・差分・保存方式）と GitLab へのマージ方式（デモ・API のモック） |
| `plan.spec.ts` / `plan-cells.spec.ts` | 稼働計画（組織の配下・リーダー・セル編集・案件で選ぶ・候補から選ぶ入力欄・1.0 超は黄／1.0 未満は青系。SPEC §41） |
| `issue-list.spec.ts` | 検証の一覧（1.0 超は警告・名前で示す・押すと該当の行へ（組織・年度・絞り込み・他画面）・8 件超・エラー赤／警告黄・各画面幅・ダーク）。SPEC §40 |
| `chart-zoom.spec.ts` | グラフの拡大表示（ダイアログで描き直す・開く・閉じる・はみ出さない・吹き出し。各画面幅・ライト/ダーク）。SPEC §33 |
| `ui-controls.spec.ts` | テーマ切替・期間指定・「?」の吹き出し（各画面幅・ライト/ダーク） |
| `screen-text.spec.ts` | 画面の説明文の量（各画面の本文の文章は合計 120 文字・1 段落 70 文字まで。説明は「?」へ）と、GitLab のトークン入力が設定画面だけにあること。SPEC §37 |
| `scale-data.spec.ts` | 実運用規模のデータ: 退職者の表示、すべて 0 のグラフ、長い名前で 390px からはみ出さない |
| `qa-regressions.spec.ts` | 実操作 QA で見つけた不具合の再発防止 |
| `a11y.spec.ts` | Tab 到達、aria-sort、dialog の role、画像の代替、状態チップの文字、390px、ダーク、印刷 |
| `monkey.spec.ts` | シード付きランダム操作（クリック・キー・select・リサイズ・戻る/進む）。毎操作後に 例外 0・`NaN` 等の非表示・h1 あり・ダイアログが Esc で閉じる、を確認。候補の判定はページ内で 1 回にまとめている（5 倍データでボタンが数千あるため） |

## 失敗したとき

- レポート: `tests/e2e/report/index.html`（`npx playwright show-report tests/e2e/report`）。CI で保存するなら `tests/e2e/report/` をアーティファクトにする
- スクリーンショットとトレース: `tests/e2e/test-results/`（トレースは CI のリトライ時のみ `trace: on-first-retry`）
- モンキーの再現: `MONKEY_SEEDS=<seed> npx playwright test -c tests/e2e/playwright.config.ts monkey -g "seed=<seed>"`。エラーメッセージの trace が操作の順序

## 設計メモ

- セレクタは `docs/UI_NOTES.md` のもの（`.yn-kpi .yn-kpi-value`、`.yn-seg-btn[data-preset|data-unit]`、`#yn-filter-from/to/team`、`input[name=yn-method]`、`dialog.yn-dialog[open]`、`table tbody tr[data-key]`、`.yn-row-link`、`.yn-tree-toggle`、`.yn-table-toolbar .yn-export`、`#yn-f-*`、`.yn-forecast-card.is-selected`）。表の列は**見出しの文字**（予算・実績・残予算…）で引くので列の追加・並び替えに強い
- 単位: 画面の既定は百万円（`DEFAULT_UNIT` は config から導出）。厳密に突き合わせるテストは URL に `unit=yen` を付けて円で比べ、既定単位の画面は `yen(v, DEFAULT_UNIT)` で比べる。計算根拠 dialog と Excel の金額は常に円（`yen(v, "yen")`）
- `helpers/app.ts` の `test` は auto フィクスチャで console.error / pageerror / 失敗リクエストを集め、テスト終了時に 0 件を要求する
- `helpers/core.ts` が `src/core` と `scripts/lib/load.ts` を直接 import する（Playwright の TS ローダが `.js` 拡張子の import を `.ts` に解決する）
