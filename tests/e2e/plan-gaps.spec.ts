/**
 * 計画と実績のずれ（SPEC §64）: メンバー別に出る・チームで絞れる・確定月が無いと表を出さない・行から詳細へ
 */
import { test, expect, gotoPage } from "./helpers/app.js";

test("メンバー別に「計画とのずれ」が出て、行からメンバー詳細へ", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/members");
  const head = page.locator("#yn-plan-gaps");
  await expect(head).toContainText("計画とのずれ");
  await expect(head).toContainText(/（確定月） ・ \d+件/);
  const table = page.getByRole("table", { name: "計画とのずれ" });
  await expect(table.locator("tbody tr").first()).toBeVisible();
  await expect(table.locator("tbody tr").first()).toContainText(/計画なし|実績なし|多い|少ない/);
  // メンバーごとの計画と実績の表より下に置く（§68）
  const membersTable = page.getByRole("table", { name: "メンバー別の計画と実績" });
  const membersBox = (await membersTable.boundingBox())!;
  expect((await head.boundingBox())!.y).toBeGreaterThan(membersBox.y + membersBox.height);
  await table.locator("tbody tr").first().click();
  await expect(page).toHaveURL(/\/member\?/);
});

test("チームで絞ると件数が減り、「リソース計画へ」がチームを引き継ぐ", async ({ page }) => {
  await gotoPage(page, "/members");
  const all = Number((await page.locator("#yn-plan-gaps").innerText()).match(/(\d+)件/)?.[1]);
  await gotoPage(page, "/members?team=S11");
  const text = await page.locator("#yn-plan-gaps").innerText();
  const n = Number(text.match(/(\d+)件/)?.[1] ?? 0);
  expect(n).toBeLessThan(all);
  await expect(page.locator("#yn-gap-plan-link")).toHaveAttribute("href", /plan\?team=S11/);
});

test("確定した月が無い期間（今月）は表を出さない", async ({ page }) => {
  await gotoPage(page, "/members");
  await page.getByRole("button", { name: "今月", exact: true }).click();
  await expect(page.locator("#yn-plan-gaps")).toContainText("確定した月がありません");
  await expect(page.getByRole("table", { name: "計画とのずれ" })).toHaveCount(0);
  await expect(page.locator("#yn-gap-plan-link")).toHaveCount(0);
});
