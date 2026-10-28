/**
 * メンバー別（SPEC §18）: 一覧 /members と詳細 /member?id=
 *   - 数値が core（aggregateMembers / memberMonthlySeries）と一致（比較は経過月）
 *   - 内訳パネル（計画 = 配分 × 基準時間 × 単価、実績 = 実績行 → 作業ログ）
 *   - 遷移（一覧 → 詳細 → 契約詳細、契約詳細 → メンバー詳細）、チーム絞り込み、検索
 *   - Excel 出力、a11y（見出し・キーボード）、赤を使わない、ダーク、390px
 * 金額は既定単位に依存しないよう URL に unit=yen を付ける。
 */
import { createRequire } from "node:module";
import { aggregateMembers, memberMonthlySeries, type Period } from "../../src/core/index.js";
import { test, expect, useDarkTheme, gotoPage, tableByCaption, dataRows, headerIndex, col, cell, cellText, kpiValue, dialog, dialogRow, query } from "./helpers/app.js";
import { fiscalPeriod, getModel, treeAt, yen, formatPercent } from "./helpers/core.js";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx") as typeof import("xlsx");

const model = getModel();
const FY = fiscalPeriod(model);
const ASOF = model.meta.asOfMonth;
/** 比較の期間（経過月）= 期間開始〜min(期間終了, 基準月) */
const elapsed = (p: Period): Period => ({ from: p.from, to: p.to < ASOF ? p.to : ASOF });
const CMP = elapsed(FY);
const U = "unit=yen";

const hoursText = (h: number) => `${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 }).format(h)}h`;
/** moneySigned と同じ（+ / ± を付ける） */
const signed = (v: number) => (Math.round(v) === 0 ? `±${yen(0)}` : v < 0 ? yen(v) : `+${yen(v)}`);

async function rowByKey(page: import("@playwright/test").Page, caption: string, key: string) {
  return tableByCaption(page, caption).locator(`tbody tr[data-key="${key}"]`);
}

test.describe("メンバー一覧 /members", () => {
  test("KPI・全行・合計行が core の aggregateMembers（経過月）と一致し、経過月の注記が出る", async ({ page }) => {
    await gotoPage(page, `/members?from=${FY.from}&to=${FY.to}&${U}`);
    const agg = aggregateMembers(model, { period: CMP });
    const full = aggregateMembers(model, { period: FY });
    await expect(kpiValue(page, 0)).toHaveText(yen(agg.total.plannedCost));
    await expect(kpiValue(page, 1)).toHaveText(yen(agg.total.actualCost));
    await expect(kpiValue(page, 2)).toHaveText(signed(agg.total.variance));
    await expect(kpiValue(page, 3)).toHaveText(formatPercent(agg.total.utilization));
    await expect(page.locator(".yn-note").filter({ hasText: "経過月" }).first()).toContainText(yen(full.total.plannedCost));

    const table = tableByCaption(page, "メンバー別の計画と実績");
    const h = await headerIndex(table);
    const rows = dataRows(table);
    await expect(rows).toHaveCount(agg.members.length);
    for (const m of agg.members) {
      const row = table.locator(`tbody tr[data-key="${m.memberId}"]`);
      await expect(cell(row, 0)).toContainText(m.memberName);
      expect(await cellText(row, col(h, "計画時間"))).toBe(hoursText(m.plannedHours));
      expect(await cellText(row, col(h, "実績時間"))).toBe(hoursText(m.actualHours));
      expect(await cellText(row, col(h, "稼働率"))).toBe(formatPercent(m.utilization));
      expect(await cellText(row, col(h, "計画額"))).toBe(yen(m.plannedCost));
      expect(await cellText(row, col(h, "実績"))).toBe(yen(m.actualCost));
      expect(await cellText(row, col(h, "差額"))).toBe(signed(m.variance));
    }
    const foot = table.locator("tfoot tr");
    expect(await cellText(foot, col(h, "計画額"))).toBe(yen(agg.total.plannedCost));
    expect(await cellText(foot, col(h, "実績"))).toBe(yen(agg.total.actualCost));
    expect(await cellText(foot, col(h, "稼働率"))).toBe(formatPercent(agg.total.utilization));
    // 実績の合計は同じ期間の契約実績の合計と一致（コアの不変条件を画面でも）
    const cost = model.contracts.reduce((a, r) => a + r.months.filter((cm) => CMP.from <= cm.month && cm.month <= CMP.to).reduce((b, cm) => b + cm.cost, 0), 0);
    expect(agg.total.actualCost).toBe(cost);
  });

  test("チームで絞り込むと所属チーム（基準月、配下含む）のメンバーだけ。検索で絞ると合計行も表示中のメンバーで計算し直す", async ({ page }) => {
    const team = "S11";
    await gotoPage(page, `/members?from=${FY.from}&to=${FY.to}&team=${team}&${U}`);
    const tree = treeAt(ASOF);
    const ids = new Set(tree[team]!.descendantIds);
    const all = aggregateMembers(model, { period: CMP });
    const expected = all.members.filter((m) => m.teamId && ids.has(m.teamId)).map((m) => m.memberId);
    expect(expected.length).toBeGreaterThan(2);
    const table = tableByCaption(page, "メンバー別の計画と実績");
    await expect(dataRows(table)).toHaveCount(expected.length);
    const keys = await dataRows(table).evaluateAll((trs) => trs.map((tr) => tr.getAttribute("data-key")));
    expect([...keys].sort()).toEqual([...expected].sort());
    const teamAgg = aggregateMembers(model, { period: CMP, memberIds: expected });
    await expect(kpiValue(page, 1)).toHaveText(yen(teamAgg.total.actualCost));

    // 検索（全角・大文字小文字を区別しない）
    const target = all.members.find((m) => m.memberId === "M011")!;
    await gotoPage(page, `/members?from=${FY.from}&to=${FY.to}&${U}`);
    await page.locator("#yn-m-text").fill("ｍ011");
    await expect(dataRows(table)).toHaveCount(1);
    const h = await headerIndex(table);
    expect(await cellText(table.locator("tfoot tr"), col(h, "実績"))).toBe(yen(target.actualCost));
    await page.locator("#yn-m-text").fill("該当なしzzz");
    await expect(table.locator("tbody")).toContainText("検索に一致するメンバーがいません");
  });

  test("期間がすべて未来なら計画だけ（実績 0）で、注記が出る", async ({ page }) => {
    await gotoPage(page, `/members?from=2026-12&to=2027-03&${U}`);
    const agg = aggregateMembers(model, { period: { from: "2026-12", to: "2027-03" } });
    await expect(page.locator(".yn-note").filter({ hasText: "実績はまだありません" })).toBeVisible();
    await expect(kpiValue(page, 0)).toHaveText(yen(agg.total.plannedCost));
    await expect(kpiValue(page, 1)).toHaveText(yen(0));
  });

  test("内訳: 計画額は 配分 × 基準時間 × 単価 の明細、実績は実績行と作業ログ、稼働率・合計行も根拠を持つ", async ({ page }) => {
    await gotoPage(page, `/members?from=${FY.from}&to=${FY.to}&${U}`);
    const agg = aggregateMembers(model, { period: CMP });
    const m = agg.members.find((x) => x.memberId === "M011")!;
    const table = tableByCaption(page, "メンバー別の計画と実績");
    const h = await headerIndex(table);
    const row = await rowByKey(page, "メンバー別の計画と実績", "M011");

    await cell(row, col(h, "計画額")).locator("button.yn-num").click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).locator(".yn-bd-formula")).toContainText("配分人月 × 基準時間");
    expect(await dialogRow(page, "計画額")).toBe(yen(m.plannedCost));
    expect(await dialogRow(page, "計画時間")).toBe(hoursText(m.plannedHours));
    await expect(dialog(page).locator("table")).toContainText("役職「主任」（2026-04〜）");
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);

    await cell(row, col(h, "実績")).locator("button.yn-num").click();
    expect(await dialogRow(page, "実績")).toBe(yen(m.actualCost));
    await dialog(page).getByRole("button", { name: "作業ログを読み込む" }).click();
    await expect(dialog(page).locator(".yn-bd-lazy table")).toBeVisible();
    await expect(dialog(page).locator(".yn-bd-lazy tbody tr").first()).toContainText("M011");
    await page.keyboard.press("Escape");

    await cell(row, col(h, "稼働率")).locator("button.yn-num").click();
    expect(await dialogRow(page, "稼働率")).toBe(formatPercent(m.utilization));
    await page.keyboard.press("Escape");

    await table.locator("tfoot tr").locator("td").nth(col(h, "実績")).locator("button.yn-num").click();
    expect(await dialogRow(page, "実績（合計）")).toBe(yen(agg.total.actualCost));
    await page.keyboard.press("Escape");
  });

  test("行クリックでメンバー詳細へ（期間・単位を引き継ぐ）", async ({ page }) => {
    await gotoPage(page, `/members?from=${FY.from}&to=${FY.to}&${U}`);
    await (await rowByKey(page, "メンバー別の計画と実績", "M020")).locator(".yn-row-link").click();
    await expect(page).toHaveURL(/\/member\?/);
    await expect(page.locator("h1")).toContainText("斎藤");
    expect(query(page).get("id")).toBe("M020");
    expect(query(page).get("unit")).toBe("yen");
  });

  test("Excel 出力: 金額は円、見出しと値が core と一致", async ({ page }) => {
    await gotoPage(page, `/members?from=${FY.from}&to=${FY.to}&${U}`);
    const dl = page.waitForEvent("download");
    await page.locator(".yn-export").first().click();
    const download = await dl;
    // 出力するのは表示中の比較期間（経過月）
    expect(download.suggestedFilename()).toBe(`members_${CMP.from}_${CMP.to}.xlsx`);
    const wb = XLSX.readFile((await download.path())!);
    const aoa = XLSX.utils.sheet_to_json<Array<string | number | null>>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, defval: null });
    const hr = aoa.findIndex((r) => r.includes("メンバーID"));
    const header = aoa[hr]!.map((x) => String(x ?? ""));
    for (const label of ["メンバー", "メンバーID", "所属チーム", "役職", "区分", "計画時間（h）", "実績時間（h）", "稼働率（%）", "計画額（円）", "実績（円）", "差額（計画−実績）（円）", "状態"]) expect(header).toContain(label);
    const agg = aggregateMembers(model, { period: CMP });
    const body = aoa.slice(hr + 1).filter((r) => r[header.indexOf("メンバーID")]);
    expect(body).toHaveLength(agg.members.length);
    for (const r of body) {
      const m = agg.members.find((x) => x.memberId === r[header.indexOf("メンバーID")])!;
      expect(r[header.indexOf("計画額（円）")]).toBe(m.plannedCost);
      expect(r[header.indexOf("実績（円）")]).toBe(m.actualCost);
      expect(r[header.indexOf("差額（計画−実績）（円）")]).toBe(m.variance);
    }
  });
});

test.describe("メンバー詳細 /member", () => {
  test("M011: 基本情報・KPI・月次（期間全体）・契約別（経過月）・単価の変遷が core と一致", async ({ page }) => {
    await gotoPage(page, `/member?id=M011&from=${FY.from}&to=${FY.to}&${U}`);
    const t = aggregateMembers(model, { period: CMP, memberIds: ["M011"] }).members[0]!;
    await expect(page.locator("h1")).toContainText("小林 玲奈");
    await expect(page.locator(".yn-facts")).toContainText("主任");
    await expect(kpiValue(page, 0)).toHaveText(yen(t.plannedCost));
    await expect(kpiValue(page, 1)).toHaveText(yen(t.actualCost));
    await expect(kpiValue(page, 2)).toHaveText(signed(t.variance));
    await expect(kpiValue(page, 3)).toHaveText(formatPercent(t.utilization));

    // 月次: 期間全体の各月。未来月の実績は「—」
    const monthly = tableByCaption(page, "月ごとの計画と実績");
    const mh = await headerIndex(monthly);
    const series = memberMonthlySeries(model, "M011", FY);
    await expect(dataRows(monthly)).toHaveCount(series.length);
    for (const p of series) {
      const row = monthly.locator(`tbody tr[data-key="${p.month}"]`);
      expect(await cellText(row, col(mh, "計画時間"))).toBe(hoursText(p.plannedHours));
      expect(await cellText(row, col(mh, "計画額"))).toBe(yen(p.plannedCost));
      expect(await cellText(row, col(mh, "実績"))).toBe(p.month > ASOF ? "—" : yen(p.actualCost));
    }
    expect(await cellText(monthly.locator("tfoot tr"), col(mh, "実績"))).toBe(yen(t.actualCost));

    // 契約別（経過月）。アサインの無い契約は「アサインなし」
    const contracts = tableByCaption(page, "契約別の計画と実績");
    const ch = await headerIndex(contracts);
    await expect(dataRows(contracts)).toHaveCount(t.byContract.length);
    for (const c of t.byContract) {
      const row = contracts.locator(`tbody tr[data-key="${c.contractId}"]`);
      expect(await cellText(row, col(ch, "計画額"))).toBe(yen(c.plannedCost));
      expect(await cellText(row, col(ch, "実績"))).toBe(yen(c.actualCost));
      if (c.assignedMonths === 0) await expect(row).toContainText("アサインなし");
    }

    // 単価の変遷（昇格 2026-07: 一般 6,000 → 主任 8,500）
    const rates = tableByCaption(page, "単価の変遷");
    await expect(dataRows(rates)).toHaveCount(2);
    await expect(dataRows(rates).nth(1)).toContainText("8,500円");
    await expect(dataRows(rates).nth(1)).toContainText("主任");
  });

  test("月の根拠と契約の根拠、契約別の行から契約詳細へ、契約詳細のメンバー行からメンバー詳細へ", async ({ page }) => {
    await gotoPage(page, `/member?id=M011&from=${FY.from}&to=${FY.to}&${U}`);
    const monthly = tableByCaption(page, "月ごとの計画と実績");
    const mh = await headerIndex(monthly);
    const jul = monthly.locator('tbody tr[data-key="2026-07"]');
    await cell(jul, col(mh, "計画額")).locator("button.yn-num").click();
    const p = memberMonthlySeries(model, "M011", { from: "2026-07", to: "2026-07" })[0]!;
    expect(await dialogRow(page, "計画額")).toBe(yen(p.plannedCost));
    await expect(dialog(page).locator("table")).toContainText("8,500円");
    await page.keyboard.press("Escape");

    const contracts = tableByCaption(page, "契約別の計画と実績");
    await contracts.locator('tbody tr[data-key="C002"] .yn-row-link').click();
    await expect(page).toHaveURL(/\/contract\?/);
    expect(query(page).get("id")).toBe("C002");
    const members = tableByCaption(page, "メンバー別の実績");
    await members.locator('tbody tr[data-key="M011"] .yn-row-link').click();
    await expect(page).toHaveURL(/\/member\?/);
    expect(query(page).get("id")).toBe("M011");
    await expect(page.locator("h1")).toContainText("小林 玲奈");
  });

  test("未登録メンバー M099: マスタ未登録の表示、計画 0・稼働率は —", async ({ page }) => {
    await gotoPage(page, `/member?id=M099&from=${FY.from}&to=${FY.to}&${U}`);
    await expect(page.locator(".yn-facts")).toContainText("マスタ未登録");
    await expect(page.locator("h1")).toContainText("臨時 太郎");
    await expect(kpiValue(page, 0)).toHaveText(yen(0));
    await expect(kpiValue(page, 3)).toHaveText("—");
  });

  test("存在しない ID は空状態と一覧へのリンク", async ({ page }) => {
    await gotoPage(page, "/member?id=NOPE");
    await expect(page.locator(".yn-empty")).toContainText("メンバー NOPE は見つかりません");
    await page.getByRole("link", { name: "メンバー別へ戻る" }).click();
    await expect(page).toHaveURL(/\/members/);
  });
});

test.describe("表示の作法", () => {
  for (const path of [`/members?${U}`, `/member?id=M011&${U}`]) {
    test(`${path}: 赤を使わない（稼働率 100% 超・差額マイナスでも）、表の見出し・キーボード`, async ({ page }) => {
      await gotoPage(page, `${path}&from=${FY.from}&to=${FY.to}`);
      // 詳細の先頭の表（所属の変遷）は閉じた <details> の中なので、見えている表で待つ
      await expect(page.locator("table.yn-table:visible").first()).toBeVisible();
      await expect(page.locator(".yn-danger-text, .yn-chip-danger, tr.is-danger, .yn-kpi.is-danger")).toHaveCount(0);
      const tables = page.locator("table.yn-table").filter({ has: page.locator("tbody tr[data-key]") });
      for (let i = 0; i < (await tables.count()); i++) {
        await expect(tables.nth(i).locator("caption")).toHaveCount(1);
        await expect(tables.nth(i).locator("tbody tr[data-key]").first().locator("th[scope=row]")).toHaveCount(1);
      }
      // Tab で数値ボタンに到達し、Enter で内訳が開き Esc で戻る
      let reached = false;
      for (let i = 0; i < 80 && !reached; i++) {
        await page.keyboard.press("Tab");
        reached = await page.evaluate(() => document.activeElement?.matches("button.yn-num") ?? false);
      }
      expect(reached).toBe(true);
      await page.keyboard.press("Enter");
      await expect(dialog(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
      expect(await page.evaluate(() => document.activeElement?.matches("button.yn-num") ?? false)).toBe(true);
    });
  }

  test("1280px / 1024px で一覧の表が横スクロール無しで収まる", async ({ page }) => {
    for (const width of [1280, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      await gotoPage(page, `/members?from=${FY.from}&to=${FY.to}&${U}`);
      const wrap = page.locator(".yn-table-wrap").first();
      await expect(wrap).toBeVisible();
      const { sw, cw } = await wrap.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
      expect(sw, `${width}px`).toBeLessThanOrEqual(cw + 1);
    }
  });

  test("390px: ページに横スクロールが無い", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of [`/members?${U}`, `/member?id=M011&${U}`]) {
      await gotoPage(page, path);
      const { sw, cw } = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, cw: document.scrollingElement!.clientWidth }));
      expect(sw, path).toBeLessThanOrEqual(cw + 1);
    }
  });

  test.describe("ダーク", () => {
    test.beforeEach(async ({ page }) => {
      await useDarkTheme(page);
    });
    test("背景が暗く、グラフの凡例が出る", async ({ page }) => {
      await gotoPage(page, `/member?id=M011&${U}`);
      const lum = await page.evaluate(() => {
        const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g)!.map(Number);
        return (0.2126 * m[0]! + 0.7152 * m[1]! + 0.0722 * m[2]!) / 255;
      });
      expect(lum).toBeLessThan(0.25);
      await expect(page.locator(".yn-legend").first()).toContainText("計画時間");
    });
  });
});
