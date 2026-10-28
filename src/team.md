---
title: チーム詳細
---

<div id="page-skeleton" class="yn-skeleton" aria-busy="true" aria-label="読み込み中">
  <div class="yn-skel-line yn-skel-title"></div>
  <div class="yn-skel-line"></div>
  <div class="yn-skel-grid"><div></div><div></div><div></div><div></div><div></div></div>
  <div class="yn-skel-block"></div>
</div>

```js
import { html } from "htl";
import { T, fmt } from "./i18n/index.js";
import { UNASSIGNED_TEAM_ID, UNASSIGNED_TEAM_LABEL, contractsForTeam, teamMemberCosts, teamOrgChanges, teamPath } from "./core/index.js";
import { createStore, periodFiscalYear } from "./components/state.js";
import { summarize, seriesWithForecast, priorYearComparison, contractRow, teamRow, treeAt, treeMonthFor, memberNameAt } from "./components/analysis.js";
import { pageHeader, sectionTitle, emptyState, loadJson, note } from "./components/layout.js";
import { mountFilterBar } from "./components/filters.js";
import { statusChip } from "./components/kpi.js";
import { chartFigure } from "./components/chart-zoom.js";
import { monthlyChart, monthlyLegend, seriesTable } from "./components/charts.js";
import { dataTable, standardColumns, rowStatus, statusSortValue, contractNameCell, teamCountColumns, withForecastCount } from "./components/table.js";
import * as bd from "./components/breakdown.js";
import { summaryKpis, memberCostSpec, orgChangeText, ORG_CHANGE_LABELS } from "./components/team-detail.js";
import { money, formatHours, formatPercent, monthJa, periodJa, METHOD_LABELS, fiscalYearLabel, integer } from "./components/format.js";
```

```js
const model = await loadJson(FileAttachment("./data/model.json"), { skeleton: "page-skeleton" });
const teamId = new URLSearchParams(location.search).get("id") ?? "";
const store = model ? createStore(model) : null;
```

```js
const state = Generators.observe((notify) => {
  if (!store) {
    notify(null);
    return () => {};
  }
  notify(store.get());
  return store.subscribe(notify);
});
```

```js
// 画面の状態（期間・単位・方式）と ?id= から、このチームの母集団（配下含む契約）を決める
const vm = (() => {
  if (!model || !state) return null;
  const period = { from: state.from, to: state.to };
  const treeMonth = treeMonthFor(model, period);
  const { tree } = treeAt(model, treeMonth);
  const isUnassigned = teamId === UNASSIGNED_TEAM_ID;
  const node = Object.prototype.hasOwnProperty.call(tree, teamId) ? tree[teamId] : null;
  const base = { period, treeMonth, tree, teamId, isUnassigned, unit: state.unit, method: state.method };
  if (!isUnassigned && !node) {
    return { ...base, exists: false, knownInHistory: model.teams.some((t) => t.teamId === teamId) };
  }
  const name = isUnassigned ? UNASSIGNED_TEAM_LABEL : node.name;
  const contracts = contractsForTeam(model, teamId, tree);
  const contractIds = contracts.map((c) => c.contractId);
  const scope = { period, contractIds, teamId, teamLabel: name, tree, treeMonth };
  const { totals, forecast } = summarize(model, scope, state.method);
  const series = seriesWithForecast(model, scope, state.method);
  const compare = priorYearComparison(model, scope);
  const path = isUnassigned ? [] : teamPath(tree, teamId);
  return {
    ...base,
    exists: true,
    name,
    node,
    scope,
    contractIds,
    totals,
    forecast,
    series,
    compare,
    path,
    fy: periodFiscalYear(model, period),
  };
})();
```

```js
if (model && vm) {
  const title = vm.exists ? html`${vm.isUnassigned ? "" : html`<span class="yn-title-id">${vm.teamId}</span> `}${vm.name}` : T.team.pageTitle;
  const crumbs = [{ label: T.app.pages.index, href: store.href("./") }, { label: T.app.pages.teams, href: store.href("./teams") }];
  if (!vm.exists) crumbs.push({ label: teamId || T.team.noIdCrumb });
  else if (vm.isUnassigned) crumbs.push({ label: vm.name });
  else for (const n of vm.path) crumbs.push({ label: n.name, href: store.href("./team", {}, { id: n.teamId }) });
  display(
    pageHeader({
      model,
      title,
      lead: vm.exists
        ? vm.isUnassigned
          ? T.team.unassignedLead
          : fmt(T.team.lead, { team: vm.name })
        : null,
      breadcrumbs: crumbs,
      includesPreliminary: vm.exists ? vm.totals.includesPreliminary : false,
      extra: vm.exists
        ? html`${!vm.isUnassigned && (vm.node.level || vm.node.leaderMemberId)
            ? html`<p class="yn-team-org" id="yn-team-org">${vm.node.level ? html`<span class="yn-chip yn-chip-neutral">${vm.node.level}</span> ` : null}${T.team.leaderLabel}${vm.node.leaderMemberId ? html`<a href=${store.href("./member", {}, { id: vm.node.leaderMemberId })}>${memberNameAt(model, vm.node.leaderMemberId, vm.treeMonth)}</a>` : T.team.leaderUnset}</p>`
            : null}<a class="yn-btn yn-btn-sm" id="yn-team-contracts-link" href=${store.href("./contracts", { team: vm.teamId })}>${T.team.toContracts}</a>${!vm.isUnassigned ? html` <a class="yn-btn yn-btn-sm" id="yn-team-plan-link" href=${`./plan?team=${encodeURIComponent(vm.teamId)}`}>${T.team.toPlan}</a>` : null}`
        : null,
    }),
  );
}
```

```js
if (model && !teamId) {
  display(emptyState({ title: T.team.noIdTitle, text: T.team.noIdText, actions: [{ label: T.index.toTeams, href: store.href("./teams") }] }));
}
```

```js
if (store && teamId) mountFilterBar(store, model, { show: ["period", "method", "unit"] });
```

```js
if (vm && !vm.exists && teamId) {
  display(
    emptyState({
      title: T.team.notInPeriodTitle,
      text: vm.knownInHistory
        ? fmt(T.team.notInPeriodText, { teamId, month: monthJa(vm.treeMonth) })
        : fmt(T.team.unknownText, { teamId }),
      actions: [{ label: T.index.toTeams, href: store.href("./teams") }],
    }),
  );
}
```

```js
if (vm?.exists) {
  display(sectionTitle(T.team.summaryTitle, fmt(T.team.summaryHint, { period: periodJa(vm.period), team: vm.name, children: vm.isUnassigned ? "" : T.team.includingChildren, month: monthJa(vm.treeMonth) })));
  display(summaryKpis({ model, store, scope: vm.scope, totals: vm.totals, forecast: vm.forecast, compare: vm.compare, fy: vm.fy, unit: vm.unit }));
}
```

```js
if (vm?.exists) {
  display(sectionTitle(T.charts.monthlyTitle, fmt(T.index.monthlyHint, { period: periodJa(vm.period), asOfMonth: monthJa(model.meta.asOfMonth), method: METHOD_LABELS[vm.method] })));
  display(chartFigure({
    title: T.charts.monthlyTitle,
    subtitle: periodJa(vm.period),
    legend: monthlyLegend(dark),
    draw: (width, height) => monthlyChart({ series: vm.series, unit: vm.unit, dark, width, height, asOfMonth: model.meta.asOfMonth }),
    after: html`<details class="yn-details"><summary>${T.pages.showTable}</summary>${seriesTable(vm.series, { unit: vm.unit, exportName: `team_${vm.teamId}_monthly_${vm.period.from}_${vm.period.to}` })}</details>`,
  }));
}
```

```js
// 配下チーム（直下の子ごと。子が無ければ出さない）
if (vm?.exists && vm.node && vm.node.children.length > 0) {
  const { period, unit, method, tree } = vm;
  const rows = vm.node.children.map((id) => ({ ...teamRow(model, id, tree[id].name, 0, period, method, tree), key: id }));
  const detailHref = (id) => store.href("./contract", {}, { id });
  display(sectionTitle(T.team.childrenTitle, fmt(T.team.childrenHint, { team: vm.name, fy: fiscalYearLabel(model.meta.fiscalYear) })));
  const columns = [
    { key: "name", label: T.columns.team, type: "text" },
    ...teamCountColumns(),
    ...standardColumns({
      forecastLabel: T.columns.forecastGrossProfit,
      breakdowns: {
        budget: (r) => bd.budgetAggregateSpec({ model, contractIds: r.contractIds, period, unit }),
        cost: (r) => bd.costAggregateSpec({ model, contractIds: r.contractIds, period, unit, detailHref }),
        grossProfit: (r) => bd.grossProfitSpec({ budget: r.budget, cost: r.cost, unit, subtitle: r.name }),
        margin: (r) => bd.marginSpec({ totals: r.totals, unit, subtitle: r.name }),
        burnRate: (r) => bd.burnRateSpec({ totals: r.totals, unit, threshold: model.config.burnRateDangerThreshold, asOfMonth: model.meta.asOfMonth, subtitle: r.name }),
        forecast: (r) => bd.forecastTotalsSpec({ model, totals: r.forecast, unit, contractIds: r.contractIds, detailHref }),
      },
    }).map(withForecastCount),
    { key: "status", label: T.columns.status, type: "status", get: (r) => rowStatus(r), sortValue: (r) => statusSortValue(r), hideNarrow: true },
  ];
  display(dataTable({ columns, rows, unit, caption: T.team.childrenTitle, exportName: `team_${vm.teamId}_children_${period.from}_${period.to}`, sort: { key: "status", dir: "asc" }, rowHref: (r) => store.href("./team", {}, { id: r.teamId }) }));
}
```

```js
// 契約一覧（このチームの契約のみ。列は他の一覧と同じ standardColumns）
if (vm?.exists) {
  const { period, unit, method, tree } = vm;
  const all = model.contracts.filter((r) => vm.contractIds.includes(r.contract.contractId)).map((r) => ({ ...contractRow(model, r, period, method, tree), key: r.contract.contractId }));
  const rows = all.filter((r) => r.inPeriod);
  const outside = all.length - rows.length;
  display(
    sectionTitle(
      T.app.pages.contracts,
      fmt(T.team.contractsHint, { team: vm.name, children: vm.isUnassigned ? "" : T.team.includingChildren, method: METHOD_LABELS[method], fy: model.meta.fiscalYear }),
      html`<a class="yn-btn yn-btn-sm" href=${store.href("./contracts", { team: vm.teamId })}>${T.team.filterContracts}</a>`,
      outside > 0 ? fmt(T.team.hiddenOutside, { n: outside }) : null,
    ),
  );
  if (rows.length === 0) {
    display(emptyState({ title: T.team.noContractsTitle, text: fmt(T.team.noContractsText, { team: vm.name, period: periodJa(period) }), icon: "○" }));
  } else {
    const detailHref = (id) => store.href("./contract", {}, { id });
    const sub = (r) => `${r.contractId} ${r.customerName} / ${r.projectName}`;
    const columns = [
      { key: "name", label: T.columns.contract, type: "text", render: (r) => contractNameCell(r), sortValue: (r) => `${r.customerName} ${r.projectName}`, exportValue: (r) => `${r.customerName} / ${r.projectName}` },
      { key: "contractId", label: T.columns.contractId, type: "text", exportOnly: true },
      { key: "customerName", label: T.customers.colCustomer, type: "text", exportOnly: true },
      { key: "projectName", label: T.contracts.colProject, type: "text", exportOnly: true },
      { key: "teamName", label: T.columns.team, type: "text", exportOnly: true },
      { key: "period", label: T.columns.contractPeriod, type: "text", exportOnly: true, get: (r) => `${r.startMonth}〜${r.endMonth}` },
      ...standardColumns({
        breakdowns: {
          budget: (r) => bd.budgetAggregateSpec({ model, contractIds: [r.contractId], period, unit }),
          cost: (r) => bd.costAggregateSpec({ model, contractIds: [r.contractId], period, unit, detailHref }),
          grossProfit: (r) => bd.grossProfitSpec({ budget: r.budget, cost: r.cost, unit, subtitle: sub(r) }),
          margin: (r) => bd.marginSpec({ totals: r.totals, unit, subtitle: sub(r) }),
          burnRate: (r) => bd.burnRateSpec({ totals: r.totals, unit, threshold: model.config.burnRateDangerThreshold, asOfMonth: model.meta.asOfMonth, subtitle: sub(r) }),
          forecast: (r) => bd.forecastSpec({ forecast: r.forecast, contract: r.contract, unit, config: model.config }),
        },
      }),
      { key: "status", label: T.columns.status, type: "status", get: (r) => rowStatus(r), sortValue: (r) => statusSortValue(r), hideNarrow: true },
    ];
    display(dataTable({ columns, rows, unit, caption: T.team.contractsCaption, exportName: `team_${vm.teamId}_contracts_${period.from}_${period.to}`, sort: { key: "status", dir: "asc" }, rowHref: (r) => detailHref(r.contractId) }));
  }
}
```

```js
// メンバー別原価（作業実績軸: このチームの契約に工数を付けた人。所属チームが別でも含める）
if (vm?.exists) {
  const { period, unit, tree } = vm;
  const inCount = vm.totals.contractCount;
  const teamScope = vm.node ? new Set(vm.node.descendantIds) : null;
  const rows = teamMemberCosts(model, vm.contractIds, period, teamScope).map((r) => ({
    ...r,
    key: r.memberId,
    teams: r.teamIds.map((id) => tree[id]?.name ?? model.teams.find((t) => t.teamId === id)?.name ?? id).join("、") || "—",
    isSupport: r.outsideHours > 0,
  }));
  display(sectionTitle(T.team.membersTitle, fmt(T.team.membersHint, { period: periodJa(period), team: vm.name, count: inCount > 0 ? fmt(T.team.countParen, { n: inCount }) : "", support: vm.isUnassigned ? "" : T.team.supportNote })));
  if (rows.length === 0) {
    display(emptyState({ title: T.team.noWorkTitle, text: T.team.noWorkText, icon: "○" }));
  } else {
    const detailHref = (id) => store.href("./contract", {}, { id });
    const columns = [
      {
        key: "memberName",
        label: T.breakdown.colMember,
        type: "text",
        render: (r) => html`${r.memberName} <span class="yn-muted">${r.memberId}</span>${r.rateMissing ? html` ${statusChip("neutral", T.breakdown.rateMissing, T.team.rateMissingTitle)}` : ""}${r.isSupport ? html` ${statusChip("neutral", T.team.support, T.team.supportTitle)}` : ""}`,
        sortValue: (r) => r.memberName,
      },
      { key: "teams", label: T.team.colTeamAtTime, type: "text", hideOnPhone: true },
      { key: "hours", label: T.columns.hours, type: "hours", breakdown: (r) => memberCostSpec({ model, contractIds: vm.contractIds, period, unit, member: r, detailHref }) },
      { key: "amount", label: T.columns.cost, type: "moneyYen", breakdown: (r) => memberCostSpec({ model, contractIds: vm.contractIds, period, unit, member: r, detailHref }) },
      { key: "share", label: T.team.colShare, type: "percent" },
      { key: "contractCount", label: T.columns.contractCount, type: "int", hideOnPhone: true, get: (r) => r.contractIds.length },
      { key: "monthCount", label: T.team.colWorkMonths, type: "int", hideOnPhone: true, hideNarrow: true },
    ];
    display(dataTable({ columns, rows, unit, caption: T.team.membersTitle, exportName: `team_${vm.teamId}_members_${period.from}_${period.to}`, sort: { key: "amount", dir: "desc" } }));
  }
}
```

```js
// 組織の変遷（期間内に、このチームの名前・上位、または直下の構成が変わったときだけ）
if (vm?.exists && !vm.isUnassigned) {
  const changes = teamOrgChanges(model.teams, vm.teamId, vm.period);
  if (changes.length > 0) {
    const rows = changes.map((c) => ({ ...c, key: `${c.month}-${c.teamId}-${c.kind}`, kindLabel: ORG_CHANGE_LABELS[c.kind], text: orgChangeText(c) }));
    display(sectionTitle(T.team.orgTitle, fmt(T.team.orgHint, { period: periodJa(vm.period), team: vm.name, month: monthJa(vm.treeMonth) })));
    const columns = [
      { key: "month", label: T.team.colEffective, type: "text", render: (r) => monthJa(r.month), sortValue: (r) => r.month },
      { key: "kindLabel", label: T.team.colKind, type: "text" },
      {
        key: "teamName",
        label: T.team.colTarget,
        type: "text",
        get: (r) => r.name,
        render: (r) => (vm.tree[r.teamId] && r.teamId !== vm.teamId ? html`<a href=${store.href("./team", {}, { id: r.teamId })}>${r.name}</a>` : r.name),
      },
      { key: "text", label: T.team.colDetail, type: "text", sortable: false },
    ];
    display(dataTable({ columns, rows, unit: vm.unit, caption: T.team.orgTitle, exportName: `team_${vm.teamId}_history_${vm.period.from}_${vm.period.to}`, sort: { key: "month", dir: "asc" } }));
  }
}
```
