/**
 * 画面の切り替えの先読み（SPEC §108）
 *
 * Playwright（DevTools がつながったブラウザ）では Chrome が先読みそのものを止めるので、ここでは
 * 先読みの決まり（speculationrules）がエラーなく読まれることを確かめる。
 * 先読みで裏で表まで作ること・表示の状態が変わっていたら作り直すことは、DevTools をつながない Chromium で確かめた（PR の説明）。
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


test("head の埋め込みスクリプト（先読みの調整を含む）に文法の誤りが無い", async ({ page }) => {
  await gotoPage(page, "/contracts");
  const bad = await page.evaluate(() =>
    [...document.querySelectorAll("head script:not([src]):not([type])")].flatMap((s) => {
      try {
        new Function(s.textContent ?? "");
        return [];
      } catch (e) {
        return [`${String(e)}: ${(s.textContent ?? "").slice(0, 60)}`];
      }
    }),
  );
  expect(bad).toEqual([]);
  expect(await page.evaluate(() => document.head.innerHTML.includes("prerenderingchange"))).toBe(true);
});
