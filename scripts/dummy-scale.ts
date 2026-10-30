/**
 * ダミーデータの「実運用規模」の部分（scripts/generate-dummy.ts から呼ぶ。決定的）
 *
 * 手で作った基本シナリオ（6 チーム・30 人・21 契約。docs/DUMMY_DATA.md の前半）はそのまま残し、
 * その外側に 4 事業部・約 120 人・約 90 契約を足して、全体を元の 5 倍前後にする。
 * 基本シナリオとは乱数列もメンバーも契約も分けてあるので、基本シナリオの数値（テストの期待値）は変わらない。
 *
 * 実運用でよくあることを、ふつうに混ぜてある（docs/DUMMY_DATA.md「実運用規模の部分」）:
 *   - 予算超過（予実マイナス）が 3 割前後。大幅超過（150〜250%）や大幅な余り（30〜60%）も少しある
 *   - 終了した案件（更新しなかった・途中解約）、変更契約（途中で金額が変わり別契約行）、3 年契約、将来開始
 *   - 退職者（status=退職 の履歴行。退職月から工数なし。1 人だけ退職後に工数が付いている）・入社・異動・昇格
 *   - 長い顧客名・案件名・作業名・氏名、同姓同名、名称の表記ゆれ
 *   - 組織変更（課の廃止で配下チームの付け替え、チーム名の変更、新設チーム、5 段目の「班」、リーダー交代）
 *   - アサインの頻繁な変更（契約ごとに 1〜3 区間、期中に配分が変わる）。人×月の配分合計は 1.0 以下（0.05 刻み）
 */
import type { Worklog, YearMonth } from "../src/core/types.js";
import { addMonths, DIVISION_NAME, FyCalendar, monthCount, Rng, splitHours, ymOf } from "./lib/dummy-util.js";
import type { AssignmentRow, ContractRow, MappingRow, MemberRow, OutsidePlanRow, RateRow, TeamRow } from "./generate-dummy.js";

export interface ScaleInput {
  seed: number;
  asOf: string;
  /** 基準日の年度からの相対の年月（基本シナリオと同じもの） */
  cal: FyCalendar;
  /** 営業日（基本シナリオと同じ） */
  days: readonly string[];
  /** 基本シナリオの単価（役職の単価は共通で使う） */
  baseRates: readonly RateRow[];
}

export interface ScaleOutput {
  teams: TeamRow[];
  members: MemberRow[];
  rates: RateRow[];
  contracts: ContractRow[];
  mappings: MappingRow[];
  assignments: AssignmentRow[];
  outsidePlans: OutsidePlanRow[];
  taskTypes: Array<{ task: string; category: string; group?: string; note: string }>;
  worklogs: Worklog[];
}

// ---------------------------------------------------------------------------
// 組織
// ---------------------------------------------------------------------------

interface TeamDef {
  id: string;
  name: string;
  parent: string;
  level: string;
  /** 新設チーム: 基準日の年度の何月にできたか（それより前の月の組織には無い） */
  openedInMonth?: number;
}

/** generateScale の中で使う形（新設月を年月にしたもの） */
interface LeafTeam extends TeamDef {
  from?: YearMonth;
}

const DIVISIONS: TeamDef[] = [
  { id: "D3", name: "公共・社会インフラ事業部", parent: "HQ", level: "事業部" },
  { id: "D4", name: "金融ソリューション事業部", parent: "HQ", level: "事業部" },
  { id: "D5", name: "流通・サービス事業部", parent: "HQ", level: "事業部" },
  { id: "D6", name: "グローバルデリバリーセンター", parent: "HQ", level: "センター" },
];

const SECTIONS: TeamDef[] = [
  { id: "S31", name: "自治体システム課", parent: "D3", level: "課" },
  { id: "S32", name: "社会インフラ課", parent: "D3", level: "課" },
  { id: "S33", name: "公共クラウド推進課", parent: "D3", level: "課" },
  { id: "S41", name: "銀行システム課", parent: "D4", level: "課" },
  { id: "S42", name: "保険・証券システム課", parent: "D4", level: "課" },
  { id: "S43", name: "リース・クレジット課", parent: "D4", level: "課" },
  { id: "S51", name: "流通システム課", parent: "D5", level: "課" },
  { id: "S52", name: "サービス業システム課", parent: "D5", level: "課" },
  { id: "S53", name: "外食・小売システム課", parent: "D5", level: "課" },
  { id: "S61", name: "ニアショア開発課", parent: "D6", level: "課" },
  { id: "S62", name: "運用監視センター", parent: "D6", level: "グループ" },
  { id: "S63", name: "品質保証課", parent: "D6", level: "課" },
];

/** 末端の組織（メンバーが所属し、契約を持つ） */
const LEAF_TEAMS: TeamDef[] = [
  { id: "T311", name: "住民情報システム運用保守チーム", parent: "S31", level: "チーム" },
  { id: "T312", name: "税・財務システム保守チーム", parent: "S31", level: "チーム" },
  { id: "T313", name: "防災・地域情報基盤チーム", parent: "S31", level: "チーム" },
  { id: "T321", name: "交通系システム保守チーム", parent: "S32", level: "チーム" },
  { id: "T322", name: "電力・ガス設備監視運用チーム", parent: "S32", level: "チーム" },
  { id: "T331", name: "ガバメントクラウド移行支援チーム", parent: "S33", level: "チーム" },
  { id: "T332", name: "公共クラウド運用チーム", parent: "S33", level: "チーム" },
  // T411 は配下に班を持つ（組織の 5 段目）。メンバーは班に所属する
  { id: "T4111", name: "ATM・窓口端末班", parent: "T411", level: "班" },
  { id: "T4112", name: "インターネットバンキング・スマホアプリ班", parent: "T411", level: "班" },
  { id: "T412", name: "融資・外為システム保守チーム", parent: "S41", level: "チーム" },
  { id: "T421", name: "保険システム保守チーム", parent: "S42", level: "チーム" },
  { id: "T422", name: "証券バックオフィス運用チーム", parent: "S42", level: "チーム" },
  { id: "T423", name: "決済・カード系システム保守チーム", parent: "S42", level: "チーム" },
  { id: "T431", name: "リース契約管理システム保守チーム", parent: "S43", level: "チーム" },
  { id: "T432", name: "与信・債権管理システム保守チーム", parent: "S43", level: "チーム" },
  { id: "T511", name: "店舗・POSシステム保守チーム", parent: "S51", level: "チーム" },
  { id: "T512", name: "物流・倉庫管理システム保守チーム", parent: "S51", level: "チーム" },
  { id: "T513", name: "EC・オムニチャネル運用チーム", parent: "S51", level: "チーム" },
  { id: "T521", name: "ホテル・旅行予約システム保守チーム", parent: "S52", level: "チーム" },
  { id: "T522", name: "医療・介護システム保守チーム", parent: "S52", level: "チーム" },
  { id: "T523", name: "教育機関向けシステム保守チーム（大学・専門学校・学習塾）", parent: "S52", level: "チーム" },
  { id: "T531", name: "外食チェーン店舗システム保守チーム", parent: "S53", level: "チーム" },
  { id: "T532", name: "ドラッグストア・小売基幹保守チーム", parent: "S53", level: "チーム" },
  { id: "T611", name: "札幌ニアショア保守チーム", parent: "S61", level: "チーム" },
  { id: "T612", name: "福岡ニアショア保守チーム", parent: "S61", level: "チーム" },
  { id: "T621", name: "24時間365日運用監視チーム（一次受付・エスカレーション）", parent: "S62", level: "チーム" },
  { id: "T622", name: "ジョブ運用・バッチ監視チーム", parent: "S62", level: "チーム" },
  { id: "T631", name: "品質保証・テスト自動化チーム", parent: "S63", level: "チーム" },
  // 今年度 7 月に新設
  { id: "T623", name: "生成AI活用推進チーム", parent: "S62", level: "チーム", openedInMonth: 7 },
];

/** 班の親（それ自体はメンバーを持たない中間のチーム） */
const MID_TEAMS: TeamDef[] = [{ id: "T411", name: "勘定系周辺・チャネル系保守チーム", parent: "S41", level: "チーム" }];

// ---------------------------------------------------------------------------
// 名前
// ---------------------------------------------------------------------------

const FAMILY = ["佐藤", "鈴木", "高橋", "田中", "伊藤", "渡辺", "山本", "中村", "小林", "加藤", "吉田", "山田", "佐々木", "山口", "松本", "井上", "木村", "林", "斎藤", "清水", "山崎", "森", "池田", "橋本", "阿部", "石川", "山下", "中島", "石井", "小川", "前田", "岡田", "長谷川", "藤田", "後藤", "近藤", "村上", "遠藤", "青木", "坂本", "福田", "西村", "太田", "三浦", "藤原", "岡本", "松田", "中川", "原田", "小野"];
const GIVEN = ["翔太", "陽菜", "蓮", "結衣", "大翔", "美咲", "悠真", "葵", "湊", "凛", "樹", "さくら", "颯太", "紬", "陸", "芽依", "健太", "彩花", "拓海", "七海", "直樹", "真央", "亮", "千尋", "誠", "優奈", "隼人", "楓", "智也", "莉子"];

/** 手で置く特殊な名前（長い氏名・外国籍・同姓同名） */
const SPECIAL_NAMES = [
  "勅使河原 晃一郎",
  "アレクサンダー・ウィリアムズ・ジョナサン",
  "グエン・ヴァン・ミン・トゥアン",
  "長谷川 紗耶香ベアトリーチェ",
  "佐藤 健一", // 基本シナリオの M001 と同姓同名（別人）
  "王 偉",
  "マリア・フェルナンダ・ロドリゲス・ゴンザレス",
];

// ---------------------------------------------------------------------------
// 顧客・案件
// ---------------------------------------------------------------------------

interface Account {
  /** mapping.csv に書く顧客名（正規化後に一致すればよい） */
  customer: string;
  /** 工数側の顧客名の表記ゆれ */
  customerVariants: string[];
  project: string;
  projectVariants: string[];
  team: string;
}

/** 法人格を付けない顧客（独立行政法人・自治体など）。工数側でも同じ名前で出る（空白の揺れだけ） */
const PUBLIC_CUSTOMERS = new Set(["独立行政法人 国際交流・地域連携推進機構", "北湊市", "南ヶ丘県", "学校法人 白鷺学院", "医療法人社団 青葉会", "社会福祉法人 ひだまり福祉会", "国立大学法人 東都科学技術大学"]);

/** チームごとの顧客・案件（名前だけ。契約の形は後で乱数で決める） */
const ACCOUNTS: Array<[team: string, customer: string, project: string]> = [
  ["T311", "北湊市", "住民記録・印鑑登録システム運用保守"],
  ["T312", "北湊市", "市税（個人住民税・固定資産税）賦課徴収システム保守および制度改正対応"],
  ["T312", "西浜町", "財務会計システム保守"],
  ["T313", "南ヶ丘県", "防災情報システム運用"],
  ["T313", "独立行政法人 国際交流・地域連携推進機構", "地域連携ポータルサイトおよび会員管理システムの運用保守・アクセシビリティ改善対応業務"],
  ["T321", "東都高速鉄道", "運行管理システム保守"],
  ["T321", "みらいバス", "ICカード乗車券システム保守"],
  ["T322", "北日本エネルギー", "変電設備遠隔監視システム運用"],
  ["T331", "南ヶ丘県", "ガバメントクラウド移行支援"],
  ["T332", "北湊市", "公共クラウド基盤運用"],
  ["T332", "西浜町", "庁内仮想デスクトップ基盤運用"],
  ["T4111", "しおさい銀行", "ATM・窓口端末保守"],
  ["T4112", "しおさい銀行", "インターネットバンキング・スマートフォンアプリ運用保守（不正送金対策の継続的な機能改善を含む）"],
  ["T4112", "あおぞら信用組合", "ネットバンキング保守"],
  ["T412", "しおさい銀行", "国際送金・外為基幹システム運用保守（24時間監視・災害対策サイト運用を含む）"],
  ["T412", "やまなみ信用金庫", "融資稟議システム保守"],
  ["T421", "ひかり生命保険", "保険契約管理システム保守"],
  ["T421", "さざなみ損害保険", "保険金支払査定システム保守"],
  ["T422", "ときわ証券", "証券バックオフィス運用"],
  ["T423", "グローバル・ペイメント・ソリューションズ・ホールディングス", "クレジットカード決済ゲートウェイ保守"],
  ["T423", "かもめカード", "加盟店管理システム保守"],
  ["T431", "あさひリース", "リース契約管理システム保守"],
  ["T432", "かもめカード", "与信・債権管理システム保守"],
  ["T432", "あさひリース", "督促管理システム保守"],
  ["T511", "まるやまスーパー", "店舗POSシステム保守"],
  ["T512", "東西ロジスティクス", "倉庫管理システム（WMS）保守"],
  ["T512", "青葉物流", "輸配送管理システム保守"], // 基本シナリオと同じ顧客の別案件
  ["T513", "ファッションモールジャパン", "ECサイト・会員アプリ運用保守"],
  ["T513", "まるやまスーパー", "ネットスーパー運用"],
  ["T521", "ひなたホテルズ", "ホテル予約・客室管理システム保守"],
  ["T522", "医療法人社団 青葉会", "電子カルテシステム保守"],
  ["T522", "社会福祉法人 ひだまり福祉会", "介護記録・請求システム保守"],
  ["T523", "学校法人 白鷺学院", "学務・成績管理システム保守"],
  ["T523", "国立大学法人 東都科学技術大学", "学修支援システム（LMS）および教務・学籍・履修登録システム運用保守ならびにシングルサインオン連携基盤の維持管理業務"],
  ["T531", "くいしんぼうフーズ", "店舗オーダー端末保守"],
  ["T532", "けんこう薬局チェーン", "調剤・在庫管理システム保守"],
  ["T532", "ハートフルマート", "基幹（発注・在庫）システム保守"],
  ["T611", "ほっかいフーズ", "販売管理システム保守"],
  ["T612", "九州みらい銀行", "勘定系周辺システム保守"],
  ["T612", "はかた電機", "生産管理システム保守"],
  ["T621", "ファッションモールジャパン", "24時間運用監視"],
  ["T621", "東都高速鉄道", "システム運用監視（一次受付）"],
  ["T622", "ときわ証券", "夜間バッチ運用監視"],
  ["T623", "まるやまスーパー", "需要予測AIモデル運用"],
  ["T631", "グローバル・ペイメント・ソリューションズ・ホールディングス", "決済システム回帰テスト自動化保守"],
  ["T631", "せかい旅行", "テスト自動化基盤保守"],
];

/** 工数側の顧客名の表記ゆれ（正規化で mapping の名前に一致する範囲） */
function customerVariants(name: string): string[] {
  if (PUBLIC_CUSTOMERS.has(name)) return [name, name.replace(" ", "　"), `${name} `];
  return [`株式会社${name}`, `${name}株式会社`, name, `（株）${name}`, `${name}　株式会社`];
}

/** 全角英数字にする（ＡＴＭ など。正規化で半角に戻る） */
function toFullWidth(s: string): string {
  return s.replace(/[A-Za-z0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
}

function projectVariants(name: string): string[] {
  const out = [name, `${name} `];
  if (/[A-Za-z0-9]/.test(name)) out.push(toFullWidth(name));
  return out;
}

// ---------------------------------------------------------------------------
// 作業種別（実運用の長い名前を含む）
// ---------------------------------------------------------------------------

const TASKS_IN: ReadonlyArray<readonly [string, number]> = [
  ["定例", 3],
  ["問い合わせ対応", 5],
  ["障害対応", 2],
  ["調査", 3],
  ["監視・運用", 4],
  ["リリース作業", 1],
  ["定期メンテナンス作業（月次パッチ適用およびセキュリティ脆弱性対応の事前検証を含む）", 2],
  ["障害一次切り分け・ベンダーエスカレーション対応（夜間・休日待機を含む）", 1],
  ["運用手順書・設計書の改訂（変更管理委員会への提出資料作成を含む）", 1],
  ["改修", 2],
  ["テスト", 2],
];

const TASKS_OUT: ReadonlyArray<readonly [string, number]> = [
  ["次期システム更改に向けた現行調査および提案資料作成", 2],
  ["要件定義支援（新規案件）", 1],
  ["提案", 2],
  ["見積", 1],
];

const TASK_TYPES = [
  { task: "定期メンテナンス作業（月次パッチ適用およびセキュリティ脆弱性対応の事前検証を含む）", category: "契約内", note: "" },
  { task: "障害一次切り分け・ベンダーエスカレーション対応（夜間・休日待機を含む）", category: "契約内", note: "" },
  { task: "運用手順書・設計書の改訂（変更管理委員会への提出資料作成を含む）", category: "契約内", note: "" },
  { task: "次期システム更改に向けた現行調査および提案資料作成", category: "契約外", group: "提案", note: "更改提案（保守契約の範囲外）" },
  { task: "要件定義支援（新規案件）", category: "契約外", group: "設計", note: "新規案件の上流支援" },
  { task: "引き継ぎ", category: "契約内", note: "退職・異動に伴う引き継ぎ" },
];

/** 役職の単価（基本シナリオの役職に足す） */
const extraRatesOf = (c: FyCalendar): RateRow[] => [
  { key: "シニアエンジニア", hourly_rate: 9500, effective_from: c.m(-1, 4) },
  { key: "シニアエンジニア", hourly_rate: 9800, effective_from: c.m(0, 4) },
  { key: "担当課長", hourly_rate: 10500, effective_from: c.m(-1, 4) },
  // 「専門職」は単価の行を置かない（RATE_MISSING の 2 例目）
];

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

interface Person {
  id: string;
  name: string;
  kind: "employee" | "partner";
  /** 履歴（effective_from 昇順）。status=退職 の行から先は在籍しない */
  rows: MemberRow[];
}

const DEPT_OF: Record<string, string> = Object.fromEntries(DIVISIONS.map((d) => [d.id, d.name]));
const SECTION_OF: Record<string, TeamDef> = Object.fromEntries(SECTIONS.map((s) => [s.id, s]));
const TEAM_PARENT: Record<string, string> = Object.fromEntries([...DIVISIONS, ...SECTIONS, ...LEAF_TEAMS, ...MID_TEAMS].map((t) => [t.id, t.parent]));

/** 末端組織 → 課（班は親チームの課） */
function sectionOf(teamId: string): string {
  let t = teamId;
  while (t && !SECTION_OF[t]) t = TEAM_PARENT[t] ?? "";
  return t;
}

function deptRow(teamId: string): { department: string; section: string } {
  const s = sectionOf(teamId);
  const sec = SECTION_OF[s];
  if (!sec) return { department: DEPT_OF[teamId] ?? "", section: "" };
  return { department: DEPT_OF[sec.parent] ?? "", section: sec.name };
}

export function generateScale(input: ScaleInput): ScaleOutput {
  const rng = new Rng(input.seed * 31 + 1009);
  const c = input.cal;
  const asOfMonth = ymOf(input.asOf);
  const FIRST: YearMonth = c.m(-1, 4);
  const leafTeams: LeafTeam[] = LEAF_TEAMS.map((t) => (t.openedInMonth ? { ...t, from: c.m(0, t.openedInMonth) } : t));

  // ---- 組織 ----
  const teams: TeamRow[] = [];
  const leaders: Record<string, string> = {};
  const addTeam = (t: LeafTeam, from: YearMonth = t.from ?? FIRST, overrides: Partial<TeamRow> = {}) =>
    teams.push({ team_id: t.id, name: t.name, parent_team_id: t.parent, effective_from: from, level: t.level, leader_member_id: leaders[t.id] ?? "", ...overrides });

  // ---- メンバー ----
  const people: Person[] = [];
  let seq = 101;
  let pseq = 101;
  let specialIdx = 0;
  const usedNames = new Set<string>();
  const newName = (): string => {
    if (specialIdx < SPECIAL_NAMES.length && rng.chance(0.08)) return SPECIAL_NAMES[specialIdx++] as string;
    for (;;) {
      const n = `${rng.pick(FAMILY)} ${rng.pick(GIVEN)}`;
      if (!usedNames.has(n)) {
        usedNames.add(n);
        return n;
      }
    }
  };
  const hire = (teamId: string, title: string, kind: "employee" | "partner" = "employee", from: YearMonth = FIRST): Person => {
    const id = kind === "partner" ? `P${pseq++}` : `M${seq++}`;
    const name = newName();
    const d = deptRow(teamId);
    const p: Person = { id, name, kind, rows: [{ member_id: id, name, kind, title, division: DIVISION_NAME, department: d.department, section: d.section, team_id: teamId, effective_from: from, status: "" }] };
    people.push(p);
    return p;
  };

  // 部長（工数なし）・課長（課に所属）
  for (const d of DIVISIONS) leaders[d.id] = hire(d.id, "部長").id;
  for (const s of SECTIONS) leaders[s.id] = hire(s.id, rng.chance(0.25) ? "担当課長" : "課長").id;
  // チーム: 主任 1 人 ＋ 一般 2〜4 人 ＋ パートナー 0〜2 人。T623（新設）は今年度 7 月から
  for (const t of leafTeams) {
    const from = t.from ?? FIRST;
    const chief = hire(t.id, rng.chance(0.3) ? "シニアエンジニア" : "主任", "employee", from);
    leaders[t.id] = chief.id;
    const n = t.from ? 2 : rng.int(1, 3);
    for (let i = 0; i < n; i++) hire(t.id, "一般", "employee", from);
    const np = t.from ? 0 : rng.weighted([[0, 5], [1, 3], [2, 1]] as const);
    for (let i = 0; i < np; i++) hire(t.id, "パートナー", "partner", from);
  }
  leaders["T411"] = leaders["T4111"] ?? "";
  // 専門職（単価なし）を 1 人
  const specialist = people.find((p) => p.rows[0]!.team_id === "T631" && p.rows[0]!.title === "一般");
  if (specialist) specialist.rows[0]!.title = "専門職";

  const workers = () => people.filter((p) => !["部長"].includes(p.rows[0]!.title) && leafTeams.some((t) => t.id === p.rows[0]!.team_id));
  const lastRow = (p: Person) => p.rows[p.rows.length - 1] as MemberRow;
  const addRow = (p: Person, month: YearMonth, patch: Partial<MemberRow>) => {
    const prev = lastRow(p);
    const next = { ...prev, ...patch, effective_from: month };
    if (patch.team_id) Object.assign(next, deptRow(patch.team_id));
    p.rows.push(next);
  };

  // 期中入社（前年度 7 月〜今年度 10 月）: 新しく 10 人
  const hireMonths: YearMonth[] = [c.m(-1, 7), c.m(-1, 10), c.m(-1, 1), c.m(0, 4), c.m(0, 4), c.m(0, 4), c.m(0, 7), c.m(0, 8), c.m(0, 10), c.m(0, 10)];
  for (const m of hireMonths) {
    if (m > asOfMonth) continue;
    const t = rng.pick(leafTeams.filter((x) => !x.from || x.from <= m));
    hire(t.id, "一般", rng.chance(0.25) ? "partner" : "employee", m);
  }
  // 昇格（一般 → 主任）6 人、異動 8 人、退職 12 人（重ならないように別々の人を選ぶ）
  const pool = workers().filter((p) => p.rows[0]!.effective_from === FIRST && p.rows[0]!.title === "一般" && p.kind === "employee");
  const take = (n: number) => {
    const out: Person[] = [];
    while (out.length < n && pool.length > 0) out.push(pool.splice(rng.int(0, pool.length - 1), 1)[0] as Person);
    return out;
  };
  for (const p of take(6)) addRow(p, rng.pick([c.m(-1, 10), c.m(0, 4), c.m(0, 4), c.m(0, 7)] as YearMonth[]), { title: "主任" });
  for (const p of take(8)) {
    const to = rng.pick(leafTeams.filter((t) => !t.from && t.id !== p.rows[0]!.team_id));
    addRow(p, rng.pick([c.m(-1, 10), c.m(-1, 1), c.m(0, 4), c.m(0, 7), c.m(0, 10)] as YearMonth[]), { team_id: to.id });
  }
  const retireMonths: YearMonth[] = [c.m(-1, 7), c.m(-1, 9), c.m(-1, 12), c.m(-1, 1), c.m(-1, 3), c.m(0, 4), c.m(0, 4), c.m(0, 6), c.m(0, 7), c.m(0, 9), c.m(0, 10), c.m(0, 10)];
  const retirees = take(retireMonths.length);
  retirees.forEach((p, i) => addRow(p, retireMonths[i] as YearMonth, { status: "退職" }));
  // パートナーの契約終了（退職と同じ扱い）2 人
  for (const p of workers().filter((x) => x.kind === "partner" && x.rows.length === 1).slice(0, 2)) addRow(p, c.m(0, 4), { status: "退職" });
  // 退職した人を戻すことはしない。退職の翌月に精算の工数が 1 件だけ付いている人（データの誤り）を 1 人作る
  const lateLogger = retirees.find((p) => lastRow(p).effective_from <= c.m(0, 7));

  // 組織の履歴: 課の廃止（S33 → 配下を S32 へ 今年度 4 月）、チーム名の変更（T421 前年度 10 月）、リーダー交代（T312 今年度 4 月）
  for (const d of DIVISIONS) addTeam(d);
  for (const s of SECTIONS) addTeam(s);
  for (const t of MID_TEAMS) addTeam(t);
  for (const t of leafTeams) addTeam(t);
  for (const id of ["T331", "T332"]) {
    const t = leafTeams.find((x) => x.id === id) as LeafTeam;
    addTeam(t, c.m(0, 4), { parent_team_id: "S32" });
  }
  addTeam(leafTeams.find((x) => x.id === "T421") as LeafTeam, c.m(-1, 10), { name: "保険基幹システム保守チーム（生保・損保）" });
  const t312 = people.filter((p) => p.rows[0]!.team_id === "T312" && p.rows[0]!.title === "一般" && p.rows.length === 1)[0];
  if (t312) addTeam(leafTeams.find((x) => x.id === "T312") as LeafTeam, c.m(0, 4), { leader_member_id: t312.id });
  // S33 のメンバー（課長）は今年度 4 月から S32 の担当課長に
  const s33lead = people.find((p) => p.id === leaders["S33"]);
  if (s33lead) addRow(s33lead, c.m(0, 4), { team_id: "S32", title: "担当課長" });

  // ---- 単価 ----
  const rates: RateRow[] = extraRatesOf(c);
  for (const p of people.filter((x) => x.kind === "partner")) {
    const r = Math.round(rng.int(60, 95) * 100);
    rates.push({ key: p.id, hourly_rate: r, effective_from: p.rows[0]!.effective_from });
    if (rng.chance(0.25)) rates.push({ key: p.id, hourly_rate: r + 500, effective_from: c.m(0, 4) });
  }
  // パートナー 1 人だけ個人単価が無い（パートナーの役職単価も無いので RATE_MISSING）
  const noRate = people.filter((x) => x.kind === "partner" && x.rows.length === 1 && x.rows[0]!.effective_from === FIRST).at(-1);
  if (noRate) for (let i = rates.length - 1; i >= 0; i--) if (rates[i]!.key === noRate.id) rates.splice(i, 1);
  const allRates = [...input.baseRates, ...rates];
  const rateIndex = new Map<string, RateRow[]>();
  for (const r of allRates) {
    const list = rateIndex.get(r.key) ?? [];
    list.push(r);
    rateIndex.set(r.key, list);
  }
  const rateAt = (key: string, m: YearMonth): number => {
    let best: RateRow | undefined;
    for (const r of rateIndex.get(key) ?? []) if (r.effective_from <= m && (!best || r.effective_from >= best.effective_from)) best = r;
    return best?.hourly_rate ?? 0;
  };
  const rowAt = (p: Person, m: YearMonth): MemberRow | undefined => {
    let best: MemberRow | undefined;
    for (const r of p.rows) if (r.effective_from <= m) best = r;
    return best;
  };
  const costRate = (p: Person, m: YearMonth) => rateAt(p.id, m) || rateAt(rowAt(p, m)?.title ?? "", m);

  // ---- 契約（形だけ先に決め、金額は工数を作ってから決める） ----
  interface Draft extends ContractRow {
    account: Account;
    /** 着地の消化率の目標（1 超 = 超過） */
    ratio: number;
    /** 工数を付ける重み */
    weight: number;
  }
  const drafts: Draft[] = [];
  const accounts: Account[] = ACCOUNTS.map(([team, customer, project]) => ({ team, customer, project, customerVariants: customerVariants(customer), projectVariants: projectVariants(project) }));
  let cseq = 101;
  const ratioPick = (): number => {
    const r = rng.float();
    if (r < 0.05) return 0.3 + rng.float() * 0.3; // 大幅な余り
    if (r < 0.6) return 0.72 + rng.float() * 0.26; // 範囲内
    if (r < 0.88) return 1.02 + rng.float() * 0.38; // 超過
    return 1.45 + rng.float() * 1.05; // 大幅超過（炎上）
  };
  const newContract = (a: Account, from: YearMonth, to: YearMonth, note: string, teamId: string = a.team): Draft => {
    const d: Draft = { contract_id: `C${cseq++}`, customer_name: a.customer, project_name: a.project, team_id: teamId, start_month: from, end_month: to, total_amount: 0, note, account: a, ratio: ratioPick(), weight: 0.6 + rng.float() * 2.4 };
    drafts.push(d);
    return d;
  };
  const teamFrom = (id: string) => leafTeams.find((t) => t.id === id)?.from ?? FIRST;
  for (const a of accounts) {
    const f = teamFrom(a.team);
    if (f > FIRST) {
      newContract(a, f, addMonths(f, 11), "新設チームの新規受注");
      continue;
    }
    const r = rng.float();
    if (r < 0.55) {
      newContract(a, c.m(-1, 4), c.m(-1, 3), c.label(-1));
      newContract(a, c.m(0, 4), c.m(0, 3), `${c.label()} 更新`);
    } else if (r < 0.68) {
      newContract(a, c.m(-1, 4), c.m(-1, 3), `${c.label(-1)} で終了（更新なし）`);
    } else if (r < 0.75) {
      newContract(a, c.m(-1, 4), c.m(-1, 12), `途中解約（${c.m(-1, 12)} で終了）`);
    } else if (r < 0.82) {
      newContract(a, c.m(-1, 4), c.m(-1, 3), c.label(-1));
      newContract(a, c.m(0, 4), c.m(0, 6), `${c.label()}（${c.m(0, 6)} で変更契約へ）`);
      newContract(a, c.m(0, 7), c.m(0, 3), `変更契約（${c.m(0, 7)}〜 体制増強で増額）`);
    } else if (r < 0.88) {
      newContract(a, c.m(0, 4), c.m(0, 3), `${c.label()} 新規`);
    } else if (r < 0.93) {
      newContract(a, c.m(-2, 4), c.m(0, 3), `3 年契約（${c.m(-2, 4)}〜。${c.m(-2, 3)} 以前の実績データは無い）`);
    } else if (r < 0.97) {
      newContract(a, c.m(-1, 4), c.m(-1, 3), c.label(-1));
      newContract(a, c.m(0, 4), c.m(0, 6), `${c.label()}（${c.m(0, 6)} で解約）`);
    } else {
      newContract(a, c.m(-1, 10), c.m(0, 9), "期中開始（10月〜9月）");
      newContract(a, c.m(0, 10), c.m(1, 9), "期中開始の更新");
    }
  }
  // 将来開始（工数なし）、主担当チーム未設定、超大型・超少額
  newContract(accounts.find((a) => a.team === "T513")!, c.m(0, 12), c.m(1, 11), `将来開始（${c.m(0, 12)}〜）`);
  newContract(accounts.find((a) => a.team === "T321")!, c.m(1, 4), c.m(1, 3), "将来開始（次年度）");
  const noTeam = newContract({ team: "", customer: "ひかり生命保険", project: "保険代理店ポータル保守", customerVariants: customerVariants("ひかり生命保険"), projectVariants: projectVariants("保険代理店ポータル保守") }, c.m(0, 4), c.m(0, 3), "主担当チーム未設定", "");
  const tiny = newContract({ team: "T523", customer: "学校法人 白鷺学院", project: "同窓会名簿サイト保守", customerVariants: customerVariants("学校法人 白鷺学院"), projectVariants: projectVariants("同窓会名簿サイト保守") }, c.m(0, 4), c.m(0, 3), "少額（年 5 万円）");
  const huge = drafts.find((d) => d.project_name.startsWith("国際送金") && d.start_month >= c.m(0, 4)) ?? drafts.find((d) => d.project_name.startsWith("国際送金"));

  // 契約の工数側の名前: 同じ顧客・案件名の契約は期間で振り分く（mapping は契約ごとに 1 行）
  const mappings: MappingRow[] = drafts.map((d) => ({ worklog_customer_name: d.customer_name, worklog_project_name: d.project_name, contract_id: d.contract_id }));

  // ---- 作業実績 ----
  const worklogs: Worklog[] = [];
  const costBy = new Map<string, number>();
  const active = (m: YearMonth) => drafts.filter((d) => d.start_month <= m && m <= d.end_month && d !== tiny && d !== noTeam);
  const contractsOfTeam = (teamId: string, m: YearMonth) => active(m).filter((d) => d.team_id === teamId);
  const contractsOfSection = (sectionId: string, m: YearMonth) => active(m).filter((d) => d.team_id !== "" && sectionOf(d.team_id) === sectionId);
  const divisionOf = (teamId: string) => SECTION_OF[sectionOf(teamId)]?.parent ?? "";
  const pushLog = (p: Person, date: string, d: Draft | null, task: string, hours: number, names?: { customer: string; project: string }) => {
    const m = ymOf(date);
    const nm = names ?? { customer: rng.pick(d!.account.customerVariants), project: rng.pick(d!.account.projectVariants) };
    worklogs.push({ date, memberId: p.id, memberName: rowAt(p, m)?.name ?? p.name, customerName: nm.customer, projectName: nm.project, task, hours });
    if (d && TASKS_IN.some(([t]) => t === task)) costBy.set(d.contract_id, (costBy.get(d.contract_id) ?? 0) + hours * costRate(p, m));
  };

  for (const date of input.days) {
    const m = ymOf(date);
    for (const p of people) {
      const row = rowAt(p, m);
      if (!row || row.status === "退職" || row.title === "部長") continue;
      if (rng.chance(0.045)) continue; // 休暇
      const isSectionLead = !!SECTION_OF[row.team_id];
      let own = isSectionLead ? contractsOfSection(row.team_id, m) : contractsOfTeam(row.team_id, m);
      // チームの契約が全部終わった月は、同じ事業部の他チームの契約を手伝う
      if (own.length === 0) own = active(m).filter((x) => x.team_id !== "" && divisionOf(x.team_id) === divisionOf(row.team_id));
      if (own.length === 0) continue;
      if (rng.chance(0.01)) pushLog(p, date, null, "勉強会", 2, { customer: "社内", project: "技術ナレッジ共有会" });
      const total = isSectionLead ? rng.weighted([[2, 2], [3, 3], [4, 2]] as const) : rng.weighted([[6, 1], [6.5, 2], [7, 3], [7.5, 2], [8, 2], [9, 1], [10, 0.5]] as const);
      const slots = splitHours(rng, total, isSectionLead ? rng.int(1, 2) : rng.int(1, 3));
      for (const h of slots) {
        let d: Draft | undefined;
        if (!isSectionLead && rng.chance(0.08)) {
          const div = divisionOf(row.team_id);
          const others = active(m).filter((x) => x.team_id !== row.team_id && x.team_id !== "" && divisionOf(x.team_id) === div);
          if (others.length > 0) d = rng.weighted(others.map((x) => [x, x.weight] as const));
        }
        d ??= rng.weighted(own.map((x) => [x, x.weight] as const));
        // 契約外（提案・要件定義支援など）は 4%。保守の工数とは別に、同じ顧客で付く
        if (rng.chance(0.04)) pushLog(p, date, d, rng.weighted(TASKS_OUT), h);
        else pushLog(p, date, d, rng.weighted(TASKS_IN), h);
      }
      if (rng.chance(0.04)) pushLog(p, date, null, "社内会議", rng.pick([0.5, 1]), { customer: "", project: "" });
      // 主担当チーム未設定の契約は T421 の人が少しずつ、少額契約は T523 の人がたまに 0.25h
      if (row.team_id === "T421" && m >= noTeam.start_month && rng.chance(0.12)) pushLog(p, date, noTeam, "問い合わせ対応", rng.pick([0.5, 1, 1.5]));
      if (row.team_id === "T523" && m >= tiny.start_month && rng.chance(0.03)) pushLog(p, date, tiny, "問い合わせ対応", 0.25);
    }
  }
  // 退職の翌月に 1 件だけ付いた工数（データの誤り。WORKLOG_AFTER_LEFT の例）
  if (lateLogger) {
    const leftAt = lastRow(lateLogger).effective_from;
    const date = input.days.find((x) => ymOf(x) === leftAt);
    const d = drafts.find((x) => x.team_id === lateLogger.rows[0]!.team_id && x.start_month <= leftAt && leftAt <= x.end_month) ?? drafts.find((x) => x.start_month <= leftAt && leftAt <= x.end_month);
    if (date && d) pushLog(lateLogger, date, d, "引き継ぎ", 1.5);
  }

  // ---- 金額: 着地見込み（実績の月平均 × 契約月数）÷ 目標の消化率。1 万円単位 ----
  for (const d of drafts) {
    const months = monthCount(d.start_month, d.end_month);
    const elapsedFrom = d.start_month < FIRST ? FIRST : d.start_month;
    const elapsedTo = d.end_month < asOfMonth ? d.end_month : asOfMonth;
    const elapsed = elapsedTo >= elapsedFrom ? monthCount(elapsedFrom, elapsedTo) : 0;
    const cost = costBy.get(d.contract_id) ?? 0;
    let amount = elapsed > 0 && cost > 0 ? (cost / elapsed) * months / d.ratio : (rng.int(3, 40) * 1_000_000);
    if (d === huge) amount = 1_250_000_000;
    if (d === tiny) amount = 50_000;
    // 12 で割り切れない金額も混ぜる（端数は最終月）
    d.total_amount = Math.max(10_000, Math.round(amount / 10_000) * 10_000 + (rng.chance(0.15) ? rng.int(1, 9999) : 0));
  }

  // ---- アサイン（今年度）: 1 人あたり 1〜3 区間。期中に配分を変える。月の合計は 1.0 以下（超えると検証エラー） ----
  const assignments: AssignmentRow[] = [];
  /** 人 → 月 → 配分の合計（契約外予定を足す人を選ぶ） */
  const peakOf = new Map<string, Map<YearMonth, number>>();
  const forgotten = retirees.find((p) => lastRow(p).effective_from === c.m(0, 10));
  const fyFrom: YearMonth = c.m(0, 4);
  const fyTo: YearMonth = c.m(0, 3);
  for (const p of people) {
    const start = p.rows[0]!.effective_from > fyFrom ? p.rows[0]!.effective_from : fyFrom;
    const leftRow = p.rows.find((r) => r.status === "退職");
    // 1 人だけ、退職後もアサインが残っている（終了月の直し忘れ。ASSIGNMENT_AFTER_LEFT の例）
    const end = leftRow && p !== forgotten ? addMonths(leftRow.effective_from, -1) : fyTo;
    if (end < start) continue;
    const row = rowAt(p, start) ?? p.rows[0]!;
    if (row.title === "部長") continue;
    const isSectionLead = !!SECTION_OF[row.team_id];
    const cs = (isSectionLead ? drafts.filter((d) => d.team_id !== "" && sectionOf(d.team_id) === row.team_id) : drafts.filter((d) => d.team_id === row.team_id)).filter((d) => d.end_month >= start && d.start_month <= end && d !== tiny);
    if (cs.length === 0) continue;
    const budget = isSectionLead ? 0.3 : 0.8 + rng.int(0, 2) / 10;
    const used = new Map<YearMonth, number>();
    const wsum = cs.reduce((s, d) => s + d.weight, 0);
    for (const d of cs) {
      const a0 = d.start_month > start ? d.start_month : start;
      const a1 = d.end_month < end ? d.end_month : end;
      if (a1 < a0) continue;
      const base = Math.max(0.05, Math.round((budget * d.weight) / wsum * 20) / 20);
      // 区間の分け方: 1 区間（そのまま）/ 2 区間（途中で増減）/ 3 区間
      const n = Math.min(monthCount(a0, a1), rng.weighted([[1, 3], [2, 4], [3, 2]] as const));
      let cur = a0;
      for (let i = 0; i < n; i++) {
        const left = monthCount(cur, a1);
        const len = i === n - 1 ? left : rng.int(1, Math.max(1, left - (n - 1 - i)));
        const to = addMonths(cur, len - 1);
        let alloc = Math.max(0.05, Math.min(1, Math.round((base + (i === 0 ? 0 : rng.pick([-0.1, -0.05, 0.05, 0.1]))) * 100) / 100));
        // 同じ月の合計が 1.0 を超えないように削る（0.05 刻み）
        let peak = 0;
        for (let k = 0; k < len; k++) peak = Math.max(peak, used.get(addMonths(cur, k)) ?? 0);
        alloc = Math.min(alloc, Math.floor((1 - peak) * 20 + 1e-9) / 20);
        if (alloc >= 0.05) {
          for (let k = 0; k < len; k++) used.set(addMonths(cur, k), (used.get(addMonths(cur, k)) ?? 0) + alloc);
          assignments.push({ member_id: p.id, contract_id: d.contract_id, start_month: cur, end_month: to, allocation: alloc });
        }
        cur = addMonths(to, 1);
      }
    }
    peakOf.set(p.id, used);
  }

  // ---- 契約外予定（§36.4）: 配分の多い人の一部に、提案・運用設計などの見込みを足す（合計が 1.0 を少し超える月が出る）。
  // 乱数は他のデータを作り終えてから引く（ほかの行は変わらない）
  const outsidePlans: OutsidePlanRow[] = [];
  const NOTES = ["次期更改の提案", "運用設計の支援", "新規顧客の提案", "移行計画の作成"];
  // メモ → 種別（§50.1。乱数は増やさない）
  const TYPE_OF: Record<string, string> = { 次期更改の提案: "提案", 運用設計の支援: "設計", 新規顧客の提案: "提案", 移行計画の作成: "設計" };
  for (const p of people) {
    const used = peakOf.get(p.id);
    if (!used || used.size === 0) continue;
    const busy = [...used.entries()].filter(([m, v]) => v >= 0.85 && m > asOfMonth).map(([m]) => m).sort();
    if (busy.length === 0 || !rng.chance(0.12)) continue;
    const from = busy[rng.int(0, Math.max(0, busy.length - 2))]!;
    const to = addMonths(from, rng.int(1, 3));
    const start_month = from;
    const end_month = to > fyTo ? fyTo : to;
    const person_months = rng.pick([0.1, 0.2, 0.3]);
    const note = rng.pick(NOTES);
    outsidePlans.push({ member_id: p.id, type: TYPE_OF[note] ?? "提案", start_month, end_month, person_months, note });
  }

  const members = people.flatMap((p) => p.rows);
  const contracts: ContractRow[] = drafts.map(({ account: _a, ratio: _r, weight: _w, ...c }) => c);
  return { teams, members, rates, contracts, mappings, assignments, outsidePlans, taskTypes: TASK_TYPES, worklogs };
}
