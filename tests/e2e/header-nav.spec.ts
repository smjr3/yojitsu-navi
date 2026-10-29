/**
 * ヘッダーの並び（SPEC §45）
 * - 右上は業務の「稼働計画」「マスタ編集」だけ。使い方・データ確認・計算ルールは右端「その他」（⋯）のメニューに入れる（§47）
 * - メニューは押すと開き、もう一度押す・外を押す・Esc・フォーカスが外れると閉じる。開いている画面なら ⋯ が選択状態
 */
import { test, expect, gotoPage } from "./helpers/app.js";

test("右上は稼働計画 → マスタ編集の順。使い方・データ確認・計算ルールは ⋯ のメニューから開ける", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/");
  await expect(page.locator(".yn-tools a.yn-tool")).toHaveText(["稼働計画", /^マスタ編集/]);
  const btn = page.getByRole("button", { name: "その他" });
  const menu = page.locator("#yn-more-menu");
  await expect(menu).toBeHidden();
  await expect(btn).not.toHaveClass(/is-current/);
  await btn.click();
  await expect(btn).toHaveAttribute("aria-expanded", "true");
  await expect(menu.locator("a")).toHaveText(["使い方", "データ確認", "計算ルール"]);
  await expect(menu.locator("a").first()).toBeFocused();
  await btn.click();
  await expect(menu).toBeHidden();
  await btn.click();
  await page.mouse.click(500, 600);
  await expect(menu).toBeHidden();
  await btn.click();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(btn).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(menu).toBeHidden();
  await btn.click();
  await menu.getByRole("link", { name: "計算ルール" }).click();
  await expect(page).toHaveURL(/\/rules/);
  await expect(page.getByRole("button", { name: "その他" })).toHaveClass(/is-current/);
  await page.getByRole("button", { name: "その他" }).click();
  await expect(page.locator("#yn-more-menu a", { hasText: "計算ルール" })).toHaveAttribute("aria-current", "page");
  await page.locator("#yn-more-menu a", { hasText: "データ確認" }).click();
  await expect(page).toHaveURL(/\/data-check/);
  await expect(page.getByRole("heading", { level: 1, name: "データ確認" })).toBeVisible();
});

for (const width of [390, 320]) {
  test(`${width}px: ロゴの下に右上のリンクが 1 段で並び、メニューが画面内に収まる`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await gotoPage(page, "/plan");
    const tops = await page.locator(".yn-tools a.yn-tool, .yn-icon-tools > *").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2)));
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(4);
    await page.getByRole("button", { name: "その他" }).click();
    const box = (await page.locator("#yn-more-menu").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  });
}
