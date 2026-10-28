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
import { UNASSIGNED_TEAM_ID, aggregateMembers, normalizeName } from "./core/index.js";
import { createStore } from "./components/state.js";
import { scopeFor, teamName, memberIdsInTeam } from "./components/analysis.js";
import { pageHeader, sectionTitle, loadJson, note } from "./components/layout.js";
import { filterBar } from "./components/filters.js";
import { statTile, kpiRow, statusChip } from "./components/kpi.js";
// KPI 4 枚（計画原価・実績原価・差額・稼働率）。1024px でも 4 枚が 1 行（狭いと 2×2）に並ぶようにクラスを足す
const memberKpiRow = (tiles) => {
  const row = kpiRow(tiles, { columns: 4 });
  row.classList.add("yn-kpi-4");
  return row;
};
import { dataTable } from "./components/table.js";
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
  const all = aggregateMembers(model, { period });
  // 所属チーム（基準月 = 期間の終了月。未来は基準月）で絞る。上位チームは配下を含む。
  // 「未設定」は所属チームが空か、基準月の組織に無いメンバー
  // 対象の人は「期間全体」で決める（経過月だけで決めると、未来月にだけアサインのある人が期間全体の計画から抜ける）
  const allFull = period.to === fullPeriod.to ? all : aggregateMembers(model, { period: fullPeriod });
  const memberIds = memberIdsInTeam(allFull.members, state.team, scope.tree);
  const agg = memberIds ? aggregateMembers(model, { period, memberIds }) : all;
  // 期間全体の計画（未来月を含む）。KPI の補足に出す
  const fullAgg = period.to === fullPeriod.to ? agg : aggregateMembers(model, { period: fullPeriod, memberIds: memberIds ?? undefined });
  const rows = agg.members.map((m) => ({
    ...m,
    key: m.memberId,
    teamName: m.teamId ? teamName(model, m.teamId, scope.tree) : "",
    searchText: normalizeName(`${m.memberId} ${m.memberName} ${m.title ?? ""}`),
  }));
  return { scope, period, fullPeriod, allFuture, fullAgg, agg, rows, unit: state.unit, baseMonth: all.baseMonth, includesPreliminary: agg.members.some((m) => m.includesPreliminary) };
})();
```

```js
if (model) {
  display(
    pageHeader({
      model,
      title: "メンバー別",
      lead: "人ごとの計画（アサインの配分人月 × 基準時間 × 単価）と実績（その人の作業時間 × 単価）の比較。差額がマイナスの人は計画より原価が多く掛かっています。行をクリックするとメンバー詳細へ移動します。",
      breadcrumbs: [{ label: "全体サマリー", href: store.href("./") }, { label: "メンバー別" }],
      includesPreliminary: vm?.includesPreliminary ?? false,
    }),
  );
}
```

```js
if (store) display(filterBar(store, model, { show: ["period", "team", "unit"] }));
```

```js
if (vm?.scope.teamMissing) {
  display(note(`選択したチーム「${vm.scope.teamLabel}」は ${monthJa(vm.baseMonth)} 時点の組織に存在しません。メンバーは 0 人になります。`, "warn"));
}
```

```js
if (vm) {
  const { agg, unit, period, fullPeriod, fullAgg } = vm;
  const t = agg.total;
  const subtitle = `${vm.scope.teamLabel} ・ ${periodJa(period)}`;
  const future = fullAgg.total.plannedCost - t.plannedCost;
  if (vm.allFuture) display(note(`選択した期間（${periodJa(fullPeriod)}）はすべて基準月より後のため、実績はまだありません。計画だけを表示しています。`));
  else if (period.to !== fullPeriod.to)
    display(note(`計画と実績は経過月（${periodJa(period)}）で比べています。${monthJa(fullPeriod.to)} までの期間全体の計画は ${money(fullAgg.total.plannedCost, unit)}（うち${monthJa(period.to)}より後の月 ${money(future, unit)}）です。`));
  display(
    memberKpiRow([
        statTile({ label: `計画原価（${periodJa(period)}）`, value: money(t.plannedCost, unit), sub: `計画時間 ${formatHours(t.plannedHours)} ・ ${t.memberCount}人${period.to !== fullPeriod.to ? ` ・ 期間全体 ${money(fullAgg.total.plannedCost, unit)}` : ""}`, breakdown: () => bd.memberTotalsSpec({ members: agg.members, total: t, measure: "plannedCost", unit, period }) }),
        statTile({ label: "実績原価", value: money(t.actualCost, unit), sub: `実績時間 ${formatHours(t.actualHours)}（うちアサイン外 ${formatHours(t.unplannedHours)}）`, breakdown: () => bd.memberTotalsSpec({ members: agg.members, total: t, measure: "actualCost", unit, period }) }),
        statTile({ label: "差額（計画 − 実績）", value: moneySigned(t.variance, unit), sub: varianceNote(t.variance, unit), breakdown: () => bd.memberVarianceSpec({ plannedCost: t.plannedCost, actualCost: t.actualCost, unit, subtitle }) }),
        statTile({ label: "稼働率（実績時間 ÷ 計画時間）", value: formatPercent(t.utilization), sub: t.utilization === null ? "計画時間が 0 のため計算できません" : `${formatHours(t.actualHours)} ÷ ${formatHours(t.plannedHours)}`, breakdown: () => bd.memberUtilizationSpec({ plannedHours: t.plannedHours, actualHours: t.actualHours, utilization: t.utilization, unplannedHours: t.unplannedHours, subtitle }) }),
    ]),
  );
}
```

```js
// 検索フォームは model だけに依存し 1 回だけ描く（期間・単位を変えても作り直さない）
const searchForm = (() => {
  if (!model) return null;
  const form = html`<form class="yn-chip-filters" role="search" aria-label="メンバーの検索"></form>`;
  form.addEventListener("submit", (ev) => ev.preventDefault());
  const input = html`<input type="search" class="yn-input" id="yn-m-text" placeholder="名前・ID・役職・チームで検索" value=${initialQuery} aria-label="名前・ID・役職・チームで検索（全角・半角、大文字・小文字は区別しません）">`;
  let timer = null;
  input.addEventListener("input", () => {
    // 150ms デバウンス（1 文字ごとに表を作り直さない）
    clearTimeout(timer);
    timer = setTimeout(() => {
      form.value = input.value;
      form.dispatchEvent(new CustomEvent("input", { bubbles: true }));
    }, 150);
  });
  form.append(html`<label class="yn-filter-label" for="yn-m-text">検索</label>`, input);
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
  const shown = q ? aggregateMembers(model, { period, memberIds: rows.map((r) => r.memberId) }) : vm.agg;
  display(
    sectionTitle(
      "メンバーごとの計画と実績",
      `${periodJa(period)}${period.to !== vm.fullPeriod.to ? "（経過月）" : ""} ・ 所属は ${monthJa(vm.baseMonth)} 時点。期間内に計画（アサイン）か実績（作業）のある人だけを表示します。稼働率 = 実績時間 ÷ 計画時間（100% 超でも色は付けません）。差額 = 計画原価 − 実績原価。`,
    ),
  );
  const monthsOf = (r) => (monthsByMember.get(r.memberId) ?? []).filter((mm) => period.from <= mm.month && mm.month <= period.to);
  const sub = (r) => `${r.memberName}（${r.memberId}）`;
  const contractHref = (id) => store.href("./contract", {}, { id });
  const chips = (r) => {
    const list = [];
    if (r.memberUnknown) list.push({ kind: "neutral", text: "マスタ未登録", title: "members.csv に無いメンバー（作業ログの名前で表示）" });
    if (r.rateMissing) list.push({ kind: "neutral", text: "単価なし", title: "時間単価が見つからない月があります（0円で計算）" });
    if (r.unplannedHours > 0) list.push({ kind: "neutral", text: `アサイン外 ${formatHours(r.unplannedHours)}`, title: "アサインの無い契約・月への作業時間（実績の内数）" });
    // 速報はページ見出しのバッジで示す（ほぼ全員に付いてしまい行ごとのチップは情報にならない）
    return list;
  };
  const columns = [
    {
      key: "memberName",
      label: "メンバー",
      sublabel: "（ID・所属・役職）",
      type: "text",
      // 2 行目に ID・所属チーム・役職（列を分けると 1280/1024px に収まらないため。Excel には別列で出す）
      render: (r) => html`<span class="yn-cell-2line" title=${`${r.memberName}（${r.memberId}）・${r.teamName || "未所属"}${r.title ? `・${r.title}` : ""}`}><span class="yn-cell-main">${r.memberName}</span><span class="yn-cell-sub"><span class="yn-cell-id">${r.memberId}</span> ・ ${r.teamName || "未所属"}${r.title ? ` ・ ${r.title}` : ""}</span></span>`,
      sortValue: (r) => r.memberName,
      exportValue: (r) => r.memberName,
    },
    { key: "memberId", label: "メンバーID", type: "text", exportOnly: true },
    { key: "teamName", label: "所属チーム", type: "text", exportOnly: true, exportValue: (r) => r.teamName || "未所属" },
    { key: "title", label: "役職", type: "text", exportOnly: true },
    { key: "kindLabel", label: "区分", type: "text", exportOnly: true, get: (r) => (r.memberUnknown ? "マスタ未登録" : r.kind === "partner" ? "パートナー" : "社員") },
    { key: "plannedHours", label: "計画時間", type: "hours", hideOnPhone: true, breakdown: (r) => bd.memberPlanSpec({ model, member: r, months: monthsOf(r), unit, measure: "hours", subtitle: periodJa(period), contractHref }) },
    { key: "actualHours", label: "実績時間", type: "hours", hideOnPhone: true, breakdown: (r) => bd.memberActualSpec({ model, member: r, months: monthsOf(r), unit, measure: "hours", subtitle: periodJa(period), contractHref }) },
    { key: "utilization", label: "稼働率", type: "percent", breakdown: (r) => bd.memberUtilizationSpec({ plannedHours: r.plannedHours, actualHours: r.actualHours, utilization: r.utilization, unplannedHours: r.unplannedHours, subtitle: sub(r) }) },
    { key: "plannedCost", label: "計画原価", type: "money", breakdown: (r) => bd.memberPlanSpec({ model, member: r, months: monthsOf(r), unit, subtitle: periodJa(period), contractHref }) },
    { key: "actualCost", label: "実績原価", type: "money", breakdown: (r) => bd.memberActualSpec({ model, member: r, months: monthsOf(r), unit, subtitle: periodJa(period), contractHref }) },
    { key: "variance", label: "差額", sublabel: "（計画−実績）", type: "money", exportLabel: "差額（計画−実績）（円）", render: (r, u) => moneySigned(r.variance, u), breakdown: (r) => bd.memberVarianceSpec({ plannedCost: r.plannedCost, actualCost: r.actualCost, unit, subtitle: sub(r) }) },
    { key: "status", label: "状態", type: "status", get: chips, hideNarrow: true, sortable: false },
  ];
  const st = shown.total;
  display(
    dataTable({
      columns,
      rows,
      unit,
      caption: "メンバー別の計画と実績",
      exportName: `members_${period.from}_${period.to}`,
      sort: { key: "variance", dir: "asc" },
      rowHref: (r) => store.href("./member", {}, { id: r.memberId }),
      emptyText: q ? "検索に一致するメンバーがいません" : "この期間に計画も実績もあるメンバーがいません",
      summary: rows.length
        ? { memberName: null, name: `合計（${rows.length}人）`, plannedHours: st.plannedHours, actualHours: st.actualHours, utilization: st.utilization, plannedCost: st.plannedCost, actualCost: st.actualCost, variance: st.variance, teamName: null, title: null, status: null }
        : null,
      summaryBreakdown: (col) => (["plannedHours", "actualHours", "utilization", "plannedCost", "actualCost", "variance"].includes(col.key) ? () => bd.memberTotalsSpec({ members: shown.members, total: st, measure: col.key, unit, period }) : null),
    }),
  );
  if (vm.rows.length === 0) display(note("期間を広げるか、チームの絞り込みを外してください。アサインは assignments.csv、作業実績は作業ログから読み込んでいます。"));
}
```
