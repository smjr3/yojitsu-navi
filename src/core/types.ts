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
    /** 個人アクセストークンの作成画面（空 = GitLab の標準の場所。"/…" = GitLab 上のパス、"https://…" = そのまま。§28） */
    tokenUrl?: string;
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
export type MemberImportField = "memberId" | "name" | "kind" | "title" | "division" | "department" | "section";

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
  /** 作業名に含むキーワード（§62。どれか 1 つを含めば対象。省略・空 = 条件なし） */
  taskInclude?: string[];
  /** 作業名に含むと対象外にするキーワード（§62。含むより優先） */
  taskExclude?: string[];
}

export interface Assignment {
  memberId: string;
  contractId: string;
  startMonth: YearMonth;
  endMonth: YearMonth;
  /** 配分人月（0〜1.0） */
  allocation: number;
}

/** 契約外予定（§30.5・§36・§50）: 人 × 種別 × 期間 × 人月。契約の計画額・着地見込みには入れない */
export interface OutsidePlan {
  memberId: string;
  /** 契約外の種別（§50.1。task-types.csv の group）。空 = 種別なし */
  type: string;
  startMonth: YearMonth;
  endMonth: YearMonth;
  /** 人月（0〜1.0） */
  personMonths: number;
  note: string;
}

export interface TeamRecord {
  teamId: string;
  name: string;
  /** 空 = 最上位 */
  parentTeamId: string | null;
  effectiveFrom: YearMonth;
  /** 種別（「課」「チーム」「班」など自由入力。空 = なし）。SPEC §21 */
  level?: string;
  /** リーダーの社員番号。null/省略 = 未設定。SPEC §22 */
  leaderMemberId?: string | null;
}

export type MemberKind = "employee" | "partner";

export interface MemberRecord {
  memberId: string;
  name: string;
  kind: MemberKind;
  /** 役職（単価の検索キー） */
  title: string;
  /** 所属の 3 段: 事業本部（省略可の列 division。§60）・部・課 */
  division?: string;
  department: string;
  section: string;
  /** 空 = チーム非所属 */
  teamId: string | null;
  effectiveFrom: YearMonth;
  /**
   * 在籍状態（任意の列 status。SPEC §35）。"left" = この行の effective_from から不在（退職・休職など。理由は問わない）。
   * 省略・空・「在籍」 = 在籍。CSV にそれ以外の値があれば "left"
   */
  status?: string;
}

export interface RateRecord {
  /** 役職名 または 社員番号 */
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

/** 作業種別の区分（SPEC §30）。contract = 契約内（運用保守）、outside = 契約外（提案・運用設計など） */
export type TaskCategory = "contract" | "outside";

/** data/task-types.csv の 1 行（SPEC §30.1） */
export interface TaskTypeRule {
  task: string;
  category: TaskCategory;
  /** 契約外の種別（計画の単位。§50.1）。空・省略 = task と同じ。契約内では使わない */
  group?: string;
  /** 照合の仕方（§62.2）。contains = 作業名に task を含めば該当。省略 = 完全一致 */
  match?: "contains";
  note?: string;
}

/** 計算コアへの入力一式 */
/** 目標の対象（§63）: チーム・顧客・案件 */
export type TargetKind = "team" | "customer" | "project";

/**
 * 目標（§63）: 対象 × 期間（開始月〜終了月）× 残予算率。targets.csv の 1 行。
 * 残予算率は期間の累計（予算 − 実績（終了月が先なら着地見込み））÷ 予算。月ごとの目標は開始月 = 終了月
 */
export interface Target {
  /** team / customer / project（不正な値は検証でエラー。そのまま持つ） */
  kind: string;
  /** team = チームID、customer = 顧客名、project = 契約ID */
  targetId: string;
  /** 開始月。空 = 終了月を含む年度の最初の月 */
  startMonth: string;
  /** 終了月 */
  endMonth: string;
  /** 目標の残予算率（割合。CSV の 20 = 20% → 0.2）。数値でなければ NaN */
  remainingRate: number;
  note: string;
}

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
  /** 作業種別の分類表（§30.1）。省略・空 = すべて契約内 */
  taskTypes?: TaskTypeRule[];
  /** 契約外予定（§36）。省略・空 = なし */
  outsidePlans?: OutsidePlan[];
  /** 目標（§63）。省略・空 = なし */
  targets?: Target[];
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
  /** asOf の年度 */
  fiscalYear: number;
  /** 着地を見る対象の月（既定は asOf の年度。画面では選択中の期間、案件詳細では契約の全期間。§54） */
  targetMonths: YearMonth[];
  /** 契約期間と対象の両方に含まれる月 */
  contractMonthsInTarget: YearMonth[];
  actualMonths: YearMonth[];
  remainingMonths: YearMonth[];
  actualCost: number;
  /** 平均の計算に使った月と原価（recent3 / all） */
  averageBasisMonths: YearMonth[];
  averageMonthlyCost: number;
  /** assignment 方式での残り月の見積り明細 */
  assignmentLines: AssignmentForecastLine[];
  remainingCost: number;
  /** 見積りに実績がない（平均の基礎が0か月） */
  noActuals: boolean;
  /** assignment 方式でアサインが1件もない */
  noAssignments: boolean;
}

/** リソース計画（assignment 方式）の 1 か月・1 人ぶんの見積り */
export interface AssignmentForecastLine {
  month: YearMonth;
  memberId: string;
  allocation: number;
  hours: number;
  hourlyRate: number;
  amount: number;
}

/** 契約のリソース計画の明細（asOf 月から契約の終了月まで。対象の月を変えても計算し直せるように Model に持たせる） */
export interface AssignmentPlan {
  /** この契約のアサインが 1 行でもあるか（無ければ assignment 方式は noAssignments） */
  hasAssignments: boolean;
  lines: AssignmentForecastLine[];
}

export interface Forecast {
  contractId: string;
  fiscalYear: number;
  method: ForecastMethod;
  /** 対象の月（契約期間内）の予算の合計 */
  targetBudget: number;
  forecastCost: number;
  forecastGrossProfit: number;
  isDeficit: boolean;
  breakdown: ForecastBreakdown;
}

export interface ContractResult {
  contract: Contract;
  months: ContractMonth[];
  /** 方式ごとの着地見込み。Model を作った時点は asOf の年度。画面では setForecastPeriod で選択中の期間に置き換える（§54） */
  forecasts: Record<ForecastMethod, Forecast>;
  /** リソース計画の明細（期間を変えて着地を計算し直すための材料） */
  assignmentPlan: AssignmentPlan;
}

export interface TeamNode {
  teamId: string;
  name: string;
  parentTeamId: string | null;
  /** 種別（空文字 = なし）。SPEC §21 */
  level: string;
  /** リーダーの社員番号（null = 未設定）。SPEC §22 */
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
  | "EXCLUDED_NO_CUSTOMER"
  | "TASK_UNCLASSIFIED"
  | "HOLIDAYS_AUTO";

export interface Warning {
  code: WarningCode;
  message: string;
  /** 関係する識別子（契約ID・社員番号・顧客名など） */
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

/** 作業名のキーワードに合致せず運用保守以外にした作業（§62.3）。(顧客名, 案件名, 作業名) を正規化してまとめる（表記は最初の行） */
export interface KeywordUnmatchedGroup {
  customerName: string;
  projectName: string;
  task: string;
  /** 運用保守以外の種別 */
  type: string;
  hours: number;
  count: number;
  firstDate: ISODate;
  lastDate: ISODate;
}

export interface ModelMeta {
  /**
   * 計算基準日（＝今日）。ビルド時はビルドした日（日本時間）。画面では rebaseModel で
   * 開いた人の今日（日本時間）に置き換える（asOfFixed のときを除く。§75）
   */
  asOf: ISODate;
  /** 計算基準日を YOJITSU_AS_OF で固定したビルドか（テスト・試用版。画面でも今日に置き換えない。§75） */
  asOfFixed?: boolean;
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
  /** 作業実績のある「メンバー|月」（"memberId|YYYY-MM"。§35。リソース計画で不在になった月を稼働とみなすかの判定に使う） */
  worklogMonths: string[];
  /** 画面側で過去月の組織（teamTreeAt）を引くための履歴 */
  teams: TeamRecord[];
  /** 画面側で月の状態・営業日を再計算するための祝日 */
  holidays: Holiday[];
  warnings: Warning[];
  unmapped: UnmappedWorklogGroup[];
  /** 作業名のキーワードに合致せず運用保守以外にした作業（§62.3） */
  keywordUnmatched: KeywordUnmatchedGroup[];
  /** 顧客なし等で除外した工数の合計 */
  excludedHours: number;
  /**
   * メンバー×月の計画と実績（§18.1）。memberId 昇順 → month 昇順。
   * 画面用の model.json では空にし、data/member-months.json で別に配る（メンバー別の画面だけが読む）
   */
  memberMonths: MemberMonth[];
  /**
   * 工数の明細（§30.2）。month → memberId → contractId → task の順。
   * 画面用の model.json では空にし、data/work-hours.json で別に配る
   */
  workRows: WorkRow[];
  /** 契約外の種別（§50.1。task-types.csv の契約外の行の group の重複なし、ファイルの順） */
  outsideTypes: string[];
  /** 目標（§63）。targets.csv の行（検証エラーの行も含む。評価は targets.ts） */
  targets: Target[];
}

/** 工数の明細 1 行（SPEC §30.2）。（月, メンバー, 契約, 顧客, 作業種別, 区分）ごとの合計 */
export interface WorkRow {
  month: YearMonth;
  memberId: string;
  /** その月のマスタの名前（無ければ作業ログの名前） */
  memberName: string;
  /** その月の所属チーム（null = 非所属・不明） */
  teamId: string | null;
  /** 契約内 = 紐付いた契約、契約外 = 関連契約（紐付かなければ null） */
  contractId: string | null;
  /** customerKey（§17） */
  customerKey: string;
  /** 顧客の表示名（契約に紐付けば契約の顧客名、無ければ作業ログの顧客名） */
  customerName: string;
  /** 作業種別（作業ログの表記のまま。空 = 空文字） */
  task: string;
  category: TaskCategory;
  /** 分類表に無い作業種別（契約内として数えた） */
  unclassified: boolean;
  hours: number;
  /** 契約内: 実績額の按分（円）。契約外: null */
  amount: number | null;
}

// ---------------------------------------------------------------------------
// メンバー別（SPEC §18）
// ---------------------------------------------------------------------------

/** メンバー x・月 m・契約 c の計画と実績（MemberMonth.byContract の 1 行） */
export interface MemberContractMonth {
  /** 契約ID。契約外の行は outsideRowId(正規化した種別)（§50.3。表記ゆれは 1 行にまとめる） */
  contractId: string;
  /** 契約外の行だけ: 種別（空 = 種別なし） */
  outsideType?: string;
  /** その月に掛かるアサインの配分の合計（契約期間外の月・除外された契約は 0） */
  allocation: number;
  /** 掛かったアサイン（契約外は契約外予定）の件数。0 = 計画なし（この行の実績は unplanned に入る） */
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
  /** 契約別の内訳（contractId 昇順。契約外の行は末尾。上の合計には契約外を含めない） */
  byContract: MemberContractMonth[];
}

/** aggregateMembers の契約別の行（期間内の合計） */
export interface MemberContractTotals {
  contractId: string;
  /** 契約外の行だけ: 種別（§50.3） */
  outsideType?: string;
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
  /** 基準月の時点で不在なら不在になった月（§35）、在籍なら null */
  leftFrom: YearMonth | null;
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
  /** 着地を見ている対象の期間（setForecastPeriod で選んだもの。null = asOf の年度） */
  period: Period | null;
  targetBudget: number;
  forecastCost: number;
  forecastGrossProfit: number;
  deficitContractIds: string[];
  contractCount: number;
}
