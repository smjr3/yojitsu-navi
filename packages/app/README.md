# yojitsu-navi

予実ナビ一式（画面・計算・データローダ・サンプルデータ・CI 定義・文書）を、社内 GitLab のプロジェクトとして作るためのパッケージです。パッケージ自体は依存を持たないので、社内で外部に接続せずに動きます。

npmjs.com から（ライセンスは MIT。画面フォントは SIL OFL 1.1）:

```sh
npx yojitsu-navi init yojitsu-navi --gitlab https://<社内GitLab> --project yojitsu-navi/yojitsu-navi
```

社内から npmjs.com に接続できないときは、`.tgz` のファイルで:

```sh
npx --yes ./yojitsu-navi-<版>.tgz init yojitsu-navi --gitlab https://<社内GitLab> --project yojitsu-navi/yojitsu-navi
```

手順の全体は、できたフォルダの `docs/DEPLOY_GITLAB.md` にあります。
