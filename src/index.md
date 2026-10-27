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
import { UNASSIGNED_TEAM_ID, UNASSIGNED_TEAM_LABEL, contractsForTeam } from "./core/index.js";
import { createStore, periodFiscalYear } from "./components/state.js";
import { scopeFor, summarize, seriesWithForecast, priorYearComparison, contractRow, teamRow, teamName } from "./components/analysis.js";
import { pageHeader, sectionTitle, emptyState, loadJson, note } from "./components/layout.js";
import { filterBar } from "./components/filters.js";
import { statTile, kpiRow, statusChip } from "./components/kpi.js";
import { monthlyChart, monthlyLegend, seriesTable, burnMeter } from "./components/charts.js";
import { dataTable, standardColumns, rowStatus } from "./components/table.js";
import * as bd from "./components/breakdown.js";
import { money, moneySigned, pointsSigned, formatPercent, monthJa, periodJa, METHOD_LABELS, fiscalYearLabel } from "./components/format.js";
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
      title: "全体サマリー",
      lead: "保守契約の予算（契約額の月割り）と原価（工数 × 単価）を突き合わせ、粗利と年度末の着地見込みを見る画面です。数値をクリックすると計算根拠が開きます。",
      breadcrumbs: [{ label: "全体サマリー" }],
      includesPreliminary: vm?.totals.includesPreliminary ?? false,
    }),
  );
}
```

```js
if (store) display(filterBar(store, model));
```

```js
if (vm) {
  const { scope, totals, forecast, compare, unit } = vm;
  const asOfMonth = model.meta.asOfMonth;
  const subtitle = `${periodJa(scope.period)} ・ ${scope.teamLabel}`;
  const cmp = (key, { good = null, points = false } = {}) => {
    if (!compare) return { text: "前年同期の比較データなし", direction: null, good: null };
    const a = compare.now[key];
    const b = compare.before[key];
    if (a === null || b === null || a === undefined || b === undefined) return { text: "前年同期の比較データなし", direction: null, good: null };
    const d = a - b;
    const dir = d > 0 ? "up" : d < 0 ? "down" : "flat";
    const text = `${points ? pointsSigned(d) : moneySigned(d, unit)} 前年同期（${monthJa(compare.prior.from)}〜${monthJa(compare.prior.to)}）比`;
    return { text, direction: dir, good: good === null ? null : good(d) };
  };
  const budgetLabel = vm.fy ? `年度予算（${fiscalYearLabel(vm.fy)}）` : "期間の予算";
  const deficitCount = forecast.deficitContractIds.length;
  display(
    kpiRow([
      statTile({
        label: budgetLabel,
        value: money(totals.budget, unit),
        sub: `${totals.contractCount}件の契約`,
        compare: cmp("budget"),
        breakdown: () => bd.budgetAggregateSpec({ model, contractIds: scope.contractIds, period: scope.period, unit, label: "予算" }),
      }),
      statTile({
        label: "原価（工数原価）",
        value: money(totals.cost, unit),
        sub: `${formatPercent(totals.budget ? totals.cost / totals.budget : null)} / 予算 ・ ${Math.round(totals.hours).toLocaleString("ja-JP")}h`,
        compare: cmp("cost", { good: (d) => d <= 0 }),
        breakdown: () => bd.costAggregateSpec({ model, contractIds: scope.contractIds, period: scope.period, unit, detailHref: (id) => store.href("./contract", {}, { id }) }),
      }),
      statTile({
        label: "粗利",
        value: money(totals.grossProfit, unit),
        sub: html`粗利率 ${bd.numberButton(formatPercent(totals.grossMargin), () => bd.marginSpec({ budget: totals.budget, cost: totals.cost, unit, subtitle }), { className: "yn-num-inline", ariaLabel: "粗利率の計算根拠を表示" })}`,
        compare: cmp("grossProfit", { good: (d) => d >= 0 }),
        status: totals.grossProfit < 0 ? { kind: "danger", text: "赤字" } : null,
        breakdown: () => bd.grossProfitSpec({ budget: totals.budget, cost: totals.cost, unit, subtitle }),
      }),
      statTile({
        label: "消化率（経過月の累計）",
        value: formatPercent(totals.burnRate),
        sub: html`${burnMeter(totals.burnRate, model.config.burnRateDangerThreshold)}<span>${totals.burnRateBreakdown.elapsedMonths.length}か月経過 ・ 基準 ${formatPercent(model.config.burnRateDangerThreshold, 0)}</span>`,
        status: totals.isOverBudget ? { kind: "danger", text: "予算超過" } : totals.burnRate === null ? { kind: "neutral", text: "経過月なし" } : { kind: "ok", text: "範囲内" },
        breakdown: () => bd.burnRateSpec({ totals, unit, threshold: model.config.burnRateDangerThreshold, asOfMonth, subtitle }),
      }),
      statTile({
        label: `着地見込み粗利（${fiscalYearLabel(forecast.fiscalYear)}・${METHOD_LABELS[forecast.method]}）`,
        value: money(forecast.forecastGrossProfit, unit),
        sub: `年度予算 ${money(forecast.fyBudget, unit)} − 着地原価 ${money(forecast.forecastCost, unit)}`,
        status: deficitCount > 0 ? { kind: "danger", text: `赤字見込み ${deficitCount}件` } : { kind: "ok", text: "赤字見込みなし" },
        breakdown: () => bd.forecastTotalsSpec({ model, totals: forecast, unit, contractIds: scope.contractIds, detailHref: (id) => store.href("./contract", {}, { id }) }),
        emphasis: true,
      }),
    ]),
  );
}
```

```js
if (vm) {
  display(sectionTitle("月次推移", `${periodJa(vm.scope.period)} の予算・原価・粗利。${monthJa(model.meta.asOfMonth)} 以降は着地見込み（${METHOD_LABELS[vm.method]}）です。`));
}
```

```js
if (vm) {
  display(html`<figure class="yn-card yn-chart-card">
    ${monthlyLegend(dark)}
    ${resize((width) => monthlyChart({ series: vm.series, unit: vm.unit, dark, width, asOfMonth: model.meta.asOfMonth }))}
    <details class="yn-details"><summary>表で見る</summary>${seriesTable(vm.series, { unit: vm.unit, exportName: `monthly_${vm.scope.period.from}_${vm.scope.period.to}` })}</details>
  </figure>`);
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
  display(sectionTitle("赤字見込みの契約", `${fiscalYearLabel(model.meta.fiscalYear)} の着地粗利がマイナスになる契約（${METHOD_LABELS[method]}）。クリックで契約詳細へ。`));
  if (rows.length === 0) {
    display(emptyState({ title: "赤字見込みの契約はありません", text: `${scope.teamLabel} の契約はすべて黒字で着地する見込みです。`, icon: "✓" }));
  } else {
    const columns = [
      { key: "contractId", label: "契約ID", type: "text", width: "6rem" },
      { key: "name", label: "顧客 / 案件", type: "text", get: (r) => `${r.customerName} / ${r.projectName}` },
      { key: "teamName", label: "チーム", type: "text", hideOnPhone: true },
      ...standardColumns({
        breakdowns: {
          budget: (r) => bd.budgetAggregateSpec({ model, contractIds: [r.contractId], period: scope.period, unit }),
          cost: (r) => bd.costAggregateSpec({ model, contractIds: [r.contractId], period: scope.period, unit, detailHref: (id) => store.href("./contract", {}, { id }) }),
          grossProfit: (r) => bd.grossProfitSpec({ budget: r.budget, cost: r.cost, unit, subtitle: `${r.contractId} ${r.customerName} / ${r.projectName}` }),
          margin: (r) => bd.marginSpec({ budget: r.budget, cost: r.cost, unit, subtitle: `${r.contractId} ${r.customerName} / ${r.projectName}` }),
          burnRate: (r) => bd.burnRateSpec({ totals: r.totals, unit, threshold: model.config.burnRateDangerThreshold, asOfMonth: model.meta.asOfMonth, subtitle: `${r.contractId} ${r.customerName} / ${r.projectName}` }),
          forecast: (r) => bd.forecastSpec({ forecast: r.forecast, contract: r.contract, unit, config: model.config }),
        },
      }),
      { key: "status", label: "状態", type: "status", get: (r) => rowStatus(r), sortable: false },
    ];
    display(dataTable({ columns, rows, unit, caption: "赤字見込みの契約", exportName: `deficit_contracts_${scope.period.from}_${scope.period.to}`, rowHref: (r) => store.href("./contract", {}, { id: r.contractId }) }));
  }
}
```

```js
if (vm) {
  const { scope, unit, method } = vm;
  const { tree } = scope;
  let targets = [];
  if (scope.teamId && scope.teamId !== UNASSIGNED_TEAM_ID && tree[scope.teamId]) {
    targets = tree[scope.teamId].children.map((id) => tree[id]);
  } else if (!scope.teamId) {
    const roots = Object.values(tree).filter((n) => n.parentTeamId === null);
    targets = roots.length === 1 ? roots[0].children.map((id) => tree[id]) : roots;
    if (roots.length === 1) targets = [roots[0], ...targets];
  }
  const rows = targets.map((n) => ({ ...teamRow(model, n.teamId, n.name, n.depth, scope.period, method, tree), key: n.teamId }));
  if (!scope.teamId) {
    const un = teamRow(model, UNASSIGNED_TEAM_ID, UNASSIGNED_TEAM_LABEL, 0, scope.period, method, tree);
    if (un.contractIds.length) rows.push({ ...un, key: UNASSIGNED_TEAM_ID });
  }
  display(sectionTitle("チーム別", scope.teamId ? `${scope.teamLabel} の配下チーム（${monthJa(scope.period.to)} 時点の組織）` : `事業部ごとの集計（${monthJa(scope.period.to)} 時点の組織）。行をクリックすると契約一覧に絞り込みます。`, html`<a class="yn-btn yn-btn-sm" href=${store.href("./teams")}>チーム一覧へ</a>`));
  if (rows.length === 0) {
    display(emptyState({ title: "配下のチームはありません", text: "このチームは末端のチームです。契約一覧で契約ごとの数値を確認できます。", actions: [{ label: "契約一覧を開く", href: store.href("./contracts") }] }));
  } else {
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
      { key: "status", label: "状態", type: "status", get: (r) => (r.deficitCount > 0 ? { kind: "danger", text: `赤字見込み ${r.deficitCount}件` } : rowStatus(r)), sortable: false },
    ];
    display(dataTable({ columns, rows, unit, caption: "チーム別の集計", exportName: `teams_summary_${scope.period.from}_${scope.period.to}`, rowHref: (r) => store.href("./contracts", { team: r.teamId }) }));
  }
}
```
