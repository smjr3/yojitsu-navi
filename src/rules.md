---
title: 計算ルール
---

```js
import { html } from "htl";
import { pageHeader, loadJson } from "./components/layout.js";
import { money, formatPercent, monthJa, METHOD_LABELS } from "./components/format.js";
```

```js
const model = await loadJson(FileAttachment("./data/model.json"));
const config = model?.config ?? {};
const meta = model?.meta ?? {};
const fyStart = config.fiscalYearStartMonth ?? 4;
const fyEnd = ((fyStart + 10) % 12) + 1;
const fy = meta.fiscalYear ?? new Date().getFullYear();
const thr = config.burnRateDangerThreshold ?? 1;
const closing = config.closingBusinessDay ?? 3;
const recentN = config.forecastRecentMonths ?? 3;
const stdHours = config.standardHoursPerMonth ?? 160;
const dayHours = config.hoursPerBusinessDay ?? 8;
const labels = config.labels ?? { customer: "顧客", project: "案件", contract: "契約", team: "チーム", member: "メンバー" };
const costTypes = (config.costTypes ?? []).map((t) => t.label).join("、") || "工数原価";
const asOf = meta.asOf ?? "—";
const asOfMonth = meta.asOfMonth ?? "—";
const lastFinal = meta.lastFinalMonth ?? "—";
```

```js
if (model) {
  display(
    pageHeader({
      model,
      title: "計算ルール",
      lead: "画面の数値がどう計算されているかの説明です。設定値（config.json）は現在の値に置き換えて表示しています。詳細な仕様は docs/SPEC.md を参照してください。",
      breadcrumbs: [{ label: "全体サマリー", href: "./" }, { label: "計算ルール" }],
    }),
  );
}
```

<div class="yn-prose">

## 1. 用語

| 用語 | 意味 |
|---|---|
| **予算** | ${labels.contract}の総額を${labels.contract}月数で均等割りした、月ごとの売上見込み |
| **原価** | 作業時間 × その月に有効な時間単価（${costTypes}） |
| **粗利** | 予算 − 原価。**粗利率** = 粗利 ÷ 予算 |
| **消化率** | 経過月の累計原価 ÷ 経過月の累計予算。**${formatPercent(thr, 0)} を超えると赤** |
| **着地見込み** | 年度末時点の原価と粗利の予測。${labels.contract}ごとに赤字／黒字を判定 |
| **年度** | ${fyStart}月始まり。FY${fy} = ${fy}年${fyStart}月〜${fyStart === 1 ? fy : fy + 1}年${fyEnd}月。年度番号は開始年 |
| **計算基準日** | 現在 **${asOf}**（基準月 ${monthJa(asOfMonth)}）。ビルド時の日付（環境変数 `YOJITSU_AS_OF` で固定可） |

## 2. 月の扱い

- 年月は `YYYY-MM`。${labels.contract}の月数は開始月と終了月の**両方を含む**数です（2026-04〜2027-03 は 12 か月）。
- 月の途中で始まる・終わる${labels.contract}も均等割りにします（日割りしません）。
- 開始月 > 終了月、または総額が負・数値でない${labels.contract}は計算から除外し、「データ確認」に警告を出します。0 円の${labels.contract}は有効（予算 0）です。
- ${labels.contract}ID が重複した場合は最初の行だけを使います。

## 3. 月次予算（契約額の月割り）

```
基本額   = floor(契約総額 ÷ 契約月数)
端数     = 契約総額 − 基本額 × 契約月数
月の予算 = 基本額（最終月だけ 基本額 + 端数）
```

全月の合計は必ず契約総額に一致します。例: 38,000,000 円 ÷ 12 か月 → 3,166,666 円 × 11 か月 + 3,166,674 円（最終月）。

## 4. 作業実績の紐付け（${labels.customer}名・${labels.project}名のマッピング）

作業実績の${labels.customer}名・${labels.project}名は、照合の前に**正規化**します。

1. Unicode NFKC（全角英数・半角カナを統一）
2. 前後の空白を除去し、連続する空白（全角含む）を 1 つの半角空白に
3. 小文字化
4. 法人格（株式会社・(株)・㈱・有限会社・合同会社・Inc.・Co., Ltd.・Ltd.・Corp.・LLC）を前後から除去

照合の手順:

1. ${labels.customer}名が空の作業実績は**除外**します（「データ確認」に合計時間を表示）。
2. `(${labels.customer}, ${labels.project})` の完全一致ルールを探し、無ければ `(${labels.customer}, 空)` のルール（その${labels.customer}の全工数）を探します。
3. ルールが指す${labels.contract}のうち、**作業日の月が${labels.contract}期間に入るもの**を選びます。更新${labels.contract}（同じ名前で別 ID）は作業日で自動的に振り分けられます。
4. 該当が 2 件以上なら ID 昇順で最初を採用し、警告を出します。該当が無ければ「期間外」として未紐付けになります。
5. ルール自体が無い作業実績は「ルールなし」として未紐付けになります。

未紐付けの作業実績は原価に含まれません。「データ確認」で `(${labels.customer}名, ${labels.project}名)` ごとの時間と件数を確認できます。

## 5. 履歴マスタ（${labels.team}・${labels.member}・単価）

${labels.team}・${labels.member}・単価は「適用開始月（effective_from）」付きの履歴です。**月 m に有効なレコード = 同じキーで適用開始月 ≤ m のうち最も新しいもの**。昇格・異動・単価改定は行を追加して表現し、過去月は当時の値で計算されます。

## 6. 時間単価の決め方

月 m の${labels.member} x の単価は次の順で決まります。

1. 単価表に **${labels.member}ID** のレコードがあればそれ（パートナー個人単価）
2. 無ければ、その月の${labels.member}マスタの**役職**で単価表を引く
3. どちらも無ければ **単価 0 円**として計算し、「単価なし」警告を出す（${labels.member}×月ごと）
4. ${labels.member}マスタに存在しない ID は 1 だけ試し、無ければ 0 円。「不明${labels.member}」警告を出す

## 7. 月次原価

```
${labels.member}ごとの原価 = round(その月の作業時間の合計 × 単価)   ← 円に四捨五入
月の原価            = Σ ${labels.member}ごとの原価
```

原価行には当時の所属${labels.team}を持たせるので、他${labels.team}からの応援も「どの${labels.team}の人がどれだけ作業したか」で追えます。日付が不正な作業実績、時間が 0 以下の作業実績は無視します。

## 8. 月の状態（確定・速報・未来）

| 状態 | 条件 |
|---|---|
| **未来（予定）** | 基準月より後の月 |
| **速報** | 基準月、または 基準月より前で **確定日** を迎えていない月 |
| **確定** | 確定日を過ぎた月 |

**確定日 = 翌月の第 ${closing} 営業日**（営業日 = 土日でも祝日・会社休日でもない日）。現在の確定済み最新月は **${monthJa(lastFinal)}** です。速報月を含む集計には「速報を含む」バッジが付きます。

## 9. 営業日と人月換算

- 営業日数 = その月の暦日から土日と祝日（holidays.csv）を除いた日数
- 人月（標準）= 作業時間 ÷ **${stdHours}h**
- 人月（カレンダー）= 作業時間 ÷ (営業日数 × **${dayHours}h**)。複数月は月ごとに計算して合算

## 10. 着地見込み（${labels.contract}ごと・FY${fy}）

```
年度内の契約月 = 年度の 12 か月 ∩ 契約期間
実績月         = 年度内の契約月のうち 基準月より前の月（速報を含む）
残り月         = 年度内の契約月のうち 基準月以降の月（基準月を含む）
年度予算       = Σ 年度内の契約月の予算
実績原価       = Σ 実績月の原価
着地原価       = 実績原価 + 残り原価
着地粗利       = 年度予算 − 着地原価   （マイナスなら「赤字見込み」）
```

残り原価の出し方（画面の「着地見込みの方式」で切替。既定は **${METHOD_LABELS[config.forecastMethodDefault ?? "recent3"]}**）:

| 方式 | 残り原価 |
|---|---|
| **${METHOD_LABELS.recent3}** | ${labels.contract}期間内で基準月より前の **直近 ${recentN} か月** の原価平均 × 残り月数（年度をまたいでよい。実績が ${recentN} か月未満ならある分で平均、0 か月なら 0） |
| **${METHOD_LABELS.all}** | ${labels.contract}開始月から基準月の前月までの全月の原価平均 × 残り月数 |
| **${METHOD_LABELS.assignment}** | Σ（残り月 × アサイン: 配分人月 × ${stdHours}h × その月の単価）。アサインが無ければ 0 |

年度に 1 か月も掛からない${labels.contract}は対象外（年度予算 0・判定なし）です。

## 11. 画面での集計

- 期間は両端を含みます。${labels.team}を選ぶと、その${labels.team}と**配下すべての${labels.team}**の${labels.contract}を合算します。
- 主担当${labels.team}が空・未知の${labels.contract}は「未設定」グループに入ります。
- ${labels.team}一覧は**期間の終了月時点の組織**で表示します（組織変更があった場合、過去の期間は当時の階層になります）。
- 消化率の「経過月」は期間内で基準月以前の月です。期間が未来だけなら消化率は計算できません（—）。
- 前年同期比は、経過月と同じ月を 1 年前にずらして比べます。1 年前の実績が無いときは「比較データなし」と表示します。

## 12. 金額と表示

- 金額は内部では常に円の整数。表示は **百万円（既定）/ 千円 / 円** を切替できます（百万円 = 円 ÷ 100万 を小数1桁に四捨五入、千円 = 円 ÷ 1000 を四捨五入）。計算根拠の値と Excel 出力は常に円です。
- 割合は小数 1 桁（例 103.4%）。時間は `147.75h`、日付は `2026-10-27`、月は `2026年10月`（URL と Excel では `2026-10`）。
- **赤い表示は「消化率 > ${formatPercent(thr, 0)}」と「着地が赤字」の 2 つだけ**です。黄色の警告はありません。赤は色だけでなく ▲ の印と文字でも示します。

## 13. 計算根拠

画面のすべての数値はクリックすると「式 ＋ 実際に使った値」が開きます。原価は ${labels.member}ごとの原価行から元の作業ログ（誰が・いつ・何を・何時間）まで辿れます。

## 14. データ検証

CI では次の問題があると公開を止めます: ${labels.contract}ID の重複・期間の逆転・金額の不正、存在しない${labels.contract}への紐付け、アサインの未知 ID・配分の範囲外（1 人の月合計 > 1.0）、${labels.team}の未知の親・循環、${labels.member}の未知の${labels.team}・区分の不正、単価の不正、日付・年月の形式不正。未紐付け工数や単価なしは警告として「データ確認」に表示し、公開は止めません。

## 15. ${labels.member}別（人ごとの予実）

${labels.member}ごとに、**計画（予）** と **実績（実）** を比べます。基準時間（1 人月）は現在 **${stdHours}h** です。

```
計画時間 = 配分人月 × 基準時間                       （契約・月ごと。同じ契約・月のアサインは配分を合計）
計画原価 = round(計画時間 × その月の時間単価)         （契約・月ごとに円に丸めて合計）
実績原価 = その人の原価行（作業時間 × その月の時間単価）（契約詳細の原価と同じ値）
差額     = 計画原価 − 実績原価                       （プラス = 計画より原価が少ない）
稼働率   = 実績時間 ÷ 計画時間                       （計画時間 0 なら —）
```

- 時間単価は「6. 時間単価の決め方」と同じ（個人単価 → その月の役職の単価）。単価改定・昇格の月から新しい単価になります。
- アサインは${labels.contract}期間内の月だけ数えます（期間外の月・除外された${labels.contract}への配分は計画 0）。
- アサインの無い${labels.contract}・月への作業（応援など）は「アサイン外」の時間として実績に含め、別に表示します。
- **比べるのは経過月（期間内で基準月 ${monthJa(asOfMonth)} 以前の月）だけ**です。未来の月は実績が無いため、期間全体の計画と比べると稼働率・差額がよく見えてしまうからです。期間全体の計画は注記と月次推移に出します。
- 所属${labels.team}・役職は各月の当時の値で計算し、一覧では期間の終了月（未来なら基準月）の値で表示・絞り込みします。
- メンバーマスタに無い ID でも作業実績があれば表示します（名前は作業ログの表記、個人単価が無ければ 0 円）。
- 稼働率が 100% を超えても、差額がマイナスでも**赤にはしません**（赤は消化率超過と赤字見込みだけ）。

</div>
