/**
 * チーム詳細（/team?id=）: 数値は core と一致、パンくず、配下チーム、契約一覧（列順）、メンバー別実績、組織の変遷、空状態、遷移、Excel、a11y
 */
import { createRequire } from "node:module";
import { test, expect, useDarkTheme, gotoPage, waitForPage, kpiValue, tableByCaption, dataRows, headerIndex, col, cell, cellText, parseNumber, query, rowKeys, dialog, dialogRow } from "./helpers/app.js";
import { UNASSIGNED_TEAM_ID, contractsInPeriod, contractRowExpected, fiscalPeriod, forecastFor, formatPercent, getModel, teamContractIds, totalsFor, treeAt, yen } from "./helpers/core.js";
import { teamMemberCosts, teamOrgChanges } from "../../src/core/index.js";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx") as typeof import("xlsx");

const model = getModel();
const FY = fiscalPeriod(model);
const tree = treeAt(FY.to, model);

test("T111: パンくず・見出し・KPI 5 枚が core の集計と一致する", async ({ page }) => {
  await gotoPage(page, "/team?id=T111&unit=yen");
  await expect(page.locator("h1")).toContainText("T111");
  await expect(page.locator("h1")).toContainText(tree.T111!.name);
  const crumbs = page.locator('nav[aria-label="パンくず"] li');
  const chain = ["HQ", "D1", "S11", "T111"];
  await expect(crumbs).toHaveCount(2 + chain.length);
  await expect(crumbs.nth(0).locator("a")).toHaveText("全体サマリー");
  await expect(crumbs.nth(1).locator("a")).toHaveText("チーム一覧");
  for (const [i, id] of chain.entries()) {
    const li = crumbs.nth(2 + i);
    if (i < chain.length - 1) {
      await expect(li.locator("a")).toHaveText(tree[id]!.name);
      await expect(li.locator("a")).toHaveAttribute("href", new RegExp(`team\\?id=${id}`));
    } else await expect(li.locator('[aria-current="page"]')).toHaveText(tree[id]!.name);
  }
  const ids = teamContractIds("T111", FY, model)!;
  const totals = totalsFor(FY, ids, model);
  const fc = forecastFor("recent3", ids, model);
  await expect(page.locator(".yn-kpi-grid .yn-kpi")).toHaveCount(5);
  await expect(kpiValue(page, 0)).toHaveText(yen(totals.budget));
  await expect(kpiValue(page, 1)).toHaveText(yen(totals.cost));
  await expect(kpiValue(page, 2)).toHaveText(yen(totals.grossProfit));
  await expect(kpiValue(page, 3)).toHaveText(formatPercent(totals.burnRate));
  await expect(kpiValue(page, 4)).toHaveText(yen(fc.forecastGrossProfit));
  await expect(page.locator(".yn-kpi").nth(0)).toContainText(`${totals.contractCount}件の契約`);
  // 末端チームなので「配下のチーム」は出ない
  await expect(page.getByRole("heading", { name: "配下のチーム" })).toHaveCount(0);
  // KPI の根拠: 予算の内訳の合計が KPI と一致
  await kpiValue(page, 0).click();
  expect(await dialogRow(page, "予算合計")).toBe(yen(totals.budget));
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
});

test("千円・期間・方式の変更が URL とKPIに反映され、再読込でも保たれる", async ({ page }) => {
  await gotoPage(page, "/team?id=S11&from=2026-06&to=2026-09&unit=k&method=all");
  const period = { from: "2026-06", to: "2026-09" };
  const ids = teamContractIds("S11", { from: "2026-06", to: "2026-09" }, model)!;
  const totals = totalsFor(period, ids, model);
  await expect(kpiValue(page, 0)).toHaveText(yen(totals.budget, "k"));
  await expect(kpiValue(page, 4)).toHaveText(yen(forecastFor("all", ids, model).forecastGrossProfit, "k"));
  await page.reload();
  await expect(kpiValue(page, 1)).toHaveText(yen(totals.cost, "k"));
  expect(query(page).get("id")).toBe("S11");
  await page.locator(".yn-seg-btn[data-unit=yen]").click();
  await expect(kpiValue(page, 1)).toHaveText(yen(totals.cost));
  expect(query(page).get("id")).toBe("S11");
});

test("配下のチーム: 直下の子だけが並び、数値は core と一致。行クリックで子の詳細へ", async ({ page }) => {
  await gotoPage(page, "/team?id=D2&unit=yen");
  const table = tableByCaption(page, "配下のチーム");
  expect(new Set(await rowKeys(table))).toEqual(new Set(tree.D2!.children));
  const h = await headerIndex(table);
  for (const id of tree.D2!.children) {
    const t = totalsFor(FY, teamContractIds(id, FY, model)!, model);
    const row = table.locator(`tbody tr[data-key="${id}"]`);
    expect(parseNumber(await cellText(row, col(h, "予算")))).toBe(t.budget);
    expect(parseNumber(await cellText(row, col(h, "実績")))).toBe(t.cost);
  }
  await table.locator('tbody tr[data-key="S22"] .yn-row-link').click();
  await expect(page).toHaveURL(/\/team\?/);
  expect(query(page).get("id")).toBe("S22");
  await expect(page.locator("h1")).toContainText(tree.S22!.name);
});

test("契約一覧: 期間内の契約だけ。列順は契約一覧と同じ。行クリックで契約詳細、絞り込みリンクで契約一覧", async ({ page }) => {
  await gotoPage(page, "/team?id=S21&unit=yen");
  const table = tableByCaption(page, "チームの契約一覧");
  const ids = teamContractIds("S21", FY, model)!;
  const expected = contractsInPeriod(FY, ids, model);
  expect(new Set(await rowKeys(table))).toEqual(new Set(expected.map((r) => r.contract.contractId)));
  const h = await headerIndex(table);
  const order = ["契約", "予算", "実績", "残予算", "残予算率", "消化率", "着地差", "状態"].map((l) => col(h, l));
  expect(order).toEqual([...order].sort((a, b) => a - b));
  // 契約一覧ページの列順と同じ
  const labelsHere = [...h.keys()];
  await gotoPage(page, "/contracts");
  const labelsThere = [...(await headerIndex(tableByCaption(page, "契約一覧"))).keys()];
  expect(labelsHere).toEqual(labelsThere);
  await gotoPage(page, "/team?id=S21&unit=yen");
  for (const r of expected) {
    const e = contractRowExpected(r, FY, "recent3", model);
    const row = table.locator(`tbody tr[data-key="${r.contract.contractId}"]`);
    expect(parseNumber(await cellText(row, col(h, "予算")))).toBe(e.totals.budget);
    expect(parseNumber(await cellText(row, col(h, "実績")))).toBe(e.totals.cost);
  }
  // 数値は根拠ボタン
  await expect(table.locator("tbody td button.yn-num").first()).toBeVisible();
  // Excel: 表示行と一致
  const dl = page.waitForEvent("download");
  await page.locator(".yn-table-block").filter({ has: table }).locator(".yn-export").click();
  const d = await dl;
  expect(d.suggestedFilename()).toBe(`team_S21_contracts_${FY.from}_${FY.to}.xlsx`);
  const wb = XLSX.readFile((await d.path())!);
  const aoa = XLSX.utils.sheet_to_json<Array<string | number | null>>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, defval: null });
  const hr = aoa.findIndex((r) => r.some((c) => c === "契約ID"));
  const header = aoa[hr]!.map((x) => String(x ?? ""));
  const body = aoa.slice(hr + 1).filter((r) => r.some((c) => c !== null && c !== ""));
  expect(body.map((r) => r[header.indexOf("契約ID")]).sort()).toEqual(expected.map((r) => r.contract.contractId).sort());
  // 行クリック → 契約詳細
  const first = expected[0]!.contract.contractId;
  await cell(table.locator(`tbody tr[data-key="${first}"]`), col(h, "残予算率")).click({ position: { x: 2, y: 2 } });
  await expect(page).toHaveURL(/\/contract\?/);
  expect(query(page).get("id")).toBe(first);
  await page.goBack();
  await expect(page.locator("h1")).toContainText("S21");
  // 契約一覧へ絞り込み
  await page.getByRole("link", { name: "契約一覧で絞り込む" }).click();
  await expect(page).toHaveURL(/\/contracts\?/);
  expect(query(page).get("team")).toBe("S21");
  await expect(page.locator("#yn-filter-team")).toHaveValue("S21");
  expect(new Set(await rowKeys(tableByCaption(page, "契約一覧")))).toEqual(new Set(expected.map((r) => r.contract.contractId)));
});

test("メンバー別実績: 作業実績軸（所属が別でも含む）。core と一致し、合計は KPI の実績、根拠ボタンで実績行", async ({ page }) => {
  await gotoPage(page, "/team?id=S21&unit=yen");
  const table = tableByCaption(page, "メンバー別の実績");
  const ids = teamContractIds("S21", FY, model)!;
  const rows = teamMemberCosts(model, ids, FY, new Set(tree.S21!.descendantIds));
  expect(rows.length).toBeGreaterThan(0);
  expect(new Set(await rowKeys(table))).toEqual(new Set(rows.map((r) => r.memberId)));
  expect((await rowKeys(table))[0]).toBe(rows[0]!.memberId); // 既定は実績の大きい順
  const h = await headerIndex(table);
  for (const r of rows) {
    const row = table.locator(`tbody tr[data-key="${r.memberId}"]`);
    expect(parseNumber(await cellText(row, col(h, "実績")))).toBe(r.amount);
    expect(parseNumber(await cellText(row, col(h, "時間")))).toBeCloseTo(r.hours, 2);
    if (r.outsideHours > 0) await expect(row).toContainText("応援");
    else await expect(row).not.toContainText("応援");
  }
  expect(rows.some((r) => r.outsideHours > 0), "他チームの応援を含むデータである").toBe(true);
  expect(rows.reduce((a, r) => a + r.amount, 0)).toBe(totalsFor(FY, ids, model).cost);
  // 根拠
  const top = rows[0]!;
  await table.locator(`tbody tr[data-key="${top.memberId}"] td button.yn-num`).nth(1).click();
  expect(await dialogRow(page, "実績合計")).toBe(yen(top.amount));
  await expect(dialog(page).locator("table tbody tr").first()).toBeVisible();
  await page.keyboard.press("Escape");
});

test("組織の変遷: 期間内に変わったチームだけに出る（T212 は 2026-10 に第3課 → 第4課）", async ({ page }) => {
  const expected = (id: string, p = FY) => teamOrgChanges(model.teams, id, p);
  for (const [id, caption] of [["T212", "組織の変遷"], ["S21", "組織の変遷"], ["S22", "組織の変遷"]] as const) {
    await gotoPage(page, `/team?id=${id}&unit=yen`);
    const table = tableByCaption(page, caption);
    const ch = expected(id);
    expect(ch.length, id).toBeGreaterThan(0);
    await expect(dataRows(table)).toHaveCount(ch.length);
    await expect(table).toContainText("2026年10月");
  }
  await gotoPage(page, "/team?id=T212&unit=yen");
  await expect(tableByCaption(page, "組織の変遷")).toContainText(`${tree.S21?.name ?? "第3課"}`);
  await expect(tableByCaption(page, "組織の変遷")).toContainText("上位チームを");
  await gotoPage(page, "/team?id=S21&unit=yen");
  await expect(tableByCaption(page, "組織の変遷")).toContainText("配下から");
  await gotoPage(page, "/team?id=S22&unit=yen");
  await expect(tableByCaption(page, "組織の変遷")).toContainText("配下に移りました");
  // 変更の無いチーム・期間外では出ない
  await gotoPage(page, "/team?id=T111&unit=yen");
  await expect(page.getByRole("heading", { name: "組織の変遷" })).toHaveCount(0);
  await gotoPage(page, "/team?id=T212&from=2025-04&to=2026-03");
  await expect(page.getByRole("heading", { name: "組織の変遷" })).toHaveCount(0);
  // 期間の終了月の組織で上位が変わる（2026-09 までは第3課の配下）
  await gotoPage(page, "/team?id=T212&from=2026-04&to=2026-09");
  await expect(page.locator('nav[aria-label="パンくず"]')).toContainText(tree.S21?.name ?? "第3課");
});

test("未設定（__unassigned__）: 集計は core の未設定グループ。配下・組織の変遷は無い", async ({ page }) => {
  await gotoPage(page, `/team?id=${UNASSIGNED_TEAM_ID}&unit=yen`);
  await expect(page.locator("h1")).toContainText("未設定");
  const ids = teamContractIds(UNASSIGNED_TEAM_ID, FY, model)!;
  const totals = totalsFor(FY, ids, model);
  await expect(kpiValue(page, 0)).toHaveText(yen(totals.budget));
  await expect(kpiValue(page, 1)).toHaveText(yen(totals.cost));
  await expect(page.getByRole("heading", { name: "配下のチーム" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "組織の変遷" })).toHaveCount(0);
  await expect(page.locator('nav[aria-label="パンくず"] li')).toHaveCount(3);
});

test("存在しない ID は空状態（チーム一覧へのリンク）。ID 未指定も", async ({ page }) => {
  await gotoPage(page, "/team?id=NOPE");
  await expect(page.locator("h1")).toHaveText("チーム詳細");
  await expect(page.getByText("このチームは選択期間の組織にありません")).toBeVisible();
  await expect(page.locator(".yn-kpi-grid")).toHaveCount(0);
  await page.locator(".yn-empty").getByRole("link", { name: "チーム一覧へ" }).click();
  await expect(page.locator("h1")).toHaveText("チーム一覧");
  await gotoPage(page, "/team");
  await expect(page.getByText("チームIDが指定されていません")).toBeVisible();
  // 履歴にはあるが、プロトタイプのキー名のような ID でも壊れない
  await gotoPage(page, "/team?id=constructor");
  await expect(page.getByText("このチームは選択期間の組織にありません")).toBeVisible();
});

test("遷移: チーム一覧の行・全体サマリーのチーム別の行からチーム詳細へ。詳細内のリンクで契約一覧へ", async ({ page }) => {
  await gotoPage(page, "/teams");
  await tableByCaption(page, "チーム一覧").locator('tbody tr[data-key="T111"] .yn-row-link').click();
  await expect(page).toHaveURL(/\/team\?/);
  expect(query(page).get("id")).toBe("T111");
  await waitForPage(page);
  await page.getByRole("link", { name: "このチームの契約一覧へ" }).click();
  await expect(page).toHaveURL(/\/contracts\?/);
  expect(query(page).get("team")).toBe("T111");
  await waitForPage(page);
  await gotoPage(page, "/?team="); // 直前に保存された team=T111 を外す
  const sum = tableByCaption(page, "チーム別の集計");
  const key = (await rowKeys(sum))[0]!;
  await sum.locator(`tbody tr[data-key="${key}"] .yn-row-link`).click();
  await expect(page).toHaveURL(/\/team\?/);
  expect(query(page).get("id")).toBe(key);
  // チーム詳細は独立したタブを持たず、上部の「チーム」タブが選択状態になる
  await expect(page.locator(".yn-tabs a").filter({ hasText: "チーム" })).toHaveAttribute("aria-current", "page");
});

test("キーボード: フィルタ・並べ替え・行リンク・数値ボタンに Tab で到達できる", async ({ page }) => {
  await gotoPage(page, "/team?id=S21&unit=yen");
  const targets: Record<string, string> = { 期間: "#yn-filter-from", 並べ替え: "th button.yn-sort", 行リンク: ".yn-row-link", 数値ボタン: "td button.yn-num", Excel出力: ".yn-export", パンくず: 'nav[aria-label="パンくず"] a' };
  const reached = new Set<string>();
  await page.locator("body").press("Tab").catch(() => {});
  for (let i = 0; i < 500 && reached.size < Object.keys(targets).length; i++) {
    const hit = await page.evaluate((t) => {
      const el = document.activeElement;
      if (!el || el === document.body) return [];
      return Object.entries(t).filter(([, s]) => el.matches(s)).map(([n]) => n);
    }, targets);
    for (const n of hit) reached.add(n);
    await page.keyboard.press("Tab");
  }
  expect([...reached].sort()).toEqual(Object.keys(targets).sort());
  // 表はすべて caption と th scope を持つ
  const tables = page.locator("table.yn-table").filter({ has: page.locator("tbody tr[data-key]") });
  for (let i = 0; i < (await tables.count()); i++) await expect(tables.nth(i).locator("caption")).toHaveCount(1);
  await expect(page.locator("h1")).toHaveCount(1);
});

test.describe("狭幅（390px）", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  for (const id of ["S21", "T212", "NOPE"]) {
    test(`/team?id=${id}: 横スクロールが発生しない`, async ({ page }) => {
      await gotoPage(page, `/team?id=${id}&unit=yen`);
      await page.waitForLoadState("networkidle");
      const m = () => page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, cw: document.scrollingElement!.clientWidth }));
      const a = await m();
      expect(a.sw).toBeLessThanOrEqual(a.cw + 1);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const b = await m();
      expect(b.sw).toBeLessThanOrEqual(b.cw + 1);
    });
  }
});

test.describe("ダーク・1024px", () => {
  test.beforeEach(async ({ page }) => {
    await useDarkTheme(page);
  });
  test("背景が暗く、グラフと凡例が出る", async ({ page }) => {
    await gotoPage(page, "/team?id=S21&unit=yen");
    await page.waitForLoadState("networkidle");
    const lum = await page.evaluate(() => {
      const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g)!.map(Number);
      return (0.2126 * m[0]! + 0.7152 * m[1]! + 0.0722 * m[2]!) / 255;
    });
    expect(lum).toBeLessThan(0.25);
    await expect(page.locator(".yn-legend").first()).toBeVisible();
  });
});

test.describe("1024px 幅", () => {
  test.use({ viewport: { width: 1024, height: 800 } });
  test("契約一覧の標準列が収まる（ページの横スクロールなし）", async ({ page }) => {
    await gotoPage(page, "/team?id=S21&unit=yen");
    await page.waitForLoadState("networkidle");
    const { sw, cw } = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, cw: document.scrollingElement!.clientWidth }));
    expect(sw).toBeLessThanOrEqual(cw + 1);
    await expect(tableByCaption(page, "チームの契約一覧").locator("thead th").nth(1)).toBeVisible();
  });
});
