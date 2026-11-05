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
import { pageHeader, sectionTitle, emptyState, loadJson, note, loadModel } from "./components/layout.js";
import { statTile, kpiRow, statusChip } from "./components/kpi.js";
import { dataTable } from "./components/table.js";
import { formatHours, integer, dateTimeJst, monthJa, WARNING_LABELS, UNMAPPED_REASON_LABELS } from "./components/format.js";
```

```js
const model = await loadModel(FileAttachment("./data/model.json"), { skeleton: "page-skeleton" });
const issuesData = await loadJson(FileAttachment("./data/dataset-issues.json"));
```

```js
if (model) {
  display(
    pageHeader({
      model,
      title: T.app.pages.dataCheck,
      lead: T.dataCheck.lead,
      breadcrumbs: [{ label: T.app.pages.dataCheck }], // 全体サマリーの配下ではない（§69）
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
        statTile({ label: T.dataCheck.fetchedAt, value: model.meta.worklogFetchedAt ? dateTimeJst(model.meta.worklogFetchedAt) : T.layout.notFetched, sub: fmt(T.dataCheck.fetchedAtSub, { asOf: model.meta.asOf, lastFinal: monthJa(model.meta.lastFinalMonth) }), wrap: true }),
        statTile({ label: T.dataCheck.unmappedHours, value: formatHours(summary.unmappedHours), sub: fmt(T.dataCheck.groups, { n: model.unmapped.length }), status: summary.unmappedHours > 0 ? { kind: "warn", text: T.dataCheck.notInCost } : { kind: "ok", text: T.common.none } }),
        statTile({ label: T.dataCheck.rateMissing, value: fmt(T.breakdown.count, { n: integer(summary.rateMissing.length) }), sub: fmt(T.dataCheck.rateMissingSub, { hours: formatHours(summary.rateMissing.reduce((s, w) => s + (w.hours ?? 0), 0)) }), status: summary.rateMissing.length > 0 ? { kind: "warn", text: T.dataCheck.checkRates } : { kind: "ok", text: T.common.none } }),
        statTile({ label: T.dataCheck.excludedHours, value: formatHours(model.excludedHours), sub: T.dataCheck.excludedSub, status: model.excludedHours > 0 ? { kind: "neutral", text: T.dataCheck.notAggregated } : { kind: "ok", text: T.common.none } }),
        statTile({ label: T.dataCheck.validation, value: summary.errors > 0 ? fmt(T.dataCheck.errorCount, { n: summary.errors }) : T.dataCheck.noErrors, sub: summary.warnings === null ? T.dataCheck.validationLoadFailed : fmt(T.dataCheck.warningCount, { n: summary.warnings }), status: summary.errors > 0 ? { kind: "danger", text: T.dataCheck.blocksPublish } : { kind: "ok", text: T.dataCheck.publishable } }),
      ],
      { columns: 5 },
    ),
  );
}
```

```js
if (model) {
  display(sectionTitle(T.dataCheck.unmappedTitle, T.dataCheck.unmappedHint));
  const rows = model.unmapped.map((g, i) => ({ key: i, ...g, reasonLabel: UNMAPPED_REASON_LABELS[g.reason] ?? g.reason }));
  if (rows.length === 0) display(emptyState({ title: T.dataCheck.unmappedEmpty, icon: "✓" }));
  else
    display(
      dataTable({
        columns: [
          { key: "customerName", label: T.dataCheck.colWorklogCustomer, type: "text", empty: T.dataCheck.empty },
          { key: "projectName", label: T.dataCheck.colWorklogProject, type: "text", empty: T.dataCheck.empty },
          // 作業コードの行（§92）で探した未紐付けがあるときだけ
          ...(rows.some((r) => r.taskCode !== undefined) ? [{ key: "taskCode", label: T.dataCheck.colTaskCode, type: "text", empty: T.dataCheck.empty }] : []),
          { key: "reasonLabel", label: T.dataCheck.colReason, type: "text" },
          { key: "hours", label: T.columns.hours, type: "hours" },
          { key: "count", label: T.dataCheck.colCount, type: "int" },
          { key: "firstDate", label: T.dataCheck.colFirstDate, type: "text" },
          { key: "lastDate", label: T.dataCheck.colLastDate, type: "text" },
        ],
        rows,
        caption: T.dataCheck.unmappedTitle,
        exportName: "unmapped_worklogs",
        sort: { key: "hours", dir: "desc" },
      }),
    );
}
```

```js
// 作業名のキーワード（§62.3）。キーワードを使っていない・すべて合致したときは出さない
if (model && (model.keywordUnmatched ?? []).length > 0) {
  display(sectionTitle(T.dataCheck.keywordTitle, T.dataCheck.keywordHint));
  display(
    dataTable({
      columns: [
        { key: "customerName", label: T.dataCheck.colWorklogCustomer, type: "text" },
        { key: "projectName", label: T.dataCheck.colWorklogProject, type: "text", empty: T.dataCheck.empty },
        { key: "task", label: T.dataCheck.colTask, type: "text", empty: T.dataCheck.empty },
        { key: "type", label: T.dataCheck.colType, type: "text" },
        { key: "hours", label: T.columns.hours, type: "hours" },
        { key: "count", label: T.dataCheck.colCount, type: "int" },
        { key: "lastDate", label: T.dataCheck.colLastDate, type: "text", hideOnPhone: true },
      ],
      rows: model.keywordUnmatched.map((g, i) => ({ key: i, ...g })),
      caption: T.dataCheck.keywordTitle,
      exportName: "keyword_unmatched",
      sort: { key: "hours", dir: "desc" },
    }),
  );
}
```

```js
// 作業コードの点検（§92）。点検の設定が無い・見つからないときは出さない
if (model && (model.unregisteredTaskCodes ?? []).length > 0) {
  display(sectionTitle(T.dataCheck.taskCodeTitle, T.dataCheck.taskCodeHint));
  display(
    dataTable({
      columns: [
        { key: "taskCode", label: T.dataCheck.colTaskCode, type: "text" },
        { key: "task", label: T.dataCheck.colTask, type: "text", empty: T.dataCheck.empty },
        { key: "customerName", label: T.dataCheck.colWorklogCustomer, type: "text", empty: T.dataCheck.empty, hideOnPhone: true },
        { key: "statusLabel", label: T.dataCheck.colStatus, type: "text" },
        { key: "hours", label: T.columns.hours, type: "hours" },
        { key: "count", label: T.dataCheck.colCount, type: "int", hideOnPhone: true },
        { key: "firstDate", label: T.dataCheck.colFirstDate, type: "text", hideOnPhone: true },
        { key: "lastDate", label: T.dataCheck.colLastDate, type: "text" },
      ],
      rows: model.unregisteredTaskCodes.map((g, i) => ({ key: i, ...g, statusLabel: g.status === "none" ? T.dataCheck.statusNone : T.dataCheck.statusPeriod })),
      caption: T.dataCheck.taskCodeTitle,
      exportName: "unregistered_task_codes",
      sort: { key: "hours", dir: "desc" },
    }),
  );
}
if (model && (model.taskCodeChanges ?? []).length > 0) {
  display(sectionTitle(T.dataCheck.taskCodeChangesTitle, T.dataCheck.taskCodeChangesHint));
  const matchLabel = (c) => (c.matchBefore === null || c.matchAfter === null || c.matchBefore === c.matchAfter ? T.dataCheck.matchKept : c.matchAfter ? T.dataCheck.matchGained : T.dataCheck.matchLost);
  display(
    dataTable({
      columns: [
        { key: "taskCode", label: T.dataCheck.colTaskCode, type: "text" },
        { key: "before", label: T.dataCheck.colBefore, type: "text", empty: T.dataCheck.empty },
        { key: "after", label: T.dataCheck.colAfter, type: "text", empty: T.dataCheck.empty },
        { key: "changedOn", label: T.dataCheck.colChangedOn, type: "text" },
        ...(model.taskCodeChanges.some((c) => c.matchBefore !== null) ? [{ key: "matchLabel", label: T.dataCheck.colMatch, type: "text" }] : []),
      ],
      rows: model.taskCodeChanges.map((c, i) => ({ key: i, ...c, matchLabel: matchLabel(c) })),
      caption: T.dataCheck.taskCodeChangesTitle,
      exportName: "task_code_changes",
      sort: { key: "changedOn", dir: "desc" },
    }),
  );
}
```

```js
// 正式な案件の一覧（案件管理システム）との照合（§98）。一覧を取り込んでいない・見つからないときは出さない
const projectCheck = issuesData?.projects;
if (model && projectCheck?.enabled && projectCheck.unlinked.length > 0) {
  display(sectionTitle(T.dataCheck.unlinkedContractsTitle, T.dataCheck.unlinkedContractsHint));
  display(
    dataTable({
      columns: [
        { key: "contractId", label: T.dataCheck.colContractId, type: "text" },
        { key: "customerName", label: T.dataCheck.colCustomer, type: "text", hideOnPhone: true },
        { key: "projectName", label: T.dataCheck.colProject, type: "text" },
        { key: "period", label: T.dataCheck.colPeriod, type: "text", hideOnPhone: true },
        { key: "candidateText", label: T.dataCheck.colCandidates, type: "text", empty: T.dataCheck.noCandidate },
      ],
      rows: projectCheck.unlinked.map((c, i) => ({ key: i, ...c, period: `${c.startMonth}〜${c.endMonth}`, candidateText: c.candidates.join(", ") })),
      caption: T.dataCheck.unlinkedContractsTitle,
      exportName: "contracts_without_project_id",
      sort: { key: "contractId", dir: "asc" },
    }),
  );
}
if (model && projectCheck?.enabled && projectCheck.unregistered.length > 0) {
  display(sectionTitle(T.dataCheck.unregisteredProjectsTitle, T.dataCheck.unregisteredProjectsHint));
  display(
    dataTable({
      columns: [
        { key: "projectId", label: T.dataCheck.colProjectId, type: "text" },
        { key: "customerName", label: T.dataCheck.colCustomer, type: "text" },
        { key: "projectName", label: T.dataCheck.colProject, type: "text" },
      ],
      rows: projectCheck.unregistered.map((p, i) => ({ key: i, ...p })),
      caption: T.dataCheck.unregisteredProjectsTitle,
      exportName: "projects_without_contract",
      sort: { key: "projectId", dir: "asc" },
    }),
  );
}
```

```js
if (model) {
  display(sectionTitle(T.dataCheck.rateMissingTitle, T.dataCheck.rateMissingHint));
  const rows = model.warnings
    .filter((w) => w.code === "RATE_MISSING")
    .map((w, i) => ({ key: i, memberId: w.ref?.memberId ?? "", memberName: model.members.find((m) => m.memberId === w.ref?.memberId)?.name ?? "", month: w.ref?.month ?? "", hours: w.hours ?? 0, message: w.message }));
  if (rows.length === 0) display(emptyState({ title: T.dataCheck.rateMissingEmpty, icon: "✓" }));
  else
    display(
      dataTable({
        columns: [
          { key: "memberId", label: T.members.colMemberId, type: "text" },
          { key: "memberName", label: T.dataCheck.colName, type: "text" },
          { key: "month", label: T.charts.colMonth, type: "text", render: (r) => monthJa(r.month), exportValue: (r) => r.month },
          { key: "hours", label: T.columns.hours, type: "hours" },
        ],
        rows,
        caption: T.dataCheck.rateMissingTitle,
        exportName: "rate_missing",
        sort: { key: "month", dir: "desc" },
      }),
    );
}
```

```js
if (model) {
  display(sectionTitle(T.dataCheck.unknownTitle, T.dataCheck.unknownHint));
  const rows = model.warnings.filter((w) => w.code === "UNKNOWN_MEMBER").map((w, i) => ({ key: i, memberId: w.ref?.memberId ?? "", hours: w.hours ?? 0, count: w.count ?? 0, message: w.message }));
  if (rows.length === 0) display(emptyState({ title: T.dataCheck.unknownEmpty, icon: "✓" }));
  else
    display(
      dataTable({
        columns: [
          { key: "memberId", label: T.members.colMemberId, type: "text" },
          { key: "hours", label: T.columns.hours, type: "hours" },
          { key: "count", label: T.breakdown.costLineCount, type: "int" },
          { key: "message", label: T.dataCheck.colMessage, type: "text" },
        ],
        rows,
        caption: T.dataCheck.unknownCaption,
        exportName: "unknown_members",
      }),
    );
}
```

```js
if (model) {
  display(sectionTitle(T.dataCheck.excludedTitle, T.dataCheck.excludedHint));
  const w = model.warnings.find((x) => x.code === "EXCLUDED_NO_CUSTOMER");
  display(html`<p class="yn-fact-line">${T.dataCheck.excludedTotal} <strong class="num">${formatHours(model.excludedHours)}</strong>${w?.count ? fmt(T.dataCheck.excludedCount, { n: integer(w.count) }) : null}${w?.message ? html`<span class="yn-muted"> — ${w.message}</span>` : null}</p>`);
}
```

```js
if (model) {
  display(sectionTitle(T.dataCheck.warningsTitle, T.dataCheck.warningsHint));
  const rows = model.warnings.map((w, i) => ({ key: i, code: w.code, label: WARNING_LABELS[w.code] ?? w.code, message: w.message, hours: w.hours ?? null, count: w.count ?? null, ref: w.ref ? Object.entries(w.ref).map(([k, v]) => `${k}=${v}`).join(" ") : "" }));
  if (rows.length === 0) display(emptyState({ title: T.dataCheck.warningsEmpty, icon: "✓" }));
  else
    display(
      dataTable({
        columns: [
          { key: "label", label: T.dataCheck.colKind, type: "text", sortValue: (r) => r.code },
          { key: "message", label: T.dataCheck.colMessage, type: "text" },
          { key: "hours", label: T.columns.hours, type: "hours" },
          { key: "count", label: T.dataCheck.colCount, type: "int" },
          { key: "ref", label: T.dataCheck.colRef, type: "text", hideOnPhone: true },
        ],
        rows,
        caption: T.dataCheck.warningsCaption,
        exportName: "warnings",
        maxHeight: 520,
      }),
    );
}
```

```js
if (model) {
  display(sectionTitle(T.dataCheck.issuesTitle, T.dataCheck.issuesHint));
  if (!issuesData) display(note(T.dataCheck.issuesLoadFailed, "danger"));
  else {
    const rows = issuesData.issues.map((i, k) => ({ key: k, severity: i.severity, severityChip: i.severity === "error" ? { kind: "danger", text: T.dataCheck.severityError } : { kind: "warn", text: T.dataCheck.severityWarning }, code: i.code, file: i.file ?? "", row: i.row ?? null, message: i.message }));
    if (rows.length === 0) display(emptyState({ title: T.dataCheck.issuesEmpty, icon: "✓" }));
    else
      display(
        dataTable({
          columns: [
            { key: "severityChip", label: T.dataCheck.colSeverity, type: "status", sortValue: (r) => (r.severity === "error" ? 0 : 1) },
            { key: "code", label: T.dataCheck.colCode, type: "text" },
            { key: "file", label: T.dataCheck.colFile, type: "text" },
            { key: "row", label: T.dataCheck.colRow, type: "int" },
            { key: "message", label: T.dataCheck.colMessage, type: "text" },
          ],
          rows,
          caption: T.dataCheck.issuesCaption,
          exportName: "validation_issues",
          sort: { key: "severityChip", dir: "asc" },
          maxHeight: 520,
        }),
      );
  }
}
```
