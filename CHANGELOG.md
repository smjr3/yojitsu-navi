# 変更履歴

npm パッケージ `yojitsu-navi` の版ごとの変更と、導入先（`yojitsu-navi init` で作ったプロジェクト）で行うことです。
`yojitsu-navi update` は、今の版から新しい版までの「更新後に行うこと」「テスト・CI の前提」「新しい設定と推奨値」を表示します（「新しい設定と推奨値」には導入先の `config.json` の今の値を添えます）。
書き方と、版を上げるときの手順は [docs/RELEASE.md](docs/RELEASE.md)。

## 次の版

### 更新後に行うこと

- 社内で手を加えたプロジェクトは、次の順に進める（`.gitlab-ci.local.yml` などの社内の設定を作る・直すのは手順 3 から。手順 2 より前に作ると「コミットしていない変更」で止まる）:
  1. `npm install -g yojitsu-navi@<新しい版>`（PowerShell で「スクリプトの実行が無効」と出たら、以降の `yojitsu-navi` を `yojitsu-navi.cmd` にする）
  2. `git switch main && git pull`。`git status` で変更が無いことを確かめる
  3. `.gitlab-ci.yml` にランナーのタグ・変数・社内だけのジョブを書いていたら、`yojitsu-navi migrate-ci --dry-run` で移すものを確かめ、`yojitsu-navi migrate-ci` で `.gitlab-ci.local.yml` に移してコミットする。「自動で移せないもの」は表示のとおり CI/CD 変数などに移す（SPEC §91.4）
  4. `yojitsu-navi update --dry-run` で確かめ、`yojitsu-navi update`。`.gitlab-ci.yml` は止まらずに新しい版になる（前のものは `.yojitsu-navi-backup/`）
  5. 表示された「更新後に行うこと」「新しい設定と推奨値」を、できたブランチ `update-<版>` の中で `config.json`・CI/CD 変数に入れてコミットする
  6. `npm run ci:check` で CI の設定を確かめ、`git push -u origin update-<版>` → MR → パイプラインが緑になったらマージ
- 0.2.0・0.2.1 で作った `.gitlab-ci.local.yml` のひな形（`.yojitsu-navi-local: {}`）は GitLab が「`jobs:.yojitsu-navi-local config can't be blank`」で失敗にする。`update` がその行だけを中身のある形に直す（ほかの行は変えない。SPEC §91.3）。手で直していたらそのままでよい
- プロジェクトの名前（`package.json`・`package-lock.json` の `name`）が `yojitsu-navi-site` になる。プロジェクトの中で `npx yojitsu-navi@<版> …` が「could not determine executable to run」で動かなかったのは、名前がコマンドと同じだったため（この版に上げるまでは `npm install -g` で入れたコマンドを使う）
- `package-lock.json` は新しい版のものを使う（`esbuild`・`glob` を上げた。`npm audit` は 7 件 → 4 件。残る理由は SPEC §84.2）
- CI/CD 変数 `VITEST_MAX_FORKS` を入れてテストを動かしていて、Windows の Runner で結果が安定しないなら `1` にする
- 社内 CA が Windows の証明書ストアに入っているなら、`NODE_EXTRA_CA_CERTS` の代わりに `NODE_USE_SYSTEM_CA=1` も使える（Node 22.19 以降。docs/DEPLOY_GITLAB.md「社内の証明書」）

### テスト・CI の前提

- `npm run ci:check` を足した（`yojitsu-navi check` と同じ確かめを、コマンドを入れていない PC でもプロジェクトの中から動かせる）。CI が使うファイルに加え、`.gitlab-ci.yml`・`.gitlab-ci.local.yml` の GitLab が受け付けない書き方（中身の無いジョブ・空のファイル）も見つける。`init`・`update` の最後の確かめも同じ（SPEC §91.3）
- npm 12 の「`esbuild` のインストールスクリプトを止めた」警告は出なくなる（`package.json` の `allowScripts` で許可。SPEC §84.3）

### 変更

- ファビコンを画像ファイル（`src/icons/`）にした。0.2.0・0.2.1 の埋め込み（data URI）は社内の配信先でタブに出なかったため（SPEC §89）
- `.gitlab-ci.local.yml` のひな形を GitLab が受け付ける形にし、`update` が古いひな形を直す。`check`・`npm run ci:check` が中身の無いジョブ・空のファイルを見つける（SPEC §91.3）
- `yojitsu-navi migrate-ci`: 社内で `.gitlab-ci.yml` に書いたランナーのタグ・変数・社内だけのジョブを `.gitlab-ci.local.yml` に移す。移したあとの `update` は `.gitlab-ci.yml` で止まらない（SPEC §91.4）
- プロジェクトの名前を `yojitsu-navi-site` にし、プロジェクトの中でも `npx yojitsu-navi` が動くようにした（SPEC §91.3）
- 依存の脆弱性を 7 件から 4 件に・npm 12 で `esbuild` のスクリプトを許可・社内証明書と Windows のテスト並列数の説明を足す（SPEC §84.2・§84.3）

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
