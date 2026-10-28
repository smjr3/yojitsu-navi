# 社内 GitLab Pages への公開手順

予実ナビを社内 GitLab Pages で公開し、プロジェクトのメンバーだけが見られるようにする手順です。
パイプラインの中身は [`.gitlab-ci.yml`](../.gitlab-ci.yml) の冒頭コメントにあります。

## 全体の流れ

1. GitLab にプロジェクトを作り、このリポジトリを push する
2. 閲覧制限を設定する（Private ＋ Pages はメンバーのみ）
3. 閲覧者・編集者をメンバーに追加する
4. Runner と、必要なら社内ミラーの CI/CD 変数を設定する
5. `main` に push して公開を確認する

`main` への push のたびに `validate → test → build → pages` が走り、数分で公開内容が更新されます。
MR やほかのブランチでは `pages` 以外（検証・テスト・ビルド）だけが走ります。

## 1. プロジェクトを作って push する

1. GitLab で「新規プロジェクト → 空のプロジェクト」を作る。表示レベルは **Private**。
2. 手元のリポジトリから push する。

```sh
git remote add gitlab https://<社内GitLab>/<group>/yojitsu-navi.git
git push gitlab main
```

GitHub に社内から接続できない場合は、GitHub の「Code → Download ZIP」で取得して展開し、`git init` → `git add .` → `git commit` → 上の push でも構いません（履歴は引き継がれません）。
既定ブランチが `main` になっていることを Settings > Repository > Branch defaults で確認してください（`pages` は既定ブランチでだけ動きます）。

## 2. 閲覧制限を設定する

Settings > General > **Visibility, project features, permissions** を開きます。

| 項目 | 設定 |
|---|---|
| Project visibility | **Private** |
| Pages | **Only Project Members** |
| CI/CD | Only Project Members |

「Pages」の行が出ない、または選べない場合は、GitLab 管理者に「Pages のアクセス制御（`gitlab_pages['access_control']`）を有効にしてほしい」と依頼してください。
これが無効のままだと、プロジェクトが Private でも Pages の URL は誰でも開けてしまいます。

## 3. メンバーを追加する

Manage > **Members** で追加します。

| 人 | ロール | できること |
|---|---|---|
| 閲覧だけの人（経営層・メンバー） | **Guest** | Pages の閲覧のみ。ソースや CSV は見えない |
| マスタを編集するリーダー層 | **Developer** | 閲覧＋マスタ編集画面からの保存（MR 作成） |
| 管理者（shima さん） | Maintainer 以上 | 設定・MR のマージ |

グループ単位で追加すると、異動や入社のたびにプロジェクトを触らずに済みます。

## 4. Runner と CI/CD 変数

**Runner**: Settings > CI/CD > Runners で、このプロジェクトに使える Runner（緑の丸）があることを確認します。
`.gitlab-ci.yml` は `image:` を使うので **Docker（または Kubernetes）executor** の Runner が必要です。
shell executor しか無い場合は、Runner のマシンに Node.js 20 以上を入れ、管理者に相談してください。

**CI/CD 変数**（Settings > CI/CD > Variables）は、社内から外に出られないときだけ設定します。

| 変数 | いつ必要か | 例 |
|---|---|---|
| `NPM_CONFIG_REGISTRY` | `npm ci` が registry.npmjs.org に接続できない | `https://nexus.example.local/repository/npm/` |
| `NODE_IMAGE` | Runner が Docker Hub から `node:22` を取れない | `registry.example.local/mirror/node:22` |

作業実績 API 用の変数（`WORKLOG_API_TOKEN`・`GIT_PUSH_TOKEN` など）は、本番 API の確認が済むまで不要です（後述）。

### 外部接続について

- **画面**: 外部 CDN・外部サイトを一切読み込みません。ライブラリはすべて `dist/` に同梱されます。
- **ビルド**: 外部に接続しません。Observable Framework は本来ビルド中に registry.npmjs.org へバージョンを問い合わせますが、`npm run build` の前に `scripts/seed-npm-cache.mjs` が自動で走り、問い合わせを止めます（ネットワークを遮断した環境でビルドが通ることを確認済み）。
- 外に出るのは `npm ci`（パッケージ取得）とイメージの取得だけで、上の変数で社内ミラーに向けられます。
- E2E（`PLAYWRIGHT_E2E=1`）はブラウザの取得に外部接続が要るので、社内では既定どおり無効のままにしてください。

## 5. 公開を確認する

1. `main` に push すると CI/CD > Pipelines にパイプラインが出る。4 段すべて緑になるのを待つ。
2. Deploy > **Pages** に公開 URL が出る（例: `https://<group>.pages.<社内ドメイン>/yojitsu-navi/`）。
   - 「Use unique domain」が有効だと `https://yojitsu-navi-xxxx.pages.<社内ドメイン>/` の形になります。どちらでも動きます。
3. メンバーでブラウザから開き、全体サマリーが出ることを確認する。
4. メンバーでない人（またはシークレットウィンドウ）で開き、GitLab のログイン画面または 404 になることを確認する。

ローカルで同じビルドを試すときは `npm ci && npm run build` で `dist/` ができます。

## 困ったとき

| 症状 | 原因と対処 |
|---|---|
| `npm ci` が `ETIMEDOUT` / `ENOTFOUND registry.npmjs.org` | 外部に出られない。`NPM_CONFIG_REGISTRY` に社内ミラーを設定 |
| ジョブが `pull access denied` / イメージ取得で失敗 | Docker Hub に出られない。`NODE_IMAGE` に社内レジストリのイメージを設定 |
| ジョブが `pending` のまま | 使える Runner が無い。Settings > CI/CD > Runners を確認し、管理者に依頼 |
| `validate` が失敗 | データ（CSV）の誤り。ジョブのログに行番号と理由が出るので、該当 CSV を直して push |
| build が `registry.npmjs.org` への接続で失敗 | Framework の更新で問い合わせ先が増えた。エラーに出た `npm:<名前>` を `scripts/seed-npm-cache.mjs` の一覧に足す |
| Pages の URL が 404 | `pages` ジョブは既定ブランチでだけ動く。既定ブランチ名と、`pages` ジョブが成功しているかを確認 |
| メンバーでない人も見られる | Pages のアクセス制御が無効。手順 2 を確認し、出ない場合は管理者に依頼 |
| 一部の画面だけ 404 | 公開直後の反映待ちのことがある。数分おいて再読み込み |

## 将来: 作業実績の定期取り込み（今は設定しない）

`.gitlab-ci.yml` には、スケジュール実行時だけ動く `fetch-worklogs`（作業実績 API）と `fetch-members`（人事データ、既定は無効）のジョブがすでに入っています。
スケジュールを登録しない限り動かないので、今は何もしなくて構いません。

本番 API の仕様（列名・認証）を dry-run で確認したあとに、次を行います。

1. `config.json` の `worklogSource` を本番 API に合わせる（[DATA.md](DATA.md)）
2. CI/CD 変数 `WORKLOG_API_TOKEN`（Masked）と `GIT_PUSH_TOKEN`（Project Access Token、Developer / `write_repository`）を登録
3. Build > Pipeline schedules で平日朝（例 `0 6 * * 1-5`、Asia/Tokyo、対象 `main`）を登録

取り込み結果は `data/worklogs/` にコミットされ、その push で通常のパイプラインが走って Pages まで更新されます。
