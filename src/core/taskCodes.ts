/**
 * 作業コードの点検（SPEC §92）
 *
 * - 未登録: 運用保守のキーワード（config.taskCodeCheck）に合う作業のうち、mapping.csv に作業コードの行が無い、
 *   または行はあるが期間に入らない日付の作業がある作業コード
 * - 作業名の変更: 同じ作業コードで作業名が変わった（日付順に前の名前 → 次の名前）。キーワードの一致が変わったかも添える
 * - 案件の割り当ては人が mapping.csv に書く。ここでは見つけるだけで、案件を決めない
 * - 作業名から抜き出した案件名で契約が見つかる作業（§97）は未登録に数えない（作業コードは監視・変更検知に使う）
 */
import { isValidISODate, isValidYearMonth, monthOfDate } from "./calendar.js";
import { isCodeRule, ruleCoversMonth } from "./mapping.js";
import { includesAnyKeyword, normalizeCode, normalizeKeyword, normalizeName } from "./normalize.js";
import { resolvesByTask, type ProjectMatcher } from "./projectFromTask.js";
import type { Contract, ISODate, MappingRule, TaskCodeChange, TaskCodeCheckConfig, UnregisteredTaskCode, Warning, Worklog, YearMonth } from "./types.js";
import { T, fmt } from "../i18n/index.js";
import { addMemberHours, memberHoursList, type MemberHoursAcc } from "./worklogMembers.js";

/** 点検が有効か（含むキーワードが 1 つ以上） */
export function taskCodeCheckEnabled(check: TaskCodeCheckConfig | undefined): check is TaskCodeCheckConfig {
  return !!check && Array.isArray(check.include) && check.include.some((k) => normalizeKeyword(k) !== "");
}

/** 作業名が運用保守のキーワードに合うか（除くが優先） */
export function matchesMaintenance(check: TaskCodeCheckConfig, task: string): boolean {
  const t = normalizeKeyword(task);
  if (includesAnyKeyword(t, (check.exclude ?? []).filter((k) => normalizeKeyword(k) !== ""))) return false;
  return includesAnyKeyword(t, check.include.filter((k) => normalizeKeyword(k) !== ""));
}

export interface TaskCodeFindings {
  unregistered: UnregisteredTaskCode[];
  changes: TaskCodeChange[];
}

interface NameSpan {
  task: string;
  firstDate: ISODate;
  lastDate: ISODate;
}

interface CodeAcc {
  taskCode: string;
  /** 正規化した作業名 → 最初・最後の日付（表記は最初の行） */
  names: Map<string, NameSpan>;
  unreg: { hours: number; count: number; firstDate: ISODate; lastDate: ISODate; status: "none" | "period"; customerName: string; projectName: string; lastTask: string; members: MemberHoursAcc } | null;
}

/**
 * 作業コードの点検。作業コードの無い行・日付や時間が不正な行は見ない。
 * 名前の変更は点検の設定が無くても出す（一致の欄は null）。未登録は設定があるときだけ
 */
export function findTaskCodeIssues(worklogs: readonly Worklog[], rules: readonly MappingRule[], check: TaskCodeCheckConfig | undefined, projects?: ProjectMatcher): TaskCodeFindings {
  const enabled = taskCodeCheckEnabled(check);
  const codeRules = new Map<string, MappingRule[]>();
  for (const r of rules) {
    if (!isCodeRule(r)) continue;
    const code = normalizeCode(r.taskCode);
    const list = codeRules.get(code);
    if (list) list.push(r);
    else codeRules.set(code, [r]);
  }
  const accs = new Map<string, CodeAcc>();
  const matchCache = new Map<string, boolean>();
  const matches = (task: string): boolean => {
    let m = matchCache.get(task);
    if (m === undefined) {
      m = enabled ? matchesMaintenance(check, task) : false;
      matchCache.set(task, m);
    }
    return m;
  };
  for (const w of worklogs) {
    const code = normalizeCode(w.taskCode);
    if (code === "" || !isValidISODate(w.date) || !Number.isFinite(w.hours) || w.hours <= 0) continue;
    let acc = accs.get(code);
    if (!acc) {
      acc = { taskCode: (w.taskCode ?? "").trim(), names: new Map(), unreg: null };
      accs.set(code, acc);
    }
    const nameKey = normalizeName(w.task);
    const span = acc.names.get(nameKey);
    if (span) {
      if (w.date < span.firstDate) span.firstDate = w.date;
      if (w.date > span.lastDate) span.lastDate = w.date;
    } else acc.names.set(nameKey, { task: w.task.trim(), firstDate: w.date, lastDate: w.date });

    if (!enabled || !matches(w.task)) continue;
    const month = monthOfDate(w.date);
    const list = codeRules.get(code);
    if (list && list.some((r) => ruleCoversMonth(r, month))) continue;
    if (!list && resolvesByTask(projects, w.task)) continue;
    const status = list ? "period" : "none";
    const u = acc.unreg;
    if (!u) {
      acc.unreg = { hours: w.hours, count: 1, firstDate: w.date, lastDate: w.date, status, customerName: w.customerName, projectName: w.projectName, lastTask: w.task.trim(), members: new Map() };
      addMemberHours(acc.unreg.members, w);
    } else {
      addMemberHours(u.members, w);
      u.hours += w.hours;
      u.count += 1;
      if (w.date < u.firstDate) u.firstDate = w.date;
      if (w.date >= u.lastDate) {
        u.lastDate = w.date;
        u.lastTask = w.task.trim();
        u.customerName = w.customerName;
        u.projectName = w.projectName;
      }
    }
  }

  const unregistered: UnregisteredTaskCode[] = [];
  const changes: TaskCodeChange[] = [];
  for (const acc of accs.values()) {
    if (acc.unreg) {
      const u = acc.unreg;
      unregistered.push({ taskCode: acc.taskCode, task: u.lastTask, customerName: u.customerName, projectName: u.projectName, hours: u.hours, count: u.count, firstDate: u.firstDate, lastDate: u.lastDate, status: u.status, members: memberHoursList(u.members) });
    }
    if (acc.names.size > 1) {
      // 名前を使い始めた順に並べ、隣どうしを「前 → 次」とする
      const spans = [...acc.names.values()].sort((a, b) => (a.firstDate < b.firstDate ? -1 : a.firstDate > b.firstDate ? 1 : a.task < b.task ? -1 : 1));
      for (let i = 1; i < spans.length; i++) {
        const before = spans[i - 1] as NameSpan;
        const after = spans[i] as NameSpan;
        changes.push({
          taskCode: acc.taskCode,
          before: before.task,
          after: after.task,
          changedOn: after.firstDate,
          matchBefore: enabled ? matches(before.task) : null,
          matchAfter: enabled ? matches(after.task) : null,
        });
      }
    }
  }
  unregistered.sort((a, b) => b.hours - a.hours || (a.taskCode < b.taskCode ? -1 : a.taskCode > b.taskCode ? 1 : 0));
  changes.sort((a, b) => (a.changedOn > b.changedOn ? -1 : a.changedOn < b.changedOn ? 1 : a.taskCode < b.taskCode ? -1 : a.taskCode > b.taskCode ? 1 : 0));
  return { unregistered, changes };
}

/** 一致状況が変わった名前の変更か */
export function isMatchChange(c: TaskCodeChange): boolean {
  return c.matchBefore !== null && c.matchAfter !== null && c.matchBefore !== c.matchAfter;
}

/** 点検の結果を計算の警告にする（未登録はコードごと、名前の変更・一致の変化は 1 件ずつ） */
export function taskCodeWarnings(f: TaskCodeFindings): Warning[] {
  const out: Warning[] = [];
  for (const u of f.unregistered) {
    out.push({
      code: "TASK_CODE_UNREGISTERED",
      message: fmt(u.status === "none" ? T.calcWarnings.taskCodeUnregistered : T.calcWarnings.taskCodeOutOfPeriod, { code: u.taskCode, task: u.task, count: u.count, hours: u.hours, firstDate: u.firstDate, lastDate: u.lastDate }),
      ref: { taskCode: u.taskCode, task: u.task, status: u.status },
      hours: u.hours,
      count: u.count,
    });
  }
  for (const c of f.changes) {
    const matchChanged = isMatchChange(c);
    out.push({
      code: matchChanged ? "TASK_CODE_MATCH_CHANGED" : "TASK_CODE_RENAMED",
      message: fmt(matchChanged ? (c.matchAfter ? T.calcWarnings.taskCodeMatchGained : T.calcWarnings.taskCodeMatchLost) : T.calcWarnings.taskCodeRenamed, { code: c.taskCode, before: c.before, after: c.after, date: c.changedOn }),
      ref: { taskCode: c.taskCode, before: c.before, after: c.after, date: c.changedOn },
    });
  }
  return out;
}

export interface MappingRowIssue {
  severity: "error" | "warning";
  code: "MAPPING_MONTH_INVALID" | "MAPPING_PERIOD_INVERTED" | "MAPPING_PERIOD_OVERLAP" | "MAPPING_OUTSIDE_CONTRACT";
  /** CSV の行番号（ヘッダ = 1） */
  row: number;
  message: string;
  ref: Record<string, string | number>;
}

function maxMonth(a: YearMonth | undefined, b: YearMonth): YearMonth {
  return a && a > b ? a : b;
}
function minMonth(a: YearMonth | undefined, b: YearMonth): YearMonth {
  return a && a < b ? a : b;
}

/**
 * mapping.csv の行の期間（§92）の検証。
 * - 年月の形式・開始 > 終了 → error
 * - 同じ探し方（作業コード、または 顧客・案件・キーワード）の行で、契約の期間と行の期間の重なる月が別の契約を指す → warning（一意に決まらない）
 * - 行の期間が契約の期間と 1 か月も重ならない → warning（その行は使われない）
 */
export function validateMappingPeriods(rules: readonly MappingRule[], contracts: readonly Contract[]): MappingRowIssue[] {
  const issues: MappingRowIssue[] = [];
  const contractById = new Map<string, Contract>();
  for (const c of contracts) if (!contractById.has(c.contractId)) contractById.set(c.contractId, c);
  const file = "mapping.csv";
  // 有効な期間（行 ∩ 契約）
  const spans: Array<{ row: number; key: string; contractId: string; from: YearMonth; to: YearMonth }> = [];
  rules.forEach((r, i) => {
    const row = i + 2;
    let ok = true;
    for (const [col, v] of [["start_month", r.startMonth], ["end_month", r.endMonth]] as const) {
      if (v && !isValidYearMonth(v)) {
        issues.push({ severity: "error", code: "MAPPING_MONTH_INVALID", row, message: fmt(T.checks.mappingMonthInvalid, { file, row, column: col, value: v }), ref: { column: col } });
        ok = false;
      }
    }
    if (!ok) return;
    if (r.startMonth && r.endMonth && r.startMonth > r.endMonth) {
      issues.push({ severity: "error", code: "MAPPING_PERIOD_INVERTED", row, message: fmt(T.checks.mappingPeriodInverted, { file, row, from: r.startMonth, to: r.endMonth }), ref: {} });
      return;
    }
    const c = contractById.get(r.contractId);
    if (!c || !isValidYearMonth(c.startMonth) || !isValidYearMonth(c.endMonth) || c.startMonth > c.endMonth) return;
    const from = maxMonth(r.startMonth, c.startMonth);
    const to = minMonth(r.endMonth, c.endMonth);
    if (from > to) {
      if (r.startMonth || r.endMonth) {
        issues.push({ severity: "warning", code: "MAPPING_OUTSIDE_CONTRACT", row, message: fmt(T.checks.mappingOutsideContract, { file, row, contractId: r.contractId, from: c.startMonth, to: c.endMonth }), ref: { contractId: r.contractId } });
      }
      return;
    }
    const key = isCodeRule(r)
      ? `code\u0000${normalizeCode(r.taskCode)}`
      : `name\u0000${normalizeName(r.worklogCustomerName)}\u0000${normalizeName(r.worklogProjectName)}\u0000${[...(r.taskInclude ?? [])].map(normalizeKeyword).sort().join("|")}\u0000${[...(r.taskExclude ?? [])].map(normalizeKeyword).sort().join("|")}`;
    spans.push({ row, key, contractId: r.contractId, from, to });
  });
  const seen = new Set<string>();
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i]!;
      const b = spans[j]!;
      if (a.key !== b.key || a.contractId === b.contractId) continue;
      const from = a.from > b.from ? a.from : b.from;
      const to = a.to < b.to ? a.to : b.to;
      if (from > to) continue;
      const pair = `${a.row}:${b.row}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      issues.push({
        severity: "warning",
        code: "MAPPING_PERIOD_OVERLAP",
        row: b.row,
        message: fmt(T.checks.mappingPeriodOverlap, { file, row: b.row, other: a.row, contractId: b.contractId, otherContractId: a.contractId, from, to }),
        ref: { contractId: b.contractId, otherContractId: a.contractId, from, to },
      });
    }
  }
  return issues;
}
