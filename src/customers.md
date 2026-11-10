---
title: 顧客別
---

<div id="page-skeleton" class="yn-skeleton" aria-busy="true" aria-label="読み込み中">
  <div class="yn-skel-line yn-skel-title"></div>
  <div class="yn-skel-line"></div>
  <div class="yn-skel-block"></div>
</div>

```js
import { html } from "htl";
import { T, fmt } from "./i18n/index.js";
import { aggregate, forecastTotals, normalizeName } from "./core/index.js";
import { createStore } from "./components/state.js";
import { onTextInput } from "./components/text-input.js";
import { scopeFor } from "./components/analysis.js";
import { customerGroups, customerHref, idsRow, groupBreakdowns } from "./components/customers.js";
import { pageHeader, sectionTitle, emptyState, note, loadModel } from "./components/layout.js";
import { mountFilterBar } from "./components/filters.js";
import { dataTable, standardColumns, rowStatus, statusSortValue, teamCountColumns } from "./components/table.js";
import * as bd from "./components/breakdown.js";
import { hasTargets, targetColumn } from "./components/targets.js";
import { monthJa, periodJa, METHOD_LABELS } from "./components/format.js";
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
// 一覧専用の絞り込み（検索語は URL の q。ページ内の状態）
const listFilter = { text: new URLSearchParams(location.search).get("q") ?? "", showOutside: new URLSearchParams(location.search).get("f") === "outside" };
// 検索語と「期間外も表示」を URL に書き戻す（詳細から「戻る」で復元するため）
function writeListFilter(lf) {
  const url = new URL(location.href);
  if (lf.showOutside) url.searchParams.set("f", "outside");
  else url.searchParams.delete("f");
  if (lf.text) url.searchParams.set("q", lf.text);
  else url.searchParams.delete("q");
  history.replaceState(history.state, "", url);
}
```

```js
const groups = model ? customerGroups(model) : [];
```

```js
const vm = (() => {
  if (!model || !state) return null;
  const scope = scopeFor(model, state);
  // チームで絞ると、そのチーム（配下含む）の契約だけで顧客を集計する。契約が 1 件も残らない顧客は出さない
  const inTeam = scope.contractIds ? new Set(scope.contractIds) : null;
  const all = groups
    .map((g) => ({ g, ids: inTeam ? g.contractIds.filter((id) => inTeam.has(id)) : g.contractIds }))
    .filter(({ ids }) => ids.length > 0)
    .map(({ g, ids }) => ({ ...idsRow(model, ids, scope.period, state.method, { name: g.label, customerName: g.label }), key: g.key, searchText: normalizeName(g.label) + "\n" + g.key, inPeriod: false }));
  for (const r of all) r.inPeriod = r.contractCount > 0;
  return { scope, all, unit: state.unit, method: state.method, includesPreliminary: all.some((r) => r.includesPreliminary) };
})();
```

```js
if (model) {
  display(
    pageHeader({
      model,
      title: T.app.pages.customers,
      lead: T.customers.lead,
      breadcrumbs: [{ label: T.app.pages.index, href: store.href("./") }, { label: T.app.pages.customers }],
      includesPreliminary: vm?.includesPreliminary ?? false,
    }),
  );
}
```

```js
if (store) mountFilterBar(store, model);
```

```js
if (vm?.scope.teamMissing) {
  display(note(fmt(T.customers.teamMissing, { team: vm.scope.teamLabel, month: monthJa(vm.scope.treeMonth) }), "warn"));
}
```

```js
// 絞り込みフォームは model だけに依存し 1 回だけ描く（期間・単位を変えても検索欄を作り直さない）
const chips = (() => {
  if (!model) return null;
  const form = html`<form class="yn-chip-filters" role="group" aria-label=${T.customers.filterLabel}></form>`;
  form.addEventListener("submit", (ev) => ev.preventDefault());
  const outside = html`<input type="checkbox" id="yn-f-showOutside" checked=${listFilter.showOutside}>`;
  outside.addEventListener("change", () => {
    listFilter.showOutside = outside.checked;
    form.dispatchEvent(new CustomEvent("input", { bubbles: true }));
  });
  const text = html`<input type="search" class="yn-input" id="yn-f-text" placeholder=${T.customers.searchPlaceholder} value=${listFilter.text} aria-label=${T.customers.searchAria}>`;
  // 打ち終わってから反映（1 文字ごと・日本語の変換中には表を作り直さない。§105）
  onTextInput(text, () => {
    listFilter.text = text.value;
    form.dispatchEvent(new CustomEvent("input", { bubbles: true }));
  });
  form.append(
    html`<span class="yn-filter-label">${T.customers.filterHead}</span>`,
    html`<label class="yn-toggle-chip" for="yn-f-showOutside" title=${T.customers.showOutsideTitle}>${outside}<span>${T.customers.showOutside}</span></label>`,
    text,
  );
  form.value = { ...listFilter };
  form.addEventListener("input", () => {
    form.value = { ...listFilter };
    writeListFilter(listFilter);
  });
  return form;
})();
```

```js
if (chips) display(chips);
```

```js
const listState = chips ? Generators.input(chips) : null;
```

```js
if (vm) {
  const { scope, all, unit } = vm;
  const f = listState ?? listFilter;
  // 検索はコアの normalizeName（NFKC・空白整理・小文字化・法人格除去）で両辺を正規化して部分一致
  const q = normalizeName(f.text ?? "");
  const rows = all.filter((r) => (f.showOutside || r.inPeriod) && (!q || r.searchText.includes(q)));
  const outsideCount = all.filter((r) => !r.inPeriod).length;
  display(
    sectionTitle(
      T.customers.sectionTitle,
      fmt(T.customers.sectionHint, { period: periodJa(scope.period), team: scope.teamLabel, method: METHOD_LABELS[vm.method], fy: model.meta.fiscalYear }),
      null,
      outsideCount > 0 && !f.showOutside ? fmt(T.customers.hiddenOutside, { n: outsideCount }) : null,
    ),
  );
  const columns = [
    { key: "name", label: T.customers.colCustomer, type: "text", sortValue: (r) => r.name },
    ...teamCountColumns(),
    ...standardColumns({ costTypes: model.config.costTypes, breakdowns: groupBreakdowns({ model, store, period: scope.period, unit }) }),
    hasTargets(model, "customer") ? targetColumn(model, "customer", (r) => r.name, vm.method) : null,
    { key: "status", label: T.columns.status, type: "status", get: (r) => rowStatus(r), sortValue: (r) => statusSortValue(r), hideNarrow: true },
  ].filter(Boolean);
  // 合計行は表示中の顧客の契約すべてを母集団にした aggregate() / forecastTotals()（顧客は契約を重複せず分けるので、全体の合計と一致する）。
  // 列の絞り込みをすると、絞り込み後の顧客で作り直す
  const detailHref = (id) => store.href("./contract", {}, { id });
  const summary = (shown) => {
    const shownIds = shown.flatMap((r) => r.contractIds);
    const sumTotals = aggregate(model, { period: scope.period, contractIds: shownIds });
    const sumForecast = forecastTotals(model, shownIds, vm.method);
    return {
      name: fmt(T.customers.totalRow, { n: shown.length }),
      contractCount: sumTotals.contractCount,
      budget: sumTotals.budget,
      cost: sumTotals.cost,
      grossProfit: sumTotals.grossProfit,
      grossMargin: sumTotals.grossMargin,
      burnRate: sumTotals.burnRate,
      isOverBudget: sumTotals.isOverBudget,
      // 着地粗利は期間内の契約が 1 件も無ければ「—」（forecastTotals.contractCount は全契約数なので使わない）
      forecastGrossProfit: sumTotals.contractCount === 0 ? null : sumForecast.forecastGrossProfit,
      isDeficit: false,
      status: null,
      shownIds,
      sumTotals,
      sumForecast,
      // 「列」で選べる列（時間・人月・着地の予算と実績）の合計（§106.1）
      totals: sumTotals,
      forecast: sumForecast,
      sumSubtitle: fmt(T.customers.totalSubtitle, { n: shown.length, period: periodJa(scope.period) }),
    };
  };
  const summaryBreakdown = (col, { shownIds, sumTotals, sumForecast, sumSubtitle }) => {
    switch (col.key) {
      case "budget":
        return () => bd.budgetAggregateSpec({ model, contractIds: shownIds, period: scope.period, unit });
      case "cost":
        return () => bd.costAggregateSpec({ model, contractIds: shownIds, period: scope.period, unit, detailHref });
      case "grossProfit":
        return () => bd.grossProfitSpec({ budget: sumTotals.budget, cost: sumTotals.cost, unit, subtitle: sumSubtitle });
      case "grossMargin":
        return () => bd.marginSpec({ totals: sumTotals, unit, subtitle: sumSubtitle });
      case "burnRate":
        return () => bd.burnRateSpec({ totals: sumTotals, unit, threshold: model.config.burnRateDangerThreshold, asOfMonth: model.meta.asOfMonth, subtitle: sumSubtitle });
      case "forecastGrossProfit":
        return () => bd.forecastTotalsSpec({ model, totals: sumForecast, unit, contractIds: shownIds, detailHref });
      default:
        return null;
    }
  };
  if (rows.length === 0) {
    display(emptyState({ title: T.customers.emptyTitle, text: T.customers.emptyText, icon: "○" }));
  } else {
    display(
      dataTable({
        columns,
        rows,
        unit,
        caption: T.customers.caption,
        exportName: `customers_${scope.period.from}_${scope.period.to}`,
        sort: { key: "status", dir: "asc" },
        rowHref: (r) => customerHref(store, r.key),
        summary,
        summaryBreakdown,
      }),
    );
  }
}
```
