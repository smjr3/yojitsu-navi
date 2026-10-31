/**
 * 体制図（SPEC §76）: チーム一覧の表示切替。月を動かすと所属・増減・負荷の色が変わり、吹き出しで担当顧客・負荷の内訳が出る。表示だけ
 */
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";
import { getModel } from "./helpers/core.js";
import { addMonths, loadLevelOf, orgChartAt, personMonths } from "../../src/core/index.js";

const model = getModel();
const asOf = model.meta.asOfMonth;
const chart = orgChartAt(model, asOf);
const std = model.config.standardHoursPerMonth;
const chip = (page: import("@playwright/test").Page, teamId: string, memberId: string) => page.locator(`.yn-org-node[data-team="${teamId}"] > .yn-org-people > [data-member="${memberId}"][data-origin="own"]`);

test("表 ⇄ 体制図の切り替え。URL に残り、表示だけ（入力欄・保存は無い） @smoke", async ({ page }) => {
  await gotoPage(page, "/teams");
  await expect(page.locator("table").first()).toBeVisible();
  await page.locator('[data-view="chart"]').click();
  await expect(page.locator(".yn-org-tree")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("view")).toBe("chart");
  await expect(page.locator(".yn-org-tree input, .yn-org-tree textarea, .yn-org-tree [contenteditable]")).toHaveCount(0);
  await expect(page.locator(".yn-org-tree").getByRole("button")).toHaveCount(0);
  // 再読み込みしても体制図のまま
  await page.reload();
  await expect(page.locator(".yn-org-tree")).toBeVisible();
  await page.locator('[data-view="table"]').click();
  await expect(page.locator(".yn-org-tree")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("view")).toBeNull();
});

test("組織とメンバーが core（orgChartAt）と一致し、色は計画の人月で決まる", async ({ page }) => {
  await gotoPage(page, "/teams?view=chart");
  await expect(page.locator(".yn-org")).toHaveAttribute("data-month", asOf);
  const teamIds = Object.keys(chart.nodes);
  await expect(page.locator(".yn-org-node[data-team]:not([data-team=''])")).toHaveCount(teamIds.length);
  // 人の多いチームを数件確かめる
  const sample = Object.values(chart.nodes)
    .sort((a, b) => b.members.length - a.members.length)
    .slice(0, 3);
  for (const n of sample) {
    const own = page.locator(`.yn-org-node[data-team="${n.teamId}"] > .yn-org-people > [data-origin="own"]`);
    await expect(own).toHaveCount(n.members.length);
    for (const p of n.members) {
      const level = p.change === "left" ? "is-left" : `is-${loadLevelOf(personMonths(p.plannedHours, std))}`;
      await expect(chip(page, n.teamId, p.memberId)).toHaveClass(new RegExp(level));
    }
  }
});

test("月を送ると前月との増減（＋/−）が変わる。◀ ▶・スライダー・URL の month", async ({ page }) => {
  // 増減のある月を core から探す
  let month = asOf;
  for (let i = 0; i < 12; i++) {
    const m = addMonths(asOf, -i);
    if (Object.values(orgChartAt(model, m).nodes).some((n) => n.members.some((p) => p.change))) {
      month = m;
      break;
    }
  }
  const c = orgChartAt(model, month);
  const joined = Object.values(c.nodes).flatMap((n) => n.members.filter((p) => p.change === "joined").map((p) => [n.teamId, p.memberId] as const));
  const left = Object.values(c.nodes).flatMap((n) => n.members.filter((p) => p.change === "left").map((p) => [n.teamId, p.memberId] as const));
  expect(joined.length + left.length, "ダミーデータに増減のある月がある").toBeGreaterThan(0);
  await gotoPage(page, `/teams?view=chart&month=${month}`);
  for (const [t, m] of joined) await expect(chip(page, t, m).locator('.yn-org-mark[data-change="joined"]')).toHaveText("＋");
  for (const [t, m] of left) await expect(chip(page, t, m)).toHaveClass(/is-left/);
  await page.locator('[data-org="next"]').click();
  await expect(page.locator(".yn-org")).toHaveAttribute("data-month", addMonths(month, 1));
  await expect(page.locator('[data-org="next"]')).toBeFocused();
  await page.locator('[data-org="prev"]').click();
  await expect(page.locator(".yn-org")).toHaveAttribute("data-month", month);
  // スライダーの左端 = データの最初の月（描き直しを待ってから URL を見る）
  const first = model.meta.minMonth < asOf ? model.meta.minMonth : asOf;
  await page.locator(".yn-org-slider").fill("0");
  await expect(page.locator(".yn-org")).toHaveAttribute("data-month", first);
  await expect.poll(() => new URL(page.url()).searchParams.get("month")).toBe(first);
});

test("吹き出し: チームは担当顧客、メンバーは計画・実績の内訳（未来の月は計画だけ）", async ({ page }) => {
  const team = Object.values(chart.nodes).find((n) => n.contractIds.length > 0 && n.members.length > 0)!;
  const contract = model.contracts.find((r) => r.contract.contractId === team.contractIds[0])!.contract;
  await gotoPage(page, "/teams?view=chart");
  const head = page.locator(`.yn-org-node[data-team="${team.teamId}"] > .yn-org-head`);
  await head.scrollIntoViewIfNeeded();
  await head.hover();
  const tip = page.locator("#yn-plan-tip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("担当顧客");
  await expect(tip).toContainText(contract.customerName);

  const p = team.members.find((x) => x.lines.length > 0 && x.change !== "left")!;
  await chip(page, team.teamId, p.memberId).hover();
  await expect(tip).toContainText(p.name);
  await expect(tip).toContainText("実績");

  const future = addMonths(asOf, 2);
  await gotoPage(page, `/teams?view=chart&month=${future}`);
  const fc = orgChartAt(model, future);
  const fn = Object.values(fc.nodes).find((n) => n.members.some((x) => x.plannedHours > 0))!;
  const fp = fn.members.find((x) => x.plannedHours > 0)!;
  const el = chip(page, fn.teamId, fp.memberId);
  await el.scrollIntoViewIfNeeded();
  await el.hover();
  await expect(tip).toContainText("計画（見込み）");
  await expect(tip).not.toContainText("実績 ");
});

test("応援・ヘルプは案件の主担当チームに載り、チップで見分けられる", async ({ page }) => {
  const month = Array.from({ length: 6 }, (_, i) => addMonths(model.meta.lastFinalMonth, -i)).find((m) => Object.values(orgChartAt(model, m).nodes).some((n) => n.guests.some((g) => g.origin === "help")))!;
  const c = orgChartAt(model, month);
  const node = Object.values(c.nodes).find((n) => n.guests.some((g) => g.origin === "help"))!;
  const g = node.guests.find((x) => x.origin === "help")!;
  await gotoPage(page, `/teams?view=chart&month=${month}`);
  const sel = page.locator(`.yn-org-node[data-team="${node.teamId}"] [data-member="${g.memberId}"][data-origin="help"]`);
  // 実績だけの人は畳んである
  if (!(g.plannedHours > 0)) await page.locator(`.yn-org-node[data-team="${node.teamId}"] > .yn-org-people > .yn-org-spot > summary`).click();
  await expect(sel.locator(".yn-chip-help")).toHaveText("ヘルプ");
});

test("ずれの色は確定した月だけ。未確定の月は状態を出す", async ({ page }) => {
  await gotoPage(page, `/teams?view=chart&color=gap&month=${model.meta.lastFinalMonth}`);
  await expect(page.locator(".yn-org-status")).toHaveCount(0);
  await expect(page.locator(".yn-org-person.is-full, .yn-org-person.is-over, .yn-org-person.is-under").first()).toBeVisible();
  await page.locator('[data-org="next"]').click();
  await page.locator('[data-org="next"]').click();
  await expect(page.locator(".yn-org-status")).toBeVisible();
});

for (const width of [390, 768, 1024, 1280]) {
  test(`はみ出さない: ${width}px ダーク`, async ({ page }) => {
    await useDarkTheme(page);
    await page.setViewportSize({ width, height: 900 });
    await gotoPage(page, "/teams?view=chart");
    await expect(page.locator(".yn-org-tree")).toBeVisible();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over).toBeLessThanOrEqual(0);
    // チップが組織の枠からはみ出さない
    const bad = await page.evaluate(() =>
      [...document.querySelectorAll(".yn-org-person")].filter((el) => {
        const box = el.getBoundingClientRect();
        const parent = el.closest(".yn-org-node")!.getBoundingClientRect();
        return box.right > parent.right + 1 || box.left < parent.left - 1;
      }).length,
    );
    expect(bad).toBe(0);
  });
}
