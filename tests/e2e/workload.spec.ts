/**
 * 工数（SPEC §30）: /workload と詳細画面の「作業種別の内訳」
 *   - KPI・軸ごとの表・作業種別の表が core（workTotals / aggregateWork / workByTask）と一致
 *   - 契約外は案件の実績に入らない（案件詳細の内訳の合計 = 案件の実績）
 *   - 軸の切替が URL に残る、内訳パネル、チーム絞り込み、Excel、ダーク・390px で横スクロールなし
 */
import { aggregateWork, elapsedMonthCount, filterWorkRows, memberTeamsAt, personMonths, workByTask, workTotals, type WorkRow } from "../../src/core/index.js";
import { test, expect, useDarkTheme, gotoPage, tableByCaption, dataRows, headerIndex, col, cellText, kpiValue, dialog, dialogRow, query } from "./helpers/app.js";
import { fiscalPeriod, getModel, treeAt, aggregate } from "./helpers/core.js";

const model = getModel();
const FY = fiscalPeriod(model);
const STD = model.config.standardHoursPerMonth;
const pmText = (h: number) => `${new Intl.NumberFormat("ja-JP", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Math.round(personMonths(h, STD) * 100) / 100)}人月`;
const hoursText = (h: number) => `${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 }).format(h)}h`;
const rows: WorkRow[] = model.workRows;
const axisBtn = (page: import("@playwright/test").Page, axis: string) => page.locator(`.yn-work-axis button[data-axis="${axis}"]`);
const inFy = filterWorkRows(rows, { period: FY });
const totals = workTotals(inFy, elapsedMonthCount(FY, model.meta.asOfMonth));

test.describe("工数 /workload", () => {
  test("ダミーデータに契約外の工数がある（前提）", () => {
    expect(totals.outsideHours).toBeGreaterThan(0);
    expect(totals.contractHours).toBeGreaterThan(0);
  });

  test("KPI が core と一致し、タブ「工数」が選択される", { tag: "@smoke" }, async ({ page }) => {
    await gotoPage(page, `/workload?from=${FY.from}&to=${FY.to}`);
    await expect(page.getByRole("link", { name: "工数", exact: true }).first()).toHaveAttribute("aria-current", "page");
    await expect(kpiValue(page, 0)).toHaveText(pmText(totals.contractHours));
    await expect(kpiValue(page, 1)).toHaveText(pmText(totals.outsideHours));
    await expect(kpiValue(page, 2)).toHaveText(`${totals.memberCount}人`);
    // 内訳: 契約外の行に作業種別ごとの時間が出る
    await kpiValue(page, 1).click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    expect(await dialogRow(page, "契約外")).toContain(hoursText(totals.outsideHours));
    for (const l of workByTask(inFy).filter((x) => x.category === "outside")) await expect(d).toContainText(l.task);
    await page.keyboard.press("Escape");
  });

  test("所属チーム別: 木の各行が aggregateWork と一致", async ({ page }) => {
    await gotoPage(page, `/workload?from=${FY.from}&to=${FY.to}`);
    const tree = treeAt(FY.to < model.meta.asOfMonth ? FY.to : model.meta.asOfMonth);
    const rootTeamIds = Object.values(tree).filter((n) => n.parentTeamId === null).map((n) => n.teamId);
    const groups = aggregateWork(model, inFy, { period: FY, axis: "team", tree, rootTeamIds, unassignedLabel: "未所属" });
    const table = tableByCaption(page, "所属チームごとの工数");
    const h = await headerIndex(table);
    await expect(dataRows(table)).toHaveCount(groups.length);
    // 分布のグラフ: 末端の組織だけを並べる（上位は配下の合計で二重になるため）
    const chart = page.locator('[aria-label="所属チームごとの工数の分布（契約内と契約外の人月の横積み上げ棒）"]');
    await expect(chart).toBeVisible();
    // 末端が 20 を超えるときは合計の多い上位 20 件（長い名前は … で切れるので先頭 6 文字で照合）
    const leafGroups = groups.filter((g) => !g.hasChildren);
    const byTotal = [...leafGroups].sort((a, b) => b.totals.contractHours + b.totals.outsideHours - (a.totals.contractHours + a.totals.outsideHours));
    const shown = byTotal.slice(0, 20).map((g) => g.label);
    const labels = (await chart.locator("text").allTextContents()).join("\n");
    for (const name of shown) expect(labels, name).toContain([...name].slice(0, 6).join(""));
    if (leafGroups.length > 20) {
      await expect(page.locator(".yn-note", { hasText: "上位 20 件" })).toBeVisible();
      // 少ない方は出さない（上位 20 件と先頭 6 文字が重ならない名前で確かめる）
      const head = (n: string) => [...n].slice(0, 6).join("");
      const hidden = byTotal.slice(20).map((g) => g.label).filter((n) => !shown.some((s) => head(s) === head(n)));
      for (const name of hidden) expect(labels, name).not.toContain(head(name));
    }
    await expect(chart.locator("text", { hasText: "ソリューション事業本部" })).toHaveCount(0);
    for (const g of groups) {
      const row = table.locator(`tbody tr[data-key="${g.key}"]`);
      expect(await cellText(row, col(h, "契約内"))).toBe(pmText(g.totals.contractHours));
      expect(await cellText(row, col(h, "契約外"))).toBe(pmText(g.totals.outsideHours));
    }
  });

  test("軸の切替（顧客・メンバー）が URL に残り、戻っても復元される", async ({ page }) => {
    await gotoPage(page, `/workload?from=${FY.from}&to=${FY.to}`);
    await axisBtn(page, "customer").click();
    await expect(axisBtn(page, "customer")).toHaveAttribute("aria-pressed", "true");
    expect(query(page).get("axis")).toBe("customer");
    const byCustomer = aggregateWork(model, inFy, { period: FY, axis: "customer", unassignedLabel: "-" });
    const table = tableByCaption(page, "顧客ごとの工数");
    await expect(dataRows(table)).toHaveCount(byCustomer.length);
    // 案件の無い顧客（契約外だけ）は詳細へのリンクにしない
    const onlyOutside = byCustomer.find((g) => g.totals.contractHours === 0);
    expect(onlyOutside).toBeTruthy();
    await expect(table.locator(`tbody tr[data-key="${onlyOutside!.key}"]`)).not.toHaveClass(/is-clickable/);

    await axisBtn(page, "member").click();
    expect(query(page).get("axis")).toBe("member");
    const byMember = aggregateWork(model, inFy, { period: FY, axis: "member", unassignedLabel: "-" });
    const mt = tableByCaption(page, "メンバーごとの工数");
    await expect(dataRows(mt)).toHaveCount(byMember.length);
    const h = await headerIndex(mt);
    const top = byMember.find((g) => g.totals.outsideHours > 0)!;
    expect(await cellText(mt.locator(`tbody tr[data-key="${top.key}"]`), col(h, "契約外"))).toBe(pmText(top.totals.outsideHours));
    // 行クリックでメンバー詳細 → 戻ると軸が復元
    await mt.locator(`tbody tr[data-key="${top.key}"] th`).click();
    await expect(page).toHaveURL(/\/member\?/);
    await page.goBack();
    await expect(axisBtn(page, "member")).toHaveAttribute("aria-pressed", "true");
  });

  test("チームで絞ると、その所属の人だけになる", async ({ page }) => {
    const teamId = "T111";
    await gotoPage(page, `/workload?from=${FY.from}&to=${FY.to}&team=${teamId}`);
    const base = FY.to < model.meta.asOfMonth ? FY.to : model.meta.asOfMonth;
    const tree = treeAt(base);
    const teams = memberTeamsAt(model, inFy, base);
    const ids = new Set([...teams.entries()].filter(([, t]) => t !== null && tree[teamId]!.descendantIds.includes(t)).map(([id]) => id));
    const t = workTotals(inFy.filter((r) => ids.has(r.memberId)), elapsedMonthCount(FY, model.meta.asOfMonth));
    await expect(kpiValue(page, 0)).toHaveText(pmText(t.contractHours));
    await expect(kpiValue(page, 1)).toHaveText(pmText(t.outsideHours));
  });

  test("作業種別の表: 契約内の実績の合計 = 全案件の実績、契約外は「対象外」", async ({ page }) => {
    await gotoPage(page, `/workload?from=${FY.from}&to=${FY.to}&unit=yen`);
    const table = tableByCaption(page, "作業種別の内訳");
    const h = await headerIndex(table);
    const lines = workByTask(inFy);
    await expect(dataRows(table)).toHaveCount(lines.length);
    const foot = table.locator("tfoot tr");
    const all = aggregate(model, { period: FY });
    expect(await cellText(foot, col(h, "実績"))).toBe(`${new Intl.NumberFormat("ja-JP").format(all.cost)}円`);
    const outsideRow = table.locator(`tbody tr[data-key^="outside:"]`).first();
    expect(await cellText(outsideRow, col(h, "実績"))).toBe("対象外");
  });

  test("ダーク・390px でも横スクロールしない", async ({ page }) => {
    await useDarkTheme(page);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const axis of ["team", "customer", "member"]) {
      await gotoPage(page, `/workload?from=${FY.from}&to=${FY.to}&axis=${axis}`);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(over, axis).toBeLessThanOrEqual(0);
    }
  });
});

test.describe("詳細画面の作業種別の内訳", () => {
  test("案件詳細: 契約内の合計 = 案件の実績・時間、契約外は合計に入らない", async ({ page }) => {
    const id = "C002";
    await gotoPage(page, `/contract?id=${id}&from=${FY.from}&to=${FY.to}&unit=yen`);
    const table = tableByCaption(page, "作業種別の内訳");
    await expect(table).toBeVisible();
    const h = await headerIndex(table);
    const t = aggregate(model, { period: FY, contractIds: [id] });
    const foot = table.locator("tfoot tr");
    expect(await cellText(foot, col(h, "時間"))).toBe(hoursText(t.hours));
    expect(await cellText(foot, col(h, "実績"))).toBe(`${new Intl.NumberFormat("ja-JP").format(t.cost)}円`);
    const outside = filterWorkRows(rows, { period: FY, contractIds: [id] }).filter((r) => r.category === "outside");
    expect(outside.length).toBeGreaterThan(0);
    // 契約外を実績に含めない旨は本文に出さず、見出しの「?」（§37）
    await expect(page.locator(".yn-note").filter({ hasText: "契約外の合計" })).toHaveCount(0);
    await expect(page.locator(".yn-work-section .yn-tip-pop").first()).toContainText("契約外は案件の実績");
  });

  test("メンバー・チーム・顧客の詳細にも出る", async ({ page }) => {
    for (const path of [`/member?id=M010`, `/team?id=T111`, `/customer?key=${encodeURIComponent("青葉物流")}`]) {
      await gotoPage(page, `${path}&from=${FY.from}&to=${FY.to}`);
      await expect(tableByCaption(page, "作業種別の内訳"), path).toBeVisible();
    }
  });
});
