/**
 * 全体サマリーの節の並び（SPEC §153）: チーム別 → 超過見込みの案件
 */
import { test, expect, gotoPage } from "./helpers/app.js";

test("全体サマリーはチーム別を超過見込みの案件より上に出す", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/");
  const heads = page.locator("h2");
  await expect(heads.filter({ hasText: "超過見込みの案件" })).toHaveCount(1);
  const titles = (await heads.allTextContents()).map((t) => t.trim());
  const team = titles.findIndex((t) => t.startsWith("チーム別"));
  const deficit = titles.findIndex((t) => t.startsWith("超過見込みの案件"));
  expect(team).toBeGreaterThanOrEqual(0);
  expect(team).toBeLessThan(deficit);
});
