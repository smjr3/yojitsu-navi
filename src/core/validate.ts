/**
 * データ検証（SPEC §14）
 *
 * error  = CI で止める（契約・マッピング・アサイン・チーム・メンバー・単価・形式）
 * warning = 止めずに表示（未紐付け工数、単価なし、未知メンバーの工数）
 */
import { contractInvalidReason } from "./budget.js";
import { addMonths, isValidISODate, isValidYearMonth, monthOfDate, monthRange } from "./calendar.js";
import { mapWorklogs } from "./mapping.js";
import { createMasterIndex, isLeftRecord, memberAt, rateFor, teamTreeAt } from "./masters.js";
import type { Dataset, YearMonth } from "./types.js";
import { createTaskClassifier, isOutsideWorklog, outsideTypes, unclassifiedTaskWarnings } from "./workTypes.js";
import { normalizeName } from "./normalize.js";
import { customerKey } from "./customers.js";
import { isTargetKind } from "./targets.js";
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

/** 同じキーで effective_from も同じ行が複数ある（どちらが効くか分からない）→ error。2 行目以降を報告する */
function pushDuplicates<T extends { effectiveFrom: string }>(rows: readonly T[], keyOf: (r: T) => string, file: string, code: string, column: string, push: IssueSink): void {
  const first = new Map<string, number>();
  rows.forEach((r, i) => {
    const k = keyOf(r);
    if (k === "") return;
    const id = `${k}\u0000${r.effectiveFrom}`;
    const prev = first.get(id);
    if (prev === undefined) first.set(id, rowOf(i));
    else push({ severity: "error", code, message: fmt(T.checks.duplicateHistoryRow, { file, row: rowOf(i), column, key: k, effectiveFrom: r.effectiveFrom, prev }), file, row: rowOf(i), ref: { key: k, effectiveFrom: r.effectiveFrom } });
  });
}

function validateContracts(dataset: Dataset, teamIds: ReadonlySet<string>, push: IssueSink): void {
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
    } else if (!Number.isSafeInteger(c.totalAmount)) {
      push({ severity: "error", code: "CONTRACT_AMOUNT_INVALID", message: fmt(T.checks.contractAmountTooLarge, { file, row, contractId: c.contractId }), file, row, ref: { contractId: c.contractId } });
    }
    // 主担当チームが teams.csv に無い: 打ち間違いのまま「未設定」に集計されるのを防ぐ（メンバーの MEMBER_UNKNOWN_TEAM と同じ扱い）
    if (c.teamId !== null && c.teamId !== "" && !teamIds.has(c.teamId)) {
      push({ severity: "error", code: "CONTRACT_UNKNOWN_TEAM", message: fmt(T.checks.contractUnknownTeam, { file, row, contractId: c.contractId, teamId: c.teamId }), file, row, ref: { contractId: c.contractId, teamId: c.teamId } });
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
  const contractById = new Map(dataset.contracts.map((c) => [c.contractId, c]));
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
      push({ severity: "error", code: "ALLOCATION_OUT_OF_RANGE", message: fmt(T.checks.allocationOutOfRange, { file, row, value: Number.isFinite(a.allocation) ? String(a.allocation) : T.checks.notANumber }), file, row, ref: { memberId: a.memberId, contractId: a.contractId } });
      return;
    }
    if (!monthsOk) return;
    // 契約期間の外の月は計画に入らない（着地見込みにも効かない）ので、気付けるよう警告する
    const c = contractById.get(a.contractId);
    if (c && isValidYearMonth(c.startMonth) && isValidYearMonth(c.endMonth) && a.startMonth <= a.endMonth && (a.startMonth < c.startMonth || a.endMonth > c.endMonth)) {
      push({ severity: "warning", code: "ASSIGNMENT_OUTSIDE_CONTRACT", message: fmt(T.checks.assignmentOutsideContract, { file, row, contractId: a.contractId, from: a.startMonth, to: a.endMonth, cFrom: c.startMonth, cTo: c.endMonth }), file, row, ref: { memberId: a.memberId, contractId: a.contractId } });
    }
    for (const month of monthRange(a.startMonth, a.endMonth)) {
      const key = `${a.memberId}\u0000${month}`;
      const acc = monthlyTotal.get(key);
      if (acc) {
        acc.total += a.allocation;
        acc.rows.push(row);
      } else monthlyTotal.set(key, { memberId: a.memberId, month, total: a.allocation, rows: [row] });
    }
  });
  // 1.0 超は警告（保存は止めない。§40）。同じ人の続いた月は 1 件にまとめる（3 か月超えて 3 件並ばないように）
  const overs = [...monthlyTotal.values()].filter((acc) => acc.total > 1 + 1e-9); // 浮動小数の誤差（0.3+0.7 など）を許容
  overs.sort((a, b) => (a.memberId === b.memberId ? (a.month < b.month ? -1 : 1) : a.memberId < b.memberId ? -1 : 1));
  let run: { memberId: string; from: YearMonth; to: YearMonth; max: number; rows: Set<number> } | null = null;
  const flush = () => {
    if (!run) return;
    const rows = [...run.rows].sort((a, b) => a - b);
    const max = Math.round(run.max * 10000) / 10000;
    const period = run.from === run.to ? run.from : `${run.from}〜${run.to}`;
    push({ severity: "warning", code: "ALLOCATION_OVER_1", message: fmt(T.checks.allocationOver1, { file, memberId: run.memberId, period, max, rows: rows.join(", ") }), file, row: rows[0] as number, ref: { memberId: run.memberId, month: run.from, toMonth: run.to, total: run.max } });
    run = null;
  };
  for (const acc of overs) {
    if (run && run.memberId === acc.memberId && addMonths(run.to, 1) === acc.month) {
      run.to = acc.month;
      run.max = Math.max(run.max, acc.total);
      for (const r of acc.rows) run.rows.add(r);
      continue;
    }
    flush();
    run = { memberId: acc.memberId, from: acc.month, to: acc.month, max: acc.total, rows: new Set(acc.rows) };
  }
  flush();
}

/** 契約外予定（§36・§50）: メンバー・種別・月・人月の形式と、同じ人・同じ種別・同じ月の重複 */
function validateOutsidePlans(dataset: Dataset, memberIds: ReadonlySet<string>, push: IssueSink): void {
  const file = "outside-plans.csv";
  const seen = new Map<string, number[]>();
  // 種別は分類表（task-types.csv）の契約外の種別から選ぶ。分類表に契約外の種別が無ければ問わない
  const types = new Set(outsideTypes(dataset.taskTypes).map((t) => normalizeName(t)));
  (dataset.outsidePlans ?? []).forEach((o, i) => {
    const row = rowOf(i);
    if (!memberIds.has(o.memberId)) push({ severity: "error", code: "OUTSIDE_UNKNOWN_MEMBER", message: fmt(T.checks.outsideUnknownMember, { file, row, memberId: o.memberId }), file, row, ref: { memberId: o.memberId } });
    if (types.size > 0 && o.type !== "" && !types.has(normalizeName(o.type))) push({ severity: "warning", code: "OUTSIDE_UNKNOWN_TYPE", message: fmt(T.checks.outsideUnknownType, { file, row, type: o.type }), file, row, ref: { memberId: o.memberId, type: o.type } });
    if (!isValidYearMonth(o.startMonth)) push({ severity: "error", code: "INVALID_MONTH", message: fmt(T.checks.outsideMonthInvalid, { file, row, column: "start_month", value: o.startMonth }), file, row });
    if (!isValidYearMonth(o.endMonth)) push({ severity: "error", code: "INVALID_MONTH", message: fmt(T.checks.outsideMonthInvalid, { file, row, column: "end_month", value: o.endMonth }), file, row });
    const monthsOk = isValidYearMonth(o.startMonth) && isValidYearMonth(o.endMonth);
    if (monthsOk && o.startMonth > o.endMonth) push({ severity: "error", code: "OUTSIDE_PERIOD_INVERTED", message: fmt(T.checks.outsidePeriodInverted, { file, row, from: o.startMonth, to: o.endMonth }), file, row });
    if (!Number.isFinite(o.personMonths) || o.personMonths < 0 || o.personMonths > 1) {
      push({ severity: "error", code: "OUTSIDE_OUT_OF_RANGE", message: fmt(T.checks.outsideOutOfRange, { file, row, value: Number.isFinite(o.personMonths) ? String(o.personMonths) : T.checks.notANumber }), file, row, ref: { memberId: o.memberId } });
    }
    if (!monthsOk || o.startMonth > o.endMonth) return;
    for (const month of monthRange(o.startMonth, o.endMonth)) {
      const key = `${o.memberId}\u0000${normalizeName(o.type)}\u0000${month}`;
      const list = seen.get(key);
      if (list) list.push(row);
      else seen.set(key, [row]);
    }
  });
  // 重複は人ごとに最初の月だけ報告する（長い期間の重複で同じ文が並ばないように）
  const reported = new Set<string>();
  for (const [key, rows] of seen) {
    if (rows.length < 2) continue;
    const [memberId, , month] = key.split("\u0000") as [string, string, string];
    const sig = `${memberId}|${rows.join(",")}`;
    if (reported.has(sig)) continue;
    reported.add(sig);
    push({ severity: "error", code: "OUTSIDE_OVERLAP", message: fmt(T.checks.outsideOverlap, { file, memberId, month, rows: rows.join(", ") }), file, row: rows[rows.length - 1] as number, ref: { memberId, month } });
  }
}

/**
 * 目標（§57）: 種別・対象・月・残予算率の形式と、同じ対象・同じ期限月の重複。
 * 対象が見つからないのは警告（チームの廃止・案件の終了後も、過去の目標の行は残せるように）
 */
function validateTargets(dataset: Dataset, teamIds: ReadonlySet<string>, contractIds: ReadonlySet<string>, push: IssueSink): void {
  const file = "targets.csv";
  const customers = new Set(dataset.contracts.map((c) => customerKey(c.customerName)));
  const seen = new Map<string, number[]>();
  (dataset.targets ?? []).forEach((t, i) => {
    const row = rowOf(i);
    const id = t.targetId.trim();
    if (!isTargetKind(t.kind)) push({ severity: "error", code: "TARGET_INVALID_KIND", message: fmt(T.checks.targetInvalidKind, { file, row, value: t.kind }), file, row });
    else if (id === "") push({ severity: "error", code: "TARGET_MISSING_ID", message: fmt(T.checks.targetMissingId, { file, row }), file, row });
    else {
      const known = t.kind === "team" ? teamIds.has(id) : t.kind === "customer" ? customers.has(customerKey(id)) : contractIds.has(id);
      if (!known) push({ severity: "warning", code: "TARGET_UNKNOWN", message: fmt(T.checks.targetUnknown, { file, row, kind: T.targets.kinds[t.kind], id }), file, row, ref: { kind: t.kind, id } });
    }
    const due = t.dueMonth.trim();
    const start = t.startMonth.trim();
    if (!isValidYearMonth(due)) push({ severity: "error", code: "INVALID_MONTH", message: fmt(T.checks.targetMonthInvalid, { file, row, column: "due_month", value: t.dueMonth }), file, row });
    if (start !== "" && !isValidYearMonth(start)) push({ severity: "error", code: "INVALID_MONTH", message: fmt(T.checks.targetMonthInvalid, { file, row, column: "start_month", value: t.startMonth }), file, row });
    if (isValidYearMonth(due) && isValidYearMonth(start) && start > due) push({ severity: "error", code: "TARGET_PERIOD_INVERTED", message: fmt(T.checks.targetPeriodInverted, { file, row, from: start, to: due }), file, row });
    if (!Number.isFinite(t.remainingRate) || t.remainingRate > 1) {
      push({ severity: "error", code: "TARGET_RATE_INVALID", message: fmt(T.checks.targetRateInvalid, { file, row, value: Number.isFinite(t.remainingRate) ? String(Math.round(t.remainingRate * 10000) / 100) : T.checks.notANumber }), file, row });
    }
    if (!isTargetKind(t.kind) || id === "" || !isValidYearMonth(due)) return;
    const key = `${t.kind}\u0000${t.kind === "customer" ? customerKey(id) : id}\u0000${due}`;
    const list = seen.get(key);
    if (list) list.push(row);
    else seen.set(key, [row]);
  });
  for (const [key, rows] of seen) {
    if (rows.length < 2) continue;
    const [kind, id, month] = key.split("\u0000") as [string, string, string];
    push({ severity: "error", code: "TARGET_DUPLICATE", message: fmt(T.checks.targetDuplicate, { file, kind: T.targets.kinds[kind as "team"], id, month, rows: rows.join(", ") }), file, row: rows[rows.length - 1] as number });
  }
}

function validateTeams(dataset: Dataset, teamIds: ReadonlySet<string>, memberIds: ReadonlySet<string>, push: IssueSink): void {
  const file = "masters/teams.csv";
  dataset.teams.forEach((t, i) => {
    const row = rowOf(i);
    if (t.teamId === "") push({ severity: "error", code: "TEAM_ID_EMPTY", message: fmt(T.checks.teamIdEmpty, { file, row }), file, row });
    if (!isValidYearMonth(t.effectiveFrom)) push({ severity: "error", code: "INVALID_MONTH", message: fmt(T.checks.teamEffectiveFromInvalid, { file, row, value: t.effectiveFrom }), file, row });
    if (t.parentTeamId !== null && t.parentTeamId !== "" && t.parentTeamId === t.teamId) {
      push({ severity: "error", code: "TEAM_SELF_PARENT", message: fmt(T.checks.teamSelfParent, { file, row, teamId: t.teamId }), file, row, ref: { teamId: t.teamId } });
    } else if (t.parentTeamId !== null && t.parentTeamId !== "" && !teamIds.has(t.parentTeamId)) {
      push({ severity: "error", code: "TEAM_UNKNOWN_PARENT", message: fmt(T.checks.teamUnknownParent, { file, row, parentTeamId: t.parentTeamId }), file, row, ref: { teamId: t.teamId, parentTeamId: t.parentTeamId } });
    }
    if (t.leaderMemberId != null && t.leaderMemberId !== "" && !memberIds.has(t.leaderMemberId)) {
      push({ severity: "error", code: "TEAM_UNKNOWN_LEADER", message: fmt(T.checks.teamUnknownLeader, { file, row, leaderMemberId: t.leaderMemberId }), file, row, ref: { teamId: t.teamId, memberId: t.leaderMemberId } });
    }
  });
  pushDuplicates(dataset.teams, (t) => t.teamId, file, "DUPLICATE_TEAM_ROW", "team_id", push);
  // 循環: effective_from の各時点の組織で検出する
  const snapshots = [...new Set(dataset.teams.map((t) => t.effectiveFrom).filter(isValidYearMonth))].sort();
  const reported = new Set<string>();
  for (const month of snapshots) {
    for (const w of teamTreeAt(dataset, month).warnings) {
      if (typeof w.ref?.cycle !== "string") continue;
      if (!w.ref.cycle.includes(">")) continue; // 自分自身を親にした行は TEAM_SELF_PARENT で行番号つきで報告済み
      if (reported.has(w.ref.cycle)) continue;
      reported.add(w.ref.cycle);
      push({ severity: "error", code: "TEAM_CYCLE", message: `${file}: ${w.message}`, file, ref: { cycle: w.ref.cycle, month } });
    }
  }
}

function validateMembers(dataset: Dataset, teamIds: ReadonlySet<string>, push: IssueSink): void {
  const file = "masters/members.csv";
  pushDuplicates(dataset.members, (m) => m.memberId, file, "DUPLICATE_MEMBER_ROW", "member_id", push);
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
    if (m.status !== undefined && m.status !== "left") {
      push({ severity: "error", code: "MEMBER_STATUS_INVALID", message: fmt(T.checks.memberStatusInvalid, { file, row, memberId: m.memberId, value: m.status }), file, row, ref: { memberId: m.memberId } });
    }
  });
}

/** 退職した月以降に残っているアサイン（§35。終了月の直し忘れ）。計画の人月・着地見込みに入ってしまうので警告。メンバーごとにまとめる */
function validateAssignmentsAfterLeft(dataset: Dataset, push: IssueSink): void {
  const file = "assignments.csv";
  const masters = createMasterIndex(dataset);
  const hit = new Map<string, { rows: number[]; first: YearMonth; last: YearMonth; leftFrom: YearMonth }>();
  dataset.assignments.forEach((a, i) => {
    if (!isValidYearMonth(a.startMonth) || !isValidYearMonth(a.endMonth) || a.startMonth > a.endMonth || !(a.allocation > 0)) return;
    for (const m of monthRange(a.startMonth, a.endMonth)) {
      const rec = memberAt(masters, a.memberId, m);
      if (!isLeftRecord(rec)) continue;
      const acc = hit.get(a.memberId);
      if (acc) {
        if (!acc.rows.includes(rowOf(i))) acc.rows.push(rowOf(i));
        if (m < acc.first) acc.first = m;
        if (m > acc.last) acc.last = m;
      } else hit.set(a.memberId, { rows: [rowOf(i)], first: m, last: m, leftFrom: rec!.effectiveFrom });
    }
  });
  for (const [memberId, h] of [...hit].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    push({ severity: "warning", code: "ASSIGNMENT_AFTER_LEFT", message: fmt(T.checks.assignmentAfterLeft, { file, memberId, leftFrom: h.leftFrom, first: h.first, last: h.last, rows: h.rows.join(", ") }), file, row: h.rows[0] as number, ref: { memberId, month: h.first } });
  }
}

/** 退職した月以降に付いた作業実績（§35）。実績には数える（単価は退職の行の役職）が、入力の誤りの可能性が高いので警告。メンバーごとにまとめる */
function validateWorkAfterLeft(dataset: Dataset, push: IssueSink): void {
  const file = "worklogs";
  const masters = createMasterIndex(dataset);
  const hit = new Map<string, { memberId: string; memberName: string; hours: number; first: string; last: string; count: number }>();
  for (const w of dataset.worklogs) {
    if (!isValidISODate(w.date) || !Number.isFinite(w.hours) || w.hours <= 0) continue;
    const rec = memberAt(masters, w.memberId, monthOfDate(w.date));
    if (!isLeftRecord(rec)) continue;
    const acc = hit.get(w.memberId);
    if (acc) {
      acc.hours += w.hours;
      acc.count++;
      if (w.date < acc.first) acc.first = w.date;
      if (w.date > acc.last) acc.last = w.date;
    } else hit.set(w.memberId, { memberId: w.memberId, memberName: rec?.name || w.memberName, hours: w.hours, first: w.date, last: w.date, count: 1 });
  }
  for (const h of [...hit.values()].sort((a, b) => (a.memberId < b.memberId ? -1 : 1))) {
    const hours = Math.round(h.hours * 100) / 100;
    push({ severity: "warning", code: "WORKLOG_AFTER_LEFT", message: fmt(T.checks.worklogAfterLeft, { file, memberId: h.memberId, memberName: h.memberName, count: h.count, hours, first: h.first, last: h.last }), file, ref: { memberId: h.memberId, hours } });
  }
}

/** 役職に単価が 1 行も無いメンバー（個人単価も無い）→ 実績が 0 円になるので警告。役職ごとにまとめる */
function validateTitleRates(dataset: Dataset, push: IssueSink): void {
  const keys = new Set(dataset.rates.map((r) => r.key));
  const byTitle = new Map<string, Set<string>>();
  for (const m of dataset.members) {
    if (m.memberId === "" || keys.has(m.memberId)) continue;
    const title = m.title ?? "";
    if (title !== "" && keys.has(title)) continue;
    const ids = byTitle.get(title) ?? new Set<string>();
    ids.add(m.memberId);
    byTitle.set(title, ids);
  }
  const file = "masters/members.csv";
  for (const [title, ids] of byTitle) {
    const members = [...ids].join(", ");
    const message = title === "" ? fmt(T.checks.memberNoTitleNoRate, { file, members }) : fmt(T.checks.titleRateUndefined, { file, title, members });
    push({ severity: "warning", code: "MEMBER_RATE_UNDEFINED", message, file, ref: { title, count: ids.size } });
  }
}

function validateRates(dataset: Dataset, push: IssueSink): void {
  const file = "masters/rates.csv";
  pushDuplicates(dataset.rates, (r) => r.key, file, "DUPLICATE_RATE_ROW", "key", push);
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
  // 1 人 1 日 24 時間超は入力ミスの可能性が高い（計算には含める）
  const perDay = new Map<string, number>();
  for (const w of dataset.worklogs) {
    if (!isValidISODate(w.date) || !Number.isFinite(w.hours) || w.hours <= 0) continue;
    const k = `${w.memberId}\u0000${w.date}`;
    perDay.set(k, (perDay.get(k) ?? 0) + w.hours);
  }
  const overDays = [...perDay].filter(([, h]) => h > 24);
  if (overDays.length > 0) {
    const examples = overDays.slice(0, 5).map(([k, h]) => `${k.replace("\u0000", " ")} ${Math.round(h * 100) / 100}h`).join("、");
    push({ severity: "warning", code: "WORKLOG_DAY_OVER_24H", message: fmt(T.checks.worklogDayOver24, { file, count: overDays.length, examples }), file, ref: { count: overDays.length } });
  }

  // 紐付けは妥当な契約のみを対象にする（重複・不正契約はエラーで別途報告済み）
  const validContracts = dataset.contracts.filter((c, i, all) => contractInvalidReason(c) === null && all.findIndex((x) => x.contractId === c.contractId) === i);
  const valid = new Set(validContracts);
  const excluded = new Map(dataset.contracts.filter((c) => !valid.has(c)).map((c) => [c.contractId, contractInvalidReason(c) ?? T.calcWarnings.duplicateReason]));
  for (const c of validContracts) excluded.delete(c.contractId); // 重複 ID は 1 行目が有効
  // 契約外の作業（§30）は紐付けの対象外（buildModel と同じ）
  const classifier = createTaskClassifier(dataset.taskTypes);
  const inScope = classifier.enabled ? dataset.worklogs.filter((w) => !isOutsideWorklog(w, classifier)) : dataset.worklogs;
  const mapping = mapWorklogs(inScope, dataset.mappings, validContracts, excluded);
  for (const w of unclassifiedTaskWarnings(mapping.mappings.filter((m) => m.kind === "assigned" || m.kind === "unmapped").map((m) => m.worklog), classifier)) {
    push({ severity: "warning", code: w.code, message: w.message, file: "task-types.csv", ref: { task: String(w.ref?.task ?? ""), hours: w.hours ?? 0, count: w.count ?? 0 } });
  }
  for (const g of mapping.unmapped) {
    push({ severity: "warning", code: "UNMAPPED_WORKLOG", message: fmt(T.checks.unmappedWorklog, { file, customer: g.customerName, project: g.projectName, count: g.count, hours: g.hours, firstDate: g.firstDate, lastDate: g.lastDate, reason: g.reason }), file, ref: { customerName: g.customerName, projectName: g.projectName, reason: g.reason, hours: g.hours, count: g.count } });
  }
  if (mapping.excludedHours > 0) {
    push({ severity: "warning", code: "EXCLUDED_NO_CUSTOMER", message: fmt(T.checks.excludedNoCustomer, { file, hours: mapping.excludedHours }), file, ref: { hours: mapping.excludedHours } });
  }

  // 単価なし・未知メンバー（紐付いた実績のみ対象。社員番号・月で集約）
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
    const before = memberAt(masters, m.memberId, m.month) === null;
    push({ severity: "warning", code: "RATE_MISSING", message: fmt(before ? T.checks.rateMissingBeforeMember : T.checks.rateMissing, { file, month: m.month, memberId: m.memberId, hours: m.hours }), file, ref: { memberId: m.memberId, month: m.month, hours: m.hours } });
  }
}

/** Dataset を検証する。error が 1 件でもあれば CI は非0終了にする */
export function validateDataset(dataset: Dataset): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push: IssueSink = (issue) => issues.push(issue);
  const contractIds = new Set(dataset.contracts.map((c) => c.contractId));
  const memberIds = new Set(dataset.members.map((m) => m.memberId));
  const teamIds = new Set(dataset.teams.map((t) => t.teamId));

  validateContracts(dataset, teamIds, push);
  validateMappings(dataset, contractIds, push);
  validateAssignments(dataset, contractIds, memberIds, push);
  validateOutsidePlans(dataset, memberIds, push);
  validateTargets(dataset, teamIds, contractIds, push);
  validateTeams(dataset, teamIds, memberIds, push);
  validateMembers(dataset, teamIds, push);
  validateRates(dataset, push);
  validateTitleRates(dataset, push);
  validateHolidays(dataset, push);
  validateWorklogs(dataset, push);
  validateWorkAfterLeft(dataset, push);
  validateAssignmentsAfterLeft(dataset, push);
  return issues;
}

/** error を含むか */
export function hasErrors(issues: readonly ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}
