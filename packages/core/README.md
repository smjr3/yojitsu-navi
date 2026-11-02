# @yojitsu-navi/core

予実ナビの計算コアです。保守案件の予算（契約金額の均等月割り）・実績（工数 × 時間単価）・残予算・着地見込みの計算と、データの型・検証・CSV の読み込みを、ほかのプロジェクトからも同じ結果で使えるようにしたものです。画面（Observable Framework）には依存しません。外部の依存はありません。

- ソースの正はリポジトリの `src/core/`（画面と同じもの）。このフォルダには `package.json` と配布物（`dist/`、git には入れない）だけを置きます。
- 計算の仕様は `docs/SPEC.md`、CSV の列は `docs/DATA.md`、公開の手順は `docs/DEPLOY_GITLAB.md`「計算コアの npm パッケージ」。

## 使い方

npmjs.com から入れます（ライセンスは MIT）。

```sh
npm install @yojitsu-navi/core
```

社内 GitLab の Package Registry に公開したもの（`docs/DEPLOY_GITLAB.md`）を使うときは、使う側のプロジェクトの `.npmrc`:

```ini
@yojitsu-navi:registry=https://gitlab.example.local/api/v4/groups/<グループID>/-/packages/npm/
//gitlab.example.local/api/v4/groups/<グループID>/-/packages/npm/:_authToken=${GITLAB_NPM_TOKEN}
```

`GITLAB_NPM_TOKEN` は `read_api` の個人トークンかデプロイトークン（`read_package_registry`）。GitLab CI の中なら `${CI_JOB_TOKEN}` で読めます（このプロジェクトの CI/CD > Job token permissions で相手のプロジェクトを許可）。

```sh
npm install @yojitsu-navi/core
```

```ts
import { parseDataset, buildModel, aggregate, formatYen, type Contract } from "@yojitsu-navi/core";
import { effectiveSaveMode } from "@yojitsu-navi/core/gitlab";   // index に無いものは個別に
```

- ES Modules のみ（`import`）。Node 20 以上、またはバンドラ（Vite・Observable Framework など）。
- 型定義（`.d.ts`）同梱。
- 画面の文言（エラー文・「未設定」などのラベル）は日本語固定で `dist/i18n/` に入っています。
