/**
 * 一時不在と終了の区別（SPEC §155）
 * - 体制図: 一時不在の人は元の所属に薄く残る（取り消し線なし・人数に数えない）。終了した人は翌月から出ない
 * - マスタ編集: 在籍の欄は 在籍／一時不在／終了。書いてある理由（休職など）は同じ種類のまま残す。名前の横の「?」で意味を出す
 * - メンバー詳細: 一時不在のチップ
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";

// ダミーデータ: M186 は 2026-04 から休職（T532）、M188 は 2025-07 に退職（T532）。docs/DUMMY_DATA.md
const AWAY = "M186";
const GONE = "M188";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem("yojitsu-navi:masters-draft:v1");
    sessionStorage.removeItem("yojitsu-navi:masters-draft-session");
  });
});

const person = (page: Page, id: string) => page.locator(`.yn-org-node[data-team="T532"] > .yn-org-people .yn-org-person[data-member="${id}"]`);

test("体制図: 一時不在の人は元の所属に薄く残り、吹き出しに一時不在。終了した人は出ない", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/teams?view=chart&month=2026-08");
  const p = person(page, AWAY);
  await expect(p).toHaveAttribute("data-change", "away");
  await expect(p).toHaveClass(/is-left/);
  expect(await p.locator(".yn-org-pname").evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("none");
  await expect(person(page, GONE)).toHaveCount(0);
  await p.hover();
  await expect(page.locator("#yn-plan-tip")).toContainText("一時不在（人数には数えません）");
});

test("マスタ編集: 在籍の欄は 在籍／一時不在／終了。理由の値は同じ種類なら残る。「?」で意味", async ({ page }) => {
  await gotoPage(page, "/masters");
  const d = page.locator("dialog.yn-me-dialog[open]");
  await page.locator(`tr.yn-me-group[data-group="${AWAY}"]`).locator("button", { hasText: /^修正$/ }).click();
  const sel = d.locator('[name="status"]');
  await expect(sel.locator("option")).toHaveText(["在籍", "一時不在", "終了"]);
  await expect(sel.locator("option:checked")).toHaveText("一時不在");
  expect(await sel.inputValue()).toBe("休職");
  // 終了を選ぶと値は「終了」、一時不在に戻すと元の「休職」
  await sel.selectOption({ label: "終了" });
  expect(await sel.inputValue()).toBe("終了");
  await sel.selectOption({ label: "一時不在" });
  expect(await sel.inputValue()).toBe("休職");
  const tipBtn = d.getByRole("button", { name: "在籍の選び方" });
  await tipBtn.click();
  await expect(d.locator(".yn-tip-pop").filter({ hasText: "休職・育休" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("メンバー詳細: 一時不在のチップ。390px・ダークで横スクロール無し", async ({ page }) => {
  await useDarkTheme(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await gotoPage(page, `/member?id=${AWAY}`);
  await expect(page.locator(".yn-facts .yn-chip", { hasText: "一時不在" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
