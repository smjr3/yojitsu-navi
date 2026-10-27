/**
 * 表示用の書式（計算コア money.ts のラッパ ＋ 単位切替 ＋ 日付・月・ラベル）
 *
 * 画面側の単位は "yen" | "k"（千円）。計算コアの MoneyUnit（"yen" | "thousandYen"）へ変換する。
 */
import { EMPTY_VALUE, formatHours, formatPercent, formatPersonMonths, formatYen } from "../core/index.js";

export { EMPTY_VALUE, formatHours, formatPercent, formatPersonMonths };

export const UNITS = [
  { id: "yen", label: "円", coreUnit: "yen" },
  { id: "k", label: "千円", coreUnit: "thousandYen" },
];

export function toCoreUnit(unit) {
  return unit === "k" ? "thousandYen" : "yen";
}

/** 金額（円の整数）を選択中の単位で表示 */
export function money(yen, unit = "yen") {
  return formatYen(yen, toCoreUnit(unit));
}

/** 符号付き金額（差分表示用）。0 は "±0円" */
export function moneySigned(yen, unit = "yen") {
  if (typeof yen !== "number" || !Number.isFinite(yen)) return EMPTY_VALUE;
  const body = money(Math.abs(yen), unit);
  if (unit === "k" ? Math.round(yen / 1000) === 0 : Math.round(yen) === 0) return `±${body}`;
  return `${yen < 0 ? "−" : "+"}${body}`;
}

/** 割合の差（ポイント）。0.012 → "+1.2pt" */
export function pointsSigned(delta, digits = 1) {
  if (typeof delta !== "number" || !Number.isFinite(delta)) return EMPTY_VALUE;
  const v = delta * 100;
  const s = new Intl.NumberFormat("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Math.abs(v));
  if (Number(s) === 0) return `±${s}pt`;
  return `${v < 0 ? "−" : "+"}${s}pt`;
}

/** 軸ラベル用の短い金額（百万円） */
export function millions(yen) {
  if (typeof yen !== "number" || !Number.isFinite(yen)) return EMPTY_VALUE;
  return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 }).format(yen / 1e6);
}

/** 整数のカンマ区切り */
export function integer(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return EMPTY_VALUE;
  return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 }).format(n);
}

/** 小数（最大 digits 桁） */
export function decimal(n, digits = 2) {
  if (typeof n !== "number" || !Number.isFinite(n)) return EMPTY_VALUE;
  return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: digits }).format(n);
}

/** "2026-10" → "2026年10月" */
export function monthJa(ym) {
  if (typeof ym !== "string" || !/^\d{4}-\d{2}$/.test(ym)) return EMPTY_VALUE;
  return `${ym.slice(0, 4)}年${Number(ym.slice(5, 7))}月`;
}

/** "2026-10" → "10月"（軸などの短い表示。1月と最初の点には年を付ける） */
export function monthShort(ym, withYear = false) {
  if (typeof ym !== "string" || !/^\d{4}-\d{2}$/.test(ym)) return "";
  const m = Number(ym.slice(5, 7));
  return withYear || m === 1 ? `${ym.slice(2, 4)}/${m}` : `${m}月`;
}

/** 契約期間の短い表記 "26/04–27/03"（title に正式表記を入れて使う） */
export function periodCompact(from, to) {
  const f = (ym) => (typeof ym === "string" && ym.length >= 7 ? `${ym.slice(2, 4)}/${ym.slice(5, 7)}` : "");
  return `${f(from)}–${f(to)}`;
}

/** 月の並び "2026-04".."2026-10" を "2026年4月〜10月"（年が同じなら年は1回）で */
export function monthSpanJa(months) {
  if (!months || months.length === 0) return "なし";
  const a = months[0];
  const b = months[months.length - 1];
  if (a === b) return monthJa(a);
  if (a.slice(0, 4) === b.slice(0, 4)) return `${monthJa(a)}〜${Number(b.slice(5, 7))}月`;
  return `${monthJa(a)}〜${monthJa(b)}`;
}

/** 期間 "2026-04〜2027-03" を "2026年4月〜2027年3月" で */
export function periodJa(period) {
  if (!period) return EMPTY_VALUE;
  return `${monthJa(period.from)}〜${monthJa(period.to)}`;
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

export const METHOD_LABELS = {
  recent3: "直近実績",
  all: "全期間平均",
  assignment: "アサイン計画",
};

export const METHOD_DESCRIPTIONS = {
  recent3: "直近 N か月の原価平均 × 残り月数（N は計算ルール参照）",
  all: "契約開始から前月までの原価平均 × 残り月数",
  assignment: "残り月のアサイン配分 × 標準時間 × 単価",
};

export const STATUS_LABELS = {
  final: "確定",
  preliminary: "速報",
  future: "予定",
  outside: "期間外",
};

export const WARNING_LABELS = {
  UNMAPPED_WORKLOG: "未紐付け工数",
  WORKLOG_OUT_OF_CONTRACT_PERIOD: "契約期間外の工数",
  RATE_MISSING: "単価なし",
  UNKNOWN_MEMBER: "不明メンバー",
  UNKNOWN_TEAM: "チーム階層の問題",
  ALLOCATION_OVER_1: "配分の超過",
  CONTRACT_INVALID: "契約の不備",
  DUPLICATE_CONTRACT_ID: "契約IDの重複",
  MAPPING_UNKNOWN_CONTRACT: "紐付け先の契約がない",
  MAPPING_AMBIGUOUS: "紐付け先が複数",
  EXCLUDED_NO_CUSTOMER: "顧客名なしで除外",
};

export const UNMAPPED_REASON_LABELS = {
  NO_RULE: "紐付けルールなし",
  OUT_OF_PERIOD: "契約期間外",
  UNKNOWN_CONTRACT: "契約IDが存在しない",
};

/** 粗利の黒字/赤字 */
export function profitLabel(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return EMPTY_VALUE;
  return value < 0 ? "赤字" : "黒字";
}
