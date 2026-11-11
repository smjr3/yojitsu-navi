/**
 * 今月の残り時間（SPEC §113）
 * - メンバー詳細: GitLab の接続なしで、その人の今月の計画・実績・残り（core の myHoursRows と一致）
 * - ヘッダー右上: トークンの持ち主（デモは gitlab-mock の利用者 = members.csv の gitlab_username が demo-user の人）にだけ出る。
 *   押すと内訳が開き、メンバー詳細へ移れる。ヘッダーの「作業実績の取得」は外す
 * - 390px・ダークで横スクロール無し
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";
import { getModel } from "./helpers/core.js";
import { ROOT_DIR } from "./constants.js";
import { loadDataset } from "../../scripts/lib/load.js";
import { gitlabUsernameIndex, myHoursRows, myHoursTotals, formatHours } from "../../src/core/index.js";

const model = getModel();
const dataset = loadDataset(ROOT_DIR).dataset;
const month = model.meta.asOfMonth;
const names = new Map(model.contracts.map((r) => [r.contract.contractId, r.contract.projectName]));
const rowsOf = (memberId: string) => myHoursRows(model.memberMonths.find((mm) => mm.memberId === memberId && mm.month === month), (id) => names.get(id));
const demoMember = gitlabUsernameIndex(dataset.members, month).get("demo-user")!;
const remainText = (r: number) => (r < 0 ? `超過 ${formatHours(-r)}` : `残り ${formatHours(r)}`);

/** デモの GitLab につないだ状態（token = null ならトークン無し） */
async function useDemoGitLab(page: Page, token: string | null = "demo"): Promise<void> {
  await page.addInitScript((token) => {
    (window as unknown as { __YN_MY_HOURS_CONFIG__: unknown }).__YN_MY_HOURS_CONFIG__ = { enabled: true, demo: true, api: "" };
    try {
      if (token) sessionStorage.setItem("yojitsu-navi:gitlab-token", token);
      else sessionStorage.removeItem("yojitsu-navi:gitlab-token");
    } catch {}
  }, token);
}

test("ダミーデータにデモの利用者がいる", () => {
  expect(demoMember).toBeTruthy();
  expect(rowsOf(demoMember).length).toBeGreaterThan(1);
});

test("メンバー詳細に今月の残りと案件ごとの行（GitLab の接続なし）", { tag: "@smoke" }, async ({ page }) => {
  const rows = rowsOf(demoMember);
  await gotoPage(page, `/member?id=${demoMember}`);
  const card = page.locator("#observablehq-main .yn-my-hours-card");
  await expect(card).toBeVisible();
  await expect(card.locator(".yn-my-hours-big")).toHaveText(remainText(myHoursTotals(rows).remainingHours));
  await expect(card.locator("tbody tr")).toHaveCount(rows.length);
  await expect(card.locator("tbody tr").first().locator("td").first()).toHaveText(rows[0]!.label);
  // ヘッダー右上には出ない（トークンが無い）
  await expect(page.locator(".yn-my-hours-btn")).toHaveCount(0);
});

test("計画も実績も無い人は「計画も実績もありません」", async ({ page }) => {
  const idle = dataset.members.map((m) => m.memberId).find((id) => rowsOf(id).length === 0)!;
  await gotoPage(page, `/member?id=${idle}`);
  await expect(page.locator("#observablehq-main .yn-my-hours-card")).toContainText("今月の計画も実績もありません");
});

test("ヘッダー右上: 本人の残り。押すと内訳、メンバー詳細へ移れる", { tag: "@smoke" }, async ({ page }) => {
  await useDemoGitLab(page);
  await gotoPage(page, "/");
  const total = myHoursTotals(rowsOf(demoMember)).remainingHours;
  const btn = page.locator(".yn-my-hours-btn");
  await expect(btn).toBeVisible();
  await expect(btn.locator("b")).toHaveText(formatHours(Math.abs(total)));
  await expect(btn).toContainText(total < 0 ? "今月の超過" : "今月の残り");
  // 「作業実績の取得」はヘッダーから外す（見出しの下には残る）
  await expect(page.locator(".yn-topbar .yn-filter-fetched")).toBeHidden();
  const pop = page.locator(".yn-my-hours-pop");
  await expect(pop).toBeHidden();
  await btn.click();
  await expect(pop).toBeVisible();
  await expect(pop.locator(".yn-my-hours-big")).toHaveText(remainText(total));
  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();
  await btn.click();
  await pop.locator(".yn-my-hours-link").click();
  await expect(page).toHaveURL(new RegExp(`member\\?id=${demoMember}`));
  await expect(page.locator("#observablehq-main .yn-my-hours-card")).toBeVisible();
});

test("トークンが無ければヘッダー右上には出さない", async ({ page }) => {
  await useDemoGitLab(page, null);
  await gotoPage(page, "/");
  await expect(page.locator(".yn-topbar .yn-filter-fetched")).toBeVisible();
  await expect(page.locator(".yn-my-hours-btn")).toHaveCount(0);
});

for (const width of [390, 768]) {
  test(`${width}px・ダーク: 吹き出しが画面に収まり、横スクロールしない`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await useDarkTheme(page);
    await useDemoGitLab(page);
    await gotoPage(page, "/");
    await page.locator(".yn-my-hours-btn").click();
    const box = (await page.locator(".yn-my-hours-pop").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    const btn = (await page.locator(".yn-my-hours-btn").boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(btn.y + btn.height);
    const { sw, cw } = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, cw: document.scrollingElement!.clientWidth }));
    expect(sw).toBeLessThanOrEqual(cw + 1);
  });
}
