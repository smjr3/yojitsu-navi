/**
 * 顧客別（/customers, /customer?key=）: 数値の突合、内訳パネル、検索・チーム絞り込み、遷移、Excel 出力、
 * 日本語・記号・空白を含む顧客名の URL 往復、a11y、ダーク、狭幅
 */
import { createRequire } from "node:module";
import type { Page } from "@playwright/test";
import { test, expect, useDarkTheme, gotoPage, kpiValue, dialog, dialogRow, tableByCaption, dataRows, headerIndex, col, cell, cellText, parseNumber, query, rowKeys } from "./helpers/app.js";
import { aggregate, fiscalPeriod, forecastFor, formatPercent, getModel, teamContractIds, totalsFor, yen } from "./helpers/core.js";
import { NONE_CUSTOMER_KEY, customerKey, dailyProgress, encodeDaily, groupByCustomer } from "../../src/core/index.js";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx") as typeof import("xlsx");

/** 数値比較は既定の表示単位に依存しないよう、URL に unit=yen を明示して開く（unit 指定済みならそのまま） */
async function go(page: Page, path: string) {
  const [p, q = ""] = path.split("?");
  const params = new URLSearchParams(q);
  if (!params.has("unit")) params.set("unit", "yen");
  await gotoPage(page, `${p}?${params.toString().replace(/\+/g, "%20")}`);
}

const model = getModel();
/** 着地見込みの方式の既定（config.json。§51 で計画値） */
const DEFAULT_METHOD = model.config.forecastMethodDefault;
const FY = fiscalPeriod(model);
const groups = groupByCustomer(model.contracts.map((r) => r.contract));
const inFy = (ids: readonly string[]) => aggregate(model, { period: FY, contractIds: ids as string[] });
/** 一覧に出る顧客（選択期間に案件が 1 件以上） */
const listed = (restrict?: readonly string[]) => {
  const set = restrict ? new Set(restrict) : null;
  return groups
    .map((g) => ({ ...g, ids: set ? g.contractIds.filter((id) => set.has(id)) : g.contractIds }))
    .filter((g) => g.ids.length > 0 && inFy(g.ids).contractCount > 0);
};

const rowByKey = (page: Page, caption: string, key: string) => tableByCaption(page, caption).locator("tbody tr[data-key]").filter({ has: page.locator(`xpath=self::tr[@data-key=${JSON.stringify(key)}]`) });

/** 顧客一覧の 1 行を core の値と比べる */
async function expectRow(page: Page, key: string, ids: readonly string[], method = DEFAULT_METHOD) {
  const table = tableByCaption(page, "顧客一覧");
  const h = await headerIndex(table);
  const row = table.locator("tbody tr[data-key]").filter({ has: page.locator(`xpath=self::tr[@data-key=${JSON.stringify(key)}]`) });
  await expect(row).toHaveCount(1);
  const t = inFy(ids);
  const f = forecastFor(method, ids as string[], model);
  expect(parseNumber(await cellText(row, col(h, "案件数")))).toBe(t.contractCount);
  expect(await cellText(row, col(h, "予算"))).toBe(yen(t.budget));
  expect(await cellText(row, col(h, "実績"))).toBe(yen(t.cost));
  expect(await cellText(row, col(h, "残予算"))).toBe(yen(t.grossProfit));
  expect(await cellText(row, col(h, "残予算率"))).toBe(formatPercent(t.grossMargin));
  expect(await cellText(row, col(h, "消化率"))).toContain(formatPercent(t.burnRate));
  // 着地差は選んだ期間の終わりまで（§54）。期間に案件が無ければ「—」
  if (t.contractCount === 0) expect(await cellText(row, col(h, "着地差"))).toBe("—");
  else expect((await cellText(row, col(h, "着地差"))).replace(/[▲\s]/g, "")).toBe(yen(f.forecastGrossProfit));
}

test.describe("顧客一覧 /customers", () => {
  test("行は『期間内に案件のある顧客』で、数値は core の aggregate / forecastTotals と一致", async ({ page }) => {
    await go(page, "/customers");
    await expect(page.locator("h1")).toHaveText("顧客別");
    const table = tableByCaption(page, "顧客一覧");
    const expected = listed();
    expect(expected.length).toBeGreaterThan(5);
    expect(new Set(await rowKeys(table))).toEqual(new Set(expected.map((g) => g.key)));
    for (const g of expected) await expectRow(page, g.key, g.ids);
    // 表示名: 契約ID昇順で最初の案件の顧客名
    for (const g of expected) {
      const first = model.contracts.map((r) => r.contract).filter((c) => g.contractIds.includes(c.contractId)).sort((a, b) => (a.contractId < b.contractId ? -1 : 1))[0]!;
      await expect(table.locator("tbody tr[data-key]").filter({ has: page.locator(`xpath=self::tr[@data-key=${JSON.stringify(g.key)}]`) })).toContainText(first.customerName);
    }
  });

  test("合計行 = 全顧客の合計 = 全体サマリーの KPI（顧客は案件を重複せず分ける）", async ({ page }) => {
    await go(page, "/customers");
    const table = tableByCaption(page, "顧客一覧");
    const h = await headerIndex(table);
    const sum = table.locator("tfoot tr.yn-summary-row");
    await expect(sum).toBeVisible();
    const all = totalsFor(FY, undefined, model);
    await expect(sum).toContainText("合計");
    expect(await cellText(sum, col(h, "予算"))).toBe(yen(all.budget));
    expect(await cellText(sum, col(h, "実績"))).toBe(yen(all.cost));
    expect(await cellText(sum, col(h, "残予算"))).toBe(yen(all.grossProfit));
    expect(parseNumber(await cellText(sum, col(h, "案件数")))).toBe(all.contractCount);
    // 行の予算の合計も一致
    const rows = dataRows(table);
    let s = 0;
    for (let i = 0; i < (await rows.count()); i++) s += parseNumber(await cellText(rows.nth(i), col(h, "予算")))!;
    expect(s).toBe(all.budget);
    // 合計行の根拠ボタン
    await cell(sum, col(h, "予算")).locator("button").click();
    await expect(dialog(page)).toBeVisible();
    expect(await dialogRow(page, "予算合計")).toBe(yen(all.budget));
  });

  test("数値の根拠ボタン: 顧客行の予算・着地差の内訳が開き、値が表と一致", async ({ page }) => {
    await go(page, "/customers");
    const g = listed().find((x) => x.ids.length >= 2)!;
    expect(g).toBeTruthy();
    const table = tableByCaption(page, "顧客一覧");
    const h = await headerIndex(table);
    const row = table.locator("tbody tr[data-key]").filter({ has: page.locator(`xpath=self::tr[@data-key=${JSON.stringify(g.key)}]`) });
    await cell(row, col(h, "予算")).locator("button").click();
    await expect(dialog(page)).toBeVisible();
    expect(await dialogRow(page, "予算合計")).toBe(yen(inFy(g.ids).budget));
    expect(await dialogRow(page, "対象案件")).toBe(`${inFy(g.ids).contractCount}件`);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await cell(row, col(h, "実績")).locator("button").click();
    await expect(dialog(page).locator("#yn-dialog-title")).toContainText("実績の計算根拠");
    await page.keyboard.press("Escape");
    await cell(row, col(h, "着地差")).locator("button").click();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("検索: 全角・半角・法人格・大文字小文字の違いを区別せず部分一致。該当なしは空状態", async ({ page }) => {
    await go(page, "/customers");
    const table = tableByCaption(page, "顧客一覧");
    const search = page.locator("#yn-f-text");
    // 「青葉」は青葉物流と医療法人社団 青葉会の両方に部分一致する
    await search.fill("青葉");
    await expect.poll(async () => (await rowKeys(table)).length).toBe(2);
    expect((await rowKeys(table)).sort()).toEqual([customerKey("青葉物流"), customerKey("医療法人社団 青葉会")].sort());
    // 法人格つき・全角英数でも同じ（normalizeName）
    await search.fill("株式会社青葉物流");
    await expect.poll(async () => (await rowKeys(table)).length).toBe(1);
    await search.fill("ＥＣ");
    await expect(page.locator("#yn-f-text")).toHaveValue("ＥＣ");
    await search.fill("zzzz該当なし");
    await expect(page.getByText("該当する顧客がありません")).toBeVisible();
    await search.fill("");
    await expect.poll(async () => (await rowKeys(tableByCaption(page, "顧客一覧"))).length).toBe(listed().length);
    // URL の q から復元
    await go(page, "/customers?q=" + encodeURIComponent("みなと"));
    await expect(page.locator("#yn-f-text")).toHaveValue("みなと");
    expect(await rowKeys(tableByCaption(page, "顧客一覧"))).toEqual([customerKey("みなと銀行")]);
  });

  test("チーム絞り込み: そのチームの案件だけで顧客を集計する", async ({ page }) => {
    await go(page, "/customers");
    const teamId = "T211";
    await page.locator("#yn-filter-team").selectOption(teamId);
    expect(query(page).get("team")).toBe(teamId);
    const ids = teamContractIds(teamId, FY, model)!;
    const expected = listed(ids);
    const table = tableByCaption(page, "顧客一覧");
    await expect.poll(async () => new Set(await rowKeys(table))).toEqual(new Set(expected.map((g) => g.key)));
    expect(expected.length).toBeGreaterThan(0);
    for (const g of expected) await expectRow(page, g.key, g.ids);
    // 合計行 = チームの合計
    const h = await headerIndex(table);
    const sum = table.locator("tfoot tr.yn-summary-row");
    expect(await cellText(sum, col(h, "予算"))).toBe(yen(totalsFor(FY, ids, model).budget));
    // 全チームの顧客より少ない、または案件数が減っている顧客がある
    const full = listed();
    expect(expected.some((g) => g.ids.length < (full.find((f) => f.key === g.key)?.ids.length ?? 0)) || expected.length < full.length).toBe(true);
  });

  test("期間外の顧客も表示: 切り替えると行が増える（期間を絞ったとき）", async ({ page }) => {
    await go(page, "/customers?from=2026-04&to=2026-04");
    const table = tableByCaption(page, "顧客一覧");
    const p = { from: "2026-04", to: "2026-04" };
    const visible = groups.filter((g) => aggregate(model, { period: p, contractIds: g.contractIds }).contractCount > 0);
    await expect.poll(async () => (await rowKeys(table)).length).toBe(visible.length);
    if (visible.length < groups.length) {
      await page.locator("label[for=yn-f-showOutside]").click();
      await expect.poll(async () => (await rowKeys(tableByCaption(page, "顧客一覧"))).length).toBe(groups.length);
    }
  });

  test("Excel 出力: 表示中の顧客が円の整数で出る", async ({ page }) => {
    await go(page, "/customers");
    const table = tableByCaption(page, "顧客一覧");
    const keys = await rowKeys(table);
    const dl = page.waitForEvent("download");
    await page.locator(".yn-table-block").filter({ has: table }).locator(".yn-export").click();
    const d = await dl;
    expect(d.suggestedFilename()).toBe(`customers_${FY.from}_${FY.to}.xlsx`);
    const wb = XLSX.readFile((await d.path())!);
    const aoa = XLSX.utils.sheet_to_json<Array<string | number | null>>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, defval: null });
    const hr = aoa.findIndex((r) => r.some((c) => c === "顧客"));
    expect(hr).toBeGreaterThanOrEqual(0);
    const header = aoa[hr]!.map((x) => String(x ?? ""));
    for (const label of ["顧客", "案件数（期間内）", "予算（円）", "実績（円）", "残予算（円）", "残予算率（%）", "消化率（%）", "着地差（円）"]) expect(header, label).toContain(label);
    const rowsAll = aoa.slice(hr + 1).filter((r) => r.some((c) => c !== null && c !== ""));
    expect(String(rowsAll.at(-1)![0]), "最終行は合計行").toMatch(/^合計/);
    const body = rowsAll.slice(0, -1);
    expect(body.length).toBe(keys.length);
    const byLabel = new Map(groups.map((g) => [g.label, g]));
    for (const r of body) {
      const g = byLabel.get(String(r[header.indexOf("顧客")]));
      expect(g).toBeTruthy();
      const t = inFy(g!.contractIds);
      expect(r[header.indexOf("予算（円）")]).toBe(t.budget);
      expect(r[header.indexOf("実績（円）")]).toBe(t.cost);
      expect(r[header.indexOf("案件数（期間内）")]).toBe(t.contractCount);
    }
  });

  test("上部タブに『顧客』があり、チームの次に並び、一覧・詳細の両方で選択状態になる", async ({ page }) => {
    await go(page, "/customers");
    const tabs = page.locator(".yn-tabs a");
    const names = (await tabs.allTextContents()).map((x) => x.trim()).filter(Boolean);
    expect(names.indexOf("顧客")).toBe(names.indexOf("チーム") + 1);
    await expect(tabs.filter({ hasText: "顧客" })).toHaveAttribute("aria-current", "page");
    await go(page, `/customer?key=${encodeURIComponent(listed()[0]!.key)}`);
    await expect(page.locator(".yn-tabs a").filter({ hasText: "顧客" })).toHaveAttribute("aria-current", "page");
  });
});

test.describe("顧客詳細 /customer", () => {
  test("一覧 → 詳細: key は encodeURIComponent、KPI は core と一致、案件一覧・担当チーム別・パンくず", { tag: "@smoke" }, async ({ page }) => {
    await go(page, "/customers");
    const g = listed().find((x) => x.contractIds.length >= 2)!;
    const link = tableByCaption(page, "顧客一覧").locator("tbody tr[data-key]").filter({ has: page.locator(`xpath=self::tr[@data-key=${JSON.stringify(g.key)}]`) }).locator(".yn-row-link").first();
    await link.click();
    await expect(page).toHaveURL(/\/customer\?/);
    expect(page.url()).toContain(`key=${encodeURIComponent(g.key)}`);
    expect(query(page).get("key")).toBe(g.key);
    await expect(page.locator("h1")).toHaveText(g.label);
    // KPI
    const t = inFy(g.contractIds);
    const f = forecastFor(DEFAULT_METHOD, g.contractIds, model);
    await expect(page.locator(".yn-kpi-grid .yn-kpi")).toHaveCount(5);
    await expect(kpiValue(page, 0)).toHaveText(yen(t.budget));
    await expect(kpiValue(page, 1)).toHaveText(yen(t.cost));
    await expect(kpiValue(page, 2)).toHaveText(yen(t.grossProfit));
    await expect(kpiValue(page, 3)).toHaveText(formatPercent(t.burnRate));
    await expect(kpiValue(page, 4)).toHaveText(yen(f.forecastGrossProfit));
    // 見出しの順: KPI → 月次推移 → 今月の進捗（今月の予算がある顧客だけ。§61）→ 案件 → 担当チーム別 → 作業種別の内訳（工数の明細は後から読む）
    await expect(page.locator("h2.yn-section-title", { hasText: "作業種別の内訳" })).toBeVisible();
    const heads = await page.locator("h2.yn-section-title").allTextContents();
    const daily = dailyProgress(model, encodeDaily(model), g.contractIds) ? [`今月の進捗（${model.meta.asOfMonth.slice(0, 4)}年${Number(model.meta.asOfMonth.slice(5, 7))}月・速報）`] : [];
    expect(heads.map((x) => x.trim())).toEqual(["月次推移", ...daily, "この顧客の案件", "担当チーム別", "作業種別の内訳"]);
    // 案件一覧 = その顧客の（期間内の）案件だけ
    const contracts = tableByCaption(page, "顧客の案件一覧");
    const inPeriod = g.contractIds.filter((id) => inFy([id]).contractCount > 0);
    expect(new Set(await rowKeys(contracts))).toEqual(new Set(inPeriod));
    // 担当チーム別: 案件の teamId ごと。案件数の合計 = 期間内の案件数
    const teams = tableByCaption(page, "担当チーム別");
    const th = await headerIndex(teams);
    const trs = dataRows(teams);
    let n = 0;
    let budget = 0;
    for (let i = 0; i < (await trs.count()); i++) {
      n += parseNumber(await cellText(trs.nth(i), col(th, "案件数")))!;
      budget += parseNumber(await cellText(trs.nth(i), col(th, "予算")))!;
    }
    expect(n).toBe(t.contractCount);
    expect(budget).toBe(t.budget);
    // 案件の行クリックで案件詳細へ、顧客名のリンクで戻れる
    await contracts.locator(`tbody tr[data-key="${inPeriod[0]}"] .yn-row-link`).click();
    await expect(page).toHaveURL(/\/contract\?/);
    await expect(page.locator(".yn-facts a", { hasText: model.contracts.find((r) => r.contract.contractId === inPeriod[0])!.contract.customerName })).toHaveAttribute("href", new RegExp(`customer\\?key=${encodeURIComponent(g.key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}&`));
    await page.locator(".yn-facts a", { hasText: g.label }).first().click();
    await expect(page).toHaveURL(/\/customer\?/);
    await expect(page.locator("h1")).toHaveText(g.label);
    // パンくず
    const crumbs = page.locator('nav[aria-label="パンくず"] li');
    await expect(crumbs).toHaveCount(3);
    await expect(crumbs.nth(1).locator("a")).toHaveText("顧客別");
    await crumbs.nth(1).locator("a").click();
    await expect(page).toHaveURL(/\/customers\?/);
  });

  test("KPI の根拠・前年同期比の注記・月次推移", async ({ page }) => {
    const g = listed().find((x) => x.contractIds.length >= 2)!;
    await go(page, `/customer?key=${encodeURIComponent(g.key)}`);
    await kpiValue(page, 0).click();
    expect(await dialogRow(page, "予算合計")).toBe(yen(inFy(g.contractIds).budget));
    await page.keyboard.press("Escape");
    await kpiValue(page, 4).click();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    // 前年同期比: 前年データがあれば比較、無ければ「比較データなし」のどちらかが全タイルに出る
    const compare = page.locator(".yn-kpi-compare");
    await expect(compare.first()).toBeVisible();
    await expect(page.locator(".yn-chart-card svg").first()).toBeVisible();
    await expect(page.locator(".yn-legend").first()).toBeVisible();
  });

  test("案件が期間に掛からないとき: 非表示の件数と『期間外の案件も表示』", async ({ page }) => {
    const g = groups.find((x) => x.contractIds.length >= 2 && x.contractIds.some((id) => inFy([id]).contractCount === 0))!;
    expect(g, "ダミーデータに期間外の案件を持つ顧客がある").toBeTruthy();
    await go(page, `/customer?key=${encodeURIComponent(g.key)}`);
    const contracts = tableByCaption(page, "顧客の案件一覧");
    const inPeriod = g.contractIds.filter((id) => inFy([id]).contractCount > 0);
    await expect.poll(async () => (await rowKeys(contracts)).length).toBe(inPeriod.length);
    await page.locator("label[for=yn-f-showOutside]").click();
    await expect.poll(async () => new Set(await rowKeys(tableByCaption(page, "顧客の案件一覧")))).toEqual(new Set(g.contractIds));
  });

  test("存在しない key・key なしは空状態（エラーにならない）", async ({ page }) => {
    await go(page, "/customer?key=" + encodeURIComponent("存在しない会社 & Co."));
    await expect(page.getByText("顧客「存在しない会社 & Co.」は見つかりません")).toBeVisible();
    await page.getByRole("link", { name: "顧客別へ戻る" }).click();
    await expect(page).toHaveURL(/\/customers/);
    await go(page, "/customer");
    await expect(page.getByText("顧客が指定されていません")).toBeVisible();
  });

  test("Excel 出力（案件一覧・担当チーム別）", async ({ page }) => {
    const g = listed().find((x) => x.contractIds.length >= 2)!;
    await go(page, `/customer?key=${encodeURIComponent(g.key)}`);
    for (const [caption, file] of [
      ["顧客の案件一覧", `customer_contracts_${FY.from}_${FY.to}.xlsx`],
      ["担当チーム別", `customer_teams_${FY.from}_${FY.to}.xlsx`],
    ] as const) {
      const dl = page.waitForEvent("download");
      await page.locator(".yn-table-block").filter({ has: tableByCaption(page, caption) }).locator(".yn-export").click();
      const d = await dl;
      expect(d.suggestedFilename()).toBe(file);
      const wb = XLSX.readFile((await d.path())!);
      const aoa = XLSX.utils.sheet_to_json<Array<string | number | null>>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, defval: null });
      expect(aoa.some((r) => r.some((c) => c === "予算（円）"))).toBe(true);
    }
  });
});

/** model.json の顧客名を書き換えて配信する（日本語・記号・空白・予約文字を含む顧客名の往復確認） */
async function rewriteCustomers(page: Page, names: Record<string, string>) {
  await page.route(/\/_file\/data\/model\.[^/]*\.json$/, async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    for (const r of json.contracts) if (names[r.contract.contractId] !== undefined) r.contract.customerName = names[r.contract.contractId];
    await route.fulfill({ response: res, json });
  });
}

test.describe("顧客名に記号・空白・日本語を含む場合の URL 往復", () => {
  const NASTY = "A&B 商事/東京 #1 100%+α ?x=y=z";
  const NASTY_VARIANT = "Ａ＆Ｂ　商事/東京 #1 100%+α ?x=y=z（株）";
  const names = { C001: NASTY, C002: NASTY_VARIANT, C003: "株式会社", C004: "__none__", C005: "日本語　名前 \"quote\" 'single' <b>tag</b>" };

  test("一覧のリンクは encodeURIComponent。詳細で同じ顧客に復元され、表記ゆれは 1 つに束ねられる", async ({ page }) => {
    await rewriteCustomers(page, names);
    await go(page, "/customers");
    const key = customerKey(NASTY);
    expect(customerKey(NASTY_VARIANT)).toBe(key);
    const table = tableByCaption(page, "顧客一覧");
    const row = table.locator("tbody tr[data-key]").filter({ has: page.locator(`xpath=self::tr[@data-key=${JSON.stringify(key)}]`) });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(NASTY); // 契約ID昇順で最初（C001）の表記
    const href = await row.locator(".yn-row-link").first().getAttribute("href");
    expect(href).toContain(`key=${encodeURIComponent(key)}`);
    expect(href).not.toMatch(/key=[^&]*[ #?]/);
    await row.locator(".yn-row-link").first().click();
    await expect(page).toHaveURL(/\/customer\?/);
    expect(query(page).get("key")).toBe(key);
    await expect(page.locator("h1")).toHaveText(NASTY);
    // C001 と C002 の 2 案件が同じ顧客
    const contracts = tableByCaption(page, "顧客の案件一覧");
    const ids = new Set(await rowKeys(contracts));
    expect(ids.has("C001") || ids.has("C002")).toBe(true);
    // 再読み込み（ブックマーク）でも同じ
    await page.reload();
    await expect(page.locator("h1")).toHaveText(NASTY);
    // 直接 URL を組み立てても開ける
    await go(page, `/customer?key=${encodeURIComponent(key)}&from=2026-04&to=2027-03`);
    await expect(page.locator("h1")).toHaveText(NASTY);
  });

  test("予約キーと同じ綴りの顧客名・法人格だけの顧客名は別の顧客として開ける", async ({ page }) => {
    await rewriteCustomers(page, names);
    await go(page, "/customers");
    const table = tableByCaption(page, "顧客一覧");
    const keys = await rowKeys(table);
    expect(keys).toContain(customerKey("__none__"));
    expect(customerKey("__none__")).not.toBe(NONE_CUSTOMER_KEY);
    // 顧客名なし（C003 = 法人格だけ）は別の行
    expect(keys).toContain(NONE_CUSTOMER_KEY);
    const none = tableByCaption(page, "顧客一覧").locator("tbody tr[data-key]").filter({ has: page.locator(`xpath=self::tr[@data-key=${JSON.stringify(NONE_CUSTOMER_KEY)}]`) });
    await expect(none).toContainText("顧客名なし");
    await none.locator(".yn-row-link").first().click();
    await expect(page.locator("h1")).toHaveText("顧客名なし");
    expect(query(page).get("key")).toBe(NONE_CUSTOMER_KEY);
    // HTML 特殊文字・引用符は文字として表示される
    await go(page, `/customer?key=${encodeURIComponent(customerKey(names.C005))}`);
    await expect(page.locator("h1")).toHaveText(names.C005);
    expect(await page.locator("h1 b").count()).toBe(0);
  });

  test("検索: 記号を含む顧客名で検索できる", async ({ page }) => {
    await rewriteCustomers(page, names);
    await go(page, "/customers");
    await page.locator("#yn-f-text").fill("100%+α ?x=y");
    await expect.poll(async () => (await rowKeys(tableByCaption(page, "顧客一覧"))).length).toBe(1);
  });
});

test.describe("画面の作法", () => {
  const detailPath = `/customer?key=${encodeURIComponent(customerKey("青葉物流"))}`;

  test("Tab で検索欄・並べ替え・行リンク・数値ボタン・Excel 出力に到達でき、aria-sort がある", async ({ page }) => {
    await go(page, "/customers");
    await expect(page.locator("table.yn-table").first()).toBeVisible();
    const targets: Record<string, string> = { 検索: "#yn-f-text", 並べ替え見出し: "th button.yn-sort", 行リンク: ".yn-row-link", 数値ボタン: "td button.yn-num", Excel出力: ".yn-export", チーム: "#yn-filter-team" };
    const reached = new Set<string>();
    await page.locator("body").press("Tab").catch(() => {});
    for (let i = 0; i < 400 && reached.size < Object.keys(targets).length; i++) {
      const hit = await page.evaluate((t) => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        return Object.entries(t).filter(([, sel]) => el.matches(sel)).map(([name]) => name);
      }, targets);
      for (const name of hit ?? []) reached.add(name);
      await page.keyboard.press("Tab");
    }
    expect([...reached].sort()).toEqual(Object.keys(targets).sort());
    const ths = page.locator("table.yn-table thead th button.yn-sort");
    for (let i = 0; i < (await ths.count()); i++) await expect(ths.nth(i).locator("xpath=ancestor::th[1]")).toHaveAttribute("aria-sort", /^(none|ascending|descending)$/);
    await expect(page.locator("table.yn-table caption")).toHaveCount(1);
    await expect(page.locator("tbody tr[data-key]").first().locator("th[scope=row]")).toHaveCount(1);
  });

  test("赤は消化率超過と超過見込みだけ: 色だけに頼らず文字（▲・超過見込み／消化率超過）を持つ", async ({ page }) => {
    await go(page, "/customers");
    const chips = await page.locator("tbody .yn-chip-danger").allTextContents();
    for (const t of chips) expect(t).toMatch(/超過見込み|予算超過|消化率超過/);
    const dangerText = await page.locator("tbody .yn-danger-text").evaluateAll((els) => els.map((e) => (e.textContent ?? "").replace(/[▲\s]/g, "")));
    for (const t of dangerText) expect(t.length).toBeGreaterThan(0);
    // 超過見込みの案件を持つ顧客: 合計の着地がマイナスなら赤の「超過見込み N件」、マイナスでなければ灰色の「超過案件 N件」（§67）
    const deficitCustomers = listed().filter((g) => forecastFor(DEFAULT_METHOD, g.ids, model).deficitContractIds.length > 0);
    expect(deficitCustomers.length).toBeGreaterThan(0);
    for (const g of deficitCustomers) {
      const f = forecastFor(DEFAULT_METHOD, g.ids, model);
      const n = f.deficitContractIds.length;
      const row = rowByKey(page, "顧客一覧", g.key);
      if (f.forecastGrossProfit < 0) await expect(row.locator(".yn-chip-danger").first()).toHaveText(`▲超過見込み ${n}件`);
      else {
        await expect(row.locator(".yn-chip-neutral")).toContainText(`超過案件 ${n}件`);
        await expect(row.locator(".yn-chip-danger", { hasText: "超過見込み" })).toHaveCount(0);
      }
    }
  });

  for (const [name, path] of [["一覧", "/customers"], ["詳細", detailPath]] as const) {
    test(`${name}: 画像・SVG・チップに名前／文字があり、見出しは h1 が 1 つ`, async ({ page }) => {
      await go(page, path);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("h1")).toHaveCount(1);
      const problems = await page.evaluate(() => {
        const out: string[] = [];
        for (const svg of document.querySelectorAll("svg")) {
          const hidden = svg.closest('[aria-hidden="true"]') !== null;
          const control = svg.closest("button, a, [role=button]");
          const controlNamed = control && (control.getAttribute("aria-label") || control.getAttribute("title") || (control.textContent ?? "").trim());
          const named = controlNamed || svg.getAttribute("aria-label") || svg.getAttribute("aria-labelledby") || svg.querySelector(":scope > title");
          const role = svg.getAttribute("role");
          if (!hidden && !named && role !== "presentation" && role !== "none") out.push(`svg: ${svg.outerHTML.slice(0, 120)}`);
        }
        for (const chip of document.querySelectorAll(".yn-chip")) {
          const text = [...chip.childNodes].filter((n) => !(n instanceof Element && n.getAttribute("aria-hidden") === "true")).map((n) => n.textContent ?? "").join("").trim();
          if (!text) out.push(`chip: ${chip.outerHTML.slice(0, 100)}`);
        }
        return out;
      });
      expect(problems).toEqual([]);
    });
  }

  for (const width of [1280, 1024]) {
    test(`${width}px 幅: 顧客一覧の標準列が横スクロール無しで収まる`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await go(page, "/customers");
      const table = tableByCaption(page, "顧客一覧");
      await expect(table).toBeVisible();
      const m = await table.evaluate((t) => {
        const wrap = t.closest(".yn-table-scroll") as HTMLElement;
        return { sw: wrap.scrollWidth, cw: wrap.clientWidth, page: document.scrollingElement!.scrollWidth <= document.scrollingElement!.clientWidth + 1 };
      });
      expect(m.page).toBe(true);
      expect(m.sw, `表 scrollWidth ${m.sw} <= clientWidth ${m.cw}`).toBeLessThanOrEqual(m.cw + 1);
      const h = await headerIndex(table);
      for (const l of ["予算", "実績", "残予算", "残予算率", "消化率", "着地差"]) await expect(table.locator("thead th").nth(col(h, l))).toBeVisible();
    });
  }

  test("列順は他の一覧と同じ: 予算・実績・残予算・残予算率・消化率・着地差（状態は最後）", async ({ page }) => {
    await go(page, "/customers");
    const h = await headerIndex(tableByCaption(page, "顧客一覧"));
    const order = ["予算", "実績", "残予算", "残予算率", "消化率", "着地差", "状態"].map((l) => col(h, l));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(col(h, "顧客")).toBeLessThan(col(h, "予算"));
  });

  test.describe("スマートフォン幅（390×844）", () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    for (const [name, path] of [["一覧", "/customers"], ["詳細", detailPath], ["見つからない", "/customer?key=nope"]] as const) {
      test(`${name}: 横スクロールが発生しない`, async ({ page }) => {
        await go(page, path);
        await page.waitForLoadState("networkidle");
        const { sw, cw } = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, cw: document.scrollingElement!.clientWidth }));
        expect(sw).toBeLessThanOrEqual(cw + 1);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        const after = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, cw: document.scrollingElement!.clientWidth }));
        expect(after.sw).toBeLessThanOrEqual(after.cw + 1);
      });
    }
  });

  test.describe("ダークモード", () => {
    test.beforeEach(async ({ page }) => {
      await useDarkTheme(page);
    });
    for (const [name, path] of [["一覧", "/customers"], ["詳細", detailPath]] as const) {
      test(`${name}: 背景が暗く、エラー無し`, async ({ page }) => {
        await go(page, path);
        await page.waitForLoadState("networkidle");
        const lum = await page.evaluate(() => {
          const m = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g)!.map(Number);
          return (0.2126 * m[0]! + 0.7152 * m[1]! + 0.0722 * m[2]!) / 255;
        });
        expect(lum).toBeLessThan(0.25);
        await expect(page.locator("table.yn-table:visible").first()).toBeVisible();
      });
    }
  });
});
