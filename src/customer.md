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
import { UNASSIGNED_TEAM_ID, UNASSIGNED_TEAM_LABEL } from "./core/index.js";
import { createStore, periodFiscalYear } from "./components/state.js";
import { scopeFor, summarize, seriesWithForecast, priorYearComparison, contractRow, teamName, treeAt, treeMonthFor } from "./components/analysis.js";
import { customerGroups, idsRow, groupBreakdowns, contractListColumns } from "./components/customers.js";
import { pageHeader, sectionTitle, emptyState, loadJson, note } from "./components/layout.js";
import { filterBar } from "./components/filters.js";
import { statTile, kpiRow } from "./components/kpi.js";
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
      title: "顧客詳細",
      breadcrumbs: [{ label: "全体サマリー", href: store.href("./") }, { label: "顧客別", href: store.href("./customers") }, { label: "（顧客が見つかりません）" }],
    }),
  );
  display(
    emptyState({
      title: customerKey ? `顧客「${customerKey}」は見つかりません` : "顧客が指定されていません",
      text: customerKey ? "顧客名が変わったか、データから無くなった可能性があります。顧客別の一覧から選び直してください。" : "顧客別の一覧から顧客を選んでください。",
      actions: [{ label: "顧客別へ戻る", href: store.href("./customers") }],
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
      lead: `この顧客の ${vm.scope.contractIds.length} 件の契約を合算した予実です。数値をクリックすると計算根拠が開きます。`,
      breadcrumbs: [{ label: "全体サマリー", href: store.href("./") }, { label: "顧客別", href: store.href("./customers") }, { label: group.label }],
      includesPreliminary: vm.totals.includesPreliminary,
    }),
  );
}
```

```js
if (store && group) display(filterBar(store, model, { show: ["period", "team", "method", "unit"] }));
```

```js
// チームで絞っているときは数字が顧客全体と変わるので明示する（外れたら消えるよう、無いときは空の要素を出す）
if (vm) {
  display(
    vm.scope.teamId
      ? note(
          `${vm.scope.teamLabel}（配下含む）の契約だけで集計しています（この顧客の全 ${group.contractIds.length} 件のうち ${vm.scope.contractIds.length} 件）。顧客全体を見るには、チームを「全体」に戻してください。`,
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
  const detailHref = (id) => store.href("./contract", {}, { id });
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
        breakdown: () => bd.costAggregateSpec({ model, contractIds: scope.contractIds, period: scope.period, unit, detailHref }),
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
        breakdown: () => bd.forecastTotalsSpec({ model, totals: forecast, unit, contractIds: scope.contractIds, detailHref }),
        emphasis: true,
      }),
    ]),
  );
}
```

```js
if (vm) {
  display(sectionTitle("月次推移", `${periodJa(vm.scope.period)} の予算・原価・粗利。${monthJa(model.meta.asOfMonth)} 以降は着地見込み（${METHOD_LABELS[vm.method]}）です。`));
  display(html`<figure class="yn-card yn-chart-card">
    ${monthlyLegend(dark)}
    ${resize((width) => monthlyChart({ series: vm.series, unit: vm.unit, dark, width, asOfMonth: model.meta.asOfMonth }))}
    <details class="yn-details"><summary>表で見る</summary>${seriesTable(vm.series, { unit: vm.unit, exportName: `customer_monthly_${vm.scope.period.from}_${vm.scope.period.to}` })}</details>
  </figure>`);
}
```

```js
// 契約一覧の「期間外の契約も表示」（モデルだけに依存して 1 回だけ描く）
const outsideToggle = (() => {
  if (!model || !group) return null;
  const input = html`<input type="checkbox" id="yn-f-showOutside" checked=${listFilter.showOutside}>`;
  const form = html`<form class="yn-chip-filters" role="group" aria-label="契約の絞り込み"><label class="yn-toggle-chip" for="yn-f-showOutside" title="選択した期間に 1 か月も掛からない契約も表示">${input}<span>期間外の契約も表示</span></label></form>`;
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
      "この顧客の契約",
      `${periodJa(scope.period)} ・ 着地: ${METHOD_LABELS[vm.method]}（${fiscalYearLabel(model.meta.fiscalYear)}）。クリックで契約詳細へ。${hidden > 0 && !f.showOutside ? `選択期間に掛からない契約 ${hidden}件は非表示（「期間外の契約も表示」で表示）。` : ""}`,
    ),
  );
  if (outsideToggle && hidden > 0) display(outsideToggle);
  if (rows.length === 0) {
    display(emptyState({ title: "選択期間に掛かる契約がありません", text: "期間を変えるか、「期間外の契約も表示」を選んでください。", icon: "○" }));
  } else {
    display(
      dataTable({
        columns: contractListColumns({ model, store, period: scope.period, unit }),
        rows,
        unit,
        caption: "顧客の契約一覧",
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
  display(sectionTitle("担当チーム別", `${group.label} の契約を、契約に登録された主担当チームごとに集計（${monthJa(treeMonthFor(model, scope.period))} 時点の組織名）。契約数は期間内の契約、着地粗利は年度に掛かる契約（件数を併記）が母集団です。行をクリックすると、この顧客のこのチームの契約一覧（契約一覧を顧客とチームで絞った表示）に移動します。`));
  if (rows.length === 0) {
    display(emptyState({ title: "選択期間に掛かる契約がありません", text: "期間を変えてください。", icon: "○" }));
  } else {
    const columns = [
      { key: "name", label: "チーム", type: "text" },
      ...teamCountColumns(),
      ...standardColumns({ breakdowns: groupBreakdowns({ model, store, period: scope.period, unit }) }).map(withForecastCount),
      { key: "status", label: "状態", type: "status", get: (r) => rowStatus(r), sortValue: (r) => statusSortValue(r), hideNarrow: true },
    ];
    display(
      dataTable({
        columns,
        rows,
        unit,
        caption: "担当チーム別",
        exportName: `customer_teams_${scope.period.from}_${scope.period.to}`,
        sort: { key: "status", dir: "asc" },
        rowHref: (r) => store.href("./contracts", { team: r.teamId }, { customer: group.key, direct: 1 }),
      }),
    );
  }
}
```
