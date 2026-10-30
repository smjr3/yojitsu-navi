---
title: メンバー別
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
import { PLAN_GAP_MIN_HOURS, PLAN_GAP_RATIO, UNASSIGNED_TEAM_ID, aggregateMembers, normalizeName, planGaps } from "./core/index.js";
import { createStore } from "./components/state.js";
import { scopeFor, teamName, memberIdsInTeam } from "./components/analysis.js";
import { pageHeader, sectionTitle, loadJson, note } from "./components/layout.js";
import { mountFilterBar } from "./components/filters.js";
import { statTile, kpiRow, statusChip } from "./components/kpi.js";
// KPI 4 枚（計画原価・実績原価・差額・稼働率）。1024px でも 4 枚が 1 行（狭いと 2×2）に並ぶようにクラスを足す
const memberKpiRow = (tiles) => {
  const row = kpiRow(tiles, { columns: 4 });
  row.classList.add("yn-kpi-4");
  return row;
};
import { dataTable, contractNameCell } from "./components/table.js";
import * as bd from "./components/breakdown.js";
import { EMPTY_VALUE, money, moneySigned, varianceNote, formatHours, formatPercent, monthJa, periodJa } from "./components/format.js";
```

```js
// model.json（全ページ共通）と member-months.json（メンバー別だけ）を並行して読む
const model = await loadJson(
  {
    json: async () => {
      const [m, d] = await Promise.all([FileAttachment("./data/model.json").json(), FileAttachment("./data/member-months.json").json()]);
      return { ...m, memberMonths: d.memberMonths };
    },
  },
  { skeleton: "page-skeleton" },
);
const store = model ? createStore(model) : null;
// メンバーごとの MemberMonth（根拠パネル用）
const monthsByMember = new Map();
for (const mm of model?.memberMonths ?? []) {
  if (!monthsByMember.has(mm.memberId)) monthsByMember.set(mm.memberId, []);
  monthsByMember.get(mm.memberId).push(mm);
}
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
// 検索欄の初期値（URL の q。ストアの外＝ページ固有）
const initialQuery = new URLSearchParams(location.search).get("q") ?? "";
```

```js
const vm = (() => {
  if (!model || !state) return null;
  const scope = scopeFor(model, state);
  const fullPeriod = scope.period;
  // 比較は経過月（期間内で基準月以前）で行う。未来月は実績が無く、期間全体の計画と比べると見かけ上よく見えるため（SPEC §18.2）
  const allFuture = fullPeriod.from > model.meta.asOfMonth;
  const period = allFuture ? fullPeriod : { from: fullPeriod.from, to: fullPeriod.to < model.meta.asOfMonth ? fullPeriod.to : model.meta.asOfMonth };
  // 契約外を含むか（§50.4。フィルタバーの切替）。計画・実績の両方に効く
  const includeOutside = state.outside === "1";
  const all = aggregateMembers(model, { period, includeOutside });
  // 所属チーム（基準月 = 期間の終了月。未来は基準月）で絞る。上位チームは配下を含む。
  // 「未設定」は所属チームが空か、基準月の組織に無いメンバー
  // 対象の人は「期間全体」で決める（経過月だけで決めると、未来月にだけアサインのある人が期間全体の計画から抜ける）
  const allFull = period.to === fullPeriod.to ? all : aggregateMembers(model, { period: fullPeriod, includeOutside });
  const memberIds = memberIdsInTeam(allFull.members, state.team, scope.tree);
  const agg = memberIds ? aggregateMembers(model, { period, memberIds, includeOutside }) : all;
  // 期間全体の計画（未来月を含む）。KPI の補足に出す
  const fullAgg = period.to === fullPeriod.to ? agg : aggregateMembers(model, { period: fullPeriod, memberIds: memberIds ?? undefined, includeOutside });
  const rows = agg.members.map((m) => ({
    ...m,
    key: m.memberId,
    teamName: m.teamId ? teamName(model, m.teamId, scope.tree) : "",
    searchText: normalizeName(`${m.memberId} ${m.memberName} ${m.title ?? ""}`),
  }));
  return { scope, period, fullPeriod, allFuture, fullAgg, agg, rows, memberIds, includeOutside, unit: state.unit, baseMonth: all.baseMonth, includesPreliminary: agg.members.some((m) => m.includesPreliminary) };
})();
```

```js
if (model) {
  display(
    pageHeader({
      model,
      title: T.app.pages.members,
      lead: T.members.lead,
      breadcrumbs: [{ label: T.app.pages.index, href: store.href("./") }, { label: T.app.pages.members }],
      includesPreliminary: vm?.includesPreliminary ?? false,
    }),
  );
}
```

```js
if (store) mountFilterBar(store, model, { show: ["period", "team", "outside", "unit"] });
```

```js
if (vm?.scope.teamMissing) {
  display(note(fmt(T.members.teamMissing, { team: vm.scope.teamLabel, month: monthJa(vm.baseMonth) }), "warn"));
}
```

```js
if (vm) {
  const { agg, unit, period, fullPeriod, fullAgg } = vm;
  const t = agg.total;
  const subtitle = `${vm.scope.teamLabel} ・ ${periodJa(period)}`;
  // 期間全体の計画は KPI の補足に出す（経過月で比べる理由は見出しの「?」）
  if (vm.allFuture) display(note(fmt(T.members.futureOnly, { period: periodJa(fullPeriod) })));
  display(
    memberKpiRow([
        statTile({ label: fmt(T.members.plannedCostPeriod, { period: periodJa(period) }), value: money(t.plannedCost, unit), sub: fmt(T.members.plannedSub, { hours: formatHours(t.plannedHours), n: t.memberCount, whole: period.to !== fullPeriod.to ? fmt(T.members.wholePeriodSuffix, { value: money(fullAgg.total.plannedCost, unit) }) : "" }), breakdown: () => bd.memberTotalsSpec({ members: agg.members, total: t, measure: "plannedCost", unit, period }) }),
        statTile({ label: T.breakdown.actualCost, value: money(t.actualCost, unit), sub: fmt(T.members.actualSub, { hours: formatHours(t.actualHours), unplanned: formatHours(t.unplannedHours) }), breakdown: () => bd.memberTotalsSpec({ members: agg.members, total: t, measure: "actualCost", unit, period }) }),
        statTile({ label: T.members.varianceTile, value: moneySigned(t.variance, unit), sub: t.plannedCost === 0 && t.actualCost === 0 ? "" : varianceNote(t.variance, unit), breakdown: () => bd.memberVarianceSpec({ plannedCost: t.plannedCost, actualCost: t.actualCost, unit, subtitle }) }),
        statTile({ label: T.members.utilizationTile, value: formatPercent(t.utilization), sub: t.utilization === null ? T.breakdown.utilZero : `${formatHours(t.actualHours)} ÷ ${formatHours(t.plannedHours)}`, breakdown: () => bd.memberUtilizationSpec({ plannedHours: t.plannedHours, actualHours: t.actualHours, utilization: t.utilization, unplannedHours: t.unplannedHours, subtitle }) }),
    ]),
  );
}
```


```js
// 検索フォームは model だけに依存し 1 回だけ描く（期間・単位を変えても作り直さない）
const searchForm = (() => {
  if (!model) return null;
  const form = html`<form class="yn-chip-filters" role="search" aria-label=${T.members.searchLabel}></form>`;
  form.addEventListener("submit", (ev) => ev.preventDefault());
  const input = html`<input type="search" class="yn-input" id="yn-m-text" placeholder=${T.members.searchPlaceholder} value=${initialQuery} aria-label=${T.members.searchAria}>`;
  let timer = null;
  input.addEventListener("input", () => {
    // 150ms デバウンス（1 文字ごとに表を作り直さない）
    clearTimeout(timer);
    timer = setTimeout(() => {
      form.value = input.value;
      // URL の q に書き戻す（詳細から「戻る」で復元するため）
      const url = new URL(location.href);
      if (input.value) url.searchParams.set("q", input.value);
      else url.searchParams.delete("q");
      history.replaceState(history.state, "", url);
      form.dispatchEvent(new CustomEvent("input", { bubbles: true }));
    }, 150);
  });
  form.append(html`<label class="yn-filter-label" for="yn-m-text">${T.members.searchHead}</label>`, input);
  form.value = initialQuery;
  return form;
})();
```

```js
if (searchForm) display(searchForm);
```

```js
const query = searchForm ? Generators.input(searchForm) : "";
```

```js
if (vm) {
  const { unit, period } = vm;
  const q = normalizeName(query ?? "");
  const rows = q ? vm.rows.filter((r) => r.searchText.includes(q) || normalizeName(r.teamName).includes(q)) : vm.rows;
  // 合計行は表示中のメンバーを母集団にコアで集計し直す（検索で絞ったときも一致させる）
  const shown = q ? aggregateMembers(model, { period, memberIds: rows.map((r) => r.memberId), includeOutside: vm.includeOutside }) : vm.agg;
  display(
    sectionTitle(
      T.members.sectionTitle,
      fmt(T.members.sectionHint, { period: periodJa(period), elapsed: period.to !== vm.fullPeriod.to ? T.members.elapsedSuffix : "", month: monthJa(vm.baseMonth) }),
    ),
  );
  const monthsOf = (r) => (monthsByMember.get(r.memberId) ?? []).filter((mm) => period.from <= mm.month && mm.month <= period.to);
  const sub = (r) => r.memberName;
  const contractHref = (id) => store.href("./contract", {}, { id });
  const chips = (r) => {
    const list = [];
    if (r.leftFrom) list.push({ kind: "neutral", text: T.members.chipLeft, title: fmt(T.members.chipLeftTitle, { month: monthJa(r.leftFrom) }) });
    if (r.memberUnknown) list.push({ kind: "neutral", text: T.members.chipUnknown, title: T.members.chipUnknownTitle });
    if (r.rateMissing) list.push({ kind: "neutral", text: T.breakdown.rateMissing, title: T.members.chipRateMissingTitle });
    if (r.unplannedHours > 0) list.push({ kind: "neutral", text: fmt(T.members.chipUnplanned, { hours: formatHours(r.unplannedHours) }), title: T.members.chipUnplannedTitle });
    // 速報はページ見出しのバッジで示す（ほぼ全員に付いてしまい行ごとのチップは情報にならない）
    return list;
  };
  const columns = [
    {
      key: "memberName",
      label: T.breakdown.colMember,
      sublabel: T.members.colMemberSub,
      type: "text",
      // 2 行目に ID・所属チーム・役職（列を分けると 1280/1024px に収まらないため。Excel には別列で出す）
      render: (r) => html`<span class="yn-cell-2line" title=${`${r.memberName}・${r.teamName || T.members.noTeam}${r.title ? `・${r.title}` : ""}`}><span class="yn-cell-main">${r.memberName}</span><span class="yn-cell-sub">${r.teamName || T.members.noTeam}${r.title ? ` ・ ${r.title}` : ""}</span></span>`,
      sortValue: (r) => r.memberName,
      exportValue: (r) => r.memberName,
    },
    { key: "memberId", label: T.members.colMemberId, type: "text", exportOnly: true },
    { key: "teamName", label: T.members.colTeam, type: "text", exportOnly: true, exportValue: (r) => r.teamName || T.members.noTeam },
    { key: "title", label: T.members.colTitle, type: "text", exportOnly: true },
    { key: "kindLabel", label: T.members.colKind, type: "text", exportOnly: true, get: (r) => (r.memberUnknown ? T.members.chipUnknown : r.kind === "partner" ? T.members.kindPartner : T.members.kindEmployee) },
    { key: "plannedHours", label: T.breakdown.plannedHours, type: "hours", hideOnPhone: true, breakdown: (r) => bd.memberPlanSpec({ model, member: r, months: monthsOf(r), includeOutside: vm.includeOutside, unit, measure: "hours", subtitle: periodJa(period), contractHref }) },
    { key: "actualHours", label: T.breakdown.actualHours, type: "hours", hideOnPhone: true, breakdown: (r) => bd.memberActualSpec({ model, member: r, months: monthsOf(r), includeOutside: vm.includeOutside, unit, measure: "hours", subtitle: periodJa(period), contractHref }) },
    { key: "utilization", label: T.breakdown.utilization, type: "percent", breakdown: (r) => bd.memberUtilizationSpec({ plannedHours: r.plannedHours, actualHours: r.actualHours, utilization: r.utilization, unplannedHours: r.unplannedHours, subtitle: sub(r) }) },
    { key: "plannedCost", label: T.breakdown.plannedCost, type: "money", breakdown: (r) => bd.memberPlanSpec({ model, member: r, months: monthsOf(r), includeOutside: vm.includeOutside, unit, subtitle: periodJa(period), contractHref }) },
    { key: "actualCost", label: T.breakdown.actualCost, type: "money", breakdown: (r) => bd.memberActualSpec({ model, member: r, months: monthsOf(r), includeOutside: vm.includeOutside, unit, subtitle: periodJa(period), contractHref }) },
    { key: "variance", label: T.breakdown.variance, sublabel: T.members.varianceSub, type: "money", exportLabel: T.members.varianceExport, render: (r, u) => moneySigned(r.variance, u), breakdown: (r) => bd.memberVarianceSpec({ plannedCost: r.plannedCost, actualCost: r.actualCost, unit, subtitle: sub(r) }) },
    { key: "status", label: T.columns.status, type: "status", get: chips, hideNarrow: true, sortable: false },
  ];
  // 合計行は表示中のメンバーで集計し直す（列の絞り込み後の行が来る）
  const totalsFor = (shownRows) => (shownRows.length === rows.length ? shown : aggregateMembers(model, { period, memberIds: shownRows.map((r) => r.memberId), includeOutside: vm.includeOutside }));
  display(
    dataTable({
      columns,
      rows,
      unit,
      caption: T.members.caption,
      exportName: `members_${period.from}_${period.to}`,
      sort: { key: "variance", dir: "asc" },
      rowHref: (r) => store.href("./member", {}, { id: r.memberId }),
      emptyText: q ? T.members.emptySearch : T.members.emptyTitle,
      summary: (shownRows) => {
        const agg = totalsFor(shownRows);
        const st = agg.total;
        return { memberName: null, name: fmt(T.members.totalRow, { n: shownRows.length }), plannedHours: st.plannedHours, actualHours: st.actualHours, utilization: st.utilization, plannedCost: st.plannedCost, actualCost: st.actualCost, variance: st.variance, teamName: null, title: null, status: null, agg };
      },
      summaryBreakdown: (col, { agg }) => (["plannedHours", "actualHours", "utilization", "plannedCost", "actualCost", "variance"].includes(col.key) ? () => bd.memberTotalsSpec({ members: agg.members, total: agg.total, measure: col.key, unit, period }) : null),
    }),
  );
  if (vm.rows.length === 0) display(note(T.members.emptyText));
}
```

```js
// 計画とのずれ（§64）: メンバーごとの計画と実績の表の下に置く（§68）。確定した月だけで、メンバー × 案件の計画時間と実績時間を比べる。検索欄には連動しない
if (vm) {
  const gaps = planGaps(model, { period: vm.fullPeriod, memberIds: vm.memberIds ?? undefined, includeOutside: vm.includeOutside });
  const jp = gaps.judgedPeriod;
  const status = !jp ? T.members.gapNoConfirmed : gaps.rows.length ? fmt(T.members.gapStatus, { period: periodJa(jp), n: gaps.rows.length }) : fmt(T.members.gapNone, { period: periodJa(jp) });
  const toPlan = html`<a class="yn-btn yn-btn-sm" id="yn-gap-plan-link" href=${state.team ? `./plan?team=${encodeURIComponent(state.team)}` : "./plan"}>${T.members.gapToPlan}</a>`;
  display(html`<div id="yn-plan-gaps">${sectionTitle(T.members.gapTitle, fmt(T.members.gapHint, { ratio: formatPercent(PLAN_GAP_RATIO), hours: formatHours(PLAN_GAP_MIN_HOURS) }), gaps.rows.length ? toPlan : null, status)}</div>`);
  if (gaps.rows.length) {
    const byId = new Map(model.contracts.map((r) => [r.contract.contractId, r.contract]));
    const kindText = { unplanned: T.members.gapUnplanned, noActual: T.members.gapNoActual, over: T.members.gapOver, under: T.members.gapUnder };
    const rows = gaps.rows.map((g) => {
      const k = byId.get(g.contractId);
      const outside = typeof g.outsideType === "string";
      return {
        ...g,
        key: `${g.memberId}\u0000${g.contractId}`,
        outside,
        outsideLabel: outside ? bd.outsideRowLabel(g.outsideType) : "",
        memberTeamName: g.teamId ? teamName(model, g.teamId, vm.scope.tree) : T.members.noTeam,
        customerName: k?.customerName ?? "",
        projectName: k?.projectName ?? "",
        teamName: k?.teamId ? teamName(model, k.teamId, vm.scope.tree) : T.numbers.unassignedTeam,
        startMonth: k?.startMonth ?? "",
        endMonth: k?.endMonth ?? "",
        kindLabel: kindText[g.kind],
      };
    });
    const signedHours = (h) => (h > 0 ? `+${formatHours(h)}` : h < 0 ? `−${formatHours(-h)}` : formatHours(0));
    const columns = [
      {
        key: "memberName",
        label: T.breakdown.colMember,
        type: "text",
        render: (r) => html`<span class="yn-cell-2line" title=${`${r.memberName}・${r.memberTeamName}`}><span class="yn-cell-main">${r.memberName}</span><span class="yn-cell-sub">${r.memberTeamName}</span></span>`,
      },
      { key: "memberId", label: T.members.colMemberId, type: "text", exportOnly: true },
      { key: "contractId", label: T.columns.contract, type: "text", render: (r) => (r.outside ? html`<span class="yn-cell-main">${r.outsideLabel}</span>` : contractNameCell(r)), sortValue: (r) => (r.outside ? r.outsideLabel : `${r.customerName} / ${r.projectName}`), exportValue: (r) => (r.outside ? r.outsideLabel : `${r.customerName} / ${r.projectName}`) },
      { key: "kind", label: T.members.gapColKind, type: "status", get: (r) => [{ kind: "neutral", text: r.kindLabel }], sortValue: (r) => r.kindLabel, exportValue: (r) => r.kindLabel },
      { key: "plannedHours", label: T.breakdown.plannedHours, type: "hours", hideOnPhone: true },
      { key: "actualHours", label: T.breakdown.actualHours, type: "hours", hideOnPhone: true },
      { key: "diffHours", label: T.members.gapColDiff, sublabel: T.members.gapColDiffSub, type: "hours", render: (r) => signedHours(r.diffHours), sortValue: (r) => Math.abs(r.diffHours) },
    ];
    display(
      dataTable({
        columns,
        rows,
        unit: vm.unit,
        caption: T.members.gapCaption,
        exportName: `plan_gaps_${jp.from}_${jp.to}`,
        sort: { key: "diffHours", dir: "desc" },
        rowHref: (r) => store.href("./member", {}, { id: r.memberId }),
        maxHeight: 420,
      }),
    );
  }
}
```
