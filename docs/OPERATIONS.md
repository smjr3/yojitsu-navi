# 運用と設定

README から分けた、運用担当・管理者向けの設定と手順です。公開（GitLab Pages）の初回設定は [DEPLOY_GITLAB.md](DEPLOY_GITLAB.md)、
`config.json` の項目の一覧は [DATA.md](DATA.md) を参照してください。

## CI/CD 変数

Settings > CI/CD > Variables に登録します。

| 変数 | 用途 |
|---|---|
| `WORKLOG_API_TOKEN` | 作業実績 API のトークン（http アダプタ）。Protected・Masked にする |
| `MEMBER_FETCH_ENABLED` | 任意。`1` でスケジュール実行時に `fetch-members` ジョブも動く（既定は無効） |
| `MEMBER_API_TOKEN` | 任意。人事 API のトークン（`memberSource.adapter = http`）。Protected・Masked にする |
| `GIT_PUSH_TOKEN` | スケジュール実行の取り込み結果を MR にして自動マージするための Project Access Token（**Maintainer** / `write_repository`。Protected・Masked。`main` は直接プッシュ不可のため MR を通す。SPEC §39.4） |
| `NPM_CONFIG_REGISTRY` | 任意。社内 npm ミラーの URL（依存込みのパッケージで作ったプロジェクトは不要。[DEPLOY_GITLAB.md](DEPLOY_GITLAB.md) 手順 0） |
| `NODE_IMAGE` | 任意。Node のイメージ（既定 `node:22`）。Docker Hub に出られないときは社内レジストリのもの |
| `PLAYWRIGHT_E2E` | 任意。`1` で build 後に E2E も実行 |

スケジュール（Settings > CI/CD > Schedules、例: 平日 06:00）を登録すると `fetch-worklogs` ジョブが
直近 N か月の作業実績を取り直して MR（`data/worklogs-<日時>`）を作り、パイプラインの成功後に自動でマージされて公開まで進みます。

## 作業実績の取得元（アダプタ）を本番 API に切り替える

作業実績の取得元は `scripts/adapters/` のアダプタで差し替えます。`config.json` の `worklogSource` で選びます。

| adapter | 用途 |
|---|---|
| `csv` | `data/worklogs/*.csv` を手で置く運用（既定） |
| `dummy` | 開発・デモ用。`scripts/generate-dummy.ts` のシナリオを生成 |
| `http` | 社内の工数管理 API から JSON / CSV で取得（汎用） |

本番 API に切り替える手順:

1. `config.json` を編集

   ```json
   "worklogSource": {
     "adapter": "http",
     "http": {
       "url": "https://worklog.example.local/api/export?from={from}&to={to}",
       "authHeader": "Authorization",
       "refetchMonths": 3,
       "columns": {
         "date": "work_date", "memberId": "emp_no", "memberName": "emp_name",
         "customerName": "client", "projectName": "project", "task": "task", "hours": "hours"
       }
     }
   }
   ```

   - `{from}` `{to}` は `YYYY-MM` に置換されます
   - `columns` は「予実ナビの項目名 → 取得元の列名」
   - 任意項目: `dataPath`（JSON で配列が入っているキー。`"data.items"` のようにドット区切り）、
     `authScheme`（既定は `Authorization` ヘッダのとき `Bearer`、他のヘッダ名なら接頭辞なし）、`method`
   - 応答は `Content-Type` が JSON なら配列、`text/csv` なら CSV として読みます
   - 5xx とネットワークエラーは 3 回まで再試行、4xx は即失敗
2. CI/CD 変数 `WORKLOG_API_TOKEN` と `GIT_PUSH_TOKEN` を Protected・Masked で登録（トークンは config.json に書かない。ログにも出ません）
3. ローカルで確認: `WORKLOG_API_TOKEN=... npm run fetch && npm run validate`
4. スケジュールを登録（取り込み結果は `data/worklogs-<日時>` の MR になり、パイプラインの成功後に自動でマージされます）

`refetchMonths` か月分を毎回取り直すので、締め後の修正入力も反映されます。それより前の月は触りません。
一時的に切り替えたいときは環境変数 `WORKLOG_ADAPTER=dummy npm run fetch` のように上書きできます。
新しいアダプタの追加手順は [scripts/adapters/index.ts](../scripts/adapters/index.ts) の冒頭コメントを参照。

## 本番 API への合わせ方（コードを変えずに config だけで）

本番の API の列名・日付形式・ページングは本番でしか分からないので、`config.json` だけで合わせられるようにしてあります。設定項目の一覧は [DATA.md](DATA.md)。

1. **列名を確認する**（ファイルは書かれません）

   ```bash
   WORKLOG_API_TOKEN=... npm run fetch -- --dry-run --sample=5
   ```

   まず `config.json` の `worklogSource.adapter` を `http`、`http.url` を API の URL にしておきます。
   列名が合っていないと「列が見つかりません: …。応答の最初の1行の列名: a, b, member.id, …」と止まります
   （列名だけを表示し、中身の値は出しません）。表示された列名を見て次へ。
2. **config を書く**
   - 列名: `columns` に「予実ナビの項目 → 取得元の列名」。入れ子は `"member.id"`、候補が複数あるなら `["emp_no", "member.id"]`
   - 日付: `dateFormat`（`YYYY-MM-DD` / `YYYY/MM/DD` / `YYYYMMDD` / `ISO8601` / `epochMillis`。省略で自動判定）
     - 時刻付きの日付（`2026-10-31T23:30:00Z` など）は、自動判定だと先頭 10 文字（UTC の日付）を取るため JST では翌日の作業が前日になる。時刻付きの API では `dateFormat: ISO8601` を推奨（JST に変換して日付を取る）。8 桁の数値（`20261027`）は `YYYYMMDD` として読む
     - 取得できたのに全行が対象期間外になるときは、ファイルを書かずにエラーで止まる（日付の読み違いで月ファイルが空になるのを防ぐ）。分・秒単位の API は小数 4 桁まで保持して換算する
   - 時間の単位: `hoursUnit`（`hours` / `minutes` / `seconds`）
   - 件数が多い API: `pagination`（`page` / `offset` / `link` / `cursor`）
   - 取り消し行などを除く: `filters`、固定の絞り込み: `query`、Shift_JIS の CSV: `encoding`
3. **もう一度 dry-run で確認する**: 「列の対応表」の各項目が `[使う列: …]` になり、先頭 N 行の日付・時間・名前が想定どおりなら完了。
   問題なければ `npm run fetch && npm run validate` で実際に書き込む。

ページングは、上限ページ数（`maxPages`、既定 1000）と、同じカーソル・同じページの繰り返しの検出で無限ループしません。
トークンはログにも例外メッセージにも出ません（環境変数のみ）。

### 所属・役職を人事データから取り込む（任意）

既定（`memberSource.adapter = "none"`）では `data/masters/members.csv` を手で編集します。
人事の元データがあるときは `memberSource` を設定すると、`npm run fetch:members` で更新できます。

```bash
# 人事の CSV を置く運用: data/hr/members.csv に置いて adapter を csv にする
npm run fetch:members -- --dry-run --sample=5   # 対応表と変更内容だけ表示（書かない）
npm run fetch:members                           # members.csv を更新
```

- 変わった人（名前・区分・役職・部・課）だけ、実行月の `effective_from` で新しい行を追加します（`team_id` は引き継ぎ。チームは画面で設定）
- 取り込み元に無い人は削除も退職扱いもしません（過去月を壊さないため）。退職はマスタ編集の「在籍区分」か、`status=退職` の行を足して表します（SPEC §35）。退職の行がある人が取り込み元に再び現れたら、在籍に戻す行を足します。何度流しても同じ結果です
- 人事 API のときは `adapter: "http"`、環境変数 `MEMBER_API_TOKEN`
- CI で毎日実行するには、スケジュールを登録して CI/CD 変数 `MEMBER_FETCH_ENABLED=1` を設定します（既定は無効）

## マスタ編集の設定（GitLab へのマージ方式）

`/masters`（`data/masters/members.csv`・`rates.csv`・`teams.csv`）と `/plan`（`data/assignments.csv`・`data/outside-plans.csv`）は、CSV を画面で編集する画面です（SPEC §19・§24〜§26・§36）。保存は 2 つの画面で共通で、両方の変更が 1 つの MR に入ります。
表で 1 行ずつ直すほか、「CSV で編集」に切り替えてファイルの中身をまとめて書き換える・Excel から貼り付けることもできます。
編集後のデータはブラウザ内で `npm run validate` と同じ検証にかけ、エラーがあれば保存できません。

流れ: 画面で編集 → 保存すると GitLab に **ブランチと MR** ができる → リーダーが画面上部の「マージ待ちの変更」で内容を見て **マージ** → CI がビルドし直して反映。
開いている MR の件数はヘッダーの「マスタ編集」にバッジで出ます。トークンの登録・表示モード・差し色は右上の歯車（設定画面 `/settings`）にまとめています。

```jsonc
"masterEdit": {
  "mode": "gitlab",                // 既定。"download"（CSV をダウンロードしてアップロード）| "demo"（試用。GitLab に接続しない）
  "gitlab": {
    "apiBaseUrl": "",              // 例 https://gitlab.example.local/api/v4（空の間は download で動く）
    "projectId": "",               // 数値ID または "group/yojitsu-navi"
    "targetBranch": "main",
    "commitMode": "mr"             // "mr"（ブランチ masters/<日時>-<ユーザー> にコミットして MR）| "direct"（非推奨）
  }
}
```

1. 接続先: 社内 GitLab の CI でビルドすると、`apiBaseUrl`・`projectId` が空ならそのプロジェクト（`CI_API_V4_URL`・`CI_PROJECT_PATH`）が自動で入る（SPEC §39.1）。別のプロジェクトに保存したいときだけ値を入れる。ローカルのビルドで両方空なら CSV ダウンロードになる。
2. 各自が GitLab の「ユーザー設定 → アクセストークン」で Personal Access Token（scope: `api`）を作り、設定画面（右上の歯車）で登録する。マスタ編集・リソース計画の保存欄には入力欄を置かず、未登録なら「設定へ」のリンクが出る。
   既定はそのタブの `sessionStorage` だけ（タブを閉じると消える）。設定画面で「このブラウザに記憶する」を選ぶと `localStorage`。画面に再表示しない・サーバーやリポジトリには保存しない。
3. 権限: 保存（MR 作成）は Developer 以上、**マージはリーダー層（Maintainer）だけ**。GitLab 側で `main` を保護ブランチにする（[DEPLOY_GITLAB.md](DEPLOY_GITLAB.md)「推奨構成」。`npm run gitlab:setup -- --apply` で設定できる）。
   設定画面の「接続を確認」は、トークンの scope・公開範囲・Pages の閲覧制限・保護ブランチが推奨と違えば「GitLab の設定に N 件の不足があります」と出す（SPEC §39.3）。
   画面は GitLab が返す `can_merge` を見て、マージできる人にだけ「マージ」ボタンを出す（強制は GitLab 側）。
4. 競合検出: ビルド時に各ファイルの最終コミット ID を取り、コミットの `last_commit_id` に付ける。編集中に他の人が同じファイルを更新していると GitLab が拒否し、画面に「他の人が先に更新しました」と出る（編集内容は下書きに残る）。
   このため CI の build ジョブは `GIT_DEPTH: "0"`（浅いクローンにしない）にしている。マージは表示中の head（`sha`）を付けて行い、見ていない変更が入らないようにする。

**CORS**: Pages（`*.pages.<社内ドメイン>`）と GitLab 本体はオリジンが違うので、ブラウザから API を呼ぶには GitLab 側が CORS を許可している必要がある。
GitLab の API は Personal Access Token 付きの CORS リクエストを許可するのが既定だが、リバースプロキシや WAF で `OPTIONS` が止められていると「GitLab に接続できませんでした」になる。
その場合は画面の「CSV ダウンロードに切り替える」で、変更したファイルをダウンロードして GitLab の画面からアップロードする運用に切り替えられる（編集内容はそのまま）。恒常的に通らないなら `mode` を `"download"` にする。

**デモ（`mode: "demo"`）**: GitLab に接続せず、ブラウザ内の模擬で保存 → マージ待ち → マージの流れを試せる（試用版用。設定画面で「リーダーとして操作」を切り替えられる）。本番では使わない。

`memberSource.adapter` が `"none"` 以外（人事データから所属・役職を取り込む設定）のときは、メンバーの氏名・区分・役職・部署・課は読み取り専用になり、所属チームと適用開始月だけ編集できる。

## 年度が替わるとき

コード・設定の変更は要らない（年度は計算基準日から求める。SPEC §49）。データだけ足す。

- `data/holidays.csv` に新しい年の祝日・会社休日を足す。足していない年は国民の祝日だけで計算し、データ確認に「祝日表に無い年」が出る。
- 新年度の契約を `data/contracts.csv` に別行で足し、リソース計画で新年度の配分を入れる（リソース計画の年度は ◀ ▶ で切り替える）。

## 実績の種類を追加する

現在は工数 × 単価（`labor`）だけです。外注費・ライセンス費などを追加する場合:

1. `config.json` の `costTypes` に `{ "id": "outsourcing", "label": "外注費" }` を追加
2. その種類の月次金額を求めるロジックを計算コア（`src/core/cost.ts`）に足し、`ContractMonth.costs[id]` に入れる
   （入力データが必要なら `docs/DATA.md` に CSV を定義し、`src/core/csv.ts` と `scripts/lib/load.ts` で読む）
3. 画面は `costs` の全キーを表示するので、追加の変更は不要（合計 `cost` は自動で合算）
