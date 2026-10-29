# 変更の決まり

## ドキュメントは同じ変更の中で直す（必須）

画面・データ・計算・手順・用語を変えたら、**同じ PR（MR）の中で** README と docs を実装に合わせて直します。
古い画像・古い説明・もう無い機能の説明・古い件数やファイル名を残さないでください。後回しにすると誰も直しません。

PR を出す前に確認すること:

- [ ] `git diff main --stat` で触った領域を確認し、関係する文書を直した
  - 画面 → README「画面」、[docs/UI_NOTES.md](docs/UI_NOTES.md)、スクリーンショット
  - 計算・仕様 → [docs/SPEC.md](docs/SPEC.md)、[docs/CORE_NOTES.md](docs/CORE_NOTES.md)
  - データの列・ファイル → [docs/DATA.md](docs/DATA.md)
  - ダミーデータ → [docs/DUMMY_DATA.md](docs/DUMMY_DATA.md)（規模・警告の件数の表）
  - 画面の文言 → [docs/TEXTS.md](docs/TEXTS.md)
  - ビルド・ローダ → [docs/DATA_LOADERS.md](docs/DATA_LOADERS.md)
  - 設定・運用・公開 → [docs/OPERATIONS.md](docs/OPERATIONS.md)、[docs/DEPLOY_GITLAB.md](docs/DEPLOY_GITLAB.md)
  - テスト → [tests/e2e/README.md](tests/e2e/README.md)
- [ ] 画面の見た目を変えたら `npm run screenshots` でスクリーンショットを撮り直した（README の画像は常に最新。撮り直さない画像は参照ごと消す）
- [ ] 文書の中のリンク・ファイル名・コマンドが今も存在する
- [ ] PR の説明に「ドキュメント: 何を直したか」を書いた（直す必要が無ければ理由）

## テスト

- `npm run check`（型・データ検証・unit / property / integration）と `npm run test:e2e`（Playwright 全件）が通ること。GitHub Actions は Pull Request では E2E の縮小版（`npm run test:e2e:smoke`）しか走らせないので、全件はマージ前にローカルで通す（`main` へのマージ後に CI が全件を走らせる）
- 主要な画面・操作を足したら、その代表のテストに `{ tag: "@smoke" }` を付けて縮小版に入れる（[tests/e2e/README.md](tests/e2e/README.md)）
- 画面を変えたら、実際に操作して確かめる: 画面幅 390 / 768 / 1024 / 1280px、ライト / ダーク、極端な値（0・とても大きい金額・長い名前）、はみ出し
- 操作の手数・待ち・迷いも見る（分かりにくい・手間が多いものは直すか、PR に書く）

## そのほか

- 画面の文言は `src/i18n/ja.js` と `src/i18n/rules.txt` に集める（[docs/TEXTS.md](docs/TEXTS.md)）
- ビルドは必ず `npm run build`（`npx observable build` を直接使わない。[docs/DATA_LOADERS.md](docs/DATA_LOADERS.md)）
- 文書・コメント・設定に個人のアカウント名や外部サービスのアカウント情報を書かない
