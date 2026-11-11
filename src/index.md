---
title: 全体サマリー
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
import { UNASSIGNED_TEAM_ID, UNASSIGNED_TEAM_LABEL, contractsForTeam } from "./core/index.js";
import { createStore, periodFiscalYear } from "./components/state.js";
import { scopeFor, summarize, seriesWithForecast, priorYearComparison, contractRow, teamRow, teamName } from "./components/analysis.js";
import { pageHeader, sectionTitle, emptyState, note, loadModel } from "./components/layout.js";
import { mountFilterBar } from "./components/filters.js";
import { statTile, kpiRow, statusChip, forecastStatus } from "./components/kpi.js";
import { chartFigure } from "./components/chart-zoom.js";
import { dailyFor, dailySection, loadDaily } from "./components/daily.js";
import { monthlyChart, monthlyLegend, seriesTable, burnMeter } from "./components/charts.js";
import { dataTable, standardColumns, rowStatus, statusSortValue, contractNameCell, contractInfoColumns, teamCountColumns } from "./components/table.js";
import * as bd from "./components/breakdown.js";
import { money, moneySigned, pointsSigned, formatPercent, monthJa, monthSpanJa, periodJa, METHOD_LABELS, fiscalYearLabel, integer } from "./components/format.js";
```

```js
const model = await loadModel(FileAttachment("./data/model.json"), { skeleton: "page-skeleton" });
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
  const { totals, forecast } = summarize(model, scope, state.method);
  const series = seriesWithForecast(model, scope, state.method);
  const compare = priorYearComparison(model, scope);
  const fy = periodFiscalYear(model, scope.period);
  return { scope, totals, forecast, series, compare, fy, unit: state.unit, method: state.method };
})();
```

```js
if (model) {
  display(
    pageHeader({
      model,
      title: T.app.pages.index,
      lead: T.index.lead,
      breadcrumbs: [{ label: T.app.pages.index }],
      includesPreliminary: vm?.totals.includesPreliminary ?? false,
    }),
  );
}
```

```js
if (store) mountFilterBar(store, model);
```

```js
if (vm?.scope.teamMissing) {
  display(note(fmt(T.pages.teamMissing, { team: vm.scope.teamLabel, month: monthJa(vm.scope.treeMonth) }), "warn"));
}
```

```js
if (vm) {
  const { scope, totals, forecast, compare, unit } = vm;
  const asOfMonth = model.meta.asOfMonth;
  const subtitle = `${periodJa(scope.period)} ・ ${scope.teamLabel}`;
  // 前年同期比: タイルの値（期間全体）とは母集団が違うので、何と何を比べたかを文で明示する
  const spanLabel = (p) => monthSpanJa([p.from, p.to]);
  const cmp = (key, { good = null, points = false } = {}) => {
    if (!compare) return { text: T.kpi.noCompare, direction: null, good: null };
    const a = compare.now[key];
    const b = compare.before[key];
    if (a === null || b === null || a === undefined || b === undefined) return { text: T.kpi.noCompare, direction: null, good: null };
    const d = a - b;
    const dir = d > 0 ? "up" : d < 0 ? "down" : "flat";
    const text = fmt(T.kpi.compareText, { diff: points ? pointsSigned(d) : moneySigned(d, unit), current: spanLabel(compare.current), prior: spanLabel(compare.prior), partial: compare.partial ? T.kpi.comparePartial : "" });
    return { text: fmt(T.kpi.compareShort, { diff: points ? pointsSigned(d) : moneySigned(d, unit) }), title: text, direction: dir, good: good === null ? null : good(d) };
  };
  const elapsedLabel = (months) =>
    months.length === 0 ? T.kpi.noElapsed : fmt(T.kpi.elapsed, { span: monthSpanJa(months), n: months.length, prelim: months[months.length - 1] > model.meta.lastFinalMonth ? T.kpi.elapsedPrelim : "" });
  const budgetLabel = vm.fy ? fmt(T.kpi.budgetFy, { fy: fiscalYearLabel(vm.fy) }) : T.kpi.budgetPeriod;
  display(
    kpiRow([
      statTile({
        label: budgetLabel,
        value: money(totals.budget, unit),
        sub: fmt(T.kpi.contractCount, { n: totals.contractCount }),
        compare: cmp("budget"),
        breakdown: () => bd.budgetAggregateSpec({ model, contractIds: scope.contractIds, period: scope.period, unit, label: T.kpi.budgetBreakdownLabel }),
      }),
      statTile({
        label: T.kpi.cost,
        value: money(totals.cost, unit),
        sub: fmt(T.kpi.costSub, { costRatio: formatPercent(totals.grossMargin === null ? null : 1 - totals.grossMargin), hours: integer(Math.round(totals.hours)) }),
        compare: cmp("cost", { good: (d) => d <= 0 }),
        breakdown: () => bd.costAggregateSpec({ model, contractIds: scope.contractIds, period: scope.period, unit, detailHref: (id) => store.href("./contract", {}, { id }) }),
      }),
      statTile({
        label: T.kpi.grossProfit,
        value: money(totals.grossProfit, unit),
        sub: html`${T.kpi.marginPrefix} ${bd.numberButton(formatPercent(totals.grossMargin), () => bd.marginSpec({ totals, unit, subtitle }), { className: "yn-num-inline", ariaLabel: T.kpi.marginAria })}`,
        compare: cmp("grossProfit", { good: (d) => d >= 0 }),
        status: totals.grossProfit < 0 ? { kind: "danger", text: T.kpi.deficit } : null,
        breakdown: () => bd.grossProfitSpec({ budget: totals.budget, cost: totals.cost, unit, subtitle }),
      }),
      statTile({
        label: T.kpi.burnRate,
        value: formatPercent(totals.burnRate),
        sub: html`${burnMeter(totals.burnRate, model.config.burnRateDangerThreshold)}<span>${fmt(T.kpi.burnSub, { elapsed: elapsedLabel(totals.burnRateBreakdown.elapsedMonths), threshold: formatPercent(model.config.burnRateDangerThreshold, 0) })}</span>`,
        status: totals.isOverBudget ? { kind: "danger", text: T.kpi.overBudget } : totals.burnRate === null ? { kind: "neutral", text: T.kpi.noElapsed } : { kind: "ok", text: T.kpi.withinRange },
        breakdown: () => bd.burnRateSpec({ totals, unit, threshold: model.config.burnRateDangerThreshold, asOfMonth, subtitle }),
      }),
      statTile({
        label: fmt(T.kpi.forecast, { fy: fiscalYearLabel(forecast.fiscalYear), method: METHOD_LABELS[forecast.method] }),
        value: money(forecast.forecastGrossProfit, unit),
        sub: fmt(T.kpi.forecastSub, { budget: money(forecast.targetBudget, unit), cost: money(forecast.forecastCost, unit) }),
        status: forecastStatus(forecast),
        breakdown: () => bd.forecastTotalsSpec({ model, totals: forecast, unit, contractIds: scope.contractIds, detailHref: (id) => store.href("./contract", {}, { id }) }),
        emphasis: true,
      }),
    ]),
  );
}
```

```js
if (vm) {
  display(sectionTitle(T.charts.monthlyTitle, fmt(T.index.monthlyHint, { period: periodJa(vm.scope.period), asOfMonth: monthJa(model.meta.asOfMonth), method: METHOD_LABELS[vm.method] })));
}
```

```js
if (vm) {
  display(chartFigure({
    title: T.charts.monthlyTitle,
    subtitle: periodJa(vm.scope.period),
    legend: monthlyLegend(dark),
    draw: (width, height) => monthlyChart({ series: vm.series, unit: vm.unit, dark, width, height, asOfMonth: model.meta.asOfMonth }),
    after: html`<details class="yn-details"><summary>${T.pages.showTable}</summary>${seriesTable(vm.series, { unit: vm.unit, exportName: `monthly_${vm.scope.period.from}_${vm.scope.period.to}` })}</details>`,
  }));
}
```

```js
// 今月の進捗（日別の速報。§61）。読めなければ出さない
const daily = await loadDaily(FileAttachment("./data/daily.json"));
```

```js
if (vm) {
  display(dailySection(dailyFor(model, daily, vm.scope.contractIds ?? model.contracts.map((c) => c.contract.contractId), vm.scope.period), { unit: vm.unit, dark, subtitle: vm.scope.teamLabel, exportName: `daily_${model.meta.asOfMonth}` }));
}
```

```js
if (vm) {
  const { scope, unit, method } = vm;
  const ids = scope.contractIds ? new Set(scope.contractIds) : null;
  const rows = model.contracts
    .filter((r) => !ids || ids.has(r.contract.contractId))
    .filter((r) => r.forecasts[method].isDeficit)
    .map((r) => ({ ...contractRow(model, r, scope.period, method, scope.tree), key: r.contract.contractId }))
    .sort((a, b) => a.forecastGrossProfit - b.forecastGrossProfit);
  display(sectionTitle(T.breakdown.deficitContracts, fmt(T.index.deficitHint, { period: periodJa(scope.period), method: METHOD_LABELS[method] })));
  if (rows.length === 0) {
    display(emptyState({ title: T.index.noDeficitTitle, text: fmt(T.index.noDeficitText, { team: scope.teamLabel }), icon: "✓" }));
  } else {
    const columns = [
      { key: "name", label: T.columns.contract, type: "text", render: (r) => contractNameCell(r), sortValue: (r) => `${r.customerName} ${r.projectName}`, exportValue: (r) => `${r.customerName} / ${r.projectName}` },
      { key: "contractId", label: T.columns.contractId, type: "text", exportOnly: true },
      ...contractInfoColumns(),
      ...standardColumns({ costTypes: model.config.costTypes,
        breakdowns: {
          budget: (r) => bd.budgetAggregateSpec({ model, contractIds: [r.contractId], period: scope.period, unit }),
          cost: (r) => bd.costAggregateSpec({ model, contractIds: [r.contractId], period: scope.period, unit, detailHref: (id) => store.href("./contract", {}, { id }) }),
          grossProfit: (r) => bd.grossProfitSpec({ budget: r.budget, cost: r.cost, unit, subtitle: `${r.customerName} / ${r.projectName}` }),
          margin: (r) => bd.marginSpec({ totals: r.totals, unit, subtitle: `${r.customerName} / ${r.projectName}` }),
          burnRate: (r) => bd.burnRateSpec({ totals: r.totals, unit, threshold: model.config.burnRateDangerThreshold, asOfMonth: model.meta.asOfMonth, subtitle: `${r.customerName} / ${r.projectName}` }),
          forecast: (r) => bd.forecastSpec({ forecast: r.forecast, contract: r.contract, unit, config: model.config, model }),
        },
      }),
      { key: "status", label: T.columns.status, type: "status", get: (r) => rowStatus(r), sortable: false, hideNarrow: true },
    ];
    display(dataTable({ columns, rows, unit, caption: T.breakdown.deficitContracts, exportName: `deficit_contracts_${scope.period.from}_${scope.period.to}`, rowHref: (r) => store.href("./contract", {}, { id: r.contractId }) }));
  }
}
```

```js
if (vm) {
  const { scope, unit, method } = vm;
  const { tree } = scope;
  let targets = [];
  if (scope.teamId && scope.teamId !== UNASSIGNED_TEAM_ID && Object.hasOwn(tree, scope.teamId)) {
    targets = tree[scope.teamId].children.map((id) => tree[id]);
  } else if (!scope.teamId) {
    const roots = Object.values(tree).filter((n) => n.parentTeamId === null);
    targets = roots.length === 1 ? roots[0].children.map((id) => tree[id]) : roots;
    if (roots.length === 1) targets = [roots[0], ...targets];
  }
  // 最上位 1 つ（合計）と直下の組織を並べるときは、直下を一段下げて親子が分かるようにする（チーム一覧と同じ木の表。§115）
  const withRoot = !scope.teamId && targets.length > 1 && targets[0].parentTeamId === null && targets.slice(1).every((n) => n.parentTeamId === targets[0].teamId);
  const rows = targets.map((n, i) => {
    const r = { ...teamRow(model, n.teamId, n.name, n.depth, scope.period, method, tree), key: n.teamId };
    if (!withRoot) return r;
    return i === 0 ? { ...r, depth: 0, parentKey: null, hasChildren: true } : { ...r, depth: 1, parentKey: targets[0].teamId, hasChildren: false };
  });
  if (!scope.teamId) {
    // 未設定（チーム無し）の行は、期間内に契約があるときだけ末尾に出す（チーム一覧と同じ規則）
    const un = teamRow(model, UNASSIGNED_TEAM_ID, UNASSIGNED_TEAM_LABEL, 0, scope.period, method, tree);
    if (un.contractCount > 0) rows.push({ ...un, key: UNASSIGNED_TEAM_ID, ...(withRoot ? { depth: 0, parentKey: null, hasChildren: false } : {}) });
  }
  display(sectionTitle(T.index.byTeam, fmt(T.index.byTeamHint, { scope: scope.teamId ? fmt(T.index.childTeams, { team: scope.teamLabel }) : T.index.byDivision, month: monthJa(scope.treeMonth), fy: fiscalYearLabel(model.meta.fiscalYear) }), html`<a class="yn-btn yn-btn-sm" href=${store.href("./teams")}>${T.index.toTeams}</a>`));
  if (rows.length === 0) {
    display(emptyState({ title: T.index.noChildTitle, text: T.index.noChildText, actions: [{ label: T.index.openContracts, href: store.href("./contracts") }] }));
  } else {
    const columns = [
      { key: "name", label: T.columns.team, type: "text" },
      ...teamCountColumns(),
      ...standardColumns({ costTypes: model.config.costTypes,
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
      { key: "status", label: T.columns.status, type: "status", get: (r) => rowStatus(r), sortable: false, hideNarrow: true },
    ];
    display(dataTable({ columns, rows, unit, tree: withRoot, caption: T.index.byTeamCaption, exportName: `teams_summary_${scope.period.from}_${scope.period.to}`, rowHref: (r) => store.href("./team", {}, { id: r.teamId }) }));
  }
}
```
