/**
 * 表の列ごとの絞り込み（SPEC §70）
 *   - 見出しの漏斗ボタン → 値の一覧（検索つき）／数値は以上〜以下（表示単位で入力、元の値で比較）、日付は以降〜以前・年のボタン（§108）
 *   - 件数「n 件 / 全 m 件」と「絞り込みを解除」、合計行は絞り込み後の行で作り直す
 *   - 並べ替えと同じくタブ単位で覚える（詳細から戻っても残る）。木構造の表は一致行＋親を残す
 *   - 作業ログ・作業別の内訳にも付く。狭い画面・ダークでも吹き出しが画面内
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect, gotoPage, tableByCaption, dataRows, headerIndex, col, cellText, parseNumber, useDarkTheme } from "./helpers/app.js";

function filterBtn(table: Locator, key: string): Locator {
  return table.locator(`thead th[data-key="${key}"] .yn-filter-btn`);
}
const pop = (page: Page) => page.locator(".yn-filter-pop");
const count = (table: Locator) => table.locator("xpath=ancestor::div[contains(@class,'yn-table-block')]").locator(".yn-table-count");
const clearAll = (table: Locator) => table.locator("xpath=ancestor::div[contains(@class,'yn-table-block')]").getByRole("button", { name: "絞り込みを解除" });

async function columnValues(table: Locator, label: string): Promise<string[]> {
  const idx = col(await headerIndex(table), label);
  const rows = dataRows(table);
  const n = await rows.count();
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(await cellText(rows.nth(i), idx));
  return out;
}

test.describe("案件一覧", () => {
  test("状態で絞ると件数・合計行が絞り込み後になり、解除で戻る。詳細から戻っても残る", { tag: "@smoke" }, async ({ page }) => {
    await gotoPage(page, "/contracts?unit=yen");
    const table = tableByCaption(page, "案件一覧");
    const total = await dataRows(table).count();
    await expect(count(table)).toHaveText(`${total} 件`);
    await expect(clearAll(table)).toBeHidden();

    await filterBtn(table, "status").click();
    await expect(pop(page)).toBeVisible();
    // いったん全部外してから「超過見込み」だけ選ぶ
    await pop(page).getByLabel("（すべて）").uncheck();
    await expect(dataRows(table)).toHaveCount(0);
    await expect(table.locator(".yn-table-empty")).toHaveText("絞り込みに一致する行がありません");
    await pop(page).locator(".yn-filter-item", { hasText: "超過見込み" }).first().locator("input").check();
    const shown = await dataRows(table).count();
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(total);
    await expect(count(table)).toHaveText(`${shown} 件 / 全 ${total} 件`);
    for (const s of await columnValues(table, "状態")) expect(s).toContain("超過見込み");
    await expect(filterBtn(table, "status")).toHaveClass(/is-active/);
    // 合計行は表示中の行の合計（予算は案件ごとの和と一致）
    const budgets = (await columnValues(table, "予算")).map((t) => parseNumber(t) ?? 0);
    const foot = table.locator("tfoot tr");
    await expect(foot.locator("td").first()).toHaveText(`合計（${shown}件）`);
    const idx = col(await headerIndex(table), "予算");
    expect(parseNumber(await cellText(foot, idx))).toBe(budgets.reduce((a, b) => a + b, 0));

    // Esc で閉じてボタンへ戻る
    await page.keyboard.press("Escape");
    await expect(pop(page)).toHaveCount(0);
    await expect(filterBtn(table, "status")).toBeFocused();

    // 詳細へ行って戻っても残る
    await dataRows(table).first().locator("a").first().click();
    await page.waitForURL(/\/contract\?/);
    await page.goBack();
    await expect(dataRows(tableByCaption(page, "案件一覧"))).toHaveCount(shown);

    await clearAll(tableByCaption(page, "案件一覧")).click();
    await expect(dataRows(tableByCaption(page, "案件一覧"))).toHaveCount(total);
    await expect(clearAll(tableByCaption(page, "案件一覧"))).toBeHidden();
  });

  test("数値は表示単位（百万円）で「以上」を入れ、元の値で比べる。検索語は部分一致", async ({ page }) => {
    await gotoPage(page, "/contracts?unit=m");
    const table = tableByCaption(page, "案件一覧");
    const total = await dataRows(table).count();
    await filterBtn(table, "budget").click();
    await expect(pop(page).locator(".yn-filter-unit")).toHaveText("百万円");
    await pop(page).getByLabel("予算 以上").fill("10");
    await expect(count(table)).toContainText("/ 全");
    for (const t of await columnValues(table, "予算")) expect(parseNumber(t)!).toBeGreaterThanOrEqual(9.95); // 表示は 0.1 百万円単位に丸め
    await pop(page).getByRole("button", { name: "解除" }).click();
    await expect(dataRows(table)).toHaveCount(total);
    await expect(pop(page).getByLabel("予算 以上")).toHaveValue("");

    // 案件列の検索（顧客名の一部）
    await pop(page).getByRole("button", { name: "閉じる" }).click();
    const first = (await columnValues(table, "案件"))[0]!;
    const word = first.split(" / ")[0]!.slice(0, 3);
    await filterBtn(table, "name").click();
    await pop(page).getByRole("searchbox").fill(word);
    await expect(async () => {
      const names = await columnValues(table, "案件");
      expect(names.length).toBeGreaterThan(0);
      for (const n of names) expect(n).toContain(word);
    }).toPass();
    // 吹き出しの外を押すと閉じる
    await page.locator("h1").click();
    await expect(pop(page)).toHaveCount(0);
  });
});

test("案件詳細の作業ログ: 作業内容で絞ると合計行が絞り込み後の時間になる（スマホ幅・ダーク）", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await useDarkTheme(page);
  await gotoPage(page, "/contract?id=C008");
  await page.getByRole("button", { name: "作業ログを読み込む" }).click();
  const table = tableByCaption(page, "作業ログ");
  await expect(dataRows(table).first()).toBeVisible();
  const total = await dataRows(table).count();
  await filterBtn(table, "task").click();
  const p = pop(page);
  await expect(p).toBeVisible();
  // 吹き出しは画面内
  const box = (await p.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await p.getByLabel("（すべて）").uncheck();
  const firstItem = p.locator(".yn-filter-list .yn-filter-item").first();
  const task = ((await firstItem.locator(".yn-filter-item-text").textContent()) ?? "").trim();
  await firstItem.locator("input").check();
  await page.keyboard.press("Escape");
  const tasks = await columnValues(table, "作業内容");
  expect(tasks.length).toBeLessThan(total);
  expect(new Set(tasks)).toEqual(new Set([task]));
  const hours = (await columnValues(table, "時間")).map((t) => parseNumber(t) ?? 0).reduce((a, b) => a + b, 0);
  const idx = col(await headerIndex(table), "時間");
  expect(parseNumber(await cellText(table.locator("tfoot tr"), idx))).toBeCloseTo(hours, 2);
  await expect(table.locator("tfoot td").first()).toHaveText(`合計（${tasks.length}件）`);

  // 日付の列は以降〜以前（年月で入れるとその月を丸ごと。§108）
  await filterBtn(table, "date").click();
  const dates = await columnValues(table, "日付");
  const ym = dates[0]!.slice(0, 7);
  await expect(pop(page).getByRole("searchbox")).toHaveCount(0);
  await pop(page).getByLabel("日付 以降").fill(ym);
  await pop(page).getByLabel("日付 以前").fill(ym.replace("-", "/"));
  await expect(async () => {
    const shown = await columnValues(table, "日付");
    expect(shown.length).toBe(dates.filter((d) => d.startsWith(ym)).length);
    for (const d of shown) expect(d.startsWith(ym)).toBe(true);
  }).toPass();
  // 読めない入力は赤枠で、反映しない
  await pop(page).getByLabel("日付 以前").fill("13月");
  await expect(pop(page).getByLabel("日付 以前")).toHaveClass(/is-invalid/);
});

test("日付の列: 年のボタンでその年だけ、もう一度押すと解除。日付で絞っても再読み込みで残る", async ({ page }) => {
  await gotoPage(page, "/contract?id=C008");
  await page.getByRole("button", { name: "作業ログを読み込む" }).click();
  const table = tableByCaption(page, "作業ログ");
  await expect(dataRows(table).first()).toBeVisible();
  const all = await columnValues(table, "日付");
  const year = all[0]!.slice(0, 4);
  await filterBtn(table, "date").click();
  const yearBtn = pop(page).getByRole("button", { name: `${year}年` });
  await yearBtn.click();
  await expect(yearBtn).toHaveAttribute("aria-pressed", "true");
  await expect(pop(page).getByLabel("日付 以降")).toHaveValue(year);
  await expect(dataRows(table)).toHaveCount(all.filter((d) => d.startsWith(year)).length);
  await expect(filterBtn(table, "date")).toHaveClass(/is-active/);
  await yearBtn.click();
  await expect(yearBtn).toHaveAttribute("aria-pressed", "false");
  await expect(dataRows(table)).toHaveCount(all.length);

  // 最初の日より後を以降に入れる（日で入れる）→ 再読み込みしても残る
  const sorted = [...all].sort();
  const mid = sorted[Math.floor(sorted.length / 2)]!;
  await pop(page).getByLabel("日付 以降").fill(mid.replace(/-/g, ""));
  await page.keyboard.press("Enter");
  const expected = all.filter((d) => d >= mid).length;
  await expect(dataRows(table)).toHaveCount(expected);
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: "作業ログを読み込む" }).click();
  await expect(dataRows(tableByCaption(page, "作業ログ"))).toHaveCount(expected);
});

test("作業別の内訳: 作業別には付き、単価の列は値の一覧で絞る", async ({ page }) => {
  await gotoPage(page, "/contract?id=C008");
  const work = tableByCaption(page, "作業種別の内訳");
  await expect(filterBtn(work, "task")).toBeVisible();
  // 右寄せでも値が文字の列（単価）は値の一覧で絞る（範囲にすると全行が消える）
  const members = tableByCaption(page, "メンバー別の実績");
  const n = await dataRows(members).count();
  await filterBtn(members, "rateText").click();
  await expect(pop(page).locator(".yn-filter-range")).toHaveCount(0);
  await pop(page).locator(".yn-filter-list input").first().uncheck();
  expect(await dataRows(members).count()).toBeLessThan(n);
  await pop(page).getByRole("button", { name: "解除" }).click();
  await expect(dataRows(members)).toHaveCount(n);
});

test("木構造の表（チーム一覧・稼働実績のチーム軸）: 一致した行と親を残し、親だけの行は薄く出す", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/teams");
  const table = tableByCaption(page, "チーム一覧");
  const all = await dataRows(table).count();
  await filterBtn(table, "name").click();
  await pop(page).getByRole("searchbox").fill("クラウド運用");
  await expect(count(table)).toHaveText(/^\d+ 件 \/ 全 \d+ 件$/);
  await page.keyboard.press("Escape");
  const rows = dataRows(table);
  const n = await rows.count();
  expect(n).toBeGreaterThan(1);
  expect(n).toBeLessThan(all);
  // 最後の行が一致した行（親より後ろ）。親は薄い行として先に並ぶ
  await expect(rows.last()).not.toHaveClass(/is-filter-context/);
  await expect(rows.last().locator("th")).toContainText("クラウド運用");
  await expect(rows.first()).toHaveClass(/is-filter-context/);
  // 一致した行の深さは親より深い（親子の位置を保つ）
  const depth = async (i: number) => Number((await rows.nth(i).getAttribute("class"))!.match(/yn-depth-(\d+)/)![1]);
  expect(await depth(n - 1)).toBeGreaterThan(await depth(0));
  // 詳細から戻っても残り、解除で全行に戻る
  await rows.last().locator("a.yn-row-link").click();
  await page.waitForURL(/\/team/);
  await page.goBack();
  await expect(dataRows(tableByCaption(page, "チーム一覧"))).toHaveCount(n);
  await clearAll(tableByCaption(page, "チーム一覧")).click();
  await expect(dataRows(tableByCaption(page, "チーム一覧"))).toHaveCount(all);

  await gotoPage(page, "/workload?axis=team");
  const work = tableByCaption(page, "所属チームごとの稼働実績");
  await expect(filterBtn(work, "name")).toBeVisible();
});

test("全部外した絞り込みは、表を作り直しても（単位の切り替え・再読み込み）残る", async ({ page }) => {
  await gotoPage(page, "/customers");
  const table = tableByCaption(page, "顧客一覧");
  await filterBtn(table, "status").click();
  await pop(page).getByLabel("（すべて）").uncheck();
  await page.keyboard.press("Escape");
  await expect(dataRows(table)).toHaveCount(0);
  await page.getByRole("button", { name: "千円" }).first().click();
  await expect(tableByCaption(page, "顧客一覧").locator(".yn-table-empty")).toHaveText("絞り込みに一致する行がありません");
  await page.reload();
  await expect(tableByCaption(page, "顧客一覧").locator(".yn-table-empty")).toHaveText("絞り込みに一致する行がありません");
  await clearAll(tableByCaption(page, "顧客一覧")).click();
  await expect(dataRows(tableByCaption(page, "顧客一覧")).first()).toBeVisible();
});
