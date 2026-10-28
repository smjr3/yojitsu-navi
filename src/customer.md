---
title: 顧客詳細
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
import { UNASSIGNED_TEAM_ID, UNASSIGNED_TEAM_LABEL } from "./core/index.js";
import { createStore, periodFiscalYear } from "./components/state.js";
import { scopeFor, summarize, seriesWithForecast, priorYearComparison, contractRow, teamName, treeAt, treeMonthFor } from "./components/analysis.js";
import { customerGroups, idsRow, groupBreakdowns, contractListColumns } from "./components/customers.js";
import { pageHeader, sectionTitle, emptyState, loadJson, note } from "./components/layout.js";
import { mountFilterBar } from "./components/filters.js";
import { statTile, kpiRow } from "./components/kpi.js";
import { chartFigure } from "./components/chart-zoom.js";
import { monthlyChart, monthlyLegend, seriesTable, burnMeter } from "./components/charts.js";
import { dataTable, standardColumns, rowStatus, statusSortValue, teamCountColumns, withForecastCount } from "./components/table.js";
import * as bd from "./components/breakdown.js";
import { money, moneySigned, pointsSigned, formatPercent, monthJa, monthSpanJa, periodJa, METHOD_LABELS, fiscalYearLabel, integer } from "./components/format.js";
```

```js
const model = await loadJson(FileAttachment("./data/model.json"), { skeleton: "page-skeleton" });
// URLSearchParams が %XX を復号する（一覧のリンクは encodeURIComponent で作る）
const customerKey = new URLSearchParams(location.search).get("key") ?? "";
const group = model ? customerGroups(model).find((g) => g.key === customerKey) ?? null : null;
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
// 契約一覧の期間外表示（ページ内の状態）
const listFilter = { showOutside: false };
```

```js
const vm = (() => {
  if (!model || !state || !group) return null;
  const period = { from: state.from, to: state.to };
  // チームを絞っているときは、そのチーム（配下含む）の契約だけで集計する（顧客別の一覧と同じ。L3）
  const teamScope = scopeFor(model, state);
  const inTeam = teamScope.contractIds ? new Set(teamScope.contractIds) : null;
  const contractIds = inTeam ? group.contractIds.filter((id) => inTeam.has(id)) : group.contractIds;
  const scope = { period, contractIds, teamId: state.team, teamLabel: teamScope.teamLabel, teamMissing: teamScope.teamMissing };
  const { totals, forecast } = summarize(model, scope, state.method);
  const series = seriesWithForecast(model, scope, state.method);
  const compare = priorYearComparison(model, scope);
  const { tree } = treeAt(model, treeMonthFor(model, period));
  return { scope, totals, forecast, series, compare, tree, fy: periodFiscalYear(model, period), unit: state.unit, method: state.method };
})();
```

```js
if (model && !group) {
  display(
    pageHeader({
      model,
      title: T.customer.pageTitle,
      breadcrumbs: [{ label: T.app.pages.index, href: store.href("./") }, { label: T.app.pages.customers, href: store.href("./customers") }, { label: T.customer.notFoundCrumb }],
    }),
  );
  display(
    emptyState({
      title: customerKey ? fmt(T.customer.notFoundTitle, { customer: customerKey }) : T.customer.noKeyTitle,
      text: customerKey ? T.customer.notFoundText : T.customer.noKeyText,
      actions: [{ label: T.customer.back, href: store.href("./customers") }],
    }),
  );
}
```

```js
if (vm) {
  display(
    pageHeader({
      model,
      title: group.label,
      lead: fmt(T.customer.lead, { n: vm.scope.contractIds.length }),
      breadcrumbs: [{ label: T.app.pages.index, href: store.href("./") }, { label: T.app.pages.customers, href: store.href("./customers") }, { label: group.label }],
      includesPreliminary: vm.totals.includesPreliminary,
    }),
  );
}
```

```js
if (store && group) mountFilterBar(store, model, { show: ["period", "team", "method", "unit"] });
```

```js
// チームで絞っているときは数字が顧客全体と変わるので明示する（外れたら消えるよう、無いときは空の要素を出す）
if (vm) {
  display(
    vm.scope.teamId
      ? note(
          fmt(T.customer.teamFiltered, { team: vm.scope.teamLabel, total: group.contractIds.length, n: vm.scope.contractIds.length }),
          vm.scope.contractIds.length === 0 ? "warn" : "info",
        )
      : html`<div></div>`,
  );
}
```

```js
if (vm) {
  const { scope, totals, forecast, compare, unit } = vm;
  const asOfMonth = model.meta.asOfMonth;
  const subtitle = `${group.label} ・ ${periodJa(scope.period)}`;
  // 前年同期比: 全体サマリーと同じ規則（経過月の累計を 12 か月前の同じ月と比べる）。タイルの値（期間全体）とは母集団が違うので文で明示する
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
  const deficitCount = forecast.deficitContractIds.length;
  const detailHref = (id) => store.href("./contract", {}, { id });
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
        breakdown: () => bd.costAggregateSpec({ model, contractIds: scope.contractIds, period: scope.period, unit, detailHref }),
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
        sub: fmt(T.kpi.forecastSub, { budget: money(forecast.fyBudget, unit), cost: money(forecast.forecastCost, unit) }),
        status: deficitCount > 0 ? { kind: "danger", text: fmt(T.kpi.deficitCount, { n: deficitCount }) } : { kind: "ok", text: T.kpi.noDeficit },
        breakdown: () => bd.forecastTotalsSpec({ model, totals: forecast, unit, contractIds: scope.contractIds, detailHref }),
        emphasis: true,
      }),
    ]),
  );
}
```

```js
if (vm) {
  display(sectionTitle(T.charts.monthlyTitle, fmt(T.index.monthlyHint, { period: periodJa(vm.scope.period), asOfMonth: monthJa(model.meta.asOfMonth), method: METHOD_LABELS[vm.method] })));
  display(chartFigure({
    title: T.charts.monthlyTitle,
    subtitle: periodJa(vm.scope.period),
    legend: monthlyLegend(dark),
    draw: (width, height) => monthlyChart({ series: vm.series, unit: vm.unit, dark, width, height, asOfMonth: model.meta.asOfMonth }),
    after: html`<details class="yn-details"><summary>${T.pages.showTable}</summary>${seriesTable(vm.series, { unit: vm.unit, exportName: `customer_monthly_${vm.scope.period.from}_${vm.scope.period.to}` })}</details>`,
  }));
}
```

```js
// 契約一覧の「期間外の契約も表示」（モデルだけに依存して 1 回だけ描く）
const outsideToggle = (() => {
  if (!model || !group) return null;
  const input = html`<input type="checkbox" id="yn-f-showOutside" checked=${listFilter.showOutside}>`;
  const form = html`<form class="yn-chip-filters" role="group" aria-label=${T.contracts.filterLabel}><label class="yn-toggle-chip" for="yn-f-showOutside" title=${T.contracts.chipOutsideTitle}>${input}<span>${T.contracts.chipOutside}</span></label></form>`;
  form.addEventListener("submit", (ev) => ev.preventDefault());
  input.addEventListener("change", () => {
    listFilter.showOutside = input.checked;
    form.value = { ...listFilter };
    form.dispatchEvent(new CustomEvent("input", { bubbles: true }));
  });
  form.value = { ...listFilter };
  return form;
})();
```

```js
const outsideState = outsideToggle ? Generators.input(outsideToggle) : null;
```

```js
if (vm) {
  const { scope, unit } = vm;
  const f = outsideState ?? listFilter;
  const all = scope.contractIds.map((id) => {
    const r = model.contracts.find((x) => x.contract.contractId === id);
    return { ...contractRow(model, r, scope.period, vm.method, vm.tree), key: id };
  });
  const rows = all.filter((r) => f.showOutside || r.inPeriod);
  const hidden = all.length - all.filter((r) => r.inPeriod).length;
  display(
    sectionTitle(
      T.customer.contractsTitle,
      fmt(T.customer.contractsHint, { period: periodJa(scope.period), method: METHOD_LABELS[vm.method], fy: fiscalYearLabel(model.meta.fiscalYear) }),
      null,
      hidden > 0 && !f.showOutside ? fmt(T.customer.hiddenOutside, { n: hidden }) : null,
    ),
  );
  if (outsideToggle && hidden > 0) display(outsideToggle);
  if (rows.length === 0) {
    display(emptyState({ title: T.customer.noContractsTitle, text: T.customer.noContractsText, icon: "○" }));
  } else {
    display(
      dataTable({
        columns: contractListColumns({ model, store, period: scope.period, unit }),
        rows,
        unit,
        caption: T.customer.contractsCaption,
        exportName: `customer_contracts_${scope.period.from}_${scope.period.to}`,
        sort: { key: "status", dir: "asc" },
        rowHref: (r) => store.href("./contract", {}, { id: r.contractId }),
      }),
    );
  }
}
```

```js
if (vm) {
  const { scope, unit, method, tree } = vm;
  // 契約の teamId ごと（配下をまとめず、契約に登録された主担当チームそのもの）
  const byTeam = new Map();
  for (const id of scope.contractIds) {
    const c = model.contracts.find((x) => x.contract.contractId === id).contract;
    const tid = c.teamId ? c.teamId : UNASSIGNED_TEAM_ID;
    if (!byTeam.has(tid)) byTeam.set(tid, []);
    byTeam.get(tid).push(id);
  }
  const rows = [...byTeam.entries()]
    .map(([tid, ids]) => ({ ...idsRow(model, ids, scope.period, method, { name: tid === UNASSIGNED_TEAM_ID ? UNASSIGNED_TEAM_LABEL : teamName(model, tid, tree), teamId: tid }), key: tid }))
    .filter((r) => r.contractCount > 0 || r.fyContractCount > 0);
  display(sectionTitle(T.customer.byTeamTitle, fmt(T.customer.byTeamHint, { customer: group.label, month: monthJa(treeMonthFor(model, scope.period)) })));
  if (rows.length === 0) {
    display(emptyState({ title: T.customer.noContractsTitle, text: T.customer.changePeriod, icon: "○" }));
  } else {
    const columns = [
      { key: "name", label: T.columns.team, type: "text" },
      ...teamCountColumns(),
      ...standardColumns({ breakdowns: groupBreakdowns({ model, store, period: scope.period, unit }) }).map(withForecastCount),
      { key: "status", label: T.columns.status, type: "status", get: (r) => rowStatus(r), sortValue: (r) => statusSortValue(r), hideNarrow: true },
    ];
    display(
      dataTable({
        columns,
        rows,
        unit,
        caption: T.customer.byTeamTitle,
        exportName: `customer_teams_${scope.period.from}_${scope.period.to}`,
        sort: { key: "status", dir: "asc" },
        rowHref: (r) => store.href("./contracts", { team: r.teamId }, { customer: group.key, direct: 1 }),
      }),
    );
  }
}
```

```js
// 工数の明細（SPEC §30）。この表だけが使うので、他の表示を待たせずに後から読む
import { decodeWorkRows, filterWorkRows, monthRange } from "./core/index.js";
import { workTaskSection } from "./components/work.js";
const workRows = FileAttachment("./data/work-hours.json").json().then((d) => decodeWorkRows(d)).catch(() => null);
```

```js
if (vm && workRows) {
  // チームで絞っているときは、契約内はその契約だけ（契約外は顧客の行をそのまま）
  const ids = new Set(vm.scope.contractIds);
  const rows = filterWorkRows(workRows, { period: vm.scope.period, customerKeys: [group.key] }).filter((r) => r.category === "outside" || ids.has(r.contractId));
  display(
    workTaskSection({
      rows,
      months: monthRange(vm.scope.period.from, vm.scope.period.to).filter((m) => m <= model.meta.asOfMonth),
      unit: vm.unit,
      config: model.config,
      hint: fmt(T.work.sectionHintScope, { period: periodJa(vm.scope.period), name: group.label }),
      exportName: `customer_tasks_${vm.scope.period.from}_${vm.scope.period.to}`,
    }),
  );
}
```
