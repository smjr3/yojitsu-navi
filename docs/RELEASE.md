# npmjs.com への公開（SPEC §83・§84）

npm パッケージ `yojitsu-navi` を npmjs.com に公開する手順です。パッケージは 1 つだけで、アプリ一式を作るコマンド（`npx yojitsu-navi init`）と、ほかのプロジェクトから import して使う計算コア（`import { buildModel } from "yojitsu-navi"`）の両方が入っています。ライセンスは MIT（ルートの `LICENSE`。画面フォントは別に SIL OFL 1.1、`src/fonts/OFL.txt`）。

公開は GitHub Actions の `publish-npm`（`.github/workflows/publish-npm.yml`）だけが行います。手元の PC で `npm publish` すると、公開前の確認（`scripts/check-publish.mjs`）が止めます。

## 最初に 1 回（npmjs.com と GitHub の画面）

1. npmjs.com でアカウントを作る（Sign Up）。**ユーザー名は公開ページに出るので、個人名・会社名にしない**。2 段階認証を有効にする。
2. 右上のアイコン > **Access Tokens** > **Generate New Token** > **Granular Access Token**:
   - Packages and scopes: **Read and write**、対象は「All packages」（最初の公開の後は `yojitsu-navi` だけに絞ってよい）
   - 「Bypass two-factor authentication」をオン（CI から公開するため）
   - 有効期限を決めて作成し、表示されたトークンをコピーする
3. GitHub のリポジトリの **Settings > Secrets and variables > Actions > New repository secret** で、名前 `NPM_TOKEN`、値に 2 のトークンを入れて保存する。

## 公開するたび

1. 版を上げる PR を作り、`main` にマージする。ルートの `package.json` と `packages/app/package.json` の `version` を同じ値にする（互換が崩れる変更は 1 桁目、機能の追加は 2 桁目、直しは 3 桁目）。同じ PR で [CHANGELOG.md](../CHANGELOG.md) の「## 次の版」を「## <版>」にし、中身を見直す（下の「変更履歴の書き方」）。新しい「## 次の版」は、次に導入先へ届く変更の PR で足す。
2. GitHub の **Releases > Draft a new release > Choose a tag** で、新しいタグ `v<版>`（例 `v0.1.0`）を入力し、Target を `main` にして **Publish release**。
3. **Actions > Publish npm** が、版とタグの一致・型チェック・テスト・ビルドを確かめてから公開する（数分）。CHANGELOG.md にその版の見出しが無いと公開前の確認が止める。npmjs.com のパッケージのページで版を確認する。

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
| 「タグ … と … の version が一致しません」 | タグの版と package.json が違う。Release とタグを消して、正しい版で作り直す |
| `npm publish` が 403 | 同じ版が公開済み（上書きできない）か、トークンに書き込み権限がない |
| `npm publish` が 401 / `ENEEDAUTH` | `NPM_TOKEN` が未設定か期限切れ。作り直して Secrets を更新する |

公開した版は 72 時間を過ぎると取り消せません（npm の決まり）。中身は `npm run app:pack` で `.tgz` を作って確かめられます。
