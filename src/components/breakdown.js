/**
 * 計算根拠（内訳）パネル — SPEC §13
 *
 * 画面の数値は numberButton() で描く。クリックすると <dialog> に「式 ＋ 実際に使った値」を表示する。
 * 内訳の仕様（spec）は次の形:
 *   {
 *     title, subtitle?, formula?: string | string[],
 *     rows?: [{label, value, note?}],                 // 式に入れた値
 *     sections?: [{title?, text?, table?: {columns: [{label, align?}], rows: [[cell, ...]]}, lazy?: async () => Node}],
 *     note?: string
 *   }
 * spec は関数でもよい（開いたときに初めて計算する）。
 */
import { html } from "htl";
import { h } from "./dom.js";
import { T, fmt } from "../i18n/index.js";
import { EMPTY_VALUE, STATUS_LABELS, METHOD_LABELS, decimal, formatHours, formatPercent, integer, money as moneyInUnit, monthJa, periodJa, profitLabel } from "./format.js";
import { grossMarginOf, memberNameAt } from "./analysis.js";
import { worklogKey } from "./worklog-key.js";

/**
 * 計算根拠は丸めずに見せる（SPEC §12）: 画面の表示単位（百万円など）に関係なく、内訳の金額は常に円で出す。
 * spec 関数の unit 引数は呼び出し側との互換のため受け取るだけにしている。
 */
const money = (yen, _unit) => moneyInUnit(yen, "yen");

let dialogEl = null;
let lastOpener = null;

function ensureDialog() {
  if (dialogEl && dialogEl.isConnected) return dialogEl;
  const dialog = html`<dialog class="yn-dialog" aria-labelledby="yn-dialog-title">
    <div class="yn-dialog-inner">
      <header class="yn-dialog-head">
        <h2 id="yn-dialog-title" class="yn-dialog-title"></h2>
        <button type="button" class="yn-btn yn-btn-icon yn-dialog-close" aria-label=${T.breakdown.close}>×</button>
      </header>
      <div class="yn-dialog-body"></div>
      <footer class="yn-dialog-foot"><span class="yn-dialog-hint">${T.breakdown.escHint}</span><button type="button" class="yn-btn yn-dialog-close2">${T.breakdown.close}</button></footer>
    </div>
  </dialog>`;
  const close = () => dialog.close();
  dialog.querySelector(".yn-dialog-close").addEventListener("click", close);
  dialog.querySelector(".yn-dialog-close2").addEventListener("click", close);
  dialog.addEventListener("click", (ev) => {
    // 背景（dialog 自身）のクリックで閉じる。内側のクリックは無視
    if (ev.target === dialog) close();
  });
  dialog.addEventListener("close", () => {
    if (lastOpener && lastOpener.isConnected) lastOpener.focus();
    lastOpener = null;
  });
  document.body.appendChild(dialog);
  dialogEl = dialog;
  return dialog;
}

function renderTable(table) {
  const cols = table.columns ?? [];
  return html`<div class="yn-table-wrap yn-table-wrap-inline"><table class="yn-table yn-table-compact">
    <thead><tr>${cols.map((c) => html`<th scope="col" class=${c.align === "num" ? "num" : ""}>${c.label}</th>`)}</tr></thead>
    <tbody>${table.rows.map(
      (r) => html`<tr>${r.map((cell, i) => html`<td class=${cols[i]?.align === "num" ? "num" : ""}>${cell ?? EMPTY_VALUE}</td>`)}</tr>`,
    )}</tbody>
    ${table.foot ? html`<tfoot><tr>${table.foot.map((cell, i) => html`<td class=${cols[i]?.align === "num" ? "num" : ""}>${cell ?? ""}</td>`)}</tr></tfoot>` : null}
  </table></div>`;
}

function renderSection(section) {
  const node = html`<section class="yn-bd-section">
    ${section.title ? html`<h3 class="yn-bd-section-title">${section.title}</h3>` : null}
    ${section.text ? html`<p class="yn-bd-text">${section.text}</p>` : null}
    ${section.table ? renderTable(section.table) : null}
  </section>`;
  if (section.lazy) {
    const btn = html`<button type="button" class="yn-btn yn-btn-sm">${section.lazyLabel ?? T.breakdown.loadDetails}</button>`;
    const holder = html`<div class="yn-bd-lazy"></div>`;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = T.common.loading;
      try {
        const content = await section.lazy();
        holder.replaceChildren(content);
        btn.remove();
      } catch (error) {
        holder.replaceChildren(html`<p class="yn-note yn-note-danger" role="alert">${fmt(T.breakdown.loadFailed, { error: error?.message ?? String(error) })}</p>`);
        btn.disabled = false;
        btn.textContent = section.lazyLabel ?? T.breakdown.loadDetails;
      }
    });
    node.append(btn, holder);
  }
  return node;
}

function renderSpec(spec) {
  const formulas = Array.isArray(spec.formula) ? spec.formula : spec.formula ? [spec.formula] : [];
  return html`<div class="yn-bd">
    ${spec.subtitle ? html`<p class="yn-bd-subtitle">${spec.subtitle}</p>` : null}
    ${formulas.length ? html`<div class="yn-bd-formula" aria-label=${T.breakdown.formulaLabel}>${formulas.map((f) => html`<code>${f}</code>`)}</div>` : null}
    ${spec.rows?.length
      ? html`<dl class="yn-bd-rows">${spec.rows.map(
          (r) => html`<div class=${r.emphasis ? "is-emphasis" : ""}><dt>${r.label}</dt><dd><span class="num">${r.value ?? EMPTY_VALUE}</span>${r.note ? html`<small>${r.note}</small>` : null}</dd></div>`,
        )}</dl>`
      : null}
    ${(spec.sections ?? []).map(renderSection)}
    ${spec.note ? html`<p class="yn-note">${spec.note}</p>` : null}
  </div>`;
}

/** 内訳パネルを開く */
export function openBreakdown(spec, opener = null) {
  const resolved = typeof spec === "function" ? spec() : spec;
  const dialog = ensureDialog();
  lastOpener = opener ?? document.activeElement;
  dialog.querySelector("#yn-dialog-title").textContent = resolved.title ?? T.breakdown.title;
  const body = dialog.querySelector(".yn-dialog-body");
  body.replaceChildren(renderSpec(resolved));
  body.scrollTop = 0;
  if (!dialog.open) dialog.showModal();
  dialog.querySelector(".yn-dialog-close").focus();
  return dialog;
}

export function closeBreakdown() {
  if (dialogEl?.open) dialogEl.close();
}

/** 数値ボタン。クリック／Enter で内訳を開く */
export function numberButton(text, spec, { className = "", ariaLabel = null, title = T.breakdown.show } = {}) {
  // 表の 1 マスごとに作るので html`` でなく直接作る（§107）
  const btn = h("button", { type: "button", class: `yn-num ${className}`.trim(), title, "aria-label": ariaLabel }, text);
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    openBreakdown(spec, btn);
  });
  return btn;
}

// ---------------------------------------------------------------------------
// 作業ログ明細の遅延取得（data/worklogs/[contractId].json）
// ---------------------------------------------------------------------------

const worklogCache = new Map();

/** 契約の作業ログ明細を取得する（結果はキャッシュ） */
export function fetchWorklogs(contractId) {
  if (!worklogCache.has(contractId)) {
    const file = `data/worklogs/${worklogKey(contractId)}.json`;
    // ビルド済みサイトでは dynamicPaths により /data/worklogs/<id>.json に置かれる。
    // 開発プレビュー（npm run dev）では /_file/data/worklogs/<id>.json で配信されるので順に試す。
    const candidates = [new URL(`../../${file}`, import.meta.url), new URL(`../../_file/${file}`, import.meta.url)];
    const p = (async () => {
      let lastStatus = 0;
      for (const url of candidates) {
        // 再公開のたびに中身が変わるがファイル名は同じなので、ブラウザのキャッシュを使う前に必ずサーバーに確認する（変わっていなければ 304）
        const res = await fetch(url, { cache: "no-cache" });
        if (res.ok) return res.json();
        lastStatus = res.status;
        if (res.status !== 404) break;
      }
      throw new Error(fmt(T.breakdown.worklogFetchFailed, { status: lastStatus }));
    })();
    p.catch(() => worklogCache.delete(contractId));
    worklogCache.set(contractId, p);
  }
  return worklogCache.get(contractId);
}

/** 作業ログ明細の表 */
export function worklogTable(entries, { unit = "yen", limit = 500 } = {}) {
  const rows = entries.slice(0, limit).map((w) => [w.date, w.memberName, w.task, formatHours(w.hours), money(w.hourlyRate, "yen"), money(w.amount, unit)]);
  const total = entries.reduce((s, w) => s + w.amount, 0);
  const hours = entries.reduce((s, w) => s + w.hours, 0);
  const more = entries.length > limit ? html`<p class="yn-note">${fmt(T.breakdown.showingFirst, { limit: integer(limit), total: integer(entries.length) })}</p>` : null;
  return html`<div>${renderTable({
    columns: [{ label: T.breakdown.colDate }, { label: T.breakdown.colMember }, { label: T.breakdown.colTask }, { label: T.breakdown.colHours, align: "num" }, { label: T.breakdown.colRate, align: "num" }, { label: T.breakdown.colAmount, align: "num" }],
    rows,
    foot: [T.breakdown.total, fmt(T.breakdown.countSpaced, { n: integer(entries.length) }), "", formatHours(hours), "", money(total, unit)],
  })}${more}</div>`;
}

// ---------------------------------------------------------------------------
// 内訳 spec の組み立て（計算コアの breakdown を人が読める形に）
// ---------------------------------------------------------------------------

/** 契約×月の予算（BudgetBreakdown） */
export function budgetMonthSpec({ contract, cm, unit }) {
  const b = cm.budgetBreakdown;
  return {
    title: fmt(T.breakdown.budgetTitle, { customer: contract.customerName, project: contract.projectName, month: monthJa(cm.month) }),
    formula: [T.breakdown.budgetFormulaBase, T.breakdown.budgetFormulaRemainder, T.breakdown.budgetFormulaMonth],
    rows: [
      { label: T.breakdown.totalAmount, value: money(b.totalAmount, unit) },
      { label: T.breakdown.monthCount, value: fmt(T.breakdown.months, { n: b.monthCount }), note: `${contract.startMonth}〜${contract.endMonth}` },
      { label: T.breakdown.baseMonthly, value: money(b.baseMonthly, unit) },
      { label: T.breakdown.remainder, value: money(b.remainder, unit) },
      { label: T.breakdown.isLastMonth, value: b.isLastMonth ? T.breakdown.yes : T.breakdown.no },
      { label: fmt(T.breakdown.monthBudget, { month: monthJa(cm.month) }), value: money(cm.budget, unit), emphasis: true },
    ],
  };
}

/** 期間・契約範囲の予算合計 */
export function budgetAggregateSpec({ model, contractIds, period, unit, label = T.breakdown.budget }) {
  const set = contractIds ? new Set(contractIds) : null;
  const rows = [];
  let total = 0;
  for (const r of model.contracts) {
    if (set && !set.has(r.contract.contractId)) continue;
    const months = r.months.filter((m) => period.from <= m.month && m.month <= period.to);
    if (months.length === 0) continue;
    const sum = months.reduce((s, m) => s + m.budget, 0);
    total += sum;
    const b = months[0].budgetBreakdown;
    rows.push([
      `${r.contract.customerName} / ${r.contract.projectName}`,
      `${r.contract.startMonth}〜${r.contract.endMonth}`,
      money(r.contract.totalAmount, unit),
      `${b.monthCount}`,
      money(b.baseMonthly, unit),
      `${months.length}`,
      money(sum, unit),
    ]);
  }
  return {
    title: fmt(T.breakdown.aggregateTitle, { label, period: periodJa(period) }),
    formula: [T.breakdown.budgetAggFormula, fmt(T.breakdown.budgetAggFormulaSum, { label })],
    rows: [
      { label: T.breakdown.targetContracts, value: fmt(T.breakdown.count, { n: rows.length }) },
      { label: fmt(T.breakdown.labelTotal, { label }), value: money(total, unit), emphasis: true },
    ],
    sections: [
      {
        title: T.breakdown.byContract,
        table: {
          columns: [{ label: T.breakdown.colContract }, { label: T.breakdown.colContractPeriod }, { label: T.breakdown.totalAmount, align: "num" }, { label: T.breakdown.monthCount, align: "num" }, { label: T.breakdown.colMonthlyBase, align: "num" }, { label: T.breakdown.colMonthsInPeriod, align: "num" }, { label: T.breakdown.colBudgetInPeriod, align: "num" }],
          rows,
        },
      },
    ],
    note: T.breakdown.budgetAggNote,
  };
}

/** 契約×月の原価（CostLine → 作業ログ） */
export function costMonthSpec({ contract, cm, unit, model }) {
  const lines = cm.costLines.map((l) => [
    l.memberName,
    l.memberTeamId ? (model?.teamTree?.[l.memberTeamId]?.name ?? l.memberTeamId) : "—",
    formatHours(l.hours),
    l.rateMissing ? html`<span class="yn-chip yn-chip-neutral"><span class="yn-chip-icon" aria-hidden="true">▲</span>${T.breakdown.rateMissing}</span>` : money(l.hourlyRate, "yen"),
    l.rateSource ? `${l.rateSource.key === l.memberId ? T.masters.personalRateHint : l.rateSource.key}（${l.rateSource.effectiveFrom}〜）` : "—",
    money(l.amount, unit),
  ]);
  return {
    title: fmt(T.breakdown.costTitle, { customer: contract.customerName, project: contract.projectName, month: monthJa(cm.month) }),
    subtitle: fmt(T.breakdown.statusLine, { status: STATUS_LABELS[cm.status] }),
    formula: [T.breakdown.costFormulaMember, T.breakdown.costFormulaMonth],
    rows: [
      { label: T.breakdown.workHours, value: formatHours(cm.hours) },
      { label: T.breakdown.costLineCount, value: `${cm.costLines.length}` },
      { label: fmt(T.breakdown.monthCost, { month: monthJa(cm.month) }), value: money(cm.cost, unit), emphasis: true },
    ],
    sections: [
      {
        title: T.breakdown.costLinesByMember,
        table: {
          columns: [{ label: T.breakdown.colMember }, { label: T.breakdown.colTeamAtTime }, { label: T.breakdown.colHours, align: "num" }, { label: T.breakdown.colRate, align: "num" }, { label: T.breakdown.colRateSource }, { label: T.breakdown.colAmount, align: "num" }],
          rows: lines,
        },
      },
      {
        title: T.breakdown.worklogs,
        lazyLabel: T.breakdown.loadWorklogs,
        lazy: async () => {
          const data = await fetchWorklogs(contract.contractId);
          const month = data.months.find((m) => m.month === cm.month);
          const entries = month?.worklogs ?? [];
          if (entries.length === 0) return html`<p class="yn-note">${T.breakdown.noWorklogsMonth}</p>`;
          return worklogTable(entries, { unit });
        },
      },
    ],
  };
}

/** 期間・契約範囲の原価合計 */
export function costAggregateSpec({ model, contractIds, period, unit, label = T.breakdown.cost, detailHref = null }) {
  const set = contractIds ? new Set(contractIds) : null;
  const rows = [];
  let total = 0;
  let hours = 0;
  for (const r of model.contracts) {
    if (set && !set.has(r.contract.contractId)) continue;
    const months = r.months.filter((m) => period.from <= m.month && m.month <= period.to);
    if (months.length === 0) continue;
    const sum = months.reduce((s, m) => s + m.cost, 0);
    const h = months.reduce((s, m) => s + m.hours, 0);
    const missing = months.some((m) => m.costLines.some((l) => l.rateMissing));
    total += sum;
    hours += h;
    rows.push([
      detailHref ? html`<a href=${detailHref(r.contract.contractId)}>${r.contract.customerName} / ${r.contract.projectName}</a>` : `${r.contract.customerName} / ${r.contract.projectName}`,
      `${r.contract.startMonth}〜${r.contract.endMonth}`,
      `${months.length}`,
      formatHours(h),
      money(sum, unit),
      missing ? T.breakdown.hasRateMissing : "",
    ]);
  }
  return {
    title: fmt(T.breakdown.aggregateTitle, { label, period: periodJa(period) }),
    formula: [T.breakdown.costAggFormula, fmt(T.breakdown.costAggFormulaSum, { label })],
    rows: [
      { label: T.breakdown.targetContracts, value: fmt(T.breakdown.count, { n: rows.length }) },
      { label: T.breakdown.workHours, value: formatHours(hours) },
      { label: fmt(T.breakdown.labelTotal, { label }), value: money(total, unit), emphasis: true },
    ],
    sections: [
      {
        title: T.breakdown.byContract,
        text: T.breakdown.costAggHint,
        table: {
          columns: [{ label: T.breakdown.colContract }, { label: T.breakdown.colContractPeriod }, { label: T.breakdown.colMonthsInPeriod, align: "num" }, { label: T.breakdown.colHours, align: "num" }, { label: T.breakdown.cost, align: "num" }, { label: T.breakdown.colNote }],
          rows,
        },
      },
    ],
  };
}

/** 粗利 */
export function grossProfitSpec({ budget, cost, unit, label = T.breakdown.grossProfit, subtitle = null }) {
  return {
    title: fmt(T.breakdown.labelTitle, { label }),
    subtitle,
    formula: [T.breakdown.gpFormula],
    rows: [
      { label: T.breakdown.budget, value: money(budget, unit) },
      { label: T.breakdown.cost, value: money(cost, unit) },
      { label: T.breakdown.grossProfit, value: money(budget - cost, unit), emphasis: true, note: profitLabel(budget - cost) },
    ],
  };
}

/**
 * 粗利率。コアの Totals（aggregate の結果）があれば totals を渡す（値を再計算しない）。
 * Totals が無い場面（月ごと・見込み）は budget/cost から grossMarginOf() で求める。
 */
export function marginSpec({ totals = null, budget = totals?.budget, cost = totals?.cost, grossMargin = totals ? totals.grossMargin : grossMarginOf(budget, cost), unit, subtitle = null }) {
  const gp = totals ? totals.grossProfit : budget - cost;
  return {
    title: T.breakdown.marginTitle,
    subtitle,
    formula: [T.breakdown.marginFormula],
    rows: [
      { label: T.breakdown.budget, value: money(budget, unit) },
      { label: T.breakdown.cost, value: money(cost, unit) },
      { label: T.breakdown.grossProfit, value: money(gp, unit) },
      { label: T.breakdown.margin, value: formatPercent(grossMargin), emphasis: true, note: grossMargin === null ? T.breakdown.marginZero : null },
    ],
  };
}

/** 消化率（burnRateBreakdown） */
export function burnRateSpec({ totals, unit, threshold, asOfMonth, subtitle = null }) {
  const b = totals.burnRateBreakdown;
  const months = b.elapsedMonths;
  const span = months.length ? (months.length === 1 ? monthJa(months[0]) : `${monthJa(months[0])}〜${monthJa(months[months.length - 1])}`) : T.common.none;
  return {
    title: T.breakdown.burnTitle,
    subtitle,
    formula: [T.breakdown.burnFormula, fmt(T.breakdown.burnFormulaElapsed, { month: monthJa(asOfMonth) })],
    rows: [
      { label: T.breakdown.elapsed, value: fmt(T.breakdown.months, { n: months.length }), note: span },
      { label: T.breakdown.cumCost, value: money(b.cumulativeCost, unit) },
      { label: T.breakdown.cumBudget, value: money(b.cumulativeBudget, unit) },
      { label: T.breakdown.burnRate, value: formatPercent(totals.burnRate), emphasis: true, note: totals.burnRate === null ? T.breakdown.burnZero : null },
      { label: T.breakdown.threshold, value: fmt(T.breakdown.thresholdValue, { value: formatPercent(threshold) }), note: totals.isOverBudget ? T.breakdown.over : T.breakdown.within },
    ],
    note: T.breakdown.burnNote,
  };
}

/** 契約1件の着地見込み（ForecastBreakdown） */
export function forecastSpec({ forecast, contract, unit, config, model = null, subtitle = null }) {
  const b = forecast.breakdown;
  const method = forecast.method;
  const rows = [
    { label: T.breakdown.method, value: METHOD_LABELS[method] },
    { label: T.breakdown.targetPeriod, value: b.targetMonths.length ? periodJa({ from: b.targetMonths[0], to: b.targetMonths[b.targetMonths.length - 1] }) : EMPTY_VALUE },
    { label: T.breakdown.contractMonthsInTarget, value: fmt(T.breakdown.months, { n: b.contractMonthsInTarget.length }), note: b.contractMonthsInTarget.length ? `${b.contractMonthsInTarget[0]}〜${b.contractMonthsInTarget[b.contractMonthsInTarget.length - 1]}` : T.breakdown.notInTarget },
    { label: T.breakdown.actualMonths, value: fmt(T.breakdown.months, { n: b.actualMonths.length }), note: b.actualMonths.join(", ") || T.common.none },
    { label: T.breakdown.remainingMonths, value: fmt(T.breakdown.months, { n: b.remainingMonths.length }), note: b.remainingMonths.join(", ") || T.common.none },
    { label: T.breakdown.targetBudget, value: money(forecast.targetBudget, unit) },
    { label: T.breakdown.actualCostSum, value: money(b.actualCost, unit) },
  ];
  const formula = [T.breakdown.fcFormulaBudget, T.breakdown.fcFormulaCost, T.breakdown.fcFormulaGp];
  const sections = [];
  if (method === "assignment") {
    formula.splice(1, 0, T.breakdown.fcFormulaAssignment);
    rows.push({ label: T.breakdown.standardHours, value: `${config.standardHoursPerMonth}h` });
    rows.push({ label: T.breakdown.remainingCost, value: money(b.remainingCost, unit), note: b.noAssignments ? T.breakdown.noAssignments : null });
    if (b.assignmentLines.length) {
      sections.push({
        title: T.breakdown.assignmentDetails,
        table: {
          columns: [{ label: T.breakdown.colMonth }, { label: T.breakdown.colMember }, { label: T.breakdown.colAllocation, align: "num" }, { label: T.breakdown.colHours, align: "num" }, { label: T.breakdown.colRate, align: "num" }, { label: T.breakdown.colAmount, align: "num" }],
          rows: b.assignmentLines.map((l) => [l.month, model ? memberNameAt(model, l.memberId, l.month) : l.memberId, decimal(l.allocation, 2), formatHours(l.hours), money(l.hourlyRate, "yen"), money(l.amount, unit)]),
        },
      });
    }
  } else {
    const n = method === "recent3" ? fmt(T.breakdown.recentN, { n: config.forecastRecentMonths }) : T.breakdown.allMonths;
    formula.splice(1, 0, T.breakdown.fcFormulaAvg, fmt(T.breakdown.fcFormulaAvgBasis, { basis: n }));
    rows.push({ label: T.breakdown.averageBasis, value: fmt(T.breakdown.months, { n: b.averageBasisMonths.length }), note: b.averageBasisMonths.join(", ") || T.breakdown.noActual });
    rows.push({ label: T.breakdown.averageCost, value: money(Math.round(b.averageMonthlyCost), unit), note: b.noActuals ? T.breakdown.noActualZero : fmt(T.breakdown.exactYen, { value: decimal(b.averageMonthlyCost, 2) }) });
    rows.push({ label: T.breakdown.remainingCost, value: money(b.remainingCost, unit), note: fmt(T.breakdown.avgTimesMonths, { avg: money(Math.round(b.averageMonthlyCost), unit), n: b.remainingMonths.length }) });
  }
  rows.push({ label: T.breakdown.forecastCost, value: money(forecast.forecastCost, unit) });
  rows.push({ label: T.breakdown.forecastGp, value: money(forecast.forecastGrossProfit, unit), emphasis: true, note: forecast.isDeficit ? T.breakdown.deficitForecast : T.breakdown.surplusForecast });
  return {
    title: fmt(T.breakdown.forecastTitle, { customer: contract.customerName, project: contract.projectName }),
    subtitle,
    formula,
    rows,
    sections,
  };
}

/** 複数契約の着地見込み合計 */
export function forecastTotalsSpec({ model, totals, unit, contractIds, detailHref = null }) {
  const set = contractIds ? new Set(contractIds) : null;
  const rows = [];
  for (const r of model.contracts) {
    if (set && !set.has(r.contract.contractId)) continue;
    const f = r.forecasts[totals.method];
    if (f.breakdown.contractMonthsInTarget.length === 0) continue;
    rows.push([
      detailHref ? html`<a href=${detailHref(r.contract.contractId)}>${r.contract.customerName} / ${r.contract.projectName}</a>` : `${r.contract.customerName} / ${r.contract.projectName}`,
      `${r.contract.startMonth}〜${r.contract.endMonth}`,
      money(f.targetBudget, unit),
      money(f.breakdown.actualCost, unit),
      money(f.breakdown.remainingCost, unit),
      money(f.forecastGrossProfit, unit),
      f.isDeficit ? html`<span class="yn-chip yn-chip-danger"><span class="yn-chip-icon" aria-hidden="true">▲</span>${T.common.deficit}</span>` : T.common.surplus,
    ]);
  }
  return {
    title: fmt(T.breakdown.forecastTotalsTitle, { period: totals.period ? periodJa(totals.period) : `FY${totals.fiscalYear}`, method: METHOD_LABELS[totals.method] }),
    formula: [T.breakdown.fcTotalsFormula, T.breakdown.fcTotalsFormulaSum],
    rows: [
      { label: T.breakdown.targetContractsPeriod, value: fmt(T.breakdown.count, { n: rows.length }) },
      { label: T.breakdown.targetBudget, value: money(totals.targetBudget, unit) },
      { label: T.breakdown.forecastCost, value: money(totals.forecastCost, unit) },
      { label: T.breakdown.forecastGpLong, value: money(totals.forecastGrossProfit, unit), emphasis: true },
      { label: T.breakdown.deficitContracts, value: fmt(T.breakdown.count, { n: totals.deficitContractIds.length }), note: totals.deficitContractIds.join(", ") || null },
    ],
    sections: [
      {
        title: T.breakdown.byContract,
        table: {
          columns: [{ label: T.breakdown.colContract }, { label: T.breakdown.colContractPeriod }, { label: T.breakdown.targetBudget, align: "num" }, { label: T.breakdown.actualCost, align: "num" }, { label: T.breakdown.remainingCost, align: "num" }, { label: T.breakdown.forecastGp, align: "num" }, { label: T.breakdown.judgement }],
          rows,
        },
      },
    ],
  };
}

/** 作業時間・人月 */
export function hoursSpec({ totals, config, subtitle = null }) {
  return {
    title: T.breakdown.hoursTitle,
    subtitle,
    formula: [fmt(T.breakdown.pmStdFormula, { hours: config.standardHoursPerMonth }), fmt(T.breakdown.pmCalFormula, { hours: config.hoursPerBusinessDay })],
    rows: [
      { label: T.breakdown.workHours, value: formatHours(totals.hours) },
      { label: T.breakdown.pmStd, value: fmt(T.breakdown.personMonths, { value: decimal(totals.personMonthsStandard, 2) }) },
      { label: T.breakdown.pmCal, value: fmt(T.breakdown.personMonths, { value: decimal(totals.personMonthsCalendar, 2) }) },
    ],
  };
}

// ---------------------------------------------------------------------------
// メンバー別（SPEC §18）: 計画 = 配分 × 基準時間 × 単価、実績 = 原価行（CostLine）
// months はそのメンバーの MemberMonth（期間で絞ったもの）。contractIds を渡すとその契約の行だけ
// ---------------------------------------------------------------------------

/** メンバー 1 人の金額は小さいので、百万円表示（"m"）のときは根拠パネルを円で出す */
function memberUnit(unit) {
  return unit === "m" ? "yen" : unit;
}

function contractLabelOf(model, contractId) {
  const r = model?.contracts?.find((x) => x.contract.contractId === contractId);
  return r ? `${r.contract.customerName} / ${r.contract.projectName}` : "";
}

function rateSourceText(mm) {
  if (mm.rateMissing) return html`<span class="yn-chip yn-chip-neutral"><span class="yn-chip-icon" aria-hidden="true">○</span>${T.breakdown.rateMissingZero2}</span>`;
  if (!mm.rateSource) return "—";
  const personal = mm.rateSource.key === mm.memberId;
  return fmt(T.breakdown.rateSourceText, { source: personal ? T.breakdown.personalRate : fmt(T.breakdown.roleRate, { role: mm.rateSource.key }), from: mm.rateSource.effectiveFrom });
}

/** 月 × 契約の行。contractIds を渡せばその行だけ（契約外の行 ID も可）。渡さなければ契約の行 ＋ includeOutside なら契約外の行（§50.3） */
function memberRows(months, contractIds, includeOutside = false) {
  const set = contractIds ? new Set(contractIds) : null;
  const out = [];
  for (const mm of months)
    for (const row of mm.byContract) {
      const outside = typeof row.outsideType === "string";
      if (set ? set.has(row.contractId) : !outside || includeOutside) out.push({ mm, row });
    }
  return out;
}

/** 契約外の行の名前（「契約外: 提案」。種別なしは「契約外予定」） */
export function outsideRowLabel(type) {
  return type ? fmt(T.breakdown.outsideRow, { type }) : T.masterFiles.outside;
}

function contractCell(model, contractId, contractHref, row = null) {
  if (row && typeof row.outsideType === "string") return outsideRowLabel(row.outsideType);
  const label = contractLabelOf(model, contractId) || contractId;
  return contractHref ? html`<a href=${contractHref(contractId)}>${label}</a>` : label;
}

/** 計画（時間・原価）の根拠: 契約×月ごとに 配分 × 基準時間 × 単価 */
export function memberPlanSpec({ model, member, months, contractIds = null, includeOutside = false, unit, measure = "cost", subtitle = null, contractHref = null }) {
  unit = memberUnit(unit);
  const rows = memberRows(months, contractIds, includeOutside).filter(({ row }) => row.assignmentCount > 0);
  const std = months[0]?.standardHoursPerMonth ?? model?.config?.standardHoursPerMonth ?? 0;
  const hours = rows.reduce((s, { row }) => s + row.plannedHours, 0);
  const cost = rows.reduce((s, { row }) => s + row.plannedCost, 0);
  const missing = rows.some(({ mm }) => mm.rateMissing);
  const label = measure === "hours" ? T.breakdown.plannedHours : T.breakdown.plannedCost;
  return {
    title: fmt(T.breakdown.memberTitle, { label, name: member.memberName, id: member.memberId }),
    subtitle,
    formula: [fmt(T.breakdown.planHoursFormula, { hours: std }), T.breakdown.planCostFormula, fmt(T.breakdown.planSumFormula, { label, label2: label })],
    rows: [
      { label: T.breakdown.assignmentRows, value: fmt(T.breakdown.count, { n: rows.length }) },
      { label: T.breakdown.baseHours, value: `${std}h` },
      { label: T.breakdown.plannedHours, value: formatHours(hours), emphasis: measure === "hours" },
      { label: T.breakdown.plannedCost, value: money(cost, unit), emphasis: measure !== "hours", note: missing ? T.breakdown.rateMissingZero : null },
    ],
    sections: [
      rows.length
        ? {
            title: T.breakdown.planByContractMonth,
            table: {
              columns: [{ label: T.breakdown.colMonth }, { label: T.breakdown.colContract }, { label: T.breakdown.colAllocation, align: "num" }, { label: T.breakdown.plannedHours, align: "num" }, { label: T.breakdown.colRate, align: "num" }, { label: T.breakdown.colRateSource }, { label: T.breakdown.plannedCost, align: "num" }],
              rows: rows.map(({ mm, row }) => [monthJa(mm.month), contractCell(model, row.contractId, contractHref, row), decimal(row.allocation, 3), formatHours(row.plannedHours), money(mm.hourlyRate, "yen"), rateSourceText(mm), money(row.plannedCost, unit)]),
              foot: [T.breakdown.total, "", "", formatHours(hours), "", "", money(cost, unit)],
            },
          }
        : { title: T.breakdown.planByContractMonth, text: T.breakdown.noAssignmentsInRange },
    ],
    note: T.breakdown.allocationNote,
  };
}

/** 実績（時間・原価）の根拠: 契約×月ごとの原価行 → 元の作業ログ */
export function memberActualSpec({ model, member, months, contractIds = null, includeOutside = false, unit, measure = "cost", subtitle = null, contractHref = null }) {
  unit = memberUnit(unit);
  const rows = memberRows(months, contractIds, includeOutside).filter(({ row }) => row.actualHours > 0 || row.actualCost !== 0);
  const hours = rows.reduce((s, { row }) => s + row.actualHours, 0);
  const cost = rows.reduce((s, { row }) => s + row.actualCost, 0);
  const unplannedHours = rows.filter(({ row }) => row.assignmentCount === 0).reduce((s, { row }) => s + row.actualHours, 0);
  const label = measure === "hours" ? T.breakdown.actualHours : T.breakdown.actualCost;
  // 作業ログの明細は契約ごとのファイル（契約外の作業ログは配っていない）
  const ids = [...new Set(rows.filter(({ row }) => typeof row.outsideType !== "string").map(({ row }) => row.contractId))];
  const monthSet = new Set(rows.map(({ mm }) => mm.month));
  const sections = [
    rows.length
      ? {
          title: T.breakdown.costLinesByContractMonth,
          table: {
            columns: [{ label: T.breakdown.colMonth }, { label: T.breakdown.colContract }, { label: T.breakdown.colHours, align: "num" }, { label: T.breakdown.colRate, align: "num" }, { label: T.breakdown.colRateSource }, { label: T.breakdown.cost, align: "num" }, { label: T.breakdown.colAssignment }],
            rows: rows.map(({ mm, row }) => [monthJa(mm.month), contractCell(model, row.contractId, contractHref, row), formatHours(row.actualHours), money(mm.hourlyRate, "yen"), rateSourceText(mm), money(row.actualCost, unit), row.assignmentCount > 0 ? T.breakdown.present : T.common.none]),
            foot: [T.breakdown.total, "", formatHours(hours), "", "", money(cost, unit), ""],
          },
        }
      : { title: T.breakdown.costLinesByContractMonth, text: T.breakdown.noWorklogsInRange },
  ];
  if (ids.length) {
    sections.push({
      title: T.breakdown.worklogs,
      lazyLabel: T.breakdown.loadWorklogs,
      lazy: async () => {
        const all = [];
        for (const id of ids) {
          const data = await fetchWorklogs(id);
          for (const m of data.months) if (monthSet.has(m.month)) for (const w of m.worklogs) if (w.memberId === member.memberId) all.push(w);
        }
        all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        if (all.length === 0) return html`<p class="yn-note">${T.breakdown.noWorklogs}</p>`;
        return html`<div><p class="yn-note">${T.breakdown.worklogRoundingNote}</p>${worklogTable(all, { unit })}</div>`;
      },
    });
  }
  return {
    title: fmt(T.breakdown.memberTitle, { label, name: member.memberName, id: member.memberId }),
    subtitle,
    formula: [T.breakdown.actualCostFormula, fmt(T.breakdown.planSumFormula, { label, label2: label })],
    rows: [
      { label: T.breakdown.costLinesContractMonth, value: fmt(T.breakdown.count, { n: rows.length }) },
      { label: T.breakdown.actualHours, value: formatHours(hours), emphasis: measure === "hours" },
      { label: T.breakdown.unplannedPart, value: formatHours(unplannedHours), note: unplannedHours > 0 ? T.breakdown.unplannedNote : null },
      { label: T.breakdown.actualCost, value: money(cost, unit), emphasis: measure !== "hours" },
    ],
    sections,
  };
}

/** 差額 = 計画原価 − 実績原価 */
export function memberVarianceSpec({ plannedCost, actualCost, unit, subtitle = null }) {
  unit = memberUnit(unit);
  const v = plannedCost - actualCost;
  return {
    title: T.breakdown.varianceTitle,
    subtitle,
    formula: [T.breakdown.varianceFormula],
    rows: [
      { label: T.breakdown.plannedCost, value: money(plannedCost, unit) },
      { label: T.breakdown.actualCost, value: money(actualCost, unit) },
      { label: T.breakdown.variance, value: money(v, unit), emphasis: true, note: v > 0 ? T.format.varianceLess : v < 0 ? T.format.varianceMore : T.format.varianceEven },
    ],
    note: T.breakdown.varianceNote,
  };
}

/** 稼働率 = 実績時間 ÷ 計画時間 */
export function memberUtilizationSpec({ plannedHours, actualHours, utilization, unplannedHours = 0, subtitle = null }) {
  return {
    title: T.breakdown.utilTitle,
    subtitle,
    formula: [T.breakdown.utilFormula],
    rows: [
      { label: T.breakdown.actualHours, value: formatHours(actualHours), note: unplannedHours > 0 ? fmt(T.breakdown.utilUnplanned, { hours: formatHours(unplannedHours) }) : null },
      { label: T.breakdown.plannedHours, value: formatHours(plannedHours) },
      { label: T.breakdown.utilization, value: formatPercent(utilization), emphasis: true, note: utilization === null ? T.breakdown.utilZero : null },
    ],
    note: T.breakdown.utilNote,
  };
}

const MEMBER_MEASURES = {
  plannedHours: { label: T.breakdown.plannedHours, hours: true, formula: T.breakdown.sumPlanHours },
  actualHours: { label: T.breakdown.actualHours, hours: true, formula: T.breakdown.sumActualHours },
  plannedCost: { label: T.breakdown.plannedCost, formula: T.breakdown.sumPlanCost },
  actualCost: { label: T.breakdown.actualCost, formula: T.breakdown.sumActualCost },
  variance: { label: T.breakdown.variance, formula: T.breakdown.sumVariance },
  utilization: { label: T.breakdown.utilization, percent: true, formula: T.breakdown.sumUtil },
};

/** メンバー一覧の合計行（表示中のメンバー。total は aggregateMembers の total） */
export function memberTotalsSpec({ members, total, measure, unit, period }) {
  unit = memberUnit(unit);
  const d = MEMBER_MEASURES[measure];
  const fmtValue = (v) => (d.hours ? formatHours(v) : d.percent ? formatPercent(v) : money(v, unit));
  const parts =
    measure === "utilization"
      ? [{ label: T.breakdown.actualHours, value: formatHours(total.actualHours) }, { label: T.breakdown.plannedHours, value: formatHours(total.plannedHours) }]
      : measure === "variance"
        ? [{ label: T.breakdown.plannedCost, value: money(total.plannedCost, unit) }, { label: T.breakdown.actualCost, value: money(total.actualCost, unit) }]
        : [];
  return {
    title: fmt(T.breakdown.membersTotalTitle, { label: d.label }),
    subtitle: periodJa(period),
    formula: [d.formula],
    rows: [{ label: T.breakdown.targetMembers, value: fmt(T.breakdown.people, { n: members.length }) }, ...parts, { label: fmt(T.breakdown.labelSum, { label: d.label }), value: fmtValue(total[measure]), emphasis: true }],
    sections: [
      {
        title: T.breakdown.byMember,
        table: { columns: [{ label: T.breakdown.colMember }, { label: d.label, align: "num" }], rows: members.map((m) => [m.memberName, fmtValue(m[measure])]) },
      },
    ],
  };
}
