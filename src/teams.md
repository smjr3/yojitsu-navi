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
import { mountFilterBar } from "./components/filters.js";
import { dataTable, standardColumns, rowStatus, teamCountColumns, withForecastCount } from "./components/table.js";
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
      title: "チーム一覧",
      lead: "組織階層（事業部 › 課 › チーム）ごとの予実。上位の行は配下すべてのチームの合計です。行をクリックすると、そのチームの契約一覧に移動します。",
      breadcrumbs: [{ label: "全体サマリー", href: store.href("./") }, { label: "チーム一覧" }],
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
  display(sectionTitle("組織別の予実", `${periodJa(scope.period)} ・ ${monthJa(scope.treeMonth)} 時点の組織で表示 ・ 着地: ${METHOD_LABELS[vm.method]}（${model.meta.fiscalYear}年度）。契約数は期間内の契約、着地粗利は年度に掛かる契約（件数を併記）が母集団です。状態の「赤字 N件」は配下で赤字見込みの契約数、「予算超過」は消化率が基準超。`));
  if (scope.period.to < model.meta.asOfMonth) {
    display(note(`期間の終了月（${monthJa(scope.period.to)}）時点の組織で集計しています。現在（${monthJa(model.meta.asOfMonth)}）の組織と異なる場合があります。`));
  }
  const columns = [
    { key: "name", label: "チーム", type: "text" },
    ...teamCountColumns(),
    ...standardColumns({
      forecastLabel: "着地粗利",
      breakdowns: {
        budget: (r) => bd.budgetAggregateSpec({ model, contractIds: r.contractIds, period: scope.period, unit }),
        cost: (r) => bd.costAggregateSpec({ model, contractIds: r.contractIds, period: scope.period, unit, detailHref: (id) => store.href("./contract", {}, { id }) }),
        grossProfit: (r) => bd.grossProfitSpec({ budget: r.budget, cost: r.cost, unit, subtitle: r.name }),
        margin: (r) => bd.marginSpec({ totals: r.totals, unit, subtitle: r.name }),
        burnRate: (r) => bd.burnRateSpec({ totals: r.totals, unit, threshold: model.config.burnRateDangerThreshold, asOfMonth: model.meta.asOfMonth, subtitle: r.name }),
        forecast: (r) => bd.forecastTotalsSpec({ model, totals: r.forecast, unit, contractIds: r.contractIds, detailHref: (id) => store.href("./contract", {}, { id }) }),
      },
    }).map(withForecastCount),
    { key: "status", label: "状態", type: "status", get: (r) => rowStatus(r), hideNarrow: true },
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
