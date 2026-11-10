/**
 * 表の列の表示・並び順（SPEC §106）
 * - ツールバーの「列」で列を隠す・前後に動かす。先頭の列は固定
 * - 画面と表ごとにこのブラウザへ覚え、再読み込みでも保つ。「元に戻す」で既定に戻る
 * - 隠した列の絞り込みは外し、Excel も画面の列に合わせる
 * - 長い文字の列（案件名など）は上限の幅で「…」、全文は title
 * - マスタ編集の台帳も同じ部品
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect, gotoPage, tableByCaption, dataRows } from "./helpers/app.js";

const heads = (table: Locator) => table.locator("thead th").evaluateAll((ths) => ths.map((th) => (th as HTMLElement).dataset.key ?? ""));
const block = (page: Page, table: Locator) => page.locator(".yn-table-block", { has: table });
const pop = (page: Page) => page.locator(".yn-cols-pop");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("tcols-cleared")) return;
    sessionStorage.setItem("tcols-cleared", "1");
    for (const k of Object.keys(localStorage)) if (k.startsWith("yojitsu-navi:columns:")) localStorage.removeItem(k);
  });
});

test("案件一覧: 列を隠す・前へ動かすと表に反映され、再読み込みでも保ち、元に戻せる", { tag: "@smoke" }, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoPage(page, "/contracts");
  const table = tableByCaption(page, "案件一覧");
  const before = await heads(table);
  expect(before[0]).toBe("name");
  const btn = block(page, table).locator(".yn-cols-btn");
  await btn.click();
  await expect(btn).toHaveAttribute("aria-expanded", "true");
  // 先頭（案件名）の列は一覧に出さない（固定）
  await expect(pop(page).locator('.yn-cols-item[data-key="name"]')).toHaveCount(0);
  await pop(page).locator('.yn-cols-item[data-key="cost"] input').uncheck();
  await pop(page).locator('.yn-cols-item[data-key="grossMargin"] button[data-dir="up"]').click();
  const after = await heads(table);
  expect(after).not.toContain("cost");
  expect(after.indexOf("grossMargin")).toBeLessThan(after.indexOf("grossProfit"));
  expect(after[0]).toBe("name");
  // 本文の列の数も見出しと同じ
  await expect(dataRows(table).first().locator("th, td")).toHaveCount(after.length);
  await page.keyboard.press("Escape");
  await expect(pop(page)).toHaveCount(0);
  await expect(btn).toBeFocused();
  await expect(btn).toHaveClass(/is-active/);

  await page.reload();
  const t2 = tableByCaption(page, "案件一覧");
  await expect(dataRows(t2).first()).toBeVisible();
  expect(await heads(t2)).toEqual(after);
  await block(page, t2).locator(".yn-cols-btn").click();
  await pop(page).getByRole("button", { name: "元に戻す" }).click();
  expect(await heads(t2)).toEqual(before);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("yojitsu-navi:columns:")))).toEqual([]);
});

test("選べる列（§106.1）: 既定では出さず、チェックすると値と合計が出て、再読み込みでも保つ", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoPage(page, "/contracts?unit=yen");
  const table = tableByCaption(page, "案件一覧");
  const before = await heads(table);
  for (const k of ["customerName", "hours", "personMonths", "forecastBudget", "totalAmount"]) expect(before).not.toContain(k);
  await block(page, table).locator(".yn-cols-btn").click();
  const hours = pop(page).locator('.yn-cols-item[data-key="hours"]');
  await expect(hours).toHaveClass(/is-off/);
  // ID だけの列は一覧にも出さない
  await expect(pop(page).locator('.yn-cols-item[data-key="contractId"]')).toHaveCount(0);
  await hours.locator("input").click();
  await pop(page).locator('.yn-cols-item[data-key="customerName"] input').click();
  await page.keyboard.press("Escape");
  const after = await heads(table);
  expect(after).toContain("hours");
  expect(after).toContain("customerName");
  // 値（時間）と合計行
  const col = after.indexOf("hours");
  await expect(dataRows(table).first().locator("th, td").nth(col)).toHaveText(/h$/);
  await expect(table.locator("tfoot td").nth(col)).toHaveText(/h$/);
  await page.reload();
  expect(await heads(tableByCaption(page, "案件一覧"))).toEqual(after);
});

test("データ確認: 作業した人の一覧は名前が先頭で、社員番号は選べる列", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoPage(page, "/data-check");
  const table = page.locator("table.yn-table").filter({ has: page.locator('thead th[data-key="memberName"]') }).first();
  await expect(table).toBeVisible();
  const h = await heads(table);
  expect(h[0]).toBe("memberName");
  expect(h).not.toContain("memberId");
});

test("隠した列の絞り込みは外れる。Excel は画面の列と並びに合わせる", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoPage(page, "/contracts?unit=yen");
  const table = tableByCaption(page, "案件一覧");
  const all = await dataRows(table).count();
  // 状態の列で「超過見込み」だけに絞る
  await table.locator('thead th[data-key="status"] .yn-filter-btn').click();
  const fp = page.locator(".yn-filter-pop");
  await fp.locator(".yn-filter-all input").uncheck();
  await fp.locator(".yn-filter-item", { hasText: "超過見込み" }).locator("input").check();
  await fp.getByRole("button", { name: "閉じる" }).click();
  const filtered = await dataRows(table).count();
  expect(filtered).toBeLessThan(all);
  await block(page, table).locator(".yn-cols-btn").click();
  await pop(page).locator('.yn-cols-item[data-key="status"] input').uncheck();
  await expect(dataRows(table)).toHaveCount(all);
  await expect(block(page, table).locator(".yn-filter-clear-all")).toBeHidden();
  await pop(page).locator('.yn-cols-item[data-key="budget"] button[data-dir="down"]').click();
  await page.keyboard.press("Escape");

  const [download] = await Promise.all([page.waitForEvent("download"), block(page, table).locator(".yn-export").click()]);
  const XLSX = await import("xlsx");
  const fs = await import("node:fs");
  const wb = XLSX.read(fs.readFileSync((await download.path())!));
  const header = (XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]!]!, { header: 1 }) as string[][])[1] ?? [];
  expect(header.some((h) => h.startsWith("状態"))).toBe(false);
  expect(header.findIndex((h) => h.startsWith("予算"))).toBeGreaterThan(header.findIndex((h) => h.startsWith("実績")));
});

test("長い文字の列は上限の幅で「…」になり、全文は title。ページは横にはみ出さない（390px）", async ({ page }) => {
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await gotoPage(page, "/data-check");
    const cells = page.locator("td.yn-cell-clip");
    await expect(cells.first()).toBeAttached();
    const clipped = await cells.evaluateAll((list) =>
      list
        .filter((c) => c.scrollWidth > c.clientWidth + 1)
        .map((c) => {
          // 列の幅は見出しの幅より狭くならない
          const th = c.closest("table")!.querySelectorAll("thead th")[(c as HTMLTableCellElement).cellIndex];
          return { title: c.getAttribute("title"), text: c.textContent, w: c.getBoundingClientRect().width, head: th?.scrollWidth ?? 0 };
        }),
    );
    expect(clipped.length).toBeGreaterThan(0);
    for (const c of clipped) {
      expect(c.title).toBe(c.text);
      expect(c.w).toBeLessThanOrEqual(Math.max(width <= 700 ? 200 : 320, c.head) + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});

test("マスタ編集の台帳: 値の列を隠す・動かすと履歴の行も揃い、タブを替えると一覧は閉じる", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoPage(page, "/masters");
  const table = page.locator(".yn-me-ledger");
  await expect(table.locator("tbody tr").first()).toBeVisible();
  const n = await table.locator("thead th").count();
  await page.locator('[data-fk="cols:members"]').click();
  await pop(page).locator('.yn-cols-item[data-key="kind"] input').uncheck();
  // 描き直しても一覧は開いたまま
  await expect(pop(page)).toBeVisible();
  await pop(page).locator('.yn-cols-item[data-key="status"] button[data-dir="up"]').click();
  await expect(table.locator("thead th")).toHaveCount(n - 1);
  const ths = await table.locator("thead th").allTextContents();
  expect(ths.some((t) => t.includes("区分"))).toBe(false);
  expect(ths.findIndex((t) => t.includes("在籍"))).toBeLessThan(ths.findIndex((t) => t.includes("所属チーム")));
  await expect(table.locator("tbody tr.yn-me-group").first().locator("th, td")).toHaveCount(n - 1);
  await page.locator("#yn-me-tab-rates").click();
  await expect(pop(page)).toHaveCount(0);
  await page.locator("#yn-me-tab-members").click();
  await expect(page.locator(".yn-me-ledger thead th")).toHaveCount(n - 1);
});
