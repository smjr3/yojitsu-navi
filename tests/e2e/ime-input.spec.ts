/**
 * 検索・絞り込みの欄で日本語の変換中に文字が勝手に確定されない（SPEC §105）
 *
 * Chromium の IME 操作（CDP の Input.imeSetComposition / Input.insertText）で、
 * 変換中は表も欄もそのまま（反映しない・欄を作り直さない）、確定してから絞り込むことを確かめる。
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect, gotoPage } from "./helpers/app.js";

/** どの表にも無い読み。確定すると 0 件になる */
const WORD = "ぞぞ";

const rowCount = (page: Page) => page.evaluate(() => document.querySelectorAll("main tbody tr").length);

async function composeThenCommit(page: Page, field: Locator): Promise<void> {
  await field.click();
  await field.evaluate((el) => ((el as HTMLElement & { __ime?: boolean }).__ime = true));
  const before = await rowCount(page);
  expect(before).toBeGreaterThan(0);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "ぞ", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.imeSetComposition", { text: WORD, selectionStart: WORD.length, selectionEnd: WORD.length });
  // 反映の待ち（150ms）より長く待っても、変換中は表を描き直さず、欄も作り直さない
  await page.waitForTimeout(600);
  expect(await rowCount(page)).toBe(before);
  await expect(field).toHaveValue(WORD);
  expect(await field.evaluate((el) => (el as HTMLElement & { __ime?: boolean }).__ime === true && el.isConnected && el === document.activeElement)).toBe(true);
  // 確定すると絞り込む。欄は入力中のまま（フォーカス・値が残る）
  await cdp.send("Input.insertText", { text: WORD });
  await expect.poll(() => rowCount(page)).toBeLessThan(before);
  await expect(field).toHaveValue(WORD);
  await expect(field).toBeFocused();
  await cdp.detach();
}

const screens: { name: string; path: string; field: (page: Page) => Locator }[] = [
  { name: "マスタ編集の検索", path: "/masters", field: (page) => page.locator("#yn-me-panel .yn-me-search") },
  { name: "リソース計画の検索", path: "/plan", field: (page) => page.locator("#yn-me-plan-q") },
  { name: "案件一覧の検索", path: "/contracts", field: (page) => page.locator("#yn-f-text") },
  { name: "顧客一覧の検索", path: "/customers", field: (page) => page.locator("#yn-f-text") },
  { name: "メンバー一覧の検索", path: "/members", field: (page) => page.locator("#yn-m-text") },
];

for (const s of screens) {
  test(`${s.name}: 変換中は確定されず、確定してから絞り込む`, async ({ page }) => {
    await gotoPage(page, s.path);
    await composeThenCommit(page, s.field(page));
  });
}

test("列の絞り込みの検索（マスタ編集）: 変換中は確定されず、確定してから絞り込む", async ({ page }) => {
  await gotoPage(page, "/masters");
  await page.locator('#yn-me-panel thead .yn-filter-btn[data-fcol="title"]').click();
  await composeThenCommit(page, page.locator(".yn-filter-pop").getByRole("searchbox"));
});
