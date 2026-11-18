/**
 * 色の意味をアプリ全体でそろえる（SPEC §131）: 青 = 予算・計画、橙 = 実績、赤 = 予算の超過だけ、
 * 紫の破線 = 目標の上限（§140）、黄 = 計画より多い、赤紫 = 計画なし。ライト・ダークの両方で、凡例・グラフ・メーター・体制図が同じ意味の色になる
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";

/** charts.js の chartColors() と同じ値（ブラウザ用のモジュールなのでテストからは読めない） */
const chartColors = (dark: boolean) =>
  dark
    ? { budget: "#3987e5", cost: "#d95926", danger: "#d03b3b", target: "#b38cf6" }
    : { budget: "#2a78d6", cost: "#eb6834", danger: "#d03b3b", target: "#7b3fd1" };

/** scope の中のグラフ（svg）で、目標の色の線が描かれている数 */
const targetStrokes = (page: Page, scope: string, color: string) =>
  page.locator(`${scope} svg`).evaluateAll((svgs, color) => svgs.reduce((n, svg) => n + [...svg.querySelectorAll("[stroke]")].filter((e) => e.getAttribute("stroke")!.toLowerCase() === color).length, 0), color);

/** 凡例の各項目: 文字と見本の色（--c） */
const legendItems = (page: Page, scope: string) =>
  page.locator(`${scope} .yn-legend li`).evaluateAll((els) =>
    els.map((li) => ({ text: (li.textContent ?? "").trim(), color: (li.querySelector(".yn-legend-swatch") as HTMLElement | null)?.style.getPropertyValue("--c").trim().toLowerCase() ?? "" })),
  );

for (const dark of [false, true]) {
  test.describe(dark ? "ダーク" : "ライト", () => {
    test.beforeEach(async ({ page }) => {
      if (dark) await useDarkTheme(page);
    });
    const c = chartColors(dark);

    test("今月の進捗: 予算の上限は青、凡例は 予算 → 実績 の順", async ({ page }) => {
      await gotoPage(page, "/");
      const items = await legendItems(page, "#yn-daily");
      expect(items.length).toBeGreaterThan(0);
      // 予算の上限は目標があっても青（§140）
      expect(items.find((it) => it.text === "上限（予算）")?.color).toBe(c.budget);
      const idx = (t: string) => items.findIndex((it) => it.text.includes(t));
      expect(idx("上限（予算）")).toBeLessThan(idx("実績の累計"));
      expect(items.find((it) => it.text === "実績の累計")!.color).toBe(c.cost);
    });

    test("リソース計画の金額: 予算は青で凡例の先頭、顧客の色に青・橙・赤を使わない", async ({ page }) => {
      await gotoPage(page, "/plan?team=D1");
      await page.locator('[data-fk="plan:chart:amount"]').click();
      const items = await legendItems(page, "figure.yn-me-plan-chart");
      expect(items[0]).toEqual({ text: "予算", color: c.budget });
      const customers = items.slice(1).filter((it) => it.text !== "目標の上限");
      for (const it of customers) expect([c.budget, c.cost, c.danger, c.target]).not.toContain(it.color);
    });

    test("目標の上限は赤と分けた紫の破線: 月次推移（月・四半期）・今月の進捗・金額のグラフと凡例（§140）", async ({ page }) => {
      expect([c.budget, c.cost, c.danger]).not.toContain(c.target);
      // T212 は基準月（10 月）から 12 月まで月ごとの目標がある
      await gotoPage(page, "/team?id=T212");
      const monthly = ".yn-chart-card:has-text('月次推移')";
      expect((await legendItems(page, monthly)).find((it) => it.text === "目標の上限")?.color).toBe(c.target);
      expect(await targetStrokes(page, monthly, c.target)).toBeGreaterThan(0);
      await page.locator(`${monthly} .yn-chart-unit button`, { hasText: /^(✓ )?四半期$/ }).first().click();
      await expect.poll(() => targetStrokes(page, monthly, c.target)).toBeGreaterThan(0);
      expect((await legendItems(page, monthly)).find((it) => it.text === "目標の上限")?.color).toBe(c.target);
      const daily = await legendItems(page, "#yn-daily");
      // 目標があっても予算の上限（青の実線）を出し、目標は凡例の最後
      expect(daily.find((it) => it.text === "上限（予算）")?.color).toBe(c.budget);
      expect(daily[daily.length - 1]).toEqual({ text: "上限（目標）", color: c.target });
      expect(await targetStrokes(page, "#yn-daily", c.target)).toBeGreaterThan(0);

      await gotoPage(page, "/plan?team=D1");
      await page.locator('[data-fk="plan:chart:amount"]').click();
      expect((await legendItems(page, "figure.yn-me-plan-chart")).find((it) => it.text === "目標の上限")?.color).toBe(c.target);
      expect(await targetStrokes(page, "figure.yn-me-plan-chart", c.target)).toBeGreaterThan(0);
    });

    test("消化率のメーターの塗りは実績の橙（超過は赤）", async ({ page }) => {
      await gotoPage(page, "/");
      const fills = await page.locator(".yn-meter").evaluateAll((els) =>
        els.map((m) => ({ over: m.classList.contains("is-danger"), bg: getComputedStyle(m.querySelector(".yn-meter-fill")!).backgroundColor })),
      );
      expect(fills.length).toBeGreaterThan(0);
      const cost = await page.evaluate(() => {
        const d = document.createElement("div");
        d.style.background = "var(--yn-series-cost)";
        document.body.append(d);
        const v = getComputedStyle(d).backgroundColor;
        d.remove();
        return v;
      });
      for (const f of fills.filter((x) => !x.over)) expect(f.bg).toBe(cost);
    });

    test("体制図: 計画なしはリソース計画と同じ赤紫", async ({ page }) => {
      await gotoPage(page, "/teams?view=chart");
      const [swatch, empty] = await page.evaluate(() => {
        const bg = (cls: string) => {
          const d = document.createElement("span");
          d.className = cls;
          document.querySelector(".yn-org")!.append(d);
          const v = getComputedStyle(d).backgroundColor;
          d.remove();
          return v;
        };
        return [bg("yn-org-swatch is-empty"), bg("yn-chip-empty")];
      });
      expect(swatch).toBe(empty);
      await expect(page.locator(".yn-org-legend-item", { hasText: "計画なし" }).locator(".is-empty")).toHaveCount(1);
    });
  });
}
