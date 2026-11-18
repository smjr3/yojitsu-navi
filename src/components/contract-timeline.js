/**
 * 案件一覧の「期間」表示（SPEC §132）: 案件ごとの契約期間を横軸の時間に帯で並べ、帯の中に月ごとの実績を出す。
 * 1 行 = 1 案件（契約。更新かどうかはデータから分からないので、続く契約もつなげない）。
 * 行・帯・月の棒は数が多いので h() で作る（SPEC §107）。
 */
import { h } from "./dom.js";
import { T, fmt } from "../i18n/index.js";
import { addMonths, monthRange, monthsBetween, formatPercent } from "../core/index.js";
import { money, monthJa, periodCompact } from "./format.js";

/** 「終了が近い」: 今月から何か月先までに終わる案件か（今月に終わる案件を含む） */
export const END_SOON_MONTHS = 3;
export const TIMELINE_GROUPS = ["customer", "team", "none"];
export const TIMELINE_SORTS = ["end", "start", "amount", "burn"];
const PREFS_KEY = "yojitsu-navi:contract-timeline";

/** 終わった案件（終了月が今月より前） */
export function isEnded(row, asOfMonth) {
  return row.endMonth < asOfMonth;
}

/** 終了が近い案件（今月〜END_SOON_MONTHS か月先に終わる） */
export function isEndingSoon(row, asOfMonth) {
  return row.endMonth >= asOfMonth && row.endMonth <= addMonths(asOfMonth, END_SOON_MONTHS);
}

const collator = new Intl.Collator("ja");
const SORTERS = {
  end: (a, b) => a.endMonth.localeCompare(b.endMonth) || a.startMonth.localeCompare(b.startMonth),
  start: (a, b) => a.startMonth.localeCompare(b.startMonth) || a.endMonth.localeCompare(b.endMonth),
  amount: (a, b) => (b.totalAmount ?? 0) - (a.totalAmount ?? 0),
  burn: (a, b) => burnOf(b) - burnOf(a),
};
function burnOf(r) {
  return typeof r.burnRate === "number" && Number.isFinite(r.burnRate) ? r.burnRate : -1;
}

/**
 * 行をまとめて並べる。終わった案件はどの並べ方でも後ろ（終わった中では終了の新しい順）。
 * まとまりの順は、並べた後の最初の行の順（終了が近い順なら、終了が近い案件のある顧客が上）。
 * @returns {{key: string, label: string, rows: object[]}[]}
 */
export function arrangeTimeline(rows, { group = "customer", sort = "end", asOfMonth }) {
  const cmp = SORTERS[sort] ?? SORTERS.end;
  const sorted = [...rows].sort((a, b) => {
    const ea = isEnded(a, asOfMonth);
    const eb = isEnded(b, asOfMonth);
    if (ea !== eb) return ea ? 1 : -1;
    if (ea) return b.endMonth.localeCompare(a.endMonth) || collator.compare(a.customerName, b.customerName);
    return cmp(a, b) || collator.compare(`${a.customerName} ${a.projectName}`, `${b.customerName} ${b.projectName}`) || a.contractId.localeCompare(b.contractId);
  });
  if (group === "none") return [{ key: "", label: "", rows: sorted }];
  const keyOf = group === "team" ? (r) => r.teamId ?? "" : (r) => r.customerName;
  const labelOf = group === "team" ? (r) => r.teamName : (r) => r.customerName;
  const groups = new Map();
  for (const r of sorted) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, { key: k, label: labelOf(r), rows: [] });
    groups.get(k).rows.push(r);
  }
  return [...groups.values()];
}

/**
 * 月ごとの実績の棒: 確定した月だけ（速報の月は月の途中なので割合にしない）。高さ = 実績 ÷ 予算（1 で頭打ち）
 * @returns {{month: string, ratio: number, over: boolean, budget: number, cost: number}[]}
 */
export function monthBars(months, visible) {
  const out = [];
  for (const m of months ?? []) {
    if (m.status !== "final" || !(m.budget > 0) || m.month < visible.from || m.month > visible.to) continue;
    out.push({ month: m.month, ratio: m.cost / m.budget, over: m.cost > m.budget, budget: m.budget, cost: m.cost });
  }
  return out;
}

/** まとめ方・並べ方をブラウザに覚える（読めなければ既定） */
export function loadTimelinePrefs(storage = safeStorage()) {
  try {
    const v = JSON.parse(storage?.getItem(PREFS_KEY) ?? "{}");
    return { group: TIMELINE_GROUPS.includes(v.group) ? v.group : "customer", sort: TIMELINE_SORTS.includes(v.sort) ? v.sort : "end" };
  } catch {
    return { group: "customer", sort: "end" };
  }
}
export function saveTimelinePrefs(prefs, storage = safeStorage()) {
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify({ group: prefs.group, sort: prefs.sort }));
  } catch {
    /* 保存できなくても動く */
  }
}
function safeStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * 期間の表示を作る。
 * @param {{rows: object[], period: {from: string, to: string}, asOf: string, unit: string, href: (row) => string}} opts
 */
export function contractTimeline({ rows, period, asOf, unit, href }) {
  const L = T.contracts.timeline;
  const asOfMonth = asOf.slice(0, 7);
  const months = monthRange(period.from, period.to);
  const n = Math.max(1, months.length);
  const prefs = loadTimelinePrefs();
  const root = h("div", { class: "yn-tl-wrap" });
  const select = (key, options, label) => {
    const s = h(
      "select",
      { class: "yn-input yn-tl-select", "aria-label": label, "data-role": key },
      options.map((o) => h("option", { value: o, selected: prefs[key] === o }, L[`${key}_${o}`])),
    );
    s.addEventListener("change", () => {
      prefs[key] = s.value;
      saveTimelinePrefs(prefs);
      draw();
    });
    return h("label", { class: "yn-tl-ctl" }, h("span", null, label), s);
  };
  const tools = h("div", { class: "yn-tl-tools" }, select("group", TIMELINE_GROUPS, L.groupLabel), select("sort", TIMELINE_SORTS, L.sortLabel));
  const box = h("div", { class: "yn-tl", style: `--yn-tl-n:${n}` });
  root.append(tools, box);

  // 横の位置（0〜1）: 月の左端・右端。期間の外は端に寄せる
  const left = (ym) => (ym < period.from ? 0 : (monthsBetween(period.from, ym) - 1) / n);
  const right = (ym) => (ym > period.to ? 1 : monthsBetween(period.from, ym) / n);
  const pct = (x) => `${(x * 100).toFixed(4)}%`;

  // 今日の線（期間の中にあるときだけ）。月の中の位置は日で
  const todayX = asOfMonth >= period.from && asOfMonth <= period.to ? left(asOfMonth) + (Math.min(Number(asOf.slice(8, 10)), 30) - 0.5) / 30 / n : null;

  const header = () => {
    const cells = months.map((m, i) => {
      const mm = Number(m.slice(5, 7));
      const year = mm === 1 || i === 0;
      return h("div", { class: year ? "yn-tl-m is-year" : "yn-tl-m" }, year ? h("span", { class: "yn-tl-y" }, fmt(L.year, { year: m.slice(0, 4) })) : null, fmt(T.format.monthOnly, { month: mm }));
    });
    return h(
      "div",
      { class: "yn-tl-row yn-tl-head" },
      h("div", { class: "yn-tl-label" }, L.colContract),
      h("div", { class: "yn-tl-track" }, h("div", { class: "yn-tl-months" }, cells), todayX === null ? null : h("span", { class: "yn-tl-today-label", style: `left:${pct(todayX)}` }, L.today)),
    );
  };

  const rowEl = (r) => {
    const ended = isEnded(r, asOfMonth);
    const soon = isEndingSoon(r, asOfMonth);
    const name = `${r.customerName} / ${r.projectName}`;
    const label = h(
      "div",
      { class: "yn-tl-label" },
      h("a", { class: "yn-tl-name", href: href(r), title: name }, name),
      h("span", { class: "yn-tl-sub" }, `${r.teamName} ・ ${periodCompact(r.startMonth, r.endMonth)}`, ended ? h("span", { class: "yn-tl-ended" }, ` ・ ${L.ended}`) : null),
    );
    const rowClass = ended ? "yn-tl-row is-ended" : "yn-tl-row";
    // 期間に 1 か月も掛からない案件（「期間外の案件も表示」）は帯を描かず、どちら側にあるかを端に出す（横軸を延ばさない）
    if (r.endMonth < period.from || r.startMonth > period.to) {
      const before = r.endMonth < period.from;
      const text = before ? `◀ ${periodCompact(r.startMonth, r.endMonth)}` : `${periodCompact(r.startMonth, r.endMonth)} ▶`;
      return h("div", { class: rowClass, "data-contract": r.contractId }, label, h("div", { class: "yn-tl-track" }, h("span", { class: before ? "yn-tl-outside" : "yn-tl-outside is-after", title: fmt(L.outsideTitle, { from: monthJa(r.startMonth), to: monthJa(r.endMonth) }) }, text)));
    }
    const L0 = left(r.startMonth);
    const R0 = right(r.endMonth);
    const span = Math.max(R0 - L0, 0.001);
    const visFrom = r.startMonth < period.from ? period.from : r.startMonth;
    const visTo = r.endMonth > period.to ? period.to : r.endMonth;
    const visN = monthsBetween(visFrom, visTo);
    const bars = monthBars(r.months, { from: visFrom, to: visTo }).map((b) => {
      const i = monthsBetween(visFrom, b.month) - 1;
      return h("span", {
        class: b.over ? "yn-tl-bar is-over" : "yn-tl-bar",
        style: `left:${pct(i / visN)};width:${pct(1 / visN)};height:${pct(Math.min(1, b.ratio))}`,
        title: fmt(L.barTitle, { month: monthJa(b.month), cost: money(b.cost, unit), budget: money(b.budget, unit), rate: formatPercent(b.ratio) }),
      });
    });
    const cls = ["yn-tl-band"];
    if (r.startMonth < period.from) cls.push("is-cut-l");
    if (r.endMonth > period.to) cls.push("is-cut-r");
    const title = fmt(L.bandTitle, { customer: r.customerName, project: r.projectName, from: monthJa(r.startMonth), to: monthJa(r.endMonth), amount: money(r.totalAmount, unit), rate: r.burnRate === null || r.burnRate === undefined ? "—" : formatPercent(r.burnRate) });
    const band = h("span", { class: cls.join(" "), style: `left:${pct(L0)};width:${pct(span)}`, title }, bars);
    const over = r.isOverBudget;
    const rate = typeof r.burnRate === "number" && Number.isFinite(r.burnRate) ? formatPercent(r.burnRate) : null;
    // 帯の下の数字: 総額 ・ 消化率。帯の幅の箱の中で左に寄せ、横にスクロールしても帯が見えている間は見える（sticky）。
    // 右寄りの短い帯は右端にそろえる（表示の外へはみ出さない）
    const anchorRight = L0 > 0.6 && span < 0.3;
    const facts = h(
      "span",
      { class: anchorRight ? "yn-tl-facts-box is-right" : "yn-tl-facts-box", style: `left:${pct(L0)};width:${pct(span)}` },
      h(
        "span",
        { class: "yn-tl-facts" },
        money(r.totalAmount, unit),
        rate ? [" ・ ", L.burn, " ", over ? h("span", { class: "yn-danger-text" }, h("span", { "aria-hidden": "true" }, "▲"), rate) : rate] : null,
      ),
    );
    const endChip = soon ? h("span", { class: "yn-tl-end", style: R0 > 0.8 ? `right:${pct(1 - R0)};transform:translate(-4px,-50%)` : `left:${pct(R0)}` }, fmt(L.endSoon, { month: Number(r.endMonth.slice(5, 7)) })) : null;
    return h("div", { class: rowClass, "data-contract": r.contractId }, label, h("div", { class: "yn-tl-track" }, band, facts, endChip));
  };

  const collapsed = new Set();
  function draw() {
    const groups = arrangeTimeline(rows, { group: prefs.group, sort: prefs.sort, asOfMonth });
    const body = [];
    for (const g of groups) {
      if (prefs.group !== "none") {
        const open = !collapsed.has(g.key);
        const total = g.rows.reduce((s, r) => s + (r.totalAmount ?? 0), 0);
        const btn = h("button", { type: "button", class: "yn-tl-group-btn", "aria-expanded": String(open), "data-group": g.key }, h("span", { class: "yn-tl-caret", "aria-hidden": "true" }, open ? "▾" : "▸"), " ", g.label || T.common.none);
        btn.addEventListener("click", () => {
          if (collapsed.has(g.key)) collapsed.delete(g.key);
          else collapsed.add(g.key);
          draw();
          // 描き直したボタンにフォーカスを戻す（キーボードで続けて開け閉めできるように）
          for (const b of box.querySelectorAll(".yn-tl-group-btn")) if (b.dataset.group === g.key) b.focus();
        });
        body.push(h("div", { class: "yn-tl-row yn-tl-group" }, h("div", { class: "yn-tl-label" }, btn), h("div", { class: "yn-tl-track" }, h("span", { class: "yn-tl-group-sum" }, fmt(L.groupSum, { n: g.rows.length, amount: money(total, unit) })))));
        if (!open) continue;
      }
      for (const r of g.rows) body.push(rowEl(r));
    }
    const grid = h("div", { class: "yn-tl-grid", style: `--yn-tl-n:${n}` }, header(), body, todayX === null ? null : h("span", { class: "yn-tl-today", style: `--yn-tl-x:${todayX}`, "aria-hidden": "true" }));
    box.replaceChildren(grid);
  }
  draw();
  // 横にスクロールする長さのとき、最初は今日の線が見える位置に（左から 3 分の 1 あたり）
  if (todayX !== null && typeof requestAnimationFrame !== "undefined") {
    requestAnimationFrame(() => {
      if (box.scrollWidth <= box.clientWidth) return;
      const label = box.querySelector(".yn-tl-head .yn-tl-label")?.getBoundingClientRect().width ?? 0;
      box.scrollLeft = Math.max(0, (box.scrollWidth - label) * todayX - (box.clientWidth - label) / 3);
    });
  }

  const anyOver = rows.some((r) => (r.months ?? []).some((m) => m.status === "final" && m.budget > 0 && m.cost > m.budget && m.month >= period.from && m.month <= period.to));
  root.append(
    h(
      "div",
      { class: "yn-tl-legend", "aria-hidden": "true" },
      h("span", null, h("i", { class: "yn-tl-sw-band" }), L.legendBand),
      h("span", null, h("i", { class: "yn-tl-sw-bar" }), L.legendBar),
      anyOver ? h("span", null, h("i", { class: "yn-tl-sw-over" }), L.legendOver) : null,
    ),
  );
  return root;
}
