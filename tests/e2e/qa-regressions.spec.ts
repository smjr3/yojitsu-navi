/**
 * 実操作 QA で見つかった不具合の再発防止
 * - URL の team にプロトタイプのキー（constructor 等）を入れても例外にならず、全体に戻る
 * - 960px 未満でも上部タブがすべて見える（2 段目に回る）
 * - 並べ替えは絞り込み・単位の変更や「戻る」で既定に戻らない。絞り込み・検索は「戻る」で復元される
 * - 案件詳細の ID は前後の空白・大文字小文字の違いを許す
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

test("案件一覧: 並べ替え・絞り込み・検索が、絞り込み変更と詳細からの「戻る」で保たれる", async ({ page }) => {
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

test("案件詳細: ID の前後の空白と大文字小文字の違いを許す", async ({ page }) => {
  await gotoPage(page, "/contract?id=c008%20");
  await expect(page.locator("h1")).toHaveText("こもれび出版 / 会員サイト保守");
  await expect(page.getByText("見つかりません")).toHaveCount(0);
});

test("スマホ幅ではヘッダを固定しない（画面の 1/4 を占めない）。PC 幅では固定する", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoPage(page, "/contracts");
  await page.mouse.wheel(0, 1500);
  await expect.poll(() => page.evaluate(() => document.querySelector("#observablehq-header")!.getBoundingClientRect().bottom)).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.mouse.wheel(0, 300);
  await expect.poll(() => page.evaluate(() => document.querySelector("#observablehq-header")!.getBoundingClientRect().top)).toBe(0);
});

test("「速報含む」のアイコンはフォントに頼らず円で描く", async ({ page }) => {
  await gotoPage(page, "/contracts");
  const icon = page.locator(".yn-icon-prelim").first();
  await expect(icon).toBeVisible();
  const box = (await icon.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(10);
  expect(box.height).toBeGreaterThanOrEqual(10);
});

test("スマホ幅のマスタ編集: 行を追加して表が右へスクロールしても、行のエラー文が見える", async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("yojitsu-navi:masters-draft:v1"));
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoPage(page, "/masters");
  await page.getByRole("tab", { name: /組織/ }).click();
  await page.locator('button[data-fk="add:teams"]').click();
  const dlg = page.locator("dialog[open]");
  // 親組織に自分自身を指す ID を入れてエラーの行を作る（リーダー・親組織は候補から選ぶ欄なので、存在しない値は ID 欄で作る）
  await dlg.locator('[name="team_id"]').fill("NOPE");
  await dlg.locator('[name="name"]').fill("自分が親");
  await dlg.locator('[name="parent_team_id"]').evaluate((el: HTMLSelectElement) => {
    el.append(new Option("NOPE", "NOPE", true, true));
  });
  await dlg.locator('[data-role="submit"]').click();
  if (await page.locator("dialog[open] .yn-me-confirm").isVisible().catch(() => false)) await page.locator('dialog[open] [data-role="submit"]').click();
  const ul = page.locator(".yn-me-issue-row .yn-me-issues").first();
  await expect(ul).toContainText("NOPE");
  await page.locator(".yn-me-issue-row").first().evaluate((tr) => tr.closest(".yn-table-wrap")!.scrollTo({ left: 10000 }));
  const box = (await ul.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
});

test("稼働計画のセルの編集欄を開いたまま狭い画面に変えても、画面内に収まり操作できる（モンキーテストで発見）", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  await page.locator('tr.yn-me-plan-row[data-member="M010"] [data-fk="plan:cell:M010:2027-01"]').click();
  const pop = page.locator("dialog.yn-plan-pop[open]");
  await expect(pop).toBeVisible();
  for (const width of [414, 1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    const box = (await pop.boundingBox())!;
    expect(box.x, `${width}px`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${width}px`).toBeLessThanOrEqual(width + 1);
    expect(box.y + box.height, `${width}px`).toBeLessThanOrEqual(801);
  }
  await pop.locator("#yn-plan-pop-new").click();
  await expect(pop.locator("#yn-plan-pop-new")).toBeFocused();
});
