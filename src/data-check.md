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
import { pageHeader, emptyState, loadJson, note, loadModel } from "./components/layout.js";
import { foldSection, sectionToc } from "./components/fold-section.js";
import { statTile, kpiRow, statusChip } from "./components/kpi.js";
import { dataTable, PREVIEW_ROWS } from "./components/table.js";
import { formatHours, integer, dateTimeJst, monthJa, WARNING_LABELS, UNMAPPED_REASON_LABELS } from "./components/format.js";
import { groupedWorklogTable, peopleColumn } from "./components/worklog-people.js";
import { mastersHref, officialProjectLookup, registerContractHref, unlinkedByCandidate, contractListText } from "./components/register-links.js";
```

```js
const model = await loadModel(FileAttachment("./data/model.json"), { skeleton: "page-skeleton" });
const issuesData = await loadJson(FileAttachment("./data/dataset-issues.json"));
```

```js
// マスタ編集へ移る（§103）。「案件に登録」は分かっている値を入れた追加のダイアログ、ほかは該当の行を検索・絞り込んで開く
// 長い文（警告・検証の内容）は省略せず折り返す（§115）
const msgCell = (text) => html`<span class="yn-cell-msg">${text}</span>`;
const linkButton = (href, text, aria) => html`<a class="yn-btn yn-btn-sm yn-row-action" href=${href} aria-label=${aria}>${text}</a>`;
const officialByName = officialProjectLookup(issuesData?.officialProjects);
const registerHref = (row) => registerContractHref(row, officialByName);
// 正式な案件IDは名前で出す（顧客 / 案件名（ID））。一覧に無い ID はそのまま（§127）
const officialById = new Map((issuesData?.officialProjects ?? []).map((p) => [p.projectId, p]));
const officialLabel = (id) => {
  const p = officialById.get(id);
  return p ? `${[p.customerName, p.projectName].filter(Boolean).join(" / ")}（${id}）` : id;
};
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
  const unknownMembers = model.unknownMembers ?? [];
  const errors = issuesData?.summary?.errors ?? 0;
  const warnings = issuesData?.summary?.warnings ?? null;
  return { unmappedHours, rateMissing, unknownMembers, errors, warnings };
})();
```

```js
// 節の一覧（目次・見出しの件数。§127）。出さない節（設定が無い・該当なし）は null
const sections = (() => {
  if (!model) return null;
  const projectCheck = issuesData?.projects;
  const warnRows = model.warnings.filter((w) => w.code === "RATE_MISSING");
  const excluded = model.warnings.find((x) => x.code === "EXCLUDED_NO_CUSTOMER");
  const errors = issuesData?.summary?.errors ?? 0;
  const list = [
    { key: "unmapped", title: T.dataCheck.unmappedTitle, hint: T.dataCheck.unmappedHint, count: model.unmapped.filter((g) => g.reason !== "OUT_OF_PERIOD").length },
    { key: "outOfPeriod", title: T.dataCheck.outOfPeriodTitle, hint: T.dataCheck.outOfPeriodHint, count: model.unmapped.filter((g) => g.reason === "OUT_OF_PERIOD").length },
    (model.keywordUnmatched ?? []).length > 0 ? { key: "keyword", title: T.dataCheck.keywordTitle, hint: T.dataCheck.keywordHint, count: model.keywordUnmatched.length } : null,
    (model.unregisteredTaskCodes ?? []).length > 0 ? { key: "taskCode", title: T.dataCheck.taskCodeTitle, hint: T.dataCheck.taskCodeHint, count: model.unregisteredTaskCodes.length } : null,
    (model.taskCodeChanges ?? []).length > 0 ? { key: "taskCodeChanges", title: T.dataCheck.taskCodeChangesTitle, hint: T.dataCheck.taskCodeChangesHint, count: model.taskCodeChanges.length, tone: "neutral" } : null,
    projectCheck?.enabled && projectCheck.unlinked.length > 0 ? { key: "unlinkedContracts", title: T.dataCheck.unlinkedContractsTitle, hint: T.dataCheck.unlinkedContractsHint, count: projectCheck.unlinked.length } : null,
    projectCheck?.enabled && projectCheck.unregistered.length > 0 ? { key: "unregisteredProjects", title: T.dataCheck.unregisteredProjectsTitle, hint: T.dataCheck.unregisteredProjectsHint, count: projectCheck.unregistered.length } : null,
    issuesData ? { key: "unset", title: T.dataCheck.unsetTitle, hint: T.dataCheck.unsetHint, count: (issuesData.unset ?? []).length } : null,
    { key: "rateMissing", title: T.dataCheck.rateMissingTitle, hint: T.dataCheck.rateMissingHint, count: new Set(warnRows.map((w) => w.ref?.memberId ?? "")).size },
    { key: "unknown", title: T.dataCheck.unknownTitle, hint: T.dataCheck.unknownHint, count: (model.unknownMembers ?? []).length },
    { key: "excluded", title: T.dataCheck.excludedTitle, hint: T.dataCheck.excludedHint, count: model.excludedHours > 0 ? (excluded?.count ?? 1) : 0, tone: "neutral" },
    // 上の各項目と重なる一覧なので既定はたたむ
    { key: "warnings", title: T.dataCheck.warningsTitle, hint: T.dataCheck.warningsHint, count: model.warnings.length, tone: "neutral", defaultOpen: false },
    { key: "issues", title: T.dataCheck.issuesTitle, hint: T.dataCheck.issuesHint, count: issuesData ? issuesData.issues.length : null, tone: errors > 0 ? "danger" : "warn" },
  ].filter(Boolean);
  return new Map(list.map((x) => [x.key, { ...x, id: `dc-${x.key}`, tone: x.tone ?? "warn" }]));
})();
// 節を作る（見出しの開閉・件数）。本文は body に入れる
const openSection = (key) => {
  const meta = sections.get(key);
  return foldSection({ id: meta.id, title: meta.title, hint: meta.hint, count: meta.count, tone: meta.tone, defaultOpen: meta.defaultOpen ?? true });
};
// 表は先頭の PREVIEW_ROWS 行だけ出し、残りは「すべて表示」で（ページのスクロールが表に取られないように。§127）
```

```js
if (summary) {
  display(
    kpiRow(
      [
        statTile({ label: T.dataCheck.fetchedAt, value: model.meta.worklogFetchedAt ? dateTimeJst(model.meta.worklogFetchedAt) : T.layout.notFetched, sub: fmt(T.dataCheck.fetchedAtSub, { asOf: model.meta.asOf, lastFinal: monthJa(model.meta.lastFinalMonth) }), wrap: true }),
        statTile({ label: T.dataCheck.unmappedHours, value: formatHours(summary.unmappedHours), sub: fmt(T.dataCheck.groups, { n: model.unmapped.length }), status: summary.unmappedHours > 0 ? { kind: "warn", text: T.dataCheck.notInCost } : { kind: "ok", text: T.common.none } }),
        statTile({ label: T.dataCheck.rateMissing, value: fmt(T.breakdown.count, { n: integer(summary.rateMissing.length) }), sub: fmt(T.dataCheck.rateMissingSub, { hours: formatHours(summary.rateMissing.reduce((s, w) => s + (w.hours ?? 0), 0)) }), status: summary.rateMissing.length > 0 ? { kind: "warn", text: T.dataCheck.checkRates } : { kind: "ok", text: T.common.none } }),
        statTile({ label: T.dataCheck.unknownTile, value: fmt(T.dataCheck.peopleCount, { n: integer(summary.unknownMembers.length) }), sub: fmt(T.dataCheck.unknownTileSub, { hours: formatHours(summary.unknownMembers.reduce((s, u) => s + u.hours, 0)) }), status: summary.unknownMembers.length > 0 ? { kind: "warn", text: T.dataCheck.addToMembers } : { kind: "ok", text: T.common.none } }),
        statTile({ label: T.dataCheck.excludedHours, value: formatHours(model.excludedHours), sub: T.dataCheck.excludedSub, status: model.excludedHours > 0 ? { kind: "neutral", text: T.dataCheck.notAggregated } : { kind: "ok", text: T.common.none } }),
        statTile({ label: T.dataCheck.validation, value: summary.errors > 0 ? fmt(T.dataCheck.errorCount, { n: summary.errors }) : T.dataCheck.noErrors, sub: summary.warnings === null ? T.dataCheck.validationLoadFailed : fmt(T.dataCheck.warningCount, { n: summary.warnings }), status: summary.errors > 0 ? { kind: "danger", text: T.dataCheck.blocksPublish } : { kind: "ok", text: T.dataCheck.publishable } }),
      ],
      { columns: 6 },
    ),
  );
}
```

```js
if (sections) display(sectionToc([...sections.values()]));
```

```js
if (model) {
  const sec = openSection("unmapped");
  display(sec.el);
  // 契約期間外は下の「契約期間外の実績」に分ける（§103）
  const rows = model.unmapped.filter((g) => g.reason !== "OUT_OF_PERIOD").map((g) => ({ ...g, reasonLabel: UNMAPPED_REASON_LABELS[g.reason] ?? g.reason }));
  // 未登録の案件（作業名から抜き出した案件名。§97）は、本当に案件があれば人が登録する（自動では登録しない。§103）
  const registerCol = rows.some((r) => r.reason === "UNREGISTERED_PROJECT")
    ? [
        {
          key: "action",
          label: T.dataCheck.colAction,
          type: "custom",
          get: (r) => (r.reason === "UNREGISTERED_PROJECT" ? T.dataCheck.registerContract : ""),
          render: (r) => {
            if (r.reason !== "UNREGISTERED_PROJECT") return "";
            return linkButton(registerHref(r), T.dataCheck.registerContract, fmt(T.dataCheck.registerContractAria, { name: [r.customerName, r.projectName].filter(Boolean).join(" / ") }));
          },
          exportValue: () => "",
        },
      ]
    : [];
  if (rows.length === 0) sec.body.append(emptyState({ title: T.dataCheck.unmappedEmpty, icon: "✓" }));
  else
    sec.body.append(
      groupedWorklogTable({
        model,
        groups: rows,
        groupName: (g) => [g.taskCode, g.customerName, g.projectName].filter(Boolean).join(" / ") || T.dataCheck.empty,
        columns: [
          { key: "customerName", label: T.dataCheck.colWorklogCustomer, type: "text", empty: T.dataCheck.empty },
          { key: "projectName", label: T.dataCheck.colWorklogProject, type: "text", empty: T.dataCheck.empty },
          // 作業コードの行（§92）で探した未紐付けがあるときだけ
          ...(rows.some((r) => r.taskCode !== undefined) ? [{ key: "taskCode", label: T.dataCheck.colTaskCode, type: "text", empty: T.dataCheck.empty }] : []),
          peopleColumn(model),
          { key: "reasonLabel", label: T.dataCheck.colReason, type: "text" },
          { key: "hours", label: T.columns.hours, type: "hours" },
          { key: "count", label: T.dataCheck.colCount, type: "int" },
          { key: "firstDate", label: T.dataCheck.colFirstDate, type: "text", hideOnPhone: true },
          { key: "lastDate", label: T.dataCheck.colLastDate, type: "text" },
          ...registerCol,
        ],
        caption: T.dataCheck.unmappedTitle,
        previewRows: PREVIEW_ROWS,
        exportName: "unmapped_worklogs",
        sort: { key: "hours", dir: "desc" },
      }),
    );
}
```

```js
// 契約期間外の実績（§103）: 消したり自動で直したりせず、契約期間・実績の日付・時間を並べて人が判断する
if (model) {
  const sec = openSection("outOfPeriod");
  display(sec.el);
  const groups = model.unmapped.filter((g) => g.reason === "OUT_OF_PERIOD");
  const periodText = (g) => (g.contracts ?? []).map((c) => `${monthJa(c.startMonth)}〜${monthJa(c.endMonth)}`).join("、");
  const rows = groups.map((g) => ({ ...g, contractText: (g.contracts ?? []).map((c) => c.contractId).join("、"), contractPeriod: periodText(g), workPeriod: g.firstDate === g.lastDate ? g.firstDate : `${g.firstDate}〜${g.lastDate}` }));
  if (rows.length === 0) sec.body.append(emptyState({ title: T.dataCheck.outOfPeriodEmpty, icon: "✓" }));
  else
    sec.body.append(
      groupedWorklogTable({
        model,
        groups: rows,
        groupName: (g) => [g.taskCode, g.customerName, g.projectName].filter(Boolean).join(" / ") || T.dataCheck.empty,
        columns: [
          { key: "customerName", label: T.dataCheck.colWorklogCustomer, type: "text", empty: T.dataCheck.empty },
          { key: "projectName", label: T.dataCheck.colWorklogProject, type: "text", empty: T.dataCheck.empty },
          { key: "contractText", label: T.dataCheck.colContractId, type: "text", optional: true, exportAlways: true },
          { key: "contractPeriod", label: T.dataCheck.colContractPeriod, type: "text" },
          { key: "workPeriod", label: T.dataCheck.colWorkPeriod, type: "text", sortValue: (r) => r.lastDate },
          peopleColumn(model),
          {
            key: "hours",
            label: T.columns.hours,
            type: "hours",
            breakdown: (r) => ({
              title: [r.customerName, r.projectName].filter(Boolean).join(" / "),
              subtitle: `${T.dataCheck.colContractPeriod}: ${r.contractPeriod}`,
              sections: [{ table: { columns: [{ label: T.charts.colMonth }, { label: T.columns.hours, align: "num" }], rows: (r.months ?? []).map((m) => [monthJa(m.month), formatHours(m.hours)]) } }],
            }),
          },
          { key: "count", label: T.dataCheck.colCount, type: "int", hideOnPhone: true },
          {
            key: "action",
            label: T.dataCheck.colAction,
            type: "custom",
            get: () => T.dataCheck.openContract,
            render: (r) => {
              const id = r.contracts?.[0]?.contractId;
              return id ? linkButton(mastersHref("contracts", { q: id }), T.dataCheck.openContract, fmt(T.dataCheck.openContractAria, { name: [r.customerName, r.projectName].filter(Boolean).join(" / ") })) : "";
            },
            exportValue: () => "",
          },
        ],
        caption: T.dataCheck.outOfPeriodTitle,
        previewRows: PREVIEW_ROWS,
        exportName: "out_of_period_worklogs",
        sort: { key: "hours", dir: "desc" },
      }),
    );
}
```

```js
// 作業名のキーワード（§62.3）。キーワードを使っていない・すべて合致したときは出さない
if (model && (model.keywordUnmatched ?? []).length > 0) {
  const sec = openSection("keyword");
  display(sec.el);
  sec.body.append(
    groupedWorklogTable({
      model,
      groups: model.keywordUnmatched,
      groupName: (g) => [g.customerName, g.projectName, g.task].filter(Boolean).join(" / "),
      columns: [
        { key: "customerName", label: T.dataCheck.colWorklogCustomer, type: "text" },
        { key: "projectName", label: T.dataCheck.colWorklogProject, type: "text", empty: T.dataCheck.empty },
        { key: "task", label: T.dataCheck.colTask, type: "text", empty: T.dataCheck.empty },
        peopleColumn(model),
        { key: "type", label: T.dataCheck.colType, type: "text" },
        { key: "hours", label: T.columns.hours, type: "hours" },
        { key: "count", label: T.dataCheck.colCount, type: "int" },
        { key: "lastDate", label: T.dataCheck.colLastDate, type: "text", hideOnPhone: true },
      ],
      caption: T.dataCheck.keywordTitle,
      previewRows: PREVIEW_ROWS,
      exportName: "keyword_unmatched",
      sort: { key: "hours", dir: "desc" },
    }),
  );
}
```

```js
// 作業コードの点検（§92）。点検の設定が無い・見つからないときは出さない
if (model && (model.unregisteredTaskCodes ?? []).length > 0) {
  const sec = openSection("taskCode");
  display(sec.el);
  sec.body.append(
    groupedWorklogTable({
      model,
      groups: model.unregisteredTaskCodes.map((g) => ({ ...g, statusLabel: g.status === "none" ? T.dataCheck.statusNone : T.dataCheck.statusPeriod })),
      groupName: (g) => [g.taskCode, g.task].filter(Boolean).join(" / "),
      groupLabel: T.dataCheck.colTaskCode,
      columns: [
        { key: "taskCode", label: T.dataCheck.colTaskCode, type: "text" },
        { key: "task", label: T.dataCheck.colTask, type: "text", empty: T.dataCheck.empty },
        { key: "customerName", label: T.dataCheck.colWorklogCustomer, type: "text", empty: T.dataCheck.empty, hideOnPhone: true },
        peopleColumn(model),
        { key: "statusLabel", label: T.dataCheck.colStatus, type: "text" },
        { key: "hours", label: T.columns.hours, type: "hours" },
        { key: "count", label: T.dataCheck.colCount, type: "int", hideOnPhone: true },
        { key: "firstDate", label: T.dataCheck.colFirstDate, type: "text", hideOnPhone: true },
        { key: "lastDate", label: T.dataCheck.colLastDate, type: "text" },
      ],
      caption: T.dataCheck.taskCodeTitle,
      previewRows: PREVIEW_ROWS,
      exportName: "unregistered_task_codes",
      sort: { key: "hours", dir: "desc" },
    }),
  );
}
if (model && (model.taskCodeChanges ?? []).length > 0) {
  const sec = openSection("taskCodeChanges");
  display(sec.el);
  const matchLabel = (c) => (c.matchBefore === null || c.matchAfter === null || c.matchBefore === c.matchAfter ? T.dataCheck.matchKept : c.matchAfter ? T.dataCheck.matchGained : T.dataCheck.matchLost);
  sec.body.append(
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
      previewRows: PREVIEW_ROWS,
      exportName: "task_code_changes",
      maxHeight: 520,
      sort: { key: "changedOn", dir: "desc" },
    }),
  );
}
```

```js
// 正式な案件の一覧（案件管理システム）との照合（§98）。一覧を取り込んでいない・見つからないときは出さない
const projectCheck = issuesData?.projects;
if (model && projectCheck?.enabled && projectCheck.unlinked.length > 0) {
  const sec = openSection("unlinkedContracts");
  display(sec.el);
  sec.body.append(
    dataTable({
      columns: [
        { key: "customerName", label: T.dataCheck.colCustomer, type: "text" },
        { key: "projectName", label: T.dataCheck.colProject, type: "text" },
        { key: "contractId", label: T.dataCheck.colContractId, type: "text", optional: true, exportAlways: true },
        { key: "period", label: T.dataCheck.colPeriod, type: "text", hideOnPhone: true, dateValue: (r) => [r.startMonth, r.endMonth] },
        { key: "candidateText", label: T.dataCheck.colCandidates, type: "text", empty: T.dataCheck.noCandidate },
      ],
      rows: projectCheck.unlinked.map((c, i) => ({ key: i, ...c, period: `${c.startMonth}〜${c.endMonth}`, candidateText: c.candidates.map(officialLabel).join("、") })),
      caption: T.dataCheck.unlinkedContractsTitle,
      previewRows: PREVIEW_ROWS,
      exportName: "contracts_without_project_id",
      maxHeight: 520,
      sort: { key: "customerName", dir: "asc" },
    }),
  );
}
if (model && projectCheck?.enabled && projectCheck.unregistered.length > 0) {
  const sec = openSection("unregisteredProjects");
  display(sec.el);
  // 正式な案件IDの無い案件の候補になっているもの（同じ案件を二重に登録しないように並べる）
  const sameName = unlinkedByCandidate(projectCheck.unlinked);
  sec.body.append(
    dataTable({
      columns: [
        // 名前を先に。正式な案件IDは「列」で選べる列（Excel には常に出す。§127）
        { key: "customerName", label: T.dataCheck.colCustomer, type: "text" },
        { key: "projectName", label: T.dataCheck.colProject, type: "text" },
        { key: "projectId", label: T.dataCheck.colProjectId, type: "text", optional: true, exportAlways: true },
        ...(sameName.size > 0 ? [{ key: "sameNameText", label: T.dataCheck.colSameNameContracts, type: "text", empty: "" }] : []),
        {
          key: "action",
          label: T.dataCheck.colAction,
          type: "custom",
          get: () => T.dataCheck.registerContract,
          render: (p) => linkButton(registerHref(p), T.dataCheck.registerContract, fmt(T.dataCheck.registerContractAria, { name: `${p.customerName} / ${p.projectName}` })),
          exportValue: () => "",
        },
      ],
      rows: projectCheck.unregistered.map((p, i) => ({ key: i, ...p, sameNameText: contractListText(sameName.get(p.projectId)) })),
      caption: T.dataCheck.unregisteredProjectsTitle,
      previewRows: PREVIEW_ROWS,
      exportName: "projects_without_contract",
      maxHeight: 520,
      sort: { key: "customerName", dir: "asc" },
    }),
  );
}
```

```js
// 未設定・仮の値（§103）。マスタ編集の該当箇所を開くだけで、値は人が入れる
if (model && issuesData) {
  const sec = openSection("unset");
  display(sec.el);
  const kinds = T.dataCheck.unsetKinds;
  const hrefOf = (u) =>
    u.kind === "contractTeam"
      ? mastersHref("contracts", { q: u.key, unset: "team" })
      : u.kind === "contractAmount"
        ? mastersHref("contracts", { q: u.key, unset: "amount" })
        : u.kind === "rateMissing"
          ? mastersHref("rates", { new: "1", key: u.key })
          : mastersHref("rates", { q: u.key, unset: "provisional" });
  const rows = (issuesData.unset ?? []).map((u, i) => ({
    key: i,
    ...u,
    kindLabel: kinds[u.kind] ?? u.kind,
    target: u.customerName !== undefined ? `${[u.customerName, u.projectName].filter(Boolean).join(" / ")}（${u.key}）` : u.key,
    detail: u.kind === "rateMissing" ? fmt(T.dataCheck.unsetMembers, { n: integer(u.count ?? 0) }) : "",
  }));
  if (rows.length === 0) sec.body.append(emptyState({ title: T.dataCheck.unsetEmpty, icon: "✓" }));
  else
    sec.body.append(
      dataTable({
        columns: [
          { key: "kindLabel", label: T.dataCheck.colUnsetKind, type: "text", sortValue: (r) => ["contractTeam", "contractAmount", "rateMissing", "rateProvisional"].indexOf(r.kind) },
          { key: "target", label: T.dataCheck.colUnsetTarget, type: "text" },
          { key: "detail", label: T.dataCheck.colUnsetDetail, type: "text", empty: "", hideOnPhone: true },
          { key: "action", label: T.dataCheck.colAction, type: "custom", get: () => T.dataCheck.fixInMasters, render: (r) => linkButton(hrefOf(r), T.dataCheck.fixInMasters, fmt(T.dataCheck.fixInMastersAria, { name: `${r.kindLabel} ${r.target}` })), exportValue: () => "" },
        ],
        rows,
        caption: T.dataCheck.unsetTitle,
        previewRows: PREVIEW_ROWS,
        exportName: "unset_items",
        sort: { key: "kindLabel", dir: "asc" },
        maxHeight: 520,
      }),
    );
}
```

```js
if (model) {
  const sec = openSection("rateMissing");
  display(sec.el);
  // 人ごとにまとめる（メンバー × 月のままだと行が多すぎて読めない）。月ごとの時間は内訳で見る
  const byMember = new Map();
  for (const w of model.warnings) {
    if (w.code !== "RATE_MISSING") continue;
    const id = w.ref?.memberId ?? "";
    let r = byMember.get(id);
    if (!r) byMember.set(id, (r = { key: id || "\u0000", memberId: id, memberName: model.members.find((m) => m.memberId === id)?.name ?? "", hours: 0, months: [] }));
    r.hours += w.hours ?? 0;
    r.months.push({ month: w.ref?.month ?? "", hours: w.hours ?? 0 });
  }
  const rows = [...byMember.values()].map((r) => {
    const months = r.months.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
    return { ...r, months, monthCount: months.length, firstMonth: months[0]?.month ?? "", lastMonth: months[months.length - 1]?.month ?? "" };
  });
  if (rows.length === 0) sec.body.append(emptyState({ title: T.dataCheck.rateMissingEmpty, icon: "✓" }));
  else
    sec.body.append(
      dataTable({
        columns: [
          { key: "memberName", label: T.dataCheck.colName, type: "text" },
          { key: "memberId", label: T.members.colMemberId, type: "text", optional: true, exportAlways: true },
          { key: "monthCount", label: T.dataCheck.colMonths, type: "int" },
          {
            key: "span",
            label: T.dataCheck.colMonthSpan,
            type: "text",
            get: (r) => r.lastMonth,
            render: (r) => (r.firstMonth === r.lastMonth ? monthJa(r.firstMonth) : `${monthJa(r.firstMonth)}〜${monthJa(r.lastMonth)}`),
            exportValue: (r) => `${r.firstMonth}〜${r.lastMonth}`,
            hideOnPhone: true,
          },
          {
            key: "hours",
            label: T.columns.hours,
            type: "hours",
            breakdown: (r) => ({
              title: `${r.memberName || r.memberId}（${r.memberId}）`,
              subtitle: T.dataCheck.rateMissingTitle,
              sections: [{ table: { columns: [{ label: T.charts.colMonth }, { label: T.columns.hours, align: "num" }], rows: r.months.map((m) => [monthJa(m.month), formatHours(m.hours)]) } }],
            }),
          },
        ],
        rows,
        caption: T.dataCheck.rateMissingTitle,
        previewRows: PREVIEW_ROWS,
        exportName: "rate_missing",
        maxHeight: 520,
        sort: { key: "hours", dir: "desc" },
      }),
    );
}
```

```js
if (model) {
  const sec = openSection("unknown");
  display(sec.el);
  const rows = (model.unknownMembers ?? []).map((u) => ({ ...u, key: u.memberId || "\u0000", customerText: u.customers.map((c) => c.name || T.numbers.noCustomerName).join("、") }));
  if (rows.length === 0) sec.body.append(emptyState({ title: T.dataCheck.unknownEmpty, icon: "✓" }));
  else
    sec.body.append(
      dataTable({
        columns: [
          // マスタに無い人は作業実績の名前が空のこともあるので、社員番号も出しておく（名前が先）
          { key: "memberName", label: T.dataCheck.colName, type: "text", empty: T.dataCheck.empty },
          { key: "memberId", label: T.members.colMemberId, type: "text", empty: T.dataCheck.empty },
          { key: "hours", label: T.columns.hours, type: "hours" },
          { key: "contractHours", label: T.dataCheck.colContractHours, type: "hours", hideOnPhone: true },
          { key: "count", label: T.dataCheck.colCount, type: "int", hideOnPhone: true },
          { key: "firstDate", label: T.dataCheck.colFirstDate, type: "text", hideOnPhone: true },
          { key: "lastDate", label: T.dataCheck.colLastDate, type: "text" },
          {
            key: "customerText",
            label: T.dataCheck.colCustomers,
            type: "text",
            filterValue: (r) => r.customers.map((c) => c.name || T.numbers.noCustomerName),
            breakdown: (r) => ({
              title: `${r.memberName || r.memberId}（${r.memberId || T.dataCheck.empty}）`,
              subtitle: T.dataCheck.unknownTitle,
              sections: [{ table: { columns: [{ label: T.dataCheck.colCustomer }, { label: T.columns.hours, align: "num" }], rows: r.customers.map((c) => [c.name || T.numbers.noCustomerName, formatHours(c.hours)]) } }],
            }),
          },
        ],
        rows,
        caption: T.dataCheck.unknownCaption,
        previewRows: PREVIEW_ROWS,
        exportName: "unknown_members",
        sort: { key: "hours", dir: "desc" },
        maxHeight: 560,
      }),
    );
}
```

```js
if (model) {
  const sec = openSection("excluded");
  display(sec.el);
  const w = model.warnings.find((x) => x.code === "EXCLUDED_NO_CUSTOMER");
  sec.body.append(html`<p class="yn-fact-line">${T.dataCheck.excludedTotal} <strong class="num">${formatHours(model.excludedHours)}</strong>${w?.count ? fmt(T.dataCheck.excludedCount, { n: integer(w.count) }) : null}${w?.message ? html`<span class="yn-muted"> — ${w.message}</span>` : null}</p>`);
}
```

```js
if (model) {
  const sec = openSection("warnings");
  display(sec.el);
  const rows = model.warnings.map((w, i) => ({ key: i, code: w.code, label: WARNING_LABELS[w.code] ?? w.code, message: w.message, hours: w.hours ?? null, count: w.count ?? null, ref: w.ref ? Object.entries(w.ref).map(([k, v]) => `${k}=${v}`).join(" ") : "" }));
  if (rows.length === 0) sec.body.append(emptyState({ title: T.dataCheck.warningsEmpty, icon: "✓" }));
  else
    sec.body.append(
      dataTable({
        columns: [
          { key: "label", label: T.dataCheck.colKind, type: "text", sortValue: (r) => r.code },
          { key: "message", label: T.dataCheck.colMessage, type: "custom", render: (r) => msgCell(r.message), exportValue: (r) => r.message },
          { key: "hours", label: T.columns.hours, type: "hours" },
          { key: "count", label: T.dataCheck.colCount, type: "int" },
          { key: "ref", label: T.dataCheck.colRef, type: "text", exportOnly: true },
        ],
        rows,
        caption: T.dataCheck.warningsCaption,
        previewRows: PREVIEW_ROWS,
        exportName: "warnings",
        maxHeight: 520,
      }),
    );
}
```

```js
if (model) {
  const sec = openSection("issues");
  display(sec.el);
  if (!issuesData) sec.body.append(note(T.dataCheck.issuesLoadFailed, "danger"));
  else {
    const rows = issuesData.issues.map((i, k) => ({ key: k, severity: i.severity, severityChip: i.severity === "error" ? { kind: "danger", text: T.dataCheck.severityError } : { kind: "warn", text: T.dataCheck.severityWarning }, code: i.code, file: i.file ?? "", row: i.row ?? null, message: i.message }));
    if (rows.length === 0) sec.body.append(emptyState({ title: T.dataCheck.issuesEmpty, icon: "✓" }));
    else
      sec.body.append(
        dataTable({
          columns: [
            { key: "severityChip", label: T.dataCheck.colSeverity, type: "status", sortValue: (r) => (r.severity === "error" ? 0 : 1) },
            { key: "message", label: T.dataCheck.colMessage, type: "custom", render: (r) => msgCell(r.message), exportValue: (r) => r.message },
            { key: "file", label: T.dataCheck.colFile, type: "text", optional: true, exportAlways: true },
            { key: "row", label: T.dataCheck.colRow, type: "int", optional: true, exportAlways: true },
            { key: "code", label: T.dataCheck.colCode, type: "text", exportOnly: true },
          ],
          rows,
          caption: T.dataCheck.issuesCaption,
          previewRows: PREVIEW_ROWS,
          exportName: "validation_issues",
          sort: { key: "severityChip", dir: "asc" },
          maxHeight: 520,
        }),
      );
  }
}
```
