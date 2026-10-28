/*
 * ─────────────────────────────────────────────────────────────
 *  予実ナビ 画面の文言（日本語）
 * ─────────────────────────────────────────────────────────────
 *  画面に出る見出し・説明・ボタン名・警告・Excel の列名などはここにまとめています。
 *  文言を直すときは、このファイルの "…" の中だけを書き換えてください。
 *  （計算ルール画面の本文は同じフォルダの rules.txt にあります）
 *
 *  書き換えのルール
 *   - 左側の名前（例: title:）は変えない。プログラムがこの名前で文言を探します。
 *   - 文字は " と " の間に書く。行末の , は消さない。
 *   - {name} のような波かっこは、画面で実際の値（件数・月・名前など）に置き換わる差し込み口です。
 *     中の英字は変えずに、位置は自由に動かしてかまいません（使わないなら消してもかまいません）。
 *   - 文中に " を書きたいときは \" と書くか、「」を使ってください。
 *   - 詳しい手順は docs/TEXTS.md を見てください。
 */
export default {
  // ── アプリ全体（タブ・ページ名・フッター） ────────────────────
  app: {
    name: "予実ナビ",
    footer: "予実ナビ — 保守契約の予実（粗利）管理",
    tabsLabel: "画面",
    toolsLabel: "補助",
    // 上部タブ
    nav: {
      index: "全体",
      teams: "チーム",
      customers: "顧客",
      contracts: "契約",
      members: "メンバー",
      dataCheck: "データ確認",
      rules: "計算ルール",
      masters: "マスタ編集",
    },
    // ページ名（ブラウザのタブ・パンくずに出る名前）
    pages: {
      index: "全体サマリー",
      teams: "チーム一覧",
      customers: "顧客別",
      contracts: "契約一覧",
      members: "メンバー別",
      rules: "計算ルール",
      dataCheck: "データ確認",
      masters: "マスタ編集",
    },
  },

  // ── どの画面でも使う言葉 ──────────────────────────────────
  common: {
    all: "全体",
    none: "なし",
    loading: "読み込み中…",
    deficit: "赤字",
    surplus: "黒字",
  },

  // ── ページ上部（基準日・速報バッジ・エラー表示） ───────────────
  layout: {
    breadcrumbsLabel: "パンくず",
    metaLabel: "データの基準",
    asOf: "計算基準日",
    fiscalYear: "年度",
    fiscalYearValue: "{fy}（{from}〜{to}）",
    lastFinal: "確定済み",
    lastFinalValue: "{month} まで",
    fetchedAt: "作業実績の取得",
    notFetched: "未取得",
    prelimHidden: "速報",
    prelimBadge: "速報を含む",
    prelimBadgeTitle: "確定前の作業実績（速報）を含みます",
    finalBadge: "確定値のみ",
    finalBadgeTitle: "期間内の月はすべて確定しています",
    loadErrorTitle: "データを読み込めませんでした",
    loadErrorHelp: "ページを再読み込みしても直らない場合は、最新のビルド（CI）が成功しているか確認してください。",
    kpiRowLabel: "主要指標",
    kpiBreakdownAria: "{label} {value} の計算根拠を表示",
  },

  // ── 金額の単位・日付の書き方 ─────────────────────────────
  format: {
    units: { m: "百万円", k: "千円", yen: "円" },
    month: "{year}年{month}月",
    monthOnly: "{month}月",
    monthRangeSameYear: "{from}〜{toMonth}月",
    monthRange: "{from}〜{to}",
    varianceLess: "計画より原価が少ない",
    varianceMore: "計画より原価が多い",
    varianceEven: "計画どおり",
  },

  // ── 着地見込みの方式 ─────────────────────────────────────
  methods: {
    labels: {
      recent3: "直近実績",
      all: "全期間平均",
      assignment: "アサイン計画",
    },
    // {n} は直近何か月で平均するか（config.json の設定値）
    descriptions: {
      recent3: "直近 {n} か月の原価平均 × 残り月数（N は計算ルール参照）",
      all: "契約開始から前月までの原価平均 × 残り月数",
      assignment: "残り月のアサイン配分 × 標準時間 × 単価",
    },
  },

  // ── 月の状態 ────────────────────────────────────────────
  monthStatus: {
    final: "確定",
    preliminary: "速報",
    future: "予定",
    outside: "期間外",
  },

  // ── データ確認の警告の種類 ───────────────────────────────
  warnings: {
    UNMAPPED_WORKLOG: "未紐付け工数",
    WORKLOG_OUT_OF_CONTRACT_PERIOD: "契約期間外の工数",
    RATE_MISSING: "単価なし",
    UNKNOWN_MEMBER: "不明メンバー",
    UNKNOWN_TEAM: "チーム階層の問題",
    ALLOCATION_OVER_1: "配分の超過",
    CONTRACT_INVALID: "契約の不備",
    DUPLICATE_CONTRACT_ID: "契約IDの重複",
    MAPPING_UNKNOWN_CONTRACT: "紐付け先の契約がない",
    MAPPING_AMBIGUOUS: "紐付け先が複数",
    EXCLUDED_NO_CUSTOMER: "顧客名なしで除外",
  },
  unmappedReasons: {
    NO_RULE: "紐付けルールなし",
    OUT_OF_PERIOD: "契約期間外",
    UNKNOWN_CONTRACT: "契約IDが存在しない",
  },

  // ── 表示条件（フィルタバー） ─────────────────────────────
  filters: {
    formLabel: "表示条件",
    period: "期間",
    from: "開始月",
    to: "終了月",
    presetsLabel: "期間のプリセット",
    allTeams: "全体（すべてのチーム）",
    pastTeams: "過去の組織にのみ存在するチーム",
    unassignedSuffix: "（主担当チームなし）",
    team: "チーム",
    teamHelp: "配下のチームを含めて集計",
    method: "着地見込み",
    unit: "単位",
    // 期間のプリセット。{fy} は年度の番号（例 2026）
    presets: {
      fy: "今年度（FY{fy}）",
      fyShort: "今年度",
      prevFy: "前年度（FY{fy}）",
      prevFyShort: "前年度",
      recent3: "直近3か月",
      recent12: "直近12か月",
    },
  },
  // ── 一覧表（列名は画面と Excel 出力の見出しの両方に使う） ─────────
  columns: {
    contract: "契約",
    contractId: "契約ID",
    team: "チーム",
    contractPeriod: "契約期間",
    status: "状態",
    budget: "予算",
    cost: "原価",
    grossProfit: "粗利",
    grossMargin: "粗利率",
    burnRate: "消化率",
    forecastGrossProfit: "着地粗利",
    hours: "時間",
    contractCount: "契約数",
    inPeriodSub: "（期間内）",
    contractCountInPeriod: "契約数（期間内）",
    contractCountFy: "契約数（年度内）",
    inFySub: "（年度内）",
    forecastGrossProfitFyExport: "着地粗利（年度内）（円）",
  },
  table: {
    // Excel の列名に付ける単位
    exportYen: "{label}（円）",
    exportPercent: "{label}（%）",
    exportHours: "{label}（h）",
    exportUnitNote: "単位: 円（金額は選択中の表示単位に関係なく円の整数）・割合は %・時間は h",
    exportButton: "Excel出力",
    exportFailed: "Excel 出力に失敗しました: {error}",
    empty: "該当するデータがありません",
    sortBy: "{label}で並べ替え",
    totalBreakdownAria: "合計の{label} {value} の計算根拠を表示",
    cellBreakdownAria: "{label} {value} の計算根拠を表示",
    treeOpen: "{name} の配下を開く",
    treeClose: "{name} の配下を閉じる",
    rowCountTree: "{n} 行",
    rowCount: "{n} 件",
    total: "合計",
    scrollHint: "横にスクロールできます",
    regionLabel: "一覧",
    contractTitle: "{id} {customer} / {project}（{team}、{from}〜{to}）",
    fyContractCount: "{n}件",
    fyContractCountTitle: "年度に掛かる契約の件数",
    // 状態チップ
    chipTeamDeficit: "赤字 {n}件",
    chipTeamDeficitTitle: "配下の契約のうち、年度末に赤字で着地する見込みの契約が {n} 件あります",
    chipDeficit: "赤字見込み",
    chipDeficitTitle: "年度末に赤字で着地する見込み",
    chipOverBudget: "予算超過",
    chipOverBudgetTitle: "経過月の累計原価が累計予算を超えています（消化率が基準超）",
    chipPrelim: "速報含む",
    chipPrelimTitle: "確定前の月を含みます",
    chipOk: "問題なし",
  },

  // ── データの検査（CI とデータ確認画面に出るエラー・警告） ────────────
  checks: {
    missingColumn: "{file}: 列 {column} がありません",
    contractIdEmpty: "{file} {row} 行目: 契約IDが空です",
    duplicateContractId: "{file} {row} 行目: 契約ID {contractId} が重複しています",
    contractStartMonthInvalid: "{file} {row} 行目: start_month の形式が不正です: {value}",
    contractEndMonthInvalid: "{file} {row} 行目: end_month の形式が不正です: {value}",
    contractPeriodInverted: "{file} {row} 行目: 契約 {contractId} の開始月 {from} が終了月 {to} より後です",
    contractAmountNotNumber: "{file} {row} 行目: 契約 {contractId} の total_amount が数値ではありません",
    contractAmountNegative: "{file} {row} 行目: 契約 {contractId} の total_amount が負です: {value}",
    contractAmountNotInteger: "{file} {row} 行目: 契約 {contractId} の total_amount は円の整数で入力してください: {value}",
    mappingUnknownContract: "{file} {row} 行目: 契約ID {contractId} は contracts.csv に存在しません",
    assignmentUnknownMember: "{file} {row} 行目: メンバーID {memberId} は members.csv に存在しません",
    assignmentUnknownContract: "{file} {row} 行目: 契約ID {contractId} は contracts.csv に存在しません",
    assignmentStartMonthInvalid: "{file} {row} 行目: start_month の形式が不正です: {value}",
    assignmentEndMonthInvalid: "{file} {row} 行目: end_month の形式が不正です: {value}",
    assignmentPeriodInverted: "{file} {row} 行目: 開始月 {from} が終了月 {to} より後です",
    allocationOutOfRange: "{file} {row} 行目: allocation は 0〜1 で指定してください: {value}",
    allocationOver1: "{file}: メンバー {memberId} の {month} の allocation 合計が 1.0 を超えています（{total}、行 {rows}）",
    teamIdEmpty: "{file} {row} 行目: team_id が空です",
    teamEffectiveFromInvalid: "{file} {row} 行目: effective_from の形式が不正です: {value}",
    teamUnknownParent: "{file} {row} 行目: 親チーム {parentTeamId} は存在しません",
    memberIdEmpty: "{file} {row} 行目: member_id が空です",
    memberKindInvalid: "{file} {row} 行目: メンバー {memberId} の区分は employee か partner で指定してください: {value}",
    memberUnknownTeam: "{file} {row} 行目: メンバー {memberId} のチーム {teamId} は存在しません",
    memberEffectiveFromInvalid: "{file} {row} 行目: effective_from の形式が不正です: {value}",
    rateKeyEmpty: "{file} {row} 行目: key が空です",
    rateNotNumber: "{file} {row} 行目: {key} の hourly_rate が数値ではありません",
    rateNegative: "{file} {row} 行目: {key} の hourly_rate が負です: {value}",
    rateEffectiveFromInvalid: "{file} {row} 行目: effective_from の形式が不正です: {value}",
    holidayDateInvalid: "{file} {row} 行目: date の形式が不正です: {value}",
    worklogInvalidDate: "{file}: 日付が不正な作業実績 {count} 件を無視します",
    worklogInvalidHours: "{file}: hours が 0 以下か数値でない作業実績 {count} 件を無視します",
    unmappedWorklog: "{file}: 「{customer} / {project}」の作業実績 {count} 件（{hours} 時間、{firstDate}〜{lastDate}）が契約に紐付いていません（{reason}）",
    excludedNoCustomer: "{file}: 顧客名が空の作業実績 {hours} 時間を除外します",
    unknownMember: "{file}: メンバー {memberId} は members.csv に存在しません（{hours} 時間）",
    rateMissing: "{file}: {month} のメンバー {memberId} の時間単価がありません（{hours} 時間）",
  },

  // ── 計算時の警告（データ確認画面） ─────────────────────────
  calcWarnings: {
    unknownMember: "メンバー {memberId}（{memberName}）はメンバーマスタに存在しません。個人単価が無ければ単価 0 で計算しています（{hours} 時間）",
    rateMissing: "{month} のメンバー {memberId}（{memberName}）の時間単価が見つからないため 0 円で計算しています（{hours} 時間）",
    teamParentMissing: "チーム「{name}」({teamId}) の親チーム {parentTeamId} が {month} 時点で存在しないため最上位として扱います",
    teamCycle: "チームの親子関係が循環しています（{cycle} → {current}）。{cutId}「{cutName}」を最上位として扱います",
    mappingUnknownContract: "マッピング {row} 行目（{customer} / {project}）の契約ID {contractId} は存在しません",
    excludedNoCustomer: "顧客名が空の作業実績 {count} 件（{hours} 時間）を集計から除外しました",
    mappingAmbiguous: "「{customer} / {project}」の作業実績 {count} 件（{hours} 時間）は複数の契約（{candidates}）に該当するため、契約ID昇順で最初の {chosen} に紐付けました",
    unmappedWorklog: "「{customer} / {project}」の作業実績 {count} 件（{hours} 時間、{firstDate}〜{lastDate}）が契約に紐付いていません（{reason}）",
    reasonNoRule: "マッピングルールなし",
    reasonOutOfPeriod: "契約期間外",
    reasonUnknownContract: "存在しない契約ID",
    contractStartMonthInvalid: "開始月の形式が不正です: {value}",
    contractEndMonthInvalid: "終了月の形式が不正です: {value}",
    contractPeriodInverted: "開始月 {from} が終了月 {to} より後です",
    contractAmountNotNumber: "契約総額が数値ではありません",
    contractAmountNegative: "契約総額が負です: {value}",
    contractAmountNotInteger: "契約総額が整数ではありません: {value}",
    duplicateContractId: "契約ID {contractId} が重複しています。最初の行のみ採用します",
    duplicateReason: "契約IDの重複",
    contractExcluded: "契約 {contractId} を計算から除外しました: {reason}",
  },

  // ── 数値の書き方（金額・人月）と固定の名前 ─────────────────────
  numbers: {
    millionYen: "{value}百万円",
    thousandYen: "{value}千円",
    yen: "{value}円",
    personMonths: "{value}人月",
    // 主担当チームが空・不明の契約のグループ名
    unassignedTeam: "未設定",
    noCustomerName: "顧客名なし",
  },
};
