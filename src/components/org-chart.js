/**
 * 体制図（SPEC §76）: チーム一覧の表示切替。月を選ぶと、その月の組織・メンバー・応援／ヘルプと負荷の色が変わる
 *
 * 表示だけ（ここからマスタや計画は変えない）。計算は core の orgChartAt、お金の数字は aggregate／着地見込み。
 *   orgChartView({ model, store, state, month, color, onChange }) → 要素
 * onChange({ month?, color? }) で URL を書き換えて描き直すのはページ側（teams.md）。
 */
import { html } from "htl";
import { T, fmt } from "../i18n/index.js";
import {
  aggregate,
  formatHours,
  formatPercent,
  formatPersonMonths,
  isValidYearMonth,
  loadLevelOf,
  monthRange,
  orgChartAt,
  personMonths,
  planGapKindOf,
  setForecastPeriod,
} from "../core/index.js";
import { forecastMonthlyCost, grossMarginOf } from "./analysis.js";
import { money, monthJa } from "./format.js";
import { planCellTooltip } from "./plan-cell.js";

/** 体制図で選べる月（データの最初の月〜最後の月。今月は必ず含む） */
export function orgChartMonths(model) {
  const asOf = model.meta.asOfMonth;
  const from = model.meta.minMonth && model.meta.minMonth < asOf ? model.meta.minMonth : asOf;
  const to = model.meta.maxMonth && model.meta.maxMonth > asOf ? model.meta.maxMonth : asOf;
  return monthRange(from, to);
}

/** URL の month を選べる月に収める（無効なら fallback） */
export function clampOrgMonth(model, month, fallback) {
  const ms = orgChartMonths(model);
  const m = isValidYearMonth(month) ? month : fallback;
  if (m < ms[0]) return ms[0];
  if (m > ms[ms.length - 1]) return ms[ms.length - 1];
  return m;
}

/** その月の組織ごとの予算・実績（今月以降は着地見込みの方法の見込み） */
function nodeMoney(model, chart, month, method, restorePeriod) {
  const isActual = month < model.meta.asOfMonth;
  // 見込みはその月だけを対象に計算し直し、終わったらチーム一覧の期間に戻す（§54）
  let fc = null;
  if (!isActual) setForecastPeriod(model, { from: month, to: month });
  try {
    const contractTeam = new Map(model.contracts.map((r) => [r.contract.contractId, r.contract.teamId]));
    const contractOf = new Map(model.contracts.map((r) => [r.contract.contractId, r.contract]));
    const out = new Map();
    for (const node of Object.values(chart.nodes)) {
      const scope = new Set(node.descendantIds);
      const ids = model.contracts.map((r) => r.contract.contractId).filter((id) => scope.has(contractTeam.get(id)));
      const t = aggregate(model, { period: { from: month, to: month }, contractIds: ids });
      let cost = t.cost;
      if (!isActual) {
        fc = forecastMonthlyCost(model, ids, method);
        cost = fc.get(month) ?? 0;
      }
      const customers = new Map();
      for (const d of node.descendantIds) {
        for (const cid of chart.nodes[d]?.contractIds ?? []) {
          const c = contractOf.get(cid);
          if (!c) continue;
          const key = c.customerName || T.numbers.noCustomerName;
          customers.set(key, (customers.get(key) ?? 0) + 1);
        }
      }
      out.set(node.teamId, { budget: t.budget, cost, isActual, rate: grossMarginOf(t.budget, cost), customers: [...customers].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)) });
    }
    return out;
  } finally {
    if (!isActual && restorePeriod) setForecastPeriod(model, restorePeriod);
  }
}

const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "±0");

export function orgChartView({ model, store, state, month, color, onChange, restorePeriod }) {
  const std = model.config.standardHoursPerMonth;
  const unit = state.unit;
  const months = orgChartMonths(model);
  const chart = orgChartAt(model, month);
  const moneyBy = nodeMoney(model, chart, month, state.method, restorePeriod);
  const confirmed = month <= model.meta.lastFinalMonth;
  const isFuture = month > model.meta.asOfMonth;
  const isCurrent = month === model.meta.asOfMonth;
  const gapMode = color === "gap";
  const contractById = new Map(model.contracts.map((r) => [r.contract.contractId, r.contract]));
  const teamName = (id) => (id && chart.nodes[id] ? chart.nodes[id].name : (id ?? ""));
  const tip = planCellTooltip();
  const tipContent = new Map();

  // ── 操作（◀ 月 ▶、スライダー、色の基準） ─────────────────
  const idx = months.indexOf(month);
  const select = html`<select class="yn-select" id="yn-org-month" aria-label=${T.orgChart.monthLabel}>${months.map((m) => html`<option value=${m} selected=${m === month}>${monthJa(m)}</option>`)}</select>`;
  select.addEventListener("change", () => onChange({ month: select.value }));
  const slider = html`<input type="range" class="yn-org-slider" min="0" max=${months.length - 1} step="1" value=${idx} aria-label=${T.orgChart.sliderLabel} aria-valuetext=${monthJa(month)}>`;
  // ドラッグ中は月の表示だけ追い、離したら描き直す（重い描き直しを連打しない）
  slider.addEventListener("input", () => (select.value = months[Number(slider.value)]));
  slider.addEventListener("change", () => onChange({ month: months[Number(slider.value)] }));
  const step = (n) => {
    const next = months[idx + n];
    if (next) onChange({ month: next });
  };
  const colorBtn = (id, label) => html`<button type="button" class="yn-seg-btn" aria-pressed=${String(color === id)} data-color=${id} onclick=${() => onChange({ color: id })}>${label}</button>`;
  const bar = html`<div class="yn-org-bar">
    <div class="yn-org-month">
      <button type="button" class="yn-btn yn-btn-sm" data-org="prev" aria-label=${T.orgChart.prevMonth} disabled=${idx <= 0} onclick=${() => step(-1)}>◀</button>
      ${select}
      <button type="button" class="yn-btn yn-btn-sm" data-org="next" aria-label=${T.orgChart.nextMonth} disabled=${idx >= months.length - 1} onclick=${() => step(1)}>▶</button>
    </div>
    ${slider}
    <div class="yn-org-color"><span class="yn-filter-label" id="yn-org-color-label">${T.orgChart.colorLabel}</span><div class="yn-seg" role="group" aria-labelledby="yn-org-color-label">${colorBtn("plan", T.orgChart.colorPlan)}${colorBtn("gap", T.orgChart.colorGap)}</div></div>
  </div>`;

  const sw = (cls, label) => html`<span class="yn-org-legend-item"><span class=${`yn-org-swatch ${cls}`} aria-hidden="true"></span>${label}</span>`;
  const legend = html`<div class="yn-org-legend" aria-hidden="true">
    ${gapMode
      ? [sw("is-over", T.orgChart.legendGapOver), sw("is-under", T.orgChart.legendGapUnder), sw("is-full", T.orgChart.legendGapNone)]
      : [sw("is-over", T.orgChart.legendOver), sw("is-full", T.orgChart.legendFull), sw("is-under", T.orgChart.legendUnder), sw("is-none", T.orgChart.legendNone)]}
    <span class="yn-org-legend-item">${T.orgChart.legendJoined}</span>
    <span class="yn-org-legend-item yn-org-legend-left">${T.orgChart.legendLeft}</span>
    <span class="yn-org-legend-item"><span class="yn-chip yn-chip-neutral">${T.orgChart.legendSupport}</span></span>
    <span class="yn-org-legend-item"><span class="yn-chip yn-chip-neutral yn-chip-help">${T.orgChart.legendHelp}</span></span>
  </div>`;
  const status = gapMode && !confirmed ? html`<div class="yn-org-status" role="status">${fmt(T.orgChart.gapUnconfirmed, { month: monthJa(month) })}</div>` : null;

  // ── 人のチップ ─────────────────────────────────────
  const pm = (h) => formatPersonMonths(personMonths(h, std));
  const hoursText = (h) => fmt(T.orgChart.tipHours, { pm: pm(h), hours: formatHours(h) });
  const lineLabel = (l) => {
    if (l.outsideType !== undefined) return l.outsideType ? fmt(T.orgChart.tipOutside, { type: l.outsideType }) : T.orgChart.tipOutsideNoType;
    const c = contractById.get(l.contractId);
    return c ? [c.customerName, c.projectName].filter(Boolean).join(" ") : l.contractId;
  };
  const personTip = (p) => {
    const head = html`<p class="yn-plan-tip-head">${p.name}${p.title ? `（${p.title}）` : ""}</p>`;
    const sub = [];
    if (p.origin === "support") sub.push(fmt(T.orgChart.tipGuestSupport, { team: teamName(p.teamId) }));
    if (p.origin === "help") sub.push(p.memberUnknown ? T.orgChart.tipGuestHelpUnknown : T.orgChart.tipGuestHelpNoOrg);
    if (p.change === "joined") sub.push(p.otherTeamId ? fmt(T.orgChart.tipJoinedFrom, { team: teamName(p.otherTeamId) }) : T.orgChart.tipJoinedNew);
    if (p.change === "left") sub.push(p.otherTeamId ? fmt(T.orgChart.tipLeftTo, { team: teamName(p.otherTeamId) }) : T.orgChart.tipLeftAbsent);
    if (p.leaving) sub.push(T.orgChart.tipLeaving);
    if (p.change === "left") return html`<div>${head}<p>${monthJa(month)}</p>${sub.map((t) => html`<p>${t}</p>`)}</div>`;
    const planLabel = isFuture || isCurrent ? T.orgChart.tipForecast : T.orgChart.tipPlan;
    const showActual = !isFuture;
    const rows = p.lines.map(
      (l) => html`<li><span>${lineLabel(l)}${l.support ? html`<br><small>${fmt(T.orgChart.tipSupportTo, { team: teamName(l.contractTeamId) })}</small>` : ""}</span><span class="num">${showActual ? html`${T.orgChart.tipActual} ${pm(l.actualHours)}<br>` : ""}${planLabel} ${pm(l.plannedHours)}</span></li>`,
    );
    const total = html`<li class="yn-org-tip-total"><span>${T.orgChart.tipTotal}</span><span class="num">${showActual ? html`${T.orgChart.tipActual} ${hoursText(p.actualHours)}<br>` : ""}${planLabel} ${hoursText(p.plannedHours)}</span></li>`;
    return html`<div>${head}<p>${monthJa(month)}</p>${sub.map((t) => html`<p>${t}</p>`)}${p.lines.length ? html`<ul class="yn-plan-tip-list">${rows}${total}</ul>` : html`<p>${T.orgChart.tipNoLoad}</p>`}</div>`;
  };
  const levelClass = (p) => {
    if (p.change === "left") return "is-left";
    if (gapMode) {
      if (!confirmed || (p.plannedHours <= 0 && p.actualHours <= 0)) return "is-none";
      const k = planGapKindOf(p.plannedHours, p.actualHours);
      return k === "over" || k === "unplanned" ? "is-over" : k === "under" || k === "noActual" ? "is-under" : "is-full";
    }
    return `is-${loadLevelOf(personMonths(p.plannedHours, std))}`;
  };
  const chipValue = (p) => {
    if (p.change === "left") return "";
    if (gapMode) {
      if (!confirmed || (p.plannedHours <= 0 && p.actualHours <= 0)) return "";
      const d = p.actualHours - p.plannedHours;
      return Math.abs(d) < 0.005 ? "±0h" : `${d > 0 ? "+" : "−"}${formatHours(Math.abs(d))}`;
    }
    const v = personMonths(p.plannedHours, std);
    return v > 0 ? new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 }).format(v) : "";
  };
  let tipSeq = 0;
  const personChip = (p) => {
    const key = `p${++tipSeq}`;
    tipContent.set(key, () => personTip(p));
    const mark = p.change === "joined" ? T.orgChart.joinedMark : p.change === "left" ? T.orgChart.leftMark : "";
    const origin = p.origin === "support" ? html`<span class="yn-chip yn-chip-neutral">${T.orgChart.legendSupport}</span>` : p.origin === "help" ? html`<span class="yn-chip yn-chip-neutral yn-chip-help">${T.orgChart.legendHelp}</span>` : null;
    const href = p.memberUnknown ? null : store.href("./member", {}, { id: p.memberId });
    const inner = html`${mark ? html`<span class="yn-org-mark" data-change=${p.change}>${mark}</span>` : null}<span class="yn-org-pname">${p.name}</span>${origin}<span class="yn-org-pval">${chipValue(p)}</span>`;
    const cls = `yn-org-person ${levelClass(p)}${p.leaving ? " is-leaving" : ""}`;
    return href
      ? html`<a class=${cls} href=${href} data-tip=${key} data-member=${p.memberId} data-origin=${p.origin} data-change=${p.change ?? ""}>${inner}</a>`
      : html`<span class=${cls} tabindex="0" data-tip=${key} data-member=${p.memberId} data-origin=${p.origin} data-change=${p.change ?? ""}>${inner}</span>`;
  };

  // ── 組織 ───────────────────────────────────────
  const teamTip = (node, mny) => {
    const list = mny.customers.slice(0, 12).map(([name, n]) => html`<li><span>${name}</span><span class="num">${fmt(T.orgChart.tipProjects, { n })}</span></li>`);
    const more = mny.customers.length > 12 ? html`<p>${fmt(T.orgChart.tipMoreCustomers, { n: mny.customers.length - 12 })}</p>` : null;
    return html`<div>
      <p class="yn-plan-tip-head">${node.name}${node.level ? `（${node.level}）` : ""}</p>
      <p>${fmt(T.orgChart.tipCustomers, { month: monthJa(month) })}</p>
      ${list.length ? html`<ul class="yn-plan-tip-list">${list}</ul>` : html`<p>${T.orgChart.tipNoCustomers}</p>`}${more}
      <ul class="yn-plan-tip-list yn-org-tip-money">
        <li><span>${T.orgChart.tipBudget}</span><span class="num">${money(mny.budget, unit)}</span></li>
        <li><span>${mny.isActual ? T.orgChart.tipCost : T.orgChart.tipForecastCost}</span><span class="num">${money(mny.cost, unit)}</span></li>
        <li><span>${T.orgChart.tipRemaining}</span><span class="num">${formatPercent(mny.rate)}</span></li>
        <li><span>${T.orgChart.tipHeadcount}</span><span class="num">${fmt(T.orgChart.people, { n: node.totalHeadcount })}${fmt(T.orgChart.peopleDelta, { delta: signed(node.totalHeadcount - node.prevTotalHeadcount) })}</span></li>
      </ul>
    </div>`;
  };
  const renderNode = (id) => {
    const node = chart.nodes[id];
    if (!node) return null;
    const mny = moneyBy.get(id);
    const key = `t${++tipSeq}`;
    tipContent.set(key, () => teamTip(node, mny));
    const delta = node.totalHeadcount - node.prevTotalHeadcount;
    const leader = node.leaderMemberId ? (model.members.find((m) => m.memberId === node.leaderMemberId)?.name ?? node.leaderMemberId) : "";
    const over = mny.rate !== null && mny.rate < 0;
    // 応援・ヘルプのうち、その月に計画が無く実績だけの人は畳んでおく（スポットの作業で組織の人が埋もれないように）
    const planned = node.guests.filter((p) => p.plannedHours > 0);
    const spot = node.guests.filter((p) => !(p.plannedHours > 0));
    const people = [...node.members, ...planned];
    return html`<section class="yn-org-node" data-depth=${Math.min(node.depth, 4)} data-team=${id}>
      <a class=${`yn-org-head${over ? " is-over-budget" : ""}`} href=${store.href("./team", {}, { id })} data-tip=${key}>
        <span class="yn-org-title"><span class="yn-org-name">${node.name}</span>${node.level ? html`<span class="yn-org-level">${node.level}</span>` : null}</span>
        <span class="yn-org-meta">
          ${leader ? html`<span class="yn-org-leader">${fmt(T.orgChart.leader, { name: leader })}</span>` : null}
          <span class="yn-org-count">${fmt(T.orgChart.people, { n: node.totalHeadcount })}${delta !== 0 ? html`<span class="yn-org-delta" data-sign=${delta > 0 ? "plus" : "minus"}>${fmt(T.orgChart.peopleDelta, { delta: signed(delta) })}</span>` : null}</span>
          ${mny.budget > 0 ? html`<span class=${`yn-org-rate${over ? " is-danger" : ""}`}>${fmt(T.orgChart.remainingRate, { rate: formatPercent(mny.rate, 0) })}</span>` : null}
        </span>
      </a>
      ${people.length || spot.length
        ? html`<div class="yn-org-people">${people.map(personChip)}${spot.length
            ? html`<details class="yn-org-spot"><summary>${fmt(T.orgChart.spotSummary, { n: spot.length })}</summary><div class="yn-org-people">${spot.map(personChip)}</div></details>`
            : null}</div>`
        : null}
      ${node.children.length ? html`<div class="yn-org-children">${node.children.map(renderNode)}</div>` : null}
    </section>`;
  };
  const roots = chart.rootTeamIds.map(renderNode);
  const unplaced = chart.unplaced.length
    ? html`<section class="yn-org-node" data-depth="1" data-team=""><div class="yn-org-head"><span class="yn-org-title"><span class="yn-org-name">${T.orgChart.unplacedTitle}</span></span></div><div class="yn-org-people">${chart.unplaced.map(personChip)}</div></section>`
    : null;
  const tree = html`<div class="yn-org-tree">${roots.length ? roots : html`<div class="yn-state yn-empty" role="status">${T.orgChart.empty}</div>`}${unplaced}</div>`;

  // 吹き出し: カーソルを合わせる・フォーカスで出す（クリックはそのまま詳細へ）
  const showFor = (el) => {
    const make = el && tipContent.get(el.dataset.tip);
    if (make) tip.show(el, make(), 360);
  };
  tree.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const el = e.target.closest?.("[data-tip]");
    if (el && tree.contains(el)) showFor(el);
  });
  tree.addEventListener("pointerout", (e) => {
    const el = e.target.closest?.("[data-tip]");
    if (el && !el.contains(e.relatedTarget)) tip.hide();
  });
  tree.addEventListener("focusin", (e) => showFor(e.target.closest?.("[data-tip]")));
  tree.addEventListener("focusout", () => tip.hide());
  tree.addEventListener("keydown", (e) => e.key === "Escape" && tip.hide());

  return html`<div class="yn-org" data-month=${month} data-color=${color}>
    ${bar}${legend}${status}${tree}${tip.el}
  </div>`;
}
