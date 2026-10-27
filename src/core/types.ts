/**
 * 予実ナビ 計算コア — 型定義（入力データ・設定・計算結果）
 *
 * この型が画面・テスト・データ読み込みの共通契約。
 * 計算コアは画面に依存せず、ここで定義した入力から出力を純粋関数で導く。
 */

/** "YYYY-MM" 形式の年月 */
export type YearMonth = string;
/** "YYYY-MM-DD" 形式の日付 */
export type ISODate = string;
/** 原価の種類ID（例: "labor"）。config.costTypes で定義する */
export type CostTypeId = string;

export type ForecastMethod = "recent3" | "all" | "assignment";
export type MoneyUnit = "yen" | "thousandYen";
export type MonthStatus = "final" | "preliminary" | "future" | "outside";

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

export interface CostTypeDef {
  id: CostTypeId;
  label: string;
}

export interface Config {
  /** 年度開始月（1〜12）。4 = 4月始まり */
  fiscalYearStartMonth: number;
  /** 1.0人月の標準時間 */
  standardHoursPerMonth: number;
  /** 営業日1日あたりの時間（カレンダー基準の人月換算に使う） */
  hoursPerBusinessDay: number;
  /** 消化率がこの値を超えたら「赤」。1.0 = 100% */
  burnRateDangerThreshold: number;
  /** 翌月の第N営業日に前月分が確定する */
  closingBusinessDay: number;
  forecastMethodDefault: ForecastMethod;
  /** 直近実績方式で平均する月数 */
  forecastRecentMonths: number;
  currency: { code: string; defaultUnit: MoneyUnit };
  labels: { customer: string; project: string; contract: string; team: string; member: string };
  worklogSource: WorklogSourceConfig;
  costTypes: CostTypeDef[];
}

export interface WorklogSourceConfig {
  adapter: "csv" | "http" | "dummy";
  csv: { path: string };
  http: {
    url: string;
    authHeader: string;
    refetchMonths: number;
    /** 任意: JSON応答で配列がネストしている場合のパス（例 "data.items"） */
    dataPath?: string;
    /** 任意: 認証ヘッダの値の接頭辞（例 "Bearer"） */
    authScheme?: string;
    /** 任意: HTTPメソッド（既定 GET） */
    method?: string;
    /** 取得元の列名 → 予実ナビの項目名 */
    columns: Record<keyof Worklog, string>;
  };
}

// ---------------------------------------------------------------------------
// 入力データ（data/ 配下のCSVと同じ構造）
// ---------------------------------------------------------------------------

export interface Contract {
  contractId: string;
  customerName: string;
  projectName: string;
  /** 主担当チームID。空 = 未設定 */
  teamId: string | null;
  startMonth: YearMonth;
  endMonth: YearMonth;
  /** 契約総額（税抜・円） */
  totalAmount: number;
  note?: string;
}

export interface MappingRule {
  /** 工数側の顧客名（正規化前） */
  worklogCustomerName: string;
  /** 工数側の案件名。空文字 = その顧客の全工数 */
  worklogProjectName: string;
  contractId: string;
}

export interface Assignment {
  memberId: string;
  contractId: string;
  startMonth: YearMonth;
  endMonth: YearMonth;
  /** 配分人月（0〜1.0） */
  allocation: number;
}

export interface TeamRecord {
  teamId: string;
  name: string;
  /** 空 = 最上位 */
  parentTeamId: string | null;
  effectiveFrom: YearMonth;
}

export type MemberKind = "employee" | "partner";

export interface MemberRecord {
  memberId: string;
  name: string;
  kind: MemberKind;
  /** 役職（単価の検索キー） */
  title: string;
  department: string;
  section: string;
  /** 空 = チーム非所属 */
  teamId: string | null;
  effectiveFrom: YearMonth;
}

export interface RateRecord {
  /** 役職名 または メンバーID */
  key: string;
  /** 時間単価（円） */
  hourlyRate: number;
  effectiveFrom: YearMonth;
}

export interface Holiday {
  date: ISODate;
  name: string;
}

export interface Worklog {
  date: ISODate;
  memberId: string;
  memberName: string;
  customerName: string;
  projectName: string;
  task: string;
  hours: number;
}

/** 計算コアへの入力一式 */
export interface Dataset {
  config: Config;
  contracts: Contract[];
  mappings: MappingRule[];
  assignments: Assignment[];
  teams: TeamRecord[];
  members: MemberRecord[];
  rates: RateRecord[];
  holidays: Holiday[];
  worklogs: Worklog[];
  /** 作業実績の最終取得日時（ISO 8601）。無ければ undefined */
  worklogFetchedAt?: string;
}

// ---------------------------------------------------------------------------
// 計算結果（内訳＝計算根拠を必ず伴う）
// ---------------------------------------------------------------------------

export interface BudgetBreakdown {
  totalAmount: number;
  monthCount: number;
  /** 均等割りの基本額（切り捨て） */
  baseMonthly: number;
  /** 最終月に乗せる端数 */
  remainder: number;
  isLastMonth: boolean;
}

export interface CostLine {
  costType: CostTypeId;
  memberId: string;
  memberName: string;
  hours: number;
  hourlyRate: number;
  /** 使った単価の出どころ。rateMissing の場合は null */
  rateSource: { key: string; effectiveFrom: YearMonth } | null;
  rateMissing: boolean;
  /** hours × hourlyRate を円に丸めた額 */
  amount: number;
  /** 当時のメンバー所属チーム（空 = 非所属 or 不明） */
  memberTeamId: string | null;
}

export interface WorklogEntry extends Worklog {
  contractId: string;
  hourlyRate: number;
  amount: number;
}

export interface ContractMonth {
  contractId: string;
  month: YearMonth;
  status: MonthStatus;
  budget: number;
  budgetBreakdown: BudgetBreakdown;
  /** 原価の種類別合計 */
  costs: Record<CostTypeId, number>;
  /** 原価合計 */
  cost: number;
  grossProfit: number;
  hours: number;
  costLines: CostLine[];
  /** 元の作業ログ（誰が・いつ・何を・何時間） */
  worklogs: WorklogEntry[];
  /** この月に有効な営業日数（カレンダー基準の人月換算用） */
  businessDays: number;
}

export interface ForecastBreakdown {
  method: ForecastMethod;
  fiscalYear: number;
  fiscalYearMonths: YearMonth[];
  /** 契約期間と年度の両方に含まれる月 */
  contractMonthsInFY: YearMonth[];
  actualMonths: YearMonth[];
  remainingMonths: YearMonth[];
  actualCost: number;
  /** 平均の計算に使った月と原価（recent3 / all） */
  averageBasisMonths: YearMonth[];
  averageMonthlyCost: number;
  /** assignment 方式での残り月の見積り明細 */
  assignmentLines: Array<{ month: YearMonth; memberId: string; allocation: number; hours: number; hourlyRate: number; amount: number }>;
  remainingCost: number;
  /** 見積りに実績がない（平均の基礎が0か月） */
  noActuals: boolean;
  /** assignment 方式でアサインが1件もない */
  noAssignments: boolean;
}

export interface Forecast {
  contractId: string;
  fiscalYear: number;
  method: ForecastMethod;
  fyBudget: number;
  forecastCost: number;
  forecastGrossProfit: number;
  isDeficit: boolean;
  breakdown: ForecastBreakdown;
}

export interface ContractResult {
  contract: Contract;
  months: ContractMonth[];
  /** 方式ごとの着地見込み（年度は asOf の年度） */
  forecasts: Record<ForecastMethod, Forecast>;
}

export interface TeamNode {
  teamId: string;
  name: string;
  parentTeamId: string | null;
  depth: number;
  children: string[];
  /** 自分と配下すべてのチームID */
  descendantIds: string[];
}

export type WarningCode =
  | "UNMAPPED_WORKLOG"
  | "WORKLOG_OUT_OF_CONTRACT_PERIOD"
  | "RATE_MISSING"
  | "UNKNOWN_MEMBER"
  | "UNKNOWN_TEAM"
  | "ALLOCATION_OVER_1"
  | "CONTRACT_INVALID"
  | "DUPLICATE_CONTRACT_ID"
  | "MAPPING_UNKNOWN_CONTRACT"
  | "MAPPING_AMBIGUOUS"
  | "EXCLUDED_NO_CUSTOMER";

export interface Warning {
  code: WarningCode;
  message: string;
  /** 関係する識別子（契約ID・メンバーID・顧客名など） */
  ref?: Record<string, string | number>;
  /** 件数や時間など、まとめる単位 */
  hours?: number;
  count?: number;
}

export interface UnmappedWorklogGroup {
  customerName: string;
  projectName: string;
  hours: number;
  count: number;
  firstDate: ISODate;
  lastDate: ISODate;
  reason: "NO_RULE" | "OUT_OF_PERIOD" | "UNKNOWN_CONTRACT";
}

export interface ModelMeta {
  /** 計算基準日 */
  asOf: ISODate;
  asOfMonth: YearMonth;
  /** 確定済みの最新月（asOf が前月分の確定日以降なら前月、そうでなければ前々月） */
  lastFinalMonth: YearMonth;
  fiscalYear: number;
  fiscalYearMonths: YearMonth[];
  /** データ全体で扱う月の範囲（契約の最小開始月〜最大終了月） */
  minMonth: YearMonth;
  maxMonth: YearMonth;
  worklogFetchedAt: string | null;
  /** 前年同期比に使えるデータが存在するか（1年分の実績がたまったら true） */
  hasPriorYearData: boolean;
  generatedAt: string;
}

/** 計算コアの出力。画面はこれだけを読む */
export interface Model {
  meta: ModelMeta;
  config: Config;
  contracts: ContractResult[];
  /** asOf 月時点のチーム階層（過去月の階層は teamTreeByMonth で引く） */
  teamTree: Record<string, TeamNode>;
  /** 木構造の最上位チームID一覧（表示順） */
  rootTeamIds: string[];
  members: MemberRecord[];
  /** 画面側で過去月の組織（teamTreeAt）を引くための履歴 */
  teams: TeamRecord[];
  /** 画面側で月の状態・営業日を再計算するための祝日 */
  holidays: Holiday[];
  warnings: Warning[];
  unmapped: UnmappedWorklogGroup[];
  /** 顧客なし等で除外した工数の合計 */
  excludedHours: number;
}

// ---------------------------------------------------------------------------
// 集計（画面側で期間・範囲を選んで使う）
// ---------------------------------------------------------------------------

export interface Period {
  from: YearMonth;
  to: YearMonth;
}

export interface Totals {
  budget: number;
  cost: number;
  costs: Record<CostTypeId, number>;
  grossProfit: number;
  /** 粗利率（budget が 0 のとき null） */
  grossMargin: number | null;
  hours: number;
  /** 消化率 = 経過月の累計原価 ÷ 経過月の累計予算（累計予算 0 のとき null） */
  burnRate: number | null;
  /** 消化率の根拠 */
  burnRateBreakdown: { elapsedMonths: YearMonth[]; cumulativeCost: number; cumulativeBudget: number };
  isOverBudget: boolean;
  /** 人月換算（標準時間ベース）*/
  personMonthsStandard: number;
  /** 人月換算（営業日×時間ベース）*/
  personMonthsCalendar: number;
  /** 速報月を含むか */
  includesPreliminary: boolean;
  contractCount: number;
}

export interface MonthlyPoint {
  month: YearMonth;
  status: MonthStatus;
  budget: number;
  cost: number;
  costs: Record<CostTypeId, number>;
  grossProfit: number;
  hours: number;
}

export interface ForecastTotals {
  method: ForecastMethod;
  fiscalYear: number;
  fyBudget: number;
  forecastCost: number;
  forecastGrossProfit: number;
  deficitContractIds: string[];
  contractCount: number;
}
