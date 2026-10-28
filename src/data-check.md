---
title: データ確認
---

<div id="page-skeleton" class="yn-skeleton" aria-busy="true" aria-label="読み込み中">
  <div class="yn-skel-line yn-skel-title"></div>
  <div class="yn-skel-line"></div>
  <div class="yn-skel-grid"><div></div><div></div><div></div><div></div></div>
  <div class="yn-skel-block"></div>
</div>

```js
import { html } from "htl";
import { T, fmt } from "./i18n/index.js";
import { pageHeader, sectionTitle, emptyState, loadJson, note } from "./components/layout.js";
import { statTile, kpiRow, statusChip } from "./components/kpi.js";
import { dataTable } from "./components/table.js";
import { formatHours, integer, dateTimeJst, monthJa, WARNING_LABELS, UNMAPPED_REASON_LABELS } from "./components/format.js";
```

```js
const model = await loadJson(FileAttachment("./data/model.json"), { skeleton: "page-skeleton" });
const issuesData = await loadJson(FileAttachment("./data/dataset-issues.json"));
```

```js
if (model) {
  display(
    pageHeader({
      model,
      title: "データ確認",
      lead: "原価に乗らなかった作業実績と、マスタの不備を確認する画面です。ここに出る項目は数値の精度に影響します。データの直し方は README の「データファイルの編集ルール」を参照してください。",
      breadcrumbs: [{ label: "全体サマリー", href: "./" }, { label: "データ確認" }],
    }),
  );
}
```

```js
const summary = (() => {
  if (!model) return null;
  const unmappedHours = model.unmapped.reduce((s, g) => s + g.hours, 0);
  const rateMissing = model.warnings.filter((w) => w.code === "RATE_MISSING");
  const unknownMembers = model.warnings.filter((w) => w.code === "UNKNOWN_MEMBER");
  const errors = issuesData?.summary?.errors ?? 0;
  const warnings = issuesData?.summary?.warnings ?? null;
  return { unmappedHours, rateMissing, unknownMembers, errors, warnings };
})();
```

```js
if (summary) {
  display(
    kpiRow(
      [
        statTile({ label: "作業実績の最終取得", value: model.meta.worklogFetchedAt ? dateTimeJst(model.meta.worklogFetchedAt) : "未取得", sub: `計算基準日 ${model.meta.asOf} ・ 確定済み ${monthJa(model.meta.lastFinalMonth)} まで`, wrap: true }),
        statTile({ label: "未紐付けの作業時間", value: formatHours(summary.unmappedHours), sub: `${model.unmapped.length} グループ`, status: summary.unmappedHours > 0 ? { kind: "warn", text: "原価に含まれていません" } : { kind: "ok", text: "なし" } }),
        statTile({ label: "単価のない作業（メンバー×月）", value: `${integer(summary.rateMissing.length)}件`, sub: `${formatHours(summary.rateMissing.reduce((s, w) => s + (w.hours ?? 0), 0))} を 0 円で計算`, status: summary.rateMissing.length > 0 ? { kind: "warn", text: "単価表を確認" } : { kind: "ok", text: "なし" } }),
        statTile({ label: "除外した作業時間（顧客名なし）", value: formatHours(model.excludedHours), sub: "顧客名が空の作業実績", status: model.excludedHours > 0 ? { kind: "neutral", text: "集計対象外" } : { kind: "ok", text: "なし" } }),
        statTile({ label: "データ検証", value: summary.errors > 0 ? `エラー ${summary.errors}件` : "エラーなし", sub: summary.warnings === null ? "検証結果を読み込めませんでした" : `警告 ${summary.warnings}件`, status: summary.errors > 0 ? { kind: "danger", text: "CI で公開が止まります" } : { kind: "ok", text: "公開可能" } }),
      ],
      { columns: 5 },
    ),
  );
}
```

```js
if (model) {
  display(sectionTitle("未紐付けの作業実績", "紐付けルールが無い、または契約期間に入らない作業実績。(顧客名, 案件名) ごとにまとめています。mapping.csv にルールを足すか、契約期間を確認してください。"));
  const rows = model.unmapped.map((g, i) => ({ key: i, ...g, reasonLabel: UNMAPPED_REASON_LABELS[g.reason] ?? g.reason }));
  if (rows.length === 0) display(emptyState({ title: "未紐付けの作業実績はありません", icon: "✓" }));
  else
    display(
      dataTable({
        columns: [
          { key: "customerName", label: "顧客名（作業実績側）", type: "text", empty: "（空）" },
          { key: "projectName", label: "案件名（作業実績側）", type: "text", empty: "（空）" },
          { key: "reasonLabel", label: "理由", type: "text" },
          { key: "hours", label: "時間", type: "hours" },
          { key: "count", label: "件数", type: "int" },
          { key: "firstDate", label: "最初の日", type: "text" },
          { key: "lastDate", label: "最後の日", type: "text" },
        ],
        rows,
        caption: "未紐付けの作業実績",
        exportName: "unmapped_worklogs",
        sort: { key: "hours", dir: "desc" },
      }),
    );
}
```

```js
if (model) {
  display(sectionTitle("単価のないメンバー", "役職にも個人にも単価が無く、0 円で計算した作業（メンバー × 月）。rates.csv に役職またはメンバーIDの行を追加してください。"));
  const rows = model.warnings
    .filter((w) => w.code === "RATE_MISSING")
    .map((w, i) => ({ key: i, memberId: w.ref?.memberId ?? "", memberName: model.members.find((m) => m.memberId === w.ref?.memberId)?.name ?? "", month: w.ref?.month ?? "", hours: w.hours ?? 0, message: w.message }));
  if (rows.length === 0) display(emptyState({ title: "単価のないメンバーはいません", icon: "✓" }));
  else
    display(
      dataTable({
        columns: [
          { key: "memberId", label: "メンバーID", type: "text" },
          { key: "memberName", label: "名前", type: "text" },
          { key: "month", label: "月", type: "text", render: (r) => monthJa(r.month), exportValue: (r) => r.month },
          { key: "hours", label: "時間", type: "hours" },
        ],
        rows,
        caption: "単価のないメンバー",
        exportName: "rate_missing",
        sort: { key: "month", dir: "desc" },
      }),
    );
}
```

```js
if (model) {
  display(sectionTitle("メンバーマスタに無いメンバー", "作業実績にだけ現れるメンバーID。members.csv に追加するか、作業実績側の ID を直してください。個人単価が無ければ 0 円で計算しています。"));
  const rows = model.warnings.filter((w) => w.code === "UNKNOWN_MEMBER").map((w, i) => ({ key: i, memberId: w.ref?.memberId ?? "", hours: w.hours ?? 0, count: w.count ?? 0, message: w.message }));
  if (rows.length === 0) display(emptyState({ title: "不明なメンバーはいません", icon: "✓" }));
  else
    display(
      dataTable({
        columns: [
          { key: "memberId", label: "メンバーID", type: "text" },
          { key: "hours", label: "時間", type: "hours" },
          { key: "count", label: "原価行の数", type: "int" },
          { key: "message", label: "内容", type: "text" },
        ],
        rows,
        caption: "不明なメンバー",
        exportName: "unknown_members",
      }),
    );
}
```

```js
if (model) {
  display(sectionTitle("除外した作業実績", "顧客名が空の作業実績は紐付けの対象外です（社内会議など）。"));
  const w = model.warnings.find((x) => x.code === "EXCLUDED_NO_CUSTOMER");
  display(html`<p class="yn-fact-line">合計 <strong class="num">${formatHours(model.excludedHours)}</strong>${w?.count ? html`（${integer(w.count)} 件）` : null}${w?.message ? html`<span class="yn-muted"> — ${w.message}</span>` : null}</p>`);
}
```

```js
if (model) {
  display(sectionTitle("計算時の警告（すべて）", "計算コアが出したすべての警告。種類ごとに件数を確認できます。"));
  const rows = model.warnings.map((w, i) => ({ key: i, code: w.code, label: WARNING_LABELS[w.code] ?? w.code, message: w.message, hours: w.hours ?? null, count: w.count ?? null, ref: w.ref ? Object.entries(w.ref).map(([k, v]) => `${k}=${v}`).join(" ") : "" }));
  if (rows.length === 0) display(emptyState({ title: "警告はありません", icon: "✓" }));
  else
    display(
      dataTable({
        columns: [
          { key: "label", label: "種類", type: "text", sortValue: (r) => r.code },
          { key: "message", label: "内容", type: "text" },
          { key: "hours", label: "時間", type: "hours" },
          { key: "count", label: "件数", type: "int" },
          { key: "ref", label: "参照", type: "text", hideOnPhone: true },
        ],
        rows,
        caption: "計算時の警告",
        exportName: "warnings",
        maxHeight: 520,
      }),
    );
}
```

```js
if (model) {
  display(sectionTitle("データ検証の結果（validate-data）", "CSV の構造と内容の検証。エラーがあると CI で公開が止まります。警告は表示のみです。"));
  if (!issuesData) display(note("検証結果（data/dataset-issues.json）を読み込めませんでした。", "danger"));
  else {
    const rows = issuesData.issues.map((i, k) => ({ key: k, severity: i.severity, severityChip: i.severity === "error" ? { kind: "danger", text: "エラー" } : { kind: "warn", text: "警告" }, code: i.code, file: i.file ?? "", row: i.row ?? null, message: i.message }));
    if (rows.length === 0) display(emptyState({ title: "問題は見つかりませんでした", icon: "✓" }));
    else
      display(
        dataTable({
          columns: [
            { key: "severityChip", label: "重要度", type: "status", sortValue: (r) => (r.severity === "error" ? 0 : 1) },
            { key: "code", label: "コード", type: "text" },
            { key: "file", label: "ファイル", type: "text" },
            { key: "row", label: "行", type: "int" },
            { key: "message", label: "内容", type: "text" },
          ],
          rows,
          caption: "データ検証の結果",
          exportName: "validation_issues",
          sort: { key: "severityChip", dir: "asc" },
          maxHeight: 520,
        }),
      );
  }
}
```
