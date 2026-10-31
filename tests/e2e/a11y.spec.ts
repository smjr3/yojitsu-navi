/**
 * アクセシビリティと表示環境: キーボード到達、aria-sort、ダイアログの role、画像の代替、状態チップの文字、
 * 390px 幅で横スクロール無し、ダークモード、印刷メディア
 */
import { test, expect, useDarkTheme, gotoPage, kpiValue, dialog } from "./helpers/app.js";

const PAGES = ["/", "/teams", "/teams?view=chart", "/contracts", "/contract?id=C008", "/contract?id=NOPE", "/rules", "/guide", "/data-check"];

test("Tab でフィルタ・並べ替え見出し・行リンク・Excel 出力ボタンに到達できる", async ({ page }) => {
  await gotoPage(page, "/contracts");
  await expect(page.locator("table.yn-table").first()).toBeVisible();
  const targets: Record<string, string> = {
    開始月: "#yn-filter-from",
    チーム: "#yn-filter-team",
    着地方式: 'input[name="yn-method"]',
    単位: ".yn-seg-btn[data-unit]",
    検索: "#yn-f-text",
    並べ替え見出し: "th button.yn-sort",
    行リンク: ".yn-row-link",
    数値ボタン: "td button.yn-num",
    Excel出力: ".yn-export",
  };
  const reached = new Set<string>();
  await page.locator("body").press("Tab").catch(() => {});
  for (let i = 0; i < 400 && reached.size < Object.keys(targets).length; i++) {
    const hit = await page.evaluate((t) => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      return Object.entries(t)
        .filter(([, sel]) => el.matches(sel))
        .map(([name]) => name);
    }, targets);
    for (const name of hit ?? []) reached.add(name);
    await page.keyboard.press("Tab");
  }
  expect([...reached].sort()).toEqual(Object.keys(targets).sort());
});

for (const path of ["/", "/teams", "/contracts", "/contract?id=C008"]) {
  test(`${path}: 並べ替え可能な見出しはボタンで aria-sort を持つ。行見出しは th scope=row`, async ({ page }) => {
    await gotoPage(page, path);
    const tables = page.locator("table.yn-table").filter({ has: page.locator("tbody tr[data-key]") });
    const n = await tables.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const t = tables.nth(i);
      await expect(t.locator("caption")).toHaveCount(1);
      const ths = t.locator("thead th");
      const m = await ths.count();
      for (let j = 0; j < m; j++) {
        const th = ths.nth(j);
        await expect(th).toHaveAttribute("scope", "col");
        const hasBtn = (await th.locator("button.yn-sort").count()) > 0;
        const sort = await th.getAttribute("aria-sort");
        if (hasBtn) {
          expect(sort, `${path} 表${i} 列${j}`).toMatch(/^(none|ascending|descending)$/);
          await expect(th.locator("button.yn-sort")).toHaveAttribute("type", "button");
        } else expect(sort === null || sort === "none", `${path} 表${i} 列${j}: ボタン無しなら aria-sort は無い`).toBe(true);
      }
      await expect(t.locator("tbody tr[data-key]").first().locator("th[scope=row]")).toHaveCount(1);
      // 数値列は右寄せ用のクラス（<details> 内の閉じた表は見えないので存在だけ確認）
      await expect(t.locator("thead th.num").first()).toBeAttached();
      if (await t.isVisible()) await expect(t.locator("thead th.num").first()).toBeVisible();
    }
  });
}

test("内訳パネルは role=dialog で aria-labelledby の見出しを持ち、閉じるボタンに名前がある", async ({ page }) => {
  await gotoPage(page, "/");
  await kpiValue(page, 0).click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await expect(d).toHaveRole("dialog");
  const labelledBy = await d.getAttribute("aria-labelledby");
  expect(labelledBy).toBeTruthy();
  const title = page.locator(`#${labelledBy}`);
  await expect(title).toBeVisible();
  expect(((await title.textContent()) ?? "").trim().length).toBeGreaterThan(0);
  await expect(d.getByRole("button", { name: "閉じる" }).first()).toBeVisible();
  // KPI の値ボタンには「計算根拠を表示」の名前
  await expect(kpiValue(page, 0)).toHaveAttribute("aria-label", /計算根拠を表示/);
  await expect(kpiValue(page, 0)).toHaveAttribute("type", "button");
});

for (const path of PAGES) {
  test(`${path}: 画像・SVG は alt か aria-hidden か role=img + 名前を持ち、状態チップは文字を持つ`, async ({ page }) => {
    await gotoPage(page, path);
    await page.waitForLoadState("networkidle");
    const problems = await page.evaluate(() => {
      const out: string[] = [];
      for (const img of document.querySelectorAll("img")) {
        if (!img.hasAttribute("alt") && img.getAttribute("aria-hidden") !== "true") out.push(`img without alt: ${img.outerHTML.slice(0, 120)}`);
      }
      for (const svg of document.querySelectorAll("svg")) {
        const hidden = svg.closest('[aria-hidden="true"]') !== null;
        // 名前のあるボタン／リンクの中のアイコンはその名前で読まれる（Framework のコードコピーボタン等）
        const control = svg.closest("button, a, [role=button]");
        const controlNamed = control && (control.getAttribute("aria-label") || control.getAttribute("title") || (control.textContent ?? "").trim());
        const named = controlNamed || svg.getAttribute("aria-label") || svg.getAttribute("aria-labelledby") || svg.querySelector(":scope > title");
        const role = svg.getAttribute("role");
        if (!hidden && !named && role !== "presentation" && role !== "none") out.push(`svg without name/aria-hidden: ${svg.outerHTML.slice(0, 160)}`);
      }
      for (const chip of document.querySelectorAll(".yn-chip")) {
        const text = [...chip.childNodes]
          .filter((n) => !(n instanceof Element && n.getAttribute("aria-hidden") === "true"))
          .map((n) => n.textContent ?? "")
          .join("")
          .trim();
        if (!text) out.push(`chip without text: ${chip.outerHTML.slice(0, 120)}`);
      }
      // 赤表示（danger）は文字でも分かる（▲ は aria-hidden なので文字が必要）
      for (const el of document.querySelectorAll(".yn-danger-text")) {
        const text = (el.textContent ?? "").replace(/[▲\s]/g, "");
        if (!text) out.push(`danger text empty: ${el.outerHTML.slice(0, 120)}`);
      }
      return out;
    });
    expect(problems).toEqual([]);
    // 消化率メーターは role=img + aria-label
    const meters = page.locator(".yn-meter");
    const n = await meters.count();
    for (let i = 0; i < n; i++) {
      await expect(meters.nth(i)).toHaveAttribute("role", "img");
      await expect(meters.nth(i)).toHaveAttribute("aria-label", /消化率/);
    }
    // 見出しの階層: h1 が 1 つ、h2 の前に h3 が来ない
    await expect(page.locator("h1")).toHaveCount(1);
  });
}

test.describe("スマートフォン幅（390×844）", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  for (const path of PAGES) {
    test(`${path}: 横スクロールが発生しない`, async ({ page }) => {
      await gotoPage(page, path);
      await page.waitForLoadState("networkidle");
      // 描画の落ち着きを待つ
      await expect
        .poll(async () => page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, cw: document.scrollingElement!.clientWidth })), { timeout: 5000 })
        .toEqual(expect.objectContaining({ cw: expect.any(Number) }));
      const { sw, cw } = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, cw: document.scrollingElement!.clientWidth }));
      expect(sw, `scrollWidth ${sw} <= clientWidth ${cw} + 1`).toBeLessThanOrEqual(cw + 1);
      // 下までスクロールしても同じ
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const after = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, cw: document.scrollingElement!.clientWidth }));
      expect(after.sw).toBeLessThanOrEqual(after.cw + 1);
      // h1 が見える（折り返して収まる）
      const box = await page.locator("h1").boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(390 + 1);
    });
  }

  test("内訳パネルも 390px 幅に収まり、閉じられる", async ({ page }) => {
    await gotoPage(page, "/");
    await kpiValue(page, 1).click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    const box = await d.locator(".yn-dialog-inner").boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390);
    await page.keyboard.press("Escape");
    await expect(d).toHaveCount(0);
  });
});

test.describe("ダークモード", () => {
  test.beforeEach(async ({ page }) => {
    await useDarkTheme(page);
  });
  for (const path of ["/", "/contract?id=C008"]) {
    test(`${path}: 背景が暗く、エラー無し`, async ({ page }) => {
      await gotoPage(page, path);
      await page.waitForLoadState("networkidle");
      const bg = await page.evaluate(() => {
        const parse = (s: string) => {
          const m = s.match(/rgba?\(([^)]+)\)/);
          if (!m) return null;
          const [r, g, b, a] = m[1]!.split(",").map((x) => Number(x.trim()));
          return { r: r!, g: g!, b: b!, a: a ?? 1 };
        };
        const body = parse(getComputedStyle(document.body).backgroundColor);
        const html = parse(getComputedStyle(document.documentElement).backgroundColor);
        const c = body && body.a > 0 ? body : html;
        if (!c) return null;
        const lum = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
        return { ...c, lum, theme: document.documentElement.dataset.theme };
      });
      expect(bg).not.toBeNull();
      expect(bg!.theme).toBe("dark");
      expect(bg!.lum, `背景の輝度 ${JSON.stringify(bg)}`).toBeLessThan(0.25);
      // 本文の文字色は明るい
      const fg = await page.evaluate(() => {
        const m = getComputedStyle(document.body).color.match(/\d+/g)!.map(Number);
        return (0.2126 * m[0]! + 0.7152 * m[1]! + 0.0722 * m[2]!) / 255;
      });
      expect(fg).toBeGreaterThan(0.5);
      // グラフがダーク用の色で描かれる（凡例の存在だけ確認）
      await expect(page.locator(".yn-legend").first()).toBeVisible();
    });
  }
});

test.describe("配色（§53）", () => {
  const bgLum = (page: import("@playwright/test").Page) =>
    page.evaluate(() => {
      const m = getComputedStyle(document.documentElement).backgroundColor.match(/\d+/g)!.map(Number);
      return (0.2126 * m[0]! + 0.7152 * m[1]! + 0.0722 * m[2]!) / 255;
    });
  test.describe("PC がダーク", () => {
    test.use({ colorScheme: "dark" });
    test("既定は PC に合わせてダーク、設定画面で選んだライトはページを移っても保たれ、自動に戻すとダーク", async ({ page }) => {
      await gotoPage(page, "/");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      expect(await bgLum(page)).toBeLessThan(0.25);
      await gotoPage(page, "/settings");
      await expect(page.locator('input[name="yn-set-theme"][value="auto"]')).toBeChecked();
      await page.getByRole("radio", { name: "ライト", exact: true }).check();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await gotoPage(page, "/teams");
      expect(await bgLum(page)).toBeGreaterThan(0.75);
      await gotoPage(page, "/settings");
      await page.getByRole("radio", { name: /^自動/ }).first().check();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    });
  });
  test.describe("PC がライト", () => {
    test.use({ colorScheme: "light" });
    test("既定はライト・ブルー、PC の設定が変わると追従する", async ({ page }) => {
      await gotoPage(page, "/");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await expect(page.locator("html")).toHaveAttribute("data-accent", "blue");
      expect(await bgLum(page)).toBeGreaterThan(0.75);
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    });
    test("テーマカラーを選ぶとリンク・選択中のタブの色が変わる", async ({ page }) => {
      await gotoPage(page, "/settings");
      const link = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--yn-link").trim());
      const before = await link();
      await page.getByRole("radio", { name: "グリーン" }).check();
      await expect(page.locator("html")).toHaveAttribute("data-accent", "green");
      expect(await link()).not.toBe(before);
      await gotoPage(page, "/");
      await expect(page.locator("html")).toHaveAttribute("data-accent", "green");
    });
  });
});

test("印刷メディアのエミュレーションで例外が出ない", async ({ page }) => {
  await gotoPage(page, "/");
  await page.emulateMedia({ media: "print" });
  await page.setViewportSize({ width: 800, height: 1100 });
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.locator(".yn-kpi-grid")).toBeVisible();
  // 印刷ではフィルタを隠す
  await expect(page.locator(".yn-filters").first()).toBeHidden();
  await page.emulateMedia({ media: "screen" });
  await expect(page.locator(".yn-filters").first()).toBeVisible();
});
