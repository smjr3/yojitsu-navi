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
      title: "メンバー詳細",
      breadcrumbs: [{ label: "全体サマリー", href: store.href("./") }, { label: "メンバー別", href: store.href("./members") }, { label: memberId || "（メンバーID未指定）" }],
    }),
  );
  display(
    emptyState({
      title: memberId ? `メンバー ${memberId} は見つかりません` : "メンバーIDが指定されていません",
      text: memberId ? "メンバーマスタにも、作業実績・アサインにも出てこない ID です。ID が変わった可能性があります。" : "メンバー別の一覧からメンバーを選んでください。",
      actions: [{ label: "メンバー別へ戻る", href: store.href("./members") }],
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
      title: html`<span class="yn-title-id">${memberId}</span> ${vm.name}`,
      breadcrumbs: [{ label: "全体サマリー", href: store.href("./") }, { label: "メンバー別", href: store.href("./members") }, { label: vm.name }],
      includesPreliminary: totals?.includesPreliminary ?? false,
    }),
  );
  const teamText = (id) => (id ? teamName(model, id, vm.tree) : "未所属");
  display(html`<dl class="yn-facts" aria-label="メンバーの基本情報">
    <div><dt>区分</dt><dd>${unknown ? statusChip("neutral", "マスタ未登録", "members.csv に無いメンバー。名前は作業ログの表記") : rec?.kind === "partner" ? "パートナー" : "社員"}</dd></div>
    <div><dt>所属${model.config.labels?.team ?? "チーム"}（${monthJa(vm.baseMonth)}）</dt><dd>${rec?.teamId ? html`<a href=${store.href("./members", { team: rec.teamId })}>${teamText(rec.teamId)}</a>` : "未所属"}</dd></div>
    <div><dt>役職</dt><dd>${rec?.title || EMPTY_VALUE}</dd></div>
    ${rec?.department ? html`<div><dt>部署</dt><dd>${rec.department}${rec.section ? ` ${rec.section}` : ""}</dd></div>` : null}
  </dl>`);
  if (records.length > 1) {
    display(html`<details class="yn-details yn-member-history">
      <summary>所属・役職の変遷（${records.length}件）</summary>
      ${dataTable({
        columns: [
          { key: "effectiveFrom", label: "適用開始月", type: "text", render: (r) => monthJa(r.effectiveFrom), exportValue: (r) => r.effectiveFrom },
          { key: "team", label: "所属チーム", type: "text", get: (r) => teamText(r.teamId) },
          { key: "title", label: "役職", type: "text" },
          { key: "kind", label: "区分", type: "text", get: (r) => (r.kind === "partner" ? "パートナー" : "社員") },
        ],
        rows: records.map((r, i) => ({ ...r, key: `${r.effectiveFrom}-${i}` })),
        caption: "所属・役職の変遷",
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
        statTile({ label: `計画原価（${periodJa(period)}）`, value: money(t.plannedCost, unit), sub: `計画時間 ${formatHours(t.plannedHours)}`, breakdown: () => bd.memberPlanSpec({ model, member, months, unit, subtitle: periodJa(period), contractHref }) }),
        statTile({ label: "実績原価", value: money(t.actualCost, unit), sub: `実績時間 ${formatHours(t.actualHours)}${t.unplannedHours > 0 ? `（うちアサイン外 ${formatHours(t.unplannedHours)}）` : ""}`, breakdown: () => bd.memberActualSpec({ model, member, months, unit, subtitle: periodJa(period), contractHref }) }),
        statTile({ label: "差額（計画 − 実績）", value: moneySigned(t.variance, unit), sub: varianceNote(t.variance, unit), breakdown: () => bd.memberVarianceSpec({ plannedCost: t.plannedCost, actualCost: t.actualCost, unit, subtitle }) }),
        statTile({ label: "稼働率（実績時間 ÷ 計画時間）", value: formatPercent(t.utilization), sub: t.utilization === null ? "計画時間が 0 のため計算できません" : `${formatHours(t.actualHours)} ÷ ${formatHours(t.plannedHours)}`, breakdown: () => bd.memberUtilizationSpec({ plannedHours: t.plannedHours, actualHours: t.actualHours, utilization: t.utilization, unplannedHours: t.unplannedHours, subtitle }) }),
    ]),
  );
  if (vm.allFuture) display(note(`選択した期間（${periodJa(vm.fullPeriod)}）はすべて基準月より後のため、実績はまだありません。計画だけを表示しています。`));
  else if (period.to !== vm.fullPeriod.to && vm.fullTotals)
    display(note(`計画と実績は経過月（${periodJa(period)}）で比べています。${monthJa(vm.fullPeriod.to)} までの期間全体の計画は ${money(vm.fullTotals.plannedCost, unit)}（${formatHours(vm.fullTotals.plannedHours)}）です。`));
  if (!totals) display(note(`${periodJa(period)} にはこのメンバーの計画（アサイン）も実績（作業）もありません。期間を変えてください。`));
  if (totals?.rateMissing) display(note("時間単価が見つからない月があります。その月の計画・実績の原価は 0 円で計算しています（単価の変遷を参照）。", "warn"));
}
```

```js
if (vm) {
  const { unit, member, series } = vm;
  const period = vm.fullPeriod;
  display(sectionTitle("月次推移", `${periodJa(period)} の計画時間（配分 × 基準時間）と実績時間。${monthJa(model.meta.asOfMonth)} 以降は実績が確定していない（または未来の）月です。数値をクリックすると根拠が開きます。`));
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
    { key: "month", label: "月", type: "text", render: (r) => monthJa(r.month), sortValue: (r) => r.month, exportValue: (r) => r.month },
    { key: "status", label: "状態", type: "status", get: (r) => ({ kind: r.status === "final" ? "ok" : r.status === "preliminary" ? "prelim" : "neutral", text: STATUS_LABELS[r.status] }), hideOnPhone: true },
    { key: "plannedHours", label: "計画時間", type: "hours", breakdown: (r) => bd.memberPlanSpec({ model, member, months: monthRows(r.month), unit, measure: "hours", subtitle: monthJa(r.month), contractHref }) },
    { key: "actualHours", label: "実績時間", type: "hours", render: fut((r) => formatHours(r.actualHours)), breakdown: (r) => bd.memberActualSpec({ model, member, months: monthRows(r.month), unit, measure: "hours", subtitle: monthJa(r.month), contractHref }) },
    { key: "utilization", label: "稼働率", type: "percent", render: fut((r) => formatPercent(r.utilization)), breakdown: (r) => bd.memberUtilizationSpec({ plannedHours: r.plannedHours, actualHours: r.actualHours, utilization: r.utilization, unplannedHours: r.unplannedHours, subtitle: monthJa(r.month) }) },
    { key: "plannedCost", label: "計画原価", type: "moneyYen", hideOnPhone: true, breakdown: (r) => bd.memberPlanSpec({ model, member, months: monthRows(r.month), unit, subtitle: monthJa(r.month), contractHref }) },
    { key: "actualCost", label: "実績原価", type: "moneyYen", hideOnPhone: true, render: fut((r, u) => money(r.actualCost, u)), breakdown: (r) => bd.memberActualSpec({ model, member, months: monthRows(r.month), unit, subtitle: monthJa(r.month), contractHref }) },
    { key: "variance", label: "差額", sublabel: "（計画−実績）", type: "moneyYen", render: fut((r, u) => moneySigned(r.variance, u)), breakdown: (r) => bd.memberVarianceSpec({ plannedCost: r.plannedCost, actualCost: r.actualCost, unit, subtitle: monthJa(r.month) }) },
  ];
  const t = vm.totals;
  const sumLabel = vm.period.to !== period.to ? `合計（経過月 ${periodJa(vm.period)}）` : "合計";
  display(
    dataTable({
      columns,
      rows,
      unit,
      caption: "月ごとの計画と実績",
      exportName: `member_${memberId}_monthly`,
      sort: { key: "month", dir: "asc" },
      summary: t ? { name: sumLabel, plannedHours: t.plannedHours, actualHours: t.actualHours, utilization: t.utilization, plannedCost: t.plannedCost, actualCost: t.actualCost, variance: t.variance, status: null } : null,
    }),
  );
}
```

```js
if (vm) {
  const { unit, period, member, totals } = vm;
  display(sectionTitle("契約別", `${periodJa(period)}${period.to !== vm.fullPeriod.to ? "（経過月）" : ""} にアサインされた契約と作業した契約。「アサインなし」は計画が無く作業だけがある契約（応援など）です。契約名をクリックすると契約詳細へ移動します。`));
  const byId = new Map(model.contracts.map((r) => [r.contract.contractId, r.contract]));
  const contractHref = (id) => store.href("./contract", {}, { id });
  const rows = (totals?.byContract ?? []).map((c) => {
    const k = byId.get(c.contractId);
    return {
      ...c,
      key: c.contractId,
      customerName: k?.customerName ?? "",
      projectName: k?.projectName ?? "",
      teamName: k?.teamId ? teamName(model, k.teamId, vm.tree) : "未設定",
      startMonth: k?.startMonth ?? "",
      endMonth: k?.endMonth ?? "",
    };
  });
  const chips = (r) =>
    r.assignedMonths === 0
      ? [{ kind: "neutral", text: "アサインなし", title: "この期間にアサインが無く、作業だけがある契約" }]
      : r.unplannedHours > 0
        ? [{ kind: "neutral", text: `アサイン外 ${formatHours(r.unplannedHours)}`, title: "アサイン期間の外の月に作業した時間" }]
        : [];
  const columns = [
    { key: "contractId", label: "契約", type: "text", render: (r) => contractNameCell(r), sortValue: (r) => r.contractId, exportValue: (r) => r.contractId },
    { key: "contractName", label: "顧客 / 案件", type: "text", exportOnly: true, get: (r) => `${r.customerName} / ${r.projectName}` },
    { key: "plannedHours", label: "計画時間", type: "hours", hideOnPhone: true, breakdown: (r) => bd.memberPlanSpec({ model, member, months: vm.months, contractIds: [r.contractId], unit, measure: "hours", subtitle: `${r.contractId} ・ ${periodJa(period)}`, contractHref }) },
    { key: "actualHours", label: "実績時間", type: "hours", hideOnPhone: true, breakdown: (r) => bd.memberActualSpec({ model, member, months: vm.months, contractIds: [r.contractId], unit, measure: "hours", subtitle: `${r.contractId} ・ ${periodJa(period)}`, contractHref }) },
    { key: "plannedCost", label: "計画原価", type: "moneyYen", breakdown: (r) => bd.memberPlanSpec({ model, member, months: vm.months, contractIds: [r.contractId], unit, subtitle: `${r.contractId} ・ ${periodJa(period)}`, contractHref }) },
    { key: "actualCost", label: "実績原価", type: "moneyYen", breakdown: (r) => bd.memberActualSpec({ model, member, months: vm.months, contractIds: [r.contractId], unit, subtitle: `${r.contractId} ・ ${periodJa(period)}`, contractHref }) },
    { key: "variance", label: "差額", sublabel: "（計画−実績）", type: "moneyYen", render: (r, u) => moneySigned(r.variance, u), breakdown: (r) => bd.memberVarianceSpec({ plannedCost: r.plannedCost, actualCost: r.actualCost, unit, subtitle: `${r.contractId} ・ ${periodJa(period)}` }) },
    { key: "status", label: "アサイン", type: "status", get: chips, sortable: false, hideNarrow: true },
  ];
  if (rows.length === 0) display(emptyState({ title: "この期間の契約はありません", text: "アサインも作業実績もありません。", icon: "○" }));
  else
    display(
      dataTable({
        columns,
        rows,
        unit,
        caption: "契約別の計画と実績",
        exportName: `member_${memberId}_contracts`,
        sort: { key: "actualCost", dir: "desc" },
        rowHref: (r) => contractHref(r.contractId),
        summary: { name: "合計", plannedHours: totals.plannedHours, actualHours: totals.actualHours, plannedCost: totals.plannedCost, actualCost: totals.actualCost, variance: totals.variance, status: null },
      }),
    );
}
```

```js
if (vm) {
  const segs = rateHistory[memberId] ?? [];
  display(sectionTitle("単価の変遷", `計画・実績の原価に使う時間単価（個人単価があればそれ、無ければその月の役職の単価）。データの範囲（${monthJa(model.meta.minMonth)}〜${monthJa(model.meta.maxMonth)}）で、単価・出どころ・役職が変わった月ごとに区切っています。`));
  if (segs.length === 0) display(emptyState({ title: "単価の情報がありません", text: "メンバーマスタに有効なレコードがありません。", icon: "○" }));
  else
    display(
      dataTable({
        columns: [
          { key: "from", label: "期間", type: "text", render: (r) => (r.from === r.to ? monthJa(r.from) : `${monthJa(r.from)}〜${monthJa(r.to)}`), exportValue: (r) => `${r.from}〜${r.to}` },
          { key: "title", label: "役職", type: "text", hideOnPhone: true },
          { key: "hourlyRate", label: "時間単価", type: "moneyYen", render: (r) => (r.rateMissing ? statusChip("neutral", "単価なし（0円）", "rates.csv に該当する単価がありません") : money(r.hourlyRate, "yen")) },
          { key: "source", label: "単価の出どころ", type: "text", get: (r) => (r.rateMissing ? "—" : r.rateSource?.key === memberId ? `個人単価（${r.rateSource.effectiveFrom}〜）` : `役職「${r.rateSource?.key}」（${r.rateSource?.effectiveFrom}〜）`) },
        ],
        rows: segs.map((s) => ({ ...s, key: s.from })),
        caption: "単価の変遷",
        exportName: `member_${memberId}_rates`,
        sort: { key: "from", dir: "asc" },
      }),
    );
}
```
