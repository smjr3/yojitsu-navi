/**
 * 作業種別と契約外の工数（SPEC §30）
 *
 * - 分類表（task-types.csv）で作業種別を契約内／契約外に分ける（createTaskClassifier）
 * - 契約外の作業ログは契約の実績に入れず、時間だけを工数の明細（WorkRow）に残す
 * - 契約内の実績額は、契約・月・メンバーの実績行を作業種別の時間で最大剰余法により按分する（合計が実績と一致）
 * - 画面は workRows（data/work-hours.json）を期間・軸で合算する（aggregateWork / workByTask / workMonthlySeries）
 */
import { isValidISODate, monthOfDate, monthRange } from "./calendar.js";
import { NONE_CUSTOMER_KEY, NONE_CUSTOMER_LABEL, customerKey } from "./customers.js";
import { createEffectiveIndex, memberAt, type EffectiveIndex, type MasterIndex } from "./masters.js";
import { createKeywordRouter } from "./mapping.js";
import { normalizeCode, normalizeKeyword, normalizeName } from "./normalize.js";
import type { ProjectMatcher } from "./projectFromTask.js";
import { monthStatusFromMeta } from "./status.js";
import type { ContractResult, KeywordUnmatchedGroup, MappingRule, MemberRecord, Model, MonthStatus, Period, TaskCategory, TaskTypeRule, TeamNode, Warning, Worklog, WorkRow, YearMonth } from "./types.js";
import { T, fmt } from "../i18n/index.js";
import { addMemberHours, memberHoursList, type MemberHoursAcc } from "./worklogMembers.js";

// ---------------------------------------------------------------------------
// 分類（§30.1）
// ---------------------------------------------------------------------------

/** category 列の値 → 区分。不正なら null（契約内／契約外、contract／outside。前後空白・大文字小文字は問わない） */
export function parseTaskCategory(value: string | null | undefined): TaskCategory | null {
  const v = (value ?? "").normalize("NFKC").trim().toLowerCase();
  // 画面の呼び名は「運用保守」「運用保守以外」（§50）。旧表記の 契約内・契約外 も受け付ける
  if (v === "運用保守" || v === "契約内" || v === "contract") return "contract";
  if (v === "運用保守以外" || v === "契約外" || v === "outside") return "outside";
  return null;
}

export interface TaskClassification {
  category: TaskCategory;
  /** 契約外の種別（§50.1。group、無ければ分類表の task の表記）。契約内は "" */
  group: string;
  /** 内訳に出す作業種別の表記（完全一致・分類表に無い = 作業名そのまま、含む（§62.2）= 当たった行の task） */
  label: string;
  /** 分類表に無い（契約内として数える）。分類表が空のときは常に false */
  unclassified: boolean;
  /** 作業名のキーワードに合致せず運用保守以外にした（§62.1） */
  keywordMiss?: boolean;
}

export interface TaskClassifier {
  /** 分類表に 1 行以上ある、または紐付けルールに作業名のキーワードがある */
  readonly enabled: boolean;
  /** 作業種別（作業名）だけで分類する（分類表のみ） */
  classify(task: string): TaskClassification;
  /** 作業ログを分類する。紐付けルールのキーワード（§62.1）があればそれを優先する */
  classifyWorklog(w: Pick<Worklog, "customerName" | "projectName" | "task" | "taskCode"> & { date?: string }): TaskClassification;
}

/**
 * 分類表（と紐付けルールの作業名キーワード）から分類器を作る。
 * 照合は 完全一致（正規化後）→ 含む（§62.2。ファイルの順で最初の行）。正規化後に同じ作業種別が複数あれば先の行を使う
 */
export function createTaskClassifier(rules: readonly TaskTypeRule[] | undefined, mappings: readonly MappingRule[] = [], projects?: ProjectMatcher): TaskClassifier {
  const index = new Map<string, { category: TaskCategory; group: string }>();
  const contains: Array<{ key: string; task: string; category: TaskCategory; group: string }> = [];
  for (const r of rules ?? []) {
    const key = normalizeName(r.task);
    if (key === "" || index.has(key)) continue;
    const entry = { category: r.category, group: r.category === "outside" ? outsideTypeOf(r) : "" };
    index.set(key, entry);
    if (r.match === "contains") contains.push({ key: normalizeKeyword(r.task), task: r.task.trim(), ...entry });
  }
  const hasTypes = index.size > 0;
  const router = createKeywordRouter(mappings, projects);
  const cache = new Map<string, TaskClassification>();
  const classify = (task: string): TaskClassification => {
    let c = cache.get(task);
    if (c) return c;
    const hit = index.get(normalizeName(task));
    if (hit) c = { category: hit.category, group: hit.group, label: task, unclassified: false };
    else {
      const t = normalizeKeyword(task);
      const part = t === "" ? undefined : contains.find((r) => t.includes(r.key));
      c = part ? { category: part.category, group: part.group, label: part.task, unclassified: false } : { category: "contract", group: "", label: task, unclassified: hasTypes };
    }
    cache.set(task, c);
    return c;
  };
  const byWorklog = new Map<string, TaskClassification>();
  return {
    enabled: hasTypes || router.enabled,
    classify,
    classifyWorklog(w) {
      if (!router.enabled) return classify(w.task);
      // 作業コードの行・行の期間（§92）があれば、結果がコード・月で変わるのでキーに含める
      let key = `${w.customerName}${SEP}${w.projectName}${SEP}${w.task}`;
      if (router.dependsOnCode) key += `${SEP}${normalizeCode(w.taskCode)}`;
      if (router.dependsOnMonth) key += `${SEP}${(w.date ?? "").slice(0, 7)}`;
      let c = byWorklog.get(key);
      if (c) return c;
      const base = classify(w.task);
      const m = router.match(w);
      if (m === "hit") c = { category: "contract", group: "", label: base.label, unclassified: false };
      else if (m === "miss") c = { category: "outside", group: base.category === "outside" ? base.group : T.work.otherType, label: base.label, unclassified: false, keywordMiss: true };
      // 作業名に運用保守の目印が無く、紐付けの行も無い（§97）
      else if (m === "unmarked") c = { category: "outside", group: base.category === "outside" ? base.group : T.work.otherType, label: base.label, unclassified: false };
      else c = base;
      byWorklog.set(key, c);
      return c;
    },
  };
}

/**
 * 契約外として契約の紐付けから外す作業ログか（hours・日付が正しく、分類が契約外）。
 * 顧客名の無い作業（会社業務など）も契約外なら残す（§50.2。契約内の顧客名なしは従来どおり除外）
 */
export function isOutsideWorklog(w: Worklog, classifier: TaskClassifier): boolean {
  if (!classifier.enabled) return false;
  if (typeof w.hours !== "number" || !Number.isFinite(w.hours) || w.hours <= 0) return false;
  if (!isValidISODate(w.date)) return false;
  return classifier.classifyWorklog(w).category === "outside";
}

/** キーワードに合致せず運用保守以外にした作業を (顧客名, 案件名, 作業名)（正規化後）でまとめる（§62.3。時間の多い順） */
export function keywordUnmatchedGroups(worklogs: readonly Worklog[], classifier: TaskClassifier): KeywordUnmatchedGroup[] {
  const acc = new Map<string, KeywordUnmatchedGroup>();
  const people = new Map<KeywordUnmatchedGroup, MemberHoursAcc>();
  for (const w of worklogs) {
    if (!isOutsideWorklog(w, classifier)) continue;
    const c = classifier.classifyWorklog(w);
    if (!c.keywordMiss) continue;
    // 表記ゆれ（法人格・全角半角）は 1 行にまとめ、表記は最初の行のもの
    const key = [normalizeName(w.customerName), normalizeName(w.projectName), normalizeKeyword(w.task)].join(SEP);
    let g = acc.get(key);
    if (g) {
      g.hours += w.hours;
      g.count += 1;
      if (w.date < g.firstDate) g.firstDate = w.date;
      if (w.date > g.lastDate) g.lastDate = w.date;
    } else {
      g = { customerName: w.customerName, projectName: w.projectName, task: w.task, type: c.group, hours: w.hours, count: 1, firstDate: w.date, lastDate: w.date, members: [] };
      acc.set(key, g);
      people.set(g, new Map());
    }
    addMemberHours(people.get(g) as MemberHoursAcc, w);
  }
  for (const g of acc.values()) g.members = memberHoursList(people.get(g) as MemberHoursAcc);
  return [...acc.values()].sort((a, b) => b.hours - a.hours || cmp(a.customerName, b.customerName) || cmp(a.projectName, b.projectName) || cmp(a.task, b.task));
}

// ---------------------------------------------------------------------------
// 契約外の種別（§50.1）
// ---------------------------------------------------------------------------

/** 分類表の行の契約外の種別（group、空なら task の表記） */
export function outsideTypeOf(rule: Pick<TaskTypeRule, "task" | "group">): string {
  const g = (rule.group ?? "").trim();
  return g !== "" ? g : rule.task.trim();
}

/** 契約外の種別の一覧（契約外の行の種別。正規化して重複を除き、ファイルの順） */
export function outsideTypes(rules: readonly TaskTypeRule[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rules ?? []) {
    if (r.category !== "outside") continue;
    const t = outsideTypeOf(r);
    const key = normalizeName(t);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** メンバー別の契約外の行の ID（§50.3。契約ID と重ならない接頭辞） */
export const OUTSIDE_ROW_PREFIX = "~outside:";
export function outsideRowId(type: string): string {
  return `${OUTSIDE_ROW_PREFIX}${type}`;
}
/** メンバー別の行が契約外か */
export function isOutsideRow(row: { outsideType?: string | undefined }): boolean {
  return typeof row.outsideType === "string";
}

/** 未分類の作業種別の警告（作業種別ごとに 1 件。時間の多い順） */
export function unclassifiedTaskWarnings(worklogs: readonly Worklog[], classifier: TaskClassifier): Warning[] {
  if (!classifier.enabled) return [];
  const acc = new Map<string, { task: string; hours: number; count: number }>();
  for (const w of worklogs) {
    if (!classifier.classifyWorklog(w).unclassified) continue;
    const key = normalizeName(w.task);
    const a = acc.get(key);
    if (a) {
      a.hours += w.hours;
      a.count += 1;
    } else acc.set(key, { task: w.task, hours: w.hours, count: 1 });
  }
  return [...acc.values()]
    .sort((a, b) => b.hours - a.hours || (a.task < b.task ? -1 : a.task > b.task ? 1 : 0))
    .map((a) => ({
      code: "TASK_UNCLASSIFIED" as const,
      message: fmt(T.calcWarnings.taskUnclassified, { task: a.task === "" ? T.work.emptyTask : a.task, count: a.count, hours: Math.round(a.hours * 100) / 100 }),
      ref: { task: a.task },
      hours: a.hours,
      count: a.count,
    }));
}

// ---------------------------------------------------------------------------
// 工数の明細（§30.2）
// ---------------------------------------------------------------------------

/**
 * 整数 total を weights の比で按分する（最大剰余法）。合計は必ず total。
 * 同じ剰余は添字の小さい方を優先（決定的）。weights の合計が 0 以下なら先頭に全額。
 */
export function apportion(total: number, weights: readonly number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const sum = weights.reduce((s, w) => s + (w > 0 ? w : 0), 0);
  if (!(sum > 0)) return weights.map((_, i) => (i === 0 ? total : 0));
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const raw = weights.map((w) => (abs * (w > 0 ? w : 0)) / sum);
  const out = raw.map((r) => Math.floor(r));
  let rest = abs - out.reduce((s, v) => s + v, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) out[(order[k] as { i: number }).i]! += 1;
  return out.map((v) => v * sign);
}

const SEP = "\u0000";

interface OutsideInput {
  worklog: Worklog;
  month: YearMonth;
  /** 紐付けルールに当たった関連契約（無ければ null） */
  contractId: string | null;
}

/**
 * 工数の明細を作る。
 * @param results 契約の計算結果（months[].worklogs・costLines を使う。stripWorklogs する前のもの）
 * @param outside 契約外の作業ログ（関連契約付き）
 */
export function buildWorkRows(results: readonly ContractResult[], outside: readonly OutsideInput[], classifier: TaskClassifier, masters: MasterIndex): WorkRow[] {
  const rows: WorkRow[] = [];
  const contractById = new Map(results.map((r) => [r.contract.contractId, r.contract]));

  // 契約内: 契約・月・メンバーの実績額を作業種別の時間で按分
  for (const r of results) {
    const cKey = customerKey(r.contract.customerName);
    for (const cm of r.months) {
      if (cm.worklogs.length === 0) continue;
      // 作業種別の表記（§62.2 の含むなら分類表の task）ごとの時間。未分類はその表記の作業ログのどれかが未分類なら立てる
      const byMember = new Map<string, Map<string, number>>();
      const unclassified = new Set<string>();
      for (const w of cm.worklogs) {
        let tasks = byMember.get(w.memberId);
        if (!tasks) byMember.set(w.memberId, (tasks = new Map()));
        const c = classifier.classifyWorklog(w);
        tasks.set(c.label, (tasks.get(c.label) ?? 0) + w.hours);
        if (c.unclassified) unclassified.add(c.label);
      }
      for (const line of cm.costLines) {
        const tasks = byMember.get(line.memberId);
        if (!tasks) continue;
        const names = [...tasks.keys()].sort();
        const hours = names.map((t) => tasks.get(t) as number);
        const amounts = apportion(line.amount, hours);
        names.forEach((task, i) => {
          rows.push({
            month: cm.month,
            memberId: line.memberId,
            memberName: line.memberName,
            teamId: line.memberTeamId,
            contractId: r.contract.contractId,
            customerKey: cKey,
            customerName: r.contract.customerName,
            task,
            category: "contract",
            unclassified: unclassified.has(task),
            hours: hours[i] as number,
            amount: amounts[i] as number,
          });
        });
        byMember.delete(line.memberId);
      }
    }
  }

  // 契約外: 時間だけ（金額は出さない）
  const acc = new Map<string, WorkRow>();
  for (const o of outside) {
    const w = o.worklog;
    const contract = o.contractId ? contractById.get(o.contractId) : undefined;
    const customerName = contract ? contract.customerName : w.customerName;
    const cKey = customerKey(customerName);
    const task = classifier.classifyWorklog(w).label;
    const key = [o.month, w.memberId, o.contractId ?? "", cKey, task].join(SEP);
    const hit = acc.get(key);
    if (hit) {
      hit.hours += w.hours;
      continue;
    }
    const member = memberAt(masters, w.memberId, o.month);
    acc.set(key, {
      month: o.month,
      memberId: w.memberId,
      memberName: member?.name ?? w.memberName,
      teamId: member?.teamId ? member.teamId : null,
      contractId: o.contractId,
      customerKey: cKey,
      customerName,
      task,
      category: "outside",
      unclassified: false,
      hours: w.hours,
      amount: null,
    });
  }
  rows.push(...acc.values());

  return rows.sort(compareWorkRows);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareWorkRows(a: WorkRow, b: WorkRow): number {
  return (
    cmp(a.month, b.month) ||
    cmp(a.memberId, b.memberId) ||
    cmp(a.contractId ?? "￿", b.contractId ?? "￿") ||
    cmp(a.customerKey, b.customerKey) ||
    cmp(a.category, b.category) ||
    cmp(a.task, b.task)
  );
}

// ---------------------------------------------------------------------------
// 集計（画面側。WorkRow[] に対して実行する）
// ---------------------------------------------------------------------------

export type WorkAxis = "team" | "customer" | "member";

/** 工数の合計（時間）。人月は personMonths で換算する */
export interface WorkTotals {
  contractHours: number;
  outsideHours: number;
  totalHours: number;
  /** 契約内の実績額（按分の合計） */
  contractAmount: number;
  /** 契約外の割合（合計 0 → null） */
  outsideShare: number | null;
  /** 期間内に工数のある人数 */
  memberCount: number;
  /** 期間内の経過月数（m <= asOf 月） */
  elapsedMonths: number;
  /** 1人あたり月平均の時間（人数・経過月 0 → null） */
  hoursPerMemberMonth: number | null;
}

export interface WorkFilter {
  period: Period;
  /** 省略 = 全員 */
  memberIds?: ReadonlySet<string> | readonly string[];
  /** 契約に紐付く行だけ（契約外は関連契約で判定）。省略 = 全行 */
  contractIds?: ReadonlySet<string> | readonly string[];
  /** 顧客キー。省略 = 全顧客 */
  customerKeys?: ReadonlySet<string> | readonly string[];
}

const toSet = (v: ReadonlySet<string> | readonly string[] | undefined): ReadonlySet<string> | null => (v === undefined ? null : v instanceof Set ? v : new Set(v as readonly string[]));

/** 期間・条件に合う行 */
export function filterWorkRows(rows: readonly WorkRow[], filter: WorkFilter): WorkRow[] {
  const members = toSet(filter.memberIds);
  const contracts = toSet(filter.contractIds);
  const customers = toSet(filter.customerKeys);
  return rows.filter(
    (r) =>
      r.month >= filter.period.from &&
      r.month <= filter.period.to &&
      (!members || members.has(r.memberId)) &&
      (!contracts || (r.contractId !== null && contracts.has(r.contractId))) &&
      (!customers || customers.has(r.customerKey)),
  );
}

/** 期間の経過月数（期間内で m <= asOfMonth） */
export function elapsedMonthCount(period: Period, asOfMonth: YearMonth): number {
  if (period.from > asOfMonth) return 0;
  const to = period.to < asOfMonth ? period.to : asOfMonth;
  return monthRange(period.from, to).length;
}

/** 行の合計 */
export function workTotals(rows: readonly WorkRow[], elapsedMonths: number): WorkTotals {
  let contractHours = 0;
  let outsideHours = 0;
  let contractAmount = 0;
  const members = new Set<string>();
  for (const r of rows) {
    if (r.category === "outside") outsideHours += r.hours;
    else {
      contractHours += r.hours;
      contractAmount += r.amount ?? 0;
    }
    if (r.hours > 0) members.add(r.memberId);
  }
  const totalHours = contractHours + outsideHours;
  const memberCount = members.size;
  return {
    contractHours,
    outsideHours,
    totalHours,
    contractAmount,
    outsideShare: totalHours > 0 ? outsideHours / totalHours : null,
    memberCount,
    elapsedMonths,
    hoursPerMemberMonth: memberCount > 0 && elapsedMonths > 0 ? totalHours / memberCount / elapsedMonths : null,
  };
}

/** 時間 → 人月（標準基準 §30.2） */
export function personMonths(hours: number, standardHoursPerMonth: number): number {
  return standardHoursPerMonth > 0 ? hours / standardHoursPerMonth : 0;
}

export interface WorkTaskLine {
  task: string;
  category: TaskCategory;
  unclassified: boolean;
  hours: number;
  /** 契約内のみ。契約外は null */
  amount: number | null;
  /** 同じ区分の合計に占める時間の割合（合計 0 → null） */
  share: number | null;
  /** 月 → 時間 */
  byMonth: Record<YearMonth, number>;
}

/** 作業種別ごとの内訳。契約内 → 契約外、それぞれ時間の多い順（同じなら作業種別の文字順） */
export function workByTask(rows: readonly WorkRow[]): WorkTaskLine[] {
  const acc = new Map<string, WorkTaskLine>();
  const totals: Record<TaskCategory, number> = { contract: 0, outside: 0 };
  for (const r of rows) {
    const key = `${r.category}${SEP}${r.task}`;
    let line = acc.get(key);
    if (!line) acc.set(key, (line = { task: r.task, category: r.category, unclassified: r.unclassified, hours: 0, amount: r.category === "outside" ? null : 0, share: null, byMonth: {} }));
    line.hours += r.hours;
    if (line.amount !== null) line.amount += r.amount ?? 0;
    line.byMonth[r.month] = (line.byMonth[r.month] ?? 0) + r.hours;
    totals[r.category] += r.hours;
  }
  const lines = [...acc.values()];
  for (const l of lines) l.share = totals[l.category] > 0 ? l.hours / totals[l.category] : null;
  const rank = (c: TaskCategory): number => (c === "contract" ? 0 : 1);
  return lines.sort((a, b) => rank(a.category) - rank(b.category) || b.hours - a.hours || cmp(a.task, b.task));
}

export interface WorkMonthlyPoint {
  month: YearMonth;
  status: MonthStatus;
  contractHours: number;
  outsideHours: number;
  /** 工数のある人数 */
  memberCount: number;
}

/** 期間の全月の推移（データの無い月は 0） */
export function workMonthlySeries(rows: readonly WorkRow[], period: Period, meta: { asOfMonth: YearMonth; lastFinalMonth: YearMonth }): WorkMonthlyPoint[] {
  const points = new Map<YearMonth, WorkMonthlyPoint & { members: Set<string> }>();
  for (const month of monthRange(period.from, period.to)) {
    points.set(month, { month, status: monthStatusFromMeta(month, meta), contractHours: 0, outsideHours: 0, memberCount: 0, members: new Set() });
  }
  for (const r of rows) {
    const p = points.get(r.month);
    if (!p) continue;
    if (r.category === "outside") p.outsideHours += r.hours;
    else p.contractHours += r.hours;
    if (r.hours > 0) p.members.add(r.memberId);
  }
  return [...points.values()].map(({ members, ...p }) => ({ ...p, memberCount: members.size }));
}

export interface WorkGroupRow {
  /** チームID・顧客キー・社員番号（未設定は UNASSIGNED_WORK_KEY） */
  key: string;
  label: string;
  totals: WorkTotals;
  /** この行に含めた明細（内訳の表示用） */
  rows: WorkRow[];
  /** 木表示（チーム） */
  depth: number;
  parentKey: string | null;
  hasChildren: boolean;
  /** メンバー軸: 基準月の所属チーム */
  teamId?: string | null;
}

/** 所属チーム・顧客が無い行を束ねるキー */
export const UNASSIGNED_WORK_KEY = "__unassigned__";

const memberIndexCache = new WeakMap<readonly MemberRecord[], EffectiveIndex<MemberRecord>>();
function memberIndexOf(members: readonly MemberRecord[]): EffectiveIndex<MemberRecord> {
  let index = memberIndexCache.get(members);
  if (!index) memberIndexCache.set(members, (index = createEffectiveIndex(members, (m) => m.memberId, (m) => m.effectiveFrom)));
  return index;
}

/** 基準月（§18 と同じ: 期間の終了月、未来なら asOf 月）のメンバーの所属チーム。マスタに無ければ期間内の最後の行の所属 */
export function memberTeamsAt(model: Pick<Model, "members">, rows: readonly WorkRow[], baseMonth: YearMonth): Map<string, string | null> {
  const index = memberIndexOf(model.members);
  const out = new Map<string, string | null>();
  const last = new Map<string, WorkRow>();
  for (const r of rows) {
    const prev = last.get(r.memberId);
    if (!prev || r.month >= prev.month) last.set(r.memberId, r);
  }
  for (const [memberId, r] of last) {
    const rec = index.at(memberId, baseMonth);
    out.set(memberId, rec ? (rec.teamId ? rec.teamId : null) : r.teamId);
  }
  return out;
}

export interface AggregateWorkOptions {
  period: Period;
  axis: WorkAxis;
  /** チーム軸の組織（期間の終了月の木）。rootTeamIds は表示順 */
  tree?: Record<string, TeamNode>;
  rootTeamIds?: readonly string[];
  /** 「未設定」の表示名 */
  unassignedLabel: string;
}

/**
 * 軸ごとの工数一覧。
 * - team: 基準月の所属チームで束ね、上位は配下の合計（木の順）。チームに属さない・木に無い人は末尾の「未設定」
 * - customer: 顧客キーごと（時間の多い順）
 * - member: メンバーごと（時間の多い順）
 * 期間内に工数の無いグループは出さない（チーム軸の上位は配下にあれば出す）。
 */
export function aggregateWork(model: Pick<Model, "meta" | "members">, rows: readonly WorkRow[], options: AggregateWorkOptions): WorkGroupRow[] {
  const { period } = options;
  const inPeriod = rows.filter((r) => r.month >= period.from && r.month <= period.to);
  const elapsed = elapsedMonthCount(period, model.meta.asOfMonth);
  const make = (key: string, label: string, list: WorkRow[], extra: Partial<WorkGroupRow> = {}): WorkGroupRow => ({
    key,
    label,
    totals: workTotals(list, elapsed),
    rows: list,
    depth: 0,
    parentKey: null,
    hasChildren: false,
    ...extra,
  });
  const byTotal = (a: WorkGroupRow, b: WorkGroupRow): number => b.totals.totalHours - a.totals.totalHours || cmp(a.label, b.label);

  if (options.axis === "customer") {
    const groups = new Map<string, { label: string; list: WorkRow[] }>();
    for (const r of inPeriod) {
      let g = groups.get(r.customerKey);
      // 顧客名の無い作業（社内業務など）は空欄にせず「顧客名なし」の名前で出す
      if (!g) groups.set(r.customerKey, (g = { label: r.customerKey === NONE_CUSTOMER_KEY ? (options.unassignedLabel ?? NONE_CUSTOMER_LABEL) : r.customerName, list: [] }));
      g.list.push(r);
    }
    return [...groups.entries()].map(([key, g]) => make(key, g.label, g.list)).sort(byTotal);
  }

  const baseMonth = period.to < model.meta.asOfMonth ? period.to : model.meta.asOfMonth;
  const teams = memberTeamsAt(model, inPeriod, baseMonth);

  if (options.axis === "member") {
    const groups = new Map<string, WorkRow[]>();
    for (const r of inPeriod) {
      const list = groups.get(r.memberId);
      if (list) list.push(r);
      else groups.set(r.memberId, [r]);
    }
    const index = memberIndexOf(model.members);
    return [...groups.entries()]
      .map(([memberId, list]) => {
        const rec = index.at(memberId, baseMonth);
        const name = rec?.name ?? (list[list.length - 1] as WorkRow).memberName;
        return make(memberId, name, list, { teamId: teams.get(memberId) ?? null });
      })
      .sort(byTotal);
  }

  // team
  const tree = options.tree ?? {};
  const byTeam = new Map<string, WorkRow[]>();
  for (const r of inPeriod) {
    const t = teams.get(r.memberId) ?? null;
    const key = t !== null && Object.hasOwn(tree, t) ? t : UNASSIGNED_WORK_KEY;
    const list = byTeam.get(key);
    if (list) list.push(r);
    else byTeam.set(key, [r]);
  }
  const out: WorkGroupRow[] = [];
  const visit = (id: string, depth: number, parent: string | null): void => {
    const node = tree[id];
    if (!node) return;
    const list: WorkRow[] = [];
    for (const d of node.descendantIds) list.push(...(byTeam.get(d) ?? []));
    if (list.length === 0) return;
    const children = node.children.filter((c) => tree[c]?.descendantIds.some((d) => (byTeam.get(d)?.length ?? 0) > 0));
    out.push(make(id, node.name, list, { depth, parentKey: parent, hasChildren: children.length > 0 }));
    for (const c of node.children) visit(c, depth + 1, id);
  };
  const roots = options.rootTeamIds ?? Object.values(tree).filter((n) => n.parentTeamId === null).map((n) => n.teamId);
  for (const id of roots) visit(id, 0, null);
  const un = byTeam.get(UNASSIGNED_WORK_KEY);
  if (un && un.length > 0) out.push(make(UNASSIGNED_WORK_KEY, options.unassignedLabel, un));
  return out;
}

/** 契約外の作業ログを月・関連契約付きにする（buildModel 用） */
export function outsideInputs(mappings: ReadonlyArray<{ kind: string; worklog: Worklog; month?: YearMonth; contractId?: string }>): OutsideInput[] {
  const out: OutsideInput[] = [];
  for (const m of mappings) {
    // 顧客名なし（excluded）の契約外も残す（§50.2）
    if (m.kind === "ignored") continue;
    out.push({ worklog: m.worklog, month: m.month ?? monthOfDate(m.worklog.date), contractId: m.kind === "assigned" ? (m.contractId ?? null) : null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 配布用の詰め方（data/work-hours.json）
// ---------------------------------------------------------------------------

/**
 * 辞書＋配列に詰めた WorkRow[]。r の各行 =
 * [月, 社員番号, メンバー名, チーム, 契約, 顧客キー, 顧客名, 作業種別, 区分(0=契約内/1=契約外), 未分類(0/1), 時間, 金額|null]
 * 文字列は dict の添字（null は -1）。
 */
export interface EncodedWorkRows {
  dict: string[];
  r: Array<[number, number, number, number, number, number, number, number, 0 | 1, 0 | 1, number, number | null]>;
}

export function encodeWorkRows(rows: readonly WorkRow[]): EncodedWorkRows {
  const dict: string[] = [];
  const index = new Map<string, number>();
  const id = (s: string | null): number => {
    if (s === null) return -1;
    let i = index.get(s);
    if (i === undefined) {
      i = dict.length;
      dict.push(s);
      index.set(s, i);
    }
    return i;
  };
  const r: EncodedWorkRows["r"] = rows.map((w) => [
    id(w.month),
    id(w.memberId),
    id(w.memberName),
    id(w.teamId),
    id(w.contractId),
    id(w.customerKey),
    id(w.customerName),
    id(w.task),
    w.category === "outside" ? 1 : 0,
    w.unclassified ? 1 : 0,
    w.hours,
    w.amount,
  ]);
  return { dict, r };
}

export function decodeWorkRows(data: EncodedWorkRows): WorkRow[] {
  const { dict } = data;
  const str = (i: number): string => dict[i] ?? "";
  const opt = (i: number): string | null => (i < 0 ? null : (dict[i] ?? null));
  return data.r.map((t) => ({
    month: str(t[0]),
    memberId: str(t[1]),
    memberName: str(t[2]),
    teamId: opt(t[3]),
    contractId: opt(t[4]),
    customerKey: str(t[5]),
    customerName: str(t[6]),
    task: str(t[7]),
    category: t[8] === 1 ? "outside" : "contract",
    unclassified: t[9] === 1,
    hours: t[10],
    amount: t[11],
  }));
}
