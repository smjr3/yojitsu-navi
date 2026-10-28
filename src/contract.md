---
title: 契約詳細
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
import { aggregate, FORECAST_METHODS } from "./core/index.js";
import { customerKey } from "./core/index.js";
import { customerHref } from "./components/customers.js";
import { createStore } from "./components/state.js";
import { seriesWithForecast, forecastMonthlyCost, contractTeamName, treeAt, treeMonthFor, grossMarginOf } from "./components/analysis.js";
import { pageHeader, sectionTitle, emptyState, loadJson, note } from "./components/layout.js";
import { mountFilterBar } from "./components/filters.js";
import { statTile, kpiRow, statusChip } from "./components/kpi.js";
import { monthlyChart, monthlyLegend, seriesTable, burnMeter } from "./components/charts.js";
import { dataTable } from "./components/table.js";
import * as bd from "./components/breakdown.js";
import { EMPTY_VALUE, money, formatPercent, formatHours, monthJa, monthSpanJa, periodJa, METHOD_LABELS, methodDescription, STATUS_LABELS, fiscalYearLabel, profitLabel, integer } from "./components/format.js";
```

```js
const model = await loadJson(FileAttachment("./data/model.json"), { skeleton: "page-skeleton" });
const contractId = new URLSearchParams(location.search).get("id") ?? "";
const result = model ? model.contracts.find((r) => r.contract.contractId === contractId) ?? null : null;
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
  const totals = aggregate(model, scope);
  const series = seriesWithForecast(model, scope, state.method);
  const months = result.months.filter((m) => period.from <= m.month && m.month <= period.to);
  const { tree } = treeAt(model, treeMonthFor(model, period));
  return { contract: c, result, period, inRange, totals, series, months, unit: state.unit, method: state.method, teamLabel: contractTeamName(model, c, tree) };
})();
```

```js
if (model && !result) {
  display(
    pageHeader({
      model,
      title: "契約詳細",
      breadcrumbs: [{ label: "全体サマリー", href: store.href("./") }, { label: "契約一覧", href: store.href("./contracts") }, { label: contractId || "（契約ID未指定）" }],
    }),
  );
  display(
    emptyState({
      title: contractId ? `契約 ${contractId} は見つかりません` : "契約IDが指定されていません",
      text: contractId ? "契約IDが変わったか、データから除外された可能性があります（期間逆転・金額不正の契約は計算から除かれます）。" : "契約一覧から契約を選んでください。",
      actions: [{ label: "契約一覧へ戻る", href: store.href("./contracts") }],
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
      title: html`<span class="yn-title-id">${c.contractId}</span> ${c.customerName} / ${c.projectName}`,
      breadcrumbs: [{ label: "全体サマリー", href: store.href("./") }, { label: "契約一覧", href: store.href("./contracts") }, { label: c.contractId }],
      includesPreliminary: vm.totals.includesPreliminary,
      extra: html`<a class="yn-btn yn-btn-sm" href=${store.href("./contracts", { team: c.teamId ?? "" })}>同じチームの契約一覧</a>`,
    }),
  );
  display(html`<dl class="yn-facts" aria-label="契約の基本情報">
    <div><dt>${model.config.labels?.customer ?? "顧客"}</dt><dd><a href=${customerHref(store, customerKey(c.customerName))}>${c.customerName}</a></dd></div>
    <div><dt>${model.config.labels?.project ?? "案件"}</dt><dd>${c.projectName}</dd></div>
    <div><dt>主担当${model.config.labels?.team ?? "チーム"}</dt><dd>${c.teamId ? html`<a href=${store.href("./contracts", { team: c.teamId })}>${vm.teamLabel}</a>` : html`<span class="yn-chip yn-chip-neutral">未設定</span>`}</dd></div>
    <div><dt>契約期間</dt><dd>${monthJa(c.startMonth)}〜${monthJa(c.endMonth)}（${result.months.length}か月）</dd></div>
    <div><dt>契約総額</dt><dd class="num">${money(c.totalAmount, vm.unit)}</dd></div>
    ${c.note ? html`<div><dt>備考</dt><dd>${c.note}</dd></div>` : null}
  </dl>`);
}
```

```js
if (store && result) mountFilterBar(store, model, { show: ["period", "method", "unit"] });
```

```js
if (vm && !vm.inRange) {
  display(note(`選択した期間（${monthJa(state.from)}〜${monthJa(state.to)}）はこの契約の期間と重なりません。契約の全期間を表示しています。`, "warn"));
}
```

```js
if (vm) {
  const { contract: c, totals, unit, period } = vm;
  const f = result.forecasts[vm.method];
  const elapsedLabel = (months) =>
    months.length === 0 ? T.kpi.noElapsed : fmt(T.kpi.elapsed, { span: monthSpanJa(months), n: months.length, prelim: months[months.length - 1] > model.meta.lastFinalMonth ? T.kpi.elapsedPrelim : "" });
  const subtitle = `${c.contractId} ${c.customerName} / ${c.projectName} ・ ${periodJa(period)}`;
  const inFY = f.breakdown.contractMonthsInFY.length > 0;
  display(
    kpiRow([
      statTile({ label: `予算（${periodJa(period)}）`, value: money(totals.budget, unit), sub: `${totals.contractCount ? period.from === c.startMonth && period.to === c.endMonth ? "契約の全期間" : "期間内の月の合計" : ""}`, breakdown: () => bd.budgetAggregateSpec({ model, contractIds: [c.contractId], period, unit }) }),
      statTile({ label: "原価", value: money(totals.cost, unit), sub: `${formatHours(totals.hours)} ・ ${totals.personMonthsStandard.toFixed(2)}人月（標準）`, breakdown: () => bd.costAggregateSpec({ model, contractIds: [c.contractId], period, unit }) }),
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
        label: `着地見込み粗利（${fiscalYearLabel(f.fiscalYear)}・${METHOD_LABELS[f.method]}）`,
        value: inFY ? money(f.forecastGrossProfit, unit) : "—",
        sub: inFY ? `年度予算 ${money(f.fyBudget, unit)} − 着地原価 ${money(f.forecastCost, unit)}` : `${fiscalYearLabel(f.fiscalYear)} に掛からない契約`,
        status: !inFY ? { kind: "neutral", text: "対象外" } : f.isDeficit ? { kind: "danger", text: "赤字見込み" } : { kind: "ok", text: "黒字見込み" },
        breakdown: () => bd.forecastSpec({ forecast: f, contract: c, unit, config: model.config }),
        emphasis: true,
      }),
    ]),
  );
}
```

```js
if (vm) {
  display(sectionTitle("月次推移", `${periodJa(vm.period)}。${monthJa(model.meta.asOfMonth)} 以降は着地見込み（${METHOD_LABELS[vm.method]}）です。`));
  display(html`<figure class="yn-card yn-chart-card">
    ${monthlyLegend(dark)}
    ${resize((width) => monthlyChart({ series: vm.series, unit: vm.unit, dark, width, asOfMonth: model.meta.asOfMonth }))}
  </figure>`);
}
```

```js
if (vm) {
  const { contract: c, months, unit } = vm;
  display(sectionTitle("月ごとの予実", `各月の予算・原価・粗利。予定（未来）の月は選択中の方式（${METHOD_LABELS[vm.method]}）による見込み原価（残り原価を残り月で均等割り）を「見込」として表示します。${fiscalYearLabel(model.meta.fiscalYear)} より後の月は見込み対象外（年度外）です。数値をクリックすると、その月の計算根拠（予算の月割り・メンバー別の原価行・作業ログ・見込みの算出）が開きます。`));
  const fc = forecastMonthlyCost(model, [c.contractId], vm.method);
  const forecast = result.forecasts[vm.method];
  const rows = months.map((m) => {
    const isForecast = m.status === "future";
    const outsideFY = isForecast && !fc.has(m.month);
    const cost = isForecast ? (outsideFY ? null : fc.get(m.month)) : m.cost;
    const grossProfit = cost === null ? null : m.budget - cost;
    return {
      key: m.month,
      month: m.month,
      status: m.status,
      isForecast,
      outsideFY,
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
  // 年度外の月は EMPTY_VALUE（文字列）を返す → 表は根拠ボタンを付けない
  const fcCell = (r, text, chip = false) => (r.outsideFY ? EMPTY_VALUE : r.isForecast ? html`<span class="yn-cell-forecast" title=${`見込み（${METHOD_LABELS[vm.method]}）`}>${text}${chip ? statusChip("neutral", "見込") : null}</span>` : text);
  const columns = [
    { key: "month", label: "月", type: "text", render: (r) => monthJa(r.month), sortValue: (r) => r.month, exportValue: (r) => r.month },
    { key: "status", label: "状態", type: "status", get: (r) => ({ kind: r.status === "final" ? "ok" : r.status === "preliminary" ? "prelim" : "neutral", text: r.outsideFY ? "年度外" : STATUS_LABELS[r.status], title: r.outsideFY ? `${fiscalYearLabel(model.meta.fiscalYear)} の外のため着地見込みの対象外` : null }), sortValue: (r) => r.status },
    { key: "budget", label: "予算", type: "money", breakdown: (r) => bd.budgetMonthSpec({ contract: c, cm: r.cm, unit }) },
    { key: "cost", label: "原価", type: "money", render: (r, u) => fcCell(r, money(r.cost, u), true), breakdown: (r) => (r.outsideFY ? null : r.isForecast ? bd.forecastSpec({ forecast, contract: c, unit, config: model.config, subtitle: `${monthJa(r.month)} の見込み原価（残り原価 ${money(forecast.breakdown.remainingCost, unit)} を残り ${forecast.breakdown.remainingMonths.length} か月で均等割り。端数は最終月）` }) : bd.costMonthSpec({ contract: c, cm: r.cm, unit, model })) },
    { key: "grossProfit", label: "粗利", type: "money", render: (r, u) => fcCell(r, money(r.grossProfit, u)), breakdown: (r) => (r.outsideFY ? null : bd.grossProfitSpec({ budget: r.budget, cost: r.cost, unit, subtitle: `${c.contractId} ${monthJa(r.month)}${r.isForecast ? "（見込み）" : ""}` })) },
    { key: "grossMargin", label: "粗利率", type: "percent", render: (r) => fcCell(r, formatPercent(r.grossMargin)), breakdown: (r) => (r.outsideFY ? null : bd.marginSpec({ budget: r.budget, cost: r.cost, grossMargin: r.grossMargin, unit, subtitle: `${c.contractId} ${monthJa(r.month)}${r.isForecast ? "（見込み）" : ""}` })) },
    { key: "hours", label: "時間", type: "hours", hideNarrow: true },
    { key: "members", label: "作業者数", type: "int", hideOnPhone: true, hideNarrow: true, render: (r) => (r.rateMissing ? html`${integer(r.members)} <span class="yn-muted" title="単価の無いメンバーを含みます">（単価なし含む）</span>` : integer(r.members)) },
    { key: "businessDays", label: "営業日", type: "int", hideOnPhone: true, hideNarrow: true },
  ];
  // 合計行は KPI と同じコアの Totals（期間の予算合計、原価・粗利は実績月のみ）。合計行の数値に根拠ボタンは付けない
  const t = vm.totals;
  display(
    dataTable({
      columns,
      rows,
      unit,
      caption: "月ごとの予実",
      exportName: `contract_${c.contractId}_monthly`,
      sort: { key: "month", dir: "asc" },
      summary: { name: "合計（原価・粗利は実績月のみ）", budget: t.budget, cost: t.cost, grossProfit: t.grossProfit, grossMargin: t.grossMargin, hours: t.hours, members: null, businessDays: null, status: null },
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
  display(sectionTitle("メンバー別の原価", `${periodJa(vm.period)} に作業したメンバーごとの時間と原価。契約の主担当チーム以外のメンバー（応援）も含みます。`));
  const columns = [
    { key: "memberName", label: "メンバー", type: "text", render: (r) => html`${r.memberName} <span class="yn-muted">${r.memberId}</span>${r.rateMissing ? html` ${statusChip("neutral", "単価なし", "この期間に時間単価が見つからない月があります（0円で計算）")}` : ""}` },
    { key: "teams", label: "所属（当時）", type: "text", hideOnPhone: true },
    { key: "hours", label: "時間", type: "hours" },
    { key: "rateText", label: "単価", type: "text", align: "num", sortValue: (r) => Math.max(...r.rates), hideOnPhone: true },
    { key: "amount", label: "原価", type: "moneyYen" },
    { key: "share", label: "構成比", type: "percent" },
    { key: "months", label: "作業月数", type: "int", hideOnPhone: true },
  ];
  if (rows.length === 0) display(emptyState({ title: "作業実績がありません", text: "この期間に紐付いた作業ログはありません。", icon: "○" }));
  else display(dataTable({ columns, rows, unit, caption: "メンバー別の原価", exportName: `contract_${c.contractId}_members`, sort: { key: "amount", dir: "desc" }, rowHref: (r) => store.href("./member", {}, { id: r.memberId }) }));
}
```

```js
if (vm) {
  const { contract: c, unit } = vm;
  display(sectionTitle("着地見込み（3方式の比較）", `${fiscalYearLabel(model.meta.fiscalYear)} の年度末着地を 3 つの方式で並べています。選択中の方式（${METHOD_LABELS[vm.method]}）を強調表示。`));
  const cards = FORECAST_METHODS.map((m) => {
    const f = result.forecasts[m];
    const b = f.breakdown;
    const inFY = b.contractMonthsInFY.length > 0;
    const selected = m === vm.method;
    const warn = m === "assignment" ? (b.noAssignments ? "アサインが登録されていません（残り原価 0）" : null) : b.noActuals ? "実績が無いため残り原価 0" : null;
    const btn = html`<button type="button" class="yn-btn yn-btn-sm" aria-pressed=${selected ? "true" : "false"}>${selected ? "選択中" : "この方式で表示"}</button>`;
    btn.addEventListener("click", () => store.set({ method: m }));
    return html`<article class=${`yn-card yn-forecast-card${selected ? " is-selected" : ""}${f.isDeficit && inFY ? " is-danger" : ""}`} aria-current=${selected ? "true" : null}>
      <h3 class="yn-forecast-title">${METHOD_LABELS[m]}</h3>
      <p class="yn-forecast-desc">${methodDescription(m, model.config.forecastRecentMonths)}</p>
      <div class="yn-forecast-value">${inFY ? bd.numberButton(money(f.forecastGrossProfit, unit), () => bd.forecastSpec({ forecast: f, contract: c, unit, config: model.config }), { className: "yn-kpi-value", ariaLabel: `${METHOD_LABELS[m]} の着地見込み粗利の計算根拠` }) : html`<span class="yn-kpi-value">—</span>`}
        ${inFY ? statusChip(f.isDeficit ? "danger" : "ok", f.isDeficit ? "赤字見込み" : "黒字見込み") : statusChip("neutral", "年度対象外")}</div>
      <dl class="yn-forecast-facts">
        <div><dt>年度予算</dt><dd class="num">${money(f.fyBudget, unit)}</dd></div>
        <div><dt>実績原価（${b.actualMonths.length}か月）</dt><dd class="num">${money(b.actualCost, unit)}</dd></div>
        <div><dt>残り原価（${b.remainingMonths.length}か月）</dt><dd class="num">${money(b.remainingCost, unit)}</dd></div>
        <div><dt>着地原価</dt><dd class="num">${money(f.forecastCost, unit)}</dd></div>
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
  const loadBtn = html`<button type="button" class="yn-btn">作業ログを読み込む</button>`;
  const status = html`<p class="yn-note" aria-live="polite">作業ログ（1行 = 1件の作業実績）は必要なときだけ読み込みます。</p>`;
  async function load() {
    loadBtn.disabled = true;
    loadBtn.textContent = "読み込み中…";
    try {
      const data = await bd.fetchWorklogs(c.contractId);
      const monthSet = new Set(months.map((m) => m.month));
      const entries = data.months.filter((m) => monthSet.has(m.month)).flatMap((m) => m.worklogs.map((w) => ({ ...w, month: m.month, status: m.status })));
      status.textContent = `${integer(entries.length)} 件（${periodJa(vm.period)}）。取得: ${data.worklogFetchedAt ?? "—"}`;
      loadBtn.remove();
      holder.replaceChildren(worklogExplorer(entries, unit, c.contractId));
    } catch (error) {
      status.textContent = `作業ログを読み込めませんでした: ${error?.message ?? error}`;
      status.setAttribute("role", "alert");
      loadBtn.disabled = false;
      loadBtn.textContent = "再試行";
    }
  }
  loadBtn.addEventListener("click", load);
  return html`<section>${sectionTitle("作業ログ（元データ）", "原価の元になった作業実績。月・メンバー・作業内容で絞り込めます。")}${status}${loadBtn}${holder}</section>`;
})();

function worklogExplorer(entries, unit, id) {
  const months = [...new Set(entries.map((e) => e.month))].sort();
  const members = [...new Map(entries.map((e) => [e.memberId, e.memberName])).entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const tasks = [...new Set(entries.map((e) => e.task))].sort((a, b) => a.localeCompare(b, "ja"));
  const selMonth = html`<select class="yn-select" id="yn-wl-month" aria-label="月"><option value="">すべての月</option>${months.map((m) => html`<option value=${m}>${monthJa(m)}</option>`)}</select>`;
  const selMember = html`<select class="yn-select" id="yn-wl-member" aria-label="メンバー"><option value="">すべてのメンバー</option>${members.map(([mid, name]) => html`<option value=${mid}>${name}（${mid}）</option>`)}</select>`;
  const selTask = html`<select class="yn-select" id="yn-wl-task" aria-label="作業内容"><option value="">すべての作業内容</option>${tasks.map((t) => html`<option value=${t}>${t}</option>`)}</select>`;
  const tableHolder = html`<div></div>`;
  const columns = [
    { key: "date", label: "日付", type: "text" },
    { key: "memberName", label: "メンバー", type: "text", render: (r) => `${r.memberName}（${r.memberId}）` },
    { key: "task", label: "作業内容", type: "text" },
    { key: "hours", label: "時間", type: "hours" },
    { key: "hourlyRate", label: "単価", type: "moneyYen" },
    { key: "amount", label: "金額", type: "moneyYen" },
    { key: "status", label: "状態", type: "text", render: (r) => STATUS_LABELS[r.status], hideOnPhone: true },
  ];
  const render = () => {
    const rows = entries
      .filter((e) => (!selMonth.value || e.month === selMonth.value) && (!selMember.value || e.memberId === selMember.value) && (!selTask.value || e.task === selTask.value))
      .map((e, i) => ({ ...e, key: i }));
    const sum = rows.reduce((s, r) => ({ hours: s.hours + r.hours, amount: s.amount + r.amount }), { hours: 0, amount: 0 });
    tableHolder.replaceChildren(
      dataTable({ columns, rows, unit, caption: "作業ログ", exportName: `contract_${id}_worklogs`, sort: { key: "date", dir: "asc" }, maxHeight: 480, summary: { name: `合計（${integer(rows.length)}件）`, hours: sum.hours, amount: sum.amount, date: null, memberName: null, task: null, hourlyRate: null, status: null } }),
    );
  };
  for (const s of [selMonth, selMember, selTask]) s.addEventListener("change", render);
  render();
  return html`<div class="yn-worklog">
    <div class="yn-filters is-compact" role="group" aria-label="作業ログの絞り込み">
      <div class="yn-filter"><label for="yn-wl-month">月</label>${selMonth}</div>
      <div class="yn-filter"><label for="yn-wl-member">メンバー</label>${selMember}</div>
      <div class="yn-filter"><label for="yn-wl-task">作業内容</label>${selTask}</div>
    </div>
    ${tableHolder}
  </div>`;
}
```

```js
if (worklogSection) display(worklogSection);
```
