/**
 * 実操作 QA で見つかった不具合の再発防止
 * - URL の team にプロトタイプのキー（constructor 等）を入れても例外にならず、全体に戻る
 * - 960px 未満でも上部タブがすべて見える（2 段目に回る）
 * - 並べ替えは絞り込み・単位の変更や「戻る」で既定に戻らない。絞り込み・検索は「戻る」で復元される
 * - 契約詳細の ID は前後の空白・大文字小文字の違いを許す
 */
import { test, expect, gotoPage, kpiValue } from "./helpers/app.js";

for (const team of ["constructor", "__proto__", "toString"]) {
  test(`team=${team} は未知のチームとして全体に戻る`, async ({ page }) => {
    await gotoPage(page, `/?team=${team}`);
    await expect(kpiValue(page, 0)).not.toHaveText(/^0\.0/);
    expect(new URL(page.url()).searchParams.get("team")).toBe("");
    await gotoPage(page, "/contracts");
    expect(await page.locator("table tbody tr[data-key]").count()).toBeGreaterThan(0);
  });
}

for (const width of [768, 900]) {
  test(`${width}px 幅で上部タブがすべて見える`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await gotoPage(page, "/contracts");
    const visible = await page.evaluate(() => {
      const nav = document.querySelector(".yn-tabs")!.getBoundingClientRect();
      return [...document.querySelectorAll(".yn-tab")].every((t) => {
        const r = t.getBoundingClientRect();
        return r.left >= nav.left - 1 && r.right <= nav.right + 1;
      });
    });
    expect(visible).toBe(true);
  });
}

test("契約一覧: 並べ替え・絞り込み・検索が、絞り込み変更と詳細からの「戻る」で保たれる", async ({ page }) => {
  await gotoPage(page, "/contracts");
  const sortTh = page.locator('th[data-key="grossMargin"]');
  await sortTh.locator("button").click();
  const dir = await sortTh.getAttribute("aria-sort");
  await page.locator('label[for="yn-f-prelim"]').click();
  await expect(page.locator('th[data-key="grossMargin"]')).toHaveAttribute("aria-sort", dir!);
  await page.fill("#yn-f-text", "保守");
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("保守");
  expect(new URL(page.url()).searchParams.get("f")).toBe("prelim");
  const count = await page.locator("table tbody tr[data-key]").count();
  await page.locator(".yn-row-link").first().click();
  await expect(page).toHaveURL(/\/contract\?/);
  await page.goBack();
  await expect(page.locator("#yn-f-text")).toHaveValue("保守");
  await expect(page.locator("#yn-f-prelim")).toBeChecked();
  await expect(page.locator('th[data-key="grossMargin"]')).toHaveAttribute("aria-sort", dir!);
  await expect(page.locator("table tbody tr[data-key]")).toHaveCount(count);
});

test("契約詳細: ID の前後の空白と大文字小文字の違いを許す", async ({ page }) => {
  await gotoPage(page, "/contract?id=c008%20");
  await expect(page.locator("h1")).toContainText("C008");
  await expect(page.getByText("見つかりません")).toHaveCount(0);
});
