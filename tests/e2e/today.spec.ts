/**
 * 「今日」は開いている人の今日（日本時間）（SPEC §75）。
 * E2E のビルドは YOJITSU_AS_OF で固定（meta.asOfFixed）しているので、model.json の固定の印を外し、
 * ブラウザの時計を進めて「固定しない本番のビルドを、取り込みが止まった後の日に開いた」状態にする。
 */
import type { Page } from "@playwright/test";
import { addMonths, businessDaysInMonth, isBusinessDay } from "../../src/core/index.js";
import { test, expect, gotoPage } from "./helpers/app.js";
import { getModel } from "./helpers/core.js";
import { AS_OF } from "./constants.js";

const model = getModel();

/** model.json の asOfFixed を外し、ブラウザの時計を日本時間の at にする */
async function openAsProduction(page: Page, at: string): Promise<void> {
  await page.clock.setFixedTime(new Date(`${at}T10:00:00+09:00`));
  await page.route(/\/_file\/data\/model\.[^/]*\.json$/, async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    delete json.meta.asOfFixed;
    await route.fulfill({ response: res, json });
  });
}

/** 日付 d（YYYY-MM-DD）から月末までの営業日 */
function bizDaysFrom(d: string): number {
  const month = d.slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  let n = 0;
  for (let day = Number(d.slice(8, 10)); day <= last; day++) if (isBusinessDay(`${month}-${String(day).padStart(2, "0")}`, model.holidays)) n++;
  return n;
}

/** AS_OF から n 日後 */
function plusDays(n: number): string {
  const [y, m, d] = AS_OF.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** AS_OF の月の次の営業日以降で、同じ月の最後の営業日（取り込みが止まって数日たった日） */
function laterBizDayInMonth(): string | null {
  for (let n = 10; n >= 2; n--) {
    const d = plusDays(n);
    if (d.slice(0, 7) === AS_OF.slice(0, 7) && isBusinessDay(d, model.holidays)) return d;
  }
  return null;
}

test("固定しないビルド: 今日は日本時間の今日。取り込みが止まると取得日時が警告色、残りの営業日は今日から", { tag: "@smoke" }, async ({ page }) => {
  const today = laterBizDayInMonth();
  test.skip(!today, "基準日の月に、数日後の営業日が無い");
  await openAsProduction(page, today!);
  await gotoPage(page, "/");
  const meta = page.locator(".yn-meta").first();
  await expect(meta.locator("time").first()).toHaveText(today!);
  // 取り込みは AS_OF のまま（2 日以上前）→ 止まっている
  await expect(meta.locator("> div.is-stale")).toHaveCount(1);
  await expect(meta.locator("> div.is-stale")).toContainText("作業実績の取得");
  // 今月の進捗: 残りの営業日は今日から数える。グラフに今日の線
  const daily = page.locator("#yn-daily");
  await expect(page.locator("#yn-daily-left")).toContainText(`残り ${bizDaysFrom(today!)} 営業日`);
  await expect(daily.locator('svg[role="img"] text', { hasText: "今日" })).toHaveCount(1);
});

test("固定しないビルド: 月が替わると今月・年度の既定・今月の進捗が今日の月になり、今月の実績は 0", async ({ page }) => {
  // AS_OF の翌月の 4 日（日本時間）
  const nextMonth = addMonths(AS_OF.slice(0, 7), 1);
  const today = `${nextMonth}-04`;
  await openAsProduction(page, today);
  await gotoPage(page, "/");
  await expect(page.locator(".yn-meta time").first()).toHaveText(today);
  const daily = page.locator("#yn-daily");
  const ym = `${Number(nextMonth.slice(0, 4))}年${Number(nextMonth.slice(5, 7))}月`;
  await expect(daily.locator("h2").first()).toContainText(ym);
  await expect(page.locator("#yn-daily-actual .yn-kpi-value")).toHaveText(/^0(\.00)?(百万円|千円|円)$/);
  await expect(page.locator("#yn-daily-left")).toContainText(`残り ${bizDaysFrom(today)} 営業日`);
  expect(bizDaysFrom(today)).toBeLessThanOrEqual(businessDaysInMonth(nextMonth, model.holidays));
});

test("固定したビルド（テスト・試用版）は、ブラウザの時計が進んでも今日を変えない", async ({ page }) => {
  await page.clock.setFixedTime(new Date(`${plusDays(40)}T10:00:00+09:00`));
  await gotoPage(page, "/");
  await expect(page.locator(".yn-meta time").first()).toHaveText(AS_OF);
  await expect(page.locator(".yn-meta > div.is-stale")).toHaveCount(0);
});

test("固定しないビルド: 案件の作業ログの状態も今日で決まる（工数の確定日を過ぎた月は「確定」）", async ({ page }) => {
  // AS_OF の月が確定する翌月 10 日（確定日 = 翌月の第 n 営業日。10 日なら過ぎている）
  const today = `${addMonths(AS_OF.slice(0, 7), 1)}-10`;
  await openAsProduction(page, today);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoPage(page, "/contract?id=C008");
  await page.getByRole("button", { name: "作業ログを読み込む" }).click();
  const cells = page.locator(".yn-worklog-holder tbody td");
  await expect(cells.filter({ hasText: /^確定$/ }).first()).toBeVisible();
  await expect(cells.filter({ hasText: /^速報$/ })).toHaveCount(0);
});
