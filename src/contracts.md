---
title: 案件一覧
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
import { UNASSIGNED_TEAM_ID } from "./core/index.js";
import { customerGroups } from "./components/customers.js";
import { createStore } from "./components/state.js";
import { scopeFor, contractRow } from "./components/analysis.js";
import { pageHeader, sectionTitle, emptyState, note, loadModel } from "./components/layout.js";
import { mountFilterBar } from "./components/filters.js";
import { dataTable, standardColumns, rowStatus, statusSortValue, contractNameCell } from "./components/table.js";
import * as bd from "./components/breakdown.js";
import { hasTargets, targetColumn } from "./components/targets.js";
import { money, monthJa, periodJa, METHOD_LABELS } from "./components/format.js";
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
// 一覧専用の絞り込み。URL の f（deficit,over,prelim,outside のカンマ区切り）と q に書き戻す（詳細から「戻る」で復元するため）
const listFilter = (() => {
  const q = new URLSearchParams(location.search);
  const f = (q.get("f") ?? "").split(",");
  return { deficit: f.includes("deficit"), over: f.includes("over"), prelim: f.includes("prelim"), text: q.get("q") ?? "", showOutside: f.includes("outside") };
})();
function writeListFilter(lf) {
  const url = new URL(location.href);
  const f = [lf.deficit && "deficit", lf.over && "over", lf.prelim && "prelim", lf.showOutside && "outside"].filter(Boolean).join(",");
  if (f) url.searchParams.set("f", f);
  else url.searchParams.delete("f");
  if (lf.text) url.searchParams.set("q", lf.text);
  else url.searchParams.delete("q");
  history.replaceState(history.state, "", url);
}

// 顧客キーでの厳密絞り込み（?customer=<key>）。顧客詳細の担当チーム行から来る。
// direct=1 のときは主担当チームがちょうど team の契約だけ（配下のチームは含めない）。検索語（部分一致）とは別物
const customerParam = (() => {
  const q = new URLSearchParams(location.search);
  return { key: q.get("customer") ?? "", direct: q.get("direct") === "1" };
})();
```

```js
const vm = (() => {
  if (!model || !state) return null;
  const scope = scopeFor(model, state);
  const ids = scope.contractIds ? new Set(scope.contractIds) : null;
  const customerGroup = customerParam.key ? customerGroups(model).find((g) => g.key === customerParam.key) ?? null : null;
  const customerIds = customerGroup ? new Set(customerGroup.contractIds) : null;
  const direct = customerParam.direct && state.team;
  const all = model.contracts
    .filter((r) => !ids || ids.has(r.contract.contractId))
    .filter((r) => !customerParam.key || (customerIds && customerIds.has(r.contract.contractId)))
    .filter((r) => !direct || (state.team === UNASSIGNED_TEAM_ID ? !r.contract.teamId : r.contract.teamId === state.team))
    .map((r) => ({ ...contractRow(model, r, scope.period, state.method, scope.tree), key: r.contract.contractId, searchText: normalizeName(`${r.contract.contractId} ${r.contract.customerName} ${r.contract.projectName}`) }));
  return { scope, all, customerGroup, unit: state.unit, method: state.method, includesPreliminary: all.some((r) => r.includesPreliminary) };
})();
```

```js
if (model) {
  display(
    pageHeader({
      model,
      title: T.app.pages.contracts,
      lead: T.contracts.lead,
      breadcrumbs: [{ label: T.app.pages.index, href: store.href("./") }, { label: T.app.pages.contracts }],
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
  display(note(fmt(T.contracts.teamMissing, { team: vm.scope.teamLabel, month: monthJa(vm.scope.treeMonth) }), "warn"));
}
```

```js
// 顧客キーで絞っているとき: 何で絞っているかと解除のリンクを出す
if (vm && customerParam.key) {
  const clear = store.href("./contracts");
  display(
    vm.customerGroup
      ? note(html`${fmt(T.contracts.customerFiltered, { customer: vm.customerGroup.label, direct: customerParam.direct && state.team ? fmt(T.contracts.customerFilteredDirect, { team: vm.scope.teamLabel }) : "" })} <a href=${clear}>${T.contracts.clearFilter}</a>`)
      : note(html`${fmt(T.contracts.customerNotFound, { customer: customerParam.key })} <a href=${clear}>${T.contracts.clearFilter}</a>`, "warn"),
  );
}
```

```js
// 絞り込みフォームは model だけに依存し 1 回だけ描く（期間・単位を変えても検索欄を作り直さない）
const chips = (() => {
  if (!model) return null;
  const form = html`<form class="yn-chip-filters" role="group" aria-label=${T.contracts.filterLabel}></form>`;
  form.addEventListener("submit", (ev) => ev.preventDefault());
  const mk = (key, label, title) => {
    const input = html`<input type="checkbox" id=${`yn-f-${key}`} checked=${listFilter[key]}>`;
    input.addEventListener("change", () => {
      listFilter[key] = input.checked;
      form.dispatchEvent(new CustomEvent("input", { bubbles: true }));
    });
    return html`<label class="yn-toggle-chip" for=${`yn-f-${key}`} title=${title}>${input}<span>${label}</span></label>`;
  };
  const text = html`<input type="search" class="yn-input" id="yn-f-text" placeholder=${T.contracts.searchPlaceholder} value=${listFilter.text} aria-label=${T.contracts.searchAria}>`;
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
    html`<span class="yn-filter-label">${T.customers.filterHead}</span>`,
    mk("deficit", T.contracts.chipDeficit, T.contracts.chipDeficitTitle),
    mk("over", T.contracts.chipOver, fmt(T.contracts.chipOverTitle, { percent: Math.round(model.config.burnRateDangerThreshold * 100) })),
    mk("prelim", T.contracts.chipPrelim, T.contracts.chipPrelimTitle),
    mk("showOutside", T.contracts.chipOutside, T.contracts.chipOutsideTitle),
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
  const rows = all.filter((r) => {
    if (!f.showOutside && !r.inPeriod) return false;
    if (f.deficit && !r.isDeficit) return false;
    if (f.over && !r.isOverBudget) return false;
    if (f.prelim && !r.includesPreliminary) return false;
    if (q && !r.searchText.includes(q) && !normalizeName(r.teamName).includes(q)) return false;
    return true;
  });
  const outside = all.filter((r) => !r.inPeriod).length;
  display(
    sectionTitle(
      T.contracts.sectionTitle,
      fmt(T.contracts.sectionHint, { period: periodJa(scope.period), team: scope.teamLabel, method: METHOD_LABELS[vm.method], fy: model.meta.fiscalYear }),
      null,
      outside > 0 && !f.showOutside ? fmt(T.contracts.hiddenOutside, { n: outside }) : null,
    ),
  );
  const columns = [
    { key: "name", label: T.columns.contract, type: "text", render: (r) => contractNameCell(r), sortValue: (r) => `${r.customerName} ${r.projectName}`, exportValue: (r) => `${r.customerName} / ${r.projectName}`, exportLabel: T.breakdown.colCustomerProject },
    { key: "contractId", label: T.columns.contractId, type: "text", exportOnly: true },
    { key: "customerName", label: T.customers.colCustomer, type: "text", exportOnly: true },
    { key: "projectName", label: T.contracts.colProject, type: "text", exportOnly: true },
    { key: "teamName", label: T.columns.team, type: "text", exportOnly: true },
    { key: "period", label: T.columns.contractPeriod, type: "text", exportOnly: true, get: (r) => `${r.startMonth}〜${r.endMonth}` },
    ...standardColumns({
      breakdowns: {
        budget: (r) => bd.budgetAggregateSpec({ model, contractIds: [r.contractId], period: scope.period, unit }),
        cost: (r) => bd.costAggregateSpec({ model, contractIds: [r.contractId], period: scope.period, unit, detailHref: (id) => store.href("./contract", {}, { id }) }),
        grossProfit: (r) => bd.grossProfitSpec({ budget: r.budget, cost: r.cost, unit, subtitle: `${r.customerName} / ${r.projectName}` }),
        margin: (r) => bd.marginSpec({ totals: r.totals, unit, subtitle: `${r.customerName} / ${r.projectName}` }),
        burnRate: (r) => bd.burnRateSpec({ totals: r.totals, unit, threshold: model.config.burnRateDangerThreshold, asOfMonth: model.meta.asOfMonth, subtitle: `${r.customerName} / ${r.projectName}` }),
        forecast: (r) => bd.forecastSpec({ forecast: r.forecast, contract: r.contract, unit, config: model.config, model }),
      },
    }),
    hasTargets(model, "project") ? targetColumn(model, "project", (r) => r.contractId, vm.method) : null,
    { key: "status", label: T.columns.status, type: "status", get: (r) => rowStatus(r), sortValue: (r) => statusSortValue(r), hideNarrow: true },
  ].filter(Boolean);
  // 合計行はコアの aggregate() / forecastTotals() の結果（表示中の契約だけを母集団に 1 回の走査）。
  // 列の絞り込みをすると、絞り込み後の契約で作り直す（dataTable が shown を渡す）
  const summary = (shown) => {
    const shownIds = shown.map((r) => r.contractId);
    const sumTotals = aggregate(model, { period: scope.period, contractIds: shownIds });
    const sumForecast = forecastTotals(model, shownIds, vm.method);
    return {
      name: fmt(T.contracts.totalRow, { n: shown.length }),
      customerName: null,
      projectName: null,
      teamName: null,
      period: null,
      contractId: null,
      budget: sumTotals.budget,
      cost: sumTotals.cost,
      grossProfit: sumTotals.grossProfit,
      grossMargin: sumTotals.grossMargin,
      burnRate: sumTotals.burnRate,
      isOverBudget: sumTotals.isOverBudget,
      // 着地粗利は年度に掛かる契約が 1 件も無ければ「—」（forecastTotals.contractCount は全契約数なので使わない）
      forecastGrossProfit: shown.some((r) => r.forecastGrossProfit !== null) ? sumForecast.forecastGrossProfit : null,
      isDeficit: false,
      status: null,
      shownIds,
      sumTotals,
      sumForecast,
      sumSubtitle: fmt(T.contracts.totalSubtitle, { n: shown.length, period: periodJa(scope.period) }),
    };
  };
  const summaryBreakdown = (col, { shownIds, sumTotals, sumForecast, sumSubtitle }) => {
    switch (col.key) {
      case "budget":
        return () => bd.budgetAggregateSpec({ model, contractIds: shownIds, period: scope.period, unit });
      case "cost":
        return () => bd.costAggregateSpec({ model, contractIds: shownIds, period: scope.period, unit, detailHref: (id) => store.href("./contract", {}, { id }) });
      case "grossProfit":
        return () => bd.grossProfitSpec({ budget: sumTotals.budget, cost: sumTotals.cost, unit, subtitle: sumSubtitle });
      case "grossMargin":
        return () => bd.marginSpec({ totals: sumTotals, unit, subtitle: sumSubtitle });
      case "burnRate":
        return () => bd.burnRateSpec({ totals: sumTotals, unit, threshold: model.config.burnRateDangerThreshold, asOfMonth: model.meta.asOfMonth, subtitle: sumSubtitle });
      case "forecastGrossProfit":
        return () => bd.forecastTotalsSpec({ model, totals: sumForecast, unit, contractIds: shownIds, detailHref: (id) => store.href("./contract", {}, { id }) });
      default:
        return null;
    }
  };
  if (rows.length === 0) {
    display(emptyState({ title: T.contracts.emptyTitle, text: T.contracts.emptyText, icon: "○" }));
  } else {
    display(
      dataTable({
        columns,
        rows,
        unit,
        caption: T.app.pages.contracts,
        exportName: `contracts_${scope.period.from}_${scope.period.to}`,
        sort: { key: "status", dir: "asc" },
        rowHref: (r) => store.href("./contract", {}, { id: r.contractId }),
        summary,
        summaryBreakdown,
      }),
    );
  }
}
```
