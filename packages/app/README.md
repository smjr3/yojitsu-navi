# yojitsu-navi

予実ナビ（保守案件の予算と実績のダッシュボード）のパッケージです。次の 2 つが入っています。パッケージ自体は依存を持たないので、社内で外部に接続せずに動きます。ライセンスは MIT（画面フォントは SIL OFL 1.1）。

- 予実ナビ一式（画面・計算・データローダ・CI 定義・運用のテスト・文書）を社内 GitLab のプロジェクトとして作るコマンド `yojitsu-navi`。`data/` は空で作る（`--sample` で試す用のサンプル入り）
- ほかのプロジェクトから使える計算コア（予算・実績・残予算・着地見込みの計算と型、データの検証・CSV の読み込み）

## プロジェクトを作る

```sh
npx yojitsu-navi init yojitsu-navi --gitlab https://<社内GitLab> --project yojitsu-navi/yojitsu-navi
```

社内から npmjs.com に接続できないときは、`.tgz` のファイルで:

```sh
npx --yes ./yojitsu-navi-<版>.tgz init yojitsu-navi --gitlab https://<社内GitLab> --project yojitsu-navi/yojitsu-navi
```

新しい版にするときは `yojitsu-navi upgrade`（`update` → 依存 → `check` → データ検証 → ビルドを 1 回で行い、要約とログを残す。依存は変わったときだけ入れ直し、テストは社内で手を加えたコードがあるときだけ動かす。`update` だけでもよい。`data/`・`config.json`・`.gitlab-ci.local.yml`・`.npmrc`・社内で足したファイルは変えない）。先に `yojitsu-navi upgrade --dry-run` で止まらずに進めるかを確かめられます。`config.json` に無い新しい設定は `yojitsu-navi migrate-config` で確かめ、選んだものだけ書き足せます。サンプルのまま残ったデータは `yojitsu-navi reset-data` で空にできます。CI（`.gitlab-ci.yml`）が使うファイルがそろってコミットされているかは `init`・`update` の最後に確かめ、`yojitsu-navi check`（プロジェクトの中では `npm run ci:check`）でも確かめられます。

手順の全体は、できたフォルダの `docs/DEPLOY_GITLAB.md` にあります。

新しい版にするときは、`npm install -g yojitsu-navi@<版>` のあとプロジェクトのフォルダで `yojitsu-navi update`（先に `--dry-run` で確かめられます。0.2.1 までのプロジェクトは名前がコマンドと同じなので、プロジェクトの中の `npx yojitsu-navi` は動きません）。`config.json` と `data/` は変えません。社内で変えたファイルがあると上書きの前に止まります（`--overwrite` か `--keep-local` を選ぶ）。上書き・削除する前のファイルは `.yojitsu-navi-backup/<日時>/` に残ります。社内向けの CI の設定は `.gitlab-ci.local.yml`・`.npmrc`・CI/CD 変数に書けば上書きされません（`.gitlab-ci.yml` に書いていたものは `yojitsu-navi migrate-ci` で移せます）。更新のあとに、今の版から新しい版までに導入先で行うこと・前提が変わることを 変更履歴（できたフォルダの `CHANGELOG.md`）から出します。

## 計算コアを使う

```sh
npm install yojitsu-navi
```

```ts
import { parseDataset, buildModel, aggregate, formatYen, type Contract } from "yojitsu-navi";
import { effectiveSaveMode } from "yojitsu-navi/gitlab";   // index に無いものは個別に
```

- ES Modules のみ（`import`）。Node 20 以上、またはバンドラ（Vite・Observable Framework など）。型定義（`.d.ts`）同梱。
- 画面の文言（エラー文・「未設定」などのラベル）は日本語固定です。
