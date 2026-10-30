---
title: チーム一覧
---

<div id="page-skeleton" class="yn-skeleton" aria-busy="true" aria-label="読み込み中">
  <div class="yn-skel-line yn-skel-title"></div>
  <div class="yn-skel-line"></div>
  <div class="yn-skel-block"></div>
</div>

```js
import { html } from "htl";
import { T, fmt } from "./i18n/index.js";
import { UNASSIGNED_TEAM_ID, UNASSIGNED_TEAM_LABEL, aggregate } from "./core/index.js";
import { createStore } from "./components/state.js";
import { scopeFor, flattenTree, teamRow, memberNameAt } from "./components/analysis.js";
import { pageHeader, sectionTitle, loadJson, note } from "./components/layout.js";
import { mountFilterBar } from "./components/filters.js";
import { dataTable, standardColumns, rowStatus, teamCountColumns } from "./components/table.js";
import * as bd from "./components/breakdown.js";
import { hasTargets, targetColumn } from "./components/targets.js";
import { money, monthJa, periodJa, METHOD_LABELS } from "./components/format.js";
```

```js
const model = await loadJson(FileAttachment("./data/model.json"), { skeleton: "page-skeleton" });
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
const vm = (() => {
  if (!model || !state) return null;
  const scope = scopeFor(model, state);
  const { tree } = scope;
  const rootTeamIds = Object.values(tree).filter((n) => n.parentTeamId === null).map((n) => n.teamId);
  const flat = flattenTree(tree, rootTeamIds);
  const rows = flat.map(({ node, depth, parent, hasChildren }) => ({
    ...teamRow(model, node.teamId, node.name, depth, scope.period, state.method, tree, {
      level: node.level,
      leader: node.leaderMemberId ? memberNameAt(model, node.leaderMemberId, scope.treeMonth) : "",
    }),
    key: node.teamId,
    parentKey: parent,
    hasChildren,
  }));
  // 未設定（チーム無し）の行は、期間内に契約があるときだけ末尾に出す（全体サマリーと同じ規則）
  const un = teamRow(model, UNASSIGNED_TEAM_ID, UNASSIGNED_TEAM_LABEL, 0, scope.period, state.method, tree);
  if (un.contractCount > 0) rows.push({ ...un, key: UNASSIGNED_TEAM_ID, parentKey: null, hasChildren: false });
  const totals = aggregate(model, { period: scope.period });
  return { scope, rows, totals, unit: state.unit, method: state.method };
})();
```

```js
if (model) {
  display(
    pageHeader({
      model,
      title: T.app.pages.teams,
      lead: T.teams.lead,
      breadcrumbs: [{ label: T.app.pages.index, href: store.href("./") }, { label: T.app.pages.teams }],
      includesPreliminary: vm?.totals.includesPreliminary ?? false,
    }),
  );
}
```

```js
if (store) mountFilterBar(store, model, { show: ["period", "method", "unit"] });
```

```js
if (vm) {
  const { scope, rows, unit } = vm;
  display(sectionTitle(T.teams.sectionTitle, fmt(T.teams.sectionHint, { period: periodJa(scope.period), month: monthJa(scope.treeMonth), method: METHOD_LABELS[vm.method], fy: model.meta.fiscalYear })));
  if (scope.period.to < model.meta.asOfMonth) {
    display(note(fmt(T.teams.orgNote, { month: monthJa(scope.period.to), asOfMonth: monthJa(model.meta.asOfMonth) })));
  }
  const columns = [
    { key: "name", label: T.columns.team, type: "text" },
    { key: "level", label: T.columns.level, type: "text", hideNarrow: true },
    { key: "leader", label: T.columns.leader, type: "text", hideNarrow: true },
    ...teamCountColumns(),
    ...standardColumns({
      forecastLabel: T.columns.forecastGrossProfit,
      breakdowns: {
        budget: (r) => bd.budgetAggregateSpec({ model, contractIds: r.contractIds, period: scope.period, unit }),
        cost: (r) => bd.costAggregateSpec({ model, contractIds: r.contractIds, period: scope.period, unit, detailHref: (id) => store.href("./contract", {}, { id }) }),
        grossProfit: (r) => bd.grossProfitSpec({ budget: r.budget, cost: r.cost, unit, subtitle: r.name }),
        margin: (r) => bd.marginSpec({ totals: r.totals, unit, subtitle: r.name }),
        burnRate: (r) => bd.burnRateSpec({ totals: r.totals, unit, threshold: model.config.burnRateDangerThreshold, asOfMonth: model.meta.asOfMonth, subtitle: r.name }),
        forecast: (r) => bd.forecastTotalsSpec({ model, totals: r.forecast, unit, contractIds: r.contractIds, detailHref: (id) => store.href("./contract", {}, { id }) }),
      },
    }),
    // 目標（§63）。目標が 1 件も無ければ列を出さない
    hasTargets(model, "team") ? targetColumn(model, "team", (r) => r.teamId, vm.method) : null,
    { key: "status", label: T.columns.status, type: "status", get: (r) => rowStatus(r), hideNarrow: true },
  ].filter(Boolean);
  display(
    dataTable({
      columns,
      rows,
      unit,
      tree: true,
      caption: T.app.pages.teams,
      exportName: `teams_${scope.period.from}_${scope.period.to}`,
      rowHref: (r) => store.href("./team", {}, { id: r.teamId }),
      emptyText: T.teams.empty,
    }),
  );
}
```
