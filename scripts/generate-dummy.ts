/**
 * ダミーデータ生成（決定的）
 *
 *   npx tsx scripts/generate-dummy.ts [--seed 42] [--asOf 2026-10-27] [--out data] [--base-only]
 *
 * 既定は基本シナリオ ＋ 実運用規模の部分（scripts/dummy-scale.ts）。--base-only で基本シナリオだけ（小さいデータで試すとき）。
 *
 * 同じ seed・asOf なら毎回バイト単位で同じ出力になる（乱数は mulberry32、日時は asOf から導出）。
 * シナリオの説明と「どの行がどのエッジケースを試すか」は docs/DUMMY_DATA.md を参照。
 *
 * 出力:
 *   data/contracts.csv, data/mapping.csv, data/assignments.csv, data/holidays.csv
 *   data/masters/teams.csv, data/masters/members.csv, data/masters/rates.csv
 *   data/worklogs/YYYY-MM.csv, data/worklogs/_meta.json
 *   data/task-types.csv（作業種別の分類表。SPEC §30）
 */
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { csvFormat } from "d3-dsv";
import type { Worklog, YearMonth } from "../src/core/types.js";
import { allHolidays } from "./lib/holidays.js";
import { formatWorklogCsv, sortWorklogs } from "./lib/csv.js";
import { eachDay, monthCount, Rng, splitHours, weekday, ymOf } from "./lib/dummy-util.js";
import { generateScale } from "./dummy-scale.js";

export { mulberry32 } from "./lib/dummy-util.js";

// ---------------------------------------------------------------------------
// シナリオ定義（マスタ）
// ---------------------------------------------------------------------------

export interface TeamRow {
  team_id: string;
  name: string;
  parent_team_id: string;
  effective_from: YearMonth;
  /** 種別（SPEC §21） */
  level: string;
  /** リーダー（SPEC §22） */
  leader_member_id: string;
}

export interface MemberRow {
  member_id: string;
  name: string;
  kind: "employee" | "partner";
  title: string;
  department: string;
  section: string;
  team_id: string;
  effective_from: YearMonth;
  /** 在籍状態（空 = 在籍、"退職" = この月から在籍しない。SPEC §35） */
  status: string;
}

export interface RateRow {
  key: string;
  hourly_rate: number;
  effective_from: YearMonth;
}

export interface ContractRow {
  contract_id: string;
  customer_name: string;
  project_name: string;
  team_id: string;
  start_month: YearMonth;
  end_month: YearMonth;
  total_amount: number;
  note: string;
}

export interface MappingRow {
  worklog_customer_name: string;
  worklog_project_name: string;
  contract_id: string;
}

export interface AssignmentRow {
  member_id: string;
  contract_id: string;
  start_month: YearMonth;
  end_month: YearMonth;
  allocation: number;
}

/** 契約外予定（SPEC §36.4）: 人 × 期間 × 人月 */
export interface OutsidePlanRow {
  member_id: string;
  start_month: YearMonth;
  end_month: YearMonth;
  person_months: number;
  note: string;
}

/** 組織: 事業本部 > 事業部 > 課 > チーム（末端6チーム。種別・リーダーは組織ごと）。2026-10 にクラウド運用チームが第3課→第4課へ移動 */
const TEAMS: TeamRow[] = [
  { team_id: "HQ", name: "ソリューション事業本部", parent_team_id: "", effective_from: "2025-04", level: "本部", leader_member_id: "M001" },
  { team_id: "D1", name: "第1事業部", parent_team_id: "HQ", effective_from: "2025-04", level: "事業部", leader_member_id: "M002" },
  { team_id: "D2", name: "第2事業部", parent_team_id: "HQ", effective_from: "2025-04", level: "事業部", leader_member_id: "M003" },
  { team_id: "S11", name: "第1課", parent_team_id: "D1", effective_from: "2025-04", level: "課", leader_member_id: "M004" },
  { team_id: "S12", name: "第2課", parent_team_id: "D1", effective_from: "2025-04", level: "課", leader_member_id: "M005" },
  { team_id: "S21", name: "第3課", parent_team_id: "D2", effective_from: "2025-04", level: "課", leader_member_id: "M006" },
  { team_id: "S22", name: "第4課", parent_team_id: "D2", effective_from: "2025-04", level: "課", leader_member_id: "M007" },
  { team_id: "T111", name: "インフラ保守チーム", parent_team_id: "S11", effective_from: "2025-04", level: "チーム", leader_member_id: "M010" },
  { team_id: "T112", name: "ネットワーク保守チーム", parent_team_id: "S11", effective_from: "2025-04", level: "チーム", leader_member_id: "M013" },
  { team_id: "T121", name: "業務システム保守チーム", parent_team_id: "S12", effective_from: "2025-04", level: "チーム", leader_member_id: "M015" },
  { team_id: "T211", name: "Web保守チーム", parent_team_id: "S21", effective_from: "2025-04", level: "チーム", leader_member_id: "M018" },
  { team_id: "T212", name: "クラウド運用チーム", parent_team_id: "S21", effective_from: "2025-04", level: "チーム", leader_member_id: "M021" },
  { team_id: "T221", name: "データ基盤チーム", parent_team_id: "S22", effective_from: "2025-04", level: "チーム", leader_member_id: "M023" },
  // 組織変更: クラウド運用チームを第4課の配下へ（2026-10〜）
  { team_id: "T212", name: "クラウド運用チーム", parent_team_id: "S22", effective_from: "2026-10", level: "チーム", leader_member_id: "M021" },
];

const DEPT: Record<string, { department: string; section: string }> = {
  HQ: { department: "ソリューション事業本部", section: "" },
  D1: { department: "第1事業部", section: "" },
  D2: { department: "第2事業部", section: "" },
  S11: { department: "第1事業部", section: "第1課" },
  S12: { department: "第1事業部", section: "第2課" },
  S21: { department: "第2事業部", section: "第3課" },
  S22: { department: "第2事業部", section: "第4課" },
  T111: { department: "第1事業部", section: "第1課" },
  T112: { department: "第1事業部", section: "第1課" },
  T121: { department: "第1事業部", section: "第2課" },
  T211: { department: "第2事業部", section: "第3課" },
  T212: { department: "第2事業部", section: "第3課" },
  T221: { department: "第2事業部", section: "第4課" },
};

function member(
  member_id: string,
  name: string,
  kind: "employee" | "partner",
  title: string,
  team_id: string,
  effective_from: YearMonth,
  deptOverride?: { department: string; section: string },
): MemberRow {
  const d = deptOverride ?? DEPT[team_id] ?? { department: "", section: "" };
  return { member_id, name, kind, title, department: d.department, section: d.section, team_id, effective_from, status: "" };
}

const MEMBERS: MemberRow[] = [
  // 本部・事業部長（工数は付けない）
  member("M001", "佐藤 健一", "employee", "本部長", "HQ", "2025-04"),
  member("M002", "鈴木 美咲", "employee", "部長", "D1", "2025-04"),
  member("M003", "高橋 大輔", "employee", "部長", "D2", "2025-04"),
  // 課長（課に所属。末端チームではない）
  member("M004", "田中 さくら", "employee", "課長", "S11", "2025-04"),
  member("M005", "伊藤 翔太", "employee", "課長", "S12", "2025-04"),
  member("M006", "渡辺 直樹", "employee", "課長", "S21", "2025-04"),
  member("M007", "山本 麻衣", "employee", "課長", "S22", "2025-04"),
  // T111 インフラ保守チーム
  member("M010", "中村 拓也", "employee", "主任", "T111", "2025-04"),
  member("M011", "小林 玲奈", "employee", "一般", "T111", "2025-04"),
  member("M011", "小林 玲奈", "employee", "主任", "T111", "2026-07"), // 昇格（履歴行の追加）
  member("M012", "加藤 悠人", "employee", "一般", "T111", "2025-04"),
  member("M026", "吉田 結衣", "employee", "一般", "T111", "2026-04"), // 2026-04 入社
  // T112 ネットワーク保守チーム
  member("M013", "山田 智也", "employee", "主任", "T112", "2025-04"),
  member("M014", "佐々木 美月", "employee", "一般", "T112", "2025-04"),
  member("P001", "岡田 浩二", "partner", "パートナー", "T112", "2025-04"),
  // T121 業務システム保守チーム
  member("M015", "山口 健太", "employee", "主任", "T121", "2025-04"),
  member("M016", "松本 彩", "employee", "一般", "T121", "2025-04"),
  member("M017", "井上 大地", "employee", "一般", "T121", "2025-10"), // 2025-10 入社
  member("P002", "藤井 隆", "partner", "パートナー", "T121", "2025-10"),
  // T211 Web保守チーム
  member("M018", "木村 陽菜", "employee", "主任", "T211", "2025-04"),
  member("M019", "林 翔", "employee", "一般", "T211", "2025-04"),
  member("M020", "斎藤 蒼", "employee", "一般", "T211", "2025-04"),
  member("M020", "斎藤 蒼", "employee", "一般", "T212", "2026-10"), // 2026-10 チーム異動
  // T212 クラウド運用チーム
  member("M021", "清水 莉子", "employee", "主任", "T212", "2025-04"),
  member("M022", "森 大翔", "employee", "一般", "T212", "2025-04"),
  member("P003", "村上 翼", "partner", "パートナー", "T212", "2025-04"),
  // T221 データ基盤チーム
  member("M023", "池田 奈々", "employee", "主任", "T221", "2025-04"),
  member("M024", "橋本 海斗", "employee", "一般", "T221", "2025-04"),
  member("M025", "石井 修", "employee", "技術顧問", "T221", "2025-04"), // 役職「技術顧問」の単価行なし → RATE_MISSING
  member("M027", "前田 花", "employee", "一般", "T221", "2025-04"),
  member("P004", "近藤 雅子", "partner", "パートナー", "T221", "2025-04"),
];

/** members.csv に存在しないが工数には現れるメンバー（UNKNOWN_MEMBER） */
const GHOST_MEMBER = { id: "M099", name: "臨時 太郎" };

const RATES: RateRow[] = [
  { key: "本部長", hourly_rate: 15000, effective_from: "2025-04" },
  { key: "部長", hourly_rate: 12000, effective_from: "2025-04" },
  { key: "課長", hourly_rate: 10000, effective_from: "2025-04" },
  { key: "主任", hourly_rate: 8000, effective_from: "2025-04" },
  { key: "主任", hourly_rate: 8500, effective_from: "2026-04" }, // 単価改定（2025年度の月は 8000 のまま）
  { key: "一般", hourly_rate: 6000, effective_from: "2025-04" },
  // 「技術顧問」の行は意図的に無い
  // パートナー個人単価
  { key: "P001", hourly_rate: 7000, effective_from: "2025-04" },
  { key: "P002", hourly_rate: 7500, effective_from: "2025-10" },
  { key: "P003", hourly_rate: 6800, effective_from: "2025-04" },
  { key: "P004", hourly_rate: 9000, effective_from: "2025-04" },
];

/** 契約。金額はチームの原価（単価×時間）に対しておおむね 75〜95% の消化になるように調整してある */
const CONTRACTS: ContractRow[] = [
  { contract_id: "C001", customer_name: "青葉物流", project_name: "倉庫管理システム保守", team_id: "T111", start_month: "2025-04", end_month: "2026-03", total_amount: 48000000, note: "FY2025" },
  { contract_id: "C002", customer_name: "青葉物流", project_name: "倉庫管理システム保守", team_id: "T111", start_month: "2026-04", end_month: "2027-03", total_amount: 60000000, note: "FY2026 更新" },
  { contract_id: "C003", customer_name: "みなと銀行", project_name: "勘定系周辺システム保守", team_id: "T121", start_month: "2025-10", end_month: "2026-09", total_amount: 42000000, note: "期中開始（10月〜9月）" },
  { contract_id: "C004", customer_name: "みなと銀行", project_name: "勘定系周辺システム保守", team_id: "T121", start_month: "2026-10", end_month: "2027-09", total_amount: 45000000, note: "C003 の更新契約" },
  { contract_id: "C005", customer_name: "さくら製菓", project_name: "ECサイト保守", team_id: "T211", start_month: "2026-04", end_month: "2027-03", total_amount: 38000000, note: "12で割り切れない金額（端数は最終月）" },
  { contract_id: "C006", customer_name: "ひまわり食品", project_name: "受発注システム保守", team_id: "T112", start_month: "2026-04", end_month: "2026-09", total_amount: 3600000, note: "6か月契約" },
  { contract_id: "C007", customer_name: "北斗建設", project_name: "クラウド基盤運用", team_id: "T212", start_month: "2025-04", end_month: "2027-03", total_amount: 96000000, note: "24か月契約（2年度にまたがる）" },
  { contract_id: "C008", customer_name: "こもれび出版", project_name: "会員サイト保守", team_id: "T211", start_month: "2026-04", end_month: "2027-03", total_amount: 6000000, note: "値下げ更新。工数が予算を上回る見込み" },
  { contract_id: "C009", customer_name: "しらかば医療", project_name: "電子カルテ連携保守", team_id: "", start_month: "2026-04", end_month: "2027-03", total_amount: 6000000, note: "主担当チーム未設定" },
  { contract_id: "C010", customer_name: "やまびこ通信", project_name: "ネットワーク監視", team_id: "T112", start_month: "2027-01", end_month: "2027-12", total_amount: 8000000, note: "将来開始" },
  { contract_id: "C011", customer_name: "あかつき商事", project_name: "データ分析基盤運用", team_id: "T221", start_month: "2026-04", end_month: "2027-03", total_amount: 66000000, note: "FY2026" },
  { contract_id: "C012", customer_name: "つばめ運輸", project_name: "配車システム保守", team_id: "T221", start_month: "2026-07", end_month: "2027-06", total_amount: 5400000, note: "作業実績がまだ無い" },
  { contract_id: "C013", customer_name: "かえで学園", project_name: "学習管理システム保守", team_id: "T121", start_month: "2026-04", end_month: "2027-03", total_amount: 120000, note: "少額契約（月1万円）" },
  { contract_id: "C014", customer_name: "さくら製菓", project_name: "ECサイト保守", team_id: "T211", start_month: "2025-04", end_month: "2026-03", total_amount: 33600000, note: "FY2025" },
  { contract_id: "C015", customer_name: "こもれび出版", project_name: "会員サイト保守", team_id: "T211", start_month: "2025-04", end_month: "2026-03", total_amount: 9000000, note: "FY2025" },
  { contract_id: "C016", customer_name: "あかつき商事", project_name: "データ分析基盤運用", team_id: "T221", start_month: "2025-04", end_month: "2026-03", total_amount: 63000000, note: "FY2025" },
  { contract_id: "C017", customer_name: "やまびこ通信", project_name: "拠点ネットワーク保守", team_id: "T112", start_month: "2025-04", end_month: "2026-03", total_amount: 44400000, note: "FY2025" },
  { contract_id: "C018", customer_name: "やまびこ通信", project_name: "拠点ネットワーク保守", team_id: "T112", start_month: "2026-04", end_month: "2027-03", total_amount: 42000000, note: "FY2026 更新" },
  { contract_id: "C019", customer_name: "ふじみ生命", project_name: "契約管理システム保守", team_id: "T121", start_month: "2025-04", end_month: "2026-03", total_amount: 36000000, note: "FY2025" },
  { contract_id: "C020", customer_name: "ふじみ生命", project_name: "契約管理システム保守", team_id: "T121", start_month: "2026-04", end_month: "2027-03", total_amount: 18000000, note: "FY2026 縮小更新" },
  { contract_id: "C021", customer_name: "北斗建設", project_name: "開発環境運用", team_id: "T212", start_month: "2026-10", end_month: "2027-09", total_amount: 18000000, note: "2026-10 追加受注" },
];

/**
 * 工数側の表記ゆれ。各契約について、工数に現れる (顧客名, 案件名) の候補を定義する。
 * 正規化（NFKC・空白圧縮・小文字化・法人格除去）で mapping.csv の名称に一致する。
 */
interface NameVariants {
  customers: ReadonlyArray<readonly [string, number]>;
  projects: ReadonlyArray<readonly [string, number]>;
}

const WORKLOG_NAMES: Record<string, NameVariants> = {
  青葉物流: {
    customers: [["株式会社青葉物流", 8], ["青葉物流株式会社", 1], ["青葉物流", 1]],
    projects: [["倉庫管理システム保守", 1]],
  },
  みなと銀行: {
    customers: [["みなと銀行株式会社", 1]],
    // 案件名は自由入力。mapping では案件名空（顧客の全工数）で紐付ける
    projects: [["勘定系周辺システム保守", 6], ["勘定系周辺 障害対応", 2], ["月次報告", 1], ["", 1]],
  },
  さくら製菓: {
    customers: [["さくら製菓株式会社", 6], ["（株）さくら製菓", 2], ["さくら製菓 ", 1], ["㈱さくら製菓", 1]],
    projects: [["ECサイト保守", 5], ["ＥＣサイト保守", 3], ["ecサイト保守", 1], ["ECサイト保守 ", 1]],
  },
  ひまわり食品: {
    customers: [["株式会社ひまわり食品", 5], ["ひまわり食品（株）", 2]],
    projects: [["受発注システム保守", 1]],
  },
  北斗建設: {
    customers: [["北斗建設 株式会社", 5], ["北斗建設  株式会社", 1], ["北斗建設", 2]],
    projects: [["クラウド基盤運用", 1]],
  },
  こもれび出版: {
    customers: [["こもれび出版株式会社", 1]],
    projects: [["会員サイト保守", 1]],
  },
  しらかば医療: {
    customers: [["しらかば医療", 1]],
    projects: [["電子カルテ連携保守", 1]],
  },
  やまびこ通信: {
    customers: [["やまびこ通信株式会社", 1]],
    projects: [["拠点ネットワーク保守", 1]],
  },
  あかつき商事: {
    customers: [["株式会社あかつき商事", 7], ["(株)あかつき商事", 2], ["あかつき商事", 1]],
    projects: [["データ分析基盤運用", 8], ["データ分析基盤運用　", 1], ["ﾃﾞｰﾀ分析基盤運用", 1]],
  },
  つばめ運輸: { customers: [["つばめ運輸株式会社", 1]], projects: [["配車システム保守", 1]] },
  かえで学園: { customers: [["学校法人かえで学園", 1]], projects: [["学習管理システム保守", 1]] },
  ふじみ生命: {
    customers: [["ふじみ生命保険株式会社", 1]],
    projects: [["契約管理システム保守", 1]],
  },
};

/** 工数側の名前を引くキー（契約 → 顧客グループ, 案件バリエーション） */
function worklogNamesFor(c: ContractRow): NameVariants {
  const base = WORKLOG_NAMES[c.customer_name];
  if (!base) throw new Error(`WORKLOG_NAMES に ${c.customer_name} が無い`);
  if (c.contract_id === "C021") {
    return { customers: base.customers, projects: [["開発環境運用", 1]] };
  }
  return base;
}

/** mapping.csv: 顧客の正規名で登録。みなと銀行は案件名空（顧客の全工数）。学校法人かえで学園は法人格が除去されないので正式名で登録 */
const MAPPINGS: MappingRow[] = [
  { worklog_customer_name: "青葉物流", worklog_project_name: "倉庫管理システム保守", contract_id: "C001" },
  { worklog_customer_name: "青葉物流", worklog_project_name: "倉庫管理システム保守", contract_id: "C002" },
  { worklog_customer_name: "みなと銀行", worklog_project_name: "", contract_id: "C003" },
  { worklog_customer_name: "みなと銀行", worklog_project_name: "", contract_id: "C004" },
  { worklog_customer_name: "さくら製菓", worklog_project_name: "ECサイト保守", contract_id: "C014" },
  { worklog_customer_name: "さくら製菓", worklog_project_name: "ECサイト保守", contract_id: "C005" },
  { worklog_customer_name: "ひまわり食品", worklog_project_name: "受発注システム保守", contract_id: "C006" },
  { worklog_customer_name: "北斗建設", worklog_project_name: "クラウド基盤運用", contract_id: "C007" },
  { worklog_customer_name: "北斗建設", worklog_project_name: "開発環境運用", contract_id: "C021" },
  { worklog_customer_name: "こもれび出版", worklog_project_name: "会員サイト保守", contract_id: "C015" },
  { worklog_customer_name: "こもれび出版", worklog_project_name: "会員サイト保守", contract_id: "C008" },
  { worklog_customer_name: "しらかば医療", worklog_project_name: "電子カルテ連携保守", contract_id: "C009" },
  { worklog_customer_name: "やまびこ通信", worklog_project_name: "ネットワーク監視", contract_id: "C010" },
  { worklog_customer_name: "やまびこ通信", worklog_project_name: "拠点ネットワーク保守", contract_id: "C017" },
  { worklog_customer_name: "やまびこ通信", worklog_project_name: "拠点ネットワーク保守", contract_id: "C018" },
  { worklog_customer_name: "あかつき商事", worklog_project_name: "データ分析基盤運用", contract_id: "C016" },
  { worklog_customer_name: "あかつき商事", worklog_project_name: "データ分析基盤運用", contract_id: "C011" },
  { worklog_customer_name: "つばめ運輸", worklog_project_name: "配車システム保守", contract_id: "C012" },
  { worklog_customer_name: "学校法人かえで学園", worklog_project_name: "学習管理システム保守", contract_id: "C013" },
  { worklog_customer_name: "ふじみ生命保険", worklog_project_name: "契約管理システム保守", contract_id: "C019" },
  { worklog_customer_name: "ふじみ生命保険", worklog_project_name: "契約管理システム保守", contract_id: "C020" },
];

/** ルールの無い工数（未紐付け NO_RULE になる） */
const NO_RULE_PAIRS = [
  { customer: "社内", project: "勉強会" },
  { customer: "もみじ不動産", project: "営業支援ツール検討" },
] as const;

/** アサイン（assignment 方式の着地見込み用）。FY2026 分 */
const ASSIGNMENTS: AssignmentRow[] = [
  { member_id: "M010", contract_id: "C002", start_month: "2026-04", end_month: "2027-03", allocation: 0.9 },
  { member_id: "M011", contract_id: "C002", start_month: "2026-04", end_month: "2027-03", allocation: 0.9 },
  { member_id: "M012", contract_id: "C002", start_month: "2026-04", end_month: "2027-03", allocation: 0.9 },
  { member_id: "M026", contract_id: "C002", start_month: "2026-04", end_month: "2027-03", allocation: 0.8 },
  { member_id: "M004", contract_id: "C002", start_month: "2026-04", end_month: "2027-03", allocation: 0.2 },
  { member_id: "M004", contract_id: "C018", start_month: "2026-04", end_month: "2027-03", allocation: 0.2 },
  { member_id: "M013", contract_id: "C018", start_month: "2026-04", end_month: "2027-03", allocation: 0.8 },
  { member_id: "M013", contract_id: "C006", start_month: "2026-04", end_month: "2026-09", allocation: 0.1 },
  { member_id: "M013", contract_id: "C010", start_month: "2027-01", end_month: "2027-03", allocation: 0.1 },
  { member_id: "M014", contract_id: "C018", start_month: "2026-04", end_month: "2027-03", allocation: 0.8 },
  { member_id: "M014", contract_id: "C006", start_month: "2026-04", end_month: "2026-09", allocation: 0.1 },
  { member_id: "P001", contract_id: "C018", start_month: "2026-04", end_month: "2027-03", allocation: 0.9 },
  { member_id: "M015", contract_id: "C004", start_month: "2026-10", end_month: "2027-03", allocation: 0.6 },
  { member_id: "M015", contract_id: "C003", start_month: "2026-04", end_month: "2026-09", allocation: 0.6 },
  { member_id: "M015", contract_id: "C020", start_month: "2026-04", end_month: "2027-03", allocation: 0.3 },
  { member_id: "M016", contract_id: "C003", start_month: "2026-04", end_month: "2026-09", allocation: 0.5 },
  { member_id: "M016", contract_id: "C004", start_month: "2026-10", end_month: "2027-03", allocation: 0.5 },
  { member_id: "M016", contract_id: "C020", start_month: "2026-04", end_month: "2027-03", allocation: 0.3 },
  { member_id: "M016", contract_id: "C013", start_month: "2026-04", end_month: "2027-03", allocation: 0.05 },
  { member_id: "M017", contract_id: "C003", start_month: "2026-04", end_month: "2026-09", allocation: 0.9 },
  { member_id: "M017", contract_id: "C004", start_month: "2026-10", end_month: "2027-03", allocation: 0.9 },
  { member_id: "P002", contract_id: "C020", start_month: "2026-04", end_month: "2027-03", allocation: 0.9 },
  { member_id: "M005", contract_id: "C003", start_month: "2026-04", end_month: "2026-09", allocation: 0.3 },
  { member_id: "M005", contract_id: "C004", start_month: "2026-10", end_month: "2027-03", allocation: 0.3 },
  { member_id: "M018", contract_id: "C005", start_month: "2026-04", end_month: "2027-03", allocation: 0.9 },
  { member_id: "M019", contract_id: "C008", start_month: "2026-04", end_month: "2027-03", allocation: 0.7 },
  { member_id: "M019", contract_id: "C005", start_month: "2026-04", end_month: "2027-03", allocation: 0.2 },
  { member_id: "M020", contract_id: "C005", start_month: "2026-04", end_month: "2026-09", allocation: 0.9 },
  { member_id: "M020", contract_id: "C021", start_month: "2026-10", end_month: "2027-03", allocation: 0.9 },
  { member_id: "M006", contract_id: "C005", start_month: "2026-04", end_month: "2027-03", allocation: 0.2 },
  { member_id: "M006", contract_id: "C007", start_month: "2026-04", end_month: "2027-03", allocation: 0.2 },
  { member_id: "M021", contract_id: "C007", start_month: "2026-04", end_month: "2027-03", allocation: 0.9 },
  { member_id: "M022", contract_id: "C007", start_month: "2026-04", end_month: "2027-03", allocation: 0.9 },
  { member_id: "P003", contract_id: "C007", start_month: "2026-04", end_month: "2027-03", allocation: 0.9 },
  { member_id: "M023", contract_id: "C011", start_month: "2026-04", end_month: "2027-03", allocation: 0.9 },
  { member_id: "M024", contract_id: "C011", start_month: "2026-04", end_month: "2027-03", allocation: 0.8 },
  { member_id: "M024", contract_id: "C012", start_month: "2026-07", end_month: "2027-03", allocation: 0.1 },
  { member_id: "M025", contract_id: "C011", start_month: "2026-04", end_month: "2027-03", allocation: 0.5 },
  { member_id: "M027", contract_id: "C011", start_month: "2026-04", end_month: "2027-03", allocation: 0.9 },
  { member_id: "P004", contract_id: "C011", start_month: "2026-04", end_month: "2027-03", allocation: 0.9 },
  { member_id: "M007", contract_id: "C011", start_month: "2026-04", end_month: "2027-03", allocation: 0.4 },
];

/** 契約外予定: 保守の配分との合計が 1.0 を超える月がある人（M010・M013・M020）と、期間を変えた例（M013） */
const OUTSIDE_PLANS: OutsidePlanRow[] = [
  { member_id: "M010", start_month: "2026-11", end_month: "2027-01", person_months: 0.2, note: "次期更改の提案" },
  { member_id: "M013", start_month: "2026-07", end_month: "2026-09", person_months: 0.1, note: "運用設計の支援" },
  { member_id: "M013", start_month: "2026-10", end_month: "2027-03", person_months: 0.2, note: "運用設計の支援" },
  { member_id: "M020", start_month: "2026-12", end_month: "2027-02", person_months: 0.3, note: "新規顧客の提案" },
];

const TASKS: ReadonlyArray<readonly [string, number]> = [
  ["定例", 3],
  ["問い合わせ対応", 5],
  ["障害対応", 2],
  ["調査", 3],
  ["リリース作業", 1],
  ["監視・運用", 4],
  ["パッチ適用", 1],
  ["ドキュメント更新", 1],
  ["改修", 2],
  ["テスト", 2],
];

/**
 * 作業種別の分類表（SPEC §30.1）。「勉強会」はわざと載せない（未分類の警告 TASK_UNCLASSIFIED の例）。
 * 「社内会議」は顧客名が空で分類より先に除外されるので載せなくてよい。
 */
const TASK_TYPES: Array<{ task: string; category: string; note: string }> = [
  { task: "定例", category: "契約内", note: "" },
  { task: "問い合わせ対応", category: "契約内", note: "" },
  { task: "障害対応", category: "契約内", note: "" },
  { task: "調査", category: "契約内", note: "" },
  { task: "リリース作業", category: "契約内", note: "" },
  { task: "監視・運用", category: "契約内", note: "" },
  { task: "パッチ適用", category: "契約内", note: "" },
  { task: "ドキュメント更新", category: "契約内", note: "" },
  { task: "改修", category: "契約内", note: "保守契約の範囲内の軽微な改修" },
  { task: "テスト", category: "契約内", note: "" },
  { task: "データ移行", category: "契約内", note: "" },
  { task: "導入準備", category: "契約内", note: "" },
  { task: "提案", category: "契約外", note: "追加案件・更改の提案" },
  { task: "運用設計", category: "契約外", note: "新規・更改に伴う運用設計" },
  { task: "見積", category: "契約外", note: "" },
];

/**
 * 契約外の作業（提案・運用設計など。SPEC §30）。契約の実績に入らないので、既存の数値を変えないよう
 * 本体とは別の乱数列で、本体の作業に上乗せする（その人の稼働が増える＝稼働上限の確認に使う）。
 */
const OUTSIDE_WORK: Array<{ memberIds: string[]; contractId: string | null; customer?: string; project?: string; tasks: ReadonlyArray<readonly [string, number]>; from: YearMonth; to: YearMonth; p: number; hours: number[] }> = [
  // 関連契約あり: 青葉物流の更改提案（T111 の主任・メンバー）
  { memberIds: ["M010", "M011"], contractId: "C002", tasks: [["提案", 3], ["見積", 1]], from: "2026-06", to: "2026-10", p: 0.5, hours: [2, 3, 4] },
  // 関連契約あり: みなと銀行の運用設計（T121）
  { memberIds: ["M015", "M017"], contractId: "C004", tasks: [["運用設計", 1]], from: "2026-08", to: "2026-10", p: 0.6, hours: [2, 3, 4] },
  // 関連契約なし: 新規顧客への提案（紐付けルールなし → 契約外なので未紐付け警告は出ない）
  { memberIds: ["M019"], contractId: null, customer: "株式会社さくらんぼ交通", project: "運行管理システム提案", tasks: [["提案", 2], ["見積", 1]], from: "2026-08", to: "2026-10", p: 0.5, hours: [2, 3] },
];

// ---------------------------------------------------------------------------
// 作業実績の生成
// ---------------------------------------------------------------------------

/** 月 m に有効なメンバーレコード（同じキーで effective_from <= m の最大。同値なら後の行） */
function memberAt(memberId: string, month: YearMonth): MemberRow | undefined {
  let best: MemberRow | undefined;
  for (const r of MEMBERS) {
    if (r.member_id !== memberId || r.effective_from > month) continue;
    if (!best || r.effective_from >= best.effective_from) best = r;
  }
  return best;
}

/** 月 m に有効な契約（期間内） */
function activeContracts(month: YearMonth): ContractRow[] {
  return CONTRACTS.filter((c) => c.start_month <= month && month <= c.end_month);
}

/** チームの工数対象契約。課長は課配下チームの契約を見る */
function teamContracts(teamId: string, month: YearMonth): ContractRow[] {
  const leaf: Record<string, string[]> = {
    S11: ["T111", "T112"],
    S12: ["T121"],
    S21: ["T211", "T212"],
    S22: ["T221"],
  };
  const teams = leaf[teamId] ?? [teamId];
  return activeContracts(month).filter((c) => teams.includes(c.team_id));
}

interface GenOptions {
  seed: number;
  asOf: string;
  /** "full"（既定）= 基本シナリオ ＋ 実運用規模の部分（scripts/dummy-scale.ts）、"base" = 基本シナリオだけ */
  scale?: "full" | "base";
}

interface Generated {
  teams: TeamRow[];
  members: MemberRow[];
  rates: RateRow[];
  contracts: ContractRow[];
  mappings: MappingRow[];
  assignments: AssignmentRow[];
  outsidePlans: OutsidePlanRow[];
  holidays: Array<{ date: string; name: string }>;
  taskTypes: Array<{ task: string; category: string; note: string }>;
  /** 月ごとの作業実績 */
  worklogsByMonth: Map<YearMonth, Worklog[]>;
}

/** 契約の工数側表記を1つ選ぶ */
function pickNames(rng: Rng, c: ContractRow): { customer: string; project: string } {
  const v = worklogNamesFor(c);
  return { customer: rng.weighted(v.customers), project: rng.weighted(v.projects) };
}

/** 契約の月額（百万円単位）。工数の配分重みに使う */
function monthlyMillions(c: ContractRow): number {
  const n = monthCount(c.start_month, c.end_month);
  return c.total_amount / n / 1e6;
}

/** 個別に時間を付ける契約（通常の配分からは外す） */
const SPECIAL_CONTRACTS = new Set(["C009", "C010", "C012", "C013"]);

/** メンバーごとの「重点契約」。基本は契約の月額に比例（大きい契約ほど時間を使う） */
function focusWeights(m: MemberRow, month: YearMonth): Array<readonly [ContractRow, number]> {
  const cs = teamContracts(m.team_id, month);
  return cs.map((c) => {
    let w = monthlyMillions(c);
    if (SPECIAL_CONTRACTS.has(c.contract_id)) w = 0;
    // こもれび出版は M019 がほぼ専任。FY2026 は値下げ更新で予算を超える
    if (c.contract_id === "C008") w = m.member_id === "M019" ? 9 : 0.05;
    if (c.contract_id === "C015") w = m.member_id === "M019" ? 2.5 : 0.05;
    // 北斗建設の追加受注は異動してきた M020 が主担当
    if (c.contract_id === "C021") w = m.member_id === "M020" ? 6 : 0.4;
    return [c, w] as const;
  });
}

export function generate(opts: GenOptions): Generated {
  const rng = new Rng(opts.seed);
  const holidays = allHolidays(2025, 2027);
  const holidaySet = new Set(holidays.map((h) => h.date));
  const worklogsByMonth = new Map<YearMonth, Worklog[]>();
  const push = (w: Worklog) => {
    const ym = ymOf(w.date);
    let arr = worklogsByMonth.get(ym);
    if (!arr) worklogsByMonth.set(ym, (arr = []));
    arr.push(w);
  };

  const memberIds = [...new Set(MEMBERS.map((m) => m.member_id))];
  const days = eachDay("2025-04-01", opts.asOf).filter((d) => {
    const wd = weekday(d);
    return wd !== 0 && wd !== 6 && !holidaySet.has(d);
  });

  for (const date of days) {
    const month = ymOf(date);
    for (const id of memberIds) {
      const m = memberAt(id, month);
      if (!m) continue; // まだ入社していない
      if (m.title === "本部長" || m.title === "部長") continue; // 管理職は工数を付けない
      const isLeader = m.title === "課長";

      // 休暇（たまに丸1日休む）
      if (rng.chance(0.04)) continue;

      // 1日の総時間
      const total = isLeader ? rng.weighted([[2, 2], [3, 3], [4, 2]]) : rng.weighted([[6, 1], [6.5, 2], [7, 3], [7.5, 2], [8, 2]]);
      const own = focusWeights(m, month).filter(([, w]) => w > 0);
      if (own.length === 0) continue;

      const nSlots = isLeader ? rng.int(1, 2) : rng.int(1, 3);
      const hoursList = splitHours(rng, total, nSlots);
      for (const hours of hoursList) {
        let contract: ContractRow | undefined;
        // 他チームの契約への応援（約10%）
        if (!isLeader && rng.chance(0.1)) {
          const others = activeContracts(month)
            .filter((c) => c.team_id !== "" && c.team_id !== m.team_id && !SPECIAL_CONTRACTS.has(c.contract_id))
            .map((c) => [c, monthlyMillions(c)] as const);
          if (others.length > 0) contract = rng.weighted(others);
        }
        if (!contract) contract = rng.weighted(own);
        const names = pickNames(rng, contract);
        push({
          date,
          memberId: m.member_id,
          memberName: m.name,
          customerName: names.customer,
          projectName: names.project,
          task: rng.weighted(TASKS),
          hours,
        });
      }

      // 顧客名が空の社内作業（除外対象）: 5% の日に 0.5〜1.0h
      if (rng.chance(0.05)) {
        push({ date, memberId: m.member_id, memberName: m.name, customerName: "", projectName: "", task: "社内会議", hours: rng.pick([0.5, 1]) });
      }
      // 社内勉強会（ルール無し → 未紐付け）: 1.5% の日
      if (rng.chance(0.015)) {
        push({ date, memberId: m.member_id, memberName: m.name, customerName: "社内", projectName: "勉強会", task: "勉強会", hours: 1 });
      }
      // 主担当チーム未設定の契約（C009）: T121 の M016 と T221 の M024 が少しずつ
      if ((m.member_id === "M016" || m.member_id === "M024") && month >= "2026-04" && rng.chance(0.5)) {
        const c9 = CONTRACTS.find((c) => c.contract_id === "C009");
        if (c9) {
          const names = pickNames(rng, c9);
          push({ date, memberId: m.member_id, memberName: m.name, customerName: names.customer, projectName: names.project, task: rng.weighted(TASKS), hours: rng.pick([1, 1.5, 2]) });
        }
      }
      // 少額契約（C013）: M016 が月に数回 0.25〜0.5h
      if (m.member_id === "M016" && month >= "2026-04" && rng.chance(0.15)) {
        const c13 = CONTRACTS.find((c) => c.contract_id === "C013");
        if (c13) {
          const names = pickNames(rng, c13);
          push({ date, memberId: m.member_id, memberName: m.name, customerName: names.customer, projectName: names.project, task: "問い合わせ対応", hours: rng.pick([0.25, 0.5]) });
        }
      }
      // ルール無し: 営業支援の検討（M018、2026-08〜2026-10）
      if (m.member_id === "M018" && month >= "2026-08" && month <= "2026-10" && rng.chance(0.2)) {
        push({ date, memberId: m.member_id, memberName: m.name, customerName: NO_RULE_PAIRS[1].customer, projectName: NO_RULE_PAIRS[1].project, task: "調査", hours: rng.pick([1, 1.5, 2]) });
      }
      // 将来契約（C010）の準備作業（M013、2026-10）→ 期間外で未紐付け
      if (m.member_id === "M013" && month === "2026-10" && rng.chance(0.15)) {
        push({ date, memberId: m.member_id, memberName: m.name, customerName: "やまびこ通信株式会社", projectName: "ネットワーク監視", task: "導入準備", hours: 2 });
      }
    }

    // members.csv に無いメンバー（UNKNOWN_MEMBER）: 2026-06〜2026-08 に C011 で稼働
    if (month >= "2026-06" && month <= "2026-08" && rng.chance(0.7)) {
      const c11 = CONTRACTS.find((c) => c.contract_id === "C011");
      if (c11) {
        const names = pickNames(rng, c11);
        push({ date, memberId: GHOST_MEMBER.id, memberName: GHOST_MEMBER.name, customerName: names.customer, projectName: names.project, task: "データ移行", hours: 4 });
      }
    }
  }

  // 契約外の作業（別の乱数列。本体の数値を変えない）
  const rngOutside = new Rng(opts.seed + 7919);
  for (const date of days) {
    const month = ymOf(date);
    for (const o of OUTSIDE_WORK) {
      if (month < o.from || month > o.to) continue;
      for (const id of o.memberIds) {
        const m = memberAt(id, month);
        if (!m || !rngOutside.chance(o.p)) continue;
        const c = o.contractId ? CONTRACTS.find((x) => x.contract_id === o.contractId) : undefined;
        const names = c ? pickNames(rngOutside, c) : { customer: o.customer ?? "", project: o.project ?? "" };
        push({ date, memberId: m.member_id, memberName: m.name, customerName: names.customer, projectName: names.project, task: rngOutside.weighted(o.tasks), hours: rngOutside.pick(o.hours) });
      }
    }
  }

  // 固定のエッジケース行
  // hours = 0 の行（無視される）
  if (opts.asOf >= "2026-05-12") {
    push({ date: "2026-05-12", memberId: "M014", memberName: "佐々木 美月", customerName: "株式会社ひまわり食品", projectName: "受発注システム保守", task: "問い合わせ対応", hours: 0 });
  }

  // 実運用規模の部分（別の乱数列・別のメンバーと契約。基本シナリオの数値は変わらない）
  const out = { teams: [...TEAMS], members: [...MEMBERS], rates: [...RATES], contracts: [...CONTRACTS], mappings: [...MAPPINGS], assignments: [...ASSIGNMENTS], outsidePlans: [...OUTSIDE_PLANS], taskTypes: [...TASK_TYPES] };
  if ((opts.scale ?? "full") === "full") {
    const x = generateScale({ seed: opts.seed, asOf: opts.asOf, days, baseRates: RATES });
    out.teams.push(...x.teams);
    out.members.push(...x.members);
    out.rates.push(...x.rates);
    out.contracts.push(...x.contracts);
    out.mappings.push(...x.mappings);
    out.assignments.push(...x.assignments);
    out.outsidePlans.push(...x.outsidePlans);
    out.taskTypes.push(...x.taskTypes);
    for (const w of x.worklogs) push(w);
  }

  // 月内は日付→メンバー→顧客順に並べて安定させる
  for (const [ym, rows] of worklogsByMonth) worklogsByMonth.set(ym, sortWorklogs(rows));

  return { ...out, holidays, worklogsByMonth };
}

// ---------------------------------------------------------------------------
// 書き出し
// ---------------------------------------------------------------------------

function csv<T extends object>(rows: T[], columns: Array<keyof T & string>): string {
  return csvFormat(rows as unknown as Array<Record<string, string | number>>, columns) + "\n";
}

export interface WriteOptions extends GenOptions {
  outDir: string;
}

/** 生成して outDir 以下に書き出す。戻り値は件数の要約 */
export function writeDummy(opts: WriteOptions): { members: number; contracts: number; worklogRows: number; months: number } {
  const g = generate(opts);
  const out = opts.outDir;
  mkdirSync(join(out, "masters"), { recursive: true });
  mkdirSync(join(out, "worklogs"), { recursive: true });

  writeFileSync(join(out, "contracts.csv"), csv(g.contracts, ["contract_id", "customer_name", "project_name", "team_id", "start_month", "end_month", "total_amount", "note"]));
  writeFileSync(join(out, "mapping.csv"), csv(g.mappings, ["worklog_customer_name", "worklog_project_name", "contract_id"]));
  writeFileSync(join(out, "assignments.csv"), csv(g.assignments, ["member_id", "contract_id", "start_month", "end_month", "allocation"]));
  writeFileSync(join(out, "outside-plans.csv"), csv(g.outsidePlans, ["member_id", "start_month", "end_month", "person_months", "note"]));
  // holidays.csv は Excel で保存した体で BOM 付き
  writeFileSync(join(out, "holidays.csv"), "﻿" + csv(g.holidays, ["date", "name"]));
  writeFileSync(join(out, "masters", "teams.csv"), csv(g.teams, ["team_id", "name", "parent_team_id", "effective_from", "level", "leader_member_id"]));
  writeFileSync(join(out, "masters", "members.csv"), csv(g.members, ["member_id", "name", "kind", "title", "department", "section", "team_id", "effective_from", "status"]));
  writeFileSync(join(out, "masters", "rates.csv"), csv(g.rates, ["key", "hourly_rate", "effective_from"]));
  writeFileSync(join(out, "task-types.csv"), csv(g.taskTypes, ["task", "category", "note"]));

  // 既存の月次ファイルを消してから書く（asOf を戻したときに古い月が残らないように）
  const wlDir = join(out, "worklogs");
  for (const f of readdirSync(wlDir)) {
    if (/^\d{4}-\d{2}\.csv$/.test(f)) unlinkSync(join(wlDir, f));
  }
  let rows = 0;
  const months = [...g.worklogsByMonth.keys()].sort();
  for (const ym of months) {
    const list = g.worklogsByMonth.get(ym) ?? [];
    rows += list.length;
    writeFileSync(join(wlDir, `${ym}.csv`), formatWorklogCsv(list));
  }
  const meta = { fetchedAt: `${opts.asOf}T09:00:00+09:00`, adapter: "dummy", seed: opts.seed, asOf: opts.asOf };
  writeFileSync(join(wlDir, "_meta.json"), JSON.stringify(meta, null, 2) + "\n");

  return { members: new Set(g.members.map((m) => m.member_id)).size, contracts: g.contracts.length, worklogRows: rows, months: months.length };
}

/** 月範囲の作業実績だけ返す（dummy アダプタ用） */
export function generateWorklogs(opts: GenOptions & { from: YearMonth; to: YearMonth }): Worklog[] {
  const g = generate(opts);
  const out: Worklog[] = [];
  for (const ym of [...g.worklogsByMonth.keys()].sort()) {
    if (ym < opts.from || ym > opts.to) continue;
    out.push(...(g.worklogsByMonth.get(ym) ?? []));
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): WriteOptions {
  const opts: WriteOptions = { seed: 42, asOf: "2026-10-27", outDir: "data" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if ((a === "--seed" || a === "-s") && v !== undefined) {
      opts.seed = Number(v);
      i++;
    } else if (a === "--asOf" && v !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--asOf は YYYY-MM-DD 形式で指定してください: ${v}`);
      opts.asOf = v;
      i++;
    } else if (a === "--base-only") {
      opts.scale = "base";
    } else if (a === "--out" && v !== undefined) {
      opts.outDir = v;
      i++;
    } else if (a !== undefined && /^\d+$/.test(a) && opts.seed === 42) {
      opts.seed = Number(a); // 位置引数の seed
    }
  }
  if (!Number.isFinite(opts.seed)) throw new Error("--seed は整数で指定してください");
  return opts;
}

const isMain = process.argv[1] !== undefined && existsSync(process.argv[1]) && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const summary = writeDummy(opts);
  console.log(`ダミーデータを ${opts.outDir}/ に生成しました (seed=${opts.seed}, asOf=${opts.asOf})`);
  console.log(`  メンバー ${summary.members} 人 / 契約 ${summary.contracts} 件 / 作業実績 ${summary.worklogRows} 行 (${summary.months} か月)`);
}
