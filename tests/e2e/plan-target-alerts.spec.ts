/**
 * リソース計画の目標の警告（SPEC §110）
 * - 今の計画で未達見込みになる目標を表の上に 1 件 1 行（core の planTargetAlerts と一致）。多いときは 3 件まで出し「ほか n件」で開く
 * - 目安の上限を超える月は月の見出しに !
 * - 組織を選ぶと配下込みの目標だけ。編集すると編集後の計画で出し直す（保存は止めない）
 * - 見込みの率を押すと計算根拠。390px・ダークで横スクロール無し
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme, usePlanFiscalYear } from "./helpers/app.js";
import { getModel } from "./helpers/core.js";
import { AS_OF, ROOT_DIR } from "./constants.js";
import { loadDataset } from "../../scripts/lib/load.js";
import { createMasterIndex, planTargetAlerts, type Assignment, type PlanTargetAlert } from "../../src/core/index.js";

const model = getModel();
const dataset = loadDataset(ROOT_DIR).dataset;
const inputs = (assignments: readonly Assignment[]) => ({ masters: createMasterIndex(dataset), assignments });
const keyOf = (a: PlanTargetAlert) => `${a.kind}:${a.evaluation.target.targetId}`;

test.beforeEach(async ({ page }) => {
  // 年度の月を前提にする（表示する月の既定は今月から 12 か月。§71）
  await usePlanFiscalYear(page, AS_OF);
  await page.addInitScript(() => {
    localStorage.removeItem("yojitsu-navi:masters-draft:v1");
    sessionStorage.removeItem("yojitsu-navi:masters-draft-session");
    sessionStorage.removeItem("yojitsu-navi:plan-cell-scope");
  });
});

const alertBox = (page: Page) => page.locator('[data-role="plan-target-alerts"]');
const items = (page: Page) => alertBox(page).locator("li.yn-me-plan-alert");
/** 月の見出しの ! がある月（YYYY-MM） */
async function markedMonths(page: Page): Promise<string[]> {
  const fys = model.meta.fiscalYearMonths;
  const ths = page.locator(".yn-me-plan-table thead th.num");
  const out: string[] = [];
  for (let i = 0; i < fys.length; i++) if ((await ths.nth(i).locator(".yn-me-plan-target-mark").count()) > 0) out.push(fys[i]!);
  return out;
}
const monthsOf = (list: PlanTargetAlert[]) => [...new Set(list.flatMap((a) => a.overMonths))].filter((m) => model.meta.fiscalYearMonths.includes(m)).sort();

test("すべての組織: 未達見込みの目標を 3 件まで出し、「ほか n件」で全部。月の見出しに !", { tag: "@smoke" }, async ({ page }) => {
  const exp = planTargetAlerts(model, null, { teamId: null });
  expect(exp.length).toBeGreaterThan(3);
  await gotoPage(page, "/plan");
  await expect(items(page)).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await expect(items(page).nth(i)).toHaveAttribute("data-target-id", exp[i]!.evaluation.target.targetId);
    await expect(items(page).nth(i)).toContainText("未達見込み");
  }
  await alertBox(page).getByRole("button", { name: `ほか ${exp.length - 3}件` }).click();
  await expect(items(page)).toHaveCount(exp.length);
  await expect(alertBox(page).getByRole("button", { name: "閉じる" })).toBeFocused();
  expect(await markedMonths(page)).toEqual(monthsOf(exp));
});

test("組織を選ぶと配下込みの目標だけ。目標・見込み・超える月を出し、見込みを押すと計算根拠", async ({ page }) => {
  const exp = planTargetAlerts(model, null, { teamId: "T111" });
  expect(exp.map(keyOf)).toEqual(["project:C002"]);
  const a = exp[0]!;
  await gotoPage(page, "/plan?team=T111");
  await expect(items(page)).toHaveCount(1);
  const li = items(page).first();
  await expect(li).toContainText("案件 青葉物流 / 倉庫管理システム保守（2026年12月）");
  await expect(li).toContainText(`目標 ${Math.round(a.evaluation.target.remainingRate * 100)}%`);
  await expect(li).toContainText(`見込み ${(a.evaluation.rate! * 100).toFixed(1)}%`);
  await expect(li).toContainText("超える月 2026年10月〜2026年12月");
  expect(await markedMonths(page)).toEqual(a.overMonths);
  await expect(page.locator(".yn-me-plan-target-mark").first()).toHaveAttribute("title", /目標の上限を超える見込み: 案件 青葉物流/);
  await li.locator("button.yn-num").click();
  const d = page.locator("dialog[open]");
  await expect(d).toContainText("残予算率 = (予算 − 着地) ÷ 予算");
  await expect(d).toContainText("計画値");
});

test("目標の無い組織・未達見込みの無い組織には出さない", async ({ page }) => {
  expect(planTargetAlerts(model, null, { teamId: "T311" })).toEqual([]);
  await gotoPage(page, "/plan?team=T311");
  await expect(page.locator(".yn-me-plan-table")).toBeVisible();
  await expect(alertBox(page)).toHaveCount(0);
  await expect(page.locator(".yn-me-plan-target-mark")).toHaveCount(0);
});

test("計画を編集すると編集後の計画で出し直す（12月を 0 にすると 12月の ! が消える）。保存は止めない", async ({ page }) => {
  const after = dataset.assignments.flatMap((x): Assignment[] =>
    x.memberId === "M010" && x.contractId === "C002"
      ? [
          { ...x, endMonth: "2026-11" },
          { ...x, startMonth: "2026-12", endMonth: "2026-12", allocation: 0 },
          { ...x, startMonth: "2027-01" },
        ]
      : [x],
  );
  const exp = planTargetAlerts(model, inputs(after), { teamId: "T111" });
  expect(exp[0]!.overMonths).toEqual(["2026-10", "2026-11"]);
  await gotoPage(page, "/plan?team=T111");
  expect(await markedMonths(page)).toContain("2026-12");
  await page.locator('[data-fk="plan:cell:M010:all:2026-12"]').click();
  const input = page.locator("dialog.yn-plan-pop[open] #yn-plan-pop-0");
  await input.fill("0");
  await input.press("Enter");
  await expect(page.locator("dialog.yn-plan-pop[open]")).toHaveCount(0);
  await expect(items(page).first()).toContainText("超える月 2026年10月〜2026年11月");
  await expect(items(page).first()).toContainText(`見込み ${(exp[0]!.evaluation.rate! * 100).toFixed(1)}%`);
  expect(await markedMonths(page)).toEqual(["2026-10", "2026-11"]);
  // 検証のエラーにはしない
  await expect(page.locator(".yn-me-check")).not.toContainText("目標");
});

test("390px・ダーク: 横スクロールなし", async ({ page }) => {
  await useDarkTheme(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await gotoPage(page, "/plan");
  await expect(items(page)).toHaveCount(3);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await alertBox(page).boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});
