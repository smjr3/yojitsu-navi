---
title: メンバー詳細
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
import { aggregateMembers, memberMonthlySeries, memberRecordsOf, memberBaseMonth } from "./core/index.js";
import { createStore } from "./components/state.js";
import { teamName, treeAt } from "./components/analysis.js";
import { pageHeader, sectionTitle, emptyState, loadJson, note } from "./components/layout.js";
import { mountFilterBar } from "./components/filters.js";
import { statTile, kpiRow, statusChip } from "./components/kpi.js";
// KPI 4 枚（計画原価・実績原価・差額・稼働率）。1024px でも 4 枚が 1 行（狭いと 2×2）に並ぶようにクラスを足す
const memberKpiRow = (tiles) => {
  const row = kpiRow(tiles, { columns: 4 });
  row.classList.add("yn-kpi-4");
  return row;
};
import { memberHoursChart, memberHoursLegend } from "./components/charts.js";
import { dataTable, contractNameCell } from "./components/table.js";
import * as bd from "./components/breakdown.js";
import { EMPTY_VALUE, money, moneySigned, varianceNote, formatHours, formatPercent, monthJa, periodJa, periodCompact, STATUS_LABELS } from "./components/format.js";
```

```js
// model.json（全ページ共通）と member-months.json（メンバー別だけ）を並行して読む
const loaded = await loadJson(
  {
    json: async () => {
      const [m, d] = await Promise.all([FileAttachment("./data/model.json").json(), FileAttachment("./data/member-months.json").json()]);
      return { model: { ...m, memberMonths: d.memberMonths }, rateHistory: d.rateHistory ?? {} };
    },
  },
  { skeleton: "page-skeleton" },
);
const model = loaded?.model ?? null;
const rateHistory = loaded?.rateHistory ?? {};
const memberId = new URLSearchParams(location.search).get("id") ?? "";
const records = model ? memberRecordsOf(model, memberId) : [];
const allMonths = model ? model.memberMonths.filter((mm) => mm.memberId === memberId) : [];
// マスタにあるか、作業実績・アサインのどちらかに出てくれば「存在する」
const exists = records.length > 0 || allMonths.length > 0;
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
  if (!model || !state || !exists) return null;
  const fullPeriod = { from: state.from, to: state.to };
  // 比較（KPI・契約別・合計）は経過月（期間内で基準月以前）。月次推移は期間全体（SPEC §18.2）
  const asOf = model.meta.asOfMonth;
  const allFuture = fullPeriod.from > asOf;
  const period = allFuture ? fullPeriod : { from: fullPeriod.from, to: fullPeriod.to < asOf ? fullPeriod.to : asOf };
  const agg = aggregateMembers(model, { period, memberIds: [memberId] });
  const totals = agg.members[0] ?? null;
  const fullTotals = period.to === fullPeriod.to ? totals : (aggregateMembers(model, { period: fullPeriod, memberIds: [memberId] }).members[0] ?? null);
  const months = allMonths.filter((mm) => period.from <= mm.month && mm.month <= period.to);
  const fullMonths = allMonths.filter((mm) => fullPeriod.from <= mm.month && mm.month <= fullPeriod.to);
  const series = memberMonthlySeries(model, memberId, fullPeriod);
  const baseMonth = memberBaseMonth(model, period);
  const { tree } = treeAt(model, baseMonth);
  // 見出しの名前: 基準月のマスタ → 最新のマスタ → 作業ログの名前
  const rec = [...records].reverse().find((r) => r.effectiveFrom <= baseMonth) ?? records[records.length - 1] ?? null;
  const name = totals?.memberName ?? rec?.name ?? allMonths[allMonths.length - 1]?.memberName ?? memberId;
  return { period, fullPeriod, allFuture, fullTotals, fullMonths, totals, months, series, baseMonth, tree, rec, name, unit: state.unit, member: { memberId, memberName: name } };
})();
```

```js
if (model && !exists) {
  display(
    pageHeader({
      model,
      title: T.member.pageTitle,
      breadcrumbs: [{ label: T.app.pages.index, href: store.href("./") }, { label: T.app.pages.members, href: store.href("./members") }, { label: memberId || T.member.noIdCrumb }],
    }),
  );
  display(
    emptyState({
      title: memberId ? fmt(T.member.notFoundTitle, { id: memberId }) : T.member.noIdTitle,
      text: memberId ? T.member.notFoundText : T.member.noIdText,
      actions: [{ label: T.member.back, href: store.href("./members") }],
    }),
  );
}
```

```js
if (vm) {
  const { rec, totals } = vm;
  const unknown = records.length === 0;
  display(
    pageHeader({
      model,
      title: vm.name,
      breadcrumbs: [{ label: T.app.pages.index, href: store.href("./") }, { label: T.app.pages.members, href: store.href("./members") }, { label: vm.name }],
      includesPreliminary: totals?.includesPreliminary ?? false,
      extra: html`<a class="yn-btn yn-btn-sm" id="yn-member-plan-link" href=${`./plan?member=${encodeURIComponent(memberId)}`}>${T.plan.toMemberPlan}</a>`,
    }),
  );
  const teamText = (id) => (id ? teamName(model, id, vm.tree) : T.members.noTeam);
  display(html`<dl class="yn-facts" aria-label=${T.member.factsLabel}>
    <div><dt>${T.members.colKind}</dt><dd>${unknown ? statusChip("neutral", T.members.chipUnknown, T.member.unknownTitle) : rec?.kind === "partner" ? T.members.kindPartner : T.members.kindEmployee}</dd></div>
    <div><dt>${fmt(T.member.teamAt, { team: model.config.labels?.team ?? T.columns.team, month: monthJa(vm.baseMonth) })}</dt><dd>${rec?.teamId ? html`<a href=${store.href("./members", { team: rec.teamId })}>${teamText(rec.teamId)}</a>` : T.members.noTeam}</dd></div>
    <div><dt>${T.members.colTitle}</dt><dd>${rec?.title || EMPTY_VALUE}</dd></div>
    ${rec?.department ? html`<div><dt>${T.member.department}</dt><dd>${rec.department}${rec.section ? ` ${rec.section}` : ""}</dd></div>` : null}
  </dl>`);
  if (records.length > 1) {
    display(html`<details class="yn-details yn-member-history">
      <summary>${fmt(T.member.historySummary, { n: records.length })}</summary>
      ${dataTable({
        columns: [
          { key: "effectiveFrom", label: T.member.colEffective, type: "text", render: (r) => monthJa(r.effectiveFrom), exportValue: (r) => r.effectiveFrom },
          { key: "team", label: T.members.colTeam, type: "text", get: (r) => teamText(r.teamId) },
          { key: "title", label: T.members.colTitle, type: "text" },
          { key: "kind", label: T.members.colKind, type: "text", get: (r) => (r.kind === "partner" ? T.members.kindPartner : T.members.kindEmployee) },
        ],
        rows: records.map((r, i) => ({ ...r, key: `${r.effectiveFrom}-${i}` })),
        caption: T.member.historyCaption,
        sort: { key: "effectiveFrom", dir: "asc" },
      })}
    </details>`);
  }
}
```

```js
if (store && exists) mountFilterBar(store, model, { show: ["period", "unit"] });
```

```js
if (vm) {
  const { totals, unit, period, months, member } = vm;
  const t = totals ?? { plannedCost: 0, actualCost: 0, plannedHours: 0, actualHours: 0, variance: 0, utilization: null, unplannedHours: 0, unplannedCost: 0 };
  const subtitle = `${vm.name}（${memberId}） ・ ${periodJa(period)}`;
  const contractHref = (id) => store.href("./contract", {}, { id });
  display(
    memberKpiRow([
        statTile({ label: fmt(T.members.plannedCostPeriod, { period: periodJa(period) }), value: money(t.plannedCost, unit), sub: fmt(T.member.plannedSub, { hours: formatHours(t.plannedHours) }), breakdown: () => bd.memberPlanSpec({ model, member, months, unit, subtitle: periodJa(period), contractHref }) }),
        statTile({ label: T.breakdown.actualCost, value: money(t.actualCost, unit), sub: fmt(T.member.actualSub, { hours: formatHours(t.actualHours), unplanned: t.unplannedHours > 0 ? fmt(T.member.unplannedSuffix, { hours: formatHours(t.unplannedHours) }) : "" }), breakdown: () => bd.memberActualSpec({ model, member, months, unit, subtitle: periodJa(period), contractHref }) }),
        statTile({ label: T.members.varianceTile, value: moneySigned(t.variance, unit), sub: varianceNote(t.variance, unit), breakdown: () => bd.memberVarianceSpec({ plannedCost: t.plannedCost, actualCost: t.actualCost, unit, subtitle }) }),
        statTile({ label: T.members.utilizationTile, value: formatPercent(t.utilization), sub: t.utilization === null ? T.breakdown.utilZero : `${formatHours(t.actualHours)} ÷ ${formatHours(t.plannedHours)}`, breakdown: () => bd.memberUtilizationSpec({ plannedHours: t.plannedHours, actualHours: t.actualHours, utilization: t.utilization, unplannedHours: t.unplannedHours, subtitle }) }),
    ]),
  );
  if (vm.allFuture) display(note(fmt(T.members.futureOnly, { period: periodJa(vm.fullPeriod) })));
  else if (period.to !== vm.fullPeriod.to && vm.fullTotals)
    display(note(fmt(T.member.elapsedNote, { period: periodJa(period), to: monthJa(vm.fullPeriod.to), total: money(vm.fullTotals.plannedCost, unit), hours: formatHours(vm.fullTotals.plannedHours) })));
  if (!totals) display(note(fmt(T.member.noData, { period: periodJa(period) })));
  if (totals?.rateMissing) display(note(T.member.rateMissingNote, "warn"));
}
```

```js
if (vm) {
  const { unit, member, series } = vm;
  const period = vm.fullPeriod;
  display(sectionTitle(T.charts.monthlyTitle, fmt(T.member.monthlyHint, { period: periodJa(period), asOfMonth: monthJa(model.meta.asOfMonth) })));
  display(html`<figure class="yn-card yn-chart-card">
    ${memberHoursLegend(dark)}
    ${resize((width) => memberHoursChart({ series, dark, width, asOfMonth: model.meta.asOfMonth }))}
  </figure>`);
  const contractHref = (id) => store.href("./contract", {}, { id });
  const monthRows = (m) => vm.fullMonths.filter((mm) => mm.month === m);
  const rows = series.map((p) => ({ ...p, key: p.month, isFuture: p.month > model.meta.asOfMonth }));
  // 未来の月は実績が無い: 実績・稼働率・差額は「—」（根拠ボタンなし）
  const fut = (fn) => (r, u) => (r.isFuture ? EMPTY_VALUE : fn(r, u));
  const columns = [
    { key: "month", label: T.charts.colMonth, type: "text", render: (r) => monthJa(r.month), sortValue: (r) => r.month, exportValue: (r) => r.month },
    { key: "status", label: T.columns.status, type: "status", get: (r) => ({ kind: r.status === "final" ? "ok" : r.status === "preliminary" ? "prelim" : "neutral", text: STATUS_LABELS[r.status] }), hideOnPhone: true },
    { key: "plannedHours", label: T.breakdown.plannedHours, type: "hours", breakdown: (r) => bd.memberPlanSpec({ model, member, months: monthRows(r.month), unit, measure: "hours", subtitle: monthJa(r.month), contractHref }) },
    { key: "actualHours", label: T.breakdown.actualHours, type: "hours", render: fut((r) => formatHours(r.actualHours)), breakdown: (r) => bd.memberActualSpec({ model, member, months: monthRows(r.month), unit, measure: "hours", subtitle: monthJa(r.month), contractHref }) },
    { key: "utilization", label: T.breakdown.utilization, type: "percent", render: fut((r) => formatPercent(r.utilization)), breakdown: (r) => bd.memberUtilizationSpec({ plannedHours: r.plannedHours, actualHours: r.actualHours, utilization: r.utilization, unplannedHours: r.unplannedHours, subtitle: monthJa(r.month) }) },
    { key: "plannedCost", label: T.breakdown.plannedCost, type: "moneyYen", hideOnPhone: true, breakdown: (r) => bd.memberPlanSpec({ model, member, months: monthRows(r.month), unit, subtitle: monthJa(r.month), contractHref }) },
    { key: "actualCost", label: T.breakdown.actualCost, type: "moneyYen", hideOnPhone: true, render: fut((r, u) => money(r.actualCost, u)), breakdown: (r) => bd.memberActualSpec({ model, member, months: monthRows(r.month), unit, subtitle: monthJa(r.month), contractHref }) },
    { key: "variance", label: T.breakdown.variance, sublabel: T.members.varianceSub, type: "moneyYen", render: fut((r, u) => moneySigned(r.variance, u)), breakdown: (r) => bd.memberVarianceSpec({ plannedCost: r.plannedCost, actualCost: r.actualCost, unit, subtitle: monthJa(r.month) }) },
  ];
  const t = vm.totals;
  const sumLabel = vm.period.to !== period.to ? fmt(T.member.totalElapsed, { period: periodJa(vm.period) }) : T.table.total;
  display(
    dataTable({
      columns,
      rows,
      unit,
      caption: T.member.monthlyCaption,
      exportName: `member_${memberId}_monthly_${period.from}_${period.to}`,
      sort: { key: "month", dir: "asc" },
      summary: t ? { name: sumLabel, plannedHours: t.plannedHours, actualHours: t.actualHours, utilization: t.utilization, plannedCost: t.plannedCost, actualCost: t.actualCost, variance: t.variance, status: null } : null,
    }),
  );
}
```

```js
if (vm) {
  const { unit, period, member, totals } = vm;
  display(sectionTitle(T.member.byContract, fmt(T.member.byContractHint, { period: periodJa(period), elapsed: period.to !== vm.fullPeriod.to ? T.members.elapsedSuffix : "" })));
  const byId = new Map(model.contracts.map((r) => [r.contract.contractId, r.contract]));
  const contractHref = (id) => store.href("./contract", {}, { id });
  const rows = (totals?.byContract ?? []).map((c) => {
    const k = byId.get(c.contractId);
    return {
      ...c,
      key: c.contractId,
      customerName: k?.customerName ?? "",
      projectName: k?.projectName ?? "",
      teamName: k?.teamId ? teamName(model, k.teamId, vm.tree) : T.numbers.unassignedTeam,
      startMonth: k?.startMonth ?? "",
      endMonth: k?.endMonth ?? "",
    };
  });
  const chips = (r) =>
    r.assignedMonths === 0
      ? [{ kind: "neutral", text: T.member.noAssignment, title: T.member.noAssignmentTitle }]
      : r.unplannedHours > 0
        ? [{ kind: "neutral", text: fmt(T.members.chipUnplanned, { hours: formatHours(r.unplannedHours) }), title: T.member.unplannedTitle }]
        : [];
  const columns = [
    { key: "contractId", label: T.columns.contract, type: "text", render: (r) => contractNameCell(r), sortValue: (r) => r.contractId, exportValue: (r) => r.contractId },
    { key: "contractName", label: T.breakdown.colCustomerProject, type: "text", exportOnly: true, get: (r) => `${r.customerName} / ${r.projectName}` },
    { key: "plannedHours", label: T.breakdown.plannedHours, type: "hours", hideOnPhone: true, breakdown: (r) => bd.memberPlanSpec({ model, member, months: vm.months, contractIds: [r.contractId], unit, measure: "hours", subtitle: `${r.customerName} / ${r.projectName} ・ ${periodJa(period)}`, contractHref }) },
    { key: "actualHours", label: T.breakdown.actualHours, type: "hours", hideOnPhone: true, breakdown: (r) => bd.memberActualSpec({ model, member, months: vm.months, contractIds: [r.contractId], unit, measure: "hours", subtitle: `${r.customerName} / ${r.projectName} ・ ${periodJa(period)}`, contractHref }) },
    { key: "plannedCost", label: T.breakdown.plannedCost, type: "moneyYen", breakdown: (r) => bd.memberPlanSpec({ model, member, months: vm.months, contractIds: [r.contractId], unit, subtitle: `${r.customerName} / ${r.projectName} ・ ${periodJa(period)}`, contractHref }) },
    { key: "actualCost", label: T.breakdown.actualCost, type: "moneyYen", breakdown: (r) => bd.memberActualSpec({ model, member, months: vm.months, contractIds: [r.contractId], unit, subtitle: `${r.customerName} / ${r.projectName} ・ ${periodJa(period)}`, contractHref }) },
    { key: "variance", label: T.breakdown.variance, sublabel: T.members.varianceSub, type: "moneyYen", render: (r, u) => moneySigned(r.variance, u), breakdown: (r) => bd.memberVarianceSpec({ plannedCost: r.plannedCost, actualCost: r.actualCost, unit, subtitle: `${r.customerName} / ${r.projectName} ・ ${periodJa(period)}` }) },
    { key: "status", label: T.breakdown.colAssignment, type: "status", get: chips, sortable: false, hideNarrow: true },
  ];
  if (rows.length === 0) display(emptyState({ title: T.member.noContractsTitle, text: T.member.noContractsText, icon: "○" }));
  else
    display(
      dataTable({
        columns,
        rows,
        unit,
        caption: T.member.byContractCaption,
        exportName: `member_${memberId}_contracts_${period.from}_${period.to}`,
        sort: { key: "actualCost", dir: "desc" },
        rowHref: (r) => contractHref(r.contractId),
        summary: { name: T.table.total, plannedHours: totals.plannedHours, actualHours: totals.actualHours, plannedCost: totals.plannedCost, actualCost: totals.actualCost, variance: totals.variance, status: null },
      }),
    );
}
```

```js
if (vm) {
  const segs = rateHistory[memberId] ?? [];
  display(sectionTitle(T.member.rateHistory, fmt(T.member.rateHistoryHint, { from: monthJa(model.meta.minMonth), to: monthJa(model.meta.maxMonth) })));
  if (segs.length === 0) display(emptyState({ title: T.member.noRateTitle, text: T.member.noRateText, icon: "○" }));
  else
    display(
      dataTable({
        columns: [
          { key: "from", label: T.member.colPeriod, type: "text", render: (r) => (r.from === r.to ? monthJa(r.from) : `${monthJa(r.from)}〜${monthJa(r.to)}`), exportValue: (r) => `${r.from}〜${r.to}` },
          { key: "title", label: T.members.colTitle, type: "text", hideOnPhone: true },
          { key: "hourlyRate", label: T.member.colHourlyRate, type: "moneyYen", render: (r) => (r.rateMissing ? statusChip("neutral", T.breakdown.rateMissingZero2, T.member.rateMissingTitle) : money(r.hourlyRate, "yen")) },
          { key: "source", label: T.breakdown.colRateSource, type: "text", get: (r) => (r.rateMissing ? "—" : r.rateSource?.key === memberId ? fmt(T.member.personalRateFrom, { from: r.rateSource.effectiveFrom }) : fmt(T.member.roleRateFrom, { role: r.rateSource?.key, from: r.rateSource?.effectiveFrom })) },
        ],
        rows: segs.map((s) => ({ ...s, key: s.from })),
        caption: T.member.rateHistory,
        exportName: `member_${memberId}_rates`,
        sort: { key: "from", dir: "asc" },
      }),
    );
}
```
