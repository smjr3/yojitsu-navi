# npmjs.com への公開（SPEC §83）

予実ナビの 2 つのパッケージを npmjs.com に公開する手順です。ライセンスは MIT（ルートの `LICENSE`。画面フォントは別に SIL OFL 1.1、`src/fonts/OFL.txt`）。

| パッケージ | 中身 | タグ |
|---|---|---|
| `@yojitsu-navi/core` | 計算コア（`packages/core/`、SPEC §43） | `core-v<版>` |
| `yojitsu-navi` | アプリ一式を作るコマンド（`packages/app/`、SPEC §44） | `app-v<版>` |

公開は GitHub Actions の `publish-npm`（`.github/workflows/publish-npm.yml`）だけが行います。手元の PC で `npm publish` すると、公開前の確認（`scripts/check-publish.mjs`）が止めます。

## 最初に 1 回（npmjs.com と GitHub の画面）

1. npmjs.com でアカウントを作る（Sign Up）。**ユーザー名は公開ページに出るので、個人名・会社名にしない**。2 段階認証を有効にする。
2. 右上のアイコン > **Add Organization** で、名前 `yojitsu-navi` の Organization を作る（無料の Public packages プラン）。`@yojitsu-navi/core` のスコープになる。
3. 右上のアイコン > **Access Tokens** > **Generate New Token** > **Granular Access Token**:
   - Packages and scopes: **Read and write**、対象は「All packages」か `yojitsu-navi` と `@yojitsu-navi`（Organization も Read and write）
   - 「Bypass two-factor authentication」をオン（CI から公開するため）
   - 有効期限を決めて作成し、表示されたトークンをコピーする
4. GitHub のリポジトリの **Settings > Secrets and variables > Actions > New repository secret** で、名前 `NPM_TOKEN`、値に 3 のトークンを入れて保存する。

## 公開するたび

1. 版を上げる PR を作り、`main` にマージする（互換が崩れる変更は 1 桁目、機能の追加は 2 桁目、直しは 3 桁目）。
   - core は `packages/core/package.json` の `version`。
   - アプリは `packages/app/package.json` と ルートの `package.json` の `version`（同じ値にする）。
2. GitHub の **Releases > Draft a new release > Choose a tag** で、新しいタグ `core-v<版>`（例 `core-v0.2.0`）か `app-v<版>`（例 `app-v0.1.0`）を入力し、Target を `main` にして **Publish release**。
3. **Actions > Publish npm** が、版とタグの一致・型チェック・テスト・ビルドを確かめてから公開する（数分）。npmjs.com のパッケージのページで版を確認する。

## 困ったとき

| 症状 | 原因と対処 |
|---|---|
| 「タグ … と … の version が一致しません」 | タグの版と package.json が違う。Release とタグを消して、正しい版で作り直す |
| `npm publish` が 403 | 同じ版が公開済み（上書きできない）か、トークンにそのパッケージの書き込み権限がない |
| `npm publish` が 401 / `ENEEDAUTH` | `NPM_TOKEN` が未設定か期限切れ。作り直して Secrets を更新する |
| `@yojitsu-navi/core` が 404 で公開できない | Organization `yojitsu-navi` が無い（最初に 1 回の 2） |

公開した版は 72 時間を過ぎると取り消せません（npm の決まり）。中身は `npm run core:pack`／`npm run app:pack` で `.tgz` を作って確かめられます。
