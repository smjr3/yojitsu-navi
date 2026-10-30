# 予実ナビ

保守契約の **予実（予算と実績）と残予算** を見るための社内ダッシュボードです。
契約総額を月割りした「予算」と、作業実績 × 時間単価で求めた「実績」を突き合わせ、
組織・顧客・案件・メンバーごとの消化率と選んだ期間の終わりの着地見込み（超過／範囲内。案件詳細では案件終了時点も）、稼働実績（工数）の内訳を表示します。

- 静的サイト（[Observable Framework](https://observablehq.com/framework/)）。サーバ不要、社内 GitLab Pages に公開
- データは CSV（`data/`）。Git で履歴管理し、CI で検証してから公開。マスタは画面で編集して GitLab に MR を作る
- 画面フォントは BIZ UDPゴシック（同梱、外部に取りに行かない。SIL OFL 1.1）
- 利用者向けの使い方はアプリの中（右端「⋯」→「使い方」）にあります。この README は開発・運用する人向けです
- 画面の文言は `src/i18n/` にまとめてあり、プログラムを触らずに書き換えられます（[docs/TEXTS.md](docs/TEXTS.md)）

## 画面

上部タブ（全体・チーム・顧客・案件・メンバー・稼働実績）と右上のリンク（リソース計画・マスタ編集）、右端のアイコン（設定・その他「⋯」）で移動します。ライト／ダークの切替は設定画面だけです。使い方（利用者向けのマニュアル）・データ確認・計算ルールは「⋯」のメニューにあります。

| パス | 内容 |
|---|---|
| `/` 全体 | 予算・実績・残予算・消化率・着地見込みの差、月次推移 |
| `/teams` → `/team?id=` チーム | 組織階層ごとの集計（配下を上位に積み上げ）→ チーム詳細（案件・メンバー別の実績・組織の変遷） |
| `/customers` → `/customer?key=` 顧客 | 顧客ごとの集計 → 顧客詳細（案件一覧・担当チーム別） |
| `/contracts` → `/contract?id=` 案件 | 案件ごとの予実（赤 = 消化率 100% 超 または 超過見込み）→ 案件詳細（月ごと・メンバー別・着地 3 方式・作業ログ） |
| `/members` → `/member?id=` メンバー | 計画と実績・稼働率 → メンバー詳細（月ごと・案件別・単価の変遷・退職） |
| `/workload` 稼働実績 | 運用保守／運用保守以外の稼働実績（人月）を組織・顧客・メンバー別に。作業種別の内訳 |
| `/plan` リソース計画 | リーダーが組織のメンバーの計画を入れる。人ごとに 1 行、開くと案件ごとの行と、運用保守以外の種別（提案・設計・会社業務など）ごとの行。途中で人月が変わるときは「＋ 変更」で「何月から何人月」を入れ、いつ変わったかは「変更の履歴」で見る（人月でも時間でも、保存は人月。SPEC §23・§36・§50） |
| `/masters` マスタ編集 | メンバー・単価・組織の台帳。1 対象 1 行で今の値、開くと適用開始月ごとの変更の履歴。「＋ 変更」で「何月から何に変わるか」を足す（ID は変えられない）。表／CSV で編集し、リソース計画の変更とあわせて GitLab に MR を作る。リーダーがマージ（SPEC §19・§36） |
| `/data-check` データ確認（「⋯」） | 未紐付けの作業実績・単価なし・退職後の実績などの警告 |
| `/guide` 使い方（「⋯」） | 利用者向けのマニュアル（画面の移り方・表示条件・数値の読み方・リソース計画・マスタ編集・設定・困ったとき）。アプリの中で完結し、外部の文書へ誘導しない（SPEC §47） |
| `/rules` 計算ルール（「⋯」） | 画面の数値の計算方法 |
| `/settings` 設定 | GitLab の接続（トークンの登録・接続の確認。権限と、本番の設定の不足も出す。GitLab の設定はこの画面だけ）、テーマ（ライト／ダーク） |

数値をクリックすると「式 ＋ 実際に使った値」の計算根拠が開きます。グラフは右上の「拡大」で大きく表示できます（スマホは全画面。SPEC §33）。
期間・チーム・単位・着地方式は URL（`?from=2026-04&to=2027-03&team=T111&unit=k&method=assignment`）に入るので、URL を共有すると同じ表示を再現できます。着地見込みの方式の既定は「計画値」（リソース計画 × 単価。`config.json` の `forecastMethodDefault`）。詳細から「戻る」と、一覧の絞り込み・並べ替え・スクロール位置はそのまま戻ります（SPEC §42）。

## ローカルで動かす

Node 20 以上（CI は Node 22）。

```bash
npm install
npx tsx scripts/generate-dummy.ts --asOf 2026-10-27   # ダミーデータを data/ に作り直す（リポジトリと同じ。--asOf を省くと今日の年度で作る。約 10 万行）
npm run validate                                      # データ検証（CI と同じ）
npm run dev                                           # http://localhost:3000（data/ や config.json を変えると自動で作り直す）
```

| コマンド | 内容 |
|---|---|
| `npm run check` | 型チェック + データ検証 + テスト（unit / property / integration） |
| `npm run test:e2e` | 画面の E2E 全件（Playwright。[tests/e2e/README.md](tests/e2e/README.md)） |
| `npm run test:e2e:smoke` | E2E の縮小版（`@smoke` の付いたテストだけ。全画面の表示と主要な操作。数十秒） |
| `npm run build` | `dist/` に静的サイトを生成し、出力を検証する（`YOJITSU_AS_OF=2026-10-27` で計算基準日を固定）。古いキャッシュは自動で捨てる（[docs/DATA_LOADERS.md](docs/DATA_LOADERS.md)） |
| `npm run app:pack` | 社内へ持ち込むパッケージ `packages/app/yojitsu-navi-<版>.tgz` を作る（`-- --with-deps` で依存込み。使い方は [docs/DEPLOY_GITLAB.md](docs/DEPLOY_GITLAB.md#0-持ち込むもの)） |
| `npm run core:build` / `npm run core:pack` | 計算コアを npm パッケージ `@yojitsu-navi/core` として `packages/core/` に出力する（`pack` は `.tgz` も作る。公開は [docs/DEPLOY_GITLAB.md](docs/DEPLOY_GITLAB.md#計算コアの-npm-パッケージyojitsu-navicore)） |
| `npm run fetch` / `npm run fetch:members` | 作業実績・所属を取り込み元から取り直す（[docs/OPERATIONS.md](docs/OPERATIONS.md)） |

ビルドは必ず `npm run build` を使います（`npx observable build` を直接使うと、データを直しても古い数字のまま公開されることがあります）。

## データファイルの編集ルール

ファイルの一覧と列は [docs/DATA.md](docs/DATA.md) を参照。文字コードは UTF-8（BOM 可）。Excel で保存した Shift_JIS も読めます。

- **履歴は行を追加、上書きしない**
  `teams.csv` / `members.csv` / `rates.csv` は `effective_from`（適用開始月）付きの履歴です。
  `teams.csv` の `level`（種別: 課・チーム・班など自由入力）と `leader_member_id`（リーダー）は省略可（SPEC §21・§22）。
  単価改定・昇格・異動・組織変更・退職は、**新しい `effective_from` の行を追加**してください（退職は `members.csv` の `status` 列に `退職`。SPEC §35）。
  既存行を書き換えると過去月の計算が変わってしまいます。
- 契約は 1 行 1 契約。更新契約は別の `contract_id` で行を追加し、`mapping.csv` にもその契約への紐付け行を足します
  （同じ顧客・案件名でも、作業日の月が契約期間に入るものに自動で振り分けられます）。
- `mapping.csv` の案件名を空にすると、その顧客の全工数が紐付きます。
- 名称の照合は正規化してから行うので、`株式会社` の有無・全角半角・前後の空白の違いは吸収されます（[docs/SPEC.md §4](docs/SPEC.md)）。
- 編集したら `npm run validate` で確認。CI でも同じ検証が走り、エラーがあると公開されません。
- `data/worklogs/YYYY-MM.csv` はアダプタが書き換えるので手で編集しないでください（csv アダプタ運用のときは例外）。

## 公開（GitLab Pages）

社内へは npm パッケージ（`.tgz` 1 つ）で持ち込みます。`npm run app:pack` で作り、社内で `yojitsu-navi init` するとプロジェクトのフォルダができ、push すれば Pages まで流れます。新しい版は `yojitsu-navi update` で `data/` と `config.json` を残したまま入れ替えます。社内 GitLab の URL はパッケージに入れず、社内で `init` するときに入れます（[docs/DEPLOY_GITLAB.md](docs/DEPLOY_GITLAB.md)）。

`.gitlab-ci.yml` のパイプラインは `validate → test → build → pages` です。既定ブランチでは `pages` ジョブが `dist/` を公開します。
GitLab 側の推奨構成（グループ・プロジェクト・保護ブランチ・権限・トークン）、展開の手順、社内で確認することのチェックリストは [docs/DEPLOY_GITLAB.md](docs/DEPLOY_GITLAB.md) にあります。
プロジェクトの設定は `GITLAB_TOKEN=… npm run gitlab:setup -- --api <URL> --project <グループ/プロジェクト>` で確認でき、`--apply` で推奨値に直せます。

CI/CD 変数・作業実績 API への切り替え・人事データの取り込み・マスタ編集の設定は [docs/OPERATIONS.md](docs/OPERATIONS.md) にあります。
画面もビルドも外部 CDN・外部サイトに接続しません。

計算コア（`src/core/`）は、ほかの社内プロジェクトから使えるよう npm パッケージ `@yojitsu-navi/core` として同じ GitLab の Package Registry に公開できます（タグ `core-v<版>` で CI が公開。[docs/DEPLOY_GITLAB.md](docs/DEPLOY_GITLAB.md#計算コアの-npm-パッケージyojitsu-navicore)）。

開発元の GitHub Actions（`.github/workflows/ci.yml`。社内へ持ち込むパッケージには入らない）は Pull Request と `main` への push（マージ）で動き、作業ブランチへの push だけでは動きません。E2E は Pull Request では縮小版（`npm run test:e2e:smoke`）、`main` では全件です。また `*.md`（`src/` の画面は除く）・`docs/`・`.gitlab-ci.yml` などテストに関係ないファイルだけの変更では起動しません。文書の変更では代わりに軽い検査（`docs.yml`: リンク切れ・画像を置いていないか）だけが動きます。

## ドキュメント

| 文書 | 内容 |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | 計算と画面の仕様（実装の正） |
| [docs/DATA.md](docs/DATA.md) | データファイルの列と `config.json` の取り込み設定 |
| [docs/DUMMY_DATA.md](docs/DUMMY_DATA.md) | ダミーデータのシナリオと検証結果の期待値 |
| [docs/DATA_LOADERS.md](docs/DATA_LOADERS.md) | データローダとキャッシュの決まり（壊れた・古い出力を公開しない） |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 運用と設定（CI/CD 変数・API・人事取り込み・マスタ編集・実績の種類の追加） |
| [docs/DEPLOY_GITLAB.md](docs/DEPLOY_GITLAB.md) | 社内 GitLab の推奨構成・権限・展開手順・確認チェックリスト |
| [docs/UI_NOTES.md](docs/UI_NOTES.md) | 画面の構成・状態管理・ページの追加方法 |
| [docs/CORE_NOTES.md](docs/CORE_NOTES.md) | 計算コアの実装メモ |
| [docs/TEXTS.md](docs/TEXTS.md) | 画面の文言の書き換え方 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 変更の決まり（**PR ごとにドキュメントも直す**・テスト） |

## これから

- 作業実績 API・人事 API の本番適用（列名の確認、定期取り込み）
- 社内 GitLab での確認（Pages の閲覧制限・トークン・CORS・保護ブランチ。[チェックリスト](docs/DEPLOY_GITLAB.md#社内で確認することチェックリスト)）
- 前年比（1 年分のデータがたまってから）

## リポジトリ構成

```
config.json              計算・表示・取り込み元・マスタ編集の設定
data/                    CSV データ（docs/DATA.md）
docs/                    仕様・データ定義・運用手順など（上の「ドキュメント」）
packages/app/            社内へ持ち込む npm パッケージ yojitsu-navi（コマンド yojitsu-navi。中身はリポジトリ一式を写して作る）
packages/core/           計算コアの npm パッケージ（package.json と README。中身は src/core からビルド）
scripts/
  build.ts / dev.ts      ビルド・開発サーバ（入力の指紋でキャッシュを管理）
  build-app.mjs          社内へ持ち込むパッケージを作る（npm run app:pack）
  build-core.mjs         計算コアの npm パッケージを作る（npm run core:build）
  verify-dist.ts         ビルド結果の検証
  generate-dummy.ts      ダミーデータ生成（基本シナリオ）。dummy-scale.ts が実運用規模の部分
  fetch-worklogs.ts      作業実績の取得（直近 N か月を書き換え）
  fetch-members.ts       所属・役職の取り込み（members.csv に追記）
  validate-data.ts       データ検証（CI）
  gitlab-setup.ts        本番 GitLab プロジェクトの設定の確認・適用（npm run gitlab:setup）
  ci/push-data-mr.sh     定期取り込みの結果を MR で反映（GitLab CI）
  fonts/build_fonts.py   同梱フォント（src/fonts/）の作り直し（SPEC §46）
  adapters/              取り込みアダプタ（csv / dummy / http）
  lib/                   Node 用の補助（CSV・文字コード・読み込み・原子的な書き込み・指紋）
src/core/                計算コア（純粋関数。画面に依存しない。npm パッケージ @yojitsu-navi/core のソース）
src/*.md                 画面（Observable Framework）
src/components/          画面の部品（KPI・表・グラフ・計算根拠・フィルタ・マスタ編集）
src/fonts/               画面フォント BIZ UDPゴシック（woff2）とライセンス（OFL.txt）
src/data/                データローダ（docs/DATA_LOADERS.md）
src/i18n/                画面の文言（ja.js）と計算ルール・使い方の画面の本文（rules.txt・guide.txt）
src/style.css            デザイントークンとスタイル（ライト／ダーク）
tests/                   unit / property / integration / fuzz / e2e
```
