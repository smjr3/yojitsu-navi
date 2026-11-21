/**
 * 氏名の吹き出し（SPEC §148）: 氏名にカーソルを合わせる・フォーカスすると、所属チーム・状態・今月の計画と実績・主な案件が出る。
 * 吹き出しは文書に 1 つだけ（行ごとに作らない）。指で触れたときは出さない。社員番号・単価は出さない
 */
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";
import { getModel } from "./helpers/core.js";

const model = getModel();
const asOf = model.meta.asOfMonth;
const recordAt = (id: string) => model.members.filter((r) => r.memberId === id && r.effectiveFrom <= asOf).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1)).at(-1);
const tip = (page: import("@playwright/test").Page) => page.locator("#yn-member-tip");

test("メンバー別: 氏名に合わせると吹き出し。氏名・チーム・今月の計画と実績が出て、ID・単価は出ない @smoke", async ({ page }) => {
  await gotoPage(page, "/members");
  const cells = page.locator("table [data-member-tip]");
  await expect(cells.first()).toBeVisible();
  // 行ごとに吹き出しの DOM を作らない
  await expect(page.locator(".yn-member-tip")).toHaveCount(0);
  const cell = cells.first();
  const id = (await cell.getAttribute("data-member-tip"))!;
  const rec = recordAt(id)!;
  await cell.hover();
  await expect(tip(page)).toBeVisible();
  await expect(tip(page).locator(".yn-plan-tip-head")).toContainText(rec.name);
  await expect(tip(page)).toContainText("今月の案件の計画");
  const text = (await tip(page).textContent()) ?? "";
  expect(text).not.toContain(id);
  expect(text).not.toContain("円");
  // 氏名のセルには title（ブラウザの小さな吹き出し）を付けない（二重に出さない）
  expect(await cell.getAttribute("title")).toBeNull();
  await expect(cell).toHaveAttribute("aria-describedby", "yn-member-tip");
  // 外へ出すと消える。別の人に合わせても吹き出しは 1 つ
  await page.locator("h1").hover();
  await expect(tip(page)).toBeHidden();
  await cells.nth(1).hover();
  await expect(tip(page)).toBeVisible();
  await expect(page.locator(".yn-member-tip")).toHaveCount(1);
});

test("キーボードのフォーカスでも出て、Esc で消える", async ({ page }) => {
  await gotoPage(page, "/members");
  const link = page.locator("table [data-member-tip] a").first();
  await link.focus();
  await expect(tip(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tip(page)).toBeHidden();
});

test("不在の人は「から終了」「から一時不在」を出す（§155）", async ({ page }) => {
  // 今月から不在の人（前月までの実績があるのでメンバー別の「終了した人も表示」で出る）
  const left = model.members.find((r) => r.status === "left" && r.effectiveFrom === asOf);
  test.skip(!left, "不在の人がいない");
  await gotoPage(page, "/members?f=left");
  const cell = page.locator(`table [data-member-tip="${left!.memberId}"]`).first();
  await cell.hover();
  await expect(tip(page).locator(".yn-member-tip-warn")).toContainText(left!.leave === "temporary" ? "から一時不在" : "から終了");
});

test("チーム詳細のリーダー・作業時間のメンバーにも出る。ダークでも読める", async ({ page }) => {
  await useDarkTheme(page);
  const team = model.teams.find((t) => t.leaderMemberId && recordAt(t.leaderMemberId))!;
  await gotoPage(page, `/team?id=${encodeURIComponent(team.teamId)}`);
  await page.locator(`a[data-member-tip="${team.leaderMemberId}"]`).hover();
  await expect(tip(page)).toBeVisible();
  await expect(tip(page).locator(".yn-plan-tip-head")).toContainText(recordAt(team.leaderMemberId!)!.name);
  await gotoPage(page, "/workload?axis=member");
  await page.locator("table [data-member-tip]").first().hover();
  await expect(tip(page)).toBeVisible();
});

test.describe("タッチ", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("指で触れても吹き出しは出さない（押すと従来どおり詳細へ）", async ({ page }) => {
    await gotoPage(page, "/members");
    const link = page.locator("table [data-member-tip] a").first();
    // 移動を止めて、触れた直後に吹き出しが出ていないことを確かめる
    await link.evaluate((a) => a.addEventListener("click", (e) => e.preventDefault()));
    await link.tap();
    await page.waitForTimeout(300);
    await expect(page.locator(".yn-member-tip:visible")).toHaveCount(0);
  });
});
