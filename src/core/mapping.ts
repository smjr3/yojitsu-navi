/**
 * 作業実績と契約の紐付け（SPEC §4.2）
 */
import { isValidISODate, monthOfDate } from "./calendar.js";
import { normalizeName } from "./normalize.js";
import type { Contract, ISODate, MappingRule, UnmappedWorklogGroup, Warning, Worklog, YearMonth } from "./types.js";
import { T, fmt } from "../i18n/index.js";

export type UnmappedReason = UnmappedWorklogGroup["reason"];

/** 作業ログ 1 行ごとの紐付け結果 */
export type WorklogMapping =
  | { kind: "assigned"; worklog: Worklog; month: YearMonth; contractId: string }
  | { kind: "unmapped"; worklog: Worklog; month: YearMonth; reason: UnmappedReason }
  | { kind: "excluded"; worklog: Worklog; month: YearMonth; reason: "NO_CUSTOMER" }
  | { kind: "ignored"; worklog: Worklog; reason: "INVALID_HOURS" | "INVALID_DATE" };

export interface MappingResult {
  /** 入力と同じ順序・同じ件数 */
  mappings: WorklogMapping[];
  /** 契約に紐付いた行のみ */
  assigned: Array<Extract<WorklogMapping, { kind: "assigned" }>>;
  /** 未紐付けを (顧客名, 案件名) の元の表記でまとめたもの */
  unmapped: UnmappedWorklogGroup[];
  warnings: Warning[];
  /** 顧客名なしで除外した時間の合計 */
  excludedHours: number;
  /** hours が 0 以下・数値でない、日付不正で無視した件数 */
  ignoredCount: number;
}

interface RuleTarget {
  /** 存在する契約（契約ID昇順） */
  contracts: Contract[];
  /** 存在しない契約IDを指すルールがあった */
  hasUnknownContract: boolean;
  /** 不備で除外中の契約を指すルールがあった（「存在しない」と区別する） */
  hasExcludedContract: boolean;
}

function ruleKey(customer: string, project: string): string {
  return `${customer}\u0000${project}`;
}

/** 正規化キー → ルールの指す契約一覧。存在しない契約IDには MAPPING_UNKNOWN_CONTRACT 警告 */
function buildRuleIndex(
  rules: readonly MappingRule[],
  contractsById: ReadonlyMap<string, Contract>,
  warnings: Warning[],
  excludedContracts: ReadonlyMap<string, string>,
): Map<string, RuleTarget> {
  const index = new Map<string, RuleTarget>();
  rules.forEach((rule, i) => {
    const key = ruleKey(normalizeName(rule.worklogCustomerName), normalizeName(rule.worklogProjectName));
    let target = index.get(key);
    if (!target) {
      target = { contracts: [], hasUnknownContract: false, hasExcludedContract: false };
      index.set(key, target);
    }
    const contract = contractsById.get(rule.contractId);
    const excludedReason = excludedContracts.get(rule.contractId);
    if (!contract && excludedReason !== undefined) {
      target.hasExcludedContract = true;
      warnings.push({
        code: "MAPPING_EXCLUDED_CONTRACT",
        message: fmt(T.calcWarnings.mappingExcludedContract, { row: i + 2, customer: rule.worklogCustomerName, project: rule.worklogProjectName, contractId: rule.contractId, reason: excludedReason }),
        ref: { row: i + 2, customerName: rule.worklogCustomerName, projectName: rule.worklogProjectName, contractId: rule.contractId },
      });
      return;
    }
    if (!contract) {
      target.hasUnknownContract = true;
      warnings.push({
        code: "MAPPING_UNKNOWN_CONTRACT",
        message: fmt(T.calcWarnings.mappingUnknownContract, { row: i + 2, customer: rule.worklogCustomerName, project: rule.worklogProjectName, contractId: rule.contractId }),
        ref: { row: i + 2, customerName: rule.worklogCustomerName, projectName: rule.worklogProjectName, contractId: rule.contractId },
      });
      return;
    }
    if (!target.contracts.some((c) => c.contractId === contract.contractId)) target.contracts.push(contract);
  });
  for (const target of index.values()) {
    target.contracts.sort((a, b) => (a.contractId < b.contractId ? -1 : a.contractId > b.contractId ? 1 : 0));
  }
  return index;
}

interface AmbiguousAcc {
  customerName: string;
  projectName: string;
  contractIds: Set<string>;
  chosen: string;
  hours: number;
  count: number;
}

/**
 * 作業ログを契約に紐付ける。
 * @param contracts 計算対象の（妥当な）契約。重複・不正契約は呼び出し側で除いておく
 */
export function mapWorklogs(
  worklogs: readonly Worklog[],
  rules: readonly MappingRule[],
  contracts: readonly Contract[],
  /** 不備で除外した契約ID → 理由。指すルールを「存在しない契約」と区別するため */
  excludedContracts: ReadonlyMap<string, string> = new Map(),
): MappingResult {
  const warnings: Warning[] = [];
  const contractsById = new Map<string, Contract>();
  for (const c of contracts) contractsById.set(c.contractId, c);
  const ruleIndex = buildRuleIndex(rules, contractsById, warnings, excludedContracts);

  const mappings: WorklogMapping[] = [];
  const assigned: MappingResult["assigned"] = [];
  const unmappedGroups = new Map<string, UnmappedWorklogGroup>();
  const ambiguous = new Map<string, AmbiguousAcc>();
  let excludedHours = 0;
  let excludedCount = 0;
  let ignoredCount = 0;

  const addUnmapped = (w: Worklog, reason: UnmappedReason): void => {
    const key = `${w.customerName}\u0000${w.projectName}\u0000${reason}`;
    const g = unmappedGroups.get(key);
    if (g) {
      g.hours += w.hours;
      g.count += 1;
      if (w.date < g.firstDate) g.firstDate = w.date;
      if (w.date > g.lastDate) g.lastDate = w.date;
    } else {
      unmappedGroups.set(key, {
        customerName: w.customerName,
        projectName: w.projectName,
        hours: w.hours,
        count: 1,
        firstDate: w.date as ISODate,
        lastDate: w.date as ISODate,
        reason,
      });
    }
  };

  for (const w of worklogs) {
    if (typeof w.hours !== "number" || !Number.isFinite(w.hours) || w.hours <= 0) {
      mappings.push({ kind: "ignored", worklog: w, reason: "INVALID_HOURS" });
      ignoredCount++;
      continue;
    }
    if (!isValidISODate(w.date)) {
      mappings.push({ kind: "ignored", worklog: w, reason: "INVALID_DATE" });
      ignoredCount++;
      continue;
    }
    const month = monthOfDate(w.date);
    const customer = normalizeName(w.customerName);
    if (customer === "") {
      mappings.push({ kind: "excluded", worklog: w, month, reason: "NO_CUSTOMER" });
      excludedHours += w.hours;
      excludedCount++;
      continue;
    }
    const project = normalizeName(w.projectName);
    // (顧客, 案件) の完全一致 → 無ければ (顧客, "")
    const target = ruleIndex.get(ruleKey(customer, project)) ?? ruleIndex.get(ruleKey(customer, ""));
    if (!target) {
      mappings.push({ kind: "unmapped", worklog: w, month, reason: "NO_RULE" });
      addUnmapped(w, "NO_RULE");
      continue;
    }
    if (target.contracts.length === 0) {
      // ルールはあるが、指す契約がすべて存在しない（または不備で除外中）
      const reason: UnmappedReason = target.hasExcludedContract ? "EXCLUDED_CONTRACT" : "UNKNOWN_CONTRACT";
      mappings.push({ kind: "unmapped", worklog: w, month, reason });
      addUnmapped(w, reason);
      continue;
    }
    const inPeriod = target.contracts.filter((c) => c.startMonth <= month && month <= c.endMonth);
    if (inPeriod.length === 0) {
      mappings.push({ kind: "unmapped", worklog: w, month, reason: "OUT_OF_PERIOD" });
      addUnmapped(w, "OUT_OF_PERIOD");
      continue;
    }
    const chosen = inPeriod[0] as Contract; // 契約ID昇順の先頭
    if (inPeriod.length > 1) {
      const key = `${customer}\u0000${project}\u0000${chosen.contractId}`;
      const acc = ambiguous.get(key);
      if (acc) {
        acc.hours += w.hours;
        acc.count += 1;
        for (const c of inPeriod) acc.contractIds.add(c.contractId);
      } else {
        ambiguous.set(key, {
          customerName: w.customerName,
          projectName: w.projectName,
          contractIds: new Set(inPeriod.map((c) => c.contractId)),
          chosen: chosen.contractId,
          hours: w.hours,
          count: 1,
        });
      }
    }
    const m: Extract<WorklogMapping, { kind: "assigned" }> = { kind: "assigned", worklog: w, month, contractId: chosen.contractId };
    mappings.push(m);
    assigned.push(m);
  }

  if (excludedCount > 0) {
    warnings.push({
      code: "EXCLUDED_NO_CUSTOMER",
      message: fmt(T.calcWarnings.excludedNoCustomer, { count: excludedCount, hours: excludedHours }),
      hours: excludedHours,
      count: excludedCount,
    });
  }
  for (const acc of ambiguous.values()) {
    const ids = [...acc.contractIds].sort();
    warnings.push({
      code: "MAPPING_AMBIGUOUS",
      message: fmt(T.calcWarnings.mappingAmbiguous, { customer: acc.customerName, project: acc.projectName, count: acc.count, hours: acc.hours, candidates: ids.join(", "), chosen: acc.chosen }),
      ref: { customerName: acc.customerName, projectName: acc.projectName, contractId: acc.chosen, candidates: ids.join(",") },
      hours: acc.hours,
      count: acc.count,
    });
  }
  const unmapped = [...unmappedGroups.values()];
  for (const g of unmapped) {
    warnings.push({
      code: "UNMAPPED_WORKLOG",
      message: fmt(T.calcWarnings.unmappedWorklog, { customer: g.customerName, project: g.projectName, count: g.count, hours: g.hours, firstDate: g.firstDate, lastDate: g.lastDate, reason: unmappedReasonLabel(g.reason) }),
      ref: { customerName: g.customerName, projectName: g.projectName, reason: g.reason },
      hours: g.hours,
      count: g.count,
    });
  }

  return { mappings, assigned, unmapped, warnings, excludedHours, ignoredCount };
}

/** 未紐付け理由の表示名 */
export function unmappedReasonLabel(reason: UnmappedReason): string {
  switch (reason) {
    case "NO_RULE":
      return T.calcWarnings.reasonNoRule;
    case "OUT_OF_PERIOD":
      return T.calcWarnings.reasonOutOfPeriod;
    case "UNKNOWN_CONTRACT":
      return T.calcWarnings.reasonUnknownContract;
    case "EXCLUDED_CONTRACT":
      return T.calcWarnings.reasonExcludedContract;
  }
}
