/**
 * 表示の切り替えの置き場所（SPEC §144）: 表／体制図・表／期間・まとめ方・体制図の色は、節の見出しのすぐ下の左にそろえる。
 * 「列」・Excel 出力は従来どおり右。1280px・390px（ダーク）で、見出しより下・見出しと左端がそろい・横にはみ出さない
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";

const CASES = [
  { path: "/teams", switches: [".yn-view-toggle"] },
  { path: "/teams?view=chart", switches: [".yn-view-toggle", ".yn-org-color"] },
  { path: "/contracts", switches: [".yn-view-toggle"] },
  { path: "/contracts?view=timeline", switches: [".yn-view-toggle"] },
  { path: "/workload", switches: [".yn-work-axis"] },
  { path: "/workload?axis=member", switches: [".yn-work-axis"] },
];

async function box(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new Error("not visible");
  return b;
}

async function check(page: Page, path: string, switches: string[]) {
  await gotoPage(page, path);
  const first = page.locator(`.yn-section-head:has(${switches[0]})`);
  await expect(first).toHaveCount(1);
  const title = await box(first.locator(".yn-section-title"));
  let prevRight = -1;
  for (const sel of switches) {
    const sw = first.locator(`.yn-section-switch ${sel}`);
    await expect(sw).toBeVisible();
    const b = await box(sw);
    expect(b.y, `${path} ${sel} は見出しの下`).toBeGreaterThanOrEqual(title.y + title.height - 1);
    if (prevRight < 0) expect(Math.abs(b.x - title.x), `${path} ${sel} は見出しと左端がそろう`).toBeLessThanOrEqual(1);
    else expect(b.x, `${path} ${sel} は前の切り替えの右`).toBeGreaterThan(prevRight - 1);
    prevRight = b.x + b.width;
  }
  const vw = page.viewportSize()!.width;
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(vw);
}

for (const c of CASES) {
  test(`1280px: ${c.path} の表示の切り替えは見出しの下の左`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await check(page, c.path, c.switches);
  });
}

test("390px・ダーク: 表示の切り替えは見出しの下の左で、はみ出さない", async ({ page }) => {
  await useDarkTheme(page);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const c of CASES) await check(page, c.path, c.switches);
});

test("「列」・Excel 出力は右のまま（切り替えより右）", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const path of ["/teams", "/contracts"]) {
    await gotoPage(page, path);
    const sw = await box(page.locator(".yn-section-switch .yn-view-toggle"));
    const ex = await box(page.locator(".yn-export").first());
    expect(ex.x, path).toBeGreaterThan(sw.x + sw.width + 400);
  }
});

test("稼働実績: まとめ方を切り替えても見出しの下に残り、見出しが変わる", async ({ page }) => {
  await gotoPage(page, "/workload");
  const axis = page.locator(".yn-section-switch .yn-work-axis");
  await axis.locator('button[data-axis="customer"]').click();
  await expect(page).toHaveURL(/axis=customer/);
  await expect(page.locator(".yn-section-head:has(.yn-work-axis) .yn-section-title")).toContainText("顧客");
  await expect(page.locator(".yn-work-axis")).toHaveCount(1);
  await expect(axis.locator('button[data-axis="customer"]')).toHaveAttribute("aria-pressed", "true");
});

test("キーボードで切り替えてもフォーカスが押したボタンに残る（稼働実績・案件一覧・チーム一覧）", async ({ page }) => {
  for (const [path, sel, next] of [
    ["/workload", ".yn-work-axis", '[data-axis="customer"]'],
    ["/contracts", ".yn-view-toggle", '[data-view="timeline"]'],
    ["/teams", ".yn-view-toggle", '[data-view="chart"]'],
  ] as const) {
    await gotoPage(page, path);
    const btn = page.locator(`.yn-section-switch ${sel} ${next}`);
    await btn.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(`.yn-section-switch ${sel} ${next}`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(`.yn-section-switch ${sel} ${next}`), path).toBeFocused();
  }
});
