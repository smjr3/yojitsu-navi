/**
 * グラフの単位の切り替え（日・週・月・四半期・年度。SPEC §130）の共通部品。
 * - 選んだ単位はグラフの種類ごとにこのブラウザ（localStorage）に覚える（読めなくても既定の「月」で動く）
 * - 日・週に要る日ごとの実績（data/daily-history.json・data/member-days.json）は選んだときに初めて読む
 */
import { h } from "./dom.js";
import { T, fmt } from "../i18n/index.js";
import { dateJa, monthJa, periodJa, STATUS_LABELS } from "./format.js";
import { fiscalQuarterOf } from "../core/index.js";

const PREFIX = "yojitsu-navi:chart-unit:";

export function loadUnit(kind, units, fallback = "month") {
  try {
    const v = localStorage.getItem(PREFIX + kind);
    return units.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function saveUnit(kind, unit) {
  try {
    if (unit === "month") localStorage.removeItem(PREFIX + kind);
    else localStorage.setItem(PREFIX + kind, unit);
  } catch {
    // 保存できなくても切り替えは効く
  }
}

/** 切り替えのボタン（凡例の前に置く） */
export function unitSwitch({ units, value, onChange, labels = T.charts.unitLabels, groupLabel = T.charts.unitGroupLabel }) {
  const btns = units.map((u) =>
    h("button", { type: "button", class: "yn-seg-btn", "data-unit": u, "aria-pressed": String(u === value) }, labels[u]),
  );
  for (const b of btns) b.addEventListener("click", () => b.dataset.unit !== value && onChange(b.dataset.unit));
  return h("div", { class: "yn-seg yn-chart-unit", role: "group", "aria-label": groupLabel }, btns);
}

/** FileAttachment を 1 回だけ読む（読めなければ null） */
export function lazyJson(attachment) {
  let p = null;
  return () => (p ??= attachment ? attachment.json().catch(() => null) : Promise.resolve(null));
}

/** 読み込み中・読めなかったときのグラフ枠の中身 */
export function chartMessage(text) {
  return h("div", { class: "yn-chart-empty" }, text);
}

const yy = (y) => String(y).slice(2);

/** 単位ごとの目盛り（i = 何本目か） */
export function bucketTick(d, i, startMonth) {
  if (d.unit === "day" || d.unit === "week") {
    const [y, m, dd] = [d.from.slice(0, 4), Number(d.from.slice(5, 7)), Number(d.from.slice(8, 10))];
    const withYear = i === 0 || (m === 1 && (d.unit === "week" ? dd <= 7 : dd === 1));
    return fmt(withYear ? T.charts.dayTickYear : T.charts.dayTick, { yy: yy(y), m, d: dd });
  }
  const q = fiscalQuarterOf(d.months[0], startMonth);
  if (d.unit === "year") return fmt(T.charts.yearTick, { fy: q.fiscalYear });
  return fmt(i === 0 || q.quarter === 1 ? T.charts.quarterTickYear : T.charts.quarterTick, { yy: yy(q.fiscalYear), q: q.quarter });
}

/** 週の表記「2026年10月26日〜11月1日」（年が同じなら終わりの年を省く） */
export function weekText(from, to) {
  const toText = from.slice(0, 4) === to.slice(0, 4) ? fmt(T.charts.monthDay, { month: Number(to.slice(5, 7)), day: Number(to.slice(8, 10)) }) : dateJa(to);
  return fmt(T.charts.weekLabel, { from: dateJa(from), to: toText });
}

/** 単位ごとの正式な表記（ツールチップ・表） */
export function bucketLabel(d, startMonth) {
  if (d.unit === "day") return `${dateJa(d.from)}${d.businessDay === false ? T.daily.offDay : ""}`;
  if (d.unit === "week") return weekText(d.from, d.to);
  const q = fiscalQuarterOf(d.months[0], startMonth);
  const range = d.months.length === 1 ? monthJa(d.months[0]) : periodJa({ from: d.months[0], to: d.months[d.months.length - 1] });
  if (d.unit === "year") return fmt(T.charts.yearLabel, { fy: q.fiscalYear, range });
  return fmt(T.charts.quarterLabel, { fy: q.fiscalYear, q: q.quarter, range });
}

/** ツールチップの 1 行目（状態がそろっていれば添える） */
export function bucketTipValue(d, startMonth, suffix = "") {
  const label = bucketLabel(d, startMonth);
  return d.status ? fmt(T.charts.bucketValue, { label, status: STATUS_LABELS[d.status], suffix }) : fmt(T.charts.bucketValueNoStatus, { label, suffix: suffix ? `（${suffix.replace(/^・/, "")}）` : "" });
}
