/**
 * 試用版へのコメント対応（SPEC §51）の再発防止
 * 着地見込みの方式（計画値が既定・左端）、ヘッダーのテーマ切替の廃止、タブ「稼働実績」、
 * リソース計画の名前列の幅変更、使い方の表記
 */
import { test, expect, gotoPage } from "./helpers/app.js";

const WIDTH_KEY = "yojitsu-navi:plan-name-width";

test.describe("着地見込みの方式", () => {
  test("計画値が左端で既定に選ばれ、直近実績・全期間平均の順に並ぶ", { tag: "@smoke" }, async ({ page }) => {
    await gotoPage(page, "/");
    const labels = page.locator(".yn-filter-method .yn-radio span");
    await expect(labels).toHaveText(["計画値", "直近実績", "全期間平均"]);
    await expect(page.locator("#yn-method-assignment")).toBeChecked();
    await expect(page.locator(".yn-filter-method")).not.toContainText("アサイン");
  });

  test("URL で選んだ方式は既定より優先される", async ({ page }) => {
    await gotoPage(page, "/contracts?method=recent3");
    await expect(page.locator("#yn-method-recent3")).toBeChecked();
  });

  test("案件詳細の 3 方式の比較も計画値から並ぶ", async ({ page }) => {
    await gotoPage(page, "/contracts");
    // 行の中央は数値のボタン（計算根拠）に当たることがあるので、ボタンの無い状態の列を押す
    await page.locator("table tbody tr").first().locator("td").last().click();
    await expect(page).toHaveURL(/\/contract\?/);
    const cards = page.locator(".yn-forecast-card");
    await expect(cards).toHaveCount(3);
    await expect(cards.first()).toContainText("計画値");
  });
});

test("ヘッダーにテーマの切替ボタンは無く、右端は設定と「⋯」だけ", async ({ page }) => {
  await gotoPage(page, "/");
  await expect(page.locator(".yn-theme-toggle")).toHaveCount(0);
  await expect(page.locator(".yn-icon-tools > .yn-icon-btn, .yn-icon-tools .yn-more-btn")).toHaveCount(2);
});

test("上部タブは「稼働実績」（URL は /workload のまま）", async ({ page }) => {
  await gotoPage(page, "/");
  await page.locator(".yn-tabs").getByRole("link", { name: "稼働実績", exact: true }).click();
  await expect(page).toHaveURL(/\/workload/);
  await expect(page.locator("h1")).toHaveText("稼働実績");
  await expect(page.locator(".yn-tabs")).not.toContainText("工数");
});

test.describe("リソース計画: 名前列の幅", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.removeItem("yojitsu-navi:masters-draft:v1"));
  });

  const nameTh = (page: import("@playwright/test").Page) => page.locator(".yn-me-plan-table thead th").first();
  const width = async (page: import("@playwright/test").Page) => Math.round((await nameTh(page).boundingBox())!.width);

  test("境目をドラッグすると広がり、再読み込みしても保たれ、ダブルクリックで戻る", async ({ page }) => {
    await page.addInitScript((k) => {
      if (!sessionStorage.getItem("__init")) {
        localStorage.removeItem(k);
        sessionStorage.setItem("__init", "1");
      }
    }, WIDTH_KEY);
    await gotoPage(page, "/plan");
    const before = await width(page);
    const handle = page.locator(".yn-col-resizer");
    await expect(handle).toHaveAttribute("role", "separator");
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const after = await width(page);
    expect(after).toBeGreaterThan(before + 80);
    // 本文の名前のセルも同じ幅
    const rowTh = page.locator("tr.yn-me-plan-row th[scope=row]").first();
    expect(Math.abs(Math.round((await rowTh.boundingBox())!.width) - after)).toBeLessThanOrEqual(2);
    expect(Number(await page.evaluate((k) => localStorage.getItem(k), WIDTH_KEY))).toBeGreaterThan(before);

    await page.reload();
    await expect(page.locator(".yn-me-plan-table")).toBeVisible();
    expect(Math.abs((await width(page)) - after)).toBeLessThanOrEqual(2);

    await page.locator(".yn-col-resizer").dblclick();
    expect(Math.abs((await width(page)) - before)).toBeLessThanOrEqual(2);
    expect(await page.evaluate((k) => localStorage.getItem(k), WIDTH_KEY)).toBeNull();
  });

  test("矢印キーで変えられ、上限・下限で止まる。行を開いて描き直しても幅は保たれる", async ({ page }) => {
    await page.addInitScript((k) => localStorage.removeItem(k), WIDTH_KEY);
    await gotoPage(page, "/plan");
    const handle = page.locator(".yn-col-resizer");
    await handle.focus();
    for (let i = 0; i < 20; i++) await page.keyboard.press("Shift+ArrowRight");
    await expect(handle).toHaveAttribute("aria-valuenow", "480");
    await page.locator("tr.yn-me-plan-row").first().locator('button[data-fk^="plan:toggle:"]').click();
    expect(Math.abs((await width(page)) - 480)).toBeLessThanOrEqual(2);
    await page.locator(".yn-col-resizer").focus();
    for (let i = 0; i < 20; i++) await page.keyboard.press("Shift+ArrowLeft");
    await expect(page.locator(".yn-col-resizer")).toHaveAttribute("aria-valuenow", "100");
    // 狭くしても、チップのある人の名前は隠れない（チップは次の行へ）
    for (const name of await page.locator("tr.yn-me-plan-row .yn-me-plan-name").all()) {
      expect((await name.boundingBox())!.width).toBeGreaterThan(20);
    }
    // 狭くしても名前は省略表示で、表の外にはみ出さない
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("スマホ幅でも境目をドラッグできる（ページは横にはみ出さない）", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((k) => localStorage.removeItem(k), WIDTH_KEY);
    await gotoPage(page, "/plan");
    const before = await width(page);
    const box = (await page.locator(".yn-col-resizer").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    expect(await width(page)).toBeGreaterThan(before + 30);
    // 広げすぎても表示幅の 6 割で止まり、月の数値が見える
    await page.locator(".yn-col-resizer").focus();
    for (let i = 0; i < 20; i++) await page.keyboard.press("Shift+ArrowRight");
    expect(await width(page)).toBeLessThanOrEqual(Math.floor(390 * 0.6) + 1);
    await expect(page.locator(".yn-col-resizer")).toHaveAttribute("aria-valuenow", String(Math.floor(390 * 0.6)));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test("使い方: リーダー層向けの表記、画面の表に計算ルールを並べない、着地見込みは選んだ期間の終わりと明記", async ({ page }) => {
  await gotoPage(page, "/guide");
  const main = page.locator("#observablehq-main");
  await expect(main).not.toContainText("リーダー向け");
  await expect(main.getByRole("heading", { name: /マスタ編集（リーダー層向け）/ })).toBeVisible();
  await expect(main).not.toContainText("選んだ期間に関係なく");
  await expect(main).toContainText("選んだ期間の終わり");
  await expect(main).not.toContainText("☾");
  await expect(main.locator("td", { hasText: "数値の計算方法の詳細" })).toHaveCount(0);
  await expect(main.locator("td strong", { hasText: "アサイン計画" })).toHaveCount(0);
});

test("用語: メンバーの ID は「社員番号」と表示する（§54）", async ({ page }) => {
  for (const path of ["/data-check", "/members", "/masters"]) {
    await gotoPage(page, path);
    await expect(page.locator("#observablehq-main"), path).not.toContainText("メンバーID");
  }
  await gotoPage(page, "/data-check");
  await expect(page.locator("#observablehq-main th", { hasText: "社員番号" }).first()).toBeVisible();
});

test("リソース計画の検証: 手でビルドが要るように読める説明を出さない（§54）", async ({ page }) => {
  await gotoPage(page, "/plan");
  await expect(page.locator("#observablehq-main")).not.toContainText("ビルド");
});

test("設定の表示: 「自動」に今の色や由来を添えない、「差し色」と書かない（§55）", async ({ page }) => {
  await gotoPage(page, "/settings");
  const main = page.locator("#observablehq-main");
  await expect(main).not.toContainText("差し色");
  await expect(main).toContainText("テーマカラー");
  for (const name of ["yn-set-theme", "yn-set-accent"]) {
    await expect(page.locator(`input[name="${name}"][value="auto"]`).locator("xpath=..")).toHaveText("自動");
  }
});

test("設定画面は「表示」が一番上、リソース計画の人の行のボタンに「＋運用保守以外」を添えない（§55）", async ({ page }) => {
  await gotoPage(page, "/settings");
  await expect(page.locator(".yn-settings-section").first()).toHaveAttribute("aria-label", "表示");
  await gotoPage(page, "/plan");
  await expect(page.locator('[data-fk^="plan:toggle:"]').first()).toBeVisible();
  await expect(page.locator(".yn-me-plan-row").filter({ hasText: "運用保守以外" }).locator('[data-fk^="plan:toggle:"]')).toHaveCount(0);
});

test("リソース計画の人の行のボタンは「作業 n」。n は案件と、年度内に計画がある運用保守以外の種別の数（§57）", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  const toggles = page.locator('[data-fk^="plan:toggle:"]');
  await expect(toggles.first()).toHaveText(/^作業 \d+\s*▾$/);
  await expect(page.locator('[data-fk="plan:toggle:M011"]')).toHaveText(/^作業 1\s*▾$/);
  await expect(page.locator('[data-fk="plan:toggle:M011"]')).toHaveAttribute("aria-label", /の作業ごとの計画（1 件）/);
  await expect(page.locator(".yn-me-plan-row").filter({ hasText: /案件 \d+ ▾/ })).toHaveCount(0);
});
