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
| `PROJECT_FETCH_ENABLED` | 任意。`1` でスケジュール実行時に `fetch-projects` ジョブ（正式な案件の一覧の取り込み。SPEC §98）も動く（既定は無効）。1 回だけ動かすときは Run pipeline で変数 `PROJECT_FETCH=1` |
| `PROJECT_API_TOKEN` | 任意。案件管理システム API のトークン（`projectSource.adapter = http`）。Protected・Masked にする |
| `GIT_PUSH_TOKEN` | スケジュール実行の取り込み結果を MR にして自動マージするための Project Access Token（**Maintainer** / `write_repository`。Protected・Masked。`main` は直接プッシュ不可のため MR を通す。SPEC §39.4） |
| `NPM_CONFIG_REGISTRY` | 任意。社内 npm ミラーの URL（依存込みのパッケージで作ったプロジェクトは不要。[DEPLOY_GITLAB.md](DEPLOY_GITLAB.md) 手順 0） |
| `NODE_IMAGE` | 任意。Node のイメージ（既定 `node:22`）。Docker Hub に出られないときは社内レジストリのもの |
| `YOJITSU_RUN_TESTS` | 任意。`1` で `test` ジョブ（型チェック・運用のテスト）も動く。既定は動かさない（[テストを Windows で動かす](#テストを-windows-で動かすrunnerpc)） |
| `VITEST_MAX_FORKS` | 任意（テストを動かすときだけ）。テストを同時に動かす数（既定 Windows 2・Linux は CPU の数 - 1）。Windows の Runner では `1` でないと安定しない環境がある。[テストを Windows で動かす](#テストを-windows-で動かすrunnerpc) |
| `NODE_EXTRA_CA_CERTS`・`NODE_USE_SYSTEM_CA` | 任意。社内の証明書で `npm ci` などが `SELF_SIGNED_CERT_IN_CHAIN` になるとき。どちらを使うかは [DEPLOY_GITLAB.md](DEPLOY_GITLAB.md#社内の証明書) |
| `YOJITSU_TEST_TIMEOUT_SCALE` | 任意（テストを動かすときだけ）。テストのタイムアウトの倍率（既定 Windows 3・Linux 1） |

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
         "customerName": "client", "projectName": "project", "task": "task", "hours": "hours",
         "taskCode": "task_code"
       }
     }
   }
   ```

   - `{from}` `{to}` は `YYYY-MM` に置換されます
   - `columns` は「予実ナビの項目名 → 取得元の列名」。`taskCode`（作業コード）は省略可（SPEC §92）
   - 任意項目: `dataPath`（JSON で配列が入っているキー。`"data.items"` のようにドット区切り）、
     `authScheme`（既定は `Authorization` ヘッダのとき `Bearer`、他のヘッダ名なら接頭辞なし）、`method`
   - 応答は `Content-Type` が JSON なら配列、`text/csv` なら CSV として読みます
   - 5xx とネットワークエラーは 3 回まで再試行、4xx は即失敗
2. CI/CD 変数 `WORKLOG_API_TOKEN` と `GIT_PUSH_TOKEN` を Protected・Masked で登録（トークンは config.json に書かない。ログにも出ません）
3. ローカルで確認: `WORKLOG_API_TOKEN=... npm run fetch && npm run validate`
4. スケジュールを登録（取り込み結果は `data/worklogs-<日時>` の MR になり、パイプラインの成功後に自動でマージされます）

`refetchMonths` か月分を毎回取り直すので、締め後の修正入力も反映されます。それより前の月は触りません。
取り込みが失敗した日も、画面の「今日」（月の状態・今月・残り営業日など）は開いた人の今日（日本時間）で進みます。実績は「作業実績の取得」の日時までで、前日より前のままなら警告色になります（SPEC §75）。本番のビルドでは `YOJITSU_AS_OF` を指定しないでください。
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
     - 件数のパラメータを受け付けない API（付けると 400）: `sizeParam`（offset なら `limitParam`）を書かない
     - 空配列が返るまで取る API: `stopWhen: "empty"`（既定の `short` は `size` 未満の行数で終わる）
     - 例: ページ番号だけで空配列まで取る `{ "type": "page", "pageParam": "page", "stopWhen": "empty" }`
   - 取り消し行などを除く: `filters`、固定の絞り込み: `query`、Shift_JIS の CSV: `encoding`
   - 社員番号を指定しないと返さない API: `members`（下の「取得する人をメンバーマスタから決める」）
3. **もう一度 dry-run で確認する**: 「列の対応表」の各項目が `[使う列: …]` になり、先頭 N 行の日付・時間・名前が想定どおりなら完了。
   問題なければ `npm run fetch && npm run validate` で実際に書き込む。

### 取得する人をメンバーマスタから決める（SPEC §87）

**本番の標準の取り方です**（SPEC §96）: 取得する人をメンバーマスタの在籍者から作り、50 人ずつに分けて取ります。社員番号を指定して取る API では、`worklogSource.http.members` を設定します。社員番号は **メンバーマスタ（`data/masters/members.csv`）だけ** で管理し、API の設定には書きません。

```json
"members": { "param": "member_ids", "chunkSize": 50 }
```

- 対象: 取得する期間に 1 か月でも在籍している人（期間の最初の月に不在になった人も含む）。社員・パートナー、所属チームなし（ヘルプ）も含む
- `chunkSize` 人ずつまとめて 1 回で取り、全員分を順に取ります（`member_ids=M001,M002,…`）。1 人ずつ渡す API は `"style": "repeat"`（`member_ids=M001&member_ids=M002`）。URL の途中に入れるなら `url`・`query` に `{members}`
- 新しい人は、メンバーマスタに登録すれば次の取り込みから対象になります

**過去の実績を取り直す（退職・異動した人を含む）**

| やりたいこと | コマンド（GitLab では Run pipeline の変数） |
|---|---|
| 期間を全員分で取り直す（その期間の在籍者が自動で対象。今は退職・異動した人も入る） | `npm run fetch -- --from 2025-04 --to 2025-09`（`FETCH_FROM`・`FETCH_TO`） |
| 特定の人の行だけ取り直す（ほかの人の行は残す。マスタに無い人も指定できる） | `npm run fetch -- --from 2025-04 --to 2025-09 --members M050,M051`（＋`FETCH_MEMBERS`） |

年月は例です。GitLab では Build > Pipelines > Run pipeline で対象ブランチ `main`、変数に `FETCH_FROM` などを入れて実行すると、`fetch-worklogs` ジョブが取り直して MR にします。これらの変数は CI/CD 変数（Settings）には登録しないでください（毎日の取り込みが同じ期間になります）。

**作業名から案件名を抜き出して紐付ける（SPEC §97）**: `config.json` の `projectFromTask.marker` に運用保守の目印を書くと、作業名の最初の目印より前を案件名とし、`contracts.csv` の `project_name` と完全一致する案件へ紐付けます（`mapping.csv` に作業コードを書かなくてよい）。案件名が無いものはデータ確認の「未紐付けの作業実績」に理由「未登録の案件」で出ます。案件を足すか、表記の違いだけなら `data/project-aliases.csv`（`alias,project_name`）に別名を足してください。似た名前に自動で割り当てることはしません。

**作業コードの点検（SPEC §92）**: `config.json` の `taskCodeCheck.include` に運用保守の作業名のキーワード（例 `_保守対応`）を書くと、キーワードに合うのに `mapping.csv` に無い作業コードと、作業名の変更をデータ確認画面に出します。`onUnregistered` / `onChange` を `stop` にすると、見つかったときに取り込みを失敗にします（月ファイルは書き換えない）。

| 止まったとき | 直し方 |
|---|---|
| 未登録の作業コード | 案件を確かめ、`mapping.csv` に `task_code` の行を足す（契約の更新なら新しい契約IDの行を足し、`start_month`・`end_month` で分ける。旧契約の行は消さない） |
| 作業名の変更 | 運用保守かどうかを確かめ、`npm run fetch -- --accept-task-changes`（GitLab では Run pipeline の変数 `FETCH_ACCEPT_TASK_CHANGES=1`）で 1 回取り込む。CI/CD 変数（Settings）には登録しない（毎回素通りになる） |

**途中で失敗したとき**: どこか 1 回でも失敗すると、月ファイル（人事の取り込みなら members.csv）は 1 つも書き換えません。失敗の日時と理由はデータ確認画面の「データの検証」に警告で出ます（作業実績の取得日時は前回成功のまま）。次に成功すると消えます。

ページングは、上限ページ数（`maxPages`、既定 5000）と、同じカーソル・同じページの繰り返しの検出で無限ループしません。上限を超えたらエラーで止め、ファイルは書き換えません（データ確認画面の「データの検証」に警告が出ます。SPEC §87）。
トークンはログにも例外メッセージにも出ません（環境変数のみ）。

### 取り込む期間の 3 とおり（SPEC §96）

| いつ | 取る期間 | コマンド | GitLab |
|---|---|---|---|
| 通常（毎日） | 今月を含む直近 `refetchMonths` か月（既定 3。前月の締め後の訂正も拾う） | `npm run fetch` | スケジュール実行（変数なし） |
| 初回の導入 | 今年度の初め（`fiscalYearStartMonth`、既定 4 月）から今月まで | `npm run fetch -- --initial` | Run pipeline で変数 `FETCH_MODE` = `initial` |
| 必要なとき | 好きな期間（過去の年度も。人を絞ることもできる） | `npm run fetch -- --from YYYY-MM --to YYYY-MM`（`--members` も可） | Run pipeline で変数 `FETCH_FROM`・`FETCH_TO`（`FETCH_MEMBERS`） |

- どれも取得する人は、その期間に在籍していた人（メンバーマスタから。上の「取得する人をメンバーマスタから決める」）。期間の月のファイルを全員分で書き直します
- `--initial` と `--from` / `--to` は一緒に使えません。年度の途中で導入したときは、初回に `--initial`、前の年度が要れば `--from`・`--to` で足します
- `FETCH_MODE`・`FETCH_FROM` などは Run pipeline でだけ入れ、CI/CD 変数（Settings）には登録しません（毎日の取り込みが同じ期間になります）

### 氏名・役職を人事データから取り込む（任意）

既定（`memberSource.adapter = "none"`）では `data/masters/members.csv` を手で編集します。
人事の元データがあるときは `memberSource` を設定すると、`npm run fetch:members` で更新できます。

```bash
# 人事の CSV を置く運用: data/hr/members.csv に置いて adapter を csv にする
npm run fetch:members -- --dry-run --sample=5   # 対応表と変更内容だけ表示（書かない）
npm run fetch:members                           # members.csv を更新
```

- 変わった人（名前・区分・役職・部・課）だけ、実行月の `effective_from` で新しい行を追加します（`team_id` は引き継ぎ。チームは画面で設定）
- 取り込み元に無い人は削除も不在扱いもしません（過去月を壊さないため）。退職・休職などで不在になる人は、マスタ編集の「在籍」を「不在」にするか、`status` に何か書いた行（`退職` など、理由は問わない）を足して表します（SPEC §35）。不在の人が取り込み元に載っていても在籍には戻しません（休職中の人も載るため）。復帰は台帳で在籍の行を足します。何度流しても同じ結果です
- 人事 API のときは `adapter: "http"`、環境変数 `MEMBER_API_TOKEN`
- CI で毎日実行するには、スケジュールを登録して CI/CD 変数 `MEMBER_FETCH_ENABLED=1` を設定します（既定は無効）

### 正式な案件の一覧を取り込む（任意。SPEC §98）

案件の顧客名・案件名を、手で推測して入れる代わりに案件管理システムの正式な値にそろえます。期間・金額（`total_amount`）・担当チームは今までどおり `data/contracts.csv` の手入力が正です。

- 設定は `config.json` の `projectSource`（[DATA.md](DATA.md#projectsource正式な案件の一覧の取り込みspec-98)）。ページングに対応しない API は `pagination` を書かない（1 回で全件）。サーバー側で絞れない条件は `filters` で取得後に絞る。API のときは環境変数 `PROJECT_API_TOKEN`
- `npm run fetch:projects` で `data/projects.csv`（正式な案件の一覧）を置き換え、`contracts.csv` の `project_id` のある行の顧客名・案件名を一覧の値にします。`project_id` の無い行は保留のまま（推測で入れません）
- データ確認画面の「正式な案件IDの無い案件」（候補 = 案件名が同じ正式な案件）と「マスタに無い正式な案件」（新しい案件の見落とし）で差分を確かめ、`contracts.csv` に `project_id` を入れる・行を足す。担当チーム（`team_id`）は空のまま入れてよく、後でマスタ編集の「案件」か CSV で設定します
- CI で毎日実行するには、スケジュールを登録して CI/CD 変数 `PROJECT_FETCH_ENABLED=1` を設定します（既定は無効）。1 回だけなら Run pipeline で `PROJECT_FETCH=1`

**今までのデータから移すとき**（初回だけ。結果は MR の差分で確かめる）:

```bash
npm run fetch:projects -- --dry-run --sample=5                          # 列の対応表と、取り込まれる案件の先頭 5 件
npm run fetch:projects -- --dry-run --id-from-note "案件ID:(\S+)"        # メモ（note）に書いていた ID を project_id に移す（かっこの中を取り出し、メモから消す）
npm run fetch:projects -- --dry-run --link-exact                         # 案件名が 1 件だけ同じ正式な案件の ID を入れる（複数あれば入れずに一覧に出す）
npm run fetch:projects -- --id-from-note "案件ID:(\S+)" --link-exact      # 確かめたら書き込む
```

`contracts.csv` に `project_id` の列が無ければ `contract_id` の次に足します。正規表現はメモの書き方に合わせて変えてください（PowerShell では `'案件ID:(\S+)'` のように単引用符で囲む）。

## マスタ編集の設定（GitLab へのマージ方式）

`/masters`（`data/masters/members.csv`・`rates.csv`・`teams.csv`、案件 `data/contracts.csv`（期間・金額・担当チームだけ）、目標 `data/targets.csv`、祝日 `data/holidays.csv`）と `/plan`（`data/assignments.csv`・`data/outside-plans.csv`）は、CSV を画面で編集する画面です（SPEC §19・§24〜§26・§36）。保存は 2 つの画面で共通で、両方の変更が 1 つの MR に入ります。
表で 1 行ずつ直すほか、「CSV で編集」に切り替えてファイルの中身をまとめて書き換える・Excel から貼り付けることもできます。
編集後のデータはブラウザ内で `npm run validate` と同じ検証にかけ、エラーがあれば保存できません。

流れ: 画面で編集 → 保存すると GitLab に **ブランチと MR** ができる → リーダーが画面上部の「マージ待ちの変更」で内容を見て **マージ** → CI がビルドし直して反映。
開いている MR の件数はヘッダー右端の「⋯」（その他。開くとマスタ編集の横にも）にバッジで出ます。トークンの登録・表示モード・テーマカラーは右上の歯車（設定画面 `/settings`）にまとめています。

```jsonc
"masterEdit": {
  "mode": "gitlab",                // 既定。"download"（CSV をダウンロードしてアップロード）| "demo"（試用。GitLab に接続しない）
  "gitlab": {
    "apiBaseUrl": "",              // 例 https://gitlab.example.local/api/v4（空の間は download で動く）
    "projectId": "",               // 数値ID または "group/yojitsu-navi"
    "targetBranch": "main",
    "commitMode": "mr",            // "mr"（ブランチ masters/<日時>-<ユーザー> にコミットして MR）| "direct"（非推奨）
    "tokenUrl": ""                 // 設定画面の「トークンを作成」の開く先。空 = 標準の場所、"/…" = GitLab 上のパス、"https://…" = そのまま（SPEC §78）
  }
}
```

1. 接続先: 社内 GitLab の CI でビルドすると、`apiBaseUrl`・`projectId` が空ならそのプロジェクト（`CI_API_V4_URL`・`CI_PROJECT_PATH`）が自動で入る（SPEC §39.1）。別のプロジェクトに保存したいときだけ値を入れる。ローカルのビルドで両方空なら CSV ダウンロードになる。
2. 各自が設定画面（右上の歯車）の「トークンを作成 ↗」で GitLab の作成画面を開き（名前と scope `api` は入力済み）、Personal Access Token を作って同じ画面で登録する。開く先が社内の GitLab と合わない（古い版で 404 など）ときは `tokenUrl` に正しいパス（例 `/-/profile/personal_access_tokens`）を入れる。マスタ編集・リソース計画の保存欄には入力欄を置かず、未登録なら「設定へ」のリンクが出る。
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

メンバーの社員番号・氏名は人事から取り込むため、登録済みの人では読み取り専用（CSV で編集も無し。SPEC §81）。`memberSource.adapter` が `"none"` 以外のときは、`memberSource.columns` に書いた列（既定は区分・役職）も読み取り専用。所属（事業本部・部・課）は既定では取り込まないので画面で直す。

## テストを Windows で動かす（Runner・PC）

社内のパイプラインでは、テスト（`test` ジョブ）は既定で動きません（SPEC §79.2）。テストはアプリ本体が壊れていないかの確認で、パッケージの公開前に済ませています。社内で変わるのはデータと `config.json` だけで、それは `build`（データ検証とビルド）と取り込みのジョブで確かめます。
社内の Runner や PC でも確かめたいとき（版を上げた直後など）は、CI/CD 変数 `YOJITSU_RUN_TESTS=1` を登録するか、Run pipeline で入れて実行します。PC では `npm run test` です。

社内のプロジェクトに入っているテストは、運用に要るもの（作業実績・人事の取り込み、データ検証、CI のスクリプト）だけです（SPEC §93。Linux で数秒）。どれも本番の `config.json`・`data/` を使わず、設定はテストの中、データは `tests/fixtures/` のテスト専用のものを使うので、本番の設定・データに入れ替えても結果は変わりません。計算・画面・パッケージの組み立て・ダミーデータ・ファズ・プロパティ・性能・E2E のテストは開発元のリポジトリだけにあり、公開前に済ませています。

Windows は Linux よりプロセスの起動とファイルの読み書きが遅く（ウイルス対策の検査も入る）、同じテストでも時間がかかります。次の設定は既定で Windows に合わせてあり、ふつうは何も登録しなくて構いません（SPEC §79.1）。

| 設定 | 既定 | 内容 |
|---|---|---|
| `VITEST_MAX_FORKS` | Windows `2`・Linux は CPU の数 - 1。「`[vitest-worker]: Timeout calling …`」が出る・結果が回ごとに変わるなら `1` を登録（導入先の Windows の Runner に、`2` では安定せず `1` で安定した環境があった） | 同時に動かすテストファイルの数（`vitest.config.ts` が読み、Windows の既定を 2 にしている）。Vitest 4 の `VITEST_MAX_WORKERS` と同じ（どちらで登録しても効く。両方あれば `VITEST_MAX_WORKERS`） |
| `YOJITSU_TEST_TIMEOUT_SCALE` | Windows `3`・Linux `1`。それでもタイムアウトするなら `5` | テストのタイムアウトの倍率（`vitest.config.ts` と結合テストの個別の値に掛かる） |

- Windows の Runner では、まず `VITEST_MAX_FORKS=1` で動かすのが確実です。運用のテストは 10 ファイルだけなので、1 つずつ動かしても長くはかかりません。
- GitLab では Settings > CI/CD > Variables に登録します。PC の Git Bash では `VITEST_MAX_FORKS=1 npm run test` のように前に付けます（`npm run test -- --maxWorkers=1` でも同じ）。
- ワーカーの方式は `forks` に固定しています（`vitest.config.ts`）。`threads` に変えないでください。
- テストを CI から外すために `vitest.config.ts` などを社内で変えていたら、新しい版の `update` で止まります。除外は要らなくなったので `--overwrite` で新しい版にしてください（[DEPLOY_GITLAB.md](DEPLOY_GITLAB.md#社内で変えたファイルがあるとき)）。

Git Bash の注意:

- 先頭が `/` の引数は Windows のパスに書き換えられます（例 `--project /grp/proj`）。`grp/proj` のように `/` で始めないか、`MSYS_NO_PATHCONV=1` を前に付けます。
- 改行は `.gitattributes` で LF に固定しているので、`core.autocrlf` は既定のままで構いません。
- 社内のルールで許されるなら、作業フォルダと一時フォルダ（`%TEMP%`）をウイルス対策のリアルタイム検査から外すと大きく速くなります（任意）。

開発元のリポジトリの性能テスト（`tests/unit/perf.test.ts`・`members.perf.test.ts` など。社内のプロジェクトには入っていない）は、作業実績 5 万件の計算などに目安の時間（例 2 秒）があり、実行する環境で判定を変えます。

| `YOJITSU_PERF` | 判定 | 使う場面 |
|---|---|---|
| 未設定（`loose`） | 目安の 3 倍（`YOJITSU_PERF_FACTOR` で変更）を超えたら失敗。超えたら 3 回まで測り直し、最も速い値で判定 | 開発の PC・GitHub Actions |
| `report` | 失敗にしない。かかった時間を表示するだけ | 性能がばらつく CI の Runner |
| `strict` | 目安どおりで判定 | 性能の劣化を確かめるとき（いつも同じ PC で動かして比べる） |

性能の劣化は、`report` の表示（`[性能] …ms`）を前回と比べるか、同じ PC で `YOJITSU_PERF=strict npm run test -- tests/unit/perf.test.ts` を動かして確かめます。

## 年度が替わるとき

コード・設定の変更は要らない（年度は計算基準日から求める。SPEC §49）。データだけ足す。

- `data/holidays.csv` に新しい年の祝日・会社休日を足す。足していない年は国民の祝日だけで計算し、データ確認に「祝日表に無い年」が出る。
- 新年度の契約を `data/contracts.csv` に別の行（新しい案件ID）として足し（顧客名・案件名は他システムから取り込む予定。それまでは GitLab の画面で編集。期間・金額・担当チームはマスタ編集の「案件」で直せる）、リソース計画で新年度の配分を入れる（リソース計画の表示する月は、表の上の開始月〜終了月で選ぶ）。

## 実績の種類を追加する

現在は工数 × 単価（`labor`）だけです。外注費・ライセンス費などを追加する場合:

1. `config.json` の `costTypes` に `{ "id": "outsourcing", "label": "外注費" }` を追加
2. その種類の月次金額を求めるロジックを計算コア（`src/core/cost.ts`）に足し、`ContractMonth.costs[id]` に入れる
   （入力データが必要なら `docs/DATA.md` に CSV を定義し、`src/core/csv.ts` と `scripts/lib/load.ts` で読む）
3. 画面は `costs` の全キーを表示するので、追加の変更は不要（合計 `cost` は自動で合算）
