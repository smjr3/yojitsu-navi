/**
 * 利用の流れ（SPEC §133）: 画面ごとの確認ではなく、実際の使い方の順に画面をまたいで確かめる。
 * - 単位・期間を変えてから、タブ・詳細を行き来しても変わらない
 * - チーム詳細から上のタブ・リソース計画へ移っても、そのチームで絞ったまま
 * - 一覧で並べ替え・検索してから詳細を開いて戻ると、並び・検索・位置が戻る
 * - 今月分の作業実績がまだ無いときは、今月の進捗に「目安内・上限内」の緑を出さない
 * - 異動してきた人に「応援」の印を付けない
 * - リソース計画で組織を選ぶと、他の組織の人の確認要求は畳む（エラーは畳まない）
 */
import { test, expect, gotoPage, waitForPage, query, tableByCaption, headerIndex, col, teamValue } from "./helpers/app.js";
import { getModel, treeAt, fiscalPeriod, teamContractIds } from "./helpers/core.js";
import { ownTeamScope, teamMemberCosts } from "../../src/core/index.js";

const model = getModel();
const FY = fiscalPeriod(model);

test("単位・期間を変えてから、上のタブと詳細を行き来しても変わらない", async ({ page }) => {
  await gotoPage(page, "/");
  await page.locator("#yn-unit-slot").getByRole("button", { name: "千円" }).click();
  await page.locator('button[data-preset="lastMonth"]').click();
  await expect.poll(() => query(page).get("unit")).toBe("k");
  const { from, to } = Object.fromEntries(query(page));
  expect(from).toBe(to);
  const keep = async (where: string) => {
    await waitForPage(page);
    const q = query(page);
    expect([q.get("unit"), q.get("from"), q.get("to")], where).toEqual(["k", from, to]);
  };
  for (const name of ["チーム", "顧客", "案件", "メンバー", "稼働実績", "全体"]) {
    await page.locator(".yn-tabs a", { hasText: name }).click();
    await keep(`タブ ${name}`);
  }
  // 一覧から詳細へ（表の行のリンク）→ 上のタブで戻る
  for (const [list, detail] of [["/contracts", /\/contract\?/], ["/members", /\/member\?/], ["/customers", /\/customer\?/], ["/teams", /\/team\?/]] as const) {
    await page.locator(`.yn-tabs a[href="./${list.slice(1)}"]`).click();
    await keep(list);
    await page.locator("table tbody a[href]").first().click();
    await expect(page).toHaveURL(detail);
    await keep(`${list} の詳細`);
  }
});

test("チーム詳細から上のタブ・リソース計画へ移ると、そのチームで絞ったまま", async ({ page }) => {
  const id = "T111";
  for (const name of ["メンバー", "案件", "顧客", "稼働実績", "全体"]) {
    await gotoPage(page, `/team?id=${id}`);
    await page.locator(".yn-tabs a", { hasText: name }).click();
    await waitForPage(page);
    expect(query(page).get("team"), name).toBe(id);
    await expect(teamValue(page)).toHaveValue(id);
  }
  // 「チーム」タブはチーム一覧（絞らない）
  await gotoPage(page, `/team?id=${id}`);
  await expect(page.locator(".yn-tabs a", { hasText: "チーム" })).toHaveAttribute("href", "./teams");
  await page.locator(".yn-tools a", { hasText: "リソース計画" }).click();
  await expect(page).toHaveURL(/\/plan\?team=T111$/);
  await expect(teamValue(page, "plan")).toHaveValue(id);
});

test("一覧で並べ替え・検索してから詳細を開いて戻ると、並び・検索・位置が戻る", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoPage(page, "/contracts");
  const table = tableByCaption(page, "案件一覧");
  const h = await headerIndex(table);
  const th = table.locator("thead th").nth(col(h, "実績"));
  await th.locator("button.yn-sort").click();
  await expect(th).toHaveAttribute("aria-sort", "descending");
  const search = page.locator('input[type="search"]').first();
  await search.fill("保守");
  await expect.poll(() => query(page).get("q")).toBe("保守");
  const keys = await table.locator("tbody tr[data-key]").evaluateAll((trs) => trs.slice(0, 5).map((tr) => tr.getAttribute("data-key")));
  await page.evaluate(() => scrollTo(0, 900));
  await expect.poll(() => page.evaluate(() => Math.round(scrollY))).toBeGreaterThan(800);
  const before = await page.evaluate(() => Math.round(scrollY));
  // クリック前に要素へスクロールさせない（今の位置のまま離れる）
  await page.locator(".yn-row-link").nth(8).evaluate((a) => (a as HTMLAnchorElement).click());
  await expect(page).toHaveURL(/\/contract\?/);
  await page.goBack();
  await expect(table.locator("tbody tr[data-key]").first()).toBeVisible();
  await expect(th).toHaveAttribute("aria-sort", "descending");
  await expect(search).toHaveValue("保守");
  expect(await table.locator("tbody tr[data-key]").evaluateAll((trs) => trs.slice(0, 5).map((tr) => tr.getAttribute("data-key")))).toEqual(keys);
  await expect.poll(() => page.evaluate(() => Math.round(scrollY)), { timeout: 10_000 }).toBeGreaterThan(before - 50);
});

test("今月分の作業実績がまだ無いときは、今月の進捗に「目安内・上限内」の緑を出さない", async ({ page }) => {
  await page.route(/\/_file\/data\/daily\.[^/]*json$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, lastDate: null, days: {}, members: {} } });
  });
  await gotoPage(page, "/");
  const actual = page.locator("#yn-daily-actual");
  const projection = page.locator("#yn-daily-projection");
  await expect(actual).toBeVisible();
  await expect(actual.locator(".yn-chip")).toHaveCount(0);
  await expect(projection.locator(".yn-chip")).toHaveCount(0);
  // 実績がある通常の日は判定が出る
  await page.unroute(/\/_file\/data\/daily\.[^/]*json$/);
  await gotoPage(page, "/");
  await expect(page.locator("#yn-daily-actual .yn-chip")).toHaveCount(1);
  await expect(page.locator("#yn-daily-projection .yn-chip")).toHaveCount(1);
});

test("異動してきた人には、異動前の作業が応援に数えられても「応援」の印を付けない", async ({ page }) => {
  const tree = treeAt(FY.to, model);
  // ダミーデータで、異動前の応援の時間があり今はそのチームにいる人がいるチームを探す
  const found = Object.keys(tree)
    .map((teamId) => {
      const rows = teamMemberCosts(model, teamContractIds(teamId, FY, model)!, FY, ownTeamScope(tree, teamId));
      return { teamId, row: rows.find((r) => r.supportHours > 0 && !r.supportAtLast) };
    })
    .find((x) => x.row);
  expect(found, "異動してきた人のいるチーム").toBeTruthy();
  const teamId = found!.teamId;
  const row = found!.row!;
  await gotoPage(page, `/team?id=${teamId}`);
  const tr = page.locator(`#observablehq-main table tbody tr[data-key="${row.memberId}"]`).first();
  await expect(tr).toBeVisible();
  await expect(tr.locator('[data-origin="support"]')).toHaveCount(0);
});

test("リソース計画で組織を選ぶと、他の組織の人の確認要求は畳み、ボタンで出せる", async ({ page }) => {
  const items = page.locator(".yn-me-issue-item");
  const otherBtn = page.locator('[data-fk="issue:other-org"]');
  await gotoPage(page, "/plan?team=T111");
  await expect(teamValue(page, "plan")).toHaveValue("T111");
  await expect(otherBtn).toBeVisible();
  const n = Number((await otherBtn.innerText()).match(/（(\d+)件）/)![1]);
  expect(n).toBeGreaterThan(0);
  const shown = await items.count();
  await otherBtn.click();
  await expect(otherBtn).toHaveText("選んだ組織の分だけ表示");
  await expect.poll(() => items.count()).toBeGreaterThan(shown);
  await otherBtn.click();
  await expect(items).toHaveCount(shown);
  // 組織を「すべて」に戻すと畳まない（ボタンも出ない）
  await page.locator("#yn-me-plan-team").click();
  await page.locator("#yn-me-plan-team").locator("xpath=..").locator('.yn-combo-list li[data-value=""]').click();
  await expect(otherBtn).toHaveCount(0);
});
