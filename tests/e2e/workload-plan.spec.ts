/**
 * 稼働実績を他の画面並みに（SPEC §149）
 *   - 計画との差（確定した月）: 計画より多い＝黄、計画なし＝赤紫、根拠は月ごと
 *   - まとめ方「案件」と、行を開くと内訳（案件 → メンバー、メンバー → 案件）
 *   - 表示「合計｜月ごと」、先頭 10 行＋すべて表示、不在の人を隠す、マスタに無い人 → データ確認
 *   - 月次推移の単位（日・週・月・四半期・年度）と計画の線、棒を押すと作業した人
 *   - 色: 実績の側（運用保守＝橙）。紫（目標）は使わない
 */
import { aggregateWork, compareWorkPlan, confirmedPeriodOf, filterWorkRows, groupWorkPlans, isUnknownMember, memberLeftAt, personMonths, workPlanRows } from "../../src/core/index.js";
import { test, expect, useDarkTheme, gotoPage, tableByCaption, dataRows, headerIndex, col, cellText, dialog, query, showAllRows } from "./helpers/app.js";
import { fiscalPeriod, getModel } from "./helpers/core.js";

const model = getModel();
const FY = fiscalPeriod(model);
const STD = model.config.standardHoursPerMonth;
const BASE = FY.to < model.meta.asOfMonth ? FY.to : model.meta.asOfMonth;
const inFy = filterWorkRows(model.workRows, { period: FY });
const plansFy = workPlanRows(model.memberMonths).filter((p) => p.month >= FY.from && p.month <= FY.to);
const judged = confirmedPeriodOf(model.meta, FY);
const pmText = (h: number) => `${new Intl.NumberFormat("ja-JP", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Math.round(personMonths(h, STD) * 100) / 100)}人月`;
const pmSigned = (h: number) => (Math.abs(personMonths(h, STD)) < 0.005 ? pmText(0) : `${h > 0 ? "+" : "−"}${pmText(Math.abs(h))}`);
const contractLabel = (id: string) => {
  const c = model.contracts.find((x) => x.contract.contractId === id)?.contract;
  return c ? `${c.customerName} / ${c.projectName}` : "関連する案件なし";
};
const byMember = aggregateWork(model, inFy, { period: FY, axis: "member", unassignedLabel: "-" });
const plansByMember = groupWorkPlans(plansFy, (p) => p.memberId);
const cmpOf = (g: (typeof byMember)[number]) => compareWorkPlan(plansByMember.get(g.key) ?? [], g.rows, judged);
const shown = byMember.filter((g) => memberLeftAt(model, g.key, BASE) === null);

test.describe("稼働実績 §149", () => {
  test("前提: ダミーデータに計画より多い人・計画なしの人・不在の人・マスタに無い人がいる", () => {
    expect(judged).not.toBeNull();
    expect(shown.some((g) => cmpOf(g).kind === "over")).toBe(true);
    expect(shown.some((g) => cmpOf(g).kind === "unplanned")).toBe(true);
    expect(byMember.some((g) => memberLeftAt(model, g.key, BASE) !== null)).toBe(true);
    expect(byMember.some((g) => isUnknownMember(model, g.key))).toBe(true);
  });

  test("メンバー: 計画との差が core と一致し、計画より多いと黄・計画なしは赤紫、根拠に月ごと", { tag: "@smoke" }, async ({ page }) => {
    await gotoPage(page, `/workload?from=${FY.from}&to=${FY.to}&axis=member`);
    const table = tableByCaption(page, "メンバーごとの稼働実績");
    await showAllRows(table);
    const h = await headerIndex(table);
    const over = shown.find((g) => cmpOf(g).kind === "over")!;
    const none = shown.find((g) => cmpOf(g).kind === "unplanned")!;
    const overCell = table.locator(`tbody tr[data-key="${over.key}"] > *`).nth(col(h, "計画との差"));
    expect(await cellText(table.locator(`tbody tr[data-key="${over.key}"]`), col(h, "計画との差"))).toBe(pmSigned(cmpOf(over).diffHours));
    await expect(overCell).toHaveClass(/yn-gap-over/);
    const noneCell = table.locator(`tbody tr[data-key="${none.key}"] > *`).nth(col(h, "計画との差"));
    await expect(noneCell).toHaveClass(/yn-gap-none/);
    await expect(noneCell).toContainText("計画なし");
    // 色: 黄（警告の地）と赤紫（計画なしの地）
    const bg = async (l: import("@playwright/test").Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await bg(overCell)).not.toBe(await bg(noneCell));
    // 根拠: 確定した月ごとの計画・実績
    await overCell.locator("button").click();
    const d = dialog(page);
    await expect(d).toContainText("計画との差");
    await expect(d.locator("tbody tr")).toHaveCount([...cmpOf(over).byMonth.values()].filter((m) => m.judged).length);
  });

  test("不在の人は既定で隠し、「不在の人も表示」で出す（URL f=left）", async ({ page }) => {
    await gotoPage(page, `/workload?from=${FY.from}&to=${FY.to}&axis=member`);
    const table = tableByCaption(page, "メンバーごとの稼働実績");
    await showAllRows(table);
    await expect(dataRows(table)).toHaveCount(shown.length);
    await expect(page.locator(".yn-section-hint", { hasText: `不在の人 ${byMember.length - shown.length}人は非表示` })).toBeVisible();
    await page.locator("#yn-w-left").check();
    expect(query(page).get("f")).toBe("left");
    await showAllRows(table);
    await expect(dataRows(table)).toHaveCount(byMember.length);
  });

  test("先頭 10 行＋すべて表示、マスタに無い人はデータ確認の節へ", async ({ page }) => {
    await gotoPage(page, `/workload?from=${FY.from}&to=${FY.to}&axis=member`);
    const table = tableByCaption(page, "メンバーごとの稼働実績");
    await expect(dataRows(table)).toHaveCount(10);
    const unknownN = shown.filter((g) => isUnknownMember(model, g.key)).length;
    const link = page.locator("#yn-w-check");
    await expect(link).toHaveText(`マスタに無い人 ${unknownN}人`);
    await link.click();
    await expect(page).toHaveURL(/\/data-check(\.html)?#dc-unknown$/);
    await expect(page.locator("#dc-unknown")).toBeInViewport();
  });

  test("案件: 案件ごとの行、開くとメンバーごと（行から案件・メンバーの詳細へ）", async ({ page }) => {
    await gotoPage(page, `/workload?from=${FY.from}&to=${FY.to}`);
    await page.locator('.yn-work-axis button[data-axis="contract"]').click();
    expect(query(page).get("axis")).toBe("contract");
    const groups = aggregateWork(model, inFy, { period: FY, axis: "contract", unassignedLabel: "関連する案件なし", contractLabel });
    const table = tableByCaption(page, "案件ごとの稼働実績");
    await showAllRows(table);
    await expect(dataRows(table)).toHaveCount(groups.length);
    const h = await headerIndex(table);
    const top = groups[0]!;
    const tr = table.locator(`tbody tr[data-key="${top.key}"]`);
    expect(await cellText(tr, col(h, "運用保守"))).toBe(pmText(top.totals.contractHours));
    await expect(tr).toContainText(contractLabel(top.key));
    await tr.locator(".yn-tree-toggle").click();
    await expect(tr.locator(".yn-tree-toggle")).toHaveAttribute("aria-expanded", "true");
    const subs = aggregateWork(model, top.rows, { period: FY, axis: "member", unassignedLabel: "-" });
    await expect(table.locator("tbody tr.is-sub")).toHaveCount(subs.length);
    const first = table.locator("tbody tr.is-sub").first();
    expect(await cellText(first, col(h, "運用保守"))).toBe(pmText(subs[0]!.totals.contractHours));
    await expect(first.locator("a.yn-row-link")).toHaveAttribute("href", new RegExp(`member(\\.html)?\\?.*id=${subs[0]!.key}`));
    // 閉じると消える。合計行（tfoot）は開いても変わらない
    await tr.locator(".yn-tree-toggle").click();
    await expect(table.locator("tbody tr.is-sub")).toHaveCount(0);
  });

  test("月ごと: 月の列に運用保守の人月、確定した月は計画と比べて色、速報の月は色なし", async ({ page }) => {
    await gotoPage(page, `/workload?from=${FY.from}&to=${FY.to}&axis=member&view=months`);
    await expect(page.locator('.yn-work-view button[data-view="months"]')).toHaveAttribute("aria-pressed", "true");
    const table = tableByCaption(page, "メンバーごとの稼働実績");
    await showAllRows(table);
    const g = shown.find((x) => [...cmpOf(x).byMonth.values()].some((m) => m.judged && m.kind === "over"))!;
    const m = [...cmpOf(g).byMonth.values()].find((x) => x.judged && x.kind === "over")!;
    const key = `m:${m.month}`;
    const idx = await table.locator("thead th").evaluateAll((ths, k) => ths.findIndex((t) => (t as HTMLElement).dataset.key === k), key);
    expect(idx).toBeGreaterThan(0);
    const cell = table.locator(`tbody tr[data-key="${g.key}"] > *`).nth(idx);
    await expect(cell).toHaveText((m.actualHours / STD).toFixed(2));
    await expect(cell).toHaveClass(/yn-gap-over/);
    // 「合計」に戻すと月の列は消える
    await page.locator('.yn-work-view button[data-view="total"]').click();
    expect(query(page).get("view")).toBeNull();
    await expect(table.locator(`thead th[data-key="${key}"]`)).toHaveCount(0);
  });

  test("月次推移: 計画の線と単位の切り替え、棒を押すと作業した人", async ({ page }) => {
    await gotoPage(page, `/workload?from=${FY.from}&to=${FY.to}`);
    const fig = page.locator(".yn-unit-figure");
    const plot = fig.locator('svg[aria-label^="稼働実績の推移"], [aria-label^="稼働実績の推移"]').first();
    await expect(plot).toHaveAttribute("aria-label", /月ごと/);
    await expect(fig.locator(".yn-legend")).toContainText("計画（運用保守）");
    // 色: 運用保守は実績の橙。紫（目標の上限）は使わない
    const fills = await plot.locator("rect").evaluateAll((rs) => rs.map((r) => r.getAttribute("fill") ?? ""));
    expect(fills.some((f) => /#eb6834/i.test(f))).toBe(true);
    expect(fills.some((f) => /#7a5bc7|#7b3fd1/i.test(f))).toBe(false);
    await fig.locator('.yn-chart-unit [data-unit="quarter"]').click();
    await expect(plot).toHaveAttribute("aria-label", /四半期ごと/);
    await fig.locator('.yn-chart-unit [data-unit="day"]').click();
    await expect(plot).toHaveAttribute("aria-label", /日ごと/);
    // 実績のある日を押す（左寄り＝範囲の最初の月。休日に当たったら隣の日）
    await plot.scrollIntoViewIfNeeded();
    const box = (await plot.boundingBox())!;
    const d = dialog(page);
    const people = d.locator(".yn-bd-section").filter({ hasText: "作業した人" }).locator("tbody tr");
    for (const rx of [0.12, 0.13, 0.14, 0.15, 0.16, 0.17]) {
      await page.mouse.move(box.x + box.width * rx - 4, box.y + box.height * 0.5);
      await page.mouse.move(box.x + box.width * rx, box.y + box.height * 0.6, { steps: 3 });
      await page.mouse.click(box.x + box.width * rx, box.y + box.height * 0.6);
      await expect(d.locator(".yn-dialog-title")).toContainText("の稼働実績");
      if ((await people.count()) > 0) break;
      await page.keyboard.press("Escape");
    }
    await expect(people.first()).toBeVisible();
    await page.keyboard.press("Escape");
    // 単位は覚える（月に戻しておく）
    await page.reload();
    await expect(page.locator(".yn-unit-figure .yn-chart-unit [data-unit=\"day\"]")).toHaveAttribute("aria-pressed", "true");
    await page.locator('.yn-unit-figure .yn-chart-unit [data-unit="month"]').click();
  });

  test("ダーク・390px: 案件・月ごと・開いた内訳でも横にはみ出さない", async ({ page }) => {
    await useDarkTheme(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoPage(page, `/workload?from=${FY.from}&to=${FY.to}&axis=contract&view=months`);
    const table = tableByCaption(page, "案件ごとの稼働実績");
    await table.locator("tbody tr .yn-tree-toggle").first().click();
    await expect(table.locator("tbody tr.is-sub").first()).toBeVisible();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(over).toBeLessThanOrEqual(0);
  });
});
