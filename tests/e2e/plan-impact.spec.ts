/**
 * リソース計画の変更の影響（SPEC §65）
 * - 計画を変えると、保存の上に「変更の影響」: 案件の着地の増減・残予算（期間・案件終了時点）の前→後、残予算率が変わる目標（core の planImpact と一致）
 * - 元に戻すと消える。実績で確定した月だけの変更は「変わりません」
 * - 期間・単位は表示条件を引き継ぐ。390px・ダークで横スクロール無し
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";
import { getModel } from "./helpers/core.js";
import { ROOT_DIR } from "./constants.js";
import { loadDataset } from "../../scripts/lib/load.js";
import { createMasterIndex, formatYen, planImpact, type Assignment } from "../../src/core/index.js";

const model = getModel();
const dataset = loadDataset(ROOT_DIR).dataset;
const inputs = (assignments: readonly Assignment[]) => ({ masters: createMasterIndex(dataset), assignments });
const signed = (yen: number) => (yen > 0 ? `+${formatYen(yen, "yen")}` : formatYen(yen, "yen"));

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem("yojitsu-navi:masters-draft:v1");
    sessionStorage.removeItem("yojitsu-navi:masters-draft-session");
    sessionStorage.removeItem("yojitsu-navi:plan-cell-scope");
    if (!sessionStorage.getItem("yn-e2e-state")) {
      localStorage.setItem("yojitsu-navi:state:v2", JSON.stringify({ unit: "yen" }));
      sessionStorage.setItem("yn-e2e-state", "1");
    }
  });
});

const cell = (page: Page, member: string, month: string) => page.locator(`[data-fk="plan:cell:${member}:all:${month}"]`);
async function setCell(page: Page, member: string, month: string, value: string): Promise<void> {
  await cell(page, member, month).click();
  const input = page.locator("dialog.yn-plan-pop[open] #yn-plan-pop-0");
  await input.fill(value);
  await input.press("Enter");
  // 過去の月は影響の注記が出るので、もう一度押して確定
  const again = page.locator("dialog.yn-plan-pop[open]").getByRole("button", { name: /過去 \d+ か月にも反映/ });
  if (await again.isVisible().catch(() => false)) await again.click();
  await expect(page.locator("dialog.yn-plan-pop[open]")).toHaveCount(0);
}

/** M010 の C002（0.9 人月）を 2026-12 だけ 0.5 にしたときの core の影響 */
function expected() {
  const after = dataset.assignments.flatMap((a): Assignment[] =>
    a.memberId === "M010" && a.contractId === "C002"
      ? [
          { ...a, endMonth: "2026-11" },
          { ...a, startMonth: "2026-12", endMonth: "2026-12", allocation: 0.5 },
          { ...a, startMonth: "2027-01" },
        ]
      : [a],
  );
  return planImpact(model, inputs(dataset.assignments), inputs(after), model.meta.fiscalYearMonths);
}

test("計画を変えると、保存の前に案件の着地・残予算と目標の変化を出す。元に戻すと消える", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  const section = page.locator(".yn-me-impact");
  await expect(section).toHaveCount(0);
  await setCell(page, "M010", "2026-12", "0.5");
  await expect(section.getByRole("heading", { name: "変更の影響" })).toBeVisible();
  // 保存の欄より上
  const [impactBox, saveBox] = await Promise.all([section.boundingBox(), page.locator(".yn-me-save").boundingBox()]);
  expect(impactBox!.y).toBeLessThan(saveBox!.y);

  const exp = expected();
  expect(exp.rows.map((r) => r.contractId)).toEqual(["C002"]);
  const r = exp.rows[0]!;
  const row = section.locator('[data-role="impact-rows"] tbody tr[data-contract="C002"]');
  await expect(row.locator("th")).toHaveText("青葉物流 / 倉庫管理システム保守");
  await expect(row.locator("td").nth(0)).toHaveText(signed(r.after.forecastCost - r.before.forecastCost));
  await expect(row.locator("td").nth(1)).toContainText(formatYen(r.before.forecastGrossProfit, "yen"));
  await expect(row.locator("td").nth(1)).toContainText(formatYen(r.after.forecastGrossProfit, "yen"));
  await expect(row.locator("td").nth(3)).toContainText(formatYen(r.endAfter.forecastGrossProfit, "yen"));
  await expect(section.locator('[data-role="impact-rows"] tfoot')).toHaveCount(0);

  // 目標: C002・青葉物流・T111（通期）など、変わるものだけ
  expect(exp.targets.length).toBeGreaterThan(0);
  const trs = section.locator('[data-role="impact-targets"] tbody tr');
  await expect(trs).toHaveCount(exp.targets.length);
  await expect(section.locator('[data-role="impact-targets"]')).toContainText("案件 青葉物流 / 倉庫管理システム保守（2026年12月）");
  await expect(section.locator('[data-role="impact-targets"]')).not.toContainText("（2026年9月）");

  // 案件名から案件詳細へ（表示条件を引き継ぐ）
  await expect(row.locator("a")).toHaveAttribute("href", /\.\/contract\?id=C002/);

  // 元に戻すと消える
  await setCell(page, "M010", "2026-12", "0.9");
  await expect(section).toHaveCount(0);
});

test("実績で確定した月だけの変更は「着地見込みは変わりません」", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  await setCell(page, "M010", "2026-05", "0.5");
  await expect(page.locator('.yn-me-impact [data-role="impact-none"]')).toHaveText("着地見込みは変わりません");
});

test("期間・単位は表示条件を引き継ぐ（今月だけなら今月の着地）", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("yojitsu-navi:state:v2", JSON.stringify({ unit: "yen", from: "2026-10", to: "2026-10" })));
  await gotoPage(page, "/plan?team=T111");
  // 12 月だけ変えても今月の着地は変わらない（案件終了時点だけ変わる）
  await setCell(page, "M010", "2026-12", "0.5");
  const row = page.locator('.yn-me-impact [data-role="impact-rows"] tbody tr[data-contract="C002"]');
  await expect(row.locator("td").nth(0)).toHaveText("±0円");
  // 10 月も変えると今月の着地も変わる
  await setCell(page, "M010", "2026-10", "0.5");
  await expect(row.locator("td").nth(0)).not.toHaveText("±0円");
});

for (const dark of [false, true]) {
  test(`390px${dark ? "・ダーク" : ""}で横スクロール無し`, async ({ page }) => {
    if (dark) await useDarkTheme(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoPage(page, "/plan?team=T111");
    await setCell(page, "M010", "2026-12", "0.5");
    await expect(page.locator(".yn-me-impact")).toBeVisible();
    await page.locator(".yn-me-impact").scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
