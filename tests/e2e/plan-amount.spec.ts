/**
 * リソース計画の金額と目標の上限（SPEC §122）: グラフを「金額」に切り替えると、担当案件の計画の額を顧客ごとに積み上げ、
 * 予算と目標の上限を重ねる。セルの編集欄には、案件ごとに目標の上限までの余力（人月）を出し、入力中の値で数え直す
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";

const chart = (page: Page) => page.locator("figure.yn-me-plan-chart");
const overLabels = (page: Page) => chart(page).locator("svg text").evaluateAll((els) => els.map((e) => e.textContent ?? "").filter((t) => t === "上限超" || t === "超"));

test("金額: 切り替えると顧客ごとの積み上げ・予算・目標の上限になり、このブラウザに覚える", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/plan?team=D1");
  await expect(page.locator('[data-fk="plan:chart:pm"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator('[data-fk="plan:chart:amount"]').click();
  await expect(page.locator('[data-fk="plan:chart:amount"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-fk="plan:chart:amount"]')).toBeFocused();
  const legend = chart(page).locator(".yn-legend");
  await expect(legend).toContainText("青葉物流");
  await expect(legend).toContainText("予算");
  await expect(legend).toContainText("目標の上限");
  await expect(legend).not.toContainText("人数 × 1.0");
  expect((await overLabels(page)).length).toBeGreaterThan(0);
  await page.reload();
  await expect(page.locator('[data-fk="plan:chart:amount"]')).toHaveAttribute("aria-pressed", "true");
  await expect(chart(page).locator(".yn-legend")).toContainText("目標の上限");
  await page.locator('[data-fk="plan:chart:pm"]').click();
  await expect(chart(page).locator(".yn-legend")).toContainText("人数 × 1.0");
  await page.reload();
  await expect(page.locator('[data-fk="plan:chart:pm"]')).toHaveAttribute("aria-pressed", "true");
});

test("金額: マウスを乗せると顧客ごとの額・計画の額・予算・目標の上限・上限まで", async ({ page }) => {
  await gotoPage(page, "/plan?team=D1");
  await page.locator('[data-fk="plan:chart:amount"]').click();
  const svg = chart(page).locator('svg[role="img"]');
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.6);
  const tip = svg.locator('g[aria-label="tip"]');
  for (const t of ["青葉物流", "計画の額", "予算", "目標の上限", "上限まで"]) await expect(tip).toContainText(t);
});

test("金額: 目標の無い組織は目標の上限を出さない", async ({ page }) => {
  // D4 は担当案件にも上位の組織にも目標が無い
  await gotoPage(page, "/plan?team=D4");
  await page.locator('[data-fk="plan:chart:amount"]').click();
  await expect(chart(page).locator(".yn-legend")).toContainText("予算");
  await expect(chart(page).locator(".yn-legend")).not.toContainText("目標の上限");
  expect(await overLabels(page)).toEqual([]);
});

for (const [width, dark] of [[390, false], [768, true], [1280, true]] as const) {
  test(`金額: ${width}px${dark ? "・ダーク" : ""}で横にはみ出さず、上限超の表示が重ならない`, async ({ page }) => {
    if (dark) await useDarkTheme(page);
    await page.setViewportSize({ width, height: 900 });
    await gotoPage(page, "/plan?team=D1");
    await page.locator('[data-fk="plan:chart:amount"]').click();
    const fig = chart(page);
    await expect(fig.locator('svg[role="img"]')).toBeVisible();
    const f = (await fig.boundingBox())!;
    const s = (await fig.locator('svg[role="img"]').boundingBox())!;
    expect(s.x + s.width).toBeLessThanOrEqual(f.x + f.width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const boxes = await fig.locator("svg text").evaluateAll((els) =>
      els.filter((e) => e.textContent === "上限超" || e.textContent === "超").map((e) => {
        const r = e.getBoundingClientRect();
        return { l: r.left, r: r.right };
      }),
    );
    expect(boxes.length).toBeGreaterThan(0);
    boxes.sort((a, b) => a.l - b.l);
    for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.l).toBeGreaterThanOrEqual(boxes[i - 1]!.r);
  });
}

/** 田中 さくら（第1課）の、作業の行の 2 か月目のセルを開く */
async function openTaskCell(page: Page) {
  await gotoPage(page, "/plan?team=D1");
  await page.locator('[data-fk="plan:toggle:M004"]').click();
  const fks = await page.locator('[data-fk^="plan:cell:M004:p:"]').evaluateAll((es) => es.map((e) => (e as HTMLElement).dataset.fk ?? ""));
  const month = fks[1]!.slice(-7);
  const cell = page.locator(`[data-fk="${fks.find((k) => k.includes("青葉物流") && k.endsWith(month))}"]`);
  await cell.click();
  await expect(page.locator("dialog.yn-plan-pop")).toBeVisible();
}

const pmOf = (text: string) => Number(/([\d.]+)人月/.exec(text)?.[1] ?? NaN) * (text.includes("超え") ? -1 : 1);

test("入力欄の余力: 案件ごとに目標の上限までの金額と人月を出し、入力中の値で数え直す", async ({ page }) => {
  await openTaskCell(page);
  const pop = page.locator("dialog.yn-plan-pop");
  const rows = pop.locator(".yn-plan-pop-rows li");
  const row = rows.filter({ hasText: "倉庫管理システム保守" });
  const room = row.locator(".yn-plan-pop-room");
  // 残りは金額、人月はこの人の単価での目安を括弧で（§122）
  await expect(room).toHaveText(/^(上限まで あと [\d.,]+万円|目標の上限を [\d.,]+万円 超え)（[\d.]+人月）$/);
  const before = pmOf((await room.textContent()) ?? "");
  const input = row.locator("input");
  const value = Number(await input.inputValue());
  await input.fill(String(Math.round((value + 0.5) * 100) / 100));
  await expect.poll(async () => pmOf((await room.textContent()) ?? "")).toBeCloseTo(before - 0.5, 1);
  await expect(room).toHaveText(/超え/);
  await expect(room).toHaveClass(/is-over/);
  // 元に戻すと元の余力
  await input.fill(String(value));
  await expect.poll(async () => pmOf((await room.textContent()) ?? "")).toBeCloseTo(before, 2);
});

test("入力欄の余力: 作業を追加で選んだ案件に目標があれば、その案件の余力を出す", async ({ page }) => {
  await openTaskCell(page);
  const pop = page.locator("dialog.yn-plan-pop");
  const newRoom = pop.locator(".yn-plan-pop-room.is-new");
  await expect(newRoom).toBeHidden();
  await pop.locator("#yn-plan-pop-project").fill("みなと銀行");
  await pop.locator('#yn-plan-pop-project-listbox [role="option"]').filter({ hasText: "勘定系周辺システム保守" }).first().click();
  await expect(newRoom).toBeVisible();
  const before = pmOf((await newRoom.textContent()) ?? "");
  await pop.locator("#yn-plan-pop-new").fill("0.2");
  await expect.poll(async () => pmOf((await newRoom.textContent()) ?? "")).toBeCloseTo(before - 0.2, 1);
});
