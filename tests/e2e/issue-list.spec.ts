/**
 * 検証の一覧（SPEC §40）
 * - 1.0 人月超は警告（保存を止めない）。同じ人の続いた月は 1 件
 * - エラー・警告を名前で並べ、押すとその行へ移動する（他の画面のファイルはその画面を開いて移動）
 * - エラーは赤、警告は黄で分ける
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage } from "./helpers/app.js";

/** リソース計画の CSV にアサインの行を足して反映し、表に戻る */
async function appendAssignments(page: Page, lines: string[]): Promise<void> {
  await page.getByRole("button", { name: "CSV で編集" }).click();
  const area = page.getByRole("textbox", { name: /アサイン の CSV/ });
  await area.fill((await area.inputValue()) + lines.map((l) => `${l}\n`).join(""));
  await page.locator('[data-fk="csv:apply:assignments"]').click();
  await page.getByRole("button", { name: "表で編集" }).click();
}

const item = (page: Page, text: string | RegExp) => page.locator(".yn-me-issue-item", { hasText: text });

test("1.0 超は警告: 保存は止めず、人の名前で 1 件（続いた月はまとめる）。押すと最初の月のセルへ", async ({ page }) => {
  await gotoPage(page, "/plan?team=S11");
  await appendAssignments(page, ["M010,C002,2026-11,2026-12,0.5"]);
  await expect(page.locator(".yn-me-check")).toContainText("エラーなし");
  await expect(page.locator(".yn-me-check .yn-chip-warn")).toBeVisible();
  const over = item(page, "1.0 を超えています");
  await expect(over).toHaveCount(1);
  await expect(over).toHaveClass(/is-warning/);
  // 名前で示し、文中に ID や同じ名前を繰り返さない
  await expect(over.locator(".yn-me-issue-subject")).toHaveText("中村 拓也");
  await expect(over.locator(".yn-me-issue-msg")).toContainText("2026-11〜2026-12");
  await expect(over.locator(".yn-me-issue-msg")).not.toContainText("M010");
  await expect(over.locator(".yn-me-issue-msg")).not.toContainText("中村");
  await over.getByRole("button").click();
  await expect(page.locator('[data-fk="plan:cell:M010:all:2026-11"]')).toBeFocused();
  await expect(page.locator('[data-fk="plan:cell:M010:all:2026-11"]')).toBeInViewport();
});

test("エラーは赤・警告は黄。エラーを先に並べ、押すとその履歴の行へ（絞り込み・組織・表示する月を合わせる）", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/plan?team=S11");
  await appendAssignments(page, ["M010,C002,2026-11,2026-12,0.5", "M011,C002,2027-05,2027-06,-1.5"]);
  const list = page.locator(".yn-me-issue-list > li");
  await expect(list.first()).toHaveClass(/is-error/);
  const err = item(page, "0 以上の数値で指定してください");
  await expect(err.locator(".yn-me-issue-subject")).toHaveText("小林 玲奈 ・ 倉庫管理システム保守");
  await expect(err.locator(".yn-chip")).toHaveClass(/yn-chip-danger/);
  const bg = (sel: ReturnType<Page["locator"]>) => sel.locator(".yn-me-issue-link").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await bg(err)).not.toBe(await bg(item(page, "1.0 を超えています")));
  await expect(page.locator(".yn-me-check .yn-chip-danger")).toContainText("エラー 1");

  // 別の組織・表示する月（§71）・絞り込みにしてから押しても、その行が出る
  await page.locator("#yn-me-plan-from").selectOption("2026-04");
  await page.locator("#yn-me-plan-to").selectOption("2026-09");
  const other = await page.locator("#yn-me-plan-team option", { hasText: "ネットワーク保守チーム" }).first().getAttribute("value");
  await page.locator("#yn-me-plan-team").selectOption(other!);
  await page.locator("#yn-me-plan-q").fill("該当なしの名前");
  await expect(page.locator(".yn-me-plan-table tbody")).toContainText("条件に合う人がいません");
  await err.getByRole("button").click();
  const entry = page.locator("li.yn-me-plan-entry", { hasText: "-1.50 人月" });
  await expect(entry).toBeVisible();
  await expect(entry.getByRole("button", { name: /修正/ })).toBeFocused();
  await expect(page.locator("#yn-me-plan-q")).toHaveValue("");
  // 行の月が入るように、月数（6 か月）を保って範囲をずらす
  await expect(page.locator("#yn-me-plan-from")).toHaveValue("2026-12");
  await expect(page.locator("#yn-me-plan-to")).toHaveValue("2027-05");
  await expect(entry.locator(".yn-me-issues li.is-error")).toContainText("0 以上");
});

test("存在しないメンバーのアサインも名前（ID）で示し、押すとその行へ", async ({ page }) => {
  await gotoPage(page, "/plan?team=S11");
  await appendAssignments(page, ["GHOST,C002,2026-04,2026-04,0.1"]);
  const err = item(page, "members.csv に存在しません");
  await expect(err.locator(".yn-me-issue-subject")).toContainText("GHOST");
  await err.getByRole("button").click();
  // 組織の案件に入っている人は「応援」の行として出るので、その履歴の行へ
  const entry = page.locator("li.yn-me-plan-entry", { hasText: "0.10 人月" }).filter({ has: page.locator(".yn-me-issues") });
  await expect(entry.getByRole("button", { name: /修正/ })).toBeFocused();
});

test("他の画面のファイルのエラーは、その画面を開いて行へ移動（マスタ編集 → リソース計画）", async ({ page }) => {
  await gotoPage(page, "/plan?team=S11");
  await appendAssignments(page, ["M011,C002,2026-04,2026-05,-1.5"]);
  await gotoPage(page, "/masters");
  const err = item(page, "0 以上の数値で指定してください");
  await expect(err).toContainText("リソース計画");
  const link = err.getByRole("link");
  await expect(link).toHaveAttribute("href", /plan\?jump=assignments:\d+/);
  await link.click();
  await page.waitForURL(/\/plan/);
  const entry = page.locator("li.yn-me-plan-entry", { hasText: "-1.50 人月" });
  await expect(entry.getByRole("button", { name: /修正/ })).toBeFocused();
});

test("台帳のエラー: 名前で示し、押すと絞り込みを外して履歴を開き、その行の「修正」へ", async ({ page }) => {
  await gotoPage(page, "/masters");
  await page.getByRole("tab", { name: /メンバー/ }).click();
  await page.getByRole("button", { name: "CSV で編集" }).click();
  const area = page.getByRole("textbox", { name: /メンバー の CSV/ });
  await area.fill((await area.inputValue()).replace("M011,小林 玲奈,employee,主任,ソリューション事業本部,第1事業部,第1課,T111,2026-07,", "M011,小林 玲奈,employee,主任,ソリューション事業本部,第1事業部,第1課,NOPE,2026-07,"));
  await page.locator('[data-fk="csv:apply:members"]').click();
  await page.getByRole("button", { name: "表で編集" }).click();
  await page.locator("#yn-me-q-members").fill("該当なし");
  await expect(page.locator(".yn-me-ledger tbody")).toContainText("条件に合う行がありません");
  await page.getByRole("tab", { name: /単価/ }).click();
  const err = item(page, "チーム NOPE は存在しません");
  await expect(err.locator(".yn-me-issue-subject")).toHaveText("小林 玲奈");
  await err.getByRole("button").click();
  await expect(page.getByRole("tab", { name: /メンバー/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#yn-me-q-members")).toHaveValue("");
  const focused = page.locator("tr.yn-me-hist.is-invalid :focus");
  await expect(focused).toHaveAttribute("data-fk", /^edit:/);
  await expect(focused).toHaveText("修正");
  await expect(page.locator("tr.yn-me-hist.is-invalid", { has: page.locator(":focus") })).toHaveAttribute("data-parent", "M011");
  await expect(page.locator(".yn-me-issue-row.is-error")).toBeVisible();
  await expect(page.getByRole("tab", { name: /メンバー/ }).locator(".yn-chip-danger")).toBeVisible();
});

test("9 件以上は先頭 8 件、「すべて表示」で全件", async ({ page }) => {
  await gotoPage(page, "/plan?team=S11");
  const lines = Array.from({ length: 9 }, (_, i) => `M010,C002,2027-0${i + 1},2027-0${i + 1},${i % 2 ? -1.5 : -2}`);
  await appendAssignments(page, lines);
  const all = page.locator(".yn-me-issue-list > li");
  await expect(all).toHaveCount(8);
  const more = page.locator('[data-fk="issue:more"]');
  await expect(more).toContainText("すべて表示");
  await more.click();
  expect(await all.count()).toBeGreaterThan(8);
  await expect(page.locator('[data-fk="issue:8"]')).toBeFocused();
  await expect(more).toHaveAttribute("aria-expanded", "true");
});

for (const [w, dark] of [[390, false], [768, true], [1280, true]] as const) {
  test(`一覧の見た目: ${w}px${dark ? "・ダーク" : ""}で横にはみ出さず、エラーと警告の色が違う`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: 900 });
    if (dark) await page.addInitScript(() => localStorage.setItem("yn-theme", "dark"));
    await gotoPage(page, "/plan?team=S11");
    await appendAssignments(page, ["M010,C002,2026-11,2026-12,0.5", "M011,C002,2026-04,2026-05,-1.5"]);
    const list = page.locator(".yn-me-issue-list");
    await list.scrollIntoViewIfNeeded();
    const box = (await list.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(w);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    const colors = await page.locator(".yn-me-issue-link").evaluateAll((els) => els.map((e) => getComputedStyle(e).borderLeftColor));
    expect(new Set(colors).size).toBeGreaterThanOrEqual(2);
  });
}

test("1 行で 1.0 を超える人月はエラーにしない（月合計の警告だけ。2026-10-31 試用版のコメント）。メッセージに列名の英語を出さない", async ({ page }) => {
  await gotoPage(page, "/plan?team=S11");
  await appendAssignments(page, ["M011,C002,2027-05,2027-06,1.5"]);
  await expect(item(page, "1.0 を超えています")).toBeVisible();
  await expect(page.locator(".yn-me-issue-list > li.is-error")).toHaveCount(0);
  await expect(page.locator(".yn-me-issue-list")).not.toContainText("allocation");
  // 保存（変更内容の確認）はできる
  await expect(page.locator(".yn-me-check .yn-chip-danger")).toHaveCount(0);
  await appendAssignments(page, ["M011,C002,2027-07,2027-07,-1"]);
  await expect(page.locator(".yn-me-issue-list")).not.toContainText("allocation");
  await expect(item(page, "配分（人月）は 0 以上の数値")).toBeVisible();
});
