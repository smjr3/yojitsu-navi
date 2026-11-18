/**
 * リソース計画をキーボードで続けて入力する（SPEC §145）
 *
 * 数字で入力を始める・F2/Delete・Enter で反映して次の月へ・Home/End・名前との行き来・
 * 日本語の変換中の Enter で反映しない・マウスで反映したときは今のセルに残る・狭い画面でセルが名前の列に隠れない
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme, usePlanFiscalYear } from "./helpers/app.js";
import { AS_OF } from "./constants.js";

test.beforeEach(async ({ page }) => {
  await usePlanFiscalYear(page, AS_OF);
  await page.addInitScript(() => {
    localStorage.removeItem("yojitsu-navi:masters-draft:v1");
    sessionStorage.removeItem("yojitsu-navi:masters-draft-session");
    sessionStorage.removeItem("yojitsu-navi:plan-cell-scope");
  });
});

const cell = (page: Page, member: string, month: string) => page.locator(`[data-fk="plan:cell:${member}:all:${month}"]`);
const subCell = (page: Page, member: string, keyPart: string, month: string) => page.locator(`[data-fk^="plan:cell:${member}:p:"][data-fk*="${keyPart}"][data-fk$=":${month}"]`);
const pop = (page: Page) => page.locator("dialog.yn-plan-pop[open]");
const toggle = (page: Page, member: string) => page.locator(`[data-fk="plan:toggle:${member}"]`);

test("数字を打つとそのまま入力が始まり、Enter で反映して次の月へ進む", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  await cell(page, "M010", "2027-01").focus();
  await page.keyboard.type("0.5");
  const p = pop(page);
  await expect(p).toBeVisible();
  await expect(p.locator("#yn-plan-pop-0")).toBeFocused();
  await expect(p.locator("#yn-plan-pop-0")).toHaveValue("0.5");
  await page.keyboard.press("Enter");
  await expect(p).toHaveCount(0);
  // 保守 0.5 ＋ 契約外予定 0.2
  await expect(cell(page, "M010", "2027-01")).toHaveText("0.70");
  await expect(cell(page, "M010", "2027-02")).toBeFocused();
  // 続けて次の月も（変更が無くても Enter で閉じれば進む）
  await page.keyboard.press("Enter");
  await expect(p).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(p).toHaveCount(0);
  await expect(cell(page, "M010", "2027-03")).toBeFocused();
  // 最後の月はそのセルに残る
  await page.keyboard.type("0.9");
  await page.keyboard.press("Enter");
  await expect(p).toHaveCount(0);
  await expect(cell(page, "M010", "2027-03")).toBeFocused();
});

test("過去の月の確認も Enter で確定すれば次の月へ。マウスで反映したときは今のセルに残る", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  await cell(page, "M010", "2026-09").focus();
  await page.keyboard.type("0.6");
  const p = pop(page);
  await page.keyboard.press("Enter");
  await expect(p.locator(".yn-me-impact")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(p).toHaveCount(0);
  await expect(cell(page, "M010", "2026-10")).toBeFocused();
  // マウス
  await cell(page, "M010", "2027-02").click();
  await p.locator("#yn-plan-pop-0").fill("0.4");
  await p.getByRole("button", { name: "反映" }).click();
  await expect(p).toHaveCount(0);
  await expect(cell(page, "M010", "2027-02")).toBeFocused();
});

test("F2 で今の値を選んで開き、Delete で空にして開く（Esc で取り消し）", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  await cell(page, "M010", "2027-01").focus();
  await page.keyboard.press("F2");
  const p = pop(page);
  await expect(p.locator("#yn-plan-pop-0")).toBeFocused();
  await expect(p.locator("#yn-plan-pop-0")).toHaveValue("0.9");
  await page.keyboard.press("Escape");
  await expect(p).toHaveCount(0);
  await expect(cell(page, "M010", "2027-01")).toBeFocused();
  await page.keyboard.press("Delete");
  await expect(p.locator("#yn-plan-pop-0")).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(cell(page, "M010", "2027-01")).toHaveText("1.10");
});

test("Home・End で行の端、← で名前へ、名前から → で月・↑↓ でほかの人", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  await cell(page, "M010", "2026-10").focus();
  await page.keyboard.press("End");
  await expect(cell(page, "M010", "2027-03")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(cell(page, "M010", "2026-04")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(toggle(page, "M010")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(toggle(page, "M011")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(toggle(page, "M010")).toBeFocused();
  // 開いて作業の行へ。作業の行の最初の月から ← でその人の名前へ
  await page.keyboard.press("Enter");
  await expect(toggle(page, "M010")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowRight");
  await expect(cell(page, "M010", "2026-04")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  const sub = page.locator('tr.yn-me-plan-sub[data-member="M010"] .yn-plan-cell-btn').first();
  await expect(sub).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(toggle(page, "M010")).toBeFocused();
});

test("作業の行の計画の無い月は、その作業を選んだ状態で人月から始まる", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  // 倉庫管理システム保守の計画は 2027年3月まで。契約が続く 2027年4月を出す
  await page.locator("#yn-me-plan-to").selectOption("2027-04");
  await toggle(page, "M010").click();
  const empty = subCell(page, "M010", "倉庫管理システム保守", "2027-04");
  await expect(empty).toHaveText("—");
  await empty.focus();
  await page.keyboard.type("0.1");
  const p = pop(page);
  await expect(p.locator("#yn-plan-pop-new")).toBeFocused();
  await expect(p.locator("#yn-plan-pop-new")).toHaveValue("0.1");
  await expect(p.locator("#yn-plan-pop-project")).toHaveValue("倉庫管理システム保守");
  await page.keyboard.press("Enter");
  await expect(p).toHaveCount(0);
  await expect(subCell(page, "M010", "倉庫管理システム保守", "2027-04")).toHaveText("0.10");
});

test("日本語の変換中の Enter では反映も移動もしない", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  await cell(page, "M010", "2027-01").focus();
  await page.keyboard.press("Enter");
  const p = pop(page);
  const input = p.locator("#yn-plan-pop-0");
  await expect(input).toBeFocused();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "０．４", selectionStart: 3, selectionEnd: 3 });
  // 変換を確定するだけ（Enter のキーは IME が受け取るので、ページには isComposing の keydown しか来ない）
  await input.evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
  await cdp.send("Input.insertText", { text: "０．４" });
  await cdp.detach();
  await expect(p).toBeVisible();
  await expect(input).toHaveValue("０．４");
  // 確定してからの Enter で反映（全角でも数値として読む）、次の月へ
  await page.keyboard.press("Enter");
  await expect(p).toHaveCount(0);
  await expect(cell(page, "M010", "2027-01")).toHaveText("0.60");
  await expect(cell(page, "M010", "2027-02")).toBeFocused();
  // セルの上で変換中のキーは入力を始めない
  await cell(page, "M010", "2027-02").evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "5", keyCode: 229, isComposing: true, bubbles: true })));
  await expect(p).toHaveCount(0);
});

test("スマホ幅（390）・ダーク: ← で戻ったセルが名前の列の下に隠れない", async ({ page }) => {
  await useDarkTheme(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await gotoPage(page, "/plan?team=T111");
  await cell(page, "M010", "2026-04").focus();
  for (let i = 0; i < 11; i++) await page.keyboard.press("ArrowRight");
  await expect(cell(page, "M010", "2027-03")).toBeFocused();
  for (let i = 0; i < 11; i++) await page.keyboard.press("ArrowLeft");
  const c = cell(page, "M010", "2026-04");
  await expect(c).toBeFocused();
  const covered = await c.evaluate((el) => {
    const head = el.closest("tr")!.firstElementChild!.getBoundingClientRect();
    return head.right - el.closest("td")!.getBoundingClientRect().left;
  });
  expect(covered).toBeLessThanOrEqual(1);
});
