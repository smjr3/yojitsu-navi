# yojitsu-navi

予実ナビ（保守案件の予算と実績のダッシュボード）のパッケージです。次の 2 つが入っています。パッケージ自体は依存を持たないので、社内で外部に接続せずに動きます。ライセンスは MIT（画面フォントは SIL OFL 1.1）。

- 予実ナビ一式（画面・計算・データローダ・サンプルデータ・CI 定義・文書）を社内 GitLab のプロジェクトとして作るコマンド `yojitsu-navi`
- ほかのプロジェクトから使える計算コア（予算・実績・残予算・着地見込みの計算と型、データの検証・CSV の読み込み）

## プロジェクトを作る

```sh
npx yojitsu-navi init yojitsu-navi --gitlab https://<社内GitLab> --project yojitsu-navi/yojitsu-navi
```

社内から npmjs.com に接続できないときは、`.tgz` のファイルで:

```sh
npx --yes ./yojitsu-navi-<版>.tgz init yojitsu-navi --gitlab https://<社内GitLab> --project yojitsu-navi/yojitsu-navi
```

新しい版にするときは `yojitsu-navi update`（`data/` と `config.json` は変えない）。CI（`.gitlab-ci.yml`）が使うファイルがそろってコミットされているかは `init`・`update` の最後に確かめ、`yojitsu-navi check` でも確かめられます。

手順の全体は、できたフォルダの `docs/DEPLOY_GITLAB.md` にあります。

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
