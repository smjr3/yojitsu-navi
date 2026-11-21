/**
 * 節の並び（SPEC §153）: 組織 → 案件の順
 * - 全体サマリー: チーム別 → 超過見込みの案件
 * - 顧客詳細: 担当チーム別 → この顧客の案件
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage } from "./helpers/app.js";
import { aggregate, fiscalPeriod, getModel } from "./helpers/core.js";
import { groupByCustomer } from "../../src/core/index.js";

const headingIndex = async (page: Page, first: string, second: string) => {
  const heads = page.locator("h2");
  await expect(heads.filter({ hasText: second })).toHaveCount(1);
  const titles = (await heads.allTextContents()).map((t) => t.trim());
  return [titles.findIndex((t) => t.startsWith(first)), titles.findIndex((t) => t.startsWith(second))] as const;
};

test("全体サマリーはチーム別を超過見込みの案件より上に出す", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/");
  const [team, deficit] = await headingIndex(page, "チーム別", "超過見込みの案件");
  expect(team).toBeGreaterThanOrEqual(0);
  expect(team).toBeLessThan(deficit);
});

test("顧客詳細は担当チーム別をこの顧客の案件より上に出す", async ({ page }) => {
  const model = getModel();
  const fy = fiscalPeriod(model);
  const g = groupByCustomer(model.contracts.map((r) => r.contract)).find((x) => aggregate(model, { period: fy, contractIds: x.contractIds }).contractCount > 0)!;
  await gotoPage(page, `/customer?key=${encodeURIComponent(g.key)}`);
  const [team, contracts] = await headingIndex(page, "担当チーム別", "この顧客の案件");
  expect(team).toBeGreaterThanOrEqual(0);
  expect(team).toBeLessThan(contracts);
});
