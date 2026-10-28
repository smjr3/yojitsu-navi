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
import { mountFilterBar } from "./components/filters.js";
import { statTile, kpiRow, statusChip } from "./components/kpi.js";
import { monthlyChart, monthlyLegend, seriesTable, burnMeter } from "./components/charts.js";
import { dataTable, standardColumns, rowStatus, statusSortValue, contractNameCell, teamCountColumns, withForecastCount } from "./components/table.js";
import * as bd from "./components/breakdown.js";
import { money, moneySigned, pointsSigned, formatPercent, monthJa, monthSpanJa, periodJa, METHOD_LABELS, fiscalYearLabel, integer } from "./components/format.js";
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
if (store) mountFilterBar(store, model);
```

```js
if (vm?.scope.teamMissing) {
  display(note(`選択したチーム「${vm.scope.teamLabel}」は ${monthJa(vm.scope.treeMonth)} 時点の組織に存在しません（期間の終了月か基準月より後に発効する組織です）。契約は 0 件として集計しています。`, "warn"));
}
```

```js
if (vm) {
  const { scope, totals, forecast, compare, unit } = vm;
  const asOfMonth = model.meta.asOfMonth;
  const subtitle = `${periodJa(scope.period)} ・ ${scope.teamLabel}`;
  // 前年同期比: タイルの値（期間全体）とは母集団が違うので、何と何を比べたかを文で明示する
  const spanLabel = (p) => (p.from === p.to ? monthJa(p.from) : p.from.slice(0, 4) === p.to.slice(0, 4) ? `${monthJa(p.from)}〜${Number(p.to.slice(5, 7))}月` : `${monthJa(p.from)}〜${monthJa(p.to)}`);
  const cmp = (key, { good = null, points = false } = {}) => {
    if (!compare) return { text: "前年同期の比較データなし", direction: null, good: null };
    const a = compare.now[key];
    const b = compare.before[key];
    if (a === null || b === null || a === undefined || b === undefined) return { text: "前年同期の比較データなし", direction: null, good: null };
    const d = a - b;
    const dir = d > 0 ? "up" : d < 0 ? "down" : "flat";
    const text = `${points ? pointsSigned(d) : moneySigned(d, unit)} ・ ${spanLabel(compare.current)}の累計を前年同期（${spanLabel(compare.prior)}）と比較${compare.partial ? "。前年はデータのある月のみ" : ""}`;
    return { text, direction: dir, good: good === null ? null : good(d) };
  };
  const elapsedLabel = (months) =>
    months.length === 0 ? "経過月なし" : `${monthSpanJa(months)}の${months.length}か月${months[months.length - 1] > model.meta.lastFinalMonth ? "（速報含む）" : ""}`;
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
        sub: `原価率 ${formatPercent(totals.grossMargin === null ? null : 1 - totals.grossMargin)} ・ ${integer(Math.round(totals.hours))}h`,
        compare: cmp("cost", { good: (d) => d <= 0 }),
        breakdown: () => bd.costAggregateSpec({ model, contractIds: scope.contractIds, period: scope.period, unit, detailHref: (id) => store.href("./contract", {}, { id }) }),
      }),
      statTile({
        label: "粗利",
        value: money(totals.grossProfit, unit),
        sub: html`粗利率 ${bd.numberButton(formatPercent(totals.grossMargin), () => bd.marginSpec({ totals, unit, subtitle }), { className: "yn-num-inline", ariaLabel: "粗利率の計算根拠を表示" })}`,
        compare: cmp("grossProfit", { good: (d) => d >= 0 }),
        status: totals.grossProfit < 0 ? { kind: "danger", text: "赤字" } : null,
        breakdown: () => bd.grossProfitSpec({ budget: totals.budget, cost: totals.cost, unit, subtitle }),
      }),
      statTile({
        label: "消化率（経過月の累計）",
        value: formatPercent(totals.burnRate),
        sub: html`${burnMeter(totals.burnRate, model.config.burnRateDangerThreshold)}<span>${elapsedLabel(totals.burnRateBreakdown.elapsedMonths)} ・ 基準 ${formatPercent(model.config.burnRateDangerThreshold, 0)}</span>`,
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
      { key: "name", label: "契約", type: "text", render: (r) => contractNameCell(r), sortValue: (r) => `${r.customerName} ${r.projectName}`, exportValue: (r) => `${r.customerName} / ${r.projectName}` },
      { key: "contractId", label: "契約ID", type: "text", exportOnly: true },
      { key: "teamName", label: "チーム", type: "text", exportOnly: true },
      { key: "period", label: "契約期間", type: "text", exportOnly: true, get: (r) => `${r.startMonth}〜${r.endMonth}` },
      ...standardColumns({
        breakdowns: {
          budget: (r) => bd.budgetAggregateSpec({ model, contractIds: [r.contractId], period: scope.period, unit }),
          cost: (r) => bd.costAggregateSpec({ model, contractIds: [r.contractId], period: scope.period, unit, detailHref: (id) => store.href("./contract", {}, { id }) }),
          grossProfit: (r) => bd.grossProfitSpec({ budget: r.budget, cost: r.cost, unit, subtitle: `${r.contractId} ${r.customerName} / ${r.projectName}` }),
          margin: (r) => bd.marginSpec({ totals: r.totals, unit, subtitle: `${r.contractId} ${r.customerName} / ${r.projectName}` }),
          burnRate: (r) => bd.burnRateSpec({ totals: r.totals, unit, threshold: model.config.burnRateDangerThreshold, asOfMonth: model.meta.asOfMonth, subtitle: `${r.contractId} ${r.customerName} / ${r.projectName}` }),
          forecast: (r) => bd.forecastSpec({ forecast: r.forecast, contract: r.contract, unit, config: model.config }),
        },
      }),
      { key: "status", label: "状態", type: "status", get: (r) => rowStatus(r), sortable: false, hideNarrow: true },
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
  if (scope.teamId && scope.teamId !== UNASSIGNED_TEAM_ID && Object.hasOwn(tree, scope.teamId)) {
    targets = tree[scope.teamId].children.map((id) => tree[id]);
  } else if (!scope.teamId) {
    const roots = Object.values(tree).filter((n) => n.parentTeamId === null);
    targets = roots.length === 1 ? roots[0].children.map((id) => tree[id]) : roots;
    if (roots.length === 1) targets = [roots[0], ...targets];
  }
  const rows = targets.map((n) => ({ ...teamRow(model, n.teamId, n.name, n.depth, scope.period, method, tree), key: n.teamId }));
  if (!scope.teamId) {
    // 未設定（チーム無し）の行は、期間内に契約があるときだけ末尾に出す（チーム一覧と同じ規則）
    const un = teamRow(model, UNASSIGNED_TEAM_ID, UNASSIGNED_TEAM_LABEL, 0, scope.period, method, tree);
    if (un.contractCount > 0) rows.push({ ...un, key: UNASSIGNED_TEAM_ID });
  }
  display(sectionTitle("チーム別", `${scope.teamId ? `${scope.teamLabel} の配下チーム` : "事業部ごとの集計"}（${monthJa(scope.treeMonth)} 時点の組織）。契約数は期間内の契約、着地粗利は ${fiscalYearLabel(model.meta.fiscalYear)} に掛かる契約（件数を併記）が母集団です。行をクリックするとそのチームの詳細に移動します。`, html`<a class="yn-btn yn-btn-sm" href=${store.href("./teams")}>チーム一覧へ</a>`));
  if (rows.length === 0) {
    display(emptyState({ title: "配下のチームはありません", text: "このチームは末端のチームです。契約一覧で契約ごとの数値を確認できます。", actions: [{ label: "契約一覧を開く", href: store.href("./contracts") }] }));
  } else {
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
      { key: "status", label: "状態", type: "status", get: (r) => rowStatus(r), sortable: false, hideNarrow: true },
    ];
    display(dataTable({ columns, rows, unit, caption: "チーム別の集計", exportName: `teams_summary_${scope.period.from}_${scope.period.to}`, rowHref: (r) => store.href("./team", {}, { id: r.teamId }) }));
  }
}
```
