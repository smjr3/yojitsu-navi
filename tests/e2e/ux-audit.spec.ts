/**
 * 画面の分かりにくさ・操作しにくさの点検（SPEC §115・§116）
 * - 一覧の名前の列が数値の列に押されて切れない（PC 幅）
 * - マスタ編集・リソース計画の見出しにファイル名・CSV の列名を出さない。検証の文に行番号・案件 ID を出さない
 * - データ確認の参照・コードは画面に出さない（Excel だけ）
 * - 全体サマリーの組織別は木の表（直下の組織を一段下げる）
 * - リソース計画: 特大の文字でも操作の列（＋ 作業）が見える
 * - 列の設定に固定の列と「別の列」の印
 * - 必須の欄が空ならその欄に印
 */
import { test, expect, gotoPage, teamValue } from "./helpers/app.js";

test("案件一覧（1280px）: 案件の列が 250px 以上あり、数値の列に押されて縮まない", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoPage(page, "/contracts");
  const th = page.locator("#observablehq-main table.yn-table thead th").first();
  expect((await th.boundingBox())!.width).toBeGreaterThanOrEqual(250);
});

test("マスタ編集: タブ・見出し・列見出しにファイル名や CSV の列名を出さない。在籍は空でも「在籍」", async ({ page }) => {
  await gotoPage(page, "/masters");
  await expect(page.locator(".yn-me-tabs")).not.toContainText(".csv");
  await expect(page.locator("#yn-me-panel .yn-section-title")).not.toContainText(".csv");
  await expect(page.locator(".yn-me-ledger thead")).not.toContainText("member_id");
  await expect(page.locator(".yn-me-ledger thead")).not.toContainText("effective_from");
  await expect(page.locator(".yn-me-ledger tbody tr").first()).toContainText("社員");
  await expect(page.locator(".yn-me-ledger tbody tr").first()).not.toContainText("employee");
  await expect(page.locator(".yn-me-ledger tbody tr").first()).toContainText("在籍");
});

test("リソース計画: 見出しにファイル名を出さず、検証の文に行番号・案件 ID を出さない", async ({ page }) => {
  await gotoPage(page, "/plan");
  await expect(page.locator("#yn-me-panel .yn-section-title").first()).not.toContainText(".csv");
  const msgs = page.locator(".yn-me-issue-msg");
  await expect(msgs.first()).toBeVisible();
  for (const t of await msgs.allTextContents()) {
    expect(t).not.toMatch(/行 \d|\d+ 行目|（C\d+ と C\d+）|\.csv/);
  }
});

test("データ確認: 計算時の警告の参照・検証のコードは画面に出さない", async ({ page }) => {
  await gotoPage(page, "/data-check");
  await expect(page.locator("#observablehq-main")).not.toContainText("customerName=");
  await expect(page.locator("#observablehq-main")).not.toContainText("ASSIGNMENT_AFTER_LEFT");
});

test("全体サマリーの組織別: 最上位の組織の下に直下の組織を一段下げて並べる", async ({ page }) => {
  await gotoPage(page, "/");
  const table = page.locator("#observablehq-main table.yn-table").filter({ has: page.locator(".yn-tree-indent") }).first();
  await expect(table.locator(".yn-tree-toggle:not(.yn-tree-leaf)")).toHaveCount(1);
  const depths = await table.locator("tbody .yn-tree-indent").evaluateAll((els) => els.map((e) => getComputedStyle(e).getPropertyValue("--depth").trim()));
  expect(depths[0]).toBe("0");
  expect(depths.slice(1).some((d) => d === "1")).toBe(true);
});

test("リソース計画（文字 特大・1280px）: 操作の列の「＋ 作業」が画面の中に見える", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("yn-text-size", "xxl"));
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoPage(page, "/plan");
  const btn = page.locator('[data-fk^="plan:add:"]').first();
  await expect(btn).toBeVisible();
  const box = (await btn.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(1280);
  const wrap = await page.locator(".yn-me-plan-table").evaluate((t) => t.closest(".yn-table-wrap, .yn-me-table-wrap")!.getBoundingClientRect().right);
  expect(box.x + box.width).toBeLessThanOrEqual(wrap + 1);
});

test("列の設定: 先頭の固定の列と、選べる列の「別の列」の印", async ({ page }) => {
  await gotoPage(page, "/contracts");
  await page.locator("#observablehq-main .yn-cols-btn").first().click();
  const pop = page.locator(".yn-cols-pop");
  await expect(pop.locator(".yn-cols-item.is-fixed")).toContainText("固定");
  await expect(pop.locator('.yn-cols-item[data-key="customerName"]')).toContainText("別の列");
});

test("行の追加: 必須の欄が空なら、その欄に印を付け、入力すると外す", async ({ page }) => {
  await gotoPage(page, "/masters");
  await page.getByRole("button", { name: /新しいメンバー/ }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  await d.locator('[data-role="submit"]').click();
  await expect(d.locator("#yn-me-f-name")).toHaveAttribute("aria-invalid", "true");
  await d.locator("#yn-me-f-name").fill("試験 太郎");
  await expect(d.locator("#yn-me-f-name")).not.toHaveAttribute("aria-invalid", "true");
});

// ---- 点検の追加分（SPEC §116） ----

test("保存前の変更内容: リソース計画のセル 1 つの変更は「人・作業・月 前 → 後」で出し、CSV の行は開いて見る", async ({ page }) => {
  await gotoPage(page, "/plan?member=M011");
  await page.locator('[data-fk^="plan:cell:M011:p:"][data-fk$=":2026-11"]').first().click();
  const pop = page.locator("dialog.yn-plan-pop[open]");
  await pop.getByRole("textbox", { name: /倉庫管理システム保守 の/ }).fill("0.5");
  await pop.getByRole("button", { name: "反映" }).click();
  const item = page.locator(".yn-me-diff-summary li");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("小林 玲奈");
  await expect(item).toContainText("青葉物流 / 倉庫管理システム保守");
  await expect(item).toContainText(/11月 0\.90 → 0\.50/);
  await expect(page.locator(".yn-me-diff-rows")).not.toHaveAttribute("open", "");
  await expect(page.locator(".yn-me-diff-rows summary")).toContainText("3 行");
  await expect(page.locator(".yn-me-diff-slot h3")).not.toContainText(".csv");
});

test("組織の選択: 文字で探せて、上位の組織名を添えて出す。選ぶと絞り込みに入る", async ({ page }) => {
  await gotoPage(page, "/");
  const input = page.locator("#yn-filter-team");
  await expect(input).toHaveValue(/全体/);
  await input.click();
  await page.keyboard.type("ネットワーク保守");
  const opt = page.locator("#yn-filter-team-listbox li.yn-combo-opt").first();
  await expect(opt).toContainText("ネットワーク保守チーム");
  await expect(opt.locator(".yn-combo-sub")).toContainText("第1事業部");
  await page.keyboard.press("Enter");
  await expect(teamValue(page)).toHaveValue("T112");
  await expect(page).toHaveURL(/team=T112/);
  // リソース計画の組織もリーダー名で探せる
  await gotoPage(page, "/plan");
  await page.locator("#yn-me-plan-team").fill("中村 拓也");
  await expect(page.locator("#yn-me-plan-team-listbox li.yn-combo-opt").first()).toContainText("インフラ保守チーム");
});

test("リソース計画: 見出しを重ねない。メンバー詳細から来たらその人の行を画面の中に出す", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await gotoPage(page, "/member?id=M011");
  await page.locator("#yn-member-plan-link").click();
  await expect(page.locator("h1")).toContainText("リソース計画");
  await expect(page.locator("#yn-me-panel h2").first()).not.toHaveText("リソース計画");
  const row = page.locator('tr.yn-me-plan-row[data-member="M011"]');
  await expect(row).toHaveClass(/is-focus/);
  await expect(row).toBeInViewport();
});
