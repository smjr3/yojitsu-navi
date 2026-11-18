---
title: 稼働実績
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
import {
  CHART_UNITS,
  NONE_CUSTOMER_KEY,
  UNASSIGNED_TEAM_ID,
  UNASSIGNED_WORK_KEY,
  aggregateWork,
  bucketWork,
  compareWorkPlan,
  confirmedPeriodOf,
  customerKey,
  dayUnitRange,
  decodeWorkPlans,
  decodeWorkRows,
  elapsedMonthCount,
  groupWorkPlans,
  isUnknownMember,
  memberLeftAt,
  memberTeamsAt,
  monthRange,
  ownTeamScope,
  personMonths,
  teamAncestry,
  workGuests,
  workMonthlySeries,
  workTeamOf,
  workTotals,
} from "./core/index.js";
import { createStore } from "./components/state.js";
import { scopeFor, teamName, memberIdsInTeam } from "./components/analysis.js";
import { pageHeader, sectionTitle, loadJson, note, withToday } from "./components/layout.js";
import { mountFilterBar } from "./components/filters.js";
import { statTile, kpiRow } from "./components/kpi.js";
import { dataTable, PREVIEW_ROWS } from "./components/table.js";
import { customerHref } from "./components/customers.js";
import { EMPTY_VALUE, formatHours, formatPercent, monthJa, monthShort, periodCompact, periodJa } from "./components/format.js";
import { chartFigure } from "./components/chart-zoom.js";
import { bucketLabel, bucketTick, bucketTipValue, chartMessage, lazyJson, loadUnit, saveUnit, unitSwitch } from "./components/chart-units.js";
import { openBreakdown } from "./components/breakdown.js";
import { pm, workGroupChart, workHoursChart, workHoursLegend, workSeriesTable, workTaskSection, workTaskSpec } from "./components/work.js";
```

```js
// model.json（全ページ共通）と work-hours.json（工数の明細と運用保守の計画。§149）を並行して読む
const model = await loadJson(
  {
    json: async () => {
      const [m, d] = await Promise.all([FileAttachment("./data/model.json").json().then(withToday), FileAttachment("./data/work-hours.json").json()]);
      return { ...m, workRows: decodeWorkRows(d), workPlans: decodeWorkPlans(d) };
    },
  },
  { skeleton: "page-skeleton" },
);
const store = model ? createStore(model) : null;
// グラフの日・週（§149）: メンバーの日ごとの時間。選んだときに初めて読む
const memberDays = lazyJson(FileAttachment("./data/member-days.json"));
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
// 表の切り替え（URL の axis・view・f。ストアの外＝このページだけ）
const AXES = [
  { id: "team", label: T.work.axisTeam },
  { id: "customer", label: T.work.axisCustomer },
  { id: "contract", label: T.work.axisContract },
  { id: "member", label: T.work.axisMember },
];
const VIEWS = [
  { id: "total", label: T.work.viewTotal },
  { id: "months", label: T.work.viewMonths },
];
// 区切りボタンの切り替え（まとめ方・表示）。押すと URL に書き戻して input を出す
const segControl = ({ param, items, fallback, label, id, cls }) => {
  const initial = new URLSearchParams(location.search).get(param);
  const form = html`<div class=${`yn-chip-filters ${cls}`}><span class="yn-filter-label" id=${id}>${label}</span></div>`;
  const group = html`<div class="yn-seg" role="group" aria-labelledby=${id}></div>`;
  form.value = items.some((a) => a.id === initial) ? initial : fallback;
  const btns = items.map((a) => {
    const b = html`<button type="button" class="yn-seg-btn" aria-pressed=${a.id === form.value ? "true" : "false"}>${a.label}</button>`;
    b.dataset[param] = a.id;
    b.addEventListener("click", () => {
      if (form.value === a.id) return;
      form.value = a.id;
      for (const x of btns) x.setAttribute("aria-pressed", x.dataset[param] === a.id ? "true" : "false");
      const url = new URL(location.href);
      if (a.id === fallback) url.searchParams.delete(param);
      else url.searchParams.set(param, a.id);
      history.replaceState(history.state, "", url);
      form.dispatchEvent(new CustomEvent("input", { bubbles: true }));
    });
    return b;
  });
  group.append(...btns);
  form.append(group);
  return form;
};
const axisControl = segControl({ param: "axis", items: AXES, fallback: "team", label: T.work.axisLabel, id: "yn-axis-label", cls: "yn-work-axis" });
const viewControl = segControl({ param: "view", items: VIEWS, fallback: "total", label: T.work.viewLabel, id: "yn-view-label", cls: "yn-work-view" });
// 不在の人も表示（メンバー別 §138 と同じ。URL の f=left。まとめ方がメンバーのときだけ出す）
const leftControl = (() => {
  const on = (new URLSearchParams(location.search).get("f") ?? "").split(",").includes("left");
  const input = html`<input type="checkbox" id="yn-w-left" checked=${on}>`;
  const label = html`<label class="yn-toggle-chip" for="yn-w-left" title=${T.members.chipShowLeftTitle}>${input}<span>${T.members.chipShowLeft}</span></label>`;
  label.value = on;
  input.addEventListener("change", () => {
    const url = new URL(location.href);
    if (input.checked) url.searchParams.set("f", "left");
    else url.searchParams.delete("f");
    history.replaceState(history.state, "", url);
    label.value = input.checked;
    label.dispatchEvent(new CustomEvent("input", { bubbles: true }));
  });
  input.addEventListener("input", (ev) => ev.stopPropagation());
  return label;
})();
```

```js
const vm = (() => {
  if (!model || !state) return null;
  const scope = scopeFor(model, state);
  const { period } = scope;
  const asOfMonth = model.meta.asOfMonth;
  const baseMonth = period.to < asOfMonth ? period.to : asOfMonth;
  const inPeriod = model.workRows.filter((r) => r.month >= period.from && r.month <= period.to);
  const plansIn = model.workPlans.filter((p) => p.month >= period.from && p.month <= period.to);
  // メンバーの所属（基準月。作業実績の無い・計画だけの人もマスタから）
  const teams = memberTeamsAt(model, inPeriod, baseMonth);
  const teamOf = (id) => (teams.has(id) ? teams.get(id) : workTeamOf(model, id, baseMonth));
  const ids = new Set([...inPeriod.map((r) => r.memberId), ...plansIn.map((p) => p.memberId)]);
  const people = [...ids].map((memberId) => ({ memberId, teamId: teamOf(memberId) }));
  // チームで絞る: メンバーの所属（上位は配下を含む）。チームの案件に入った他チームの人（応援）・所属の無い人（ヘルプ）は
  // チームの案件の運用保守の分だけ足す（メンバー別 §134 と同じ。§149）
  const own = memberIdsInTeam(people, state.team, scope.tree);
  const ownSet = own ? new Set(own) : null;
  const contractSet = new Set(scope.contractIds ?? []);
  const guests =
    ownSet && state.team !== UNASSIGNED_TEAM_ID && !scope.teamMissing && contractSet.size
      ? workGuests(model, inPeriod, plansIn, { ownIds: ownSet, contractIds: contractSet, ownScope: ownTeamScope(scope.tree, state.team), baseMonth })
      : new Map();
  const inGuest = (memberId, contractId, category = "contract") => guests.has(memberId) && category !== "outside" && contractId !== null && contractSet.has(contractId);
  const rows = ownSet ? inPeriod.filter((r) => ownSet.has(r.memberId) || inGuest(r.memberId, r.contractId, r.category)) : inPeriod;
  const plans = ownSet ? plansIn.filter((p) => ownSet.has(p.memberId) || inGuest(p.memberId, p.contractId)) : plansIn;
  const elapsed = elapsedMonthCount(period, asOfMonth);
  const totals = workTotals(rows, elapsed);
  // 計画と比べるのは確定した月だけ（§64 と同じ。速報の月は実績が途中）
  const judged = confirmedPeriodOf(model.meta, period);
  const planTotal = compareWorkPlan(plans, rows, judged);
  const planByMonth = new Map();
  for (const p of plans) planByMonth.set(p.month, (planByMonth.get(p.month) ?? 0) + p.hours);
  const series = workMonthlySeries(rows, period, model.meta).map((p) => ({ ...p, plannedHours: planByMonth.get(p.month) ?? 0 }));
  const nameOf = new Map();
  for (const r of rows) nameOf.set(r.memberId, r.memberName);
  return { scope, period, baseMonth, rows, plans, guests, teamOf, totals, judged, planTotal, series, nameOf, months: monthRange(period.from, period.to).filter((m) => m <= asOfMonth), unit: state.unit };
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
// 人月の差（+0.50人月／−0.20人月）
const pmSigned = (hours, cfg) => {
  const v = personMonths(hours, cfg.standardHoursPerMonth);
  const text = pm(Math.abs(hours), cfg);
  return Math.abs(v) < 0.005 ? pm(0, cfg) : v > 0 ? `+${text}` : `−${text}`;
};
// 計画との差の根拠（確定した月ごとの計画・運用保守の実績・差。§149）
const planSpec = (name, cmp, cfg, judged) => () => ({
  title: `${name} ・ ${T.work.colPlanDiff}`,
  subtitle: judged ? periodJa(judged) : T.work.noJudged,
  formula: T.work.planDiffFormula,
  rows: [
    { label: T.work.colPlan, value: `${pm(cmp.plannedHours, cfg)}（${formatHours(cmp.plannedHours)}）` },
    { label: T.work.contract, value: `${pm(cmp.actualHours, cfg)}（${formatHours(cmp.actualHours)}）` },
    { label: T.work.colPlanDiff, value: `${pmSigned(cmp.diffHours, cfg)}（${cmp.diffHours >= 0 ? "+" : "−"}${formatHours(Math.abs(cmp.diffHours))}）`, emphasis: true },
  ],
  sections: [
    {
      table: {
        columns: [{ label: T.charts.colMonth }, { label: T.work.colPlan, align: "num" }, { label: T.work.contract, align: "num" }, { label: T.work.colPlanDiff, align: "num" }],
        rows: [...cmp.byMonth.values()]
          .filter((m) => m.judged)
          .sort((a, b) => (a.month < b.month ? -1 : 1))
          .map((m) => [monthJa(m.month), pm(m.plannedHours, cfg), pm(m.actualHours, cfg), pmSigned(m.actualHours - m.plannedHours, cfg)]),
      },
    },
  ],
});
```

```js
if (vm) {
  const { totals: t, period, planTotal: pt } = vm;
  const cfg = model.config;
  const subtitle = `${vm.scope.teamLabel} ・ ${periodJa(period)}`;
  const spec = (title) => () => workTaskSpec({ title, subtitle, rows: vm.rows, config: cfg });
  const gapStatus = pt.kind === "over" ? { kind: "warn", text: T.work.gapOver } : pt.kind === "unplanned" ? { kind: "empty", text: T.work.gapNone } : null;
  display(
    kpiRow(
      [
        statTile({ label: T.work.kpiContract, value: pm(t.contractHours, cfg), sub: formatHours(t.contractHours), breakdown: spec(T.work.kpiContract) }),
        statTile({
          label: T.work.kpiPlanDiff,
          value: vm.judged ? pmSigned(pt.diffHours, cfg) : EMPTY_VALUE,
          sub: vm.judged ? fmt(T.work.kpiPlanDiffSub, { plan: pm(pt.plannedHours, cfg) }) : T.work.noJudged,
          status: gapStatus,
          breakdown: vm.judged ? planSpec(vm.scope.teamLabel, pt, cfg, vm.judged) : null,
        }),
        statTile({ label: T.work.kpiOutside, value: pm(t.outsideHours, cfg), sub: fmt(T.work.kpiOutsideSub, { share: formatPercent(t.outsideShare) }), breakdown: spec(T.work.kpiOutside) }),
        statTile({ label: T.work.kpiPeople, value: fmt(T.work.peopleValue, { n: t.memberCount }), sub: vm.guests.size ? fmt(T.work.kpiPeopleGuests, { months: t.elapsedMonths, n: vm.guests.size }) : fmt(T.work.kpiPeopleSub, { months: t.elapsedMonths }) }),
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
      { columns: 5 },
    ),
  );
  if (t.totalHours === 0) display(note(fmt(T.work.noData, { period: periodJa(period) })));
}
```

```js
// 月次推移の単位（日・週・月・四半期・年度。§130 のグラフと同じ切り替え。§149）
const chartUnit = (() => {
  const host = html`<div class="yn-unit-figure"></div>`;
  host.value = loadUnit("workload", CHART_UNITS);
  return host;
})();
```

```js
if (vm) {
  const cfg = model.config;
  const startMonth = cfg.fiscalYearStartMonth;
  const asOf = model.meta.asOf;
  const asOfMonth = model.meta.asOfMonth;
  const title = T.work.monthlyTitle;
  // 棒を押すと、その期間に誰がどれだけ作業したか（計算根拠。§135 と同じく押して開く）
  const pickSpec = (d, label) => {
    const byMember = new Map();
    if (d.members) for (const [id, v] of d.members) byMember.set(id, [v[0], v[1]]);
    else {
      const months = new Set(d.months ?? [d.month]);
      for (const r of vm.rows) {
        if (!months.has(r.month)) continue;
        const v = byMember.get(r.memberId) ?? [0, 0];
        v[r.category === "outside" ? 1 : 0] += r.hours;
        byMember.set(r.memberId, v);
      }
    }
    const list = [...byMember.entries()].filter(([, v]) => v[0] + v[1] >= 0.005).sort((a, b) => b[1][0] + b[1][1] - (a[1][0] + a[1][1]));
    return {
      title: fmt(T.work.bucketTitle, { label }),
      subtitle: vm.scope.teamLabel,
      rows: [
        ...(d.plannedHours > 0 ? [{ label: T.work.legendPlan, value: `${pm(d.plannedHours, cfg)}（${formatHours(d.plannedHours)}）` }] : []),
        { label: T.work.contract, value: `${pm(d.contractHours, cfg)}（${formatHours(d.contractHours)}）` },
        { label: T.work.outside, value: `${pm(d.outsideHours, cfg)}（${formatHours(d.outsideHours)}）` },
      ],
      sections: list.length
        ? [
            {
              title: fmt(T.work.bucketMembers, { n: list.length }),
              table: {
                columns: [{ label: T.work.axisMember }, { label: T.work.contract, align: "num" }, { label: T.work.outside, align: "num" }],
                rows: list.map(([id, v]) => [vm.nameOf.get(id) ?? id, formatHours(v[0]), formatHours(v[1])]),
              },
            },
          ]
        : [],
    };
  };
  const figure = (u, controls, data, sub) => {
    const isMonth = u === "month";
    const label = (d) => (isMonth ? monthJa(d.month) : bucketLabel(d, startMonth));
    const isNow = isMonth ? null : (d) => d.months.includes(asOfMonth) && (u === "day" ? d.from <= asOf && d.to >= asOf : true);
    const isFuture = isMonth ? null : (d) => (u === "day" || u === "week" ? d.from > asOf : d.months[0] > asOfMonth);
    const prelim = data.some((d) => (isNow ? isNow(d) : d.month === asOfMonth) && d.contractHours + d.outsideHours > 0);
    return chartFigure({
      title,
      subtitle: sub,
      legend: workHoursLegend(dark, { plan: data.some((d) => d.plannedHours > 0), prelim }),
      controls,
      draw: (width, height) =>
        workHoursChart({
          series: data,
          config: cfg,
          dark,
          width,
          height,
          asOfMonth,
          isNow,
          isFuture,
          unitName: T.charts.unitLabels[u],
          onPick: (d, opener) => openBreakdown(() => pickSpec(d, label(d)), opener),
          ...(isMonth ? {} : { tick: (d, i) => bucketTick(d, i, startMonth), tipLabel: (d) => bucketTipValue(d, startMonth), tipName: T.charts.tipPeriod }),
        }),
      after: html`<details class="yn-details"><summary><span class="yn-disc" aria-hidden="true"></span>${T.pages.showTable}</summary>${workSeriesTable({ series: data, config: cfg, exportName: `workload_${u}_${vm.period.from}_${vm.period.to}`, label, colLabel: isMonth ? T.charts.colMonth : T.charts.tipPeriod })}</details>`,
    });
  };
  let token = 0;
  const show = (u) => {
    const my = ++token;
    const controls = unitSwitch({
      units: CHART_UNITS,
      value: u,
      onChange: (next) => {
        chartUnit.value = next;
        saveUnit("workload", next);
        show(next);
        chartUnit.querySelector(`.yn-chart-unit [data-unit="${next}"]`)?.focus();
      },
    });
    if (u === "month") return chartUnit.replaceChildren(figure(u, controls, vm.series, periodJa(vm.period)));
    if (u === "quarter" || u === "year") return chartUnit.replaceChildren(figure(u, controls, bucketWork(vm.series, u, { startMonth }), periodJa(vm.period)));
    const range = u === "day" ? dayUnitRange(vm.period, asOfMonth) : vm.period;
    chartUnit.replaceChildren(chartFigure({ title, subtitle: periodJa(range), controls, draw: () => chartMessage(T.charts.loading) }));
    memberDays().then((file) => {
      if (my !== token) return;
      if (!file) return chartUnit.replaceChildren(chartFigure({ title, subtitle: periodJa(range), controls, draw: () => chartMessage(T.charts.loadFailed) }));
      // メンバー × 月の運用保守・運用保守以外の時間（日ごとの割合で配る元）
      const monthHours = new Map();
      for (const r of vm.rows) {
        if (r.month < range.from || r.month > range.to) continue;
        let m = monthHours.get(r.memberId);
        if (!m) monthHours.set(r.memberId, (m = new Map()));
        const v = m.get(r.month) ?? [0, 0];
        v[r.category === "outside" ? 1 : 0] += r.hours;
        m.set(r.month, v);
      }
      const data = bucketWork(vm.series, u, { startMonth, range, days: file.members ?? null, monthHours, holidays: model.holidays, asOf });
      chartUnit.replaceChildren(figure(u, controls, data, periodJa(range)));
    });
  };
  display(sectionTitle(title, fmt(T.work.monthlyHint, { period: periodJa(vm.period), hours: cfg.standardHoursPerMonth })));
  show(chartUnit.value);
  display(chartUnit);
}
```

```js
if (model) display(html`<div class="yn-work-switches">${axisControl}${viewControl}</div>`);
```

```js
const axis = Generators.input(axisControl);
```

```js
// view は Framework の組み込み（view()）と重なるので別の名前にする
const tableView = Generators.input(viewControl);
```

```js
const showLeft = Generators.input(leftControl);
```

```js
if (vm) {
  const cfg = model.config;
  const { period, judged } = vm;
  const tree = vm.scope.tree;
  const contractById = new Map(model.contracts.map((c) => [c.contract.contractId, c.contract]));
  const contractLabel = (id) => {
    const c = contractById.get(id);
    return c ? `${c.customerName} / ${c.projectName}` : T.work.noContractRow;
  };
  const opts = (ax) => ({ period, axis: ax, tree, contractLabel, unassignedLabel: ax === "customer" ? T.numbers.noCustomerName : ax === "contract" ? T.work.noContractRow : T.members.noTeam });
  const groups = aggregateWork(model, vm.rows, opts(axis));
  const label = AXES.find((a) => a.id === axis)?.label ?? "";
  // 計画を まとめ方のキーごとに（§149）
  const planKey = {
    team: (p) => {
      const t = vm.teamOf(p.memberId);
      return t && Object.hasOwn(tree, t) ? teamAncestry(tree, t) : [UNASSIGNED_WORK_KEY];
    },
    customer: (p) => {
      const c = contractById.get(p.contractId);
      return c ? customerKey(c.customerName) : null;
    },
    contract: (p) => p.contractId,
    member: (p) => p.memberId,
  };
  const plansBy = groupWorkPlans(vm.plans, planKey[axis]);
  // 顧客詳細は案件のある顧客だけ（運用保守以外の作業しかない顧客には詳細画面が無い）。案件の無い顧客には印を付ける（§100）
  const contractCustomers = new Set(model.contracts.map((c) => customerKey(c.contract.customerName)));
  const noContract = (r) => r.rowKind === "customer" && r.key !== NONE_CUSTOMER_KEY && !contractCustomers.has(r.key);
  // 表の 1 行（元の行・内訳の行で共通）。kind = まとめ方（team・customer・contract・member）
  const makeRow = (g, kind, plans, sub = false) => {
    const cmp = compareWorkPlan(plans ?? [], g.rows, judged);
    const row = { ...g, name: g.label, rowKind: kind, plans: plans ?? [], cmp, plannedHours: cmp.plannedHours, diffHours: cmp.diffHours, gapKind: cmp.kind, hasSub: !sub && kind !== "team" && g.rows.length > 0 };
    if (kind === "member") {
      row.teamName = g.teamId ? teamName(model, g.teamId, tree) : T.members.noTeam;
      row.origin = vm.guests.get(g.key) ?? null;
      row.unknown = isUnknownMember(model, g.key);
      row.leftFrom = row.unknown ? null : memberLeftAt(model, g.key, vm.baseMonth);
      row.href = store.href("./member", {}, { id: g.key });
    } else if (kind === "contract") {
      const c = contractById.get(g.key);
      row.teamName = c?.teamId ? teamName(model, c.teamId, tree) : "";
      row.periodText = c ? periodCompact(c.startMonth, c.endMonth) : "";
      row.href = c ? store.href("./contract", {}, { id: g.key }) : null;
    } else if (kind === "customer") {
      row.href = contractCustomers.has(g.key) ? customerHref(store, g.key) : null;
    } else row.href = g.key === UNASSIGNED_WORK_KEY ? null : store.href("./team", {}, { id: g.key });
    return row;
  };
  // 行を開いたときの内訳（§149）: 案件 → メンバー、メンバー・顧客 → 案件
  const subRows = (r) => {
    const kind = r.rowKind === "contract" ? "member" : "contract";
    const by = groupWorkPlans(r.plans, kind === "member" ? (p) => p.memberId : (p) => p.contractId);
    return aggregateWork(model, r.rows, opts(kind)).map((g) => makeRow(g, kind, by.get(g.key), true));
  };
  const allRows = groups.map((g) => makeRow(g, axis, plansBy.get(g.key)));
  // 不在の人は「不在の人も表示」を入れたときだけ（メンバー別 §138 と同じ。KPI・グラフは含む）
  const leftN = axis === "member" && !showLeft ? allRows.filter((r) => r.leftFrom).length : 0;
  const rows = leftN ? allRows.filter((r) => !r.leftFrom) : allRows;
  const unknownN = axis === "member" ? rows.filter((r) => r.unknown).length : 0;
  // データ確認への導線（マスタに無い人。§149）
  const toCheck = unknownN ? html`<a class="yn-btn yn-btn-sm" id="yn-w-check" href="./data-check#dc-unknown">${fmt(T.work.toDataCheck, { n: unknownN })}</a>` : null;
  const hint = fmt(axis === "team" ? T.work.tableHintTeam : axis === "customer" ? T.work.tableHintCustomer : axis === "contract" ? T.work.tableHintContract : T.work.tableHintMember, { period: periodJa(period), month: monthJa(vm.baseMonth) });
  display(sectionTitle(fmt(T.work.tableTitle, { axis: label }), hint, toCheck, leftN ? fmt(T.members.hiddenLeft, { n: leftN }) : null));
  if (axis === "member") display(html`<div class="yn-chip-filters yn-work-left">${leftControl}</div>`);
  // 分布のグラフ（チームは末端の組織だけ。上位は配下の合計で二重になるため）
  const chartGroups = axis === "team" ? groups.filter((g) => !g.hasChildren) : axis === "member" && leftN ? rows : groups;
  // 画面内は上位 20 件。拡大表示では全件を出す（行が多ければダイアログ内で縦にスクロール）
  display(chartFigure({
    title: fmt(T.work.tableTitle, { axis: label }),
    subtitle: periodJa(period),
    legend: workHoursLegend(dark),
    draw: (width, height) =>
      workGroupChart({ groups: chartGroups, config: cfg, dark, width, height, maxRows: height === undefined ? 20 : chartGroups.length, ariaLabel: fmt(T.work.distAriaAxis, { axis: label }) }),
    rotateHint: false,
    after: chartGroups.length > 20 ? html`<p class="yn-note">${fmt(T.work.distTrimmed, { n: 20, total: chartGroups.length })}</p>` : null,
  }));
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
  // 応援・ヘルプ・マスタ未登録・不在の印（所属の行の先頭。メンバー別 §134 と同じ）
  const chips = (r) => [
    r.origin === "support" ? html`<span class="yn-chip yn-chip-neutral" data-origin="support" title=${T.members.supportTitle}>${T.team.support}</span> ` : null,
    r.origin === "help" ? html`<span class="yn-chip yn-chip-neutral yn-chip-help" data-origin="help" title=${r.unknown ? T.team.helpUnknownTitle : T.members.helpTitle}>${T.team.help}</span> ` : null,
    r.unknown && r.origin !== "help" ? html`<span class="yn-chip yn-chip-neutral" title=${T.members.chipUnknownTitle}>${T.members.chipUnknown}</span> ` : null,
    r.leftFrom ? html`<span class="yn-chip yn-chip-neutral">${T.members.chipLeft}</span> ` : null,
  ];
  const nameCell = (r) => {
    if (r.rowKind === "member") return html`<span class="yn-cell-2line"><span class="yn-cell-main">${r.name}</span><span class="yn-cell-sub">${chips(r)}${r.teamName}</span></span>`;
    if (r.rowKind === "contract" && r.key !== UNASSIGNED_WORK_KEY) return html`<span class="yn-cell-2line"><span class="yn-cell-main">${r.name}</span><span class="yn-cell-sub">${r.teamName}${r.periodText ? ` ・ ${r.periodText}` : ""}</span></span>`;
    if (noContract(r)) return html`<span>${r.name} <span class="yn-chip yn-chip-neutral" title=${T.work.noContractTitle}>${T.work.noContract}</span></span>`;
    return r.name;
  };
  // 計画との差（確定した月）。計画より多い＝黄、計画なし＝赤紫（リソース計画・体制図と同じ色。§131）
  const gapClass = (kind) => (kind === "over" ? "yn-gap-over" : kind === "unplanned" ? "yn-gap-none" : "");
  const planCols = judged
    ? [
        // 計画は「列」で出す（既定は差だけ。運用保守の列は速報の月を含むので、並べると引き算に見えて紛らわしい）
        { key: "plan", label: T.work.colPlan, sublabel: T.work.colJudgedSub, optional: true, exportAlways: true, type: "custom", align: "num", get: (r) => personMonths(r.plannedHours, cfg.standardHoursPerMonth), render: (r) => (r.plannedHours > 0 ? pm(r.plannedHours, cfg) : EMPTY_VALUE), breakdown: (r) => planSpec(r.name, r.cmp, cfg, judged)() },
        {
          key: "planDiff",
          label: T.work.colPlanDiff,
          sublabel: T.work.colJudgedSub,
          type: "custom",
          align: "num",
          get: (r) => personMonths(r.diffHours, cfg.standardHoursPerMonth),
          render: (r) => (r.gapKind === "unplanned" ? html`<span class="yn-chip yn-chip-empty">${T.work.gapNone}</span>` : r.plannedHours === 0 && r.cmp.actualHours === 0 ? EMPTY_VALUE : pmSigned(r.diffHours, cfg)),
          filterValue: (r) => [r.gapKind === "over" ? T.work.gapOver : r.gapKind === "unplanned" ? T.work.gapNone : r.gapKind === "under" ? T.work.gapUnder : r.gapKind === "noActual" ? T.work.gapNoActual : T.work.gapOk],
          filter: "values",
          cellClass: (r) => gapClass(r.gapKind),
          breakdown: (r) => planSpec(r.name, r.cmp, cfg, judged)(),
        },
      ]
    : [];
  // 月ごとの表示（運用保守の実績の人月。確定した月は計画と比べて色を付ける。§149）。多いときは最後の 12 か月
  const monthCols = tableView === "months"
    ? vm.months.slice(-12).map((m, i, list) => ({
        key: `m:${m}`,
        label: monthShort(m, i === 0 || m.endsWith("-01")),
        sublabel: judged && m > judged.to ? T.work.prelimSub : null,
        type: "custom",
        align: "num",
        menu: false,
        filter: false,
        get: (r) => personMonths(r.cmp.byMonth.get(m)?.actualHours ?? 0, cfg.standardHoursPerMonth),
        render: (r) => {
          const v = r.cmp.byMonth.get(m)?.actualHours ?? 0;
          return v > 0 ? personMonths(v, cfg.standardHoursPerMonth).toFixed(2) : EMPTY_VALUE;
        },
        cellClass: (r) => {
          const x = r.cmp.byMonth.get(m);
          return x?.judged ? gapClass(x.kind) : x && x.actualHours > 0 ? "yn-gap-prelim" : "";
        },
        headTitle: monthJa(m),
      }))
    : [];
  const columns = [
    { key: "name", label, type: "text", render: axis === "team" ? undefined : nameCell, filterValue: axis === "customer" ? (r) => (noContract(r) ? [r.name, T.work.noContract] : [r.name]) : undefined, exportValue: (r) => r.name },
    ...(axis === "member" ? [{ key: "teamName", label: T.members.colTeam, type: "text", exportOnly: true }] : [{ key: "people", label: T.work.colMembers, type: "int", get: (r) => r.totals.memberCount, hideOnPhone: true }]),
    ...(axis === "contract" ? [{ key: "teamName", label: T.work.colContractTeam, type: "text", exportOnly: true }] : []),
    ...(tableView === "months"
      ? [...monthCols, pmCol("contract", T.work.contract, (r) => r.totals.contractHours, { sublabel: T.work.colSumSub }), ...planCols.slice(1), pmCol("outside", T.work.outside, (r) => r.totals.outsideHours, { hideOnPhone: true })]
      : [
          ...planCols.slice(0, 1),
          pmCol("contract", T.work.contract, (r) => r.totals.contractHours),
          ...planCols.slice(1),
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
        ]),
  ];
  // 合計行（不在の人を隠したときは表に出ている人だけ）
  const sumRows = leftN ? rows.flatMap((r) => r.rows) : vm.rows;
  const sumCmp = leftN ? compareWorkPlan(rows.flatMap((r) => r.plans), sumRows, judged) : vm.planTotal;
  const summaryRow = { name: fmt(T.work.totalRow, { n: rows.length }), teamName: null, totals: workTotals(sumRows, elapsedMonthCount(period, model.meta.asOfMonth)), rows: sumRows, cmp: sumCmp, plannedHours: sumCmp.plannedHours, diffHours: sumCmp.diffHours, gapKind: sumCmp.kind };
  display(
    dataTable({
      columns,
      rows,
      unit: vm.unit,
      tree: axis === "team",
      caption: fmt(T.work.tableTitle, { axis: label }),
      exportName: `workload_${axis}${tableView === "months" ? "_months" : ""}_${period.from}_${period.to}`,
      sort: axis === "team" ? null : { key: tableView === "months" ? "contract" : "total", dir: "desc" },
      rowHref: (r) => r.href,
      emptyText: T.work.empty,
      previewRows: axis === "team" ? null : PREVIEW_ROWS,
      subRows: axis === "team" ? null : subRows,
      summary: axis === "team" || rows.length === 0 ? null : summaryRow,
      summaryBreakdown: (col, sm) =>
        ["contract", "outside", "total"].includes(col.key)
          ? () => workTaskSpec({ title: col.label, subtitle: periodJa(period), rows: sm.rows, config: cfg })
          : ["plan", "planDiff"].includes(col.key)
            ? planSpec(vm.scope.teamLabel, sm.cmp, cfg, judged)
            : null,
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
