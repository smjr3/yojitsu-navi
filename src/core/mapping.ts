/**
 * 作業実績と契約の紐付け（SPEC §4.2・§86）・作業名のキーワードによる振り分け（§62）・作業コードと行の期間（§92）
 */
import { isValidISODate, monthOfDate } from "./calendar.js";
import { includesAnyKeyword, normalizeCode, normalizeKeyword, normalizeName } from "./normalize.js";
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

interface RuleEntry {
  /** 存在する契約。存在しない・除外中の契約を指す行は null */
  contract: Contract | null;
  excluded: boolean;
  cond: KeywordCond;
  /** 行の期間（§92。省略 = 期限なし） */
  startMonth?: YearMonth;
  endMonth?: YearMonth;
}

interface RuleTarget {
  /** 探し方のキー（曖昧さの警告をまとめるため） */
  key: string;
  /** 作業コードの行か（§92。キーワードは使わない） */
  byCode: boolean;
  entries: RuleEntry[];
}

function ruleKey(customer: string, project: string): string {
  return `${customer}\u0000${project}`;
}

interface KeywordCond {
  include: readonly string[];
  exclude: readonly string[];
}

function condOf(rule: MappingRule): KeywordCond {
  return { include: rule.taskInclude ?? [], exclude: rule.taskExclude ?? [] };
}

function hasKeywords(c: KeywordCond): boolean {
  return c.include.length > 0 || c.exclude.length > 0;
}

/** 作業名（normalizeKeyword 済み）が条件に合うか。除くが含むより優先。含むが空なら除く以外すべて */
function passes(c: KeywordCond, task: string): boolean {
  if (includesAnyKeyword(task, c.exclude)) return false;
  return c.include.length === 0 || includesAnyKeyword(task, c.include);
}

/** 作業コードの行か（§92） */
export function isCodeRule(rule: Pick<MappingRule, "taskCode">): boolean {
  return normalizeCode(rule.taskCode) !== "";
}

/** 行の期間が月を含むか（§92。空は期限なし） */
export function ruleCoversMonth(rule: { startMonth?: YearMonth | undefined; endMonth?: YearMonth | undefined }, month: YearMonth): boolean {
  return (!rule.startMonth || rule.startMonth <= month) && (!rule.endMonth || month <= rule.endMonth);
}

/**
 * 作業名のキーワードによる振り分け（§62.1）。
 * - hit: その (顧客, 案件) のルールにキーワードがあり、どれかの条件に合う → 運用保守
 * - miss: キーワードがあるが、どの条件にも合わない → 運用保守以外
 * - none: キーワードの無いルール（または顧客名なし・ルールなし）→ 作業種別の分類表で決める
 * ルールの探し方は mapWorklogs と同じ（(顧客, 案件) → 無ければ (顧客, "")）。
 * 作業コードの行（§92）がある作業は、人が案件に割り当てたものなので常に hit
 */
export type KeywordMatch = "hit" | "miss" | "none";

export interface KeywordRouter {
  /** キーワードのあるルールが 1 行以上ある */
  readonly enabled: boolean;
  match(w: Pick<Worklog, "customerName" | "projectName" | "task" | "taskCode">): KeywordMatch;
}

export function createKeywordRouter(rules: readonly MappingRule[]): KeywordRouter {
  const index = new Map<string, KeywordCond[]>();
  const codes = new Set<string>();
  for (const rule of rules) {
    if (isCodeRule(rule)) {
      codes.add(normalizeCode(rule.taskCode));
      continue;
    }
    const key = ruleKey(normalizeName(rule.worklogCustomerName), normalizeName(rule.worklogProjectName));
    const list = index.get(key);
    if (list) list.push(condOf(rule));
    else index.set(key, [condOf(rule)]);
  }
  const enabled = [...index.values()].some((list) => list.some(hasKeywords));
  return {
    enabled,
    match(w) {
      if (!enabled) return "none";
      if (codes.size > 0 && codes.has(normalizeCode(w.taskCode))) return "hit";
      const customer = normalizeName(w.customerName);
      if (customer === "") return "none";
      const conds = index.get(ruleKey(customer, normalizeName(w.projectName))) ?? index.get(ruleKey(customer, ""));
      if (!conds || !conds.some(hasKeywords)) return "none";
      const task = normalizeKeyword(w.task);
      return conds.some((c) => passes(c, task)) ? "hit" : "miss";
    },
  };
}

interface RuleIndex {
  byName: Map<string, RuleTarget>;
  byCode: Map<string, RuleTarget>;
}

/** 名前のキー・作業コード → ルールの行。存在しない契約IDには MAPPING_UNKNOWN_CONTRACT 警告 */
function buildRuleIndex(
  rules: readonly MappingRule[],
  contractsById: ReadonlyMap<string, Contract>,
  warnings: Warning[],
  excludedContracts: ReadonlyMap<string, string>,
): RuleIndex {
  const byName = new Map<string, RuleTarget>();
  const byCode = new Map<string, RuleTarget>();
  rules.forEach((rule, i) => {
    const code = normalizeCode(rule.taskCode);
    const map = code !== "" ? byCode : byName;
    const key = code !== "" ? code : ruleKey(normalizeName(rule.worklogCustomerName), normalizeName(rule.worklogProjectName));
    let target = map.get(key);
    if (!target) {
      target = { key: code !== "" ? `code\u0000${key}` : `name\u0000${key}`, byCode: code !== "", entries: [] };
      map.set(key, target);
    }
    const contract = contractsById.get(rule.contractId) ?? null;
    const excludedReason = excludedContracts.get(rule.contractId);
    const entry: RuleEntry = { contract, excluded: !contract && excludedReason !== undefined, cond: condOf(rule) };
    if (rule.startMonth) entry.startMonth = rule.startMonth;
    if (rule.endMonth) entry.endMonth = rule.endMonth;
    target.entries.push(entry);
    const where = code !== "" ? { customer: rule.worklogCustomerName, project: fmt(T.calcWarnings.taskCodeLabel, { code: rule.taskCode ?? "" }) } : { customer: rule.worklogCustomerName, project: rule.worklogProjectName };
    if (!contract && excludedReason !== undefined) {
      warnings.push({
        code: "MAPPING_EXCLUDED_CONTRACT",
        message: fmt(T.calcWarnings.mappingExcludedContract, { row: i + 2, customer: where.customer, project: where.project, contractId: rule.contractId, reason: excludedReason }),
        ref: { row: i + 2, customerName: rule.worklogCustomerName, projectName: rule.worklogProjectName, contractId: rule.contractId },
      });
    } else if (!contract) {
      warnings.push({
        code: "MAPPING_UNKNOWN_CONTRACT",
        message: fmt(T.calcWarnings.mappingUnknownContract, { row: i + 2, customer: where.customer, project: where.project, contractId: rule.contractId }),
        ref: { row: i + 2, customerName: rule.worklogCustomerName, projectName: rule.worklogProjectName, contractId: rule.contractId },
      });
    }
  });
  return { byName, byCode };
}

/** 契約ID昇順の比較 */
function byContractId(a: Contract, b: Contract): number {
  return a.contractId < b.contractId ? -1 : a.contractId > b.contractId ? 1 : 0;
}

/**
 * 行の候補から契約を選ぶ（§86.1 の 5.）。期間（§92）に合う行だけを見る。
 * キーワードのある行があれば合った行、無い・どれにも合わないときは全行（合わない作業は運用保守以外として関連契約を探すときだけここに来る。§62.1）。
 * 合った行の契約がすべて存在しない・除外中なら契約は空で、その理由を返す（別の契約に回さない）
 */
function candidatesFor(target: RuleTarget, month: YearMonth, taskName: string): { contracts: Contract[]; reason?: UnmappedReason } {
  const inPeriod = target.entries.filter((e) => ruleCoversMonth(e, month));
  if (inPeriod.length === 0) return { contracts: [], reason: "RULE_OUT_OF_PERIOD" };
  let selected = inPeriod;
  if (!target.byCode && inPeriod.some((e) => hasKeywords(e.cond))) {
    const task = normalizeKeyword(taskName);
    const hits = inPeriod.filter((e) => passes(e.cond, task));
    if (hits.length > 0) selected = hits;
  }
  const seen = new Set<string>();
  const contracts: Contract[] = [];
  for (const e of selected) {
    if (e.contract && !seen.has(e.contract.contractId)) {
      seen.add(e.contract.contractId);
      contracts.push(e.contract);
    }
  }
  contracts.sort(byContractId);
  if (contracts.length > 0) return { contracts };
  return { contracts, reason: selected.some((e) => e.excluded) ? "EXCLUDED_CONTRACT" : "UNKNOWN_CONTRACT" };
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
  const hasCodeRules = ruleIndex.byCode.size > 0;

  const mappings: WorklogMapping[] = [];
  const assigned: MappingResult["assigned"] = [];
  const unmappedGroups = new Map<string, UnmappedWorklogGroup>();
  const ambiguous = new Map<string, AmbiguousAcc>();
  // 同じ (ルール, 月, 作業名) の候補は同じなので覚えておく（10 万行規模で行ごとに探さない）
  const candidateCache = new Map<string, { contracts: Contract[]; reason?: UnmappedReason }>();
  let excludedHours = 0;
  let excludedCount = 0;
  let ignoredCount = 0;

  const addUnmapped = (w: Worklog, reason: UnmappedReason, code: string | null): void => {
    const key = code !== null ? `\u0001${code}\u0000${reason}` : `${w.customerName}\u0000${w.projectName}\u0000${reason}`;
    const g = unmappedGroups.get(key);
    if (g) {
      g.hours += w.hours;
      g.count += 1;
      if (w.date < g.firstDate) g.firstDate = w.date;
      if (w.date > g.lastDate) g.lastDate = w.date;
    } else {
      const group: UnmappedWorklogGroup = {
        customerName: w.customerName,
        projectName: w.projectName,
        hours: w.hours,
        count: 1,
        firstDate: w.date as ISODate,
        lastDate: w.date as ISODate,
        reason,
      };
      if (code !== null) group.taskCode = (w.taskCode ?? "").trim();
      unmappedGroups.set(key, group);
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
    // 作業コードの行（§92）があれば、顧客名・案件名より先にそれで探す
    const code = hasCodeRules ? normalizeCode(w.taskCode) : "";
    const codeTarget = code !== "" ? ruleIndex.byCode.get(code) : undefined;
    const customer = normalizeName(w.customerName);
    if (!codeTarget && customer === "") {
      mappings.push({ kind: "excluded", worklog: w, month, reason: "NO_CUSTOMER" });
      excludedHours += w.hours;
      excludedCount++;
      continue;
    }
    const project = normalizeName(w.projectName);
    // (顧客, 案件) の完全一致 → 無ければ (顧客, "")
    const target = codeTarget ?? ruleIndex.byName.get(ruleKey(customer, project)) ?? ruleIndex.byName.get(ruleKey(customer, ""));
    const groupCode = codeTarget ? code : null;
    if (!target) {
      mappings.push({ kind: "unmapped", worklog: w, month, reason: "NO_RULE" });
      addUnmapped(w, "NO_RULE", null);
      continue;
    }
    const cacheKey = `${target.key}\u0000${month}\u0000${target.byCode ? "" : w.task}`;
    let candidates = candidateCache.get(cacheKey);
    if (!candidates) {
      candidates = candidatesFor(target, month, w.task);
      candidateCache.set(cacheKey, candidates);
    }
    if (candidates.reason) {
      mappings.push({ kind: "unmapped", worklog: w, month, reason: candidates.reason });
      addUnmapped(w, candidates.reason, groupCode);
      continue;
    }
    const inPeriod = candidates.contracts.filter((c) => c.startMonth <= month && month <= c.endMonth);
    if (inPeriod.length === 0) {
      mappings.push({ kind: "unmapped", worklog: w, month, reason: "OUT_OF_PERIOD" });
      addUnmapped(w, "OUT_OF_PERIOD", groupCode);
      continue;
    }
    const chosen = inPeriod[0] as Contract; // 契約ID昇順の先頭
    if (inPeriod.length > 1) {
      const key = `${target.key}\u0000${chosen.contractId}`;
      const acc = ambiguous.get(key);
      if (acc) {
        acc.hours += w.hours;
        acc.count += 1;
        for (const c of inPeriod) acc.contractIds.add(c.contractId);
      } else {
        ambiguous.set(key, {
          customerName: w.customerName,
          projectName: groupCode !== null ? fmt(T.calcWarnings.taskCodeLabel, { code: (w.taskCode ?? "").trim() }) : w.projectName,
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
    const project = g.taskCode !== undefined ? fmt(T.calcWarnings.taskCodeLabel, { code: g.taskCode }) : g.projectName;
    warnings.push({
      code: "UNMAPPED_WORKLOG",
      message: fmt(T.calcWarnings.unmappedWorklog, { customer: g.customerName, project, count: g.count, hours: g.hours, firstDate: g.firstDate, lastDate: g.lastDate, reason: unmappedReasonLabel(g.reason) }),
      ref: { customerName: g.customerName, projectName: g.projectName, reason: g.reason, ...(g.taskCode !== undefined ? { taskCode: g.taskCode } : {}) },
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
    case "RULE_OUT_OF_PERIOD":
      return T.calcWarnings.reasonRuleOutOfPeriod;
    case "OUT_OF_PERIOD":
      return T.calcWarnings.reasonOutOfPeriod;
    case "UNKNOWN_CONTRACT":
      return T.calcWarnings.reasonUnknownContract;
    case "EXCLUDED_CONTRACT":
      return T.calcWarnings.reasonExcludedContract;
  }
}
