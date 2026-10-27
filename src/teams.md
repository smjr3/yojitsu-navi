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
import { UNASSIGNED_TEAM_ID, UNASSIGNED_TEAM_LABEL, aggregate } from "./core/index.js";
import { createStore } from "./components/state.js";
import { scopeFor, flattenTree, teamRow } from "./components/analysis.js";
import { pageHeader, sectionTitle, loadJson, note } from "./components/layout.js";
import { filterBar } from "./components/filters.js";
import { dataTable, standardColumns, rowStatus } from "./components/table.js";
import * as bd from "./components/breakdown.js";
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
    ...teamRow(model, node.teamId, node.name, depth, scope.period, state.method, tree),
    key: node.teamId,
    parentKey: parent,
    hasChildren,
  }));
  const un = teamRow(model, UNASSIGNED_TEAM_ID, UNASSIGNED_TEAM_LABEL, 0, scope.period, state.method, tree);
  rows.push({ ...un, key: UNASSIGNED_TEAM_ID, parentKey: null, hasChildren: false });
  const totals = aggregate(model, { period: scope.period });
  return { scope, rows, totals, unit: state.unit, method: state.method };
})();
```

```js
if (model) {
  display(
    pageHeader({
      model,
      title: "チーム一覧",
      lead: "組織階層（事業部 › 課 › チーム）ごとの予実。上位の行は配下すべてのチームの合計です。行をクリックすると、そのチームの契約一覧に移動します。",
      breadcrumbs: [{ label: "全体サマリー", href: store.href("./") }, { label: "チーム一覧" }],
      includesPreliminary: vm?.totals.includesPreliminary ?? false,
    }),
  );
}
```

```js
if (store) display(filterBar(store, model, { show: ["period", "method", "unit"] }));
```

```js
if (vm) {
  const { scope, rows, unit } = vm;
  display(sectionTitle("組織別の予実", `${periodJa(scope.period)} ・ ${monthJa(scope.period.to)} 時点の組織で表示 ・ 着地: ${METHOD_LABELS[vm.method]}（${model.meta.fiscalYear}年度）`));
  if (scope.period.to !== model.meta.asOfMonth) {
    display(note(`過去月の組織はその月時点のもので集計しています。現在（${monthJa(model.meta.asOfMonth)}）の組織と異なる場合があります。`));
  }
  const columns = [
    { key: "name", label: "チーム", type: "text" },
    { key: "contractCount", label: "契約数", type: "int", hideOnPhone: true },
    ...standardColumns({
      breakdowns: {
        budget: (r) => bd.budgetAggregateSpec({ model, contractIds: r.contractIds, period: scope.period, unit }),
        cost: (r) => bd.costAggregateSpec({ model, contractIds: r.contractIds, period: scope.period, unit, detailHref: (id) => store.href("./contract", {}, { id }) }),
        grossProfit: (r) => bd.grossProfitSpec({ budget: r.budget, cost: r.cost, unit, subtitle: r.name }),
        margin: (r) => bd.marginSpec({ budget: r.budget, cost: r.cost, unit, subtitle: r.name }),
        burnRate: (r) => bd.burnRateSpec({ totals: r.totals, unit, threshold: model.config.burnRateDangerThreshold, asOfMonth: model.meta.asOfMonth, subtitle: r.name }),
        forecast: (r) => bd.forecastTotalsSpec({ model, totals: r.forecast, unit, contractIds: r.contractIds, detailHref: (id) => store.href("./contract", {}, { id }) }),
      },
    }),
    { key: "status", label: "状態", type: "status", get: (r) => (r.deficitCount > 0 ? { kind: "danger", text: `赤字見込み ${r.deficitCount}件` } : rowStatus(r)) },
  ];
  display(
    dataTable({
      columns,
      rows,
      unit,
      tree: true,
      caption: "チーム一覧",
      exportName: `teams_${scope.period.from}_${scope.period.to}`,
      rowHref: (r) => store.href("./contracts", { team: r.teamId }),
      emptyText: "チームがありません",
    }),
  );
}
```
