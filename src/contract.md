---
title: 案件詳細
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
import { aggregate, contractEndForecasts, FORECAST_METHODS, setForecastPeriod } from "./core/index.js";
import { customerKey } from "./core/index.js";
import { customerHref } from "./components/customers.js";
import { createStore } from "./components/state.js";
import { seriesWithForecast, forecastMonthlyCost, contractTeamName, treeAt, treeMonthFor, grossMarginOf } from "./components/analysis.js";
import { pageHeader, sectionTitle, emptyState, loadJson, note } from "./components/layout.js";
import { mountFilterBar } from "./components/filters.js";
import { statTile, kpiRow, statusChip } from "./components/kpi.js";
import { chartFigure } from "./components/chart-zoom.js";
import { dailyFor, dailySection, loadDaily } from "./components/daily.js";
import { monthlyChart, monthlyLegend, seriesTable, burnMeter } from "./components/charts.js";
import { dataTable } from "./components/table.js";
import * as bd from "./components/breakdown.js";
import { targetSection } from "./components/targets.js";
import { EMPTY_VALUE, money, formatPercent, formatHours, monthJa, monthSpanJa, periodJa, METHOD_LABELS, methodDescription, STATUS_LABELS, fiscalYearLabel, profitLabel, integer } from "./components/format.js";
```

```js
const model = await loadJson(FileAttachment("./data/model.json"), { skeleton: "page-skeleton" });
// 前後の空白は無視し、完全一致が無ければ大文字・小文字の違いだけの契約を探す（URL を手で打ったとき用）
const contractId = (new URLSearchParams(location.search).get("id") ?? "").trim();
const result = model
  ? model.contracts.find((r) => r.contract.contractId === contractId) ??
    model.contracts.find((r) => r.contract.contractId.toLowerCase() === contractId.toLowerCase()) ??
    null
  : null;
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
  if (!model || !state || !result) return null;
  const c = result.contract;
  // 期間は契約期間に収める
  const from = state.from > c.startMonth ? state.from : c.startMonth;
  const to = state.to < c.endMonth ? state.to : c.endMonth;
  const inRange = from <= to;
  const period = inRange ? { from, to } : { from: c.startMonth, to: c.endMonth };
  const scope = { period, contractIds: [c.contractId] };
  // 着地見込みは選択中の期間（契約期間に収めたもの）の終わりまで。あわせて案件終了時点の着地も出す（§54）
  setForecastPeriod(model, period);
  const endForecasts = contractEndForecasts(model, result);
  const isWhole = period.from === c.startMonth && period.to === c.endMonth;
  const totals = aggregate(model, scope);
  const series = seriesWithForecast(model, scope, state.method);
  const months = result.months.filter((m) => period.from <= m.month && m.month <= period.to);
  const { tree } = treeAt(model, treeMonthFor(model, period));
  return { contract: c, result, period, inRange, totals, series, months, endForecasts, isWhole, unit: state.unit, method: state.method, teamLabel: contractTeamName(model, c, tree) };
})();
```

```js
if (model && !result) {
  display(
    pageHeader({
      model,
      title: T.contract.pageTitle,
      breadcrumbs: [{ label: T.app.pages.index, href: store.href("./") }, { label: T.app.pages.contracts, href: store.href("./contracts") }, { label: contractId || T.contract.noIdCrumb }],
    }),
  );
  display(
    emptyState({
      title: contractId ? fmt(T.contract.notFoundTitle, { id: contractId }) : T.contract.noIdTitle,
      text: contractId ? T.contract.notFoundText : T.contract.noIdText,
      actions: [{ label: T.contract.back, href: store.href("./contracts") }],
    }),
  );
}
```

```js
if (vm) {
  const c = vm.contract;
  display(
    pageHeader({
      model,
      title: `${c.customerName} / ${c.projectName}`,
      breadcrumbs: [{ label: T.app.pages.index, href: store.href("./") }, { label: T.app.pages.contracts, href: store.href("./contracts") }, { label: c.projectName || c.customerName }],
      includesPreliminary: vm.totals.includesPreliminary,
      extra: html`<a class="yn-btn yn-btn-sm" href=${store.href("./contracts", { team: c.teamId ?? "" })}>${T.contract.sameTeam}</a>`,
    }),
  );
  display(html`<dl class="yn-facts" aria-label=${T.contract.factsLabel}>
    <div><dt>${model.config.labels?.customer ?? T.customers.colCustomer}</dt><dd><a href=${customerHref(store, customerKey(c.customerName))}>${c.customerName}</a></dd></div>
    <div><dt>${model.config.labels?.project ?? T.contracts.colProject}</dt><dd>${c.projectName}</dd></div>
    <div><dt>${fmt(T.contract.mainTeam, { team: model.config.labels?.team ?? T.columns.team })}</dt><dd>${c.teamId ? html`<a href=${store.href("./contracts", { team: c.teamId })}>${vm.teamLabel}</a>` : html`<span class="yn-chip yn-chip-neutral">${T.numbers.unassignedTeam}</span>`}</dd></div>
    <div><dt>${T.columns.contractPeriod}</dt><dd>${fmt(T.contract.periodValue, { from: monthJa(c.startMonth), to: monthJa(c.endMonth), n: result.months.length })}</dd></div>
    <div><dt>${T.breakdown.totalAmount}</dt><dd class="num">${money(c.totalAmount, vm.unit)}</dd></div>
    ${c.note ? html`<div><dt>${T.contract.note}</dt><dd>${c.note}</dd></div>` : null}
  </dl>`);
}
```

```js
if (store && result) mountFilterBar(store, model, { show: ["period", "method", "unit"] });
```

```js
if (vm && !vm.inRange) {
  display(note(fmt(T.contract.noOverlap, { from: monthJa(state.from), to: monthJa(state.to) }), "warn"));
}
```

```js
if (vm) {
  const { contract: c, totals, unit, period } = vm;
  const f = result.forecasts[vm.method];
  const elapsedLabel = (months) =>
    months.length === 0 ? T.kpi.noElapsed : fmt(T.kpi.elapsed, { span: monthSpanJa(months), n: months.length, prelim: months[months.length - 1] > model.meta.lastFinalMonth ? T.kpi.elapsedPrelim : "" });
  const subtitle = `${c.customerName} / ${c.projectName} ・ ${periodJa(period)}`;
  const inTarget = f.breakdown.contractMonthsInTarget.length > 0;
  const fEnd = vm.endForecasts[vm.method];
  display(
    kpiRow([
      statTile({ label: fmt(T.contract.budgetPeriod, { period: periodJa(period) }), value: money(totals.budget, unit), sub: `${totals.contractCount ? period.from === c.startMonth && period.to === c.endMonth ? T.contract.wholePeriod : T.contract.sumInPeriod : ""}`, breakdown: () => bd.budgetAggregateSpec({ model, contractIds: [c.contractId], period, unit }) }),
      statTile({ label: T.columns.cost, value: money(totals.cost, unit), sub: fmt(T.contract.costSub, { hours: formatHours(totals.hours), pm: totals.personMonthsStandard.toFixed(2) }), breakdown: () => bd.costAggregateSpec({ model, contractIds: [c.contractId], period, unit }) }),
      statTile({
        label: T.kpi.grossProfit,
        value: money(totals.grossProfit, unit),
        sub: html`${T.kpi.marginPrefix} ${bd.numberButton(formatPercent(totals.grossMargin), () => bd.marginSpec({ totals, unit, subtitle }), { className: "yn-num-inline", ariaLabel: T.kpi.marginAria })}`,
        status: totals.grossProfit < 0 ? { kind: "danger", text: T.kpi.deficit } : null,
        breakdown: () => bd.grossProfitSpec({ budget: totals.budget, cost: totals.cost, unit, subtitle }),
      }),
      statTile({
        label: T.kpi.burnRate,
        value: formatPercent(totals.burnRate),
        sub: html`${burnMeter(totals.burnRate, model.config.burnRateDangerThreshold)}<span>${fmt(T.kpi.burnSub, { elapsed: elapsedLabel(totals.burnRateBreakdown.elapsedMonths), threshold: formatPercent(model.config.burnRateDangerThreshold, 0) })}</span>`,
        status: totals.isOverBudget ? { kind: "danger", text: T.kpi.overBudget } : totals.burnRate === null ? { kind: "neutral", text: T.kpi.noElapsed } : { kind: "ok", text: T.kpi.withinRange },
        breakdown: () => bd.burnRateSpec({ totals, unit, threshold: model.config.burnRateDangerThreshold, asOfMonth: model.meta.asOfMonth, subtitle }),
      }),
      statTile({
        label: fmt(T.kpi.forecast, { method: METHOD_LABELS[f.method] }),
        value: inTarget ? money(f.forecastGrossProfit, unit) : "—",
        sub: inTarget ? fmt(T.kpi.forecastSub, { budget: money(f.targetBudget, unit), cost: money(f.forecastCost, unit) }) : T.contract.notInTarget,
        status: !inTarget ? { kind: "neutral", text: T.contract.outOfScope } : f.isDeficit ? { kind: "danger", text: T.breakdown.deficitForecast } : { kind: "ok", text: T.breakdown.surplusForecast },
        breakdown: () => bd.forecastSpec({ forecast: f, contract: c, unit, config: model.config }),
        emphasis: true,
      }),
      // 期間が契約の全期間でなければ、契約の終了月までの着地も並べる（年度をまたぐ案件の収支を見るため）
      vm.isWhole
        ? null
        : statTile({
            label: fmt(T.kpi.forecastEnd, { method: METHOD_LABELS[fEnd.method] }),
            value: money(fEnd.forecastGrossProfit, unit),
            sub: fmt(T.kpi.forecastEndSub, { end: monthJa(c.endMonth), budget: money(fEnd.targetBudget, unit), cost: money(fEnd.forecastCost, unit) }),
            status: fEnd.isDeficit ? { kind: "danger", text: T.breakdown.deficitForecast } : { kind: "ok", text: T.breakdown.surplusForecast },
            breakdown: () => bd.forecastSpec({ forecast: fEnd, contract: c, unit, config: model.config }),
          }),
    ].filter(Boolean), { columns: vm.isWhole ? 5 : 6 }),
  );
}
```

```js
// 目標（§63）。目標が無ければ何も出さない
if (vm) {
  const sec = targetSection({ model, kind: "project", id: vm.contract.contractId, name: `${vm.contract.customerName} / ${vm.contract.projectName}`, method: vm.method, unit: vm.unit });
  if (sec) display(sec);
}
```

```js
if (vm) {
  display(sectionTitle(T.charts.monthlyTitle, fmt(T.contract.monthlyHint, { period: periodJa(vm.period), asOfMonth: monthJa(model.meta.asOfMonth), method: METHOD_LABELS[vm.method] })));
  display(chartFigure({
    title: T.charts.monthlyTitle,
    subtitle: periodJa(vm.period),
    legend: monthlyLegend(dark),
    draw: (width, height) => monthlyChart({ series: vm.series, unit: vm.unit, dark, width, height, asOfMonth: model.meta.asOfMonth }),
  }));
}
```

```js
// 今月の進捗（日別の速報。§61）。読めなければ出さない
const daily = await loadDaily(FileAttachment("./data/daily.json"));
```

```js
if (vm) {
  display(dailySection(dailyFor(model, daily, [vm.contract.contractId], vm.period), { unit: vm.unit, dark, subtitle: `${vm.contract.customerName} / ${vm.contract.projectName}`, exportName: `contract_${vm.contract.contractId}_daily_${model.meta.asOfMonth}` }));
}
```

```js
if (vm) {
  const { contract: c, months, unit } = vm;
  display(sectionTitle(T.contract.monthlyTableTitle, fmt(T.contract.monthlyTableHint, { method: METHOD_LABELS[vm.method] })));
  const fc = forecastMonthlyCost(model, [c.contractId], vm.method);
  const forecast = result.forecasts[vm.method];
  const rows = months.map((m) => {
    const isForecast = m.status === "future";
    const cost = isForecast ? (fc.get(m.month) ?? 0) : m.cost;
    const grossProfit = cost === null ? null : m.budget - cost;
    return {
      key: m.month,
      month: m.month,
      status: m.status,
      isForecast,
      budget: m.budget,
      cost,
      grossProfit,
      grossMargin: cost === null ? null : grossMarginOf(m.budget, cost),
      hours: m.hours,
      businessDays: m.businessDays,
      members: m.costLines.length,
      rateMissing: m.costLines.some((l) => l.rateMissing),
      cm: m,
    };
  });
  const fcCell = (r, text, chip = false) => (r.isForecast ? html`<span class="yn-cell-forecast" title=${fmt(T.contract.forecastTitle, { method: METHOD_LABELS[vm.method] })}>${text}${chip ? statusChip("neutral", T.contract.forecastChip) : null}</span>` : text);
  const columns = [
    { key: "month", label: T.charts.colMonth, type: "text", render: (r) => monthJa(r.month), sortValue: (r) => r.month, exportValue: (r) => r.month },
    { key: "status", label: T.columns.status, type: "status", get: (r) => ({ kind: r.status === "final" ? "ok" : r.status === "preliminary" ? "prelim" : "neutral", text: STATUS_LABELS[r.status], title: null }), sortValue: (r) => r.status },
    { key: "budget", label: T.columns.budget, type: "money", breakdown: (r) => bd.budgetMonthSpec({ contract: c, cm: r.cm, unit }) },
    { key: "cost", label: T.columns.cost, type: "money", render: (r, u) => fcCell(r, money(r.cost, u), true), breakdown: (r) => (r.isForecast ? bd.forecastSpec({ forecast, contract: c, unit, config: model.config, subtitle: fmt(T.contract.forecastMonthSubtitle, { month: monthJa(r.month), remaining: money(forecast.breakdown.remainingCost, unit), n: forecast.breakdown.remainingMonths.length }) }) : bd.costMonthSpec({ contract: c, cm: r.cm, unit, model })) },
    { key: "grossProfit", label: T.columns.grossProfit, type: "money", render: (r, u) => fcCell(r, money(r.grossProfit, u)), breakdown: (r) => bd.grossProfitSpec({ budget: r.budget, cost: r.cost, unit, subtitle: `${c.customerName} / ${c.projectName} ${monthJa(r.month)}${r.isForecast ? T.contract.forecastSuffix : ""}` }) },
    { key: "grossMargin", label: T.columns.grossMargin, type: "percent", render: (r) => fcCell(r, formatPercent(r.grossMargin)), breakdown: (r) => bd.marginSpec({ budget: r.budget, cost: r.cost, grossMargin: r.grossMargin, unit, subtitle: `${c.customerName} / ${c.projectName} ${monthJa(r.month)}${r.isForecast ? T.contract.forecastSuffix : ""}` }) },
    { key: "hours", label: T.columns.hours, type: "hours", hideNarrow: true },
    { key: "members", label: T.contract.colMembers, type: "int", hideOnPhone: true, hideNarrow: true, render: (r) => (r.rateMissing ? html`${integer(r.members)} <span class="yn-muted" title=${T.contract.membersRateMissingTitle}>${T.contract.membersRateMissing}</span>` : integer(r.members)) },
    { key: "businessDays", label: T.contract.colBusinessDays, type: "int", hideOnPhone: true, hideNarrow: true },
  ];
  // 合計行は KPI と同じコアの Totals（期間の予算合計、原価・粗利は実績月のみ）。合計行の数値に根拠ボタンは付けない
  const t = vm.totals;
  display(
    dataTable({
      columns,
      rows,
      unit,
      caption: T.contract.monthlyTableTitle,
      exportName: `contract_${c.contractId}_monthly_${vm.period.from}_${vm.period.to}`,
      sort: { key: "month", dir: "asc" },
      summary: { name: T.contract.totalActualOnly, budget: t.budget, cost: t.cost, grossProfit: t.grossProfit, grossMargin: t.grossMargin, hours: t.hours, members: null, businessDays: null, status: null },
    }),
  );
}
```

```js
if (vm) {
  const { contract: c, months, unit } = vm;
  const byMember = new Map();
  for (const m of months) {
    for (const l of m.costLines) {
      let acc = byMember.get(l.memberId);
      if (!acc) byMember.set(l.memberId, (acc = { key: l.memberId, memberId: l.memberId, memberName: l.memberName, hours: 0, amount: 0, months: 0, rateMissing: false, teams: new Set(), rates: new Set() }));
      acc.hours += l.hours;
      acc.amount += l.amount;
      acc.months += 1;
      acc.rateMissing ||= l.rateMissing;
      if (l.memberTeamId) acc.teams.add(model.teamTree[l.memberTeamId]?.name ?? l.memberTeamId);
      acc.rates.add(l.hourlyRate);
    }
  }
  const rows = [...byMember.values()].map((r) => ({ ...r, teams: [...r.teams].join("、") || "—", rateText: [...r.rates].map((x) => money(x, "yen")).join(" / "), share: vm.totals.cost ? r.amount / vm.totals.cost : null, isOtherTeam: c.teamId && [...r.teams].length && ![...r.teams].includes(model.teamTree[c.teamId]?.name) }));
  display(sectionTitle(T.team.membersTitle, fmt(T.contract.membersHint, { period: periodJa(vm.period) })));
  const columns = [
    { key: "memberName", label: T.breakdown.colMember, type: "text", render: (r) => html`${r.memberName}${r.rateMissing ? html` ${statusChip("neutral", T.breakdown.rateMissing, T.team.rateMissingTitle)}` : ""}` },
    { key: "teams", label: T.team.colTeamAtTime, type: "text", hideOnPhone: true },
    { key: "hours", label: T.columns.hours, type: "hours" },
    { key: "rateText", label: T.breakdown.colRate, type: "text", align: "num", sortValue: (r) => Math.max(...r.rates), hideOnPhone: true, exportLabel: T.contract.rateExportLabel, exportValue: (r) => (r.rates.size === 1 ? [...r.rates][0] : [...r.rates].join(" / ")) },
    { key: "amount", label: T.columns.cost, type: "moneyYen" },
    { key: "share", label: T.team.colShare, type: "percent" },
    { key: "months", label: T.team.colWorkMonths, type: "int", hideOnPhone: true },
  ];
  if (rows.length === 0) display(emptyState({ title: T.team.noWorkTitle, text: T.contract.noWorkText, icon: "○" }));
  else display(dataTable({ columns, rows, unit, caption: T.team.membersTitle, exportName: `contract_${c.contractId}_members_${vm.period.from}_${vm.period.to}`, sort: { key: "amount", dir: "desc" }, rowHref: (r) => store.href("./member", {}, { id: r.memberId }) }));
}
```

```js
// 工数の明細（SPEC §30）。この表だけが使うので、他の表示を待たせずに後から読む
import { decodeWorkRows, filterWorkRows, monthRange } from "./core/index.js";
import { workTaskSection } from "./components/work.js";
const workRows = FileAttachment("./data/work-hours.json").json().then((d) => decodeWorkRows(d)).catch(() => null);
```

```js
if (vm && workRows) {
  const c = vm.contract;
  display(
    workTaskSection({
      rows: filterWorkRows(workRows, { period: vm.period, contractIds: [c.contractId] }),
      months: monthRange(vm.period.from, vm.period.to).filter((m) => m <= model.meta.asOfMonth),
      unit: vm.unit,
      config: model.config,
      hint: fmt(T.work.sectionHintContract, { period: periodJa(vm.period) }),
      exportName: `contract_${c.contractId}_tasks_${vm.period.from}_${vm.period.to}`,
    }),
  );
}
```

```js
if (vm) {
  const { contract: c, unit } = vm;
  // 方式の説明はカードに出さず、見出しの「?」にまとめる
  display(
    sectionTitle(
      T.contract.forecastCompareTitle,
      html`${fmt(T.contract.forecastCompareHint, { period: periodJa(vm.period), method: METHOD_LABELS[vm.method] })}${FORECAST_METHODS.map((m) => html`<span class="yn-me-help"><strong>${METHOD_LABELS[m]}</strong> ${methodDescription(m, model.config.forecastRecentMonths)}</span>`)}`,
    ),
  );
  const cards = FORECAST_METHODS.map((m) => {
    const f = result.forecasts[m];
    const b = f.breakdown;
    const inTarget = b.contractMonthsInTarget.length > 0;
    const fEnd = vm.endForecasts[m];
    const selected = m === vm.method;
    const warn = m === "assignment" ? (b.noAssignments ? T.contract.noAssignments : null) : b.noActuals ? T.contract.noActuals : null;
    const btn = html`<button type="button" class="yn-btn yn-btn-sm" aria-pressed=${selected ? "true" : "false"}>${selected ? T.contract.selected : T.contract.useMethod}</button>`;
    btn.addEventListener("click", () => store.set({ method: m }));
    return html`<article class=${`yn-card yn-forecast-card${selected ? " is-selected" : ""}${f.isDeficit && inTarget ? " is-danger" : ""}`} aria-current=${selected ? "true" : null}>
      <h3 class="yn-forecast-title">${METHOD_LABELS[m]}</h3>
      <div class="yn-forecast-value">${inTarget ? bd.numberButton(money(f.forecastGrossProfit, unit), () => bd.forecastSpec({ forecast: f, contract: c, unit, config: model.config }), { className: "yn-kpi-value", ariaLabel: fmt(T.contract.forecastAria, { method: METHOD_LABELS[m] }) }) : html`<span class="yn-kpi-value">—</span>`}
        ${inTarget ? statusChip(f.isDeficit ? "danger" : "ok", f.isDeficit ? T.breakdown.deficitForecast : T.breakdown.surplusForecast) : statusChip("neutral", T.contract.notInTargetChip)}</div>
      <dl class="yn-forecast-facts">
        <div><dt>${T.breakdown.targetBudget}</dt><dd class="num">${money(f.targetBudget, unit)}</dd></div>
        <div><dt>${fmt(T.contract.actualCostMonths, { n: b.actualMonths.length })}</dt><dd class="num">${money(b.actualCost, unit)}</dd></div>
        <div><dt>${fmt(T.contract.remainingCostMonths, { n: b.remainingMonths.length })}</dt><dd class="num">${money(b.remainingCost, unit)}</dd></div>
        <div><dt>${T.breakdown.forecastCost}</dt><dd class="num">${money(f.forecastCost, unit)}</dd></div>
        ${vm.isWhole
          ? null
          : html`<div class="yn-forecast-end"><dt>${fmt(T.contract.endForecastFact, { end: monthJa(c.endMonth) })}</dt><dd class="num">${bd.numberButton(money(fEnd.forecastGrossProfit, unit), () => bd.forecastSpec({ forecast: fEnd, contract: c, unit, config: model.config }), { className: fEnd.isDeficit ? "yn-num-inline yn-danger-text" : "yn-num-inline", ariaLabel: fmt(T.contract.endForecastAria, { method: METHOD_LABELS[m] }) })}</dd></div>`}
      </dl>
      ${warn ? html`<p class="yn-note yn-note-warn">${warn}</p>` : null}
      ${btn}
    </article>`;
  });
  display(html`<div class="yn-forecast-grid">${cards}</div>`);
}
```

```js
const worklogSection = (() => {
  if (!vm) return null;
  const { contract: c, months, unit } = vm;
  const holder = html`<div class="yn-worklog-holder"></div>`;
  const loadBtn = html`<button type="button" class="yn-btn">${T.breakdown.loadWorklogs}</button>`;
  const status = html`<p class="yn-note" aria-live="polite" hidden></p>`;
  async function load() {
    loadBtn.disabled = true;
    loadBtn.textContent = T.common.loading;
    try {
      const data = await bd.fetchWorklogs(c.contractId);
      const monthSet = new Set(months.map((m) => m.month));
      const entries = data.months.filter((m) => monthSet.has(m.month)).flatMap((m) => m.worklogs.map((w) => ({ ...w, month: m.month, status: m.status })));
      status.hidden = false;
      status.textContent = fmt(T.contract.worklogStatus, { n: integer(entries.length), period: periodJa(vm.period), fetchedAt: data.worklogFetchedAt ?? "—" });
      loadBtn.remove();
      holder.replaceChildren(worklogExplorer(entries, unit, c.contractId));
    } catch (error) {
      status.hidden = false;
      status.textContent = fmt(T.contract.worklogFailed, { error: error?.message ?? error });
      status.setAttribute("role", "alert");
      loadBtn.disabled = false;
      loadBtn.textContent = T.contract.retry;
    }
  }
  loadBtn.addEventListener("click", load);
  return html`<section>${sectionTitle(T.contract.worklogTitle, `${T.contract.worklogHint}${T.contract.worklogLazyNote}`)}${status}${loadBtn}${holder}</section>`;
})();

function worklogExplorer(entries, unit, id) {
  const months = [...new Set(entries.map((e) => e.month))].sort();
  const members = [...new Map(entries.map((e) => [e.memberId, e.memberName])).entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const tasks = [...new Set(entries.map((e) => e.task))].sort((a, b) => a.localeCompare(b, "ja"));
  const selMonth = html`<select class="yn-select" id="yn-wl-month" aria-label=${T.charts.colMonth}><option value="">${T.contract.allMonths}</option>${months.map((m) => html`<option value=${m}>${monthJa(m)}</option>`)}</select>`;
  const selMember = html`<select class="yn-select" id="yn-wl-member" aria-label=${T.breakdown.colMember}><option value="">${T.contract.allMembers}</option>${members.map(([mid, name]) => html`<option value=${mid}>${name}</option>`)}</select>`;
  const selTask = html`<select class="yn-select" id="yn-wl-task" aria-label=${T.breakdown.colTask}><option value="">${T.contract.allTasks}</option>${tasks.map((t) => html`<option value=${t}>${t}</option>`)}</select>`;
  const tableHolder = html`<div></div>`;
  const columns = [
    { key: "date", label: T.breakdown.colDate, type: "text" },
    { key: "memberName", label: T.breakdown.colMember, type: "text", render: (r) => r.memberName },
    { key: "task", label: T.breakdown.colTask, type: "text" },
    { key: "hours", label: T.columns.hours, type: "hours" },
    { key: "hourlyRate", label: T.breakdown.colRate, type: "moneyYen" },
    { key: "amount", label: T.breakdown.colAmount, type: "moneyYen" },
    { key: "status", label: T.columns.status, type: "text", render: (r) => STATUS_LABELS[r.status], hideOnPhone: true },
  ];
  const render = () => {
    const rows = entries
      .filter((e) => (!selMonth.value || e.month === selMonth.value) && (!selMember.value || e.memberId === selMember.value) && (!selTask.value || e.task === selTask.value))
      .map((e, i) => ({ ...e, key: i }));
    const sum = rows.reduce((s, r) => ({ hours: s.hours + r.hours, amount: s.amount + r.amount }), { hours: 0, amount: 0 });
    tableHolder.replaceChildren(
      dataTable({ columns, rows, unit, caption: T.contract.worklogCaption, exportName: `contract_${id}_worklogs`, sort: { key: "date", dir: "asc" }, maxHeight: 480, summary: { name: fmt(T.contracts.totalRow, { n: integer(rows.length) }), hours: sum.hours, amount: sum.amount, date: null, memberName: null, task: null, hourlyRate: null, status: null } }),
    );
  };
  for (const s of [selMonth, selMember, selTask]) s.addEventListener("change", render);
  render();
  return html`<div class="yn-worklog">
    <div class="yn-filters is-compact" role="group" aria-label=${T.contract.worklogFilterLabel}>
      <div class="yn-filter"><label for="yn-wl-month">${T.charts.colMonth}</label>${selMonth}</div>
      <div class="yn-filter"><label for="yn-wl-member">${T.breakdown.colMember}</label>${selMember}</div>
      <div class="yn-filter"><label for="yn-wl-task">${T.breakdown.colTask}</label>${selTask}</div>
    </div>
    ${tableHolder}
  </div>`;
}
```

```js
if (worklogSection) display(worklogSection);
```
