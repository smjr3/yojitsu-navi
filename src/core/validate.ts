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
    if (c.contractId === "") push({ severity: "error", code: "CONTRACT_ID_EMPTY", message: `${file} ${row} 行目: 契約IDが空です`, file, row });
    if (seen.has(c.contractId)) {
      push({ severity: "error", code: "DUPLICATE_CONTRACT_ID", message: `${file} ${row} 行目: 契約ID ${c.contractId} が重複しています`, file, row, ref: { contractId: c.contractId } });
    }
    seen.add(c.contractId);
    if (!isValidYearMonth(c.startMonth)) push({ severity: "error", code: "INVALID_MONTH", message: `${file} ${row} 行目: start_month の形式が不正です: ${c.startMonth}`, file, row, ref: { contractId: c.contractId } });
    if (!isValidYearMonth(c.endMonth)) push({ severity: "error", code: "INVALID_MONTH", message: `${file} ${row} 行目: end_month の形式が不正です: ${c.endMonth}`, file, row, ref: { contractId: c.contractId } });
    if (isValidYearMonth(c.startMonth) && isValidYearMonth(c.endMonth) && c.startMonth > c.endMonth) {
      push({ severity: "error", code: "CONTRACT_PERIOD_INVERTED", message: `${file} ${row} 行目: 契約 ${c.contractId} の開始月 ${c.startMonth} が終了月 ${c.endMonth} より後です`, file, row, ref: { contractId: c.contractId } });
    }
    if (typeof c.totalAmount !== "number" || !Number.isFinite(c.totalAmount)) {
      push({ severity: "error", code: "CONTRACT_AMOUNT_INVALID", message: `${file} ${row} 行目: 契約 ${c.contractId} の total_amount が数値ではありません`, file, row, ref: { contractId: c.contractId } });
    } else if (c.totalAmount < 0) {
      push({ severity: "error", code: "CONTRACT_AMOUNT_INVALID", message: `${file} ${row} 行目: 契約 ${c.contractId} の total_amount が負です: ${c.totalAmount}`, file, row, ref: { contractId: c.contractId } });
    } else if (!Number.isInteger(c.totalAmount)) {
      push({ severity: "error", code: "CONTRACT_AMOUNT_INVALID", message: `${file} ${row} 行目: 契約 ${c.contractId} の total_amount は円の整数で入力してください: ${c.totalAmount}`, file, row, ref: { contractId: c.contractId } });
    }
  });
}

function validateMappings(dataset: Dataset, contractIds: ReadonlySet<string>, push: IssueSink): void {
  dataset.mappings.forEach((m, i) => {
    const file = "mapping.csv";
    const row = rowOf(i);
    if (!contractIds.has(m.contractId)) {
      push({ severity: "error", code: "MAPPING_UNKNOWN_CONTRACT", message: `${file} ${row} 行目: 契約ID ${m.contractId} は contracts.csv に存在しません`, file, row, ref: { contractId: m.contractId } });
    }
  });
}

function validateAssignments(dataset: Dataset, contractIds: ReadonlySet<string>, memberIds: ReadonlySet<string>, push: IssueSink): void {
  const file = "assignments.csv";
  const monthlyTotal = new Map<string, { memberId: string; month: YearMonth; total: number; rows: number[] }>();
  dataset.assignments.forEach((a, i) => {
    const row = rowOf(i);
    if (!memberIds.has(a.memberId)) push({ severity: "error", code: "ASSIGNMENT_UNKNOWN_MEMBER", message: `${file} ${row} 行目: メンバーID ${a.memberId} は members.csv に存在しません`, file, row, ref: { memberId: a.memberId } });
    if (!contractIds.has(a.contractId)) push({ severity: "error", code: "ASSIGNMENT_UNKNOWN_CONTRACT", message: `${file} ${row} 行目: 契約ID ${a.contractId} は contracts.csv に存在しません`, file, row, ref: { contractId: a.contractId } });
    const monthsOk = isValidYearMonth(a.startMonth) && isValidYearMonth(a.endMonth);
    if (!isValidYearMonth(a.startMonth)) push({ severity: "error", code: "INVALID_MONTH", message: `${file} ${row} 行目: start_month の形式が不正です: ${a.startMonth}`, file, row });
    if (!isValidYearMonth(a.endMonth)) push({ severity: "error", code: "INVALID_MONTH", message: `${file} ${row} 行目: end_month の形式が不正です: ${a.endMonth}`, file, row });
    if (monthsOk && a.startMonth > a.endMonth) push({ severity: "error", code: "ASSIGNMENT_PERIOD_INVERTED", message: `${file} ${row} 行目: 開始月 ${a.startMonth} が終了月 ${a.endMonth} より後です`, file, row });
    if (!Number.isFinite(a.allocation) || a.allocation < 0 || a.allocation > 1) {
      push({ severity: "error", code: "ALLOCATION_OUT_OF_RANGE", message: `${file} ${row} 行目: allocation は 0〜1 で指定してください: ${Number.isFinite(a.allocation) ? String(a.allocation) : "数値ではありません"}`, file, row, ref: { memberId: a.memberId, contractId: a.contractId } });
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
      push({ severity: "error", code: "ALLOCATION_OVER_1", message: `${file}: メンバー ${acc.memberId} の ${acc.month} の allocation 合計が 1.0 を超えています（${acc.total}、行 ${acc.rows.join(", ")}）`, file, row: acc.rows[0] as number, ref: { memberId: acc.memberId, month: acc.month, total: acc.total } });
    }
  }
}

function validateTeams(dataset: Dataset, teamIds: ReadonlySet<string>, push: IssueSink): void {
  const file = "masters/teams.csv";
  dataset.teams.forEach((t, i) => {
    const row = rowOf(i);
    if (t.teamId === "") push({ severity: "error", code: "TEAM_ID_EMPTY", message: `${file} ${row} 行目: team_id が空です`, file, row });
    if (!isValidYearMonth(t.effectiveFrom)) push({ severity: "error", code: "INVALID_MONTH", message: `${file} ${row} 行目: effective_from の形式が不正です: ${t.effectiveFrom}`, file, row });
    if (t.parentTeamId !== null && t.parentTeamId !== "" && !teamIds.has(t.parentTeamId)) {
      push({ severity: "error", code: "TEAM_UNKNOWN_PARENT", message: `${file} ${row} 行目: 親チーム ${t.parentTeamId} は存在しません`, file, row, ref: { teamId: t.teamId, parentTeamId: t.parentTeamId } });
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
    if (m.memberId === "") push({ severity: "error", code: "MEMBER_ID_EMPTY", message: `${file} ${row} 行目: member_id が空です`, file, row });
    if (m.kind !== "employee" && m.kind !== "partner") {
      push({ severity: "error", code: "MEMBER_KIND_INVALID", message: `${file} ${row} 行目: メンバー ${m.memberId} の区分は employee か partner で指定してください: ${String(m.kind)}`, file, row, ref: { memberId: m.memberId } });
    }
    if (m.teamId !== null && m.teamId !== "" && !teamIds.has(m.teamId)) {
      push({ severity: "error", code: "MEMBER_UNKNOWN_TEAM", message: `${file} ${row} 行目: メンバー ${m.memberId} のチーム ${m.teamId} は存在しません`, file, row, ref: { memberId: m.memberId, teamId: m.teamId } });
    }
    if (!isValidYearMonth(m.effectiveFrom)) push({ severity: "error", code: "INVALID_MONTH", message: `${file} ${row} 行目: effective_from の形式が不正です: ${m.effectiveFrom}`, file, row });
  });
}

function validateRates(dataset: Dataset, push: IssueSink): void {
  const file = "masters/rates.csv";
  dataset.rates.forEach((r, i) => {
    const row = rowOf(i);
    if (r.key === "") push({ severity: "error", code: "RATE_KEY_EMPTY", message: `${file} ${row} 行目: key が空です`, file, row });
    if (typeof r.hourlyRate !== "number" || !Number.isFinite(r.hourlyRate)) {
      push({ severity: "error", code: "RATE_INVALID", message: `${file} ${row} 行目: ${r.key} の hourly_rate が数値ではありません`, file, row, ref: { key: r.key } });
    } else if (r.hourlyRate < 0) {
      push({ severity: "error", code: "RATE_INVALID", message: `${file} ${row} 行目: ${r.key} の hourly_rate が負です: ${r.hourlyRate}`, file, row, ref: { key: r.key } });
    }
    if (!isValidYearMonth(r.effectiveFrom)) push({ severity: "error", code: "INVALID_MONTH", message: `${file} ${row} 行目: effective_from の形式が不正です: ${r.effectiveFrom}`, file, row });
  });
}

function validateHolidays(dataset: Dataset, push: IssueSink): void {
  const file = "holidays.csv";
  dataset.holidays.forEach((h, i) => {
    const row = rowOf(i);
    if (!isValidISODate(h.date)) push({ severity: "error", code: "INVALID_DATE", message: `${file} ${row} 行目: date の形式が不正です: ${h.date}`, file, row });
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
  if (invalidDates > 0) push({ severity: "warning", code: "WORKLOG_INVALID_DATE", message: `${file}: 日付が不正な作業実績 ${invalidDates} 件を無視します`, file, ref: { count: invalidDates } });
  if (invalidHours > 0) push({ severity: "warning", code: "WORKLOG_INVALID_HOURS", message: `${file}: hours が 0 以下か数値でない作業実績 ${invalidHours} 件を無視します`, file, ref: { count: invalidHours } });

  // 紐付けは妥当な契約のみを対象にする（重複・不正契約はエラーで別途報告済み）
  const validContracts = dataset.contracts.filter((c, i, all) => contractInvalidReason(c) === null && all.findIndex((x) => x.contractId === c.contractId) === i);
  const mapping = mapWorklogs(dataset.worklogs, dataset.mappings, validContracts);
  for (const g of mapping.unmapped) {
    push({ severity: "warning", code: "UNMAPPED_WORKLOG", message: `${file}: 「${g.customerName} / ${g.projectName}」の作業実績 ${g.count} 件（${g.hours} 時間、${g.firstDate}〜${g.lastDate}）が契約に紐付いていません（${g.reason}）`, file, ref: { customerName: g.customerName, projectName: g.projectName, reason: g.reason, hours: g.hours, count: g.count } });
  }
  if (mapping.excludedHours > 0) {
    push({ severity: "warning", code: "EXCLUDED_NO_CUSTOMER", message: `${file}: 顧客名が空の作業実績 ${mapping.excludedHours} 時間を除外します`, file, ref: { hours: mapping.excludedHours } });
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
    push({ severity: "warning", code: "UNKNOWN_MEMBER", message: `${file}: メンバー ${memberId} は members.csv に存在しません（${hours} 時間）`, file, ref: { memberId, hours } });
  }
  for (const m of missing.values()) {
    push({ severity: "warning", code: "RATE_MISSING", message: `${file}: ${m.month} のメンバー ${m.memberId} の時間単価がありません（${m.hours} 時間）`, file, ref: { memberId: m.memberId, month: m.month, hours: m.hours } });
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
  validateTeams(dataset, teamIds, push);
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
