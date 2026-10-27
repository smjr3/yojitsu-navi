# データファイル定義

すべて UTF-8（BOM可）の CSV。1行目ヘッダ。列名は下記のとおり（順不同、余分な列は無視）。
年月は `YYYY-MM`、日付は `YYYY-MM-DD`、金額は円の整数、時間は小数可。

| ファイル | 列 |
|---|---|
| `data/contracts.csv` | `contract_id, customer_name, project_name, team_id, start_month, end_month, total_amount, note` |
| `data/mapping.csv` | `worklog_customer_name, worklog_project_name, contract_id` （案件名が空 = その顧客の全工数） |
| `data/assignments.csv` | `member_id, contract_id, start_month, end_month, allocation` |
| `data/masters/teams.csv` | `team_id, name, parent_team_id, effective_from` |
| `data/masters/members.csv` | `member_id, name, kind, title, department, section, team_id, effective_from` （kind = employee / partner） |
| `data/masters/rates.csv` | `key, hourly_rate, effective_from` （key = 役職名 または member_id） |
| `data/holidays.csv` | `date, name` |
| `data/worklogs/*.csv` | `date, member_id, member_name, customer_name, project_name, task, hours` （月ごとに `YYYY-MM.csv`。アダプタが生成） |
| `data/worklogs/_meta.json` | `{ "fetchedAt": "ISO 8601", "adapter": "csv|http|dummy" }` |

`config.json` の項目は `src/core/types.ts` の `Config` を参照。
