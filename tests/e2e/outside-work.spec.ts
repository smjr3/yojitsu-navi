/**
 * 契約外の作業の計画と予実（SPEC §50）
 *   - メンバー別・メンバー詳細の「契約外を含む」: 計画と実績の両方に契約外を足す（core の aggregateMembers と一致）
 *   - URL（outside=1）と localStorage で覚える。予算の画面には切替を置かない
 *   - メンバー詳細の案件別に「契約外: 種別」の行（リンクなし）
 * 年度・月はデータの基準日から求める（特定の年度を書かない）。金額は URL に unit=yen を付けて比べる。
 */
import { aggregateMembers, isOutsideRow, type Period } from "../../src/core/index.js";
import { test, expect, gotoPage, tableByCaption, kpiValue, pickCombo } from "./helpers/app.js";
import { fiscalPeriod, getModel, yen } from "./helpers/core.js";

const model = getModel();
const FY = fiscalPeriod(model);
const ASOF = model.meta.asOfMonth;
const CMP: Period = { from: FY.from, to: FY.to < ASOF ? FY.to : ASOF };
const U = "unit=yen";

/** 契約外の計画も実績もある人（期間の経過月で） */
function memberWithOutside(): string {
  const on = aggregateMembers(model, { period: CMP, includeOutside: true });
  const hit = on.members.find((m) => {
    const out = m.byContract.filter(isOutsideRow);
    return out.some((c) => c.plannedHours > 0) && out.some((c) => c.actualHours > 0) && m.byContract.some((c) => !isOutsideRow(c));
  });
  if (!hit) throw new Error("契約外の計画と実績のある人がダミーデータにいない");
  return hit.memberId;
}

test("メンバー別: 既定は契約外を含まない。「運用保守以外を含む」で計画・実績の両方が増え、URL に outside=1", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, `/members?from=${FY.from}&to=${FY.to}&${U}`);
  const chip = page.locator("#yn-filter-outside");
  await expect(chip).not.toBeChecked();
  const off = aggregateMembers(model, { period: CMP });
  await expect(kpiValue(page, 0)).toHaveText(yen(off.total.plannedCost));
  await expect(kpiValue(page, 1)).toHaveText(yen(off.total.actualCost));
  expect(new URL(page.url()).searchParams.has("outside")).toBe(false);

  await page.getByText("運用保守以外を含む").click();
  await expect(chip).toBeChecked();
  const on = aggregateMembers(model, { period: CMP, includeOutside: true });
  expect(on.total.plannedCost).toBeGreaterThan(off.total.plannedCost);
  expect(on.total.actualCost).toBeGreaterThan(off.total.actualCost);
  await expect(kpiValue(page, 0)).toHaveText(yen(on.total.plannedCost));
  await expect(kpiValue(page, 1)).toHaveText(yen(on.total.actualCost));
  await expect.poll(() => new URL(page.url()).searchParams.get("outside")).toBe("1");
  // 契約外予定だけの人も一覧に出る
  const onlyOutside = on.members.find((m) => m.byContract.every(isOutsideRow));
  if (onlyOutside) await expect(tableByCaption(page, "メンバー別の計画と実績").locator(`tbody tr[data-key="${onlyOutside.memberId}"]`)).toHaveCount(1);

  // 別の画面へ移っても引き継ぎ、戻すと URL から消える
  await gotoPage(page, `/members?${U}`);
  await expect(page.locator("#yn-filter-outside")).toBeChecked();
  await page.getByText("運用保守以外を含む").click();
  await expect(page.locator("#yn-filter-outside")).not.toBeChecked();
  await expect.poll(() => new URL(page.url()).searchParams.has("outside")).toBe(false);
});

test("メンバー詳細: 含むと案件別に「契約外: 種別」の行（リンクなし）、合計は core と一致", async ({ page }) => {
  const id = memberWithOutside();
  await gotoPage(page, `/member?id=${id}&from=${FY.from}&to=${FY.to}&${U}`);
  const table = tableByCaption(page, "案件別の計画と実績");
  await expect(table.locator("tbody tr", { hasText: "運用保守以外:" })).toHaveCount(0);
  await page.getByText("運用保守以外を含む").click();
  const t = aggregateMembers(model, { period: CMP, memberIds: [id], includeOutside: true }).members[0]!;
  await expect(kpiValue(page, 0)).toHaveText(yen(t.plannedCost));
  await expect(kpiValue(page, 1)).toHaveText(yen(t.actualCost));
  const outside = t.byContract.filter(isOutsideRow);
  const rows = table.locator("tbody tr", { hasText: "運用保守以外:" });
  await expect(rows).toHaveCount(outside.filter((c) => c.outsideType !== "").length);
  await expect(rows.locator("a")).toHaveCount(0);
  // 根拠パネル: 実績の内訳にも契約外の行
  await kpiValue(page, 1).click();
  await expect(page.locator("dialog[open]")).toContainText("運用保守以外:");
});

test("予算の画面（全体・チーム・顧客・案件・工数）には切替を置かない", async ({ page }) => {
  for (const path of ["/", "/teams", "/customers", "/contracts", "/workload"]) {
    await gotoPage(page, `${path}?outside=1`);
    await expect(page.locator("#yn-filter-outside")).toHaveCount(0);
  }
});

test("リソース計画: 種別の行のセルから入れると outside-plans.csv にその種別で入る", async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("yojitsu-navi:masters-draft:v1"));
  const next = model.meta.fiscalYearMonths.find((m) => m > ASOF) ?? model.meta.fiscalYearMonths[model.meta.fiscalYearMonths.length - 1]!;
  await gotoPage(page, "/plan?member=M011");
  const cellBtn = page.locator(`[data-fk="plan:cell:M011:o:会社業務:${next}"]`);
  await expect(cellBtn).toHaveText("—");
  await cellBtn.click();
  const pop = page.locator("dialog.yn-plan-pop[open]");
  const input = pop.getByLabel(new RegExp(`会社業務.*`));
  await input.fill("0.1");
  await input.press("Enter");
  await expect(pop).toHaveCount(0);
  await expect(cellBtn).toHaveText("0.10");
  await expect(page.locator(".yn-me-diff-slot")).toContainText("会社業務");
});

test("リソース計画: 運用保守以外の種別は、表示中の期間に計画か実績がある種別だけ。ほかの種別はセルの「作業を追加」から検索して足す（§50.3）", async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("yojitsu-navi:masters-draft:v1"));
  const next = model.meta.fiscalYearMonths.find((m) => m > ASOF) ?? model.meta.fiscalYearMonths[model.meta.fiscalYearMonths.length - 1]!;
  await gotoPage(page, "/plan?member=M011");
  // M011 は提案・会社業務の実績だけ。設計・構築は出さない（全員に全種別を並べない）
  const names = page.locator('tr.yn-me-plan-sub.is-outside[data-member="M011"] .yn-me-plan-name');
  await expect(names).toHaveText(["提案", "会社業務"]);
  // 人の行のセル → 「作業を追加」で「構築」を検索して選ぶ（案件と同じ欄。運用保守以外の種別も候補に出る）
  await page.locator(`[data-fk="plan:cell:M011:all:${next}"]`).click();
  const pop = page.locator("dialog.yn-plan-pop[open]");
  await expect(pop.getByText("作業を追加")).toBeVisible();
  await pickCombo(pop.locator("#yn-plan-pop-project"), "構築");
  await expect(pop.locator("#yn-plan-pop-project")).toHaveValue("構築");
  await pop.locator("#yn-plan-pop-new").fill("0.1");
  await pop.getByRole("button", { name: "反映" }).click();
  await expect(pop).toHaveCount(0);
  await expect(names).toHaveText(["提案", "構築", "会社業務"]);
  await expect(page.locator(`[data-fk="plan:cell:M011:o:構築:${next}"]`)).toHaveText("0.10");
  await expect(page.locator(".yn-me-diff-slot")).toContainText("構築");
  // 出ている種別は「作業を追加」の候補から外す
  await page.locator(`[data-fk="plan:cell:M011:all:${next}"]`).click();
  await pop.locator("#yn-plan-pop-project").fill("構築");
  await expect(pop.locator(".yn-combo-list [role=option]")).toHaveCount(0);
});
