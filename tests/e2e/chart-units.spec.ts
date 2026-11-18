/**
 * グラフの単位の切り替え（SPEC §130）: 月次推移・メンバー詳細の時間グラフは 日・週・月・四半期・年度、
 * 今月の進捗は 週・月・四半期・年度。日・週の日ごとのデータは選んだときに初めて読む。選んだ単位はブラウザに覚える
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";
import { getModel } from "./helpers/core.js";

const model = getModel();
const fy = model.meta.fiscalYear;
const figure = (page: Page) => page.locator(".yn-unit-figure").first();
const unitBtn = (page: Page, label: string) => figure(page).locator(".yn-chart-unit button", { hasText: new RegExp(`^(✓ )?${label}$`) });
const plot = (page: Page) => figure(page).locator('svg[role="img"]');
const ticks = (page: Page) => plot(page).locator('[aria-label="x-axis tick label"] text');

test("月次推移: 四半期・年度は月を足した棒になり、表の期間・合計も同じ", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/");
  await expect(unitBtn(page, "月")).toHaveAttribute("aria-pressed", "true");
  await unitBtn(page, "四半期").click();
  await expect(unitBtn(page, "四半期")).toHaveAttribute("aria-pressed", "true");
  await expect(ticks(page).first()).toContainText(`${String(fy).slice(2)}年度Q1`);
  await figure(page).locator("summary", { hasText: "表で見る" }).click();
  const table = figure(page).locator("table");
  await expect(table.locator("thead th").first()).toContainText("期間");
  await expect(table.locator("tbody tr").first()).toContainText(`${fy}年度 第1四半期`);
  // 期間（今年度）の 4 四半期
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await unitBtn(page, "年度").click();
  await expect(ticks(page)).toHaveText([`${fy}年度`]);
});

test("月次推移: 日・週は選んだときに日ごとの実績を読み、日は終わりの 3 か月", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (r) => {
    if (/daily-history|member-days/.test(r.url())) requested.push(r.url());
  });
  await gotoPage(page, "/");
  await expect(plot(page)).toBeVisible();
  expect(requested, "月のままなら日ごとの実績を読まない").toEqual([]);
  await unitBtn(page, "週").click();
  await expect(plot(page)).toBeVisible();
  expect(requested.length).toBe(1);
  // 週の目盛りは月曜の日付
  await expect(ticks(page).first()).toHaveText(/^\d{2}\/\d{1,2}\/\d{1,2}$/);
  // 斜線（今月の速報）と破線（見込み）の棒が出る
  await expect(plot(page).locator('[fill^="url(#yn-hatch-"]').first()).toBeAttached();
  await unitBtn(page, "日").click();
  await expect(plot(page)).toBeVisible();
  // 同じファイルは 1 回だけ読む
  expect(requested.length).toBe(1);
  await expect(figure(page).locator('.yn-chart-zoom-btn')).toBeVisible();
  await figure(page).locator("summary", { hasText: "表で見る" }).click();
  const rows = figure(page).locator("table tbody tr");
  const first = model.meta.asOfMonth.slice(0, 4) + "年";
  await expect(rows.first()).toContainText(first);
  // 3 か月分の日（約 92 行）
  const n = await rows.count();
  expect(n).toBeGreaterThan(80);
  expect(n).toBeLessThan(95);
});

test("選んだ単位はブラウザに覚える（再読み込み・チーム詳細でも同じ）", async ({ page }) => {
  await gotoPage(page, "/");
  await unitBtn(page, "四半期").click();
  await page.reload();
  await expect(unitBtn(page, "四半期")).toHaveAttribute("aria-pressed", "true");
  await gotoPage(page, "/team?id=T111");
  await expect(unitBtn(page, "四半期")).toHaveAttribute("aria-pressed", "true");
  await unitBtn(page, "月").click();
  await page.reload();
  await expect(unitBtn(page, "月")).toHaveAttribute("aria-pressed", "true");
});

test("今月の進捗: 今四半期・今年度に切り替えられる（週・日は無い）（見出し・KPI・凡例の言葉も変わる）", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/");
  const sec = page.locator("#yn-daily");
  const btn = (label: string) => sec.locator(".yn-chart-unit button", { hasText: new RegExp(`^(✓ )?${label}$`) });
  await expect(sec.locator("h2").first()).toContainText("今月の進捗");
  await expect(btn("日")).toHaveCount(0);
  await expect(btn("週")).toHaveCount(0);
  await btn("年度").click();
  await expect(sec.locator("h2").first()).toContainText(`今年度の進捗（${fy}年度・速報）`);
  await expect(sec.locator(".yn-kpi").first()).toContainText("今年度の上限");
  await expect(sec.locator(".yn-legend")).toContainText("年度末見込み");
  await expect(sec.locator(".yn-kpi")).toHaveCount(4);
  await expect(sec.locator('svg[role="img"]')).toBeVisible();
  await btn("四半期").click();
  await expect(sec.locator("h2").first()).toContainText("今四半期の進捗");
  await btn("月").click();
  await expect(sec.locator("h2").first()).toContainText("今月の進捗");
});

test("今月の進捗: チーム詳細のメンバーごとの今月の時間は、範囲を変えても今月のまま", async ({ page }) => {
  await gotoPage(page, "/team?id=T111");
  const sec = page.locator("#yn-daily");
  await sec.locator(".yn-chart-unit button", { hasText: "四半期" }).click();
  await expect(sec.locator("h2").first()).toContainText("今四半期の進捗");
  await expect(sec.locator("h2", { hasText: "メンバーごとの今月の時間" })).toBeVisible();
});

test("メンバー詳細: 計画と実績の時間を 日・週・四半期 に切り替えられる", async ({ page }) => {
  await gotoPage(page, "/member?id=M010");
  await unitBtn(page, "週").click();
  await expect(plot(page)).toHaveAttribute("aria-label", /週ごとの計画時間と実績時間/);
  await unitBtn(page, "日").click();
  await expect(plot(page)).toHaveAttribute("aria-label", /日ごとの計画時間と実績時間/);
  await expect(plot(page).locator("rect").first()).toBeAttached();
  await unitBtn(page, "四半期").click();
  await expect(ticks(page).first()).toContainText("Q1");
});

for (const [w, dark] of [
  [390, true],
  [768, false],
  [1024, true],
  [1280, false],
] as const) {
  test(`切り替えのボタンとグラフが画面からはみ出さない（${w}px${dark ? "・ダーク" : ""}）`, async ({ page }) => {
    if (dark) await useDarkTheme(page);
    await page.setViewportSize({ width: w, height: 900 });
    await gotoPage(page, "/");
    for (const [label, progress] of [["週", "四半期"], ["年度", "年度"]] as const) {
      await unitBtn(page, label).click();
      await expect(plot(page)).toBeVisible();
      await page.locator("#yn-daily .yn-chart-unit button", { hasText: progress }).click();
      await expect(page.locator("#yn-daily svg[role='img']")).toBeVisible();
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, `${label}`).toBeLessThanOrEqual(0);
    }
  });
}

test("月次推移: 予算は段の線、棒は実績だけ。予算を超えた分は赤で、凡例に「予算超過」", async ({ page }) => {
  // 予算を超えた月のある案件
  const id = model.contracts.find((c) => c.months.some((m) => m.cost > m.budget && m.budget > 0))!.contract.contractId;
  await gotoPage(page, `/contract?id=${id}`);
  await expect(plot(page)).toBeVisible();
  // 消化率の帯（.yn-budget-strip。青・赤の極細のバー）は除いて、グラフ本体の棒・線を見る
  const colors = await plot(page).evaluate((svg) => {
    const own = (sel: string) => [...svg.querySelectorAll(sel)].filter((e) => !e.closest(".yn-budget-strip"));
    return {
      budgetLine: own("path").some((p) => /^#(2a78d6|3987e5)$/i.test(p.closest("[stroke]")?.getAttribute("stroke") ?? "")),
      budgetRect: own("rect").some((r) => /^#(2a78d6|3987e5)$/i.test(r.getAttribute("fill") ?? r.closest("[fill]")?.getAttribute("fill") ?? "")),
      overRect: own("rect").some((r) => /^#d03b3b$/i.test(r.getAttribute("fill") ?? r.closest("[fill]")?.getAttribute("fill") ?? "")),
    };
  });
  expect(colors).toEqual({ budgetLine: true, budgetRect: false, overRect: true });
  await expect(figure(page).locator(".yn-legend")).toContainText("予算超過");
});

test("日・週: 予算は棒に配らない（線・超過の赤・残予算・凡例・表）。月は予算を出す", async ({ page }) => {
  // 予算を超えた月のある案件（週・月なら赤が出る）
  const id = model.contracts.find((c) => c.months.some((m) => m.cost > m.budget && m.budget > 0 && m.month <= model.meta.asOfMonth))!.contract.contractId;
  await gotoPage(page, `/contract?id=${id}`);
  const marks = () =>
    plot(page).evaluate((svg) => {
      const color = (el: Element, attr: string) => el.getAttribute(attr) ?? el.closest(`[${attr}]`)?.getAttribute(attr) ?? "";
      return {
        // 消化率の帯（.yn-budget-strip）は別に見る
        budget: [...svg.querySelectorAll("path")].some((p) => !p.closest(".yn-budget-strip") && /^#(2a78d6|3987e5)$/i.test(color(p, "stroke"))),
        red: [...svg.querySelectorAll("rect")].some((r) => !r.closest(".yn-budget-strip") && /^#d03b3b$/i.test(color(r, "fill"))),
        gp: [...svg.querySelectorAll("path, circle")].some((p) => /^#(1baf7a|199e70)$/i.test(color(p, "stroke") || color(p, "fill"))),
      };
    });
  await unitBtn(page, "日").click();
  await expect(plot(page)).toHaveAttribute("aria-label", /日・週では予算を棒に配らず/);
  expect(await marks()).toEqual({ budget: false, red: false, gp: false });
  const legend = figure(page).locator(".yn-legend li");
  await expect(legend.filter({ hasText: /^予算/ })).toHaveCount(0);
  await expect(legend.filter({ hasText: /^残予算/ })).toHaveCount(0);
  await unitBtn(page, "週").click();
  await expect(plot(page)).toBeVisible();
  expect(await marks()).toEqual({ budget: false, red: false, gp: false });
  await unitBtn(page, "月").click();
  await expect(plot(page)).toBeVisible();
  expect(await marks()).toEqual({ budget: true, red: true, gp: true });
  // 表（案件詳細は表なし）: 全体サマリーの日
  await gotoPage(page, "/");
  await unitBtn(page, "日").click();
  await figure(page).locator("summary", { hasText: "表で見る" }).click();
  const heads = figure(page).locator("table thead th");
  await expect(heads.filter({ hasText: /^予算/ })).toHaveCount(0);
  await expect(heads.filter({ hasText: /^残予算/ })).toHaveCount(0);
  await expect(heads.filter({ hasText: /^実績/ }).first()).toBeVisible();
});

test("予算の消化率の帯: どの単位でも横軸の下に出る。日・週は月ごと、月は棒ごと、超えた期間は赤", async ({ page }) => {
  const c = model.contracts.find((x) => x.months.some((m) => m.cost > m.budget && m.budget > 0 && m.month < model.meta.asOfMonth))!;
  await gotoPage(page, `/contract?id=${c.contract.contractId}`);
  const strip = () =>
    plot(page).evaluate((svg) => {
      const segs = [...svg.querySelectorAll(".yn-budget-strip-seg")];
      return {
        count: segs.length,
        texts: segs.map((s) => s.querySelector("text")?.textContent ?? ""),
        over: segs.filter((s) => s.classList.contains("is-over")).length,
        titles: segs.map((s) => s.querySelector("title")?.textContent ?? ""),
      };
    });
  for (const u of ["日", "週"] as const) {
    await unitBtn(page, u).click();
    await expect(plot(page).locator(".yn-budget-strip")).toHaveCount(1);
    const s = await strip();
    expect(s.count).toBeGreaterThan(0);
    // 月ごと: 「10月 139%」または月の名前だけ（未来の月）
    for (const t of s.texts) expect(t).toMatch(/^(\d{1,2}月( \d+%)?|\d+%)?$/);
    expect(s.texts.some((t) => /^\d{1,2}月 \d+%$/.test(t))).toBe(true);
    if (u === "週") expect(s.over).toBeGreaterThan(0);
  }
  await unitBtn(page, "月").click();
  await expect(plot(page).locator(".yn-budget-strip")).toHaveCount(1);
  const m = await strip();
  // 月は棒（期間）ごと: 帯の区切りの数 = 期間の月数（副題の期間。既定は今年度の 6 か月以上）
  expect(m.count).toBeGreaterThanOrEqual(6);
  expect(m.over).toBeGreaterThan(0);
  expect(m.texts.filter((t) => /^\d+%$/.test(t)).length).toBeGreaterThan(0);
  expect(m.titles.some((t) => /実績 .+ ／ 予算 .+（\d+%）/.test(t))).toBe(true);
  await unitBtn(page, "四半期").click();
  await expect(plot(page).locator(".yn-budget-strip")).toHaveCount(1);
});

test("予算の消化率の帯: スマートフォンの幅でも月・週の消化率が出て、% はバーのすぐ下（目盛りより上）", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await gotoPage(page, "/");
  for (const u of ["月", "週"] as const) {
    await unitBtn(page, u).click();
    await expect(plot(page).locator(".yn-budget-strip")).toHaveCount(1);
    const r = await plot(page).evaluate((svg) => {
      const texts = [...svg.querySelectorAll(".yn-budget-strip-seg text")];
      const bar = svg.querySelector(".yn-budget-strip-seg rect")!.getBoundingClientRect();
      const tick = svg.querySelector('[aria-label="x-axis tick label"] text')!.getBoundingClientRect();
      const t = texts.find((e) => /\d/.test(e.textContent ?? ""));
      const tb = t?.getBoundingClientRect();
      return { n: texts.filter((e) => /\d/.test(e.textContent ?? "")).length, barBottom: bar.bottom, textTop: tb?.top ?? 0, textBottom: tb?.bottom ?? 0, tickTop: tick.top };
    });
    expect(r.n).toBeGreaterThan(0);
    expect(r.textTop).toBeGreaterThanOrEqual(r.barBottom - 1);
    expect(r.textTop - r.barBottom).toBeLessThan(8);
    expect(r.textBottom).toBeLessThanOrEqual(r.tickTop + 1);
  }
});

test("メンバー詳細: 時間のグラフの棒を押すと、その期間の内訳が開く（日は作業ごと、月は案件ごと。§135）", async ({ page }) => {
  await gotoPage(page, "/member?id=M010");
  const dialog = page.locator("dialog.yn-bd-dialog[open]");
  const clickAt = async (rx: number) => {
    await plot(page).scrollIntoViewIfNeeded();
    const box = (await plot(page).boundingBox())!;
    const x = box.x + box.width * rx;
    const y = box.y + box.height * 0.5;
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
  };
  await unitBtn(page, "日").click();
  await expect(plot(page)).toHaveAttribute("aria-label", /日ごと/);
  // 右寄り（今月の前の、実績のある日）
  await clickAt(0.75);
  await expect(dialog.locator(".yn-dialog-title")).toContainText("の時間");
  await expect(dialog.locator(".yn-bd-rows")).toContainText("実績時間");
  await expect(dialog.locator(".yn-bd-section").filter({ hasText: "作業ごとの内訳" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await unitBtn(page, "月").click();
  await clickAt(0.3);
  await expect(dialog.locator(".yn-bd-section").filter({ hasText: "案件ごとの内訳" }).locator("tbody tr").first()).toBeVisible();
  await expect(dialog.locator("button", { hasText: "明細を読み込む" })).toBeVisible();
});
