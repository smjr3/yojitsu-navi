/**
 * メンバー別の計画と実績（SPEC §18.1）
 *
 * 計画（予）= 配分人月 × 基準時間 × 単価、実績（実）= その人の工数原価（CostLine）。
 * buildModel で Model.memberMonths（メンバー×月、契約別の内訳付き）を作り、
 * 画面は aggregateMembers / memberMonthlySeries で期間を合算する（Model はプレーンな JSON のままで動く）。
 * 単価は §6 の rateFor をそのまま使う（原価・着地見込みと同じ関数）。
 */
import { isValidYearMonth, monthRange } from "./calendar.js";
import { normalizeName } from "./normalize.js";
import { roundYen } from "./cost.js";
import { createEffectiveIndex, createMasterIndex, isLeftRecord, leaveReasonOf, leftMonthOf, memberAt, rateFor, type EffectiveIndex, type MasterIndex } from "./masters.js";
import { monthStatusFromMeta } from "./status.js";
import { isOutsideRow, outsideRowId } from "./workTypes.js";
import type {
  Assignment,
  ContractResult,
  Dataset,
  MemberAggregate,
  MemberContractMonth,
  MemberContractTotals,
  MemberKind,
  MemberMonth,
  MemberMonthlyPoint,
  MemberRecord,
  MemberTotals,
  Model,
  OutsidePlan,
  Period,
  YearMonth,
} from "./types.js";

// ---------------------------------------------------------------------------
// 構築（buildModel から呼ぶ）
// ---------------------------------------------------------------------------

interface CellAcc {
  /** 契約外の行だけ: 種別 */
  outsideType?: string;
  allocation: number;
  assignmentCount: number;
  actualHours: number;
  actualCost: number;
  /** 作業ログ側の名前（マスタに無いメンバーの表示用） */
  worklogName: string | null;
}

const SEP = "\u0000";

/**
 * メンバー×月の計画と実績を作る。
 * - 計画: アサインのうち、計算対象の契約（results にある＝CONTRACT_INVALID・重複を除いた契約）で、
 *   月が契約期間内かつアサイン期間内のものだけ数える。allocation が数値でないアサインは無視（§10 と同じ）。
 * - 実績: 契約・月の CostLine を memberId ごとに拾う（原価の種類を問わない＝契約原価の合計と一致する）。
 * - 未アサインの工数: アサインが 1 件も掛からない（x, c, m）の実績。
 * 出力は memberId 昇順 → month 昇順、byContract は contractId 昇順（決定的）。
 */
export function buildMemberMonths(
  results: readonly ContractResult[],
  assignments: readonly Assignment[],
  masters: MasterIndex,
  standardHoursPerMonth: number,
  outside: MemberOutsideInput = {},
): MemberMonth[] {
  // (member, month) → (contract → 集計)
  const cells = new Map<string, Map<string, CellAcc>>();
  const cellOf = (memberId: string, month: YearMonth, contractId: string): CellAcc => {
    const key = `${memberId}${SEP}${month}`;
    let byContract = cells.get(key);
    if (!byContract) cells.set(key, (byContract = new Map()));
    let acc = byContract.get(contractId);
    if (!acc) byContract.set(contractId, (acc = { allocation: 0, assignmentCount: 0, actualHours: 0, actualCost: 0, worklogName: null }));
    return acc;
  };

  // 実績（CostLine）
  for (const r of results) {
    for (const cm of r.months) {
      for (const line of cm.costLines) {
        const acc = cellOf(line.memberId, cm.month, r.contract.contractId);
        acc.actualHours += line.hours;
        acc.actualCost += line.amount;
        acc.worklogName ??= line.memberName;
      }
    }
  }

  // 計画（アサイン）。契約期間外の月・計算対象外の契約は数えない
  const contractPeriod = new Map<string, { startMonth: YearMonth; endMonth: YearMonth }>();
  for (const r of results) contractPeriod.set(r.contract.contractId, r.contract);
  for (const a of assignments) {
    if (!Number.isFinite(a.allocation)) continue;
    const c = contractPeriod.get(a.contractId);
    if (!c) continue;
    const from = a.startMonth > c.startMonth ? a.startMonth : c.startMonth;
    const to = a.endMonth < c.endMonth ? a.endMonth : c.endMonth;
    if (from > to) continue;
    for (const month of monthRange(from, to)) {
      const acc = cellOf(a.memberId, month, a.contractId);
      acc.allocation += a.allocation;
      acc.assignmentCount += 1;
    }
  }

  // 契約外（§50.3）: 計画 = 契約外予定、実績 = 契約外の作業ログ（種別ごと）
  const outsideCell = (memberId: string, month: YearMonth, type: string): CellAcc => {
    // 表記ゆれ（全角・半角、大文字・小文字）は同じ種別として 1 行にまとめる（検証・リソース計画と同じ正規化）。表示名は最初の表記
    const acc = cellOf(memberId, month, outsideRowId(normalizeName(type)));
    acc.outsideType ??= type;
    return acc;
  };
  for (const o of outside.plans ?? []) {
    if (!Number.isFinite(o.personMonths) || !isValidYearMonth(o.startMonth) || !isValidYearMonth(o.endMonth) || o.startMonth > o.endMonth) continue;
    for (const month of monthRange(o.startMonth, o.endMonth)) {
      const acc = outsideCell(o.memberId, month, o.type);
      acc.allocation += o.personMonths;
      acc.assignmentCount += 1;
    }
  }
  for (const a of outside.actuals ?? []) {
    const acc = outsideCell(a.memberId, a.month, a.type);
    acc.actualHours += a.hours;
    acc.worklogName ??= a.memberName;
  }

  const keys = [...cells.keys()].sort();
  const out: MemberMonth[] = [];
  for (const key of keys) {
    const [memberId, month] = key.split(SEP) as [string, YearMonth];
    const byContractMap = cells.get(key) as Map<string, CellAcc>;
    const rate = rateFor(masters, memberId, month);
    const rec = memberAt(masters, memberId, month);
    let worklogName: string | null = null;
    const byContract: MemberContractMonth[] = [];
    let plannedHours = 0;
    let plannedCost = 0;
    let actualHours = 0;
    let actualCost = 0;
    let unplannedHours = 0;
    let unplannedCost = 0;
    for (const contractId of [...byContractMap.keys()].sort()) {
      const acc = byContractMap.get(contractId) as CellAcc;
      worklogName ??= acc.worklogName;
      const ph = acc.allocation * standardHoursPerMonth;
      const pc = roundYen(ph * rate.hourlyRate);
      if (acc.outsideType !== undefined) {
        // 契約外の実績額 = 時間 × 単価（§6 と同じ単価。種別・月ごとに円に丸める）。月の合計には入れない
        byContract.push({
          contractId,
          outsideType: acc.outsideType,
          allocation: acc.allocation,
          assignmentCount: acc.assignmentCount,
          plannedHours: ph,
          plannedCost: pc,
          actualHours: acc.actualHours,
          actualCost: roundYen(acc.actualHours * rate.hourlyRate),
        });
        continue;
      }
      byContract.push({
        contractId,
        allocation: acc.allocation,
        assignmentCount: acc.assignmentCount,
        plannedHours: ph,
        plannedCost: pc,
        actualHours: acc.actualHours,
        actualCost: acc.actualCost,
      });
      plannedHours += ph;
      plannedCost += pc;
      actualHours += acc.actualHours;
      actualCost += acc.actualCost;
      if (acc.assignmentCount === 0) {
        unplannedHours += acc.actualHours;
        unplannedCost += acc.actualCost;
      }
    }
    out.push({
      memberId,
      month,
      memberName: rec?.name ?? worklogName ?? memberId,
      memberUnknown: rate.memberUnknown,
      kind: rec?.kind ?? null,
      title: rec?.title ? rec.title : null,
      teamId: rec?.teamId ? rec.teamId : null,
      hourlyRate: rate.hourlyRate,
      rateSource: rate.rateSource,
      rateMissing: rate.rateMissing,
      standardHoursPerMonth,
      plannedHours,
      plannedCost,
      actualHours,
      actualCost,
      unplannedHours,
      unplannedCost,
      variance: plannedCost - actualCost,
      byContract,
    });
  }
  return out;
}

/** buildMemberMonths の契約外の入力（§50.3） */
export interface MemberOutsideInput {
  plans?: readonly OutsidePlan[];
  /** 契約外の作業ログの時間（メンバー・月・種別ごと） */
  actuals?: ReadonlyArray<{ memberId: string; memberName: string; month: YearMonth; type: string; hours: number }>;
}

// ---------------------------------------------------------------------------
// 集計（画面側。Model に対して実行する）
// ---------------------------------------------------------------------------

export interface MemberScope {
  period: Period;
  /** 所属チーム（基準月の値）がこの集合に含まれるメンバーだけ（配下を含めたい場合は descendantIds を渡す）。省略 = 全員 */
  teamIds?: readonly string[];
  /** 基準月の所属チームが空のメンバーも含めるか（teamIds と併用。未設定グループ用） */
  includeNoTeam?: boolean;
  /** 対象メンバー。省略 = 全員 */
  memberIds?: readonly string[];
  /** 対象契約（byContract を絞る）。省略 = 全契約 */
  contractIds?: readonly string[];
  /** 契約外の計画・実績も数える（§50.4。既定 false = 契約の分だけ） */
  includeOutside?: boolean;
}

/** 所属チームを決める月: 期間の終了月。ただし未来の組織は使わない（§11 と同じ min(period.to, asOfMonth)） */
export function memberBaseMonth(model: Pick<Model, "meta">, period: Period): YearMonth {
  return period.to < model.meta.asOfMonth ? period.to : model.meta.asOfMonth;
}

const memberIndexCache = new WeakMap<readonly MemberRecord[], EffectiveIndex<MemberRecord>>();

/** model.members の有効レコード索引（同じ配列なら使い回す） */
function memberIndexOf(members: readonly MemberRecord[]): EffectiveIndex<MemberRecord> {
  let index = memberIndexCache.get(members);
  if (!index) {
    index = createEffectiveIndex(members, (m) => m.memberId, (m) => m.effectiveFrom);
    memberIndexCache.set(members, index);
  }
  return index;
}

function emptyContractTotals(contractId: string, outsideType?: string): MemberContractTotals {
  return { contractId, ...(outsideType !== undefined ? { outsideType } : {}), plannedHours: 0, plannedCost: 0, actualHours: 0, actualCost: 0, variance: 0, utilization: null, unplannedHours: 0, unplannedCost: 0, assignedMonths: 0, months: [] };
}

/** 稼働率 = 実績時間 ÷ 計画時間（計画 0 → null） */
export function utilizationOf(actualHours: number, plannedHours: number): number | null {
  return plannedHours > 0 ? actualHours / plannedHours : null;
}

/**
 * 期間（両端含む）でメンバーごとに合算する。
 * - 所属チーム・役職・区分は基準月（memberBaseMonth）の有効レコード。基準月にレコードが無ければ期間内の最後の MemberMonth の値。
 * - contractIds を渡すと、その契約の行だけで計画・実績を数える（契約にもアサインにも出ないメンバーは行に出ない）。
 * - 期間内に計画も実績も無いメンバーは出さない。
 */
export function aggregateMembers(model: Pick<Model, "meta" | "members" | "memberMonths">, scope: MemberScope): MemberAggregate {
  const { period } = scope;
  const baseMonth = memberBaseMonth(model, period);
  const index = memberIndexOf(model.members);
  const memberSet = scope.memberIds ? new Set(scope.memberIds) : null;
  const contractSet = scope.contractIds ? new Set(scope.contractIds) : null;
  const teamSet = scope.teamIds ? new Set(scope.teamIds) : null;

  const byMember = new Map<string, { t: MemberTotals; contracts: Map<string, MemberContractTotals>; last: MemberMonth }>();
  for (const mm of model.memberMonths) {
    if (mm.month < period.from || mm.month > period.to) continue;
    if (memberSet && !memberSet.has(mm.memberId)) continue;
    let touched = false;
    let entry = byMember.get(mm.memberId);
    for (const row of mm.byContract) {
      if (isOutsideRow(row) ? !scope.includeOutside : contractSet && !contractSet.has(row.contractId)) continue;
      if (!entry) {
        entry = {
          t: {
            memberId: mm.memberId,
            memberName: mm.memberName,
            memberUnknown: mm.memberUnknown,
            teamId: null,
            title: null,
            kind: null,
            leftFrom: null,
            leaveReason: null,
            plannedHours: 0,
            plannedCost: 0,
            actualHours: 0,
            actualCost: 0,
            variance: 0,
            utilization: null,
            unplannedHours: 0,
            unplannedCost: 0,
            rateMissing: false,
            includesPreliminary: false,
            months: [],
            byContract: [],
          },
          contracts: new Map(),
          last: mm,
        };
        byMember.set(mm.memberId, entry);
      }
      const t = entry.t;
      let c = entry.contracts.get(row.contractId);
      if (!c) entry.contracts.set(row.contractId, (c = emptyContractTotals(row.contractId, row.outsideType)));
      c.plannedHours += row.plannedHours;
      c.plannedCost += row.plannedCost;
      c.actualHours += row.actualHours;
      c.actualCost += row.actualCost;
      if (row.assignmentCount > 0) c.assignedMonths += 1;
      else {
        c.unplannedHours += row.actualHours;
        c.unplannedCost += row.actualCost;
      }
      c.months.push(mm.month);
      t.plannedHours += row.plannedHours;
      t.plannedCost += row.plannedCost;
      t.actualHours += row.actualHours;
      t.actualCost += row.actualCost;
      if (row.assignmentCount === 0) {
        t.unplannedHours += row.actualHours;
        t.unplannedCost += row.actualCost;
      }
      if (row.actualHours > 0 && monthStatusFromMeta(mm.month, model.meta) === "preliminary") t.includesPreliminary = true;
      if (mm.rateMissing && (row.actualHours > 0 || row.plannedHours > 0)) t.rateMissing = true;
      touched = true;
    }
    if (touched && entry) {
      const t = entry.t;
      if (t.months[t.months.length - 1] !== mm.month) t.months.push(mm.month);
      entry.last = mm;
    }
  }

  const members: MemberTotals[] = [];
  for (const memberId of [...byMember.keys()].sort()) {
    const { t, contracts, last } = byMember.get(memberId) as { t: MemberTotals; contracts: Map<string, MemberContractTotals>; last: MemberMonth };
    const rec = index.at(memberId, baseMonth);
    t.memberName = rec?.name ?? last.memberName;
    t.teamId = rec ? (rec.teamId ? rec.teamId : null) : last.teamId;
    t.title = rec ? (rec.title ? rec.title : null) : last.title;
    t.kind = rec ? (rec.kind as MemberKind) : last.kind;
    const upToBase = memberRecordsOf(model, memberId).filter((r) => r.effectiveFrom <= baseMonth);
    t.leftFrom = isLeftRecord(rec) ? leftMonthOf(upToBase) : null;
    t.leaveReason = t.leftFrom ? leaveReasonOf(upToBase) : null;
    if (teamSet) {
      const inTeam = t.teamId !== null ? teamSet.has(t.teamId) : scope.includeNoTeam === true;
      if (!inTeam) continue;
    }
    t.variance = t.plannedCost - t.actualCost;
    t.utilization = utilizationOf(t.actualHours, t.plannedHours);
    t.byContract = [...contracts.keys()].sort().map((id) => {
      const c = contracts.get(id) as MemberContractTotals;
      c.variance = c.plannedCost - c.actualCost;
      c.utilization = utilizationOf(c.actualHours, c.plannedHours);
      return c;
    });
    members.push(t);
  }

  const total = { memberCount: members.length, plannedHours: 0, plannedCost: 0, actualHours: 0, actualCost: 0, variance: 0, utilization: null as number | null, unplannedHours: 0, unplannedCost: 0 };
  for (const t of members) {
    total.plannedHours += t.plannedHours;
    total.plannedCost += t.plannedCost;
    total.actualHours += t.actualHours;
    total.actualCost += t.actualCost;
    total.unplannedHours += t.unplannedHours;
    total.unplannedCost += t.unplannedCost;
  }
  total.variance = total.plannedCost - total.actualCost;
  total.utilization = utilizationOf(total.actualHours, total.plannedHours);
  return { period, baseMonth, members, total };
}

/** メンバー 1 人の月次推移（期間の全月。データの無い月は 0、状態は asOf 基準） */
export function memberMonthlySeries(
  model: Pick<Model, "meta" | "memberMonths">,
  memberId: string,
  period: Period,
  contractIds?: readonly string[],
  options: { includeOutside?: boolean } = {},
): MemberMonthlyPoint[] {
  const contractSet = contractIds ? new Set(contractIds) : null;
  const points = new Map<YearMonth, MemberMonthlyPoint>();
  for (const month of monthRange(period.from, period.to)) {
    points.set(month, { month, status: monthStatusFromMeta(month, model.meta), plannedHours: 0, plannedCost: 0, actualHours: 0, actualCost: 0, variance: 0, utilization: null, unplannedHours: 0, unplannedCost: 0 });
  }
  for (const mm of model.memberMonths) {
    if (mm.memberId !== memberId) continue;
    const p = points.get(mm.month);
    if (!p) continue;
    for (const row of mm.byContract) {
      if (isOutsideRow(row) ? !options.includeOutside : contractSet && !contractSet.has(row.contractId)) continue;
      p.plannedHours += row.plannedHours;
      p.plannedCost += row.plannedCost;
      p.actualHours += row.actualHours;
      p.actualCost += row.actualCost;
      if (row.assignmentCount === 0) {
        p.unplannedHours += row.actualHours;
        p.unplannedCost += row.actualCost;
      }
    }
  }
  for (const p of points.values()) {
    p.variance = p.plannedCost - p.actualCost;
    p.utilization = utilizationOf(p.actualHours, p.plannedHours);
  }
  return [...points.values()];
}

// ---------------------------------------------------------------------------
// 所属・単価の変遷（メンバー詳細の基本情報と「単価の変遷」）
// ---------------------------------------------------------------------------

export interface MemberRateSegment {
  /** この単価が使われた最初と最後の月（両端含む） */
  from: YearMonth;
  to: YearMonth;
  hourlyRate: number;
  rateSource: { key: string; effectiveFrom: YearMonth } | null;
  rateMissing: boolean;
  /** その間の役職（役職単価のときの検索キー） */
  title: string | null;
}

/** メンバーの履歴レコード（effectiveFrom 昇順。同じ月は後の行が有効なので後ろに並ぶ） */
export function memberRecordsOf(model: Pick<Model, "members">, memberId: string): MemberRecord[] {
  return model.members
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.memberId === memberId)
    .sort((a, b) => (a.m.effectiveFrom < b.m.effectiveFrom ? -1 : a.m.effectiveFrom > b.m.effectiveFrom ? 1 : a.i - b.i))
    .map(({ m }) => m);
}

/**
 * 期間内の月ごとに §6 の単価を引き、同じ単価・同じ出どころ・同じ役職が続く月をまとめる。
 * マスタに登録はあるがまだ有効レコードの無い月（入社前）は飛ばし、そこで区切る。
 * Model は単価マスタを持たないので Dataset（または createMasterIndex の結果）から引く。
 */
export function memberRateHistory(source: Pick<Dataset, "members" | "rates" | "teams"> | MasterIndex, memberId: string, period: Period): MemberRateSegment[] {
  const masters = "members" in source && Array.isArray(source.members) ? createMasterIndex(source as Pick<Dataset, "members" | "rates" | "teams">) : (source as MasterIndex);
  const segments: MemberRateSegment[] = [];
  let gap = true;
  for (const month of monthRange(period.from, period.to)) {
    const rate = rateFor(masters, memberId, month);
    const rec = memberAt(masters, memberId, month);
    if (!rec && !rate.memberUnknown) {
      gap = true;
      continue;
    }
    const title = rec?.title ? rec.title : null;
    const last = segments[segments.length - 1];
    const same =
      !gap &&
      last &&
      last.hourlyRate === rate.hourlyRate &&
      last.rateMissing === rate.rateMissing &&
      last.title === title &&
      (last.rateSource?.key ?? null) === (rate.rateSource?.key ?? null) &&
      (last.rateSource?.effectiveFrom ?? null) === (rate.rateSource?.effectiveFrom ?? null);
    gap = false;
    if (same) last.to = month;
    else segments.push({ from: month, to: month, hourlyRate: rate.hourlyRate, rateSource: rate.rateSource, rateMissing: rate.rateMissing, title });
  }
  return segments;
}
