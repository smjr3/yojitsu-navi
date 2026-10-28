---
title: 工数
---

<div id="page-skeleton" class="yn-skeleton" aria-busy="true" aria-label="読み込み中">
  <div class="yn-skel-line yn-skel-title"></div>
  <div class="yn-skel-line"></div>
  <div class="yn-skel-grid"><div></div><div></div><div></div><div></div></div>
  <div class="yn-skel-block"></div>
</div>

```js
import { html } from "htl";
import { T, fmt } from "./i18n/index.js";
import { UNASSIGNED_WORK_KEY, aggregateWork, customerKey, decodeWorkRows, elapsedMonthCount, memberTeamsAt, monthRange, personMonths, workMonthlySeries, workTotals } from "./core/index.js";
import { createStore } from "./components/state.js";
import { scopeFor, teamName, memberIdsInTeam } from "./components/analysis.js";
import { pageHeader, sectionTitle, loadJson, note } from "./components/layout.js";
import { mountFilterBar } from "./components/filters.js";
import { statTile, kpiRow } from "./components/kpi.js";
import { dataTable } from "./components/table.js";
import { customerHref } from "./components/customers.js";
import { formatHours, formatPercent, monthJa, periodJa } from "./components/format.js";
import { pm, workGroupChart, workHoursChart, workHoursLegend, workSeriesTable, workTaskSection, workTaskSpec } from "./components/work.js";
```

```js
// model.json（全ページ共通）と work-hours.json（工数の明細）を並行して読む
const model = await loadJson(
  {
    json: async () => {
      const [m, d] = await Promise.all([FileAttachment("./data/model.json").json(), FileAttachment("./data/work-hours.json").json()]);
      return { ...m, workRows: decodeWorkRows(d) };
    },
  },
  { skeleton: "page-skeleton" },
);
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
// 集計の軸（URL の axis。ストアの外＝このページだけ）
const AXES = [
  { id: "team", label: T.work.axisTeam },
  { id: "customer", label: T.work.axisCustomer },
  { id: "member", label: T.work.axisMember },
];
const axisControl = (() => {
  const initial = new URLSearchParams(location.search).get("axis");
  const form = html`<div class="yn-chip-filters yn-work-axis"><span class="yn-filter-label" id="yn-axis-label">${T.work.axisLabel}</span></div>`;
  const group = html`<div class="yn-seg" role="group" aria-labelledby="yn-axis-label"></div>`;
  form.value = AXES.some((a) => a.id === initial) ? initial : "team";
  const btns = AXES.map((a) => {
    const b = html`<button type="button" class="yn-seg-btn" data-axis=${a.id} aria-pressed=${a.id === form.value ? "true" : "false"}>${a.label}</button>`;
    b.addEventListener("click", () => {
      if (form.value === a.id) return;
      form.value = a.id;
      for (const x of btns) x.setAttribute("aria-pressed", x.dataset.axis === a.id ? "true" : "false");
      const url = new URL(location.href);
      if (a.id === "team") url.searchParams.delete("axis");
      else url.searchParams.set("axis", a.id);
      history.replaceState(history.state, "", url);
      form.dispatchEvent(new CustomEvent("input", { bubbles: true }));
    });
    return b;
  });
  group.append(...btns);
  form.append(group);
  return form;
})();
```

```js
const vm = (() => {
  if (!model || !state) return null;
  const scope = scopeFor(model, state);
  const { period } = scope;
  const baseMonth = period.to < model.meta.asOfMonth ? period.to : model.meta.asOfMonth;
  const inPeriod = model.workRows.filter((r) => r.month >= period.from && r.month <= period.to);
  // チームで絞る: メンバーの所属（基準月。上位は配下を含む）
  const teams = memberTeamsAt(model, inPeriod, baseMonth);
  const people = [...teams.entries()].map(([memberId, teamId]) => ({ memberId, teamId }));
  const ids = memberIdsInTeam(people, state.team, scope.tree);
  const idSet = ids ? new Set(ids) : null;
  const rows = idSet ? inPeriod.filter((r) => idSet.has(r.memberId)) : inPeriod;
  const elapsed = elapsedMonthCount(period, model.meta.asOfMonth);
  const totals = workTotals(rows, elapsed);
  const series = workMonthlySeries(rows, period, model.meta);
  return { scope, period, baseMonth, rows, totals, series, months: monthRange(period.from, period.to).filter((m) => m <= model.meta.asOfMonth), unit: state.unit };
})();
```

```js
if (model) {
  display(
    pageHeader({
      model,
      title: T.app.pages.workload,
      lead: T.work.lead,
      breadcrumbs: [{ label: T.app.pages.index, href: store.href("./") }, { label: T.app.pages.workload }],
      includesPreliminary: vm?.series.some((p) => p.status === "preliminary" && p.contractHours + p.outsideHours > 0) ?? false,
    }),
  );
}
```

```js
if (store) mountFilterBar(store, model, { show: ["period", "team"] });
```

```js
if (vm?.scope.teamMissing) display(note(fmt(T.members.teamMissing, { team: vm.scope.teamLabel, month: monthJa(vm.baseMonth) }), "warn"));
```

```js
if (vm) {
  const { totals: t, period } = vm;
  const cfg = model.config;
  const subtitle = `${vm.scope.teamLabel} ・ ${periodJa(period)}`;
  const spec = (title) => () => workTaskSpec({ title, subtitle, rows: vm.rows, config: cfg });
  const row = kpiRow(
    [
      statTile({ label: T.work.kpiContract, value: pm(t.contractHours, cfg), sub: formatHours(t.contractHours), breakdown: spec(T.work.kpiContract) }),
      statTile({ label: T.work.kpiOutside, value: pm(t.outsideHours, cfg), sub: fmt(T.work.kpiOutsideSub, { share: formatPercent(t.outsideShare) }), breakdown: spec(T.work.kpiOutside) }),
      statTile({ label: T.work.kpiPeople, value: fmt(T.work.peopleValue, { n: t.memberCount }), sub: fmt(T.work.kpiPeopleSub, { months: t.elapsedMonths }) }),
      statTile({
        label: T.work.kpiPerPerson,
        value: t.hoursPerMemberMonth === null ? "—" : pm(t.hoursPerMemberMonth, cfg),
        sub: t.hoursPerMemberMonth === null ? T.work.kpiPerPersonNone : fmt(T.work.kpiPerPersonSub, { hours: formatHours(t.hoursPerMemberMonth) }),
        breakdown: () => ({
          title: T.work.kpiPerPerson,
          subtitle,
          formula: T.work.perPersonFormula,
          rows: [
            { label: T.work.total, value: `${formatHours(t.totalHours)}（${pm(t.totalHours, cfg)}）` },
            { label: T.work.colMembers, value: fmt(T.work.peopleValue, { n: t.memberCount }) },
            { label: T.work.elapsedMonths, value: fmt(T.work.monthsValue, { n: t.elapsedMonths }) },
            { label: T.work.kpiPerPerson, value: t.hoursPerMemberMonth === null ? "—" : `${pm(t.hoursPerMemberMonth, cfg)}（${formatHours(t.hoursPerMemberMonth)}）`, emphasis: true },
          ],
        }),
      }),
    ],
    { columns: 4 },
  );
  row.classList.add("yn-kpi-4");
  display(row);
  if (t.totalHours === 0) display(note(fmt(T.work.noData, { period: periodJa(period) })));
}
```

```js
if (vm) {
  display(sectionTitle(T.work.monthlyTitle, fmt(T.work.monthlyHint, { period: periodJa(vm.period), hours: model.config.standardHoursPerMonth })));
  display(html`<figure class="yn-card yn-chart-card">
    ${workHoursLegend(dark)}
    ${resize((width) => workHoursChart({ series: vm.series, config: model.config, dark, width, asOfMonth: model.meta.asOfMonth }))}
    <details class="yn-details"><summary>${T.pages.showTable}</summary>${workSeriesTable({ series: vm.series, config: model.config, exportName: `workload_monthly_${vm.period.from}_${vm.period.to}` })}</details>
  </figure>`);
}
```

```js
if (axisControl) display(axisControl);
```

```js
const axis = axisControl ? Generators.input(axisControl) : "team";
```

```js
if (vm) {
  const cfg = model.config;
  const { period } = vm;
  const groups = aggregateWork(model, vm.rows, { period, axis, tree: vm.scope.tree, unassignedLabel: axis === "customer" ? T.numbers.noCustomerName : T.members.noTeam });
  const label = AXES.find((a) => a.id === axis)?.label ?? "";
  display(sectionTitle(fmt(T.work.tableTitle, { axis: label }), fmt(axis === "team" ? T.work.tableHintTeam : axis === "customer" ? T.work.tableHintCustomer : T.work.tableHintMember, { period: periodJa(period), month: monthJa(vm.baseMonth) })));
  // 分布のグラフ（チームは末端の組織だけ。上位は配下の合計で二重になるため）
  const chartGroups = axis === "team" ? groups.filter((g) => !g.hasChildren) : groups;
  display(html`<figure class="yn-card yn-chart-card">
    ${workHoursLegend(dark)}
    ${resize((width) => workGroupChart({ groups: chartGroups, config: cfg, dark, width, ariaLabel: fmt(T.work.distAriaAxis, { axis: label }) }))}
    ${chartGroups.length > 20 ? html`<p class="yn-note">${fmt(T.work.distTrimmed, { n: 20, total: chartGroups.length })}</p>` : null}
  </figure>`);
  const pmCol = (key, labelText, get, extra = {}) => ({
    key,
    label: labelText,
    type: "custom",
    align: "num",
    get: (r) => personMonths(get(r), cfg.standardHoursPerMonth),
    render: (r) => pm(get(r), cfg),
    breakdown: (r) => workTaskSpec({ title: `${r.name} ・ ${labelText}`, subtitle: periodJa(period), rows: r.rows, config: cfg }),
    ...extra,
  });
  const rows = groups.map((g) => ({
    ...g,
    name: g.label,
    teamName: axis === "member" ? (g.teamId ? teamName(model, g.teamId, vm.scope.tree) : T.members.noTeam) : "",
  }));
  const columns = [
    {
      key: "name",
      label: label,
      type: "text",
      render: axis === "member" ? (r) => html`<span class="yn-cell-2line"><span class="yn-cell-main">${r.name}</span><span class="yn-cell-sub">${r.teamName}</span></span>` : undefined,
      exportValue: (r) => r.name,
    },
    ...(axis === "member" ? [{ key: "teamName", label: T.members.colTeam, type: "text", exportOnly: true }] : [{ key: "people", label: T.work.colMembers, type: "int", get: (r) => r.totals.memberCount, hideOnPhone: true }]),
    pmCol("contract", T.work.contract, (r) => r.totals.contractHours),
    pmCol("outside", T.work.outside, (r) => r.totals.outsideHours),
    pmCol("total", T.work.total, (r) => r.totals.totalHours, { hideOnPhone: true }),
    { key: "share", label: T.work.colOutsideShare, type: "percent", get: (r) => r.totals.outsideShare, hideOnPhone: true },
    {
      key: "perPerson",
      label: T.work.colPerPerson,
      sublabel: T.work.colPerPersonSub,
      type: "custom",
      align: "num",
      get: (r) => (r.totals.hoursPerMemberMonth === null ? null : personMonths(r.totals.hoursPerMemberMonth, cfg.standardHoursPerMonth)),
      render: (r) => (r.totals.hoursPerMemberMonth === null ? "—" : pm(r.totals.hoursPerMemberMonth, cfg)),
      // メンバー別では 1 人の月平均＝稼働の重さなので狭い画面でも出す
      hideNarrow: axis !== "member",
    },
  ];
  // 顧客詳細は契約のある顧客だけ（契約外の作業しかない顧客には詳細画面が無い）
  const contractCustomers = new Set(model.contracts.map((c) => customerKey(c.contract.customerName)));
  const rowHref =
    axis === "member"
      ? (r) => store.href("./member", {}, { id: r.key })
      : axis === "customer"
        ? (r) => (contractCustomers.has(r.key) ? customerHref(store, r.key) : null)
        : (r) => (r.key === UNASSIGNED_WORK_KEY ? null : store.href("./team", {}, { id: r.key }));
  const total = workTotals(vm.rows, elapsedMonthCount(period, model.meta.asOfMonth));
  display(
    dataTable({
      columns,
      rows,
      unit: vm.unit,
      tree: axis === "team",
      caption: fmt(T.work.tableTitle, { axis: label }),
      exportName: `workload_${axis}_${period.from}_${period.to}`,
      sort: axis === "team" ? null : { key: "total", dir: "desc" },
      rowHref,
      emptyText: T.work.empty,
      summary:
        axis === "team" || rows.length === 0
          ? null
          : { name: fmt(T.work.totalRow, { n: rows.length }), teamName: null, totals: total, rows: vm.rows },
      summaryBreakdown: (col) => (["contract", "outside", "total"].includes(col.key) ? () => workTaskSpec({ title: col.label, subtitle: periodJa(period), rows: vm.rows, config: cfg }) : null),
    }),
  );
}
```

```js
if (vm) {
  display(
    workTaskSection({
      rows: vm.rows,
      months: vm.months,
      unit: vm.unit,
      config: model.config,
      hint: fmt(T.work.sectionHintAll, { period: periodJa(vm.period) }),
      exportName: `workload_tasks_${vm.period.from}_${vm.period.to}`,
    }),
  );
}
```
