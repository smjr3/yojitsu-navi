/**
 * 応援・ヘルプ（SPEC §72）: 担当チームの外の人（応援）と、所属チームの無い他部署の人（ヘルプ）を見分ける
 */
import { test, expect, gotoPage, tableByCaption, headerIndex, col, cellText, parseNumber, rowKeys } from "./helpers/app.js";
import { fiscalPeriod, getModel, teamContractIds, treeAt, yen } from "./helpers/core.js";
import { originTotals, ownTeamScope, teamMemberCosts } from "../../src/core/index.js";

const model = getModel();
const FY = fiscalPeriod(model);
const tree = treeAt(FY.to, model);
const contract = (id: string) => model.contracts.find((r) => r.contract.contractId === id)!.contract;
const kpiCostSub = (page: import("@playwright/test").Page) => page.locator(".yn-kpi-grid").first().locator(".yn-kpi").nth(1).locator(".yn-kpi-sub");

test("案件詳細: 他部署の人に「ヘルプ」、所属は部・課。実績の KPI に「うち…ヘルプ」が core と一致 @smoke", async ({ page }) => {
  const c = contract("C002");
  const rows = teamMemberCosts(model, ["C002"], FY, ownTeamScope(tree, c.teamId));
  const help = rows.filter((r) => r.helpHours > 0);
  expect(help.map((r) => r.memberId), "ダミーデータに他部署のヘルプがある").toContain("M301");
  await gotoPage(page, "/contract?id=C002&unit=yen");
  const table = tableByCaption(page, "メンバー別の実績");
  expect(new Set(await rowKeys(table))).toEqual(new Set(rows.map((r) => r.memberId)));
  const h = await headerIndex(table);
  for (const r of rows) {
    const row = table.locator(`tbody tr[data-key="${r.memberId}"]`);
    await expect(row.locator('[data-origin="help"]')).toHaveCount(r.helpHours > 0 ? 1 : 0);
    await expect(row.locator('[data-origin="support"]')).toHaveCount(r.supportHours > 0 ? 1 : 0);
    expect(parseNumber(await cellText(row, col(h, "実績")))).toBe(r.amount);
  }
  const m301 = table.locator('tbody tr[data-key="M301"]');
  await expect(m301.locator('[data-origin="help"]')).toHaveText("ヘルプ");
  await expect(m301.locator('[data-origin="help"]')).toHaveAttribute("title", /他部署/);
  expect(await cellText(m301, col(h, "所属（当時）"))).toBe("システム構築部 基盤構築課");
  const o = originTotals(rows);
  expect(o.helpAmount).toBeGreaterThan(0);
  await expect(kpiCostSub(page).locator("[data-origin]")).toContainText(`ヘルプ ${yen(o.helpAmount)}`);
  if (o.supportHours > 0) await expect(kpiCostSub(page).locator("[data-origin]")).toContainText(`応援 ${yen(o.supportAmount)}`);
});

test("案件詳細: メンバーマスタに無い人もヘルプ。所属は「マスタ未登録」、チップの説明は単価 0 円", async ({ page }) => {
  await gotoPage(page, "/contract?id=C011&unit=yen");
  const table = tableByCaption(page, "メンバー別の実績");
  const row = table.locator('tbody tr[data-key="M099"]');
  const h = await headerIndex(table);
  await expect(row.locator('[data-origin="help"]')).toHaveAttribute("title", /メンバーマスタに無い/);
  expect(await cellText(row, col(h, "所属（当時）"))).toBe("マスタ未登録");
  expect(parseNumber(await cellText(row, col(h, "実績")))).toBe(0);
});

test("案件詳細: 応援もヘルプも無い案件では KPI に内訳を出さない", async ({ page }) => {
  const plain = model.contracts.find((r) => {
    const rs = teamMemberCosts(model, [r.contract.contractId], FY, ownTeamScope(tree, r.contract.teamId));
    const o = originTotals(rs);
    return rs.length > 0 && o.helpHours === 0 && o.supportHours === 0 && r.contract.startMonth <= FY.from && FY.to <= r.contract.endMonth;
  });
  test.skip(!plain, "応援・ヘルプの無い案件がない");
  await gotoPage(page, `/contract?id=${plain!.contract.contractId}&unit=yen`);
  await expect(kpiCostSub(page)).toBeVisible();
  await expect(kpiCostSub(page).locator("[data-origin]")).toHaveCount(0);
});

test("チーム詳細: 課長（上位の組織）の作業は応援にしない。ヘルプは KPI とメンバー表に出る", async ({ page }) => {
  const ids = teamContractIds("T111", FY, model)!;
  const rows = teamMemberCosts(model, ids, FY, ownTeamScope(tree, "T111"));
  const leader = rows.find((r) => r.memberId === "M004");
  if (leader) expect(leader.supportHours, "課長 M004 は T111 の上位 S11 所属").toBe(0);
  await gotoPage(page, "/team?id=T111&unit=yen");
  const table = tableByCaption(page, "メンバー別の実績");
  if (leader) await expect(table.locator('tbody tr[data-key="M004"] [data-origin]')).toHaveCount(0);
  await expect(table.locator('tbody tr[data-key="M301"] [data-origin="help"]')).toHaveText("ヘルプ");
  const o = originTotals(rows);
  await expect(kpiCostSub(page).locator("[data-origin]")).toContainText(`ヘルプ ${yen(o.helpAmount)}`);
});
