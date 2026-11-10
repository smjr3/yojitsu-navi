/**
 * 表示用の書式（計算コア money.ts のラッパ ＋ 単位切替 ＋ 日付・月・ラベル）
 *
 * 画面側の単位は "m"（百万円・既定）| "k"（千円）| "yen"。計算コアの MoneyUnit へ変換する。
 */
import { EMPTY_VALUE, formatHours, formatPercent, formatPersonMonths, formatYen, roundToUnit } from "../core/index.js";
import { maxFractionFormat } from "../core/money.js";
import { T, fmt } from "../i18n/index.js";

export { EMPTY_VALUE, formatHours, formatPercent, formatPersonMonths, maxFractionFormat };

export const UNITS = [
  { id: "m", label: T.format.units.m, coreUnit: "millionYen" },
  { id: "k", label: T.format.units.k, coreUnit: "thousandYen" },
  { id: "yen", label: T.format.units.yen, coreUnit: "yen" },
];

export function toCoreUnit(unit) {
  return UNITS.find((u) => u.id === unit)?.coreUnit ?? "yen";
}

/** config の MoneyUnit → 画面の単位 ID */
export function fromCoreUnit(coreUnit) {
  return UNITS.find((u) => u.coreUnit === coreUnit)?.id ?? "m";
}

/** 金額（円の整数）を選択中の単位で表示 */
export function money(yen, unit = "yen") {
  return formatYen(yen, toCoreUnit(unit));
}

/**
 * 符号付き金額（差分表示用）。0 は "±0円"。
 * マイナス記号はコアの formatYen（Intl ja-JP の "-"）の出力をそのまま使い、画面で別の記号を組み立てない。
 */
export function moneySigned(yen, unit = "yen") {
  if (typeof yen !== "number" || !Number.isFinite(yen)) return EMPTY_VALUE;
  const s = money(yen, unit);
  if (roundToUnit(yen, toCoreUnit(unit)) === 0) return `±${money(0, unit)}`;
  return yen < 0 ? s : `+${s}`;
}

/**
 * 差額（計画 − 実績）に添える文。判定は表示と同じ丸め後の値で行う（SPEC §12:
 * 「±0.0百万円」なのに「計画より原価が少ない」と出さない）。
 */
export function varianceNote(yen, unit = "yen") {
  if (typeof yen !== "number" || !Number.isFinite(yen)) return "";
  const r = roundToUnit(yen, toCoreUnit(unit));
  return r > 0 ? T.format.varianceLess : r < 0 ? T.format.varianceMore : T.format.varianceEven;
}

/** 割合の差（ポイント）。0.012 → "+1.2pt"。マイナスは formatPercent と同じ記号 */
export function pointsSigned(delta, digits = 1) {
  if (typeof delta !== "number" || !Number.isFinite(delta)) return EMPTY_VALUE;
  const s = formatPercent(delta, digits).replace(/%$/, "pt");
  if (Number(s.slice(0, -2)) === 0) return `±${s.replace(/^-/, "")}`;
  return delta < 0 ? s : `+${s}`;
}

/** 軸ラベル用の短い金額（百万円） */
export function millions(yen) {
  if (typeof yen !== "number" || !Number.isFinite(yen)) return EMPTY_VALUE;
  return maxFractionFormat(1).format(yen / 1e6);
}

/** 整数のカンマ区切り */
export function integer(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return EMPTY_VALUE;
  return maxFractionFormat(0).format(n);
}

/** 小数（最大 digits 桁） */
export function decimal(n, digits = 2) {
  if (typeof n !== "number" || !Number.isFinite(n)) return EMPTY_VALUE;
  return maxFractionFormat(digits).format(n);
}

/** "2026-10" → "2026年10月" */
export function monthJa(ym) {
  if (typeof ym !== "string" || !/^\d{4}-\d{2}$/.test(ym)) return EMPTY_VALUE;
  return fmt(T.format.month, { year: ym.slice(0, 4), month: Number(ym.slice(5, 7)) });
}

/** "2026-10" → "10月"（軸などの短い表示。1月と最初の点には年を付ける） */
export function monthShort(ym, withYear = false) {
  if (typeof ym !== "string" || !/^\d{4}-\d{2}$/.test(ym)) return "";
  const m = Number(ym.slice(5, 7));
  return withYear || m === 1 ? `${ym.slice(2, 4)}/${m}` : fmt(T.format.monthOnly, { month: m });
}

/** 契約期間の短い表記 "26/04–27/03"（title に正式表記を入れて使う） */
export function periodCompact(from, to) {
  const f = (ym) => (typeof ym === "string" && ym.length >= 7 ? `${ym.slice(2, 4)}/${ym.slice(5, 7)}` : "");
  return `${f(from)}–${f(to)}`;
}

/** 月の並び "2026-04".."2026-10" を "2026年4月〜10月"（年が同じなら年は1回）で */
export function monthSpanJa(months) {
  if (!months || months.length === 0) return T.common.none;
  const a = months[0];
  const b = months[months.length - 1];
  if (a === b) return monthJa(a);
  if (a.slice(0, 4) === b.slice(0, 4)) return fmt(T.format.monthRangeSameYear, { from: monthJa(a), toMonth: Number(b.slice(5, 7)) });
  return fmt(T.format.monthRange, { from: monthJa(a), to: monthJa(b) });
}

/** 期間 "2026-04〜2027-03" を "2026年4月〜2027年3月" で */
export function periodJa(period) {
  if (!period) return EMPTY_VALUE;
  return fmt(T.format.monthRange, { from: monthJa(period.from), to: monthJa(period.to) });
}

/** "2026-10-27" はそのまま（UI でも ISO 日付を使う） */
export function dateIso(iso) {
  return typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : EMPTY_VALUE;
}

/** ISO 日時 → "2026-10-27 09:00"（日本時間） */
export function dateTimeJst(iso) {
  if (typeof iso !== "string" || iso === "") return EMPTY_VALUE;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

export function fiscalYearLabel(fy) {
  return `FY${fy}`;
}

export const METHOD_LABELS = T.methods.labels;

/** 文言の {n} は直近何か月で平均するか。methodDescription(m, n) で差し込む */
export const METHOD_DESCRIPTIONS = T.methods.descriptions;

export function methodDescription(method, recentMonths) {
  return fmt(METHOD_DESCRIPTIONS[method], { n: recentMonths });
}

export const STATUS_LABELS = T.monthStatus;

export const WARNING_LABELS = T.warnings;

export const UNMAPPED_REASON_LABELS = T.unmappedReasons;

/** 粗利の黒字/赤字 */
export function profitLabel(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return EMPTY_VALUE;
  return value < 0 ? T.common.deficit : T.common.surplus;
}
