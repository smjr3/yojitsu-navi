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
export type MoneyUnit = "yen" | "thousandYen" | "millionYen";
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
  /** 所属・役職の取り込み元（省略 = none: 手入力） */
  memberSource?: MemberSourceConfig;
  costTypes: CostTypeDef[];
  /** マスタ編集画面の保存方式（SPEC §19.2）。省略時は download */
  masterEdit?: MasterEditConfig;
}

/** マスタ編集の保存方式（SPEC §19.2） */
export interface MasterEditConfig {
  /**
   * gitlab = API でブランチにコミットして MR を作る（既定。§24）、download = CSV をダウンロードして GitLab 画面でアップロード、
   * demo = GitLab の代わりにブラウザ内の模擬を使う（試用。§29）
   */
  mode: "gitlab" | "download" | "demo";
  gitlab: {
    /** 例 https://gitlab.example.local/api/v4。空なら download に落とす */
    apiBaseUrl: string;
    /** 数値ID または "group/project"。空なら download に落とす */
    projectId: string;
    targetBranch: string;
    /** mr = 新しいブランチにコミットして MR を作成、direct = targetBranch へ直接コミット */
    commitMode: "mr" | "direct";
  };
}

/** 取得元の列指定。ドット区切りで入れ子（"member.id"）、配列なら複数候補（最初に値があるもの） */
export type ColumnSpec = string | string[];

export type DateFormat = "YYYY-MM-DD" | "YYYY/MM/DD" | "YYYYMMDD" | "ISO8601" | "epochMillis";

export type PaginationConfig =
  | { type: "none" }
  | { type: "page"; pageParam: string; sizeParam: string; size: number; startPage?: number; maxPages?: number }
  | { type: "offset"; offsetParam: string; limitParam: string; limit: number; maxPages?: number }
  | { type: "link"; maxPages?: number }
  | { type: "cursor"; cursorPath: string; cursorParam: string; maxPages?: number };

/** 取り込まない行の条件。equals / notEquals / in のどれか1つを書く */
export interface SourceFilter {
  column: string;
  equals?: string | number | boolean;
  notEquals?: string | number | boolean;
  in?: Array<string | number | boolean>;
}

/** http 取得元の共通設定（作業実績・メンバーで共有） */
export interface HttpSourceOptions {
  url: string;
  authHeader: string;
  /** 任意: JSON応答で配列がネストしている場合のパス（例 "data.items"） */
  dataPath?: string;
  /** 任意: 認証ヘッダの値の接頭辞（例 "Bearer"） */
  authScheme?: string;
  /** 任意: HTTPメソッド（既定 GET） */
  method?: string;
  /** 任意: ページング（既定 none） */
  pagination?: PaginationConfig;
  /** 任意: 追加のクエリ文字列（固定値）。{from} {to} {fromDate} {toDate} を置換 */
  query?: string;
  /** 任意: 取り込まない行の条件（すべてに合う行だけ取り込む） */
  filters?: SourceFilter[];
  /** 任意: CSV 応答の文字コード（既定 auto） */
  encoding?: "auto" | "utf-8" | "shift_jis";
}

export interface WorklogSourceConfig {
  adapter: "csv" | "http" | "dummy";
  csv: { path: string };
  http: HttpSourceOptions & {
    refetchMonths: number;
    /** 取得元の列名 → 予実ナビの項目名（配列は複数候補） */
    columns: Record<keyof Worklog, ColumnSpec>;
    /** 任意: 日付の形式（既定: 自動判定） */
    dateFormat?: DateFormat;
    /** 任意: 作業時間の単位（既定 hours） */
    hoursUnit?: "hours" | "minutes" | "seconds";
  };
}

/** 所属・役職の取り込み項目（team_id は取り込まない） */
export type MemberImportField = "memberId" | "name" | "kind" | "title" | "department" | "section";

/** 所属・役職の取り込み元（人事系）。adapter が none の間は手入力 */
export interface MemberSourceConfig {
  adapter: "csv" | "http" | "none";
  /** csv: 人事の CSV を置く運用 */
  csv?: { path: string; encoding?: "auto" | "utf-8" | "shift_jis" };
  http?: HttpSourceOptions;
  /** 取得元の列名。memberId と name は必須、他は省略可（省略した項目は取り込まず、現在の値を引き継ぐ） */
  columns?: Partial<Record<MemberImportField, ColumnSpec>>;
  /** 任意: 区分の値の読み替え（例 {"正社員":"employee","委託":"partner"}） */
  kindMap?: Record<string, MemberKind>;
  /** 任意: 取り込まない行の条件（csv / http 共通。退職者の除外など） */
  filters?: SourceFilter[];
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
  /** 種別（「課」「チーム」「班」など自由入力。空 = なし）。SPEC §21 */
  level?: string;
  /** リーダーのメンバーID。null/省略 = 未設定。SPEC §22 */
  leaderMemberId?: string | null;
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
  /** 種別（空文字 = なし）。SPEC §21 */
  level: string;
  /** リーダーのメンバーID（null = 未設定）。SPEC §22 */
  leaderMemberId: string | null;
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
  | "MAPPING_EXCLUDED_CONTRACT"
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
  reason: "NO_RULE" | "OUT_OF_PERIOD" | "UNKNOWN_CONTRACT" | "EXCLUDED_CONTRACT";
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
  /**
   * メンバー×月の計画と実績（§18.1）。memberId 昇順 → month 昇順。
   * 画面用の model.json では空にし、data/member-months.json で別に配る（メンバー別の画面だけが読む）
   */
  memberMonths: MemberMonth[];
}

// ---------------------------------------------------------------------------
// メンバー別（SPEC §18）
// ---------------------------------------------------------------------------

/** メンバー x・月 m・契約 c の計画と実績（MemberMonth.byContract の 1 行） */
export interface MemberContractMonth {
  contractId: string;
  /** その月に掛かるアサインの配分の合計（契約期間外の月・除外された契約は 0） */
  allocation: number;
  /** 掛かったアサインの件数。0 = アサインなし（この行の実績は unplanned に入る） */
  assignmentCount: number;
  /** allocation × standardHoursPerMonth */
  plannedHours: number;
  /** round(plannedHours × hourlyRate)。行（x, c, m）ごとに丸める */
  plannedCost: number;
  /** 契約 c・月 m の CostLine のうち memberId = x の時間 */
  actualHours: number;
  /** 同 CostLine の金額 */
  actualCost: number;
}

/** メンバー x・月 m の計画と実績（計画 = 配分人月 × 基準時間 × 単価、実績 = 工数原価） */
export interface MemberMonth {
  memberId: string;
  month: YearMonth;
  /** 当月のメンバーマスタの名前。無ければ作業ログの名前、それも無ければ ID */
  memberName: string;
  /** members.csv に（どの月にも）存在しない */
  memberUnknown: boolean;
  /** 当月の有効レコードの値（無ければ null） */
  kind: MemberKind | null;
  title: string | null;
  teamId: string | null;
  /** §6 の単価（当月） */
  hourlyRate: number;
  rateSource: { key: string; effectiveFrom: YearMonth } | null;
  rateMissing: boolean;
  /** 計算に使った基準時間（config.standardHoursPerMonth） */
  standardHoursPerMonth: number;
  plannedHours: number;
  /** Σ_c plannedCost(x, c, m)（行ごとに丸めた額の合計） */
  plannedCost: number;
  actualHours: number;
  actualCost: number;
  /** アサインの無い契約に付けた工数（actual のうちの内数） */
  unplannedHours: number;
  unplannedCost: number;
  /** plannedCost − actualCost（正 = 計画より原価が少ない） */
  variance: number;
  /** 契約別の内訳（contractId 昇順） */
  byContract: MemberContractMonth[];
}

/** aggregateMembers の契約別の行（期間内の合計） */
export interface MemberContractTotals {
  contractId: string;
  plannedHours: number;
  plannedCost: number;
  actualHours: number;
  actualCost: number;
  variance: number;
  utilization: number | null;
  unplannedHours: number;
  unplannedCost: number;
  /** アサインが掛かった月の数（0 = 期間内にアサインなし） */
  assignedMonths: number;
  /** 期間内で計画か実績のある月 */
  months: YearMonth[];
}

/** aggregateMembers のメンバー 1 人分（期間内の合計） */
export interface MemberTotals {
  memberId: string;
  memberName: string;
  memberUnknown: boolean;
  /** 所属・役職・区分は基準月（期間の終了月。未来は asOf 月）の値。基準月に有効レコードが無ければ期間内の最後の値 */
  teamId: string | null;
  title: string | null;
  kind: MemberKind | null;
  plannedHours: number;
  plannedCost: number;
  actualHours: number;
  actualCost: number;
  variance: number;
  /** actualHours ÷ plannedHours（plannedHours 0 → null） */
  utilization: number | null;
  unplannedHours: number;
  unplannedCost: number;
  /** 単価が見つからない月を含む */
  rateMissing: boolean;
  /** 実績に速報月を含む */
  includesPreliminary: boolean;
  /** 期間内で計画か実績のある月（昇順） */
  months: YearMonth[];
  byContract: MemberContractTotals[];
}

export interface MemberAggregate {
  period: Period;
  /** 所属チームを決めた月 = min(period.to, asOfMonth) */
  baseMonth: YearMonth;
  /** memberId 昇順 */
  members: MemberTotals[];
  total: {
    memberCount: number;
    plannedHours: number;
    plannedCost: number;
    actualHours: number;
    actualCost: number;
    variance: number;
    utilization: number | null;
    unplannedHours: number;
    unplannedCost: number;
  };
}

/** memberMonthlySeries の 1 点（期間の全月。データの無い月は 0） */
export interface MemberMonthlyPoint {
  month: YearMonth;
  status: MonthStatus;
  plannedHours: number;
  plannedCost: number;
  actualHours: number;
  actualCost: number;
  variance: number;
  utilization: number | null;
  unplannedHours: number;
  unplannedCost: number;
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
