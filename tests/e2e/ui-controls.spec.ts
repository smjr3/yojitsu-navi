/**
 * 画面の操作部品: テーマ切替（既定ライト）・期間の「今月」とカレンダー指定・見出し横の「?」の吹き出し
 * 各画面幅・ライト/ダークで、操作できること、画面からはみ出さないことを確かめる
 */
import type { Page } from "@playwright/test";
import { test, expect, useDarkTheme, gotoPage } from "./helpers/app.js";
import { getModel, presetPeriod } from "./helpers/core.js";

const model = getModel();
const { minMonth, maxMonth } = model.meta;

/** ルート要素の背景の明るさ（0〜1） */
const bgLum = (page: Page) =>
  page.evaluate(() => {
    const m = getComputedStyle(document.documentElement).backgroundColor.match(/\d+/g)!.map(Number);
    return (0.2126 * m[0]! + 0.7152 * m[1]! + 0.0722 * m[2]!) / 255;
  });

/** 月次グラフの棒の色（予算・実績の系列色） */
const chartFills = (page: Page) =>
  page.evaluate(() => [...new Set([...document.querySelectorAll(".yn-chart-card svg [fill]")].map((e) => e.getAttribute("fill")))].sort().join(","));

test.describe("テーマ切替", () => {
  test("グラフの色もリロードなしで切り替わる（全体サマリー・メンバー詳細）", async ({ page }) => {
    for (const path of ["/", "/member?id=M011"]) {
      await gotoPage(page, path);
      await expect(page.locator(".yn-chart-card svg").first()).toBeVisible();
      const light = await chartFills(page);
      await page.locator(".yn-theme-toggle").click();
      await expect.poll(() => chartFills(page)).not.toBe(light);
      await page.locator(".yn-theme-toggle").click();
      await expect.poll(() => chartFills(page)).toBe(light);
    }
  });

  test("キーボード（Tab で移動して Enter）で切り替えられる", async ({ page }) => {
    await gotoPage(page, "/teams");
    const toggle = page.locator(".yn-theme-toggle");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(await bgLum(page)).toBeLessThan(0.25);
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  test("ストレージが使えなくても既定のライトで表示され、切替は効く", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", { get: () => { throw new Error("blocked"); } });
    });
    await gotoPage(page, "/");
    expect(await bgLum(page)).toBeGreaterThan(0.75);
    await page.locator(".yn-theme-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("保存値が不正でもライトになる", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("yn-theme", "purple"));
    await gotoPage(page, "/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator(".yn-theme-toggle")).toHaveAttribute("aria-pressed", "false");
  });
});

test.describe("期間: 今月とカレンダー指定", () => {
  test("「今月」は基準月の 1 か月だけになり、ボタンが選択状態になる", async ({ page }) => {
    await gotoPage(page, "/contracts");
    await page.locator('button[data-preset="thisMonth"]').click();
    const p = presetPeriod("thisMonth", model);
    expect(p.from).toBe(model.meta.asOfMonth);
    await expect(page.locator("#yn-filter-from")).toHaveValue(p.from);
    await expect(page.locator("#yn-filter-to")).toHaveValue(p.to);
    await expect(page).toHaveURL(new RegExp(`from=${p.from}&to=${p.to}`));
    await expect(page.locator('button[data-preset="thisMonth"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('button[data-preset="fy"]')).toHaveAttribute("aria-pressed", "false");
  });

  test("カレンダーで同じ月を選ぶと「今月」が選択状態になる", async ({ page }) => {
    await gotoPage(page, "/");
    const m = model.meta.asOfMonth;
    await page.locator("#yn-filter-from-date").fill(`${m}-10`);
    await page.locator("#yn-filter-to-date").fill(`${m}-20`);
    await expect(page.locator('button[data-preset="thisMonth"]')).toHaveAttribute("aria-pressed", "true");
  });

  test("データ範囲外の日付は範囲の端の月に収まり、選べる範囲（min/max）も範囲どおり", async ({ page }) => {
    await gotoPage(page, "/contracts");
    await expect(page.locator("#yn-filter-from-date")).toHaveAttribute("min", `${minMonth}-01`);
    await page.locator("#yn-filter-from-date").fill("2001-01-01");
    await page.locator("#yn-filter-to-date").fill("2099-12-31");
    await expect(page.locator("#yn-filter-from")).toHaveValue(minMonth);
    await expect(page.locator("#yn-filter-to")).toHaveValue(maxMonth);
    await expect(page.locator("h1")).toHaveCount(1);
  });

  test("日付を消しても期間は変わらない。2 月末も正しい末日になる", async ({ page }) => {
    await gotoPage(page, "/?from=2026-04&to=2027-02");
    await expect(page.locator("#yn-filter-to-date")).toHaveValue("2027-02-28");
    await page.locator("#yn-filter-from-date").fill("");
    await expect(page.locator("#yn-filter-from")).toHaveValue("2026-04");
    await expect(page.locator("#yn-filter-to")).toHaveValue("2027-02");
  });
});

test.describe("見出し横の「?」", () => {
  /** 開いている吹き出しの位置 */
  const popBox = (page: Page) =>
    page.evaluate(() => {
      const pop = document.querySelector(".yn-tip.is-open .yn-tip-pop");
      if (!pop) return null;
      const r = pop.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight };
    });

  for (const width of [320, 390, 768]) {
    test(`${width}px: どの「?」の説明も画面内に収まる`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      for (const path of ["/", "/contracts", "/team?id=S21", "/masters"]) {
        await gotoPage(page, path);
        const n = await page.locator(".yn-tip-btn").count();
        expect(n, path).toBeGreaterThan(0);
        for (let i = 0; i < n; i++) {
          const btn = page.locator(".yn-tip-btn").nth(i);
          await btn.scrollIntoViewIfNeeded();
          await btn.click();
          const b = await popBox(page);
          expect(b, `${path} #${i}`).not.toBeNull();
          expect(b!.left, `${path} #${i}`).toBeGreaterThanOrEqual(0);
          expect(b!.right, `${path} #${i}`).toBeLessThanOrEqual(b!.vw);
          expect(b!.bottom, `${path} #${i}`).toBeLessThanOrEqual(b!.vh);
          await btn.press("Escape");
          await expect(page.locator(".yn-tip.is-open")).toHaveCount(0);
        }
      }
    });
  }

  test("画面の下端近くの「?」は説明を上に出す", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 450 });
    await gotoPage(page, "/contracts");
    const btn = page.locator(".yn-section-head .yn-tip-btn").first();
    const btnBox = (await btn.boundingBox())!;
    expect(btnBox.y + btnBox.height).toBeGreaterThan(300);
    // スクロールせずに開く（スクロールすると閉じる仕様のため）
    await btn.focus();
    const b = await popBox(page);
    expect(b).not.toBeNull();
    expect(b!.bottom).toBeLessThanOrEqual(btnBox.y);
    expect(b!.top).toBeGreaterThanOrEqual(0);
  });

  test("ほかの「?」を押すと前の説明は閉じ、外を押しても閉じる", async ({ page }) => {
    await gotoPage(page, "/team?id=S21");
    const btns = page.locator(".yn-tip-btn");
    await btns.nth(0).click();
    await expect(page.locator(".yn-tip.is-open")).toHaveCount(1);
    await btns.nth(1).click();
    await expect(page.locator(".yn-tip.is-open")).toHaveCount(1);
    await expect(btns.nth(1)).toHaveAttribute("aria-expanded", "true");
    await expect(btns.nth(0)).toHaveAttribute("aria-expanded", "false");
    await page.locator("h1").click();
    await expect(page.locator(".yn-tip.is-open")).toHaveCount(0);
  });

  test.describe("ダーク", () => {
    test.beforeEach(async ({ page }) => {
      await useDarkTheme(page);
    });
    test("吹き出しは暗い面に明るい文字で読める", async ({ page }) => {
      await gotoPage(page, "/contracts");
      await page.locator(".yn-tip-btn").first().click();
      const c = await page.evaluate(() => {
        const s = getComputedStyle(document.querySelector(".yn-tip.is-open .yn-tip-pop")!);
        const lum = (v: string) => {
          const m = v.match(/\d+/g)!.map(Number);
          return (0.2126 * m[0]! + 0.7152 * m[1]! + 0.0722 * m[2]!) / 255;
        };
        return { bg: lum(s.backgroundColor), fg: lum(s.color) };
      });
      expect(c.bg).toBeLessThan(0.2);
      expect(c.fg).toBeGreaterThan(0.6);
    });
  });
});
