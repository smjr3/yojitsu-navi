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
import { EMPTY_VALUE, STATUS_LABELS, METHOD_LABELS, decimal, formatHours, formatPercent, integer, money as moneyInUnit, monthJa, periodJa, profitLabel } from "./format.js";
import { grossMarginOf } from "./analysis.js";

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
        <button type="button" class="yn-btn yn-btn-icon yn-dialog-close" aria-label="閉じる">×</button>
      </header>
      <div class="yn-dialog-body"></div>
      <footer class="yn-dialog-foot"><span class="yn-dialog-hint">Esc で閉じる</span><button type="button" class="yn-btn yn-dialog-close2">閉じる</button></footer>
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
    const btn = html`<button type="button" class="yn-btn yn-btn-sm">${section.lazyLabel ?? "明細を読み込む"}</button>`;
    const holder = html`<div class="yn-bd-lazy"></div>`;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "読み込み中…";
      try {
        const content = await section.lazy();
        holder.replaceChildren(content);
        btn.remove();
      } catch (error) {
        holder.replaceChildren(html`<p class="yn-note yn-note-danger" role="alert">明細を読み込めませんでした: ${error?.message ?? String(error)}</p>`);
        btn.disabled = false;
        btn.textContent = section.lazyLabel ?? "明細を読み込む";
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
    ${formulas.length ? html`<div class="yn-bd-formula" aria-label="計算式">${formulas.map((f) => html`<code>${f}</code>`)}</div>` : null}
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
  dialog.querySelector("#yn-dialog-title").textContent = resolved.title ?? "計算根拠";
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
export function numberButton(text, spec, { className = "", ariaLabel = null, title = "計算根拠を表示" } = {}) {
  const btn = html`<button type="button" class=${`yn-num ${className}`.trim()} title=${title} aria-label=${ariaLabel}>${text}</button>`;
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
    const file = `data/worklogs/${encodeURIComponent(contractId)}.json`;
    // ビルド済みサイトでは dynamicPaths により /data/worklogs/<id>.json に置かれる。
    // 開発プレビュー（npm run dev）では /_file/data/worklogs/<id>.json で配信されるので順に試す。
    const candidates = [new URL(`../../${file}`, import.meta.url), new URL(`../../_file/${file}`, import.meta.url)];
    const p = (async () => {
      let lastStatus = 0;
      for (const url of candidates) {
        const res = await fetch(url);
        if (res.ok) return res.json();
        lastStatus = res.status;
        if (res.status !== 404) break;
      }
      throw new Error(`作業ログ明細の取得に失敗しました（HTTP ${lastStatus}）`);
    })();
    p.catch(() => worklogCache.delete(contractId));
    worklogCache.set(contractId, p);
  }
  return worklogCache.get(contractId);
}

/** 作業ログ明細の表 */
export function worklogTable(entries, { unit = "yen", limit = 500 } = {}) {
  const rows = entries.slice(0, limit).map((w) => [w.date, `${w.memberName}（${w.memberId}）`, w.task, formatHours(w.hours), money(w.hourlyRate, "yen"), money(w.amount, unit)]);
  const total = entries.reduce((s, w) => s + w.amount, 0);
  const hours = entries.reduce((s, w) => s + w.hours, 0);
  const more = entries.length > limit ? html`<p class="yn-note">先頭 ${integer(limit)} 件を表示（全 ${integer(entries.length)} 件）</p>` : null;
  return html`<div>${renderTable({
    columns: [{ label: "日付" }, { label: "メンバー" }, { label: "作業内容" }, { label: "時間", align: "num" }, { label: "単価", align: "num" }, { label: "金額", align: "num" }],
    rows,
    foot: ["合計", `${integer(entries.length)} 件`, "", formatHours(hours), "", money(total, unit)],
  })}${more}</div>`;
}

// ---------------------------------------------------------------------------
// 内訳 spec の組み立て（計算コアの breakdown を人が読める形に）
// ---------------------------------------------------------------------------

/** 契約×月の予算（BudgetBreakdown） */
export function budgetMonthSpec({ contract, cm, unit }) {
  const b = cm.budgetBreakdown;
  return {
    title: `予算の計算根拠 — ${contract.customerName} / ${contract.projectName}（${monthJa(cm.month)}）`,
    formula: ["基本額 = floor(契約総額 ÷ 契約月数)", "端数 = 契約総額 − 基本額 × 契約月数", "月の予算 = 基本額（最終月は 基本額 + 端数）"],
    rows: [
      { label: "契約総額", value: money(b.totalAmount, unit) },
      { label: "契約月数", value: `${b.monthCount}か月`, note: `${contract.startMonth}〜${contract.endMonth}` },
      { label: "基本額", value: money(b.baseMonthly, unit) },
      { label: "端数（最終月に加算）", value: money(b.remainder, unit) },
      { label: "この月は最終月か", value: b.isLastMonth ? "はい" : "いいえ" },
      { label: `${monthJa(cm.month)} の予算`, value: money(cm.budget, unit), emphasis: true },
    ],
  };
}

/** 期間・契約範囲の予算合計 */
export function budgetAggregateSpec({ model, contractIds, period, unit, label = "予算" }) {
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
      r.contract.contractId,
      `${r.contract.customerName} / ${r.contract.projectName}`,
      money(r.contract.totalAmount, unit),
      `${b.monthCount}`,
      money(b.baseMonthly, unit),
      `${months.length}`,
      money(sum, unit),
    ]);
  }
  return {
    title: `${label}の計算根拠（${periodJa(period)}）`,
    formula: ["契約ごとの月予算 = floor(契約総額 ÷ 契約月数)（最終月に端数を加算）", `${label} = Σ 期間内の月予算`],
    rows: [
      { label: "対象契約", value: `${rows.length}件` },
      { label: `${label}合計`, value: money(total, unit), emphasis: true },
    ],
    sections: [
      {
        title: "契約ごとの内訳",
        table: {
          columns: [{ label: "契約ID" }, { label: "顧客 / 案件" }, { label: "契約総額", align: "num" }, { label: "契約月数", align: "num" }, { label: "月予算（基本額）", align: "num" }, { label: "期間内の月数", align: "num" }, { label: "期間内の予算", align: "num" }],
          rows,
        },
      },
    ],
    note: "端数は契約の最終月に加算されるため、最終月を含む期間は基本額 × 月数と一致しないことがあります。",
  };
}

/** 契約×月の原価（CostLine → 作業ログ） */
export function costMonthSpec({ contract, cm, unit, model }) {
  const lines = cm.costLines.map((l) => [
    `${l.memberName}（${l.memberId}）`,
    l.memberTeamId ? (model?.teamTree?.[l.memberTeamId]?.name ?? l.memberTeamId) : "—",
    formatHours(l.hours),
    l.rateMissing ? html`<span class="yn-chip yn-chip-danger"><span class="yn-chip-icon" aria-hidden="true">▲</span>単価なし</span>` : money(l.hourlyRate, "yen"),
    l.rateSource ? `${l.rateSource.key}（${l.rateSource.effectiveFrom}〜）` : "—",
    money(l.amount, unit),
  ]);
  return {
    title: `原価の計算根拠 — ${contract.customerName} / ${contract.projectName}（${monthJa(cm.month)}）`,
    subtitle: `状態: ${STATUS_LABELS[cm.status]}`,
    formula: ["メンバーごとの原価 = round(作業時間 × その月に有効な時間単価)", "月の原価 = Σ メンバーごとの原価"],
    rows: [
      { label: "作業時間", value: formatHours(cm.hours) },
      { label: "原価行の数", value: `${cm.costLines.length}` },
      { label: `${monthJa(cm.month)} の原価`, value: money(cm.cost, unit), emphasis: true },
    ],
    sections: [
      {
        title: "メンバーごとの原価行",
        table: {
          columns: [{ label: "メンバー" }, { label: "当時の所属" }, { label: "時間", align: "num" }, { label: "単価", align: "num" }, { label: "単価の出どころ" }, { label: "金額", align: "num" }],
          rows: lines,
        },
      },
      {
        title: "元の作業ログ",
        lazyLabel: "作業ログを読み込む",
        lazy: async () => {
          const data = await fetchWorklogs(contract.contractId);
          const month = data.months.find((m) => m.month === cm.month);
          const entries = month?.worklogs ?? [];
          if (entries.length === 0) return html`<p class="yn-note">この月の作業ログはありません。</p>`;
          return worklogTable(entries, { unit });
        },
      },
    ],
  };
}

/** 期間・契約範囲の原価合計 */
export function costAggregateSpec({ model, contractIds, period, unit, label = "原価", detailHref = null }) {
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
      detailHref ? html`<a href=${detailHref(r.contract.contractId)}>${r.contract.contractId}</a>` : r.contract.contractId,
      `${r.contract.customerName} / ${r.contract.projectName}`,
      `${months.length}`,
      formatHours(h),
      money(sum, unit),
      missing ? "単価なしの行を含む" : "",
    ]);
  }
  return {
    title: `${label}の計算根拠（${periodJa(period)}）`,
    formula: ["メンバー×月ごとの原価 = round(作業時間 × その月に有効な時間単価)", `${label} = Σ 期間内の原価`],
    rows: [
      { label: "対象契約", value: `${rows.length}件` },
      { label: "作業時間", value: formatHours(hours) },
      { label: `${label}合計`, value: money(total, unit), emphasis: true },
    ],
    sections: [
      {
        title: "契約ごとの内訳",
        text: "契約IDを開くと月・メンバーごとの原価行と元の作業ログまで辿れます。",
        table: {
          columns: [{ label: "契約ID" }, { label: "顧客 / 案件" }, { label: "期間内の月数", align: "num" }, { label: "時間", align: "num" }, { label: "原価", align: "num" }, { label: "注記" }],
          rows,
        },
      },
    ],
  };
}

/** 粗利 */
export function grossProfitSpec({ budget, cost, unit, label = "粗利", subtitle = null }) {
  return {
    title: `${label}の計算根拠`,
    subtitle,
    formula: ["粗利 = 予算 − 原価"],
    rows: [
      { label: "予算", value: money(budget, unit) },
      { label: "原価", value: money(cost, unit) },
      { label: "粗利", value: money(budget - cost, unit), emphasis: true, note: profitLabel(budget - cost) },
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
    title: "粗利率の計算根拠",
    subtitle,
    formula: ["粗利率 = 粗利 ÷ 予算 = (予算 − 原価) ÷ 予算"],
    rows: [
      { label: "予算", value: money(budget, unit) },
      { label: "原価", value: money(cost, unit) },
      { label: "粗利", value: money(gp, unit) },
      { label: "粗利率", value: formatPercent(grossMargin), emphasis: true, note: grossMargin === null ? "予算が 0 のため計算できません" : null },
    ],
  };
}

/** 消化率（burnRateBreakdown） */
export function burnRateSpec({ totals, unit, threshold, asOfMonth, subtitle = null }) {
  const b = totals.burnRateBreakdown;
  const months = b.elapsedMonths;
  const span = months.length ? (months.length === 1 ? monthJa(months[0]) : `${monthJa(months[0])}〜${monthJa(months[months.length - 1])}`) : "なし";
  return {
    title: "消化率の計算根拠",
    subtitle,
    formula: ["消化率 = 経過月の累計原価 ÷ 経過月の累計予算", `経過月 = 期間内で ${monthJa(asOfMonth)}（基準月）以前の月`],
    rows: [
      { label: "経過月", value: `${months.length}か月`, note: span },
      { label: "累計原価（経過月）", value: money(b.cumulativeCost, unit) },
      { label: "累計予算（経過月）", value: money(b.cumulativeBudget, unit) },
      { label: "消化率", value: formatPercent(totals.burnRate), emphasis: true, note: totals.burnRate === null ? "累計予算が 0 のため計算できません" : null },
      { label: "赤の基準", value: `${formatPercent(threshold)} 超`, note: totals.isOverBudget ? "超過しています" : "範囲内です" },
    ],
    note: "基準月（速報）も経過月に含みます。速報月の原価は確定日まで増える可能性があります。",
  };
}

/** 契約1件の着地見込み（ForecastBreakdown） */
export function forecastSpec({ forecast, contract, unit, config, subtitle = null }) {
  const b = forecast.breakdown;
  const method = forecast.method;
  const rows = [
    { label: "方式", value: METHOD_LABELS[method] },
    { label: "対象年度", value: `FY${forecast.fiscalYear}`, note: `${b.fiscalYearMonths[0]}〜${b.fiscalYearMonths[b.fiscalYearMonths.length - 1]}` },
    { label: "年度内の契約月", value: `${b.contractMonthsInFY.length}か月`, note: b.contractMonthsInFY.length ? `${b.contractMonthsInFY[0]}〜${b.contractMonthsInFY[b.contractMonthsInFY.length - 1]}` : "年度に掛からない契約" },
    { label: "実績月（完了した月）", value: `${b.actualMonths.length}か月`, note: b.actualMonths.join(", ") || "なし" },
    { label: "残り月（基準月を含む）", value: `${b.remainingMonths.length}か月`, note: b.remainingMonths.join(", ") || "なし" },
    { label: "年度予算", value: money(forecast.fyBudget, unit) },
    { label: "実績原価（実績月の合計）", value: money(b.actualCost, unit) },
  ];
  const formula = ["年度予算 = Σ 年度内の契約月の予算", "着地原価 = 実績原価 + 残り原価", "着地粗利 = 年度予算 − 着地原価"];
  const sections = [];
  if (method === "assignment") {
    formula.splice(1, 0, "残り原価 = Σ(残り月 × アサイン: 配分 × 標準時間 × 単価)");
    rows.push({ label: "標準時間（1人月）", value: `${config.standardHoursPerMonth}h` });
    rows.push({ label: "残り原価", value: money(b.remainingCost, unit), note: b.noAssignments ? "アサインが 1 件もありません（残り原価 0）" : null });
    if (b.assignmentLines.length) {
      sections.push({
        title: "残り月のアサイン明細",
        table: {
          columns: [{ label: "月" }, { label: "メンバー" }, { label: "配分", align: "num" }, { label: "時間", align: "num" }, { label: "単価", align: "num" }, { label: "金額", align: "num" }],
          rows: b.assignmentLines.map((l) => [l.month, l.memberId, decimal(l.allocation, 2), formatHours(l.hours), money(l.hourlyRate, "yen"), money(l.amount, unit)]),
        },
      });
    }
  } else {
    const n = method === "recent3" ? `直近 ${config.forecastRecentMonths} か月` : "契約開始からの全月";
    formula.splice(1, 0, `残り原価 = round(平均月次原価 × 残り月数)`, `平均月次原価 = ${n}（基準月より前）の原価平均`);
    rows.push({ label: "平均の基礎にした月", value: `${b.averageBasisMonths.length}か月`, note: b.averageBasisMonths.join(", ") || "実績なし" });
    rows.push({ label: "平均月次原価", value: money(Math.round(b.averageMonthlyCost), unit), note: b.noActuals ? "実績が無いため 0 として扱います" : `正確には ${decimal(b.averageMonthlyCost, 2)} 円` });
    rows.push({ label: "残り原価", value: money(b.remainingCost, unit), note: `${money(Math.round(b.averageMonthlyCost), unit)} × ${b.remainingMonths.length}か月` });
  }
  rows.push({ label: "着地原価", value: money(forecast.forecastCost, unit) });
  rows.push({ label: "着地粗利", value: money(forecast.forecastGrossProfit, unit), emphasis: true, note: forecast.isDeficit ? "赤字見込み" : "黒字見込み" });
  return {
    title: `着地見込みの計算根拠 — ${contract.customerName} / ${contract.projectName}`,
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
    if (f.breakdown.contractMonthsInFY.length === 0) continue;
    rows.push([
      detailHref ? html`<a href=${detailHref(r.contract.contractId)}>${r.contract.contractId}</a>` : r.contract.contractId,
      `${r.contract.customerName} / ${r.contract.projectName}`,
      money(f.fyBudget, unit),
      money(f.breakdown.actualCost, unit),
      money(f.breakdown.remainingCost, unit),
      money(f.forecastGrossProfit, unit),
      f.isDeficit ? html`<span class="yn-chip yn-chip-danger"><span class="yn-chip-icon" aria-hidden="true">▲</span>赤字</span>` : "黒字",
    ]);
  }
  return {
    title: `着地見込み粗利の計算根拠（FY${totals.fiscalYear}・${METHOD_LABELS[totals.method]}）`,
    formula: ["契約ごとに 着地粗利 = 年度予算 − (実績原価 + 残り原価)", "合計 = Σ 契約ごとの着地粗利"],
    rows: [
      { label: "対象契約（年度に掛かるもの）", value: `${rows.length}件` },
      { label: "年度予算", value: money(totals.fyBudget, unit) },
      { label: "着地原価", value: money(totals.forecastCost, unit) },
      { label: "着地見込み粗利", value: money(totals.forecastGrossProfit, unit), emphasis: true },
      { label: "赤字見込みの契約", value: `${totals.deficitContractIds.length}件`, note: totals.deficitContractIds.join(", ") || null },
    ],
    sections: [
      {
        title: "契約ごとの内訳",
        table: {
          columns: [{ label: "契約ID" }, { label: "顧客 / 案件" }, { label: "年度予算", align: "num" }, { label: "実績原価", align: "num" }, { label: "残り原価", align: "num" }, { label: "着地粗利", align: "num" }, { label: "判定" }],
          rows,
        },
      },
    ],
  };
}

/** 作業時間・人月 */
export function hoursSpec({ totals, config, subtitle = null }) {
  return {
    title: "作業時間と人月換算",
    subtitle,
    formula: [`人月（標準）= 作業時間 ÷ ${config.standardHoursPerMonth}h`, `人月（カレンダー）= Σ 月ごとの 作業時間 ÷ (営業日数 × ${config.hoursPerBusinessDay}h)`],
    rows: [
      { label: "作業時間", value: formatHours(totals.hours) },
      { label: "人月（標準）", value: `${decimal(totals.personMonthsStandard, 2)}人月` },
      { label: "人月（カレンダー）", value: `${decimal(totals.personMonthsCalendar, 2)}人月` },
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
  if (mm.rateMissing) return html`<span class="yn-chip yn-chip-neutral"><span class="yn-chip-icon" aria-hidden="true">○</span>単価なし（0円）</span>`;
  if (!mm.rateSource) return "—";
  const personal = mm.rateSource.key === mm.memberId;
  return `${personal ? "個人単価" : `役職「${mm.rateSource.key}」`}（${mm.rateSource.effectiveFrom}〜）`;
}

function memberRows(months, contractIds) {
  const set = contractIds ? new Set(contractIds) : null;
  const out = [];
  for (const mm of months) for (const row of mm.byContract) if (!set || set.has(row.contractId)) out.push({ mm, row });
  return out;
}

function contractCell(model, contractId, contractHref) {
  return html`${contractHref ? html`<a href=${contractHref(contractId)}>${contractId}</a>` : contractId} <span class="yn-muted">${contractLabelOf(model, contractId)}</span>`;
}

/** 計画（時間・原価）の根拠: 契約×月ごとに 配分 × 基準時間 × 単価 */
export function memberPlanSpec({ model, member, months, contractIds = null, unit, measure = "cost", subtitle = null, contractHref = null }) {
  unit = memberUnit(unit);
  const rows = memberRows(months, contractIds).filter(({ row }) => row.assignmentCount > 0);
  const std = months[0]?.standardHoursPerMonth ?? model?.config?.standardHoursPerMonth ?? 0;
  const hours = rows.reduce((s, { row }) => s + row.plannedHours, 0);
  const cost = rows.reduce((s, { row }) => s + row.plannedCost, 0);
  const missing = rows.some(({ mm }) => mm.rateMissing);
  const label = measure === "hours" ? "計画時間" : "計画原価";
  return {
    title: `${label}の計算根拠 — ${member.memberName}（${member.memberId}）`,
    subtitle,
    formula: [`計画時間 = 配分人月 × 基準時間（${std}h）`, "計画原価 = round(計画時間 × その月の時間単価)（契約・月ごとに円に丸める）", `${label} = Σ 契約・月ごとの${label}`],
    rows: [
      { label: "アサインの行（契約×月）", value: `${rows.length}件` },
      { label: "基準時間（1人月）", value: `${std}h` },
      { label: "計画時間", value: formatHours(hours), emphasis: measure === "hours" },
      { label: "計画原価", value: money(cost, unit), emphasis: measure !== "hours", note: missing ? "単価が見つからない月は 0 円で計算しています" : null },
    ],
    sections: [
      rows.length
        ? {
            title: "契約・月ごとの計画",
            table: {
              columns: [{ label: "月" }, { label: "契約" }, { label: "配分", align: "num" }, { label: "計画時間", align: "num" }, { label: "単価", align: "num" }, { label: "単価の出どころ" }, { label: "計画原価", align: "num" }],
              rows: rows.map(({ mm, row }) => [monthJa(mm.month), contractCell(model, row.contractId, contractHref), decimal(row.allocation, 3), formatHours(row.plannedHours), money(mm.hourlyRate, "yen"), rateSourceText(mm), money(row.plannedCost, unit)]),
              foot: ["合計", "", "", formatHours(hours), "", "", money(cost, unit)],
            },
          }
        : { title: "契約・月ごとの計画", text: "この範囲にアサインはありません（計画 0）。" },
    ],
    note: "配分は assignments.csv の allocation（同じ契約・月に複数行あれば合計）。契約期間外の月のアサインは数えません。",
  };
}

/** 実績（時間・原価）の根拠: 契約×月ごとの原価行 → 元の作業ログ */
export function memberActualSpec({ model, member, months, contractIds = null, unit, measure = "cost", subtitle = null, contractHref = null }) {
  unit = memberUnit(unit);
  const rows = memberRows(months, contractIds).filter(({ row }) => row.actualHours > 0 || row.actualCost !== 0);
  const hours = rows.reduce((s, { row }) => s + row.actualHours, 0);
  const cost = rows.reduce((s, { row }) => s + row.actualCost, 0);
  const unplannedHours = rows.filter(({ row }) => row.assignmentCount === 0).reduce((s, { row }) => s + row.actualHours, 0);
  const label = measure === "hours" ? "実績時間" : "実績原価";
  const ids = [...new Set(rows.map(({ row }) => row.contractId))];
  const monthSet = new Set(rows.map(({ mm }) => mm.month));
  const sections = [
    rows.length
      ? {
          title: "契約・月ごとの原価行",
          table: {
            columns: [{ label: "月" }, { label: "契約" }, { label: "時間", align: "num" }, { label: "単価", align: "num" }, { label: "単価の出どころ" }, { label: "原価", align: "num" }, { label: "アサイン" }],
            rows: rows.map(({ mm, row }) => [monthJa(mm.month), contractCell(model, row.contractId, contractHref), formatHours(row.actualHours), money(mm.hourlyRate, "yen"), rateSourceText(mm), money(row.actualCost, unit), row.assignmentCount > 0 ? "あり" : "なし"]),
            foot: ["合計", "", formatHours(hours), "", "", money(cost, unit), ""],
          },
        }
      : { title: "契約・月ごとの原価行", text: "この範囲に作業実績はありません。" },
  ];
  if (rows.length) {
    sections.push({
      title: "元の作業ログ",
      lazyLabel: "作業ログを読み込む",
      lazy: async () => {
        const all = [];
        for (const id of ids) {
          const data = await fetchWorklogs(id);
          for (const m of data.months) if (monthSet.has(m.month)) for (const w of m.worklogs) if (w.memberId === member.memberId) all.push(w);
        }
        all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        if (all.length === 0) return html`<p class="yn-note">作業ログはありません。</p>`;
        return html`<div><p class="yn-note">作業ログ 1 行ごとの金額は行単位で丸めているため、合計が原価行と最大 0.5 円/件ずれることがあります（原価は原価行が正）。</p>${worklogTable(all, { unit })}</div>`;
      },
    });
  }
  return {
    title: `${label}の計算根拠 — ${member.memberName}（${member.memberId}）`,
    subtitle,
    formula: ["実績原価 = round(その月の作業時間の合計 × その月の時間単価)（契約・月ごと。契約詳細の原価行と同じ値）", `${label} = Σ 契約・月ごとの${label}`],
    rows: [
      { label: "原価行（契約×月）", value: `${rows.length}件` },
      { label: "実績時間", value: formatHours(hours), emphasis: measure === "hours" },
      { label: "うちアサインの無い契約・月", value: formatHours(unplannedHours), note: unplannedHours > 0 ? "応援など、アサインが登録されていない作業" : null },
      { label: "実績原価", value: money(cost, unit), emphasis: measure !== "hours" },
    ],
    sections,
  };
}

/** 差額 = 計画原価 − 実績原価 */
export function memberVarianceSpec({ plannedCost, actualCost, unit, subtitle = null }) {
  unit = memberUnit(unit);
  const v = plannedCost - actualCost;
  return {
    title: "差額の計算根拠",
    subtitle,
    formula: ["差額 = 計画原価 − 実績原価（プラス = 計画より原価が少ない）"],
    rows: [
      { label: "計画原価", value: money(plannedCost, unit) },
      { label: "実績原価", value: money(actualCost, unit) },
      { label: "差額", value: money(v, unit), emphasis: true, note: v > 0 ? "計画より原価が少ない" : v < 0 ? "計画より原価が多い" : "計画どおり" },
    ],
    note: "差額は色分けしません（赤は消化率超過と赤字見込みだけ）。",
  };
}

/** 稼働率 = 実績時間 ÷ 計画時間 */
export function memberUtilizationSpec({ plannedHours, actualHours, utilization, unplannedHours = 0, subtitle = null }) {
  return {
    title: "稼働率の計算根拠",
    subtitle,
    formula: ["稼働率 = 実績時間 ÷ 計画時間（計画時間 = 配分人月 × 基準時間）"],
    rows: [
      { label: "実績時間", value: formatHours(actualHours), note: unplannedHours > 0 ? `うちアサインの無い契約 ${formatHours(unplannedHours)}` : null },
      { label: "計画時間", value: formatHours(plannedHours) },
      { label: "稼働率", value: formatPercent(utilization), emphasis: true, note: utilization === null ? "計画時間が 0 のため計算できません" : null },
    ],
    note: "100% を超えても赤にはしません（表示のみ）。アサインの無い契約への作業も実績時間に含みます。",
  };
}

const MEMBER_MEASURES = {
  plannedHours: { label: "計画時間", hours: true, formula: "計画時間 = Σ メンバーの 配分人月 × 基準時間" },
  actualHours: { label: "実績時間", hours: true, formula: "実績時間 = Σ メンバーの作業時間" },
  plannedCost: { label: "計画原価", formula: "計画原価 = Σ メンバーの round(計画時間 × 単価)（契約・月ごとに丸め）" },
  actualCost: { label: "実績原価", formula: "実績原価 = Σ メンバーの原価行（同じ期間の契約原価の合計と一致）" },
  variance: { label: "差額", formula: "差額 = 計画原価 − 実績原価" },
  utilization: { label: "稼働率", percent: true, formula: "稼働率 = Σ 実績時間 ÷ Σ 計画時間" },
};

/** メンバー一覧の合計行（表示中のメンバー。total は aggregateMembers の total） */
export function memberTotalsSpec({ members, total, measure, unit, period }) {
  unit = memberUnit(unit);
  const d = MEMBER_MEASURES[measure];
  const fmt = (v) => (d.hours ? formatHours(v) : d.percent ? formatPercent(v) : money(v, unit));
  const parts =
    measure === "utilization"
      ? [{ label: "実績時間", value: formatHours(total.actualHours) }, { label: "計画時間", value: formatHours(total.plannedHours) }]
      : measure === "variance"
        ? [{ label: "計画原価", value: money(total.plannedCost, unit) }, { label: "実績原価", value: money(total.actualCost, unit) }]
        : [];
  return {
    title: `${d.label}（合計）の計算根拠`,
    subtitle: periodJa(period),
    formula: [d.formula],
    rows: [{ label: "対象メンバー", value: `${members.length}人` }, ...parts, { label: `${d.label}（合計）`, value: fmt(total[measure]), emphasis: true }],
    sections: [
      {
        title: "メンバーごとの内訳",
        table: { columns: [{ label: "メンバー" }, { label: d.label, align: "num" }], rows: members.map((m) => [`${m.memberName}（${m.memberId}）`, fmt(m[measure])]) },
      },
    ],
  };
}
