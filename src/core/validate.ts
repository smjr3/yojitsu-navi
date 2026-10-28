/**
 * データ検証（SPEC §14）
 *
 * error  = CI で止める（契約・マッピング・アサイン・チーム・メンバー・単価・形式）
 * warning = 止めずに表示（未紐付け工数、単価なし、未知メンバーの工数）
 */
import { contractInvalidReason } from "./budget.js";
import { isValidISODate, isValidYearMonth, monthOfDate, monthRange } from "./calendar.js";
import { mapWorklogs } from "./mapping.js";
import { createMasterIndex, rateFor, teamTreeAt } from "./masters.js";
import type { Dataset, YearMonth } from "./types.js";
import { T, fmt } from "../i18n/index.js";

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  file?: string;
  row?: number;
  ref?: Record<string, string | number>;
}

type IssueSink = (issue: ValidationIssue) => void;

/** 配列の添字からファイル行番号（ヘッダ = 1 行目） */
function rowOf(index: number): number {
  return index + 2;
}

function validateContracts(dataset: Dataset, push: IssueSink): void {
  const seen = new Set<string>();
  dataset.contracts.forEach((c, i) => {
    const file = "contracts.csv";
    const row = rowOf(i);
    if (c.contractId === "") push({ severity: "error", code: "CONTRACT_ID_EMPTY", message: fmt(T.checks.contractIdEmpty, { file, row }), file, row });
    if (seen.has(c.contractId)) {
      push({ severity: "error", code: "DUPLICATE_CONTRACT_ID", message: fmt(T.checks.duplicateContractId, { file, row, contractId: c.contractId }), file, row, ref: { contractId: c.contractId } });
    }
    seen.add(c.contractId);
    if (!isValidYearMonth(c.startMonth)) push({ severity: "error", code: "INVALID_MONTH", message: fmt(T.checks.contractStartMonthInvalid, { file, row, value: c.startMonth }), file, row, ref: { contractId: c.contractId } });
    if (!isValidYearMonth(c.endMonth)) push({ severity: "error", code: "INVALID_MONTH", message: fmt(T.checks.contractEndMonthInvalid, { file, row, value: c.endMonth }), file, row, ref: { contractId: c.contractId } });
    if (isValidYearMonth(c.startMonth) && isValidYearMonth(c.endMonth) && c.startMonth > c.endMonth) {
      push({ severity: "error", code: "CONTRACT_PERIOD_INVERTED", message: fmt(T.checks.contractPeriodInverted, { file, row, contractId: c.contractId, from: c.startMonth, to: c.endMonth }), file, row, ref: { contractId: c.contractId } });
    }
    if (typeof c.totalAmount !== "number" || !Number.isFinite(c.totalAmount)) {
      push({ severity: "error", code: "CONTRACT_AMOUNT_INVALID", message: fmt(T.checks.contractAmountNotNumber, { file, row, contractId: c.contractId }), file, row, ref: { contractId: c.contractId } });
    } else if (c.totalAmount < 0) {
      push({ severity: "error", code: "CONTRACT_AMOUNT_INVALID", message: fmt(T.checks.contractAmountNegative, { file, row, contractId: c.contractId, value: c.totalAmount }), file, row, ref: { contractId: c.contractId } });
    } else if (!Number.isInteger(c.totalAmount)) {
      push({ severity: "error", code: "CONTRACT_AMOUNT_INVALID", message: fmt(T.checks.contractAmountNotInteger, { file, row, contractId: c.contractId, value: c.totalAmount }), file, row, ref: { contractId: c.contractId } });
    }
  });
}

function validateMappings(dataset: Dataset, contractIds: ReadonlySet<string>, push: IssueSink): void {
  dataset.mappings.forEach((m, i) => {
    const file = "mapping.csv";
    const row = rowOf(i);
    if (!contractIds.has(m.contractId)) {
      push({ severity: "error", code: "MAPPING_UNKNOWN_CONTRACT", message: fmt(T.checks.mappingUnknownContract, { file, row, contractId: m.contractId }), file, row, ref: { contractId: m.contractId } });
    }
  });
}

function validateAssignments(dataset: Dataset, contractIds: ReadonlySet<string>, memberIds: ReadonlySet<string>, push: IssueSink): void {
  const file = "assignments.csv";
  const monthlyTotal = new Map<string, { memberId: string; month: YearMonth; total: number; rows: number[] }>();
  dataset.assignments.forEach((a, i) => {
    const row = rowOf(i);
    if (!memberIds.has(a.memberId)) push({ severity: "error", code: "ASSIGNMENT_UNKNOWN_MEMBER", message: fmt(T.checks.assignmentUnknownMember, { file, row, memberId: a.memberId }), file, row, ref: { memberId: a.memberId } });
    if (!contractIds.has(a.contractId)) push({ severity: "error", code: "ASSIGNMENT_UNKNOWN_CONTRACT", message: fmt(T.checks.assignmentUnknownContract, { file, row, contractId: a.contractId }), file, row, ref: { contractId: a.contractId } });
    const monthsOk = isValidYearMonth(a.startMonth) && isValidYearMonth(a.endMonth);
    if (!isValidYearMonth(a.startMonth)) push({ severity: "error", code: "INVALID_MONTH", message: fmt(T.checks.assignmentStartMonthInvalid, { file, row, value: a.startMonth }), file, row });
    if (!isValidYearMonth(a.endMonth)) push({ severity: "error", code: "INVALID_MONTH", message: fmt(T.checks.assignmentEndMonthInvalid, { file, row, value: a.endMonth }), file, row });
    if (monthsOk && a.startMonth > a.endMonth) push({ severity: "error", code: "ASSIGNMENT_PERIOD_INVERTED", message: fmt(T.checks.assignmentPeriodInverted, { file, row, from: a.startMonth, to: a.endMonth }), file, row });
    if (!Number.isFinite(a.allocation) || a.allocation < 0 || a.allocation > 1) {
      push({ severity: "error", code: "ALLOCATION_OUT_OF_RANGE", message: fmt(T.checks.allocationOutOfRange, { file, row, value: String(a.allocation) }), file, row, ref: { memberId: a.memberId, contractId: a.contractId } });
      return;
    }
    if (!monthsOk) return;
    for (const month of monthRange(a.startMonth, a.endMonth)) {
      const key = `${a.memberId}\u0000${month}`;
      const acc = monthlyTotal.get(key);
      if (acc) {
        acc.total += a.allocation;
        acc.rows.push(row);
      } else monthlyTotal.set(key, { memberId: a.memberId, month, total: a.allocation, rows: [row] });
    }
  });
  for (const acc of monthlyTotal.values()) {
    // 浮動小数の誤差（0.3+0.7 など）を許容
    if (acc.total > 1 + 1e-9) {
      push({ severity: "error", code: "ALLOCATION_OVER_1", message: fmt(T.checks.allocationOver1, { file, memberId: acc.memberId, month: acc.month, total: acc.total, rows: acc.rows.join(", ") }), file, row: acc.rows[0] as number, ref: { memberId: acc.memberId, month: acc.month, total: acc.total } });
    }
  }
}

function validateTeams(dataset: Dataset, teamIds: ReadonlySet<string>, memberIds: ReadonlySet<string>, push: IssueSink): void {
  const file = "masters/teams.csv";
  dataset.teams.forEach((t, i) => {
    const row = rowOf(i);
    if (t.teamId === "") push({ severity: "error", code: "TEAM_ID_EMPTY", message: fmt(T.checks.teamIdEmpty, { file, row }), file, row });
    if (!isValidYearMonth(t.effectiveFrom)) push({ severity: "error", code: "INVALID_MONTH", message: fmt(T.checks.teamEffectiveFromInvalid, { file, row, value: t.effectiveFrom }), file, row });
    if (t.parentTeamId !== null && t.parentTeamId !== "" && !teamIds.has(t.parentTeamId)) {
      push({ severity: "error", code: "TEAM_UNKNOWN_PARENT", message: fmt(T.checks.teamUnknownParent, { file, row, parentTeamId: t.parentTeamId }), file, row, ref: { teamId: t.teamId, parentTeamId: t.parentTeamId } });
    }
    if (t.leaderMemberId != null && t.leaderMemberId !== "" && !memberIds.has(t.leaderMemberId)) {
      push({ severity: "error", code: "TEAM_UNKNOWN_LEADER", message: fmt(T.checks.teamUnknownLeader, { file, row, leaderMemberId: t.leaderMemberId }), file, row, ref: { teamId: t.teamId, memberId: t.leaderMemberId } });
    }
  });
  // 循環: effective_from の各時点の組織で検出する
  const snapshots = [...new Set(dataset.teams.map((t) => t.effectiveFrom).filter(isValidYearMonth))].sort();
  const reported = new Set<string>();
  for (const month of snapshots) {
    for (const w of teamTreeAt(dataset, month).warnings) {
      if (typeof w.ref?.cycle !== "string") continue;
      if (reported.has(w.ref.cycle)) continue;
      reported.add(w.ref.cycle);
      push({ severity: "error", code: "TEAM_CYCLE", message: `${file}: ${w.message}`, file, ref: { cycle: w.ref.cycle, month } });
    }
  }
}

function validateMembers(dataset: Dataset, teamIds: ReadonlySet<string>, push: IssueSink): void {
  const file = "masters/members.csv";
  dataset.members.forEach((m, i) => {
    const row = rowOf(i);
    if (m.memberId === "") push({ severity: "error", code: "MEMBER_ID_EMPTY", message: fmt(T.checks.memberIdEmpty, { file, row }), file, row });
    if (m.kind !== "employee" && m.kind !== "partner") {
      push({ severity: "error", code: "MEMBER_KIND_INVALID", message: fmt(T.checks.memberKindInvalid, { file, row, memberId: m.memberId, value: String(m.kind) }), file, row, ref: { memberId: m.memberId } });
    }
    if (m.teamId !== null && m.teamId !== "" && !teamIds.has(m.teamId)) {
      push({ severity: "error", code: "MEMBER_UNKNOWN_TEAM", message: fmt(T.checks.memberUnknownTeam, { file, row, memberId: m.memberId, teamId: m.teamId }), file, row, ref: { memberId: m.memberId, teamId: m.teamId } });
    }
    if (!isValidYearMonth(m.effectiveFrom)) push({ severity: "error", code: "INVALID_MONTH", message: fmt(T.checks.memberEffectiveFromInvalid, { file, row, value: m.effectiveFrom }), file, row });
  });
}

function validateRates(dataset: Dataset, push: IssueSink): void {
  const file = "masters/rates.csv";
  dataset.rates.forEach((r, i) => {
    const row = rowOf(i);
    if (r.key === "") push({ severity: "error", code: "RATE_KEY_EMPTY", message: fmt(T.checks.rateKeyEmpty, { file, row }), file, row });
    if (typeof r.hourlyRate !== "number" || !Number.isFinite(r.hourlyRate)) {
      push({ severity: "error", code: "RATE_INVALID", message: fmt(T.checks.rateNotNumber, { file, row, key: r.key }), file, row, ref: { key: r.key } });
    } else if (r.hourlyRate < 0) {
      push({ severity: "error", code: "RATE_INVALID", message: fmt(T.checks.rateNegative, { file, row, key: r.key, value: r.hourlyRate }), file, row, ref: { key: r.key } });
    }
    if (!isValidYearMonth(r.effectiveFrom)) push({ severity: "error", code: "INVALID_MONTH", message: fmt(T.checks.rateEffectiveFromInvalid, { file, row, value: r.effectiveFrom }), file, row });
  });
}

function validateHolidays(dataset: Dataset, push: IssueSink): void {
  const file = "holidays.csv";
  dataset.holidays.forEach((h, i) => {
    const row = rowOf(i);
    if (!isValidISODate(h.date)) push({ severity: "error", code: "INVALID_DATE", message: fmt(T.checks.holidayDateInvalid, { file, row, value: h.date }), file, row });
  });
}

/** 作業実績の警告: 日付不正（警告）、未紐付け、単価なし、未知メンバー */
function validateWorklogs(dataset: Dataset, push: IssueSink): void {
  const file = "worklogs";
  let invalidDates = 0;
  let invalidHours = 0;
  for (const w of dataset.worklogs) {
    if (!isValidISODate(w.date)) invalidDates++;
    if (!Number.isFinite(w.hours) || w.hours <= 0) invalidHours++;
  }
  if (invalidDates > 0) push({ severity: "warning", code: "WORKLOG_INVALID_DATE", message: fmt(T.checks.worklogInvalidDate, { file, count: invalidDates }), file, ref: { count: invalidDates } });
  if (invalidHours > 0) push({ severity: "warning", code: "WORKLOG_INVALID_HOURS", message: fmt(T.checks.worklogInvalidHours, { file, count: invalidHours }), file, ref: { count: invalidHours } });

  // 紐付けは妥当な契約のみを対象にする（重複・不正契約はエラーで別途報告済み）
  const validContracts = dataset.contracts.filter((c, i, all) => contractInvalidReason(c) === null && all.findIndex((x) => x.contractId === c.contractId) === i);
  const mapping = mapWorklogs(dataset.worklogs, dataset.mappings, validContracts);
  for (const g of mapping.unmapped) {
    push({ severity: "warning", code: "UNMAPPED_WORKLOG", message: fmt(T.checks.unmappedWorklog, { file, customer: g.customerName, project: g.projectName, count: g.count, hours: g.hours, firstDate: g.firstDate, lastDate: g.lastDate, reason: g.reason }), file, ref: { customerName: g.customerName, projectName: g.projectName, reason: g.reason, hours: g.hours, count: g.count } });
  }
  if (mapping.excludedHours > 0) {
    push({ severity: "warning", code: "EXCLUDED_NO_CUSTOMER", message: fmt(T.checks.excludedNoCustomer, { file, hours: mapping.excludedHours }), file, ref: { hours: mapping.excludedHours } });
  }

  // 単価なし・未知メンバー（紐付いた実績のみ対象。メンバーID・月で集約）
  const masters = createMasterIndex(dataset);
  const missing = new Map<string, { memberId: string; month: YearMonth; hours: number }>();
  const unknown = new Map<string, number>();
  for (const a of mapping.assigned) {
    const month = monthOfDate(a.worklog.date);
    const rate = rateFor(masters, a.worklog.memberId, month);
    if (rate.memberUnknown) {
      unknown.set(a.worklog.memberId, (unknown.get(a.worklog.memberId) ?? 0) + a.worklog.hours);
      continue;
    }
    if (!rate.rateMissing) continue;
    const key = `${a.worklog.memberId}\u0000${month}`;
    const acc = missing.get(key);
    if (acc) acc.hours += a.worklog.hours;
    else missing.set(key, { memberId: a.worklog.memberId, month, hours: a.worklog.hours });
  }
  for (const [memberId, hours] of unknown) {
    push({ severity: "warning", code: "UNKNOWN_MEMBER", message: fmt(T.checks.unknownMember, { file, memberId, hours }), file, ref: { memberId, hours } });
  }
  for (const m of missing.values()) {
    push({ severity: "warning", code: "RATE_MISSING", message: fmt(T.checks.rateMissing, { file, month: m.month, memberId: m.memberId, hours: m.hours }), file, ref: { memberId: m.memberId, month: m.month, hours: m.hours } });
  }
}

/** Dataset を検証する。error が 1 件でもあれば CI は非0終了にする */
export function validateDataset(dataset: Dataset): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push: IssueSink = (issue) => issues.push(issue);
  const contractIds = new Set(dataset.contracts.map((c) => c.contractId));
  const memberIds = new Set(dataset.members.map((m) => m.memberId));
  const teamIds = new Set(dataset.teams.map((t) => t.teamId));

  validateContracts(dataset, push);
  validateMappings(dataset, contractIds, push);
  validateAssignments(dataset, contractIds, memberIds, push);
  validateTeams(dataset, teamIds, memberIds, push);
  validateMembers(dataset, teamIds, push);
  validateRates(dataset, push);
  validateHolidays(dataset, push);
  validateWorklogs(dataset, push);
  return issues;
}

/** error を含むか */
export function hasErrors(issues: readonly ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}
