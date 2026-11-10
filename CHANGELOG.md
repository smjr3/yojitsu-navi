# 変更履歴

npm パッケージ `yojitsu-navi` の版ごとの変更と、導入先（`yojitsu-navi init` で作ったプロジェクト）で行うことです。
`yojitsu-navi update` は、今の版から新しい版までの「更新後に行うこと」「テスト・CI の前提」「新しい設定と推奨値」を表示します（「新しい設定と推奨値」には導入先の `config.json` の今の値を添えます）。
書き方と、版を上げるときの手順は [docs/RELEASE.md](docs/RELEASE.md)。

## 0.2.4

### 更新後に行うこと

- CI のジョブ選びは何もしなくてよい（`.gitlab-ci.yml` はパッケージの新しいものになる）。MR のパイプラインは、データだけの MR では `validate`、文書・CI の設定だけの MR では `ci-check` だけが動き、ビルドは既定ブランチへのマージ後になる（SPEC §102.3）
- データだけの MR でもビルドまで確かめたいときは CI/CD 変数 `YOJITSU_MR_BUILD` = `1`。キャッシュを使わずに作り直したいときは Run pipeline で `YOJITSU_FULL_BUILD` = `1`
- 最初のビルドはキャッシュが無いのでフルビルドになる（2 回目から増分）
- 版上げの前に `yojitsu-navi upgrade --dry-run` で「止まらずに進めます」と出ることを確かめてから `yojitsu-navi upgrade` を実行する（止まる理由があれば一覧と直し方が出る。何も変えない）
- `.gitignore` を社内で直していたら、この版から止まらずに新しい版になり、社内で足した行は最後の目印「`# 社内で足したもの（yojitsu-navi update はこの下の行を残します）`」の下に移る。以後、社内の行はこの目印の下に足す
- `config.json` に無い新しい設定は `yojitsu-navi migrate-config` で一覧を確かめ、要るものだけ `yojitsu-navi migrate-config --apply --add <項目>` で書き足して値を本番に合わせる（コミットはしないので MR に入れる）
- 定期取り込みを動かしているなら、`yojitsu-navi gitlab-setup` で取り込みの MR 用のプロジェクトアクセストークン（`GIT_PUSH_TOKEN` の中身）の条件と期限が ✓ になることを確かめる
- 作業名の括弧内をタスクにするなら、`config.json` に `taskFromName`（下の表）を足す。今 `task-types.csv` の「含む」の行で括弧内の表記を拾っているなら、その行は運用保守以外にしたいもの以外は消してよい（残しても動く）。足した後はデータ確認の「未分類の作業種別」が減ることを確かめる
- `taskFromName` を使わないなら何もしなくてよい（作業種別の分類はこれまでどおり）
- 動作確認用の単価を入れている場合は、`rates.csv` のその行に `provisional` 列で `1` を入れる（またはマスタ編集の単価で「仮の値」を「仮」にする）。本番の単価に直したら外す（SPEC §103.5）
- 顧客ごとに担当チームが決まっている場合は、マスタ編集の「顧客」タブ（`data/customer-teams.csv`）に顧客と既定の担当チームを入れると、`contracts.csv` の `team_id` が空の案件にまとめて効く。例外の案件だけ `team_id` を書く（SPEC §103.6）

### テスト・CI の前提

- `upgrade` のテストは、社内で手を加えたコード（`--keep-local` で残したファイル、社内で足した `src/`・`scripts/`・`tests/` のファイルなど）があるときだけ自動で動く。前は既定で飛ばしていた。必ず動かすなら `--test`（`YOJITSU_RUN_TESTS=1`）、動かさないなら `--no-test`（`YOJITSU_RUN_TESTS=0`）
- `upgrade` の依存（`npm ci`）は、`package-lock.json`・Node の版・OS が前に入れたときと同じなら入れ直さない（`--install` で必ず入れる）。CI の動きは変わらない

### 変更

- アサインで案件を選ぶ候補に、選んでいる期間に契約が無い案件は「契約期間外」と出し、薄く後ろへ並べる（選べる。SPEC §31.6）。不在の人の候補も薄く出す
- 検索欄（マスタ編集・リソース計画・案件一覧・顧客一覧・メンバー一覧・列の絞り込み）で、日本語の変換中に文字が勝手に確定されないようにする。確定してから絞り込む（SPEC §105）
- 画面の動作を軽くした: 表の行・マスの作り方を変え、描画の途中のレイアウト計算をまとめた。メンバー一覧は同じ条件の集計と計画とのずれの表を使い回す。見た目・仕様は変わらない（SPEC §106）
- ビルドを増分にした: ローダの出力を 1 回の計算でまとめて作り、変わったファイルだけを書き換える（契約ごとの作業ログ明細を毎回全件作り直さない）。プログラムが変わったときだけキャッシュを全部捨てる。CI はローダのキャッシュをパイプラインをまたいで使い回す（SPEC §102）
- `.gitlab-ci.yml` が変わったファイルを見てジョブを選ぶようにした: MR はプログラムが変われば `build`、データだけなら `validate`、それ以外は `ci-check`。既定ブランチは文書だけの変更ではビルド・公開しない（SPEC §102.3）
- データ確認の作業実績の一覧（未紐付け・キーワードに合致しない作業・未登録の作業コード）に「作業した人」の列を足し、「案件ごと／人ごと」で切り替えられるようにした。単価のないメンバーは人ごとに 1 行にまとめた（SPEC §100）
- データ確認の KPI に「マスタに無いメンバー」の人数を出し、一覧に名前・作業した顧客・期間を足した。時間は従来どおり集計に含める（単価が無ければ 0 円。SPEC §100）
- 稼働実績の顧客別で、案件の無い顧客に「案件なし」を付けた。顧客名の無い作業の行が空欄だったのを「顧客名なし」にした（SPEC §100）
- `yojitsu-navi upgrade --dry-run`: 何も変えずに、止まらずに進めるか・依存とテストを動かすかを出す（止まるなら終了コード 2）。`--no-test`・`--install` を足した（SPEC §104）
- `yojitsu-navi migrate-config`: `config.json` に無い新しい設定と名前が変わった項目を出し、`--apply` で名前が変わった項目を移し、`--add` で選んだ項目だけを書き足す（今の値・書式は変えない。SPEC §104）
- `update` が `.gitignore` に社内で足した行を残して新しい版にする（止めない。SPEC §104）
- `gitlab-setup` が取り込みの MR 用のプロジェクトアクセストークン（有効・Maintainer 以上・`write_repository`・期限）と、`PROJECT_API_TOKEN`・`NPM_AUTH_TOKEN` の Protected・Masked を確かめる。docs/DEPLOY_GITLAB.md に「本番運用の標準構成」（SPEC §104）
- 作業名の目印の直後の括弧内を作業種別の内訳のタスクにする設定 `taskFromName` を足した（目印は複数可）。括弧が無い・期間の表記だけの作業は「タスク分類なし」として時間を数え、未分類の警告にしない。括弧内が task-types.csv に無くても未分類にしない（SPEC §101）
- 作業実績の取り込みで、前回と中身が同じ月のファイルを書き換えないようにした（改行コードの違いだけも同じとみなす）。`data/worklogs/_meta.json` に変わった月 `changedMonths` を書く。CI の取り込みはデータが変わらなければ検証を省く（SPEC §101.3）
- 正式な案件の一覧の取り込みで、`contracts.csv` の変わった行だけを書き換え、ほかの行は元のまま残すようにした。ログに `projects.csv` の追加・削除・名前の変更の件数を出す（SPEC §101.4）
- データ検証の「警告」を「確認要求」と呼ぶようにした（公開を止めない・人が判断するもの。エラーは従来どおり公開を止める。SPEC §103.1）
- データ確認に「契約期間外の実績」を分けて出す（契約期間・実績の期間・月ごとの時間・作業した人。「案件を開く」でマスタ編集へ。データは消さない・直さない。SPEC §103.2）
- 未登録の案件（「マスタに無い正式な案件」と作業名の「未登録の案件」）に「案件に登録」を付けた。正式な案件ID・顧客名・案件名を入れた状態でマスタ編集の「＋ 新しい案件」を開く（自動では登録しない。SPEC §103.3）
- データ確認に「未設定・仮の値」（担当チーム未設定・金額未入力・単価未設定・仮の単価）。マスタ編集の表の上の件数のボタンでその行だけにして直せる（SPEC §103.4）
- `rates.csv` に省略可の列 `provisional`（動作確認用の仮の単価。SPEC §103.5）
- 顧客の既定の担当チーム `data/customer-teams.csv`（省略可）とマスタ編集の「顧客」タブ。担当チームが空の案件はその顧客の既定のチームで集計する（SPEC §103.6）

### 新しい設定と推奨値

| 項目 | 書かないとき | 推奨 | 理由・いつ |
|---|---|---|---|
| `taskFromName.markers` | なし（`taskFromName` ごと書かないと使わない。`taskFromName` だけ書いて `markers` を省くと `projectFromTask.marker`） | 括弧内にタスクを書く作業名の目印（複数可） | 括弧内を作業種別の内訳のタスクにし、括弧なし・期間だけは「タスク分類なし」にする（SPEC §101） |
| `taskFromName.enabled` | `true` | そのまま | 一時的に止めるときだけ `false` |

## 0.2.3

### 変更

- リソース計画の人の表に、見出しでの並べ替えと列ごとの絞り込みを足した（一覧表・マスタ編集と同じ操作。月・期間計は人月の範囲で絞れる。SPEC §99）

## 0.2.2

### 更新後に行うこと

- 社内で手を加えたプロジェクトは、次の順に進める（社内の設定ファイルを作る・直すのは手順 3 から。手順 2 の `git pull` の前に作ったものは `git status` で確かめる）:
  1. `npm install -g yojitsu-navi@<新しい版>`（PowerShell で「スクリプトの実行が無効」と出たら、以降の `yojitsu-navi` を `yojitsu-navi.cmd` にする）
  2. `git switch main && git pull`。`git status` で変更が無いことを確かめる（`.gitlab-ci.local.yml` だけは残っていても止まらず、更新のコミットに入る）
  3. `.gitlab-ci.yml` にランナーのタグ・変数・社内だけのジョブを書いていたら、`yojitsu-navi migrate-ci --dry-run` で移すものを確かめ、`yojitsu-navi migrate-ci` で `.gitlab-ci.local.yml` に移してコミットする。「自動で移せないもの」は表示のとおり CI/CD 変数などに移す（SPEC §91.4）
  4. `yojitsu-navi upgrade`（または `update` → `npm ci` → `check` → `npm run validate` → `npm run build` を 1 つずつ）。手順 3 で移した `.gitlab-ci.yml` は止まらずに新しい版になる（前のものは `.yojitsu-navi-backup/`）。先に `yojitsu-navi update --dry-run --summary` で確かめてもよい
  5. 表示された「更新後に行うこと」「新しい設定と推奨値」を、できたブランチ `update-<版>` の中で `config.json`・CI/CD 変数に入れてコミットする
  6. `git push -u origin update-<版>` → MR → パイプラインが緑になったらマージ
- 0.2.0・0.2.1 で作った `.gitlab-ci.local.yml` のひな形（`.yojitsu-navi-local: {}`）は GitLab が「`jobs:.yojitsu-navi-local config can't be blank`」で失敗にする。`update` がその行だけを中身のある形に直す（ほかの行は変えない。SPEC §91.3）。手で直していたらそのままでよい
- プロジェクトの名前（`package.json`・`package-lock.json` の `name`）が `yojitsu-navi-site` になる。プロジェクトの中で `npx yojitsu-navi@<版> …` が「could not determine executable to run」で動かなかったのは、名前がコマンドと同じだったため（この版に上げるまでは `npm install -g` で入れたコマンドを使う）
- `update` が「パッケージに無いファイル」を出したら、使っていないもの（社内で足したテスト用のデータなど）は消して MR に入れる
- `update` が「サンプルのまま残っているデータ」を出したら、`yojitsu-navi reset-data --dry-run` で確かめてから `yojitsu-navi reset-data` で空にし、本番のデータを入れる
- `package-lock.json` は新しい版のものを使う（`esbuild`・`glob` を上げた。`npm audit` は 7 件 → 4 件。残る理由は SPEC §84.2）
- CI/CD 変数 `VITEST_MAX_FORKS` を入れてテストを動かしていて、Windows の Runner で結果が安定しないなら `1` にする
- `upgrade` の 2 番目の手順「設定の互換確認」で止まったら、表示のとおり `config.json` を直してコミットし、もう一度 `upgrade`（必須の項目が無い・型や値が違うものだけがエラー。使わない項目は注意だけ。SPEC §96）
- 初回の導入で今年度の初めから取り込むときは、Run pipeline で変数 `FETCH_MODE` = `initial`（コマンドは `npm run fetch -- --initial`）。年月を手で入れなくてよい（docs/OPERATIONS.md「取り込む期間の 3 とおり」）
- 案件の顧客名・案件名を案件管理システムの正式な値にそろえるときは、`config.json` に `projectSource` を足し（下の表）、CI/CD 変数 `PROJECT_API_TOKEN` を登録して `npm run fetch:projects -- --dry-run` で確かめる。`contracts.csv` の `note` に案件 ID を書いていたら `--id-from-note` で `project_id` の列に移す（docs/OPERATIONS.md「正式な案件の一覧を取り込む」。SPEC §98）。使わないなら何もしなくてよい
- 社内 CA が Windows の証明書ストアに入っているなら、`NODE_EXTRA_CA_CERTS` の代わりに `NODE_USE_SYSTEM_CA=1` も使える（Node 22.19 以降。docs/DEPLOY_GITLAB.md「社内の証明書」）
- 作業名から案件名を抜き出して紐付けるなら、`config.json` に `projectFromTask`（下の表）を足し、データ確認の「未紐付けの作業実績」で理由「未登録の案件」を確かめる。表記の違いだけのものは `data/project-aliases.csv`（`alias,project_name`）に別名を足す。mapping.csv の作業コードの行・名前の行はそのまま使える（そちらが先。SPEC §97）

### テスト・CI の前提

- `npm run ci:check` を足した（`yojitsu-navi check` と同じ確かめを、コマンドを入れていない PC でもプロジェクトの中から動かせる）。CI が使うファイルに加え、`.gitlab-ci.yml`・`.gitlab-ci.local.yml` の GitLab が受け付けない書き方（中身の無いジョブ・空のファイル）も見つける。`init`・`update` の最後の確かめも同じ（SPEC §91.3）
- `npm run validate`（CI の build）が `config.json` の互換確認も行う。必須の項目が無い・型や値が違うと build が止まる（`npm run config:check` で同じ確かめだけをできる。SPEC §96）
- `upgrade` はテストを既定で飛ばす（CI の test ジョブと同じ）。動かすときは `--test` か環境変数 `YOJITSU_RUN_TESTS=1`
- npm 12 の「`esbuild` のインストールスクリプトを止めた」警告は出なくなる（`package.json` の `allowScripts` で許可。SPEC §84.3）
- `.gitlab-ci.yml` に `fetch-projects` ジョブが増える。既定は動かない（スケジュール実行かつ CI/CD 変数 `PROJECT_FETCH_ENABLED=1`、または Run pipeline の変数 `PROJECT_FETCH=1` のときだけ）。`projectSource.adapter` が `none` なら何もしない
- 運用のテストに `tests/integration/project-fetch.test.ts` が増える

### 変更

- ファビコンを画像ファイル（`src/icons/`）にした。0.2.0・0.2.1 の埋め込み（data URI）は社内の配信先でタブに出なかったため（SPEC §89）
- `.gitlab-ci.local.yml` のひな形を GitLab が受け付ける形にし、`update` が古いひな形を直す。`check`・`npm run ci:check` が中身の無いジョブ・空のファイルを見つける（SPEC §91.3）
- `yojitsu-navi migrate-ci`: 社内で `.gitlab-ci.yml` に書いたランナーのタグ・変数・社内だけのジョブを `.gitlab-ci.local.yml` に移す。移したあとの `update` は `.gitlab-ci.yml` で止まらない（SPEC §91.4）
- プロジェクトの名前を `yojitsu-navi-site` にし、プロジェクトの中でも `npx yojitsu-navi` が動くようにした（SPEC §91.3）
- `yojitsu-navi upgrade`（版上げを 1 回で）・`yojitsu-navi reset-data`（サンプルのまま残ったデータを空に）を足した。`update` に `--no-commit`・`--summary`・`--log <ファイル>`（UTF-8。PowerShell で化けるとき用）、`check` に `--log`。自動でコミットしたことをはっきり出し、パッケージに無いファイルを知らせる。`update` の前に作った `.gitlab-ci.local.yml` では止まらない（SPEC §94）
- 取り込む期間の初回モード `--initial`（`FETCH_MODE=initial`）: 今年度の初めから今月まで。メンバーマスタから 50 人ずつ取る方式を本番の標準として docs に明記（SPEC §87・§96）
- `config.json` の互換確認（`npm run config:check`）。`update`・`upgrade`・`npm run validate` でも行う（SPEC §96）
- 依存の脆弱性を 7 件から 4 件に・npm 12 で `esbuild` のスクリプトを許可・社内証明書と Windows のテスト並列数の説明を足す（SPEC §84.2・§84.3）
- 作業名の目印より前を案件名として抜き出し、contracts.csv の案件名と完全一致する案件へ紐付ける（mapping.csv への作業コードの事前登録が要らない）。表記揺れは `data/project-aliases.csv` の別名だけで吸収し、曖昧一致はしない。contracts.csv に無い案件名は「未登録の案件」として警告。案件名で紐付いた作業の作業コードは未登録に数えず、取り込みで新しい作業コードを知らせるだけにした（SPEC §97）
- 案件管理システムの正式な案件の一覧の取り込み `npm run fetch:projects`（`data/projects.csv`）。`contracts.csv` に任意列 `project_id`（正式な案件ID）。`project_id` のある案件の顧客名・案件名は一覧の値、期間・金額・担当チームは手入力のまま。ページングなし・取得後の `filters` に対応。データ確認に「正式な案件IDの無い案件」「マスタに無い正式な案件」（SPEC §98）

### 新しい設定と推奨値

| 項目 | 書かないとき | 推奨 | 理由・いつ |
|---|---|---|---|
| `projectSource.adapter` | `none`（取り込まない） | 案件管理システムの API なら `http` | 顧客名・案件名を正式な値にそろえる（SPEC §98） |
| `projectSource.http.pagination` | なし（ページングなしで 1 回で全件） | ページングに対応しない API はそのまま | 1 回で全件を返す API 向け |
| `projectSource.columns` | なし（`adapter` が `csv`・`http` なら必須） | API の案件ID・顧客名・案件名の列名 | `projectId`・`customerName`・`projectName` |
| `projectSource.filters` | なし（全件） | 取り込む案件の条件 | サーバー側で絞り込めない API のため、取得後に絞る |
| `projectFromTask.marker` | なし（`projectFromTask` ごと書かないと使わない） | 運用保守の作業名に入る目印 | 目印より前の案件名で contracts.csv の案件に紐付ける（SPEC §97） |
| `projectFromTask.enabled` | `true` | そのまま | 一時的に止めるときだけ `false` |

## 0.2.1

### 更新後に行うこと

- 社内向けの CI の設定（ランナーのタグ・社内だけのジョブなど）は新しくできる `.gitlab-ci.local.yml` に、社内レジストリ・証明書は `.npmrc` か CI/CD 変数（`NPM_CONFIG_REGISTRY`・`NODE_EXTRA_CA_CERTS`）に移す。`.gitlab-ci.yml` を直したままだと毎回の更新で止まる。移したら `yojitsu-navi update --overwrite` で `.gitlab-ci.yml` を新しい版にする（置き場の一覧は docs/DEPLOY_GITLAB.md「社内の設定の置き場」）
- CI/CD 変数 `YOJITSU_RUN_TESTS` を入れていなければ、パイプラインは build → pages だけになる（test ジョブは動かない）
- 開発元だけのテスト（`tests/e2e/`・`tests/property/`・`tests/fuzz/`・`tests/integration/app-package.test.ts` など）とスクリプトが消える。テストを除外するために `vitest.config.ts` などを社内で変えていると止まるので、`yojitsu-navi update --dry-run` で確かめてから `--overwrite` にする（除外の設定は要らなくなる。SPEC §93）
- `update` が「サンプルのまま残っているデータ」を出したら、本番のデータと混ざらないよう直す: `data/worklogs/` の月のファイル・`_meta.json` は消し、そのほかの CSV は本番のものに置き換える（docs/DEPLOY_GITLAB.md「サンプルのデータを消す」）
- CI/CD 変数 `VITEST_MAX_FORKS=2`・`YOJITSU_PERF`・`PLAYWRIGHT_E2E` は消してよい（Windows は既定で 2。`YOJITSU_PERF`・`PLAYWRIGHT_E2E` はもう使わない）
- 依存が入れ替わる（`vitest` 3 → 4、`exceljs` を削除）。`package-lock.json` は新しい版のものを使い、`npm audit fix --force` は実行しない（Framework が古い版に下がる。残る脆弱性と理由は SPEC §84.2）

### テスト・CI の前提

- test ジョブ（型チェック・vitest）は既定で動かない。動かすときは CI/CD 変数 `YOJITSU_RUN_TESTS=1`（SPEC §79.2）
- validate ジョブを build ジョブにまとめた。データ検証は build の最初に動き、error があれば build が失敗する（SPEC §79.3）
- `.gitlab-ci.yml` が `.gitlab-ci.local.yml` を include する。消すとパイプラインが作られない（`yojitsu-navi check` が知らせる）
- プロジェクトに入るテストは運用に要るもの（取り込み・データ検証・CI のスクリプト）の 9 ファイルだけ。本番の `config.json`・`data/` を読まない（設定はテストの中、データは `tests/fixtures/`）。計算・画面・パッケージ・ダミーデータ・ファズ・プロパティ・性能・E2E のテストは開発元だけで動かす（SPEC §93）
- build ジョブの E2E のステップ（`scripts/ci/e2e.mjs`）を外した
- `yojitsu-navi init` は `data/` を空（見出しの行だけ）で作る。サンプルは `--sample` のときだけ（SPEC §93）
- テストは Vitest 4 で動く。Windows ではテストを同時に 2 つまで動かす。CI/CD 変数 `VITEST_MAX_FORKS` を入れればその数（Vitest 4 の `VITEST_MAX_WORKERS` でもよい。両方あれば `VITEST_MAX_WORKERS`。SPEC §79.1）
- 作業ログ明細の作り置き（ビルド中のキャッシュ）を置けないときは、黙って続けずにビルドが止まる。Windows で一時的に起きる失敗は待ってやり直す（SPEC §79.1）

### 変更

- 社内のパイプラインを短くした: テストを既定で動かさない・検証を build にまとめる・`node_modules/` をキャッシュしない（#98）
- `update` が `.gitlab-ci.local.yml`・`.npmrc` を上書き・削除しない。`.gitlab-ci.local.yml` が無ければひな形を足す（SPEC §91.1）
- `update` のあとに、この変更履歴の「更新後に行うこと」「テスト・CI の前提」「新しい設定と推奨値」を出す（SPEC §91.2）
- 利用環境に配るテストとサンプルデータを減らす: 開発元だけのファイル・テストを配らない、テストは本番の設定・データを使わない、`init` は `data/` を空で作る（`--sample` でサンプル入り）、`update` がサンプルのまま残ったデータを知らせる、Windows のテストの並列数を既定 2 に（#100）
- 作り置きの名前変更の失敗を止める・開発元以外でパッケージを組み立てない・依存の脆弱性を 18 件（critical 2）から 8 件（critical 0）に減らす（#101）

## 0.2.0

### 更新後に行うこと

- 作業実績 API に作業コードの列があれば、`config.json` の `worklogSource.http.columns.taskCode` に列名を書き、`taskCodeCheck` を設定する。案件への紐付けは `data/mapping.csv` の作業コードで行う（SPEC §92）
- ページ番号だけを受け付け、件数のパラメータで失敗する API は、`pagination` に `"stopWhen": "empty"` を書き、`sizeParam` を消す。既定は従来どおり `short`（設定件数未満で終了）なので、書かないと途中で取得が止まる（SPEC §90）。人事の取り込み（`memberSource.http.pagination`）も同じ
- 取得する人をメンバーマスタから作るときは `worklogSource.http.members` を書く（SPEC §87）
- Windows の Runner でテストを動かすなら、CI/CD 変数 `VITEST_MAX_FORKS=2`（それでもタイムアウトするなら 1）。前の版で除外していたテストがあれば除外を外す（SPEC §79.1）

### テスト・CI の前提

- Windows ではテストのタイムアウトを自動で 3 倍にする（`YOJITSU_TEST_TIMEOUT_SCALE` で変えられる）。性能テストは既定で時間を表示するだけ（`YOJITSU_PERF=loose`・`strict` で判定）
- 作業実績・人事の取り込みに失敗すると CSV を書き換えず、`data/worklogs/_meta.json`・`data/masters/_members-meta.json` の `lastFailure` に記録してジョブを失敗にする（SPEC §87）
- ページングの上限 `maxPages`（既定 5000）を超えるとエラーで止まり、CSV を書き換えない（SPEC §90）
- `update` は社内で変えたファイルがあると何も変えずに止まる（`--dry-run`・`--overwrite`・`--keep-local`。SPEC §91）
- `init`・`update`・`npm run app:build` の最後に、CI が使うファイルが揃ってコミットされているかを確かめ、足りなければ止まる（`yojitsu-navi check`。SPEC §85）

### 新しい設定と推奨値

| 項目 | 書かないとき | 推奨 | 理由・いつ |
|---|---|---|---|
| `worklogSource.http.pagination.stopWhen` | `short` | ページ番号だけの API は `empty` | 件数のパラメータを受け付けない API は `short` だと 1 ページ目で終わる |
| `worklogSource.http.pagination.maxPages` | 5000 | そのまま | 取得が終わらないときの歯止め |
| `memberSource.http.pagination.stopWhen` | `short` | ページ番号だけの API は `empty` | 人事の取り込みも同じ |
| `worklogSource.http.columns.taskCode` | なし（作業コードを使わない） | 作業実績 API の作業コードの列名 | 作業コードで案件に紐付ける（SPEC §92） |
| `taskCodeCheck.include` | なし（`taskCodeCheck` ごと書かないと点検しない） | 運用保守の作業名に入る語 | 未登録の作業コードを見つける範囲 |
| `taskCodeCheck.onUnregistered` | `warn` | 運用に慣れるまで `warn`、のちに `stop` | 未登録の作業コードがあるとき止めるか |
| `taskCodeCheck.onChange` | `warn` | `warn` | 作業名の変更・キーワードの一致の変化を知らせる |
| `worklogSource.http.members` | なし（全件を取る） | API が社員番号の指定を求めるとき | 取得する人をメンバーマスタから作る（SPEC §87） |

### 変更

- 作業コードでの紐付け・契約更新（行の期間）・未登録の作業コードと作業名変更の検出（#97）
- 更新でローカルの変更を守る（上書き前に止める・差分確認・バックアップ。#93）
- ページングの上限ページ数の既定を 5000 に（#96）
- 初期化・更新で CI のファイルを欠かさない（#95）
- 作業実績 API の取得対象をメンバーマスタから作る・失敗時は CSV を書き換えない（#91）
- Windows でもテストを除外せずに通す（#94）
- ページングを連携先 API に合わせる（件数パラメータなし・空配列で終了・上限。#89）
- 広い画面では横幅を使い切る（#92）、ファビコン（#88）
- 作業実績が案件の実績に入るかの判定を SPEC §86 にまとめる（挙動は変えない。#90）

## 0.1.0

### 変更

- 最初の公開版
