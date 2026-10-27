---
title: 契約一覧
---

<div id="page-skeleton" class="yn-skeleton" aria-busy="true" aria-label="読み込み中">
  <div class="yn-skel-line yn-skel-title"></div>
  <div class="yn-skel-line"></div>
  <div class="yn-skel-block"></div>
</div>

```js
import { html } from "htl";
import { createStore } from "./components/state.js";
import { scopeFor, contractRow } from "./components/analysis.js";
import { pageHeader, sectionTitle, emptyState, loadJson } from "./components/layout.js";
import { filterBar } from "./components/filters.js";
import { dataTable, standardColumns, rowStatus, statusSortValue, contractNameCell } from "./components/table.js";
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
// 一覧専用の絞り込み（URL には保存しない。ページ内の状態）
const listFilter = (() => {
  const q = new URLSearchParams(location.search);
  return { deficit: q.get("f") === "deficit", over: q.get("f") === "over", prelim: q.get("f") === "prelim", text: q.get("q") ?? "", showOutside: false };
})();
```

```js
const vm = (() => {
  if (!model || !state) return null;
  const scope = scopeFor(model, state);
  const ids = scope.contractIds ? new Set(scope.contractIds) : null;
  const all = model.contracts
    .filter((r) => !ids || ids.has(r.contract.contractId))
    .map((r) => ({ ...contractRow(model, r, scope.period, state.method, scope.tree), key: r.contract.contractId }));
  return { scope, all, unit: state.unit, method: state.method, includesPreliminary: all.some((r) => r.includesPreliminary) };
})();
```

```js
if (model) {
  display(
    pageHeader({
      model,
      title: "契約一覧",
      lead: "契約ごとの予算・原価・粗利・消化率と年度末の着地見込み。赤い表示は「消化率が基準を超えた」か「赤字で着地する見込み」のどちらかです。行をクリックすると契約詳細へ移動します。",
      breadcrumbs: [{ label: "全体サマリー", href: store.href("./") }, { label: "契約一覧" }],
      includesPreliminary: vm?.includesPreliminary ?? false,
    }),
  );
}
```

```js
if (store) display(filterBar(store, model));
```

```js
const chips = (() => {
  if (!vm) return null;
  const form = html`<form class="yn-chip-filters" role="group" aria-label="契約の絞り込み"></form>`;
  form.addEventListener("submit", (ev) => ev.preventDefault());
  const mk = (key, label, title) => {
    const input = html`<input type="checkbox" id=${`yn-f-${key}`} checked=${listFilter[key]}>`;
    input.addEventListener("change", () => {
      listFilter[key] = input.checked;
      form.dispatchEvent(new CustomEvent("input", { bubbles: true }));
    });
    return html`<label class="yn-toggle-chip" for=${`yn-f-${key}`} title=${title}>${input}<span>${label}</span></label>`;
  };
  const text = html`<input type="search" class="yn-input" id="yn-f-text" placeholder="顧客・案件・契約IDで検索" value=${listFilter.text} aria-label="顧客・案件・契約IDで検索">`;
  text.addEventListener("input", () => {
    listFilter.text = text.value;
    form.dispatchEvent(new CustomEvent("input", { bubbles: true }));
  });
  form.append(
    html`<span class="yn-filter-label">絞り込み</span>`,
    mk("deficit", "赤字見込み", "年度末に赤字で着地する見込みの契約"),
    mk("over", "消化率超過", `消化率が ${Math.round(model.config.burnRateDangerThreshold * 100)}% を超えた契約`),
    mk("prelim", "速報含む", "確定前の月を含む契約"),
    mk("showOutside", "期間外の契約も表示", "選択した期間に 1 か月も掛からない契約も表示"),
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
  const q = (f.text ?? "").trim().toLowerCase();
  const rows = all.filter((r) => {
    if (!f.showOutside && !r.inPeriod) return false;
    if (f.deficit && !r.isDeficit) return false;
    if (f.over && !r.isOverBudget) return false;
    if (f.prelim && !r.includesPreliminary) return false;
    if (q && !`${r.contractId} ${r.customerName} ${r.projectName} ${r.teamName}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const outside = all.filter((r) => !r.inPeriod).length;
  display(
    sectionTitle(
      "契約ごとの予実",
      `${periodJa(scope.period)} ・ ${scope.teamLabel} ・ 着地: ${METHOD_LABELS[vm.method]}（${model.meta.fiscalYear}年度）。契約列は 顧客 / 案件 と ID・チーム・期間（YY/MM）。既定の並び: 赤字見込み・予算超過の契約を先頭に、消化率の高い順。${outside > 0 && !f.showOutside ? `選択期間に掛からない契約 ${outside}件は非表示（表示する → 「期間外の契約も表示」をチェック）。` : ""}`,
    ),
  );
  const columns = [
    { key: "name", label: "契約", type: "text", render: (r) => contractNameCell(r), sortValue: (r) => `${r.customerName} ${r.projectName}`, exportValue: (r) => `${r.customerName} / ${r.projectName}` },
    { key: "contractId", label: "契約ID", type: "text", exportOnly: true },
    { key: "customerName", label: "顧客", type: "text", exportOnly: true },
    { key: "projectName", label: "案件", type: "text", exportOnly: true },
    { key: "teamName", label: "チーム", type: "text", exportOnly: true },
    { key: "period", label: "契約期間", type: "text", exportOnly: true, get: (r) => `${r.startMonth}〜${r.endMonth}` },
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
    { key: "status", label: "状態", type: "status", get: (r) => rowStatus(r), sortValue: (r) => statusSortValue(r), hideNarrow: true },
  ];
  const sum = rows.reduce(
    (s, r) => {
      s.budget += r.budget;
      s.cost += r.cost;
      s.hours += r.hours;
      if (r.forecastGrossProfit !== null) s.forecastGrossProfit += r.forecastGrossProfit;
      return s;
    },
    { budget: 0, cost: 0, hours: 0, forecastGrossProfit: 0 },
  );
  const summary = { name: `合計（${rows.length}件）`, customerName: null, projectName: null, teamName: null, period: null, contractId: null, budget: sum.budget, cost: sum.cost, grossProfit: sum.budget - sum.cost, grossMargin: sum.budget ? (sum.budget - sum.cost) / sum.budget : null, burnRate: null, forecastGrossProfit: sum.forecastGrossProfit, isDeficit: false, isOverBudget: false, status: null };
  if (rows.length === 0) {
    display(emptyState({ title: "該当する契約がありません", text: "絞り込み条件か期間・チームを変えてください。", icon: "○" }));
  } else {
    display(
      dataTable({
        columns,
        rows,
        unit,
        caption: "契約一覧",
        exportName: `contracts_${scope.period.from}_${scope.period.to}`,
        sort: { key: "status", dir: "asc" },
        rowHref: (r) => store.href("./contract", {}, { id: r.contractId }),
        summary,
      }),
    );
  }
}
```
