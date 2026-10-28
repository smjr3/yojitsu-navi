/**
 * 期待値の計算: data/ を読んで計算コア（src/core）で Model を作り、画面と同じ関数で集計する。
 * 画面が読む dist/data/model.json と同じ asOf（AS_OF）で作るので、表示値は core の値と一致しなければならない。
 */
import {
  UNASSIGNED_TEAM_ID,
  addMonths,
  aggregate,
  buildModel,
  contractsForTeam,
  fiscalYearMonths,
  forecastTotals,
  formatPercent,
  formatYen,
  teamTreeForMonth,
  type ContractResult,
  type ForecastMethod,
  type Model,
  type Period,
  type TeamNode,
  type Totals,
} from "../../../src/core/index.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDataset } from "../../../scripts/lib/load.js";
import { AS_OF, ROOT_DIR } from "../constants.js";

export { UNASSIGNED_TEAM_ID, aggregate, forecastTotals, formatPercent, formatYen };
export type { ContractResult, ForecastMethod, Model, Period, Totals };

/** 画面の単位 ID: "m"（百万円）| "k"（千円）| "yen"（円）。src/components/format.js の UNITS と同じ */
export type Unit = "yen" | "k" | "m";

const UNIT_BY_CORE = { millionYen: "m", thousandYen: "k", yen: "yen" } as const;
const CORE_BY_UNIT = { m: "millionYen", k: "thousandYen", yen: "yen" } as const;
export const UNIT_LABEL: Record<Unit, string> = { m: "百万円", k: "千円", yen: "円" };

let cached: Model | null = null;

/** data/ から Model を作る（ワーカーごとに 1 回） */
export function getModel(): Model {
  if (!cached) {
    const parsed = loadDataset(ROOT_DIR);
    cached = buildModel(parsed.dataset, { asOf: AS_OF });
  }
  return cached;
}

/** 画面の既定期間（asOf の年度） */
export function fiscalPeriod(model: Model = getModel()): Period {
  const months = model.meta.fiscalYearMonths;
  return { from: months[0]!, to: months[months.length - 1]! };
}

/** 期間プリセット（filters.js と同じ定義） */
export function presetPeriod(id: "fy" | "prevFy" | "thisMonth" | "recent3" | "recent12", model: Model = getModel()): Period {
  const { meta, config } = model;
  const clamp = (m: string) => (m < meta.minMonth ? meta.minMonth : m > meta.maxMonth ? meta.maxMonth : m);
  const clip = (months: readonly string[]): Period => ({ from: clamp(months[0]!), to: clamp(months[months.length - 1]!) });
  switch (id) {
    case "fy":
      return clip(fiscalYearMonths(meta.fiscalYear, config.fiscalYearStartMonth));
    case "prevFy":
      return clip(fiscalYearMonths(meta.fiscalYear - 1, config.fiscalYearStartMonth));
    case "thisMonth":
      return clip([meta.asOfMonth, meta.asOfMonth]);
    case "recent3":
      return clip([addMonths(meta.asOfMonth, -2), meta.asOfMonth]);
    case "recent12":
      return clip([addMonths(meta.asOfMonth, -11), meta.asOfMonth]);
  }
}

/**
 * 画面の既定の表示単位。config.json の currency.defaultUnit から導く（将来の既定変更に追従する）。
 * 数値を厳密に突き合わせるテストは、これに頼らず URL に unit=yen を明示すること。
 */
export const DEFAULT_UNIT: Unit = UNIT_BY_CORE[getModel().config.currency?.defaultUnit as keyof typeof UNIT_BY_CORE] ?? "m";

/**
 * 画面と同じ金額書式。unit 省略 = 円（計算根拠パネル（dialog）・Excel の金額は常に円）。
 * 画面の表（既定単位）と比べるときは yen(v, DEFAULT_UNIT) のように単位を明示する。
 */
export function yen(value: number | null | undefined, unit: Unit = "yen"): string {
  return formatYen(value, CORE_BY_UNIT[unit]);
}

/** 期間の終了月時点の組織木（analysis.treeAt と同じ） */
export function treeAt(month: string, model: Model = getModel()): Record<string, TeamNode> {
  return teamTreeForMonth({ teams: model.teams }, month);
}

/** チーム（配下含む）の契約ID。teamId が空なら undefined（= 全契約） */
export function teamContractIds(teamId: string, period: Period, model: Model = getModel()): string[] | undefined {
  if (!teamId) return undefined;
  return contractsForTeam(model, teamId, treeAt(period.to, model)).map((c) => c.contractId);
}

export function totalsFor(period: Period, contractIds?: readonly string[], model: Model = getModel()): Totals {
  return contractIds ? aggregate(model, { period, contractIds }) : aggregate(model, { period });
}

export function forecastFor(method: ForecastMethod, contractIds?: readonly string[], model: Model = getModel()) {
  return forecastTotals(model, contractIds, method);
}

export function contractResult(id: string, model: Model = getModel()): ContractResult {
  const r = model.contracts.find((x) => x.contract.contractId === id);
  if (!r) throw new Error(`contract ${id} not in model`);
  return r;
}

/** 契約一覧に出る契約（期間に 1 か月以上掛かるもの）。並びは model 順 */
export function contractsInPeriod(period: Period, contractIds?: readonly string[], model: Model = getModel()): ContractResult[] {
  const set = contractIds ? new Set(contractIds) : null;
  return model.contracts.filter((r) => (!set || set.has(r.contract.contractId)) && r.months.some((m) => period.from <= m.month && m.month <= period.to));
}

/** 契約一覧の 1 行の期待値（analysis.contractRow と同じ定義） */
export function contractRowExpected(r: ContractResult, period: Period, method: ForecastMethod, model: Model = getModel()) {
  const totals = aggregate(model, { period, contractIds: [r.contract.contractId] });
  const f = r.forecasts[method];
  const forecastGrossProfit = f.fyBudget === 0 && f.breakdown.contractMonthsInFY.length === 0 ? null : f.forecastGrossProfit;
  return { totals, forecast: f, forecastGrossProfit, isDeficit: f.isDeficit, isOverBudget: totals.isOverBudget, includesPreliminary: totals.includesPreliminary };
}
