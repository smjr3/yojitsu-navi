# 社内 GitLab への展開手順

予実ナビを社内 GitLab に置き、GitLab Pages でプロジェクトのメンバーだけに公開する手順です。
GitLab 側の構成・権限はこの文書の「推奨構成」に合わせてください（迷ったときの正はここです。SPEC §39）。
パイプラインの中身は [`.gitlab-ci.yml`](../.gitlab-ci.yml) の冒頭コメントにあります。

## 推奨構成

```text
<社内 GitLab>
└─ グループ yojitsu-navi（Private）          … メンバーはここに追加する（プロジェクトに引き継がれる）
   └─ プロジェクト yojitsu-navi（Private）    … コード・データ（CSV）・CI・Pages を 1 つにまとめる
      ├─ main                               … 保護ブランチ（直接プッシュ = No one、マージ = Maintainers）。Pages に公開
      ├─ masters/<日時>-<ユーザー>           … マスタ編集・リソース計画の保存で画面が作る MR のブランチ（マージで自動削除）
      └─ data/<種類>-<日時>                  … 作業実績・人事の定期取り込みが作る MR のブランチ（自動マージ）
```

**1 プロジェクトにまとめる理由**: 画面の保存（MR）→ CI の検証 → マージ → Pages の更新が 1 本のパイプラインで完結し、トークンも 1 種類で済みます。データを別プロジェクトに分けると、プロジェクトをまたぐトリガーとトークンの管理が増えるだけで、閲覧制限は Pages 側で十分にかけられます。

**main を「直接プッシュ不可」にする理由**: 本体に入る変更はすべて MR を通り、CI の検証（`build` ジョブのデータ検証とビルド）が通ったものだけになります。画面の保存も定期取り込みも MR を作るので、この設定のまま動きます。

### ファイルの置き場と、誰がどう変えるか

| 置き場 | 中身 | 変える人 | 変え方 |
|---|---|---|---|
| `data/masters/`（members・rates・teams）・`data/contracts.csv`・`data/targets.csv`・`data/holidays.csv` | メンバー・単価・組織・案件（期間・金額・担当チームだけ）・目標・祝日 | 編集者・リーダー | 画面 `/masters` で編集 → 保存で MR → リーダーがマージ |
| `data/assignments.csv`・`data/outside-plans.csv` | リソース計画・運用保守以外の予定 | 編集者・リーダー | 画面 `/plan` で編集（同上） |
| `data/mapping.csv`・`task-types.csv`（・`contracts.csv` の行の追加と顧客名・案件名） | 名称の対応・作業種別・案件の行 | 編集者・リーダー | GitLab の画面（Web IDE）でブランチを作って編集 → MR |
| `data/worklogs/` | 作業実績 | 取り込みの自動処理 | 定期取り込み（本番 API の確認後。下の「将来」） |
| `config.json` | 計算の設定・取り込み元・マスタ編集の接続先 | 管理者 | MR |
| `.gitlab-ci.yml`・`src/`・`scripts/` など | 画面・CI | 管理者 | 新しい版のパッケージで `yojitsu-navi update`（下の「新しい版にする」）。社内で直さない |
| `.gitlab-ci.local.yml`・`.npmrc` | 社内向けの CI・npm の設定（ランナーのタグ・社内レジストリ・証明書） | 管理者 | MR（下の「社内の設定の置き場」。`update` は上書きしない） |
| `.yojitsu-navi.json` | 入れた版とファイルの記録 | （コマンドが書く） | 手で編集しない |
| `.yojitsu-navi-backup/` | `update` が上書き・削除する前のファイル | （コマンドが書く） | git に入れない。要らなければ消す |

マスタ編集の接続先（`config.json` の `masterEdit.gitlab.apiBaseUrl`・`projectId`）は空のままで構いません。CI の build ジョブが、このプロジェクト（`CI_API_V4_URL`・`CI_PROJECT_PATH`）を自動で入れます。

### 権限（ロール）

| 人 | ロール | できること |
|---|---|---|
| 閲覧だけの人（経営層・メンバー） | **Guest** | Pages の閲覧だけ。ソース・CSV・MR は見えない |
| 編集する人 | **Developer** | 上に加えて、画面からの保存（MR 作成）・自分の MR の取り下げ |
| マージするリーダー層 | **Maintainer** | 上に加えて、画面の「マージ待ちの変更」でのマージ |
| 管理者（1〜2 人） | **Owner** | グループ・プロジェクトの設定、トークン・CI/CD 変数の管理 |

Premium 以上なら、保護ブランチの「Allowed to merge」に特定のグループを指定でき、リーダーを Maintainer にしなくても済みます（Free 版は Maintainers で運用）。

### トークン

| 用途 | 種類 | ロール・scope | 置き場 |
|---|---|---|---|
| 画面からの保存・マージ（各自） | Personal Access Token | scope **`api`**（`read_api` では保存できない）。有効期限は社内の上限 | 各自のブラウザ（設定画面）。サーバー・リポジトリには置かない |
| 定期取り込みの MR（将来） | Project Access Token | role **Maintainer**（自動マージに必要）、scope **`write_repository`** | CI/CD 変数 `GIT_PUSH_TOKEN`（**Protected・Masked**） |
| 初期設定スクリプト（一度だけ） | Personal Access Token | Owner か Maintainer の人の scope `api` | 実行時の環境変数 `GITLAB_TOKEN`。終わったら失効させる |

### プロジェクトの設定（`npm run gitlab:setup` が確認・適用する）

| 項目 | 値 |
|---|---|
| Project visibility | Private |
| Pages | Only Project Members |
| CI/CD | Only Project Members |
| 既定ブランチ | `main` |
| 保護ブランチ `main` | Allowed to merge = **Maintainers**、Allowed to push and merge = **No one**、force push 不可 |
| Merge checks | Pipelines must succeed（検証が通るまでマージできない） |
| マージ後 | ソースブランチを削除 |

## 展開の手順

### 0. 持ち込むもの

予実ナビは npm パッケージ（`.tgz` のファイル 1 つ）で持ち込みます。中身は画面・計算・データローダ・CI 定義・運用のテスト・文書の一式と、試す用のサンプルデータ、展開用のコマンド `yojitsu-navi` です（SPEC §44・§93）。
開発元だけで使うもの（パッケージの組み立て・公開のスクリプト、計算・画面・ダミーデータ・性能・E2E などのテスト）は入っていません。
パッケージには社内 GitLab の URL や個人・会社の情報は入っていません。接続先は手順 1 で入れます。

| ファイル | 大きさ | 使う場面 |
|---|---|---|
| `yojitsu-navi-<版>.tgz` | 約 8 MB | 社内に npm のミラー（Nexus・Artifactory など）がある。CI/CD 変数 `NPM_CONFIG_REGISTRY` を設定する（手順 4） |
| `yojitsu-navi-<版>-with-deps.tgz` | 約 64 MB | 社内に npm のミラーが無い。依存（npm のキャッシュ）を `vendor/npm-cache/` に入れ、CI は外に出ずに `npm ci --offline` する。Linux x64・Windows x64 の Runner と PC で使える |

どちらも、開発元のリポジトリで `npm run app:pack`（依存込みは `npm run app:pack -- --with-deps`）を実行すると `packages/app/` にできます。
社内で使う PC には Node.js 20 以上と git が要ります。パッケージ自体は依存を持たないので、入れるときに外部へ接続しません。

### 1. グループ・プロジェクトを作って push する

1. GitLab で **グループ** `yojitsu-navi`（Private）を作り、その中に空の **プロジェクト** `yojitsu-navi`（Private）を作る。
2. 受け取った `.tgz` のあるフォルダで、コマンドを入れてプロジェクトのフォルダを作り、push する。この時点ではまだ `main` が保護されていないので push できます。

```sh
npm install -g ./yojitsu-navi-<版>.tgz
yojitsu-navi init yojitsu-navi --gitlab https://<社内GitLab> --project yojitsu-navi/yojitsu-navi
cd yojitsu-navi
git push -u origin main
```

- `init` は一式を写し、`--gitlab`・`--project` の接続先を `config.json`（`masterEdit.gitlab`）と `git remote` に入れて、`main` に最初のコミットを作ります。省くとその場で聞かれます（空のまま進めても、CI が接続先を自動で補います）。
- `npm install -g` ができない PC では、`npx --yes ./yojitsu-navi-<版>.tgz init …` でも同じです（以下の `yojitsu-navi …` も `npx --yes ./yojitsu-navi-<版>.tgz …` に読み替え）。
- `data/` は空（各 CSV は見出しの行だけ。祝日 `holidays.csv` と作業種類 `task-types.csv` は既定のもの）で作ります。本番のデータの入れ方は [DATA.md](DATA.md)。空のままでもビルド・公開はできます（画面は 0 件）。
- 試すだけならサンプル（架空の会社のデータ。作業実績 約 13 MB）入りで作れます: `yojitsu-navi init <フォルダ> --sample`。本番のプロジェクトでは使わないでください（本番のデータと混ざると集計を誤ります）。
- git の履歴は新しく始まるので、開発元のアカウント名などは入りません。
- 最後に、CI（`.gitlab-ci.yml`）が使うファイルがそろってコミットされているかを確かめます。足りないと一覧が出て止まります（SPEC §85）。

### 2. プロジェクトの設定を確認・適用する

手順 1 のフォルダで実行します。トークンは Owner か Maintainer の人の Personal Access Token（scope `api`）で、実行するとその場で聞かれます（画面には出ません。環境変数 `GITLAB_TOKEN` でも渡せます）。

```sh
yojitsu-navi gitlab-setup
yojitsu-navi gitlab-setup --apply
```

- 接続先は `config.json`、それも空なら `git remote` の `origin` から読みます。違うプロジェクトを見るときは `--api https://<社内GitLab>/api/v4 --project <グループ/プロジェクト>`。
- 1 回目（`--apply` なし）は何も変えず、推奨構成との違いを ✓／✗ で出します。
- `--apply` で、プロジェクトの設定と保護ブランチを推奨値に直し、もう一度確かめて結果を出します。何度実行しても同じ結果です。
- `→` の付いた ✗（メンバー・CI/CD 変数）は手で直します。直し方が `→` の後ろに出ます。
- 社内の証明書でエラーになるときは `NODE_EXTRA_CA_CERTS=<社内CAのPEM>` か `NODE_USE_SYSTEM_CA=1` を付けて実行します（[社内の証明書](#社内の証明書)）。
- `npm ci` 済みのフォルダなら `npm run gitlab:setup -- …` でも同じです。Node.js を使えない場合は、上の「プロジェクトの設定」の表どおりに GitLab の画面（Settings > General、Settings > Repository > Protected branches、Settings > Merge requests）で設定してください。

### 3. メンバーを追加する

グループ `yojitsu-navi` の Manage > **Members** で、上の「権限」の表のロールで追加します。
社内の部署グループがあれば、グループごと招待（Invite a group）すると異動や入社のたびに触らずに済みます。

### 4. Runner と CI/CD 変数

**Runner**: Settings > CI/CD > Runners で、このプロジェクトに使える Runner（緑の丸）があることを確認します。
Runner は **Windows・Linux のどちらでも**動きます（SPEC §79。`.gitlab-ci.yml` の各ジョブは `node scripts/ci/*.mjs` と `npm run` だけで、シェルの違いに左右されません）。
- **shell executor**（Windows の Runner に多い）: Runner のマシンに Node.js 22（20 以上）と Git を入れておきます。`image:` は使われません。
- **Docker（または Kubernetes）executor**: `image:` の `node:22` を使います。Windows コンテナの Runner では、Windows 用の Node のイメージを `NODE_IMAGE` で指定します。
- テスト（`test` ジョブ）は既定で動きません（アプリ本体の確認はパッケージの公開前に済ませている。SPEC §79.2）。入っているテストは運用に要るもの（取り込み・データ検証・CI のスクリプト）だけで、本番の `config.json`・`data/` を使いません（SPEC §93）。社内の Runner で動かしたいときは CI/CD 変数 `YOJITSU_RUN_TESTS=1`。遅くてタイムアウトするときの設定は [OPERATIONS.md](OPERATIONS.md#テストを-windows-で動かすrunnerpc)。
- Runner にタグが付いていてタグなしのジョブを受けない設定なら、`.gitlab-ci.local.yml` に `default: tags: [...]` を書きます（下の「社内の設定の置き場」）。`.gitlab-ci.yml` に足すと、次の `update` で止まります。

**CI/CD 変数**（Settings > CI/CD > Variables）は、社内から外に出られないときだけ設定します（依存込みのパッケージで作ったプロジェクトは `NPM_CONFIG_REGISTRY` が要りません）。

| 変数 | いつ必要か | 例 |
|---|---|---|
| `NPM_CONFIG_REGISTRY` | `npm ci` が registry.npmjs.org に接続できない | `https://nexus.example.local/repository/npm/` |
| `NODE_IMAGE` | Runner が Docker Hub から `node:22` を取れない | `registry.example.local/mirror/node:22` |
| `NODE_EXTRA_CA_CERTS` | 社内の証明書で `npm ci` が `SELF_SIGNED_CERT_IN_CHAIN` などになる | 種類 **File** にして社内 CA の PEM を貼る（下の「社内の証明書」） |
| `NODE_USE_SYSTEM_CA` | 同上。Windows の shell executor で、社内 CA が Windows の証明書ストアに入っている | `1`（下の「社内の証明書」） |

作業実績 API 用の変数（`WORKLOG_API_TOKEN`・`GIT_PUSH_TOKEN` など）は、本番 API の確認が済むまで不要です（下の「将来」）。

#### 社内の証明書

社内のプロキシ・ミラーが社内 CA の証明書を使っていると、`npm ci`・取り込み・`gitlab-setup` が `SELF_SIGNED_CERT_IN_CHAIN`・`UNABLE_TO_GET_ISSUER_CERT_LOCALLY` で失敗します。Node（npm も Node で動く）に社内 CA を信頼させる方法は 2 つで、両方を一緒に使っても構いません（Node 同梱の CA に足されます）。

| 方法 | 向いている環境 | 設定 |
|---|---|---|
| `NODE_EXTRA_CA_CERTS` | どこでも（Docker の Runner・Linux・Windows） | 社内 CA の PEM ファイルのパス。CI/CD 変数なら種類 **File** にして PEM の中身を貼る |
| `NODE_USE_SYSTEM_CA=1` | Windows の shell executor の Runner と社内の PC（社内 CA が Windows の証明書ストアに配られている） | `1`。PEM を用意しなくてよく、社内 CA が入れ替わっても OS の配布に任せられる |

- `NODE_USE_SYSTEM_CA` は Node 22.19 以降（24 系は 24.6 以降）で使えます。古い Node では何も起きないので、`node --version` を確かめてください。
- Windows では Windows の証明書ストア、Linux では OpenSSL の既定の場所（`/etc/ssl/certs/` など）を読みます。Docker の Runner はコンテナの中の証明書を見るので、社内 CA が入ったイメージでなければ `NODE_EXTRA_CA_CERTS` を使います。
- PC の Git Bash では `NODE_USE_SYSTEM_CA=1 npm ci` のように前に付けるか、ユーザーの環境変数に登録します。PowerShell では `$env:NODE_USE_SYSTEM_CA = "1"` を実行してから `npm ci`。
- 効いたかは `npm ping`（レジストリに届くか）で確かめます。

### 5. 公開と接続を確認する

1. 手順 1 の push で CI/CD > Pipelines にパイプラインが出る。`build` → `pages` が緑になるのを待つ（手順 2 より前に終わっていてもよい）。
2. Deploy > **Pages** に公開 URL が出る（例: `https://yojitsu-navi.pages.<社内ドメイン>/yojitsu-navi/`。「Use unique domain」が有効なら `https://yojitsu-navi-xxxx.pages.<社内ドメイン>/`。どちらでも動きます）。
3. 下の「社内で確認すること」を順に確かめる。

## 新しい版にする

開発元から新しい版の `.tgz` を受け取ったら、手順 1 のフォルダ（`main` を最新にしたもの）で実行します。

```sh
npm install -g ./yojitsu-navi-<新しい版>.tgz
git switch main && git pull
yojitsu-navi update
git push -u origin update-<新しい版>
```

結果はブランチ `update-<版>` にコミットされるので、MR を作り、パイプラインが緑になったらリーダーがマージします。

- PowerShell で「このシステムではスクリプトの実行が無効」と出たら、`yojitsu-navi` の代わりに `yojitsu-navi.cmd` と打ちます（npm が入れた `.ps1` が実行ポリシーで止まるため）。
- プロジェクトの中の `npx yojitsu-navi@<版> …` は 0.2.1 までのプロジェクトでは動きません（プロジェクトの名前がコマンドと同じ `yojitsu-navi` だったため「could not determine executable to run」。次の版から `yojitsu-navi-site`）。`npm install -g` で入れたコマンドを使います。
- CI の設定だけを確かめるときは、プロジェクトの中で `npm run ci:check`（`yojitsu-navi check` と同じ。コマンドを入れていない PC でも動く）。

### 社内で手を加えたプロジェクトの版を上げる順番

`.gitlab-ci.yml` にランナーのタグなどを書いていた、`.gitlab-ci.local.yml`・`config.json` を社内で直している、といったプロジェクトは次の順に進めます。社内の設定ファイルを作る・直すのは手順 3 からにします（手順 2 より前に作ると、`update` が「コミットしていない変更があります」で止まります）。

1. `npm install -g yojitsu-navi@<新しい版>`（依存込みなら `npm install -g ./yojitsu-navi-<新しい版>-with-deps.tgz`）
2. `git switch main && git pull`。`git status` で変更が無いことを確かめる
3. `.gitlab-ci.yml` を社内で直していたら、`yojitsu-navi migrate-ci --dry-run` → `yojitsu-navi migrate-ci` でランナーのタグ・変数・社内だけのジョブを `.gitlab-ci.local.yml` に移し、表示のとおりコミットする（下の「社内の設定の置き場」）。「自動で移せないもの」は表示のとおり CI/CD 変数などに移してから、もう一度 `migrate-ci`
4. `yojitsu-navi update --dry-run` で変わるファイルを確かめ、`yojitsu-navi update`。手順 3 で移した `.gitlab-ci.yml` は止まらずに新しい版になる（前のものは `.yojitsu-navi-backup/<日時>/`）
5. 表示された「更新後に行うこと」「新しい設定と推奨値」を、ブランチ `update-<版>` の中で `config.json`・CI/CD 変数に入れてコミットする
6. `npm run ci:check` で CI の設定を確かめ、`git push -u origin update-<版>` → MR → パイプラインが緑になったらマージ

最後に、今の版から新しい版までの [CHANGELOG.md](../CHANGELOG.md) の「更新後に行うこと」「テスト・CI の前提」「新しい設定と推奨値」を表示します。設定は `config.json` の今の値を添えて「項目 今: … / 推奨: …」の形で出るので、要るものを MR の中で `config.json` に書きます（`update` は `config.json` を変えません）。`--dry-run` でも同じものを出します。

### 社内の設定の置き場

社内だけの設定を `.gitlab-ci.yml`・`package.json` に書くと、毎回の `update` で「社内で変えたファイル」として止まり、`--overwrite` すると消えます。次の置き場に書けば `update` は触りません（SPEC §91.1）。

| 設定 | 置き場 |
|---|---|
| Runner のタグ（全ジョブ） | `.gitlab-ci.local.yml` に `default:` → `tags: [windows]` |
| ジョブごとのタグ・社内だけのジョブ・新しい変数 | `.gitlab-ci.local.yml`（例 `build:` → `tags: [large]`） |
| npm の社内レジストリ（Nexus・JFrog Artifactory など） | CI/CD 変数 `NPM_CONFIG_REGISTRY`、または `.npmrc` に `registry=https://…` |
| レジストリの認証 | `.npmrc` に `//<レジストリのホスト>/<パス>/:_authToken=${NPM_AUTH_TOKEN}`、値は CI/CD 変数 `NPM_AUTH_TOKEN`（Masked）。トークンそのものは書かない |
| 社内の証明書 | CI/CD 変数 `NODE_EXTRA_CA_CERTS`（種類 File）か `NODE_USE_SYSTEM_CA=1`（Windows の証明書ストア。[社内の証明書](#社内の証明書)）。リポジトリに置くなら `certs/` などに置き、`.gitlab-ci.local.yml` の `variables:` で `NODE_EXTRA_CA_CERTS: "$CI_PROJECT_DIR/certs/ca.pem"` |
| Node のイメージ | CI/CD 変数 `NODE_IMAGE` |
| テストを動かす・並列数 | CI/CD 変数 `YOJITSU_RUN_TESTS`・`VITEST_MAX_FORKS` |

- GitLab は include したファイルと `.gitlab-ci.yml` を合わせます。同じ項目は `.gitlab-ci.yml` が勝つので、`.gitlab-ci.yml` にある項目（`variables:` の `NODE_IMAGE`、ジョブの `script:`・`rules:` など）は `.gitlab-ci.local.yml` では変えられません。変数は CI/CD 変数にすれば勝ちます。どうしても `.gitlab-ci.yml` の中身を変えるときは `--keep-local`（下）。
- `.gitlab-ci.local.yml` は中身が空だと GitLab が失敗にするので、ひな形の何もしない項目（`.yojitsu-navi-local:` と、その下の変数 `YOJITSU_NAVI_LOCAL`）は消さないでください。中身の無い項目（`.yojitsu-navi-local: {}`・`build:` だけの行など）も GitLab が「`jobs:<名前> config can't be blank`」で失敗にします。0.2.0・0.2.1 のひな形はこの形だったので、`update` がその行だけ直します（SPEC §91.3）。書いたら `npm run ci:check` で確かめられます。
- 社内で足したほかのファイル（`certs/` など）も、パッケージに無ければ `update` は触りません。
- 前の版で `.gitlab-ci.yml` に社内の設定を書いていたら: `yojitsu-navi migrate-ci` が、もとの版（前の `init`・`update` が入れたもの。git の履歴から探す）と比べて、ランナーのタグ（`default:`・ジョブの `tags:`）・新しい変数（全体・ジョブの `variables:`）・社内だけのジョブを `.gitlab-ci.local.yml` に移します。`.gitlab-ci.yml` は変えません。`.gitlab-ci.yml` にもともとある変数の値の変更・ジョブの `script:` などの変更・消したジョブは `.gitlab-ci.local.yml` では変えられないので「自動で移せないもの」に出ます（変数は CI/CD 変数にすれば勝ちます）。移し終えると `.gitlab-ci.local.yml` の最後に印（`# yojitsu-navi migrate-ci: …`）が付き、次の `update` はそのときの `.gitlab-ci.yml` を止まらずに新しい版にします（そのあと `.gitlab-ci.yml` をまた変えたら止まります）。自動で移せないものが要らない変更なら `migrate-ci --force`（SPEC §91.4）。

### 上書きするファイルと残すファイル

| 区分 | ファイル | `update` での扱い |
|---|---|---|
| 残す（社内のもの） | `config.json`・`data/` 以下すべて（`mapping.csv`・`task-types.csv`・`masters/`・`worklogs/` など） | 足しも消しもしない。新しい版で増えた設定の項目・データのファイルは一覧で知らせる（無くても既定値で動く）。サンプルのまま残っているデータも一覧で知らせる（下の「サンプルのデータを消す」） |
| 残す（社内の CI・npm の設定） | `.gitlab-ci.local.yml`・`.npmrc` | 上書きも削除もしない。`.gitlab-ci.local.yml` が無いときだけひな形を足す（`.gitlab-ci.yml` が include するので、無いと CI が動かない）。`.npmrc` はパッケージに入っていない |
| 残す（社内で足したもの） | パッケージに無く、前の版の記録（`.yojitsu-navi.json`）にも無いファイル | 触らない |
| 上書き | 上以外でパッケージに入っているもの（`.gitlab-ci.yml`・`.gitlab/`・`.gitignore`・`.gitattributes`・`package.json`・`package-lock.json`・`observablehq.config.js`・`src/`・`scripts/`・`tests/`・`docs/`・`README.md` など） | 新しい版にする。**社内で変えていたら止まる**（下） |
| 削除 | 前の版の記録にあって新しい版に無いもの（0.2.0 までに入っていた開発元だけのテスト・スクリプトなど。SPEC §93） | 消す。社内で変えていたら止まる |
| 入れ替え | `vendor/npm-cache/` | 依存込みのパッケージのとき丸ごと入れ替える |
| コマンドのもの | `.yojitsu-navi.json`・`.yojitsu-navi-backup/` | コマンドが書く |

### 社内で変えたファイルがあるとき

上書き・削除するファイルを社内で変えていると（前の版の記録と中身が違う・記録に無いのに同じ名前のファイルがある）、**何も変えずに止まり**、そのファイルの一覧が出ます。改行が CRLF になっただけのものは変えたことにしません。無くなっていたファイル（git の除外設定でコミットされなかったものなど）は止まらずに入れ直します。

```sh
yojitsu-navi update --dry-run      # 何も変えずに、変わるファイルの一覧と、社内で変えたファイルの差分（- が社内の今、+ が新しい版）を出す
yojitsu-navi update --overwrite    # 社内の変更も新しい版にする（前のものはバックアップに残る）
yojitsu-navi update --keep-local   # 社内で変えたファイルは社内の版のまま残す（次の update でも残す。--overwrite で新しい版に戻せる）
```

- `--keep-local` で残したファイルには新しい版の直しが入りません。`.gitlab-ci.yml` や `package.json` を残すと CI が動かなくなることがあるので、`--dry-run` の差分で確かめ、社内の変更を新しい版に入れ直す（`--overwrite` のあと MR で手直し）ほうが安全です。
- 上書き・削除する前のファイルは、毎回 `.yojitsu-navi-backup/<日時>/`（`年月日-時分秒`）に写します。前の版の記録（`.yojitsu-navi.json`）も入ります。git には入りません（`.gitignore`）。要らなくなったら消してください。
- 依存込みで作ったプロジェクトは、依存込みのパッケージ（`-with-deps.tgz`）で更新します（`vendor/npm-cache/` も入れ替わります）。
- コミットしていない変更があるとき・今より古い版のときは止まります（`--force` で続ける。社内で変えたファイルの確認は `--force` でも飛ばしません）。
- 0.2.0 以前から更新すると、開発元だけのテスト（`tests/e2e/`・`tests/property/`・`tests/fuzz/`・`tests/integration/app-package.test.ts` など）とスクリプトが消えます。テストを CI から外すために社内で変えたファイル（`vitest.config.ts` など）があると止まるので、`--dry-run` で確かめてから `--overwrite` にしてください（除外の設定は要らなくなります）。
- 前の版で欠けていた CI のファイルも入れ直します。最後に `init` と同じく CI のファイルを確かめます。今のプロジェクトだけを確かめるときは `yojitsu-navi check`。

### サンプルのデータを消す

`update` は `data/` にサンプルと同じ中身のまま残っているファイルを一覧で出します（消しはしません）。0.2.0 以前の `init` はサンプル入りで作っていたので、本番のデータに入れ替えたつもりでも、取り込んでいない月の作業実績（`data/worklogs/<年月>.csv`）などがサンプルのまま残っていることがあります。本番のデータと混ざると集計を誤るので、一覧のファイルは次のように直して MR にします。

- `data/worklogs/` の月のファイル・`_meta.json`: 消す（取り込みで作り直されます。過去の月は Run pipeline で `FETCH_FROM`・`FETCH_TO` を入れて取り直す。[OPERATIONS.md](OPERATIONS.md)）
- そのほかの CSV（`contracts.csv`・`masters/members.csv` など）: 本番のものに置き換える。まだ無いものは見出しの行だけを残す（消すとビルドが止まるものがあります）

## 社内で確認すること（チェックリスト）

開発環境では確認できない項目です。上から順に、手順と期待結果を確かめてください。

- [ ] **Pages の閲覧制限**
  - 手順: (1) メンバー（Guest）でブラウザから Pages の URL を開く。(2) メンバーでない人（またはシークレットウィンドウ）で同じ URL を開く。
  - 期待: (1) 全体サマリーが出る。(2) GitLab のログイン画面か 404 になる。
  - だめなら: `npm run gitlab:setup` の「Pages の閲覧」が ✗ のままなら、GitLab 管理者に Pages のアクセス制御（`gitlab_pages['access_control']`）の有効化を依頼する。有効になるまでは公開しない。
- [ ] **トークン**
  - 手順: 設定画面の「トークンを作成 ↗」で GitLab の Personal Access Token を作る画面を開く。
  - 期待: 作成画面が開き（404 にならない）、名前 `yojitsu-navi` と scope `api` が入っている。作成が許可されている。有効期限の上限を控えておく（期限が切れたら作り直して設定画面で登録し直す）。
  - だめなら: 404 なら `config.json` の `masterEdit.gitlab.tokenUrl` に社内の GitLab の作成画面のパス（古い版は `/-/profile/personal_access_tokens`）か URL を入れる。会社で PAT が禁止なら、管理者にグループアクセストークン等の代わりを相談する。決まるまでは `masterEdit.mode` を `"download"`（CSV をダウンロードして GitLab の画面でアップロード）にする。
- [ ] **CORS（画面から GitLab API を呼べるか）**
  - 手順: Developer の人が Pages の画面右上の歯車（設定画面）でトークンを登録する（登録すると自動で「接続を確認」が走る）。
  - 期待: 「接続できました」と、ユーザー名・権限（Developer）・「マージはリーダー（Maintainer）が行います」が出る。
  - だめなら: 「GitLab に接続できませんでした」なら、リバースプロキシ／WAF が `OPTIONS`（プリフライト）や `PRIVATE-TOKEN` ヘッダーを止めていないかを管理者に確認する（通らなければ `mode: "download"`）。
- [ ] **保護ブランチと権限**
  - 手順: (1) Maintainer の人が設定画面で「接続を確認」を押す。(2) Developer の人がマスタ編集で 1 行変えて保存する。(3) Developer の人の画面の「マージ待ちの変更」を見る。(4) Maintainer の人がその MR をマージする。
  - 期待: (1)「マージできる立場です」と出て、「GitLab の設定に N 件の不足があります」が **出ない**（出たら、その項目を手順 2 で直す）。(2) MR ができる。(3) マージボタンが出ず「マージはリーダーが行います」と出る。(4) パイプラインの成功後にマージでき、数分後に画面の数値が変わる。
- [ ] **マージ後の反映**
  - 手順: (4) のあと CI/CD > Pipelines を見る。
  - 期待: `main` のパイプライン（build → pages）が走り、MR の一覧に「検証: 成功」などのパイプライン状態が出る。ヘッダー右端の「⋯」の件数バッジが減る（取得は 1 分ごと）。

設定画面の「接続を確認」は、次の不足を見つけると「GitLab の設定に N 件の不足があります」と一覧で出します（直し方は手順 2）。

| 画面の表示 | 意味 |
|---|---|
| トークンに scope「api」がありません | `read_api` などで作ったトークン。保存・マージができない |
| プロジェクトが Private ではありません | CSV（単価など）を見られる人が広がる |
| Pages を誰でも見られる設定です | Pages の閲覧制限がかかっていない |
| main が保護ブランチではありません／main に直接プッシュできる人がいます／Developer も main にマージできます | 保護ブランチが推奨値と違う（この 3 つは Maintainer の人にだけ出る） |

## 計算コアをほかのプロジェクトで使う

計算コア（`src/core/`）は npm パッケージ `yojitsu-navi` に入っていて、ほかの社内プロジェクトから同じ計算・型で `import { buildModel, formatYen } from "yojitsu-navi"` のように使えます（SPEC §84。パッケージは 1 つだけ）。npmjs.com から入れるか、社内から接続できなければ手順 0 の `.tgz` を `npm install ./yojitsu-navi-<版>.tgz` で入れます。社内の Package Registry への公開ジョブはありません。

## 困ったとき

| 症状 | 原因と対処 |
|---|---|
| `npm ci` が `ETIMEDOUT` / `ENOTFOUND registry.npmjs.org` | 外部に出られない。`NPM_CONFIG_REGISTRY` に社内ミラーを設定するか、依存込みのパッケージで作り直す |
| `npm ci --offline` が `ENOTCACHED` | `package-lock.json` と `vendor/npm-cache/` の版が合っていない（社内で依存を足した・依存込みでないパッケージで update した）。依存込みのパッケージで `yojitsu-navi update` し直す |
| `yojitsu-navi update` が「依存込みです」で止まる | 依存込みで作ったプロジェクトを依存なしのパッケージで更新しようとした。`-with-deps.tgz` を使う |
| `yojitsu-navi update` が「社内で変えたファイルがあるので止めました」 | 一覧のファイルを社内で変えていた（何も変わっていない）。`--dry-run` で差分を見て、`--overwrite`（新しい版にする）か `--keep-local`（社内の版を残す）を付けて実行し直す |
| パイプラインが作られず「`jobs:.yojitsu-navi-local config can't be blank`」などと出る | `.gitlab-ci.local.yml`（か `.gitlab-ci.yml`）に中身の無い項目がある。0.2.0・0.2.1 のひな形 `.yojitsu-navi-local: {}` が原因。`yojitsu-navi update`（か `migrate-ci`）が直す。手で直すなら `{}` を消して次の行に `  variables:`、その次に `    YOJITSU_NAVI_LOCAL: "1"` を書く。`npm run ci:check` で確かめられる |
| プロジェクトの中で `npx yojitsu-navi …` が「could not determine executable to run」 | 0.2.1 までのプロジェクトは名前がコマンドと同じ。`npm install -g` で入れた `yojitsu-navi` を使う（次の版から直る） |
| CI が `Cannot find module …scripts/ci/….mjs` などで失敗する・`init`／`update` が「CI（.gitlab-ci.yml）が使うファイル…」で止まる | ファイルがコミットされていない（PC の git の除外設定に当たった）か、古い版で作った。新しい版で `yojitsu-navi update` すると入れ直してコミットする。`yojitsu-navi check`（`npm run ci:check`）で足りないファイルが一覧で出る |
| `npm ci` が `… vulnerabilities` と出る | 依存の脆弱性の報告。残っているもの（`xlsx` と Framework 経由の `deepmerge`）は使い方の上で影響しないことを確かめてある（一覧・理由・予定は [SPEC.md](SPEC.md) §84.2）。`npm audit fix --force` は Framework を古い版に下げるので実行しない |
| `npm ci` が `npm warn deprecated …`（`inflight`・`glob@8`・`whatwg-encoding`）と出る | Framework が使う部品の古い版の知らせ。動きには影響しない。Framework の新しい版で消える（[SPEC.md](SPEC.md) §84.2） |
| `npm ci` が `install scripts blocked because they are not covered by allowScripts`（`esbuild`） | npm 12 から、依存のインストールスクリプトは `package.json` の `allowScripts` で許可したものだけ動く。この版から `esbuild` を許可済み（`update` で入る）。前の版のままでも、`esbuild` はスクリプトなしで動くのでビルドは通る（[SPEC.md](SPEC.md) §84.3） |
| `yojitsu-navi init` が「空ではありません」 | 同じ名前のフォルダがある。別の名前にするか、今あるプロジェクトなら `update` |
| ジョブが `pull access denied` / イメージ取得で失敗 | Docker Hub に出られない。`NODE_IMAGE` に社内レジストリのイメージを設定 |
| ジョブが `pending` のまま | 使える Runner が無い。Settings > CI/CD > Runners を確認し、管理者に依頼 |
| `build` が `npm run validate` で失敗 | データ（CSV）の誤り。ジョブのログに行番号と理由が出るので、該当 CSV を直して MR |
| build が `registry.npmjs.org` への接続で失敗 | Framework の更新で問い合わせ先が増えた。エラーに出た `npm:<名前>` を `scripts/seed-npm-cache.mjs` の一覧に足す |
| Pages の URL が 404 | `pages` ジョブは既定ブランチでだけ動く。既定ブランチ名と、`pages` ジョブが成功しているかを確認 |
| メンバーでない人も見られる | Pages のアクセス制御が無効。チェックリストの「Pages の閲覧制限」 |
| `git push` が `protected branch` で拒否される | 想定どおり（直接プッシュ不可）。ブランチに push して MR を作る |
| 画面でマージすると「今はマージできません」 | パイプラインが終わっていない・失敗した。MR のパイプラインを確認（失敗ならログの理由を直す） |
| `gitlab:setup` が「保護ブランチを読めません」 | トークンの人が Maintainer 未満。Owner か Maintainer のトークンで実行 |
| 一部の画面だけ 404 | 公開直後の反映待ちのことがある。数分おいて再読み込み |

## 将来: 作業実績の定期取り込み（今は設定しない）

`.gitlab-ci.yml` には、スケジュール実行時だけ動く `fetch-worklogs`（作業実績 API）と `fetch-members`（人事データ、既定は無効）のジョブがすでに入っています。
スケジュールを登録しない限り動かないので、今は何もしなくて構いません。

本番 API の仕様（列名・認証）を dry-run で確認したあとに、次を行います。

1. `config.json` の `worklogSource` を本番 API に合わせる（[DATA.md](DATA.md)）
2. Project Access Token（role **Maintainer**、scope **`write_repository`**）を作り、CI/CD 変数 `GIT_PUSH_TOKEN` に登録する。`WORKLOG_API_TOKEN` も登録する。どちらも **Protected・Masked** をオン（Protected の変数は保護ブランチ `main` のスケジュールでだけ渡る）
3. Build > Pipeline schedules で平日朝（例 `0 6 * * 1-5`、Asia/Tokyo、対象 `main`）を登録
4. `npm run gitlab:setup` で `GIT_PUSH_TOKEN` の行が ✓ になることを確認

取り込み結果は `data/<種類>-<日時>` ブランチの MR になり、パイプラインが成功すると自動でマージされます（`scripts/ci/fetch-data.mjs` → `push-data-mr.mjs`。`main` は直接プッシュ不可のため）。
マージで `main` のパイプラインが走り、Pages まで更新されます。検証で失敗した MR は開いたまま残るので、ログの理由を直すか、MR を閉じてください（翌日の取り込みは最新の `main` から作り直します）。
取得そのものが途中で失敗したときは CSV を書き換えず、失敗の記録（`data/worklogs/_meta.json` などの `lastFailure`）だけを MR にしてジョブを失敗で終えます。データ確認画面に警告で出て、次に成功すると消えます（SPEC §87）。

`config.json` の `taskCodeCheck` を `stop` にしていると、未登録の作業コード・作業名の変更が見つかった日は取り込みを失敗で終え、データ確認画面に理由が出ます。直し方は [OPERATIONS.md](OPERATIONS.md)「作業コードの点検」（作業名の変更は Run pipeline の変数 `FETCH_ACCEPT_TASK_CHANGES=1` で取り込む。SPEC §92）。

過去の期間を取り直すとき（退職・異動した人の実績を含む）は、Build > Pipelines > Run pipeline で対象 `main`、変数 `FETCH_FROM`・`FETCH_TO`（`YYYY-MM`）を入れて実行します。特定の人だけなら `FETCH_MEMBERS`（社員番号をカンマ区切り）も入れます。手順は [OPERATIONS.md](OPERATIONS.md)「取得する人をメンバーマスタから決める」。
