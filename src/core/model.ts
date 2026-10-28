/**
 * 計算コアの入口: Dataset → Model（SPEC 全体）
 *
 * 純粋関数。同じ Dataset と asOf からは常に同じ Model が得られる
 * （meta.generatedAt のみ options.generatedAt で固定できる）。
 */
import { partitionContracts, monthlyBudget } from "./budget.js";
import { addMonths, businessDaysInMonth, isValidISODate, monthOfDate, monthRange, fiscalYearMonths, fiscalYearOf, toHolidaySet } from "./calendar.js";
import { computeMonthCost, createLaborProvider, indexWorklogs, type CostProvider } from "./cost.js";
import { forecastAllMethods, type ForecastContext } from "./forecast.js";
import { mapWorklogs } from "./mapping.js";
import { createMasterIndex, teamTreeAt, type MasterIndex } from "./masters.js";
import { buildMemberMonths } from "./members.js";
import { lastFinalMonth, monthStatus, type StatusContext } from "./status.js";
import type { ContractMonth, ContractResult, Dataset, ISODate, Model, Warning, YearMonth } from "./types.js";
import { T, fmt } from "../i18n/index.js";

export interface BuildModelOptions {
  /** 計算基準日 */
  asOf: ISODate;
  /** meta.generatedAt に入れる値。省略時は現在時刻（決定的にしたい場合は指定する） */
  generatedAt?: string;
  /** 追加の原価プロバイダ（labor 以外）。labor は常に組み込まれる */
  extraProviders?: (masters: MasterIndex) => CostProvider[];
}

/** Dataset から Model を組み立てる */
export function buildModel(dataset: Dataset, options: BuildModelOptions): Model {
  if (!isValidISODate(options.asOf)) throw new RangeError(`asOf が不正な日付です: ${options.asOf}`);
  const asOf = options.asOf;
  const asOfMonth = monthOfDate(asOf);
  const config = dataset.config;
  const holidays = toHolidaySet(dataset.holidays);
  const statusCtx: StatusContext = { asOf, config, holidays };
  const masters = createMasterIndex(dataset);
  const warnings: Warning[] = [];

  // 契約の選別（§2）
  const partition = partitionContracts(dataset.contracts);
  warnings.push(...partition.warnings);
  const contracts = partition.valid;

  // 紐付け（§4）
  const mapping = mapWorklogs(dataset.worklogs, dataset.mappings, contracts);
  warnings.push(...mapping.warnings);
  const worklogIndex = indexWorklogs(mapping.assigned);

  // 原価プロバイダ（§7）
  const providers: CostProvider[] = [createLaborProvider(masters, worklogIndex, "labor"), ...(options.extraProviders?.(masters) ?? [])];
  const costTypeIds = config.costTypes.map((t) => t.id);

  // 月ごとの状態・営業日は契約横断で共有できるのでキャッシュ
  const statusCache = new Map<YearMonth, ContractMonth["status"]>();
  const businessDaysCache = new Map<YearMonth, number>();
  const statusOf = (m: YearMonth): ContractMonth["status"] => {
    let s = statusCache.get(m);
    if (s === undefined) {
      s = monthStatus(m, statusCtx);
      statusCache.set(m, s);
    }
    return s;
  };
  const businessDaysOf = (m: YearMonth): number => {
    let d = businessDaysCache.get(m);
    if (d === undefined) {
      d = businessDaysInMonth(m, holidays);
      businessDaysCache.set(m, d);
    }
    return d;
  };

  const forecastCtx: ForecastContext = { asOfMonth, config, masters, assignments: dataset.assignments };

  const results: ContractResult[] = contracts.map((contract) => {
    const months: ContractMonth[] = monthRange(contract.startMonth, contract.endMonth).map((month) => {
      const { budget, breakdown } = monthlyBudget(contract, month);
      const mc = computeMonthCost(providers, costTypeIds, contract.contractId, month);
      return {
        contractId: contract.contractId,
        month,
        status: statusOf(month),
        budget,
        budgetBreakdown: breakdown,
        costs: mc.costs,
        cost: mc.cost,
        grossProfit: budget - mc.cost,
        hours: mc.hours,
        costLines: mc.costLines,
        worklogs: mc.worklogs,
        businessDays: businessDaysOf(month),
      };
    });
    return { contract, months, forecasts: forecastAllMethods(forecastCtx, contract, months) };
  });

  warnings.push(...collectRateWarnings(results, masters));

  // チーム階層（asOf 月）
  const team = teamTreeAt(dataset, asOfMonth);
  warnings.push(...team.warnings);

  // メタ情報
  const fiscalYear = fiscalYearOf(asOfMonth, config.fiscalYearStartMonth);
  const minMonth = contracts.reduce<YearMonth>((min, c) => (c.startMonth < min ? c.startMonth : min), contracts[0]?.startMonth ?? asOfMonth);
  const maxMonth = contracts.reduce<YearMonth>((max, c) => (c.endMonth > max ? c.endMonth : max), contracts[0]?.endMonth ?? asOfMonth);
  const priorYearCutoff = addMonths(asOfMonth, -12);
  const hasPriorYearData = results.some((r) =>
    r.months.some((m) => m.status === "final" && m.month <= priorYearCutoff && (m.cost > 0 || m.budget > 0)),
  );

  return {
    meta: {
      asOf,
      asOfMonth,
      lastFinalMonth: lastFinalMonth(statusCtx),
      fiscalYear,
      fiscalYearMonths: fiscalYearMonths(fiscalYear, config.fiscalYearStartMonth),
      minMonth,
      maxMonth,
      worklogFetchedAt: dataset.worklogFetchedAt ?? null,
      hasPriorYearData,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
    },
    config,
    contracts: results,
    teamTree: team.tree,
    rootTeamIds: team.rootTeamIds,
    members: dataset.members,
    teams: dataset.teams,
    holidays: dataset.holidays,
    warnings,
    unmapped: mapping.unmapped,
    excludedHours: mapping.excludedHours,
    // メンバー別の計画と実績（§18.1）
    memberMonths: buildMemberMonths(results, dataset.assignments, masters, config.standardHoursPerMonth),
  };
}

/**
 * 単価なし（RATE_MISSING: メンバーID・月ごとに 1 件、時間合算）と
 * 未知メンバー（UNKNOWN_MEMBER: メンバーIDごとに 1 件）の警告を原価行から集める。
 * 未知メンバーには RATE_MISSING を重ねて出さない。
 */
function collectRateWarnings(results: readonly ContractResult[], masters: MasterIndex): Warning[] {
  const missing = new Map<string, { memberId: string; memberName: string; month: YearMonth; hours: number }>();
  const unknown = new Map<string, { memberName: string; hours: number; count: number }>();
  for (const r of results) {
    for (const cm of r.months) {
      for (const line of cm.costLines) {
        if (!masters.members.has(line.memberId)) {
          const u = unknown.get(line.memberId);
          if (u) {
            u.hours += line.hours;
            u.count += 1;
          } else unknown.set(line.memberId, { memberName: line.memberName, hours: line.hours, count: 1 });
          continue;
        }
        if (!line.rateMissing) continue;
        const key = `${line.memberId}\u0000${cm.month}`;
        const acc = missing.get(key);
        if (acc) acc.hours += line.hours;
        else missing.set(key, { memberId: line.memberId, memberName: line.memberName, month: cm.month, hours: line.hours });
      }
    }
  }
  const warnings: Warning[] = [];
  for (const [memberId, u] of unknown) {
    warnings.push({
      code: "UNKNOWN_MEMBER",
      message: fmt(T.calcWarnings.unknownMember, { memberId, memberName: u.memberName, hours: u.hours }),
      ref: { memberId },
      hours: u.hours,
      count: u.count,
    });
  }
  for (const m of [...missing.values()].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.memberId < b.memberId ? -1 : 1))) {
    warnings.push({
      code: "RATE_MISSING",
      message: fmt(T.calcWarnings.rateMissing, { month: m.month, memberId: m.memberId, memberName: m.memberName, hours: m.hours }),
      ref: { memberId: m.memberId, month: m.month },
      hours: m.hours,
    });
  }
  return warnings;
}
