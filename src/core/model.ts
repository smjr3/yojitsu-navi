/**
 * 計算コアの入口: Dataset → Model（SPEC 全体）
 *
 * 純粋関数。同じ Dataset と asOf からは常に同じ Model が得られる
 * （meta.generatedAt のみ options.generatedAt で固定できる）。
 */
import { partitionContracts, monthlyBudget } from "./budget.js";
import { addMonths, businessDaysInMonth, isValidISODate, isValidYearMonth, monthOfDate, monthRange, fiscalYearMonths, fiscalYearOf } from "./calendar.js";
import { HolidaySet } from "./holidays.js";
import { computeMonthCost, createLaborProvider, indexWorklogs, type CostProvider } from "./cost.js";
import { assignmentPlanOf, forecastAllMethodsForMonths, type ForecastContext } from "./forecast.js";
import { mapWorklogs, type WorklogMapping } from "./mapping.js";
import { customerKey } from "./customers.js";
import { createTaskNameExtractor } from "./taskFromName.js";
import { projectMatcherFor } from "./projectFromTask.js";
import { findTaskCodeIssues, taskCodeWarnings } from "./taskCodes.js";
import { createMasterIndex, memberAt, teamTreeAt, workedMonthKeys, type MasterIndex } from "./masters.js";
import { buildMemberMonths } from "./members.js";
import { lastFinalMonth, monthStatus, type StatusContext } from "./status.js";
import { buildWorkRows, createTaskClassifier, isOutsideWorklog, keywordUnmatchedGroups, outsideInputs, planOutsideTypes, unclassifiedTaskWarnings } from "./workTypes.js";
import type { Contract, ContractMonth, ContractResult, Dataset, ISODate, Model, UnknownMemberWork, Warning, YearMonth } from "./types.js";
import { T, fmt } from "../i18n/index.js";

export interface BuildModelOptions {
  /** 計算基準日 */
  asOf: ISODate;
  /** 計算基準日を固定したか（meta.asOfFixed に入れる。§75） */
  asOfFixed?: boolean;
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
  // holidays.csv に行の無い年は国民の祝日で補う（§49）
  const holidays = new HolidaySet(dataset.holidays);
  const statusCtx: StatusContext = { asOf, config, holidays };
  const masters = createMasterIndex(dataset);
  const warnings: Warning[] = [];

  // 契約の選別（§2）
  const partition = partitionContracts(dataset.contracts);
  warnings.push(...partition.warnings);
  const contracts = partition.valid;

  // 作業種別の分類（§30）: 契約外は契約の実績に入れない（関連契約だけ調べ、警告は出さない）。
  // 紐付けルールに作業名のキーワードがあれば、合致しない作業も運用保守以外にする（§62）
  // 作業名から抜き出した案件名での紐付け（§97）
  const projects = projectMatcherFor(dataset);
  const classifier = createTaskClassifier(dataset.taskTypes, dataset.mappings, projects, createTaskNameExtractor(dataset.config));
  const inScopeLogs = classifier.enabled ? dataset.worklogs.filter((w) => !isOutsideWorklog(w, classifier)) : dataset.worklogs;
  const outsideLogs = classifier.enabled ? dataset.worklogs.filter((w) => isOutsideWorklog(w, classifier)) : [];
  const excludedContracts = new Map(partition.excluded.map((e) => [e.contract.contractId, e.reason]));

  // 紐付け（§4）
  const mapping = mapWorklogs(inScopeLogs, dataset.mappings, contracts, excludedContracts, projects);
  warnings.push(...mapping.warnings);
  warnings.push(...unclassifiedTaskWarnings(mapping.mappings.filter((m) => m.kind === "assigned" || m.kind === "unmapped").map((m) => m.worklog), classifier));
  const outsideMapping = outsideLogs.length > 0 ? mapWorklogs(outsideLogs, dataset.mappings, contracts, excludedContracts, projects).mappings : [];
  const worklogIndex = indexWorklogs(mapping.assigned);
  // 作業コードの点検（§92）: 未登録・作業名の変更。見つけるだけで案件は決めない
  const taskCodeFindings = findTaskCodeIssues(dataset.worklogs, dataset.mappings, config.taskCodeCheck, projects);
  warnings.push(...taskCodeWarnings(taskCodeFindings));

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
  const forecastFiscalYear = fiscalYearOf(asOfMonth, config.fiscalYearStartMonth);
  const forecastBasis = { asOfMonth, fiscalYear: forecastFiscalYear, forecastRecentMonths: config.forecastRecentMonths };
  const fyMonthsForForecast = fiscalYearMonths(forecastFiscalYear, config.fiscalYearStartMonth);

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
    const assignmentPlan = assignmentPlanOf(forecastCtx, contract);
    const forecasts = forecastAllMethodsForMonths(forecastBasis, contract, months, assignmentPlan, fyMonthsForForecast);
    return { contract, months, forecasts, assignmentPlan };
  });

  warnings.push(...collectRateWarnings(results, masters));
  const outsideIn = outsideInputs(outsideMapping);

  // チーム階層（asOf 月）
  const team = teamTreeAt(dataset, asOfMonth);
  warnings.push(...team.warnings);

  // メタ情報
  const fiscalYear = fiscalYearOf(asOfMonth, config.fiscalYearStartMonth);
  // 選べる期間 = 契約の期間 ＋ 運用保守以外の予定・実績の月（契約の外の月の予定もメンバー別で見られるように。§50）
  const outsideMonths: YearMonth[] = outsideIn.map((o) => o.month);
  for (const o of dataset.outsidePlans ?? []) {
    if (isValidYearMonth(o.startMonth) && isValidYearMonth(o.endMonth) && o.startMonth <= o.endMonth) outsideMonths.push(o.startMonth, o.endMonth);
  }
  const spanStarts = [...contracts.map((c) => c.startMonth), ...outsideMonths];
  const spanEnds = [...contracts.map((c) => c.endMonth), ...outsideMonths];
  const minMonth = spanStarts.reduce<YearMonth>((min, m) => (m < min ? m : min), spanStarts[0] ?? asOfMonth);
  const maxMonth = spanEnds.reduce<YearMonth>((max, m) => (m > max ? m : max), spanEnds[0] ?? asOfMonth);
  const priorYearCutoff = addMonths(asOfMonth, -12);
  const hasPriorYearData = results.some((r) =>
    r.months.some((m) => m.status === "final" && m.month <= priorYearCutoff && (m.cost > 0 || m.budget > 0)),
  );

  const lastFinal = lastFinalMonth(statusCtx);
  if (holidays.filledYears.size > 0) {
    const years = [...holidays.filledYears].sort((a, b) => a - b);
    warnings.push({ code: "HOLIDAYS_AUTO", message: fmt(T.calcWarnings.holidaysAuto, { years: years.join("・") }), ref: { years: years.join(",") } });
  }

  return {
    meta: {
      asOf,
      ...(options.asOfFixed ? { asOfFixed: true } : {}),
      asOfMonth,
      lastFinalMonth: lastFinal,
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
    // 作業実績のある「メンバー|月」（§35。リソース計画で、編集中の台帳の不在した月を稼働とみなすかの判定に使う）
    worklogMonths: [...workedMonthKeys({ worklogs: dataset.worklogs })].sort(),
    // 運用保守以外の実績がある「メンバー|月|種別」（§50.3。リソース計画で、その人に出す種別の行を決める）
    outsideWorkMonths: [...new Set(outsideIn.filter((o) => o.worklog.hours > 0).map((o) => `${o.worklog.memberId}|${o.month}|${classifier.classifyWorklog(o.worklog).group}`))].sort(),
    teams: dataset.teams,
    holidays: dataset.holidays,
    warnings,
    unmapped: mapping.unmapped,
    keywordUnmatched: keywordUnmatchedGroups(outsideLogs, classifier),
    unregisteredTaskCodes: taskCodeFindings.unregistered,
    taskCodeChanges: taskCodeFindings.changes,
    unknownMembers: unknownMemberWork(mapping.mappings, outsideMapping, masters, contracts),
    excludedHours: mapping.excludedHours,
    // メンバー別の計画と実績（§18.1）
    memberMonths: buildMemberMonths(results, dataset.assignments, masters, config.standardHoursPerMonth, {
      plans: dataset.outsidePlans ?? [],
      actuals: outsideIn.map((o) => ({ memberId: o.worklog.memberId, memberName: o.worklog.memberName, month: o.month, type: classifier.classifyWorklog(o.worklog).group, hours: o.worklog.hours })),
    }),
    // 工数の明細（§30.2）
    workRows: buildWorkRows(results, outsideIn, classifier, masters),
    outsideTypes: planOutsideTypes(dataset.taskTypes, classifier.enabled),
    targets: dataset.targets ?? [],
  };
}

/**
 * メンバーマスタに無い社員番号の作業をまとめる（§100）。案件の実績（0 円）・運用保守以外・未紐付けのすべてを見る。
 * 除外（顧客名なし）・不正な行は数えない。時間の多い順
 */
export function unknownMemberWork(mappings: readonly WorklogMapping[], outsideMappings: readonly WorklogMapping[], masters: MasterIndex, contracts: readonly Contract[]): UnknownMemberWork[] {
  const contractById = new Map(contracts.map((c) => [c.contractId, c]));
  const acc = new Map<string, UnknownMemberWork & { byCustomer: Map<string, { name: string; hours: number }> }>();
  // 運用保守以外の「紐付き」は関連契約にすぎず案件の実績に入らないので、うち運用保守には数えない
  const all = [...mappings.map((m) => ({ m, outside: false })), ...outsideMappings.map((m) => ({ m, outside: true }))];
  for (const { m, outside } of all) {
    if (m.kind === "ignored" || m.kind === "excluded") continue;
    const w = m.worklog;
    const id = (w.memberId ?? "").trim();
    if (masters.members.has(id)) continue;
    let u = acc.get(id);
    if (!u) {
      u = { memberId: id, memberName: (w.memberName ?? "").trim(), hours: 0, contractHours: 0, count: 0, firstDate: w.date as ISODate, lastDate: w.date as ISODate, customers: [], byCustomer: new Map() };
      acc.set(id, u);
    }
    u.hours += w.hours;
    u.count += 1;
    if (w.date < u.firstDate) u.firstDate = w.date as ISODate;
    if (w.date > u.lastDate) u.lastDate = w.date as ISODate;
    const contract = m.kind === "assigned" ? contractById.get(m.contractId) : undefined;
    if (contract && !outside) u.contractHours += w.hours;
    const name = contract ? contract.customerName : w.customerName.trim();
    const key = customerKey(name);
    const c = u.byCustomer.get(key);
    if (c) c.hours += w.hours;
    else u.byCustomer.set(key, { name, hours: w.hours });
  }
  return [...acc.values()]
    .map(({ byCustomer, ...u }) => ({ ...u, customers: [...byCustomer.values()].sort((a, b) => b.hours - a.hours || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) }))
    .sort((a, b) => b.hours - a.hours || (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
}

/**
 * 単価なし（RATE_MISSING: 社員番号・月ごとに 1 件、時間合算）と
 * 未知メンバー（UNKNOWN_MEMBER: 社員番号ごとに 1 件）の警告を原価行から集める。
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
      // メンバーの effective_from より前の作業は役職が決まらず単価が引けない。原因が分かる文言にする
      message: fmt(memberAt(masters, m.memberId, m.month) === null ? T.calcWarnings.rateMissingBeforeMember : T.calcWarnings.rateMissing, { month: m.month, memberId: m.memberId, memberName: m.memberName, hours: m.hours }),
      ref: { memberId: m.memberId, month: m.month },
      hours: m.hours,
    });
  }
  return warnings;
}
