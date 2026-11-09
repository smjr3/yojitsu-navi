# 変更の決まり

## ドキュメントは同じ変更の中で直す（必須）

画面・データ・計算・手順・用語を変えたら、**同じ PR（MR）の中で** README と docs を実装に合わせて直します。
古い説明・もう無い機能の説明・古い件数やファイル名を残さないでください。後回しにすると誰も直しません。

PR を出す前に確認すること:

- [ ] `git diff main --stat` で触った領域を確認し、関係する文書を直した
  - 画面 → README「画面」、[docs/UI_NOTES.md](docs/UI_NOTES.md)
  - 計算・仕様 → [docs/SPEC.md](docs/SPEC.md)、[docs/CORE_NOTES.md](docs/CORE_NOTES.md)。`src/core/index.ts` の公開 API を変えたら、パッケージ `yojitsu-navi` の版（ルートと `packages/app/package.json`）も上げる（SPEC §84）
  - 公開・社内へ渡す版を作るとき → ルートと `packages/app/package.json` の `version` を同じ値に上げ、[CHANGELOG.md](CHANGELOG.md) の「## 次の版」を「## <版>」にしてから `npm run app:pack`（SPEC §44。npmjs.com への公開は [docs/RELEASE.md](docs/RELEASE.md)）
  - 導入先（社内のプロジェクト）に届く変更 → [CHANGELOG.md](CHANGELOG.md) の「## 次の版」に書く。導入先で設定・CI/CD 変数・手順を変える必要がある、テストや CI の前提（動くジョブ・既定値・止まる条件）が変わる、のどちらかなら「更新後に行うこと」「テスト・CI の前提」「新しい設定と推奨値」に必ず書く（`yojitsu-navi update` がそのまま表示する。SPEC §91.2）
  - データの列・ファイル → [docs/DATA.md](docs/DATA.md)
  - `config.json` の項目を足す・変える → `scripts/lib/config-schema.mjs`（互換確認。SPEC §96）にも足す。新しい項目は既定値のある任意の項目にする（必須にすると導入先の版上げが止まる）。名前を変える・やめるときは `deprecated` に移し方を書く（名前だけを変えるなら `renamedTo` に新しい項目も書く。`yojitsu-navi migrate-config --apply` が値を移す。SPEC §104）。`tests/unit/config-schema.test.ts` の `fullConfig()` にも足す
  - ダミーデータ → [docs/DUMMY_DATA.md](docs/DUMMY_DATA.md)（規模・警告の件数の表）
  - 画面の文言 → [docs/TEXTS.md](docs/TEXTS.md)
  - ビルド・ローダ → [docs/DATA_LOADERS.md](docs/DATA_LOADERS.md)
  - 設定・運用・公開 → [docs/OPERATIONS.md](docs/OPERATIONS.md)、[docs/DEPLOY_GITLAB.md](docs/DEPLOY_GITLAB.md)、npmjs.com への公開 → [docs/RELEASE.md](docs/RELEASE.md)
  - テスト → [tests/e2e/README.md](tests/e2e/README.md)
- [ ] README・docs に画像（スクリーンショット・バッジ）を載せていない・リポジトリに画像ファイルを置いていない（画面を変えるたびに古くなり、npm パッケージも大きくなるため。画面は `npm run dev` で確かめる）。どうしても必要な画像だけ `tests/unit/docs-links.test.ts` の `IMAGE_ALLOWLIST` に理由つきで足す（今は 0 件）
- [ ] 文書の中のリンク・ファイル名・コマンドが今も存在する
- [ ] PR の説明に「ドキュメント: 何を直したか」を書いた（直す必要が無ければ理由）

## テスト

- `npm run check`（型・データ検証・unit / property / integration）と `npm run test:e2e`（Playwright 全件）が通ること。GitHub Actions は Pull Request では E2E の縮小版（`npm run test:e2e:smoke`）しか走らせないので、全件はマージ前にローカルで通す（`main` へのマージ後に CI が全件を 3 分割で走らせる）
- 主要な画面・操作を足したら、その代表のテストに `{ tag: "@smoke" }` を付けて縮小版に入れる（[tests/e2e/README.md](tests/e2e/README.md)）
- 社内のプロジェクトに配るテストは運用に要るもの（取り込み・データ検証・CI のスクリプト）だけ。足すときは `packages/app/lib/template-files.mjs` の `USER_TESTS` に入れ、プロジェクトの `config.json`・`data/` を読まない（設定は `tests/fixtures/project.ts` の `testConfig()`、データは `tests/fixtures/project/data/`。SPEC §93）。ほかのテスト・開発元だけのスクリプトは配らない
- 画面を変えたら、実際に操作して確かめる: 画面幅 390 / 768 / 1024 / 1280px、ライト / ダーク、極端な値（0・とても大きい金額・長い名前）、はみ出し
- 操作の手数・待ち・迷いも見る（分かりにくい・手間が多いものは直すか、PR に書く）

## そのほか

- 画面の文言は `src/i18n/ja.js`・`src/i18n/rules.txt`・`src/i18n/guide.txt` に集める（[docs/TEXTS.md](docs/TEXTS.md)）。画面を変えたら「使い方」（`guide.txt`）も同じ PR で直す
- Windows・Linux のどちらでも動かす（本番の Runner は Windows。SPEC §79）: `.gitlab-ci.yml` の `script` にシェルの構文を書かず `scripts/ci/*.mjs` に入れる。`bash`・`grep` などに頼らない、パスは `path` で扱う、文字列の並べ替えは言語を指定する、npm は `scripts/lib/npm.mjs` で起動する。テストのタイムアウトは `scaled()`、性能の判定は `measure()`、長く待つ別プロセスは `runAsync()`（`tests/test-env.ts`。SPEC §79.1）
- ビルドは必ず `npm run build`（`npx observable build` を直接使わない。[docs/DATA_LOADERS.md](docs/DATA_LOADERS.md)）
- 文書・コメント・設定に個人のアカウント名や外部サービスのアカウント情報を書かない
