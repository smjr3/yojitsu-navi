---
title: チーム詳細
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
import { UNASSIGNED_TEAM_ID, UNASSIGNED_TEAM_LABEL, contractsForTeam, teamMemberCosts, teamOrgChanges, teamPath } from "./core/index.js";
import { createStore, periodFiscalYear } from "./components/state.js";
import { summarize, seriesWithForecast, priorYearComparison, contractRow, teamRow, treeAt, treeMonthFor } from "./components/analysis.js";
import { pageHeader, sectionTitle, emptyState, loadJson, note } from "./components/layout.js";
import { mountFilterBar } from "./components/filters.js";
import { statusChip } from "./components/kpi.js";
import { monthlyChart, monthlyLegend, seriesTable } from "./components/charts.js";
import { dataTable, standardColumns, rowStatus, statusSortValue, contractNameCell, teamCountColumns, withForecastCount } from "./components/table.js";
import * as bd from "./components/breakdown.js";
import { summaryKpis, memberCostSpec, orgChangeText, ORG_CHANGE_LABELS } from "./components/team-detail.js";
import { money, formatHours, formatPercent, monthJa, periodJa, METHOD_LABELS, fiscalYearLabel, integer } from "./components/format.js";
```

```js
const model = await loadJson(FileAttachment("./data/model.json"), { skeleton: "page-skeleton" });
const teamId = new URLSearchParams(location.search).get("id") ?? "";
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
// 画面の状態（期間・単位・方式）と ?id= から、このチームの母集団（配下含む契約）を決める
const vm = (() => {
  if (!model || !state) return null;
  const period = { from: state.from, to: state.to };
  const treeMonth = treeMonthFor(model, period);
  const { tree } = treeAt(model, treeMonth);
  const isUnassigned = teamId === UNASSIGNED_TEAM_ID;
  const node = Object.prototype.hasOwnProperty.call(tree, teamId) ? tree[teamId] : null;
  const base = { period, treeMonth, tree, teamId, isUnassigned, unit: state.unit, method: state.method };
  if (!isUnassigned && !node) {
    return { ...base, exists: false, knownInHistory: model.teams.some((t) => t.teamId === teamId) };
  }
  const name = isUnassigned ? UNASSIGNED_TEAM_LABEL : node.name;
  const contracts = contractsForTeam(model, teamId, tree);
  const contractIds = contracts.map((c) => c.contractId);
  const scope = { period, contractIds, teamId, teamLabel: name, tree, treeMonth };
  const { totals, forecast } = summarize(model, scope, state.method);
  const series = seriesWithForecast(model, scope, state.method);
  const compare = priorYearComparison(model, scope);
  const path = isUnassigned ? [] : teamPath(tree, teamId);
  return {
    ...base,
    exists: true,
    name,
    node,
    scope,
    contractIds,
    totals,
    forecast,
    series,
    compare,
    path,
    fy: periodFiscalYear(model, period),
  };
})();
```

```js
if (model && vm) {
  const title = vm.exists ? html`${vm.isUnassigned ? "" : html`<span class="yn-title-id">${vm.teamId}</span> `}${vm.name}` : "チーム詳細";
  const crumbs = [{ label: "全体サマリー", href: store.href("./") }, { label: "チーム一覧", href: store.href("./teams") }];
  if (!vm.exists) crumbs.push({ label: teamId || "（チームID未指定）" });
  else if (vm.isUnassigned) crumbs.push({ label: vm.name });
  else for (const n of vm.path) crumbs.push({ label: n.name, href: store.href("./team", {}, { id: n.teamId }) });
  display(
    pageHeader({
      model,
      title,
      lead: vm.exists
        ? vm.isUnassigned
          ? "主担当チームが未設定（または組織に無いチーム）の契約をまとめた集計です。まず契約一覧で担当チームを確認してください。"
          : `${vm.name}（配下のチームを含む）の予実です。数値をクリックすると計算根拠が開きます。`
        : null,
      breadcrumbs: crumbs,
      includesPreliminary: vm.exists ? vm.totals.includesPreliminary : false,
      extra: vm.exists ? html`<a class="yn-btn yn-btn-sm" id="yn-team-contracts-link" href=${store.href("./contracts", { team: vm.teamId })}>このチームの契約一覧へ</a>` : null,
    }),
  );
}
```

```js
if (model && !teamId) {
  display(emptyState({ title: "チームIDが指定されていません", text: "チーム一覧からチームを選んでください。", actions: [{ label: "チーム一覧へ", href: store.href("./teams") }] }));
}
```

```js
if (store && teamId) mountFilterBar(store, model, { show: ["period", "method", "unit"] });
```

```js
if (vm && !vm.exists && teamId) {
  display(
    emptyState({
      title: "このチームは選択期間の組織にありません",
      text: vm.knownInHistory
        ? `「${teamId}」は組織の履歴にありますが、${monthJa(vm.treeMonth)} 時点の組織にはありません（期間の終了月か基準月より後に発効するチーム、または廃止されたチームです）。期間を変えるか、チーム一覧から選び直してください。`
        : `「${teamId}」というチームIDは組織の履歴にありません。チームIDが変わったか、URL が誤っている可能性があります。`,
      actions: [{ label: "チーム一覧へ", href: store.href("./teams") }],
    }),
  );
}
```

```js
if (vm?.exists) {
  display(sectionTitle("このチームの予実", `${periodJa(vm.period)} ・ ${vm.name}${vm.isUnassigned ? "" : "（配下のチームを含む）"} ・ ${monthJa(vm.treeMonth)} 時点の組織で集計。前年同期は経過月の累計を12か月前と比べます。`));
  display(summaryKpis({ model, store, scope: vm.scope, totals: vm.totals, forecast: vm.forecast, compare: vm.compare, fy: vm.fy, unit: vm.unit }));
}
```

```js
if (vm?.exists) {
  display(sectionTitle("月次推移", `${periodJa(vm.period)} の予算・原価・粗利。${monthJa(model.meta.asOfMonth)} 以降は着地見込み（${METHOD_LABELS[vm.method]}）です。`));
  display(html`<figure class="yn-card yn-chart-card">
    ${monthlyLegend(dark)}
    ${resize((width) => monthlyChart({ series: vm.series, unit: vm.unit, dark, width, asOfMonth: model.meta.asOfMonth }))}
    <details class="yn-details"><summary>表で見る</summary>${seriesTable(vm.series, { unit: vm.unit, exportName: `team_${vm.teamId}_monthly_${vm.period.from}_${vm.period.to}` })}</details>
  </figure>`);
}
```

```js
// 配下チーム（直下の子ごと。子が無ければ出さない）
if (vm?.exists && vm.node && vm.node.children.length > 0) {
  const { period, unit, method, tree } = vm;
  const rows = vm.node.children.map((id) => ({ ...teamRow(model, id, tree[id].name, 0, period, method, tree), key: id }));
  const detailHref = (id) => store.href("./contract", {}, { id });
  display(sectionTitle("配下のチーム", `${vm.name} の直下のチームごとの予実（上位の行は、さらにその配下の合計）。行をクリックするとそのチームの詳細へ。契約数は期間内、着地粗利は ${fiscalYearLabel(model.meta.fiscalYear)} に掛かる契約（件数を併記）が母集団です。`));
  const columns = [
    { key: "name", label: "チーム", type: "text" },
    ...teamCountColumns(),
    ...standardColumns({
      forecastLabel: "着地粗利",
      breakdowns: {
        budget: (r) => bd.budgetAggregateSpec({ model, contractIds: r.contractIds, period, unit }),
        cost: (r) => bd.costAggregateSpec({ model, contractIds: r.contractIds, period, unit, detailHref }),
        grossProfit: (r) => bd.grossProfitSpec({ budget: r.budget, cost: r.cost, unit, subtitle: r.name }),
        margin: (r) => bd.marginSpec({ totals: r.totals, unit, subtitle: r.name }),
        burnRate: (r) => bd.burnRateSpec({ totals: r.totals, unit, threshold: model.config.burnRateDangerThreshold, asOfMonth: model.meta.asOfMonth, subtitle: r.name }),
        forecast: (r) => bd.forecastTotalsSpec({ model, totals: r.forecast, unit, contractIds: r.contractIds, detailHref }),
      },
    }).map(withForecastCount),
    { key: "status", label: "状態", type: "status", get: (r) => rowStatus(r), sortValue: (r) => statusSortValue(r), hideNarrow: true },
  ];
  display(dataTable({ columns, rows, unit, caption: "配下のチーム", exportName: `team_${vm.teamId}_children_${period.from}_${period.to}`, sort: { key: "status", dir: "asc" }, rowHref: (r) => store.href("./team", {}, { id: r.teamId }) }));
}
```

```js
// 契約一覧（このチームの契約のみ。列は他の一覧と同じ standardColumns）
if (vm?.exists) {
  const { period, unit, method, tree } = vm;
  const all = model.contracts.filter((r) => vm.contractIds.includes(r.contract.contractId)).map((r) => ({ ...contractRow(model, r, period, method, tree), key: r.contract.contractId }));
  const rows = all.filter((r) => r.inPeriod);
  const outside = all.length - rows.length;
  display(
    sectionTitle(
      "契約一覧",
      `${vm.name}${vm.isUnassigned ? "" : "（配下のチームを含む）"} の契約。着地: ${METHOD_LABELS[method]}（${model.meta.fiscalYear}年度）。既定の並び: 赤字見込み・予算超過の契約を先頭に、消化率の高い順。${outside > 0 ? `選択期間に掛からない契約 ${outside}件は表示していません。` : ""}クリックで契約詳細へ。`,
      html`<a class="yn-btn yn-btn-sm" href=${store.href("./contracts", { team: vm.teamId })}>契約一覧で絞り込む</a>`,
    ),
  );
  if (rows.length === 0) {
    display(emptyState({ title: "期間内の契約がありません", text: `${vm.name} には、選択した期間（${periodJa(period)}）に掛かる契約がありません。期間を広げてください。`, icon: "○" }));
  } else {
    const detailHref = (id) => store.href("./contract", {}, { id });
    const sub = (r) => `${r.contractId} ${r.customerName} / ${r.projectName}`;
    const columns = [
      { key: "name", label: "契約", type: "text", render: (r) => contractNameCell(r), sortValue: (r) => `${r.customerName} ${r.projectName}`, exportValue: (r) => `${r.customerName} / ${r.projectName}` },
      { key: "contractId", label: "契約ID", type: "text", exportOnly: true },
      { key: "customerName", label: "顧客", type: "text", exportOnly: true },
      { key: "projectName", label: "案件", type: "text", exportOnly: true },
      { key: "teamName", label: "チーム", type: "text", exportOnly: true },
      { key: "period", label: "契約期間", type: "text", exportOnly: true, get: (r) => `${r.startMonth}〜${r.endMonth}` },
      ...standardColumns({
        breakdowns: {
          budget: (r) => bd.budgetAggregateSpec({ model, contractIds: [r.contractId], period, unit }),
          cost: (r) => bd.costAggregateSpec({ model, contractIds: [r.contractId], period, unit, detailHref }),
          grossProfit: (r) => bd.grossProfitSpec({ budget: r.budget, cost: r.cost, unit, subtitle: sub(r) }),
          margin: (r) => bd.marginSpec({ totals: r.totals, unit, subtitle: sub(r) }),
          burnRate: (r) => bd.burnRateSpec({ totals: r.totals, unit, threshold: model.config.burnRateDangerThreshold, asOfMonth: model.meta.asOfMonth, subtitle: sub(r) }),
          forecast: (r) => bd.forecastSpec({ forecast: r.forecast, contract: r.contract, unit, config: model.config }),
        },
      }),
      { key: "status", label: "状態", type: "status", get: (r) => rowStatus(r), sortValue: (r) => statusSortValue(r), hideNarrow: true },
    ];
    display(dataTable({ columns, rows, unit, caption: "チームの契約一覧", exportName: `team_${vm.teamId}_contracts_${period.from}_${period.to}`, sort: { key: "status", dir: "asc" }, rowHref: (r) => detailHref(r.contractId) }));
  }
}
```

```js
// メンバー別原価（作業実績軸: このチームの契約に工数を付けた人。所属チームが別でも含める）
if (vm?.exists) {
  const { period, unit, tree } = vm;
  const inCount = vm.totals.contractCount;
  const teamScope = vm.node ? new Set(vm.node.descendantIds) : null;
  const rows = teamMemberCosts(model, vm.contractIds, period, teamScope).map((r) => ({
    ...r,
    key: r.memberId,
    teams: r.teamIds.map((id) => tree[id]?.name ?? model.teams.find((t) => t.teamId === id)?.name ?? id).join("、") || "—",
    isSupport: r.outsideHours > 0,
  }));
  display(sectionTitle("メンバー別の原価", `${periodJa(period)} に、${vm.name} の期間内の契約${inCount > 0 ? `（${inCount}件）` : ""}へ作業を付けた人ごとの時間と原価（作業実績ベース）。所属チームが別の人も含みます${vm.isUnassigned ? "" : "。所属が配下のチームの外の作業がある人には「応援」を付けています"}。`));
  if (rows.length === 0) {
    display(emptyState({ title: "作業実績がありません", text: "この期間に、このチームの契約へ紐付いた作業ログはありません。", icon: "○" }));
  } else {
    const detailHref = (id) => store.href("./contract", {}, { id });
    const columns = [
      {
        key: "memberName",
        label: "メンバー",
        type: "text",
        render: (r) => html`${r.memberName} <span class="yn-muted">${r.memberId}</span>${r.rateMissing ? html` ${statusChip("neutral", "単価なし", "この期間に時間単価が見つからない月があります（0円で計算）")}` : ""}${r.isSupport ? html` ${statusChip("neutral", "応援", "所属が、このチームと配下のチームの外にある作業を含みます")}` : ""}`,
        sortValue: (r) => r.memberName,
      },
      { key: "teams", label: "所属（当時）", type: "text", hideOnPhone: true },
      { key: "hours", label: "時間", type: "hours", breakdown: (r) => memberCostSpec({ model, contractIds: vm.contractIds, period, unit, member: r, detailHref }) },
      { key: "amount", label: "原価", type: "moneyYen", breakdown: (r) => memberCostSpec({ model, contractIds: vm.contractIds, period, unit, member: r, detailHref }) },
      { key: "share", label: "構成比", type: "percent" },
      { key: "contractCount", label: "契約数", type: "int", hideOnPhone: true, get: (r) => r.contractIds.length },
      { key: "monthCount", label: "作業月数", type: "int", hideOnPhone: true, hideNarrow: true },
    ];
    display(dataTable({ columns, rows, unit, caption: "メンバー別の原価", exportName: `team_${vm.teamId}_members_${period.from}_${period.to}`, sort: { key: "amount", dir: "desc" } }));
  }
}
```

```js
// 組織の変遷（期間内に、このチームの名前・上位、または直下の構成が変わったときだけ）
if (vm?.exists && !vm.isUnassigned) {
  const changes = teamOrgChanges(model.teams, vm.teamId, vm.period);
  if (changes.length > 0) {
    const rows = changes.map((c) => ({ ...c, key: `${c.month}-${c.teamId}-${c.kind}`, kindLabel: ORG_CHANGE_LABELS[c.kind], text: orgChangeText(c) }));
    display(sectionTitle("組織の変遷", `${periodJa(vm.period)} に、${vm.name} の名前・上位チーム・直下のチームが変わった記録。契約は ${monthJa(vm.treeMonth)} 時点の組織で集計しています。`));
    const columns = [
      { key: "month", label: "発効月", type: "text", render: (r) => monthJa(r.month), sortValue: (r) => r.month },
      { key: "kindLabel", label: "種別", type: "text" },
      {
        key: "teamName",
        label: "対象チーム",
        type: "text",
        get: (r) => r.name,
        render: (r) => (vm.tree[r.teamId] && r.teamId !== vm.teamId ? html`<a href=${store.href("./team", {}, { id: r.teamId })}>${r.name}</a>` : r.name),
      },
      { key: "text", label: "内容", type: "text", sortable: false },
    ];
    display(dataTable({ columns, rows, unit: vm.unit, caption: "組織の変遷", exportName: `team_${vm.teamId}_history_${vm.period.from}_${vm.period.to}`, sort: { key: "month", dir: "asc" } }));
  }
}
```
