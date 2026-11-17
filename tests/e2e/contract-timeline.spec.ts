/**
 * 案件一覧の「期間」表示（SPEC §132）: 切り替えと URL・戻る、件数が表と同じ、期間外・終わった案件の扱い、
 * まとめ方・並べ方をブラウザに覚える、終了が近い、まとまりの開閉、画面幅とダークではみ出さない
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";
import { aggregate, fiscalPeriod, getModel } from "./helpers/core.js";
import { addMonths } from "../../src/core/index.js";
import { AS_OF } from "./constants.js";

const model = getModel();
const FY = fiscalPeriod(model);
const asOfMonth = AS_OF.slice(0, 7);
const inFy = model.contracts.filter((r) => aggregate(model, { period: FY, contractIds: [r.contract.contractId] }).contractCount > 0);

const rows = (page: Page) => page.locator(".yn-tl-row[data-contract]");

async function openTimeline(page: Page, query = "") {
  await gotoPage(page, `/contracts?view=timeline${query}`);
  await expect(page.locator(".yn-tl-grid")).toBeVisible();
}

test("表と期間を切り替える。件数は表と同じで、URL に残り戻るで復元する", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/contracts");
  await expect(page.locator(".yn-tl-grid")).toHaveCount(0);
  await page.getByRole("group", { name: "表示の切り替え" }).getByRole("button", { name: "期間" }).click();
  await expect(page).toHaveURL(/view=timeline/);
  await expect(rows(page)).toHaveCount(inFy.length);
  await expect(page.locator(".yn-tl-today")).toHaveCount(1);
  await expect(page.locator(".yn-tl-legend")).toContainText("案件の期間（予算）");
  // 名前から案件詳細へ行って戻ると期間の表示のまま
  const first = rows(page).first();
  const id = await first.getAttribute("data-contract");
  await first.locator(".yn-tl-name").click();
  await expect(page).toHaveURL(new RegExp(`/contract\\?.*id=${id}`));
  await page.goBack();
  await expect(page.locator(".yn-tl-grid")).toBeVisible();
  await page.getByRole("group", { name: "表示の切り替え" }).getByRole("button", { name: "表" }).click();
  await expect(page).not.toHaveURL(/view=timeline/);
  await expect(page.locator(".yn-tl-grid")).toHaveCount(0);
});

test("期間外の案件は既定で出さない。出すと終わった案件は薄く、まとまりの最後に並ぶ", async ({ page }) => {
  await openTimeline(page);
  const ids = new Set(await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-contract"))));
  expect(ids).toEqual(new Set(inFy.map((r) => r.contract.contractId)));
  await openTimeline(page, "&f=outside");
  await expect(rows(page)).toHaveCount(model.contracts.length);
  const order = await page.locator(".yn-tl-row").evaluateAll((els) => els.map((e) => (e.classList.contains("yn-tl-group") ? "G" : e.classList.contains("is-ended") ? "E" : "A")));
  const ended = model.contracts.filter((r) => r.contract.endMonth < asOfMonth).length;
  expect(order.filter((x) => x === "E")).toHaveLength(ended);
  // まとまりの中で、終わった案件の後に終わっていない案件が来ない
  const groups = order.join("").split("G").filter(Boolean);
  for (const g of groups) expect(g).toMatch(/^A*E*$/);
});

test("まとめ方・並べ方をブラウザに覚える。まとまりを畳める", async ({ page }) => {
  await openTimeline(page);
  await page.locator('select[data-role="group"]').selectOption("team");
  await page.locator('select[data-role="sort"]').selectOption("amount");
  await page.reload();
  await expect(page.locator(".yn-tl-grid")).toBeVisible();
  await expect(page.locator('select[data-role="group"]')).toHaveValue("team");
  await expect(page.locator('select[data-role="sort"]')).toHaveValue("amount");
  // まとめなし: まとまりの行が無い
  await page.locator('select[data-role="group"]').selectOption("none");
  await expect(page.locator(".yn-tl-group")).toHaveCount(0);
  await expect(rows(page)).toHaveCount(inFy.length);
  // 顧客でまとめて、最初のまとまりを畳む
  await page.locator('select[data-role="group"]').selectOption("customer");
  const btn = page.locator(".yn-tl-group-btn").first();
  const before = await rows(page).count();
  await btn.click();
  await expect(btn).toHaveAttribute("aria-expanded", "false");
  expect(await rows(page).count()).toBeLessThan(before);
  await btn.click();
  await expect(rows(page)).toHaveCount(before);
});

test("終了が近い: 今月から 3 か月以内に終わる案件だけ（表でも同じ絞り込み）", async ({ page }) => {
  await gotoPage(page, "/contracts?view=timeline&f=ending");
  const limit = addMonths(asOfMonth, 3);
  const expected = inFy.filter((r) => r.contract.endMonth >= asOfMonth && r.contract.endMonth <= limit).length;
  if (expected === 0) await expect(page.getByText("該当する案件がありません")).toBeVisible();
  else await expect(rows(page)).toHaveCount(expected);
  await expect(page.locator("#yn-f-ending")).toBeChecked();
});

for (const width of [390, 768, 1024, 1280]) {
  for (const dark of [false, true]) {
    test(`${width}px${dark ? "・ダーク" : ""}: 横にはみ出さず、名前の列は残る`, async ({ page }) => {
      if (dark) await useDarkTheme(page);
      await page.setViewportSize({ width, height: 900 });
      await openTimeline(page, "&f=outside");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const label = await page.locator(".yn-tl-row[data-contract] .yn-tl-label").first().boundingBox();
      expect(label!.width).toBeGreaterThan(100);
      // 狭い画面は表示の中だけ横にスクロールし、名前の列は左に固定
      const box = page.locator(".yn-tl");
      await box.evaluate((el) => (el.scrollLeft = 10_000));
      const after = await page.locator(".yn-tl-row[data-contract] .yn-tl-label").first().boundingBox();
      const boxRect = await box.boundingBox();
      expect(Math.abs(after!.x - boxRect!.x)).toBeLessThan(3);
    });
  }
}

test("長い期間（数年）は表示の中だけ横にスクロールし、期間からはみ出す帯は端を点線にする", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openTimeline(page, `&from=${model.meta.minMonth}&to=${model.meta.maxMonth}&f=outside`);
  const box = page.locator(".yn-tl");
  expect(await box.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // 1 か月の幅は 34px 以上（月の名前が読める）
  const w = await page.locator(".yn-tl-head .yn-tl-m").first().evaluate((el) => el.getBoundingClientRect().width);
  expect(w).toBeGreaterThanOrEqual(33.5);
  await openTimeline(page, `&from=${FY.from}&to=${FY.to}`);
  const cut = model.contracts.some((r) => r.contract.startMonth < FY.from && r.contract.endMonth >= FY.from);
  if (cut) await expect(page.locator(".yn-tl-band.is-cut-l").first()).toBeVisible();
});

test("横にスクロールする長さのとき、最初から今日の線が見えている", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openTimeline(page, `&from=${model.meta.minMonth}&to=${model.meta.maxMonth}`);
  const box = await page.locator(".yn-tl").boundingBox();
  await expect.poll(async () => {
    const t = await page.locator(".yn-tl-today").boundingBox();
    return t!.x > box!.x + 300 && t!.x < box!.x + box!.width;
  }).toBe(true);
});

test("期間に掛からない案件は帯を描かず端に期間を出す（横軸を延ばさない）", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openTimeline(page, `&from=${FY.from}&to=${FY.from}&f=outside`);
  const box = page.locator(".yn-tl");
  expect(await box.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const outside = model.contracts.filter((r) => r.contract.endMonth < FY.from || r.contract.startMonth > FY.from).length;
  await expect(page.locator(".yn-tl-outside")).toHaveCount(outside);
});

test("まとまりをキーボードで開け閉めするとフォーカスがボタンに残る", async ({ page }) => {
  await openTimeline(page);
  const btn = page.locator(".yn-tl-group-btn").first();
  const key = await btn.getAttribute("data-group");
  await btn.focus();
  await page.keyboard.press("Enter");
  const focused = page.locator(".yn-tl-group-btn:focus");
  await expect(focused).toHaveAttribute("aria-expanded", "false");
  await expect(focused).toHaveAttribute("data-group", key!);
  await page.keyboard.press("Enter");
  await expect(page.locator(".yn-tl-group-btn:focus")).toHaveAttribute("aria-expanded", "true");
});
