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
import { aggregate, forecastTotals, normalizeName } from "./core/index.js";
import { createStore } from "./components/state.js";
import { scopeFor } from "./components/analysis.js";
import { customerGroups, customerHref, idsRow, groupBreakdowns } from "./components/customers.js";
import { pageHeader, sectionTitle, emptyState, loadJson, note } from "./components/layout.js";
import { filterBar } from "./components/filters.js";
import { dataTable, standardColumns, rowStatus, statusSortValue, teamCountColumns, withForecastCount } from "./components/table.js";
import * as bd from "./components/breakdown.js";
import { monthJa, periodJa, METHOD_LABELS } from "./components/format.js";
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
// 一覧専用の絞り込み（検索語は URL の q。ページ内の状態）
const listFilter = { text: new URLSearchParams(location.search).get("q") ?? "", showOutside: false };
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
      title: "顧客別",
      lead: "顧客ごとの予実。同じ顧客の契約（更新前後・複数案件）をまとめて、どの顧客が悪いかを見ます。行をクリックすると、その顧客の契約と担当チームの内訳に移動します。",
      breadcrumbs: [{ label: "全体サマリー", href: store.href("./") }, { label: "顧客別" }],
      includesPreliminary: vm?.includesPreliminary ?? false,
    }),
  );
}
```

```js
if (store) display(filterBar(store, model));
```

```js
if (vm?.scope.teamMissing) {
  display(note(`選択したチーム「${vm.scope.teamLabel}」は ${monthJa(vm.scope.treeMonth)} 時点の組織に存在しません（期間の終了月か基準月より後に発効する組織です）。顧客は 0 件になります。`, "warn"));
}
```

```js
// 絞り込みフォームは model だけに依存し 1 回だけ描く（期間・単位を変えても検索欄を作り直さない）
const chips = (() => {
  if (!model) return null;
  const form = html`<form class="yn-chip-filters" role="group" aria-label="顧客の絞り込み"></form>`;
  form.addEventListener("submit", (ev) => ev.preventDefault());
  const outside = html`<input type="checkbox" id="yn-f-showOutside" checked=${listFilter.showOutside}>`;
  outside.addEventListener("change", () => {
    listFilter.showOutside = outside.checked;
    form.dispatchEvent(new CustomEvent("input", { bubbles: true }));
  });
  const text = html`<input type="search" class="yn-input" id="yn-f-text" placeholder="顧客名で検索" value=${listFilter.text} aria-label="顧客名で検索（全角・半角、大文字・小文字、株式会社などの違いは区別しません）">`;
  let timer = null;
  text.addEventListener("input", () => {
    // 150ms デバウンス（1 文字ごとに表を作り直さない）
    clearTimeout(timer);
    timer = setTimeout(() => {
      listFilter.text = text.value;
      form.dispatchEvent(new CustomEvent("input", { bubbles: true }));
    }, 150);
  });
  form.append(
    html`<span class="yn-filter-label">絞り込み</span>`,
    html`<label class="yn-toggle-chip" for="yn-f-showOutside" title="選択した期間に 1 か月も掛からない契約だけの顧客も表示">${outside}<span>期間外の顧客も表示</span></label>`,
    text,
  );
  form.value = { ...listFilter };
  form.addEventListener("input", () => (form.value = { ...listFilter }));
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
      "顧客ごとの予実",
      `${periodJa(scope.period)} ・ ${scope.teamLabel} ・ 着地: ${METHOD_LABELS[vm.method]}（${model.meta.fiscalYear}年度）。契約数は期間内の契約、着地粗利は年度に掛かる契約（件数を併記）が母集団です。状態の「赤字 N件」は赤字見込みの契約数、「予算超過」は消化率が基準超。既定の並び: 赤字・予算超過の顧客を先頭に、消化率の高い順。${outsideCount > 0 && !f.showOutside ? `選択期間に掛かる契約が無い顧客 ${outsideCount}件は非表示（「期間外の顧客も表示」で表示）。` : ""}`,
    ),
  );
  const columns = [
    { key: "name", label: "顧客", type: "text", sortValue: (r) => r.name },
    ...teamCountColumns(),
    ...standardColumns({ breakdowns: groupBreakdowns({ model, store, period: scope.period, unit }) }).map(withForecastCount),
    { key: "status", label: "状態", type: "status", get: (r) => rowStatus(r), sortValue: (r) => statusSortValue(r), hideNarrow: true },
  ];
  // 合計行は表示中の顧客の契約すべてを母集団にした aggregate() / forecastTotals()（顧客は契約を重複せず分けるので、全体の合計と一致する）
  const shownIds = rows.flatMap((r) => r.contractIds);
  const sumTotals = aggregate(model, { period: scope.period, contractIds: shownIds });
  const sumForecast = forecastTotals(model, shownIds, vm.method);
  const sumSubtitle = `表示中の ${rows.length} 顧客 ・ ${periodJa(scope.period)}`;
  const detailHref = (id) => store.href("./contract", {}, { id });
  const summary = {
    name: `合計（${rows.length}顧客）`,
    contractCount: sumTotals.contractCount,
    budget: sumTotals.budget,
    cost: sumTotals.cost,
    grossProfit: sumTotals.grossProfit,
    grossMargin: sumTotals.grossMargin,
    burnRate: sumTotals.burnRate,
    isOverBudget: sumTotals.isOverBudget,
    // 着地粗利は年度に掛かる契約が 1 件も無ければ「—」（forecastTotals.contractCount は全契約数なので使わない）
    forecastGrossProfit: rows.reduce((n, r) => n + r.fyContractCount, 0) === 0 ? null : sumForecast.forecastGrossProfit,
    isDeficit: false,
    status: null,
  };
  const summaryBreakdown = (col) => {
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
    display(emptyState({ title: "該当する顧客がありません", text: "検索語か期間・チームを変えてください。", icon: "○" }));
  } else {
    display(
      dataTable({
        columns,
        rows,
        unit,
        caption: "顧客一覧",
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
