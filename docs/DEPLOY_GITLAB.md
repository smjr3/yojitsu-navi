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
2. 履歴を持ち込まずに、今のファイルだけを 1 コミットにして push する（開発元のアカウント名などがコミット履歴に残らないようにするため）。

```sh
git checkout --orphan gitlab-main
git commit -m "予実ナビ 初回"
git remote add gitlab https://<社内GitLab>/<group>/yojitsu-navi.git
git push gitlab gitlab-main:main
```

ZIP で取得して展開し、`git init` → `git add .` → `git commit` → 上の push でも同じ結果になります。
2 回目以降の更新も、同じように変更後のファイルを GitLab 側のリポジトリにコミットして push してください。
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
| マスタを編集する人 | **Developer** | 閲覧＋マスタ編集画面からの保存（MR 作成）・自分の MR の取り下げ |
| マージするリーダー層 | **Maintainer** | 上に加えて、マスタ編集画面の「マージ待ちの変更」でマージ |

グループ単位で追加すると、異動や入社のたびにプロジェクトを触らずに済みます。

### マージをリーダー層だけにする（保護ブランチ）

Settings > Repository > **Protected branches** で `main` を次のようにします（Free 版でもできる設定です）。

| 項目 | 値 |
|---|---|
| Allowed to merge | **Maintainers** |
| Allowed to push and merge | **No one**（画面からの直接コミット `commitMode: "direct"` も止まる） |

これで Developer は MR を作れてもマージできず、画面にも「マージはリーダーが行います」と出ます（画面は GitLab の `can_merge` を見て出し分けるだけで、強制は GitLab 側）。
Premium 以上なら「Allowed to merge」に個人やグループを指定でき、Maintainer にしなくても特定の人だけにマージさせられます。

### 本番で確認すること（開発環境では確認できない）

マスタ編集のマージ方式は、開発中はブラウザ内の模擬（`mode: "demo"`）とテストのモックでしか動かしていません。本番の GitLab で次を確認してください。

1. **CORS**: Pages の画面から GitLab API を呼べるか。設定画面で「接続を確認」を押し、「接続できました」が出れば OK。「GitLab に接続できませんでした」なら、リバースプロキシ／WAF が `OPTIONS`（プリフライト）や `PRIVATE-TOKEN` ヘッダーを止めていないかを管理者に確認する（だめなら `mode: "download"`）。
2. **トークン**: Personal Access Token の作成が許可されているか、scope `api` が選べるか、有効期限の上限。会社で PAT が禁止なら、管理者に代わりの方法（グループアクセストークン等）を相談する。
3. **権限の見え方**: Developer の人で「接続を確認」→「マージはリーダーが行います」、Maintainer の人で「マージできる立場です」と出るか。マージ待ちの一覧で、Developer の人にマージボタンが出ないか。
4. **保護ブランチ**: Developer のトークンでマージを試すと拒否されるか（画面に「マージする権限がありません」）。
5. **マージ後の反映**: マージで `main` のパイプライン（validate → test → build → pages）が走り、数分後に画面の数値が変わるか。MR のパイプライン状態（「検証: 成功」など）が一覧に出るか。
6. **件数バッジ**: トークンを登録した人のヘッダーに、開いているマスタ編集の MR の件数が出るか（取得は 1 分ごと。失敗しても画面には出さない）。

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
`pages` ジョブは公開前に `.gz` を並べるので、GitLab Pages は大きな JSON（数 MB）を gzip で配信します（ブラウザの開発者ツールで `content-encoding: gzip` を確認できます）。

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
