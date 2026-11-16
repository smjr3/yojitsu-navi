/**
 * データ確認を行数が多くても見やすくする（SPEC §127）
 * - 件数付きの目次、項目の開閉（覚える）、表は先頭 10 行＋「すべて表示」
 * - 候補の正式な案件・検証のメッセージは ID だけでなく名前で出す
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage, waitForPage, tableByCaption, dataRows } from "./helpers/app.js";

/** マスタに無いメンバーを n 人に増やす（行数の多い表を作る） */
async function manyUnknownMembers(page: Page, n: number) {
  await page.route(/\/_file\/data\/model\.[^/]*json/, async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    const base = json.unknownMembers[0];
    json.unknownMembers = Array.from({ length: n }, (_, i) => ({ ...base, memberId: `X${String(i).padStart(3, "0")}`, memberName: `臨時 ${i}`, hours: 1000 - i }));
    await route.fulfill({ response: res, body: JSON.stringify(json), headers: { ...res.headers(), "content-type": "application/json" } });
  });
}

const UNKNOWN = "不明なメンバー";

test("目次に項目と件数が並び、押すとその項目へ移る", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/data-check");
  const toc = page.getByRole("navigation", { name: "このページの項目" });
  await expect(toc.getByRole("link", { name: /未紐付けの作業実績/ })).toBeVisible();
  await expect(toc.getByRole("link", { name: /データ検証の結果/ })).toContainText("件");
  await toc.getByRole("link", { name: /データ検証の結果/ }).click();
  await expect(page.locator("#dc-issues .yn-fold-toggle")).toBeInViewport();
  await expect(page.locator("#dc-issues .yn-fold-toggle")).toBeFocused();
});

test("行の多い表は先頭 10 行だけ出し、「すべて表示」で残りを出す。件数はいつも全体", async ({ page }) => {
  await manyUnknownMembers(page, 30);
  await gotoPage(page, "/data-check");
  const table = tableByCaption(page, UNKNOWN);
  const block = page.locator(".yn-table-block", { has: table });
  await expect(dataRows(table)).toHaveCount(10);
  await expect(block.locator(".yn-table-count")).toHaveText("30 件");
  // たたんでいる間は表の中でスクロールしない（高さを抑えない）
  expect(await block.locator(".yn-table-wrap").evaluate((el) => (el as HTMLElement).style.maxHeight)).toBe("");
  const more = block.getByRole("button", { name: "すべて表示（30 件）" });
  await more.click();
  await expect(dataRows(table)).toHaveCount(30);
  expect(await block.locator(".yn-table-wrap").evaluate((el) => (el as HTMLElement).style.maxHeight)).not.toBe("");
  await block.getByRole("button", { name: "先頭の 10 件だけ表示" }).click();
  await expect(dataRows(table)).toHaveCount(10);
  // 10 行以下の表にはボタンを出さない
  await expect(page.locator("#dc-unmapped .yn-table-more")).toBeHidden();
});

test("項目は見出しで開閉でき、再読み込みしても残る。計算時の警告（すべて）は既定でたたむ", async ({ page }) => {
  await gotoPage(page, "/data-check");
  const warnings = page.locator("#dc-warnings");
  await expect(warnings.locator(".yn-fold-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(warnings.locator(".yn-fold-body")).toBeHidden();
  // 目次から移ると開く
  await page.getByRole("navigation", { name: "このページの項目" }).getByRole("link", { name: /計算時の警告/ }).click();
  await expect(warnings.locator(".yn-fold-body")).toBeVisible();

  const unmapped = page.locator("#dc-unmapped");
  await unmapped.locator(".yn-fold-toggle").click();
  await expect(unmapped.locator(".yn-fold-body")).toBeHidden();
  await page.reload();
  await waitForPage(page);
  await expect(page.locator("#dc-unmapped .yn-fold-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#dc-warnings .yn-fold-toggle")).toHaveAttribute("aria-expanded", "true");
  await page.locator("#dc-unmapped .yn-fold-toggle").click();
  await expect(page.locator("#dc-unmapped .yn-fold-body")).toBeVisible();
});

test("ID だけで出さない: 候補の正式な案件は名前、検証のメッセージの社員番号・案件ID には名前を添える", async ({ page }) => {
  await gotoPage(page, "/data-check");
  const unlinked = tableByCaption(page, "正式な案件IDの無い案件");
  await expect(unlinked.locator("tbody")).toContainText("しらかば医療 / 電子カルテ連携保守（PJ-0007）");
  // マスタに無い正式な案件は名前が先頭（正式な案件ID は選べる列）
  const unregistered = tableByCaption(page, "マスタに無い正式な案件");
  expect(await unregistered.locator("thead th").first().getAttribute("data-key")).toBe("customerName");
  await expect(unregistered.locator('thead th[data-key="projectId"]')).toHaveCount(0);
  // 検証のメッセージ
  const issues = page.locator("#dc-issues");
  await issues.getByRole("button", { name: /すべて表示/ }).click();
  await expect(issues.locator("tbody")).toContainText(/メンバー M203（[^）]+）/);
  await expect(issues.locator("tbody")).toContainText(/案件 C150（[^）]+）/);
  await expect(issues.locator("tbody")).not.toContainText("NO_RULE");
});
