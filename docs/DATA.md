# データファイル定義

すべて UTF-8（BOM可）の CSV。1行目ヘッダ。列名は下記のとおり（順不同、余分な列は無視）。
年月は `YYYY-MM`、日付は `YYYY-MM-DD`、金額は円の整数、時間は小数可。

| ファイル | 列 |
|---|---|
| `data/contracts.csv` | `contract_id, customer_name, project_name, team_id, start_month, end_month, total_amount, note` |
| `data/mapping.csv` | `worklog_customer_name, worklog_project_name, contract_id` （案件名が空 = その顧客の全工数） |
| `data/assignments.csv` | `member_id, contract_id, start_month, end_month, allocation` （人 × 契約 × 期間の配分人月。画面は稼働計画 `/plan`。途中で人月が変わるときは期間を分けた行になる。SPEC §36.3） |
| `data/outside-plans.csv` | `member_id, start_month, end_month, person_months, note` （契約外予定 = 提案・運用設計など保守の契約外で使う見込みの人月。省略可・note 省略可。同じ人の同じ月に重なる行はエラー。予算・着地見込みには入らない。SPEC §36.4） |
| `data/masters/teams.csv` | `team_id, name, parent_team_id, effective_from, level, leader_member_id` （level = 種別「課」「チーム」「班」など自由入力・省略可、leader_member_id = リーダーのメンバーID・省略可。SPEC §21・§22） |
| `data/masters/members.csv` | `member_id, name, kind, title, department, section, team_id, effective_from, status` （kind = employee / partner。status = 空（在籍）/ `退職`（その月から退職）、列ごと省略可。SPEC §35） |
| `data/masters/rates.csv` | `key, hourly_rate, effective_from` （key = 役職名 または member_id） |
| `data/holidays.csv` | `date, name` |
| `data/task-types.csv` | `task, category, note` （作業種別の分類表。category = 契約内 / 契約外。ファイルが無ければすべて契約内。SPEC §30） |
| `data/worklogs/*.csv` | `date, member_id, member_name, customer_name, project_name, task, hours` （月ごとに `YYYY-MM.csv`。アダプタが生成） |
| `data/worklogs/_meta.json` | `{ "fetchedAt": "ISO 8601", "adapter": "csv|http|dummy" }` |

`config.json` の項目は `src/core/types.ts` の `Config` を参照。

## 取り込み元の設定（config.json の `worklogSource.http` と `memberSource`）

コードを変えずに本番 API の列名・形式へ合わせるための設定。手順は [OPERATIONS.md](OPERATIONS.md)「本番 API への合わせ方」。トークンは環境変数だけ（`WORKLOG_API_TOKEN`、メンバーは `MEMBER_API_TOKEN`）。

### `worklogSource.http`

| 項目 | 意味 | 既定 |
|---|---|---|
| `url` | 取得 URL。`{from}` `{to}`（`YYYY-MM`）、`{fromDate}` `{toDate}`（`YYYY-MM-DD`、月初・月末）を置換 | 必須 |
| `authHeader` / `authScheme` | トークンを載せるヘッダ名 / 値の接頭辞 | `Authorization` / `Bearer`（他のヘッダ名なら接頭辞なし） |
| `method` | `GET` / `POST` | `GET` |
| `dataPath` | JSON 応答で配列が入っているキー（`data.items`） | 応答全体が配列 |
| `columns.<項目>` | 取得元の列名。`member.id` で入れ子、`["a","b"]` で複数候補（最初に値があるもの）。項目: `date, memberId, memberName, customerName, projectName, task, hours` | 必須 |
| `dateFormat` | `YYYY-MM-DD` / `YYYY/MM/DD` / `YYYYMMDD` / `ISO8601`（JST に変換） / `epochMillis` | 自動判定 |
| `hoursUnit` | `hours` / `minutes` / `seconds` | `hours` |
| `pagination` | `{type:"none"}` / `{type:"page", pageParam, sizeParam, size, startPage}` / `{type:"offset", offsetParam, limitParam, limit}` / `{type:"link"}` / `{type:"cursor", cursorPath, cursorParam}`。どれも `maxPages`（既定 1000）を付けられる | `none` |
| `query` | 追加のクエリ文字列（固定値）。`{from}` `{to}` `{fromDate}` `{toDate}` を置換 | なし |
| `filters` | 取り込まない行の条件 `[{ "column": "state", "notEquals": "cancelled" }]`（`equals` / `notEquals` / `in`。すべてに合う行だけ取り込む） | なし |
| `encoding` | CSV 応答の文字コード `auto` / `utf-8` / `shift_jis` | `auto` |
| `refetchMonths` | 直近何か月を取り直すか | 3 |

### `memberSource`（所属・役職の取り込み）

| 項目 | 意味 |
|---|---|
| `adapter` | `none`（既定。members.csv は手入力）/ `csv`（人事の CSV を置く）/ `http` |
| `csv.path`, `csv.encoding` | `adapter: "csv"` の CSV のパス（リポジトリ相対）と文字コード |
| `http` | `adapter: "http"` の接続設定（`url, authHeader, authScheme, method, dataPath, pagination, query, encoding`。`worklogSource.http` と同じ） |
| `columns` | 取り込み項目の取得元の列名。`memberId`, `name` は必須。`kind, title, department, section` は省略可（省略した項目は取り込まず現在の値を引き継ぐ）。入れ子・複数候補は上と同じ |
| `kindMap` | 区分値の読み替え。例 `{ "正社員": "employee", "委託": "partner" }` |
| `filters` | 取り込まない行の条件（退職者の除外など）。csv・http 共通 |

`npm run fetch:members` で `data/masters/members.csv` を更新する。`team_id` は取り込まない。変化した人だけ `effective_from = 実行月` の行を追加（`team_id` は引き継ぎ）、取り込み元に無い人は削除しない。何度流しても同じ結果。
