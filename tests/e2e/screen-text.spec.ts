/**
 * 画面の説明文の量（SPEC §37）
 * - 説明・操作案内・補足は見出し横の「?」に入れ、本文には出さない（PR #12 の方針の再発防止）
 *   各画面の本文に出ている文章（表・「?」の吹き出し・ダイアログ・警告／エラー・データの値を除く）の文字数に上限を置く
 * - GitLab の設定（トークンの入力・接続先）は設定画面だけ。他の画面はトークンが無いとき「設定へ」のリンクを出すだけ
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage } from "./helpers/app.js";

/** 1 画面の本文の文章の合計文字数の上限 */
const PAGE_BUDGET = 120;
/** 1 つの段落・注記の文字数の上限（これより長い説明は「?」へ） */
const ITEM_BUDGET = 70;

const PAGES = ["/", "/teams", "/team?id=S11", "/contracts", "/contract?id=C008", "/customers", "/members", "/member?id=M011", "/workload", "/plan?team=S11", "/masters", "/data-check", "/settings"];

/** 本文に出ている説明的な文章（表・吹き出し・ダイアログ・警告・データの値は除く） */
async function proseItems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const main = document.querySelector("#observablehq-main") ?? document.body;
    const skip = "table, .yn-tip, dialog, nav, .yn-meta, .yn-kpi, .yn-stat, button, select, label, svg, .yn-note-warn, .yn-note-danger, .is-warning, .is-error, .yn-state, .yn-me-outcome, .yn-chip, .yn-crumbs, .visually-hidden, .yn-forecast-facts, .yn-team-org";
    const out: string[] = [];
    for (const el of main.querySelectorAll("p, li, dd, .yn-me-field-hint, .yn-note, small, figcaption")) {
      if (el.closest(skip)) continue;
      if (!(el as HTMLElement).offsetParent) continue;
      if (el.querySelector("p, li")) continue;
      // ボタン・入力欄の文字は数えない
      const clone = el.cloneNode(true) as HTMLElement;
      for (const c of clone.querySelectorAll("button, input, select, label, .yn-tip")) c.remove();
      const t = (clone.textContent ?? "").replace(/\s+/g, " ").trim();
      if (t) out.push(t);
    }
    return out;
  });
}

for (const path of PAGES) {
  test(`説明文の量: ${path}`, async ({ page }) => {
    await gotoPage(page, path);
    const items = await proseItems(page);
    const long = items.filter((t) => t.length > ITEM_BUDGET);
    expect(long, "長い説明は見出し横の「?」へ").toEqual([]);
    const total = items.reduce((s, t) => s + t.length, 0);
    expect(total, `本文の文章: ${JSON.stringify(items)}`).toBeLessThanOrEqual(PAGE_BUDGET);
  });
}

/** マスタ編集で単価を 1 行足し、本文の文章が上限内か確かめる */
async function editAndMeasure(page: Page): Promise<void> {
  await page.getByRole("tab", { name: /単価/ }).click();
  await page.getByRole("button", { name: "＋ 新しい単価" }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  await d.locator("#yn-me-f-key").fill("部長");
  await d.locator("#yn-me-f-hourly_rate").fill("14000");
  await d.locator("#yn-me-f-effective_from").fill("2026-11");
  await d.locator('[data-role="submit"]').click();
  if (await d.isVisible()) await d.locator('[data-role="submit"]').click();
  await expect(page.locator(".yn-me-diff-table")).toBeVisible();
  const items = await proseItems(page);
  expect(items.filter((t) => t.length > ITEM_BUDGET)).toEqual([]);
  expect(items.reduce((s, t) => s + t.length, 0), JSON.stringify(items)).toBeLessThanOrEqual(PAGE_BUDGET);
}

test("説明文の量: マスタ編集で変更した後（保存の欄が出ている）", async ({ page }) => {
  await gotoPage(page, "/masters");
  await editAndMeasure(page);
  // 手順は保存の見出しの「?」の中
  await expect(page.locator(".yn-me-save .yn-tip-pop .yn-me-steps")).toHaveCount(1);
});

test("説明文の量: デモ（GitLab 方式）でトークン登録済み・変更した後", async ({ page }) => {
  await page.route(/\/_file\/data\/masters\.[^/]*json/, async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    json.masterEdit = { ...json.masterEdit, mode: "demo" };
    await route.fulfill({ response: res, body: JSON.stringify(json), headers: { ...res.headers(), "content-type": "application/json" } });
  });
  await page.addInitScript(() => sessionStorage.setItem("yojitsu-navi:gitlab-token", "demo"));
  await gotoPage(page, "/masters");
  await editAndMeasure(page);
  await expect(page.getByRole("button", { name: /GitLab に保存/ })).toBeEnabled();
  await expect(page.locator('.yn-me-save input[type="password"]')).toHaveCount(0);
});

test("GitLab のトークン入力は設定画面だけ", async ({ page }) => {
  for (const path of PAGES.filter((p) => p !== "/settings")) {
    await gotoPage(page, path);
    await expect(page.locator('input[type="password"]'), path).toHaveCount(0);
  }
});
