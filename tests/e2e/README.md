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
| `numbers.spec.ts` | KPI・チーム行・契約行・契約詳細の月行が core の `aggregate` / `forecastTotals` / `ContractMonth` と一致。千円、期間プリセット、from/to、着地方式、チーム絞り込み、URL ⇄ 状態、localStorage |
| `breakdown.spec.ts` | 内訳パネル: 原価（契約ごとの合計 = 表示値）、作業ログの遅延読み込み、予算の月割り（C005: 3,166,666 / 最終月 3,166,674）、消化率、着地見込みの算術、Esc・フォーカス復帰・フォーカストラップ |
| `navigation.spec.ts` | チーム → 契約一覧（team=）→ 契約詳細、パンくず、同じチームの契約一覧、木の折りたたみ、並べ替え（aria-sort・数値順）、絞り込みチップ・検索、Excel 出力（`xlsx` で読み戻して見出し・数値を照合） |
| `a11y.spec.ts` | Tab 到達、aria-sort、dialog の role / aria-labelledby、img / svg の代替、状態チップの文字、390px 幅で横スクロール無し、ダークモード、印刷メディア |
| `monkey.spec.ts` | シード付きランダム操作（クリック・キー・select・リサイズ・戻る/進む）。毎操作後に 例外 0・console.error 0・`NaN/undefined/null/Infinity/[object Object]` 非表示・`—円` 非表示・h1 あり・ダイアログが Esc で閉じる、を確認。失敗時は操作履歴をメッセージと添付に出す |

## 失敗したとき

- レポート: `tests/e2e/report/index.html`（`npx playwright show-report tests/e2e/report`）。CI で保存するなら `tests/e2e/report/` をアーティファクトにする
- スクリーンショットとトレース: `tests/e2e/test-results/`（トレースは CI のリトライ時のみ `trace: on-first-retry`）
- モンキーの再現: `MONKEY_SEEDS=<seed> npx playwright test -c tests/e2e/playwright.config.ts monkey -g "seed=<seed>"`。エラーメッセージの trace が操作の順序

## 設計メモ

- セレクタは `docs/UI_NOTES.md` のもの（`.yn-kpi .yn-kpi-value`、`.yn-seg-btn[data-preset|data-unit]`、`#yn-filter-from/to/team`、`input[name=yn-method]`、`dialog.yn-dialog[open]`、`table tbody tr[data-key]`、`.yn-row-link`、`.yn-tree-toggle`、`.yn-table-toolbar .yn-export`、`#yn-f-*`、`.yn-forecast-card.is-selected`）。表の列は**見出しの文字**（予算・原価・粗利…）で引くので列の追加・並び替えに強い
- `helpers/app.ts` の `test` は auto フィクスチャで console.error / pageerror / 失敗リクエストを集め、テスト終了時に 0 件を要求する
- `helpers/core.ts` が `src/core` と `scripts/lib/load.ts` を直接 import する（Playwright の TS ローダが `.js` 拡張子の import を `.ts` に解決する）
