# データファイル定義

すべて UTF-8（BOM可）の CSV。1行目ヘッダ。列名は下記のとおり（順不同、余分な列は無視）。
年月は `YYYY-MM`、日付は `YYYY-MM-DD`、金額は円の整数、時間は小数可。

| ファイル | 列 |
|---|---|
| `data/contracts.csv` | `contract_id[, project_id], customer_name, project_name, team_id, start_month, end_month, total_amount, note[, updated_by, updated_at]` （updated_by・updated_at は assignments.csv と同じ（マスタ編集の「案件」で保存した人と保存日）。計算には使わない。project_id = 案件管理システムの正式な案件ID（省略可・空 = 未照合で保留。更新の前後の行は同じ ID でよい）。project_id のある行の顧客名・案件名は `npm run fetch:projects` が正式な案件の一覧の値に書き換える。期間・金額・担当チームは手入力が正（team_id は空でよい）。team_id が空なら customer-teams.csv の顧客の既定の担当チーム（SPEC §103.6）。登録済みの行でマスタ編集が直せるのは start_month・end_month・total_amount・team_id だけ（取り込みに無い案件はマスタ編集の「＋ 新しい案件」で足せる。SPEC §103.3）。SPEC §80・§98） |
| `data/projects.csv` | `project_id, customer_name, project_name` （案件管理システムの正式な案件の一覧。省略可。`npm run fetch:projects` が取り込んだ一覧で置き換える（手で直さない）。あるときだけ contracts.csv と照合し、データ確認に「正式な案件IDの無い案件」「マスタに無い正式な案件」を出す。SPEC §98） |
| `data/mapping.csv` | `worklog_customer_name, worklog_project_name, contract_id[, task_include, task_exclude, task_code, start_month, end_month]` （案件名が空 = その顧客の全工数。task_code = 作業コード（書いた行は顧客名・案件名・キーワードを使わずコードで紐付ける。空の顧客名・案件名でよい）、start_month / end_month = その行を使う期間（作業日の月。片方だけ・省略可。省略 = 全期間）。同じ作業コードを契約の更新後も使うときは、新しい契約IDの行を足して期間で分ける（SPEC §92）。task_include / task_exclude = 作業名に含む／含むと除くキーワード、`\|` 区切りで複数、省略可。指定した案件では合致した作業だけが運用保守、合致しない作業は運用保守以外。SPEC §62。紐付けの判定の順序と契約の更新のときの書き方は SPEC §86） |
| `data/assignments.csv` | `member_id, contract_id, start_month, end_month, allocation[, updated_by, updated_at]` （人 × 契約 × 期間の配分人月。updated_by・updated_at は保存した人の GitLab ユーザー名と保存日（YYYY-MM-DD）。画面が保存時に追加・変更した行へ書く。列なし・空欄 = 記録なし。SPEC §56。画面はリソース計画 `/plan`。途中で人月が変わるときは期間を分けた行になる。SPEC §36.3） |
| `data/outside-plans.csv` | `member_id, type, start_month, end_month, person_months, note[, updated_by, updated_at]` （運用保守以外の予定 = 提案・設計・会社業務など運用保守以外で使う見込みの人月。省略可。type = 運用保守以外の種別（task-types.csv の group。空・列なし = 種別なし）、note 省略可。updated_by・updated_at は assignments.csv と同じ。同じ人・同じ種別の同じ月に重なる行はエラー、一覧に無い種別は警告。予算・着地見込みには入らない。メンバー別で「運用保守以外を含む」にしたときの計画に入る。SPEC §36.4・§50） |
| `data/project-aliases.csv` | `alias, project_name` （案件名の別名。省略可。作業名から抜き出した案件名 `alias` を contracts.csv の `project_name` として扱う。config.json の `projectFromTask` を使うときだけ。同じ別名が複数の案件名を指すとエラー、案件名と同じ別名・contracts.csv に無い案件名は警告。SPEC §97） |
| `data/targets.csv` | `target_type, target_id, end_month, remaining_rate, start_month, note[, updated_by, updated_at]` （目標。省略可。target_type = `team` / `customer` / `project`、target_id = チームID / 顧客名 / 契約ID、end_month = 終了月、remaining_rate = 目標の残予算率（%。`20` = 20%、100 以下。超過を減らす目標はマイナス `-50`（`▲50` も可））、start_month = 開始月（空 = 終了月を含む年度の最初の月）、note 省略可。updated_by・updated_at は assignments.csv と同じ（保存した人と保存日。一覧の対象名の下に出す）。同じ対象・同じ終了月の重複はエラー、見つからない対象は警告。数値の計算には使わない。画面はマスタ編集の「目標」。SPEC §63） |
| `data/masters/teams.csv` | `team_id, name, parent_team_id, effective_from, level, leader_member_id` （level = 種別「課」「チーム」「班」など自由入力・省略可、leader_member_id = リーダーの社員番号・省略可。SPEC §21・§22） |
| `data/masters/members.csv` | `member_id, name, kind, title, division, department, section, team_id, effective_from, status` （所属は division = 事業本部・department = 部・section = 課の 3 段。division は列ごと省略可（SPEC §60）。kind = employee / partner。status = 空（在籍）/ それ以外は何でも不在（`退職`・`休職` など、理由は問わない。その月から不在。その月に計画か実績があればその月までは稼働）、列ごと省略可。SPEC §35） |
| `data/masters/rates.csv` | `key, hourly_rate, effective_from[, provisional]` （key = 役職名 または member_id。provisional = 動作確認用の仮の値なら `1`（`true`・`yes`・`仮` も可）、空・列なし = 本番の値。計算には使い、データ確認の「未設定・仮の値」とマスタ編集の「仮の単価」で分かるようにする。列が無ければ、マスタ編集で仮にした行を保存するときに足す。SPEC §103.5） |
| `data/customer-teams.csv` | `customer_name, team_id, note[, updated_by, updated_at]` （顧客の既定の担当チーム。省略可。contracts.csv の team_id が空の案件は、顧客名（正規化して完全一致）のこのチームとして集計する。案件に書いた team_id が優先。顧客名の空・重複・存在しないチームはエラー、案件の無い顧客は確認要求。画面はマスタ編集の「顧客」。SPEC §103.6） |
| `data/holidays.csv` | `date, name` （祝日・会社休日。行の無い年は国民の祝日を計算で補い、データ確認に `HOLIDAYS_AUTO` を出す。全体が空なら祝日なし。SPEC §49） |
| `data/task-types.csv` | `task, category, group[, match], note` （match = 空なら完全一致、`含む` なら作業名に task を含めば該当（完全一致が先、次にファイルの順）。作業種別の分類表。category = 運用保守 / 運用保守以外（旧表記の 契約内 / 契約外 も可）。group = 運用保守以外の種別（計画の単位。省略可、空なら task と同じ）。ファイルが無ければすべて運用保守。運用保守以外は顧客名が空でも数える。SPEC §30・§50） |
| `data/worklogs/*.csv` | `date, member_id, member_name, customer_name, project_name, task, hours[, task_code]` （月ごとに `YYYY-MM.csv`。アダプタが生成。task_code = 作業コード。その月に作業コードのある行があるときだけ付く。SPEC §92） |
| `data/worklogs/_meta.json` | `{ "fetchedAt": "ISO 8601", "adapter": "csv|http|dummy" }`。取得に失敗したときだけ `lastFailure: { at, message }`（SPEC §87） |
| `data/masters/_members-meta.json` | 人事の取り込みに失敗したときだけできる `{ "lastFailure": { at, message } }`。次に成功すると消える（SPEC §87） |
| `data/_projects-meta.json` | 正式な案件の一覧の取り込みに失敗したときだけできる `{ "lastFailure": { at, message } }`。次に成功すると消える（SPEC §98） |

`config.json` の項目は `src/core/types.ts` の `Config` を参照。

`config.json` が今の版で動くかは `npm run config:check`（`npm run validate`・`yojitsu-navi upgrade`・`update` も同じ確かめをする。SPEC §96）で確かめる。必須の項目が無い・型や値が違うとエラー（CI の build が止まる）、この版で使わない項目・廃止された項目は注意（止めない）。`_` で始まる項目（`"_comment"` など）はメモとして見ない。開発元で項目を足す・変えるときは `scripts/lib/config-schema.mjs` も直す。

`taskCodeCheck`（作業コードの点検。省略 = 点検しない。SPEC §92）: `include`（運用保守の作業名に含むキーワード）、`exclude`（含むと対象外）、`onUnregistered`（未登録の作業コードを見つけたとき `warn` = 警告だけ・既定 / `stop` = 取り込みを失敗にする）、`onChange`（作業名の変更・キーワードの一致の変化を見つけたとき。`warn` / `stop`。`stop` で止まったら確かめて `FETCH_ACCEPT_TASK_CHANGES=1` で取り込む）。

`taskFromName`（作業名の括弧内をタスクにする。省略 = 使わない。SPEC §101）: `markers`（目印の配列。省略すると `projectFromTask.marker`）、`enabled`（`false` で止める。既定 `true`）。目印の直後の括弧内を作業種別の内訳のタスクにする。括弧が無い・期間の表記だけなら「タスク分類なし」（時間は運用保守として数え、未分類の警告にしない）。括弧内が task-types.csv に無くても未分類にしない。

`projectFromTask`（作業名から案件名を抜き出して紐付ける。省略 = 使わない。SPEC §97）: `marker`（運用保守の目印。作業名の最初の目印より前を案件名とし、contracts.csv の `project_name` と完全一致する案件へ紐付ける。全角半角・空白は区別しない）、`enabled`（`false` で止める。既定 `true`）。mapping.csv の行がある作業はそちらが先。目印も mapping.csv の行も無い作業は運用保守以外。表記揺れは `data/project-aliases.csv` に別名を登録する（曖昧一致はしない）。

## 取り込み元の設定（config.json の `worklogSource.http`・`memberSource`・`projectSource`）

コードを変えずに本番 API の列名・形式へ合わせるための設定。手順は [OPERATIONS.md](OPERATIONS.md)「本番 API への合わせ方」。トークンは環境変数だけ（`WORKLOG_API_TOKEN`、メンバーは `MEMBER_API_TOKEN`、正式な案件の一覧は `PROJECT_API_TOKEN`）。

### `worklogSource.http`

| 項目 | 意味 | 既定 |
|---|---|---|
| `url` | 取得 URL。`{from}` `{to}`（`YYYY-MM`）、`{fromDate}` `{toDate}`（`YYYY-MM-DD`、月初・月末）を置換 | 必須 |
| `authHeader` / `authScheme` | トークンを載せるヘッダ名 / 値の接頭辞 | `Authorization` / `Bearer`（他のヘッダ名なら接頭辞なし） |
| `method` | `GET` / `POST` | `GET` |
| `dataPath` | JSON 応答で配列が入っているキー（`data.items`） | 応答全体が配列 |
| `columns.<項目>` | 取得元の列名。`member.id` で入れ子、`["a","b"]` で複数候補（最初に値があるもの）。項目: `date, memberId, memberName, customerName, projectName, task, hours`（必須）、`taskCode`（作業コード。省略可。設定すると応答のどれか 1 行にその列が要る。SPEC §92） | 必須 |
| `dateFormat` | `YYYY-MM-DD` / `YYYY/MM/DD` / `YYYYMMDD` / `ISO8601`（JST に変換） / `epochMillis` | 自動判定 |
| `hoursUnit` | `hours` / `minutes` / `seconds` | `hours` |
| `pagination` | `{type:"none"}` / `{type:"page", pageParam, sizeParam, size, startPage, stopWhen}` / `{type:"offset", offsetParam, limitParam, limit, stopWhen}` / `{type:"link"}` / `{type:"cursor", cursorPath, cursorParam}`。どれも `maxPages`（既定 5000）を付けられる。`page` / `offset` は `sizeParam` / `limitParam` を省くと件数のパラメータを付けない。`stopWhen` は `short`（既定。`size` / `limit` 未満の行数で終了）か `empty`（0 行で終了。`size` / `limit` は件数を付けるときだけ必要）。例: ページ番号だけの API は `{type:"page", pageParam:"page", stopWhen:"empty"}` | `none` |
| `query` | 追加のクエリ文字列（固定値）。`{from}` `{to}` `{fromDate}` `{toDate}` を置換 | なし |
| `filters` | 取り込まない行の条件 `[{ "column": "state", "notEquals": "cancelled" }]`（`equals` / `notEquals` / `in`。すべてに合う行だけ取り込む） | なし |
| `encoding` | CSV 応答の文字コード `auto` / `utf-8` / `shift_jis` | `auto` |
| `refetchMonths` | 直近何か月を取り直すか | 3 |
| `members` | 取得対象の社員番号を API に渡す（SPEC §87）。`param`（パラメータ名）、`style`（`join` = `param=A,B` / `repeat` = `param=A&param=B`）、`separator`（既定 `,`）、`chunkSize`（1 回の人数、既定 50）。`url`・`query` に `{members}` と書けばそこに入る。社員番号はメンバーマスタの在籍者から作るので設定には書かない | なし（渡さない） |

### `memberSource`（所属・役職の取り込み）

| 項目 | 意味 |
|---|---|
| `adapter` | `none`（既定。members.csv は手入力）/ `csv`（人事の CSV を置く）/ `http` |
| `csv.path`, `csv.encoding` | `adapter: "csv"` の CSV のパス（リポジトリ相対）と文字コード |
| `http` | `adapter: "http"` の接続設定（`url, authHeader, authScheme, method, dataPath, pagination, query, encoding`。`worklogSource.http` と同じ） |
| `columns` | 取り込み項目の取得元の列名。`memberId`, `name` は必須。`kind, title, division, department, section` は省略可（省略した項目は取り込まず現在の値を引き継ぐ）。既定は所属（`division, department, section`）を書かない＝所属は画面で直す（SPEC §81）。書いた列はマスタ編集で読み取り専用になる。入れ子・複数候補は上と同じ |
| `kindMap` | 区分値の読み替え。例 `{ "正社員": "employee", "委託": "partner" }` |
| `filters` | 取り込まない行の条件（退職者の除外など）。csv・http 共通 |

取り込みに失敗したときは CSV を書き換えず、失敗だけを `data/worklogs/_meta.json`（作業実績）・`data/masters/_members-meta.json`（人事）の `lastFailure` に書く。データ確認画面に警告で出て、次に成功すると消える（SPEC §87）。

`npm run fetch:members` で `data/masters/members.csv` を更新する。`team_id` は取り込まない。運用保守の案件をスポットで手伝う他部署（導入・設計・構築など）の人も取り込み対象に含める（`filters` で外さない）と、役職単価で実績に入り、`team_id` 空のまま「ヘルプ」として区別される（SPEC §72）。マスタに無い人の作業は単価 0 円で、データ確認に `UNKNOWN_MEMBER` が出る。変化した人だけ `effective_from = 実行月` の行を追加（`team_id` は引き継ぎ）、取り込み元に無い人は削除しない。何度流しても同じ結果。

### `projectSource`（正式な案件の一覧の取り込み。SPEC §98）

| 項目 | 意味 |
|---|---|
| `adapter` | `none`（既定。取り込まない）/ `csv`（書き出した CSV を置く）/ `http` |
| `csv.path`, `csv.encoding` | `adapter: "csv"` の CSV のパスと文字コード |
| `http` | `adapter: "http"` の接続設定（`url, authHeader, authScheme, method, dataPath, pagination, query, encoding`。`worklogSource.http` と同じ）。`pagination` を書かなければページングなし（1 回で全件。ページングに対応しない API 向け） |
| `columns` | `projectId`（正式な案件ID）・`customerName`・`projectName` の取得元の列名。3 つとも必須。入れ子・複数候補は上と同じ |
| `filters` | 取得した後で取り込む案件を絞る条件（すべてに合う行だけ）。サーバー側で絞り込めない API で、案件の種類・状態などで絞る。例 `[{ "column": "category", "equals": "保守" }, { "column": "active", "in": [1, "1", true] }]` |

`npm run fetch:projects` で `data/projects.csv` を置き換え、`project_id` のある契約の `customer_name`・`project_name` だけを一覧の値にする（期間・金額・担当チーム・メモは触らない。行は増やさない・消さない）。0 件・失敗のときはどちらのファイルも書き換えない。`--dry-run --sample=5` で列の対応表と変更内容だけを出す。移行用に `--id-from-note "<正規表現>"`（メモに書いていた案件 ID を project_id に移す）と `--link-exact`（案件名が 1 件だけ同じ案件の ID を入れる）がある（[OPERATIONS.md](OPERATIONS.md)「正式な案件の一覧を取り込む」）。

