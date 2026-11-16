# npmjs.com への公開（SPEC §83・§84）

npm パッケージ `yojitsu-navi` を npmjs.com に公開する手順です。パッケージは 1 つだけで、アプリ一式を作るコマンド（`npx yojitsu-navi init`）と、ほかのプロジェクトから import して使う計算コア（`import { buildModel } from "yojitsu-navi"`）の両方が入っています。ライセンスは MIT（ルートの `LICENSE`。画面フォントは別に SIL OFL 1.1、`src/fonts/OFL.txt`）。

公開は GitHub Actions の `publish-npm`（`.github/workflows/publish-npm.yml`）だけが行います。版を上げる PR が `main` にマージされると、npm への公開・タグ `v<版>`・GitHub のリリースまで自動で終わります（タグを手で作らない。SPEC §121）。手元の PC で `npm publish` すると、公開前の確認（`scripts/check-publish.mjs`）が止めます。

## 最初に 1 回（npmjs.com と GitHub の画面）

1. npmjs.com でアカウントを作る（Sign Up）。**ユーザー名は公開ページに出るので、個人名・会社名にしない**。2 段階認証を有効にする。
2. 右上のアイコン > **Access Tokens** > **Generate New Token** > **Granular Access Token**:
   - Packages and scopes: **Read and write**、対象は「All packages」（最初の公開の後は `yojitsu-navi` だけに絞ってよい）
   - 「Bypass two-factor authentication」をオン（CI から公開するため）
   - 有効期限を決めて作成し、表示されたトークンをコピーする
3. GitHub のリポジトリの **Settings > Secrets and variables > Actions > New repository secret** で、名前 `NPM_TOKEN`、値に 2 のトークンを入れて保存する。

## 公開するたび

1. 版を上げる PR を作る。`npm run version:bump -- patch`（直し）・`minor`（機能の追加）・`major`（互換が崩れる変更）が、ルートと `packages/app/package.json`・`package-lock.json` の `version` を同じ値にし、[CHANGELOG.md](../CHANGELOG.md) の「## 次の版」を「## <版>」にする（「## 次の版」が無ければ止まる）。中身を見直す（下の「変更履歴の書き方」）。新しい「## 次の版」は、次に導入先へ届く変更の PR で足す。
2. PR を `main` にマージする。**Actions > Publish npm** が、その版がまだ npm に無いことを確かめ、型チェック・テスト・ビルドのあと公開し、タグ `v<版>` と GitHub のリリース（説明は CHANGELOG.md のその版）を作る（数分）。版の変わらないマージでは動かない。
3. 途中で失敗したら、原因を直してから **Actions > Publish npm > Run workflow**（main）。npm に版があれば公開を飛ばし、リリースだけ作る。

公開済みかどうかは npmjs.com で調べるので、同じ版を二度出すことはありません。

### トークンを使わない公開（trusted publishing）

npm は 2 段階認証を飛ばすトークンでの CI からの公開を段階的にやめる予定です。`publish-npm` は npm の trusted publishing（OIDC）にも対応しています（`id-token: write`、Node 24）。切り替えるときは、`packages/app/package.json` の `repository.url` をこのリポジトリの URL にし（npm の必須条件。npm のページにリポジトリが出る）、npmjs.com の **yojitsu-navi > Settings > Trusted publishing > GitHub Actions** に、リポジトリの持ち主・リポジトリ名・ワークフローのファイル名 `publish-npm.yml` を入れ、「Allowed actions」で `npm publish` も許可して保存する。設定後 2 日以内に 1 回公開しないと設定が無効になる。動いたら Secrets の `NPM_TOKEN` は消してよい。

## 変更履歴の書き方

[CHANGELOG.md](../CHANGELOG.md) は導入先の管理者が読みます。`yojitsu-navi update` が、今の版から新しい版までの次の 3 つの小見出しを端末に出します（SPEC §91.2）。導入先に届く変更の PR では、同じ PR で「## 次の版」に書きます。

| 小見出し | 書くこと | 必ず書くとき |
|---|---|---|
| `### 更新後に行うこと` | 導入先が `config.json`・CI/CD 変数・ファイルを直す手順（箇条書き） | 新しい設定を入れないと動かない・推奨が変わる・移す設定がある |
| `### テスト・CI の前提` | 動くジョブ・既定値・止まる条件・テストの前提の変化（箇条書き） | CI のジョブ・既定の変数・テストの対象や前提・止まる条件が変わる |
| `### 新しい設定と推奨値` | 表。列は「項目（`` `config.json の項目` ``）・書かないとき・推奨・理由・いつ」。`update` は導入先の今の値を添える | `config.json` に項目が増えた・既定値と推奨が違う |
| `### 変更` | PR ごとの 1 行（`update` は出さない） | いつも |

- 版の見出しは `## 0.3.0` の形（公開前は `## 次の版`。`update` は出さない）。日付は書かない（年の直書きをしない。SPEC §49）。
- 社内の URL・会社名・個人名は書かない。

## 困ったとき

| 症状 | 原因と対処 |
|---|---|
| 「npmjs.com を確かめられませんでした」 | npm の障害など。時間をおいて Run workflow でやり直す |
| `npm publish` が 403 | 同じ版が公開済み（上書きできない）か、トークンに書き込み権限がない |
| `npm publish` が 401 / `ENEEDAUTH` / `EOTP` | `NPM_TOKEN` が未設定・期限切れ・2 段階認証を飛ばさない設定。作り直して Secrets を更新するか、trusted publishing に切り替える |
| `gh release create` が 403 | リポジトリの設定（ルールセットなど）が Actions のタグ作成を止めている。npm には公開済みなので、設定を直して Run workflow |

公開した版は 72 時間を過ぎると取り消せません（npm の決まり）。中身は `npm run app:pack` で `.tgz` を作って確かめられます。
