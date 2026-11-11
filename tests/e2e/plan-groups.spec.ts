/**
 * リソース計画の人の行と作業の行の見分け・開閉（SPEC §111）
 * - 開閉は名前の欄のボタン（▸／▾・名前・作業の数）。操作列には開閉のボタンを置かない
 * - 「すべて開く／すべて閉じる」は表示中（絞り込み後）の人が対象
 * - 開いている人はタブ単位で覚える（再読み込みしても開いたまま）
 * - 作業の行は一段下げて枝の線。開いたまとまりの上下に太い区切り線
 * - 390px・ダークで横スクロール無し、名前が隠れない
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";

const toggle = (page: Page, member: string) => page.locator(`[data-fk="plan:toggle:${member}"]`);
const subs = (page: Page, member: string) => page.locator(`tr.yn-me-plan-sub[data-parent="${member}"]`);
const expandAll = (page: Page) => page.locator('[data-fk="plan:expand-all"]');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem("yojitsu-navi:masters-draft:v1");
    sessionStorage.removeItem("yojitsu-navi:masters-draft-session");
  });
});

test("名前の ▸ を押すと作業の行が開き ▾ になる。作業の数は名前の横、操作列に開閉のボタンは無い", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  const t = toggle(page, "M010");
  // 開閉のボタンは名前の欄（行見出し）の中
  await expect(page.locator('tr.yn-me-plan-row[data-member="M010"] > th [data-fk="plan:toggle:M010"]')).toHaveCount(1);
  await expect(page.locator('tr.yn-me-plan-row[data-member="M010"] .yn-me-row-actions [data-fk^="plan:toggle:"]')).toHaveCount(0);
  await expect(t).toContainText("中村 拓也");
  await expect(t.locator(".yn-me-plan-caret")).toHaveText("▸");
  await expect(t.locator(".yn-me-plan-count")).toHaveText("3");
  await expect(t).toHaveAttribute("aria-expanded", "false");
  await expect(subs(page, "M010")).toHaveCount(0);

  // 名前の文字を押しても開く（押せる範囲 = 名前の欄）
  await t.locator(".yn-me-plan-name").click();
  await expect(toggle(page, "M010")).toHaveAttribute("aria-expanded", "true");
  await expect(toggle(page, "M010").locator(".yn-me-plan-caret")).toHaveText("▾");
  await expect(subs(page, "M010")).toHaveCount(3);
  await expect(toggle(page, "M010")).toBeFocused();

  // Enter でも閉じる
  await page.keyboard.press("Enter");
  await expect(toggle(page, "M010")).toHaveAttribute("aria-expanded", "false");
  await expect(subs(page, "M010")).toHaveCount(0);
});

test("「すべて開く」で表示中の人をまとめて開き、「すべて閉じる」で閉じる。絞り込んだときは表示中の人だけ", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  const rows = page.locator("tr.yn-me-plan-row");
  const n = await rows.count();
  expect(n).toBeGreaterThan(1);
  await expect(expandAll(page)).toHaveText(/すべて開く/);
  await expandAll(page).click();
  await expect(page.locator('tr.yn-me-plan-row [data-fk^="plan:toggle:"][aria-expanded="true"]')).toHaveCount(n);
  await expect(expandAll(page)).toHaveText(/すべて閉じる/);
  await expect(expandAll(page)).toBeFocused();
  await expandAll(page).click();
  await expect(page.locator('tr.yn-me-plan-sub')).toHaveCount(0);

  // 1 人だけ開いていれば「すべて開く」
  await toggle(page, "M010").click();
  await expect(expandAll(page)).toHaveText(/すべて開く/);

  // 絞り込んだら、表示中の人だけが対象
  await page.locator("#yn-me-plan-q").fill("小林");
  await expect(rows).toHaveCount(1);
  await expandAll(page).click();
  await page.locator("#yn-me-plan-q").fill("");
  await expect(rows).toHaveCount(n);
  await expect(page.locator('tr.yn-me-plan-row [data-fk^="plan:toggle:"][aria-expanded="true"]')).toHaveCount(2);
});

test("開いている人はタブで覚え、再読み込みしても開いたまま", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  await toggle(page, "M011").click();
  await expect(subs(page, "M011").first()).toBeVisible();
  await page.reload();
  await expect(toggle(page, "M011")).toHaveAttribute("aria-expanded", "true");
  await expect(subs(page, "M011").first()).toBeVisible();
  await expect(toggle(page, "M010")).toHaveAttribute("aria-expanded", "false");
});

test("作業の行は一段下げて枝の線、最後の作業の行で線が止まる。開いたまとまりの上下に太い区切り線", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  await toggle(page, "M010").click();
  const mainTh = page.locator('tr.yn-me-plan-row[data-member="M010"] > th');
  const sub = subs(page, "M010");
  await expect(sub).toHaveCount(3);
  // 一段下げ: 作業の名前は人の名前より右
  const nameX = (await toggle(page, "M010").locator(".yn-me-plan-name").boundingBox())!.x;
  const subX = (await sub.first().locator(".yn-me-plan-name").boundingBox())!.x;
  expect(subX - nameX).toBeGreaterThanOrEqual(12);
  // 枝の線: 最後の作業の行だけ is-last で、線は行の途中で止まる
  await expect(sub.last()).toHaveClass(/is-last/);
  await expect(page.locator('tr.yn-me-plan-sub.is-last[data-parent="M010"]')).toHaveCount(1);
  const line = (i: number) =>
    sub.nth(i).locator("th").evaluate((el) => {
      const s = getComputedStyle(el, "::before");
      return { content: s.content, bottom: s.bottom, border: s.borderLeftWidth };
    });
  const first = await line(0);
  expect(first.content).not.toBe("none");
  expect(first.border).toBe("1px");
  expect(first.bottom).toBe("0px");
  expect((await line(2)).bottom).not.toBe("0px");
  // 太い区切り: 開いた人の行の上（先頭の行でなければ）と、まとまりの次の人の行の上
  // （開閉で行の位置が動かないよう、枠線でなく内側の影の 2px）
  const topLine = (loc: typeof mainTh) => loc.evaluate((el) => getComputedStyle(el).boxShadow);
  const next = page.locator("tr.yn-me-plan-sub.is-last[data-parent='M010'] + tr.yn-me-plan-row > td").first();
  await expect(next).toHaveCount(1);
  expect(await topLine(next)).toMatch(/0px 2px 0px 0px inset/);
  await toggle(page, "M011").click();
  expect(await topLine(page.locator('tr.yn-me-plan-row[data-member="M011"] > th'))).toMatch(/0px 2px 0px 0px inset/);
  // 人の行の名前は太字、作業の行の名前より太い
  const weight = (loc: ReturnType<Page["locator"]>) => loc.evaluate((el) => Number(getComputedStyle(el).fontWeight));
  expect(await weight(mainTh.locator(".yn-me-plan-name"))).toBeGreaterThan(await weight(sub.first().locator(".yn-me-plan-name")));
});

test("変更の履歴を最後の作業の行の下に開いても、枝の線は最後の作業の行で止まる", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  await toggle(page, "M010").click();
  const last = page.locator('tr.yn-me-plan-sub.is-last[data-parent="M010"]');
  await last.locator('[data-fk^="plan:hist:"]').click();
  const hist = page.locator("tr.yn-me-plan-hist").last();
  await expect(hist).toHaveClass(/is-after-last/);
  expect(await hist.locator("td").evaluate((el) => getComputedStyle(el, "::before").content)).toBe("none");
});

for (const dark of [false, true]) {
  test(`390px${dark ? "・ダーク" : ""}: すべて開いても横スクロールせず、名前が読める`, async ({ page }) => {
    if (dark) await useDarkTheme(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoPage(page, "/plan?team=T111");
    await expandAll(page).click();
    await expect(page.locator("tr.yn-me-plan-sub").first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const name = toggle(page, "M010").locator(".yn-me-plan-name");
    const clipped = await name.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(clipped).toBe(false);
  });
}
