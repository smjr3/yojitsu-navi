/**
 * 画面の切り替えの先読み（SPEC §108）
 *
 * Playwright（DevTools がつながったブラウザ）では Chrome が先読みそのものを止めるので、ここでは
 * 先読みの決まり（speculationrules）がエラーなく読まれること、表示の状態を変えたら決まりが作り直される（古い先読みを捨てる）ことを確かめる。
 * 先読みで作った画面がすぐ出ることは、DevTools をつながない Chromium で手で確かめた（PR の説明）。
 */
import { test, expect, gotoPage } from "./helpers/app.js";

type RuleSet = { id: string; errorType?: string; sourceText: string };

test("先読みの決まりがエラーなく読まれ、マスタ編集・設定は対象外", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  const sets: RuleSet[] = [];
  cdp.on("Preload.ruleSetUpdated", (e: { ruleSet: RuleSet }) => sets.push(e.ruleSet));
  await cdp.send("Preload.enable");
  await gotoPage(page, "/contracts");
  await expect.poll(() => sets.length).toBeGreaterThan(0);
  const last = sets[sets.length - 1]!;
  expect(last.errorType).toBeUndefined();
  const rules = JSON.parse(last.sourceText);
  expect(rules.prerender[0].eagerness).toBe("moderate");
  expect(last.sourceText).toContain("./masters");
  expect(last.sourceText).toContain("./settings");
});

test("期間を変えると先読みの決まりを作り直す（前の状態で作った先読みを捨てる）", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  const removed: string[] = [];
  cdp.on("Preload.ruleSetRemoved", (e: { id: string }) => removed.push(e.id));
  await cdp.send("Preload.enable");
  await gotoPage(page, "/contracts");
  await page.waitForTimeout(300);
  const before = removed.length;
  await page.locator("[data-preset]").nth(1).click();
  await expect.poll(() => removed.length).toBeGreaterThan(before);
  await expect(page.locator("#yn-speculation")).toHaveCount(1);
});
