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

test("リソース計画: 人の行の「＋ 作業」から「その他」など運用保守以外の作業を新しく入れられる（候補は種別が先。§50.6）", async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("yojitsu-navi:masters-draft:v1"));
  await gotoPage(page, "/plan?member=M002");
  const row = page.locator('tr.yn-me-plan-row[data-member="M002"]');
  // 運用保守以外の行がまだ無い人
  await expect(page.locator('tr.yn-me-plan-sub.is-outside[data-member="M002"]')).toHaveCount(0);
  await row.locator('[data-fk="plan:add:M002"]').click();
  const dialog = page.locator("dialog.yn-me-dialog[open]");
  await expect(dialog.locator("#yn-me-dialog-title")).toContainText("計画を追加");
  await expect(dialog.locator('label[for="yn-me-f-contract_id"]')).toContainText("案件・作業");
  // 候補の先頭は運用保守以外の種別（分類表の順 ＋ 受け皿の「その他」）。その後に案件
  const input = dialog.locator("#yn-me-f-contract_id");
  await input.click();
  const list = page.locator(`#${await input.getAttribute("aria-controls")}`);
  const types = [...model.outsideTypes];
  expect(types[types.length - 1]).toBe("その他");
  const labels = list.locator('[role="option"] .yn-combo-label');
  await expect(labels.first()).toBeVisible();
  expect((await labels.allInnerTexts()).slice(0, types.length)).toEqual(types);
  await input.press("Escape");
  await pickCombo(input, "その他");
  await expect(input).toHaveValue("その他");
  await dialog.locator("#yn-me-f-allocation").fill("0.2");
  await dialog.locator('[data-role="submit"]').click();
  await expect(dialog).toHaveCount(0);
  // 「その他」の行ができ、開始月から終了月まで 0.2。保存の差分は outside-plans.csv
  const sub = page.locator('tr.yn-me-plan-sub.is-outside[data-member="M002"]');
  await expect(sub.locator(".yn-me-plan-name")).toHaveText(["その他"]);
  const next = model.meta.fiscalYearMonths.find((m) => m > ASOF) ?? ASOF;
  await expect(page.locator(`[data-fk="plan:cell:M002:o:その他:${next}"]`)).toHaveText("0.20");
  await expect(page.locator(".yn-me-diff-slot")).toContainText("その他");
  // 見出しはファイル名でなく画面の名前（§117）。要約は「人・作業・月 前 → 後」
  await expect(page.locator(".yn-me-diff-slot h3")).not.toContainText("outside-plans.csv");
  await expect(page.locator(".yn-me-diff-summary")).toContainText("その他");
  // 運用保守以外の「その他」は分類表に無くても検証の警告にならない
  await expect(page.getByText(/種別「その他」/)).toHaveCount(0);
  // 同じ種別をもう一度入れると、重ねずに置き換える（行は 1 つのまま）
  await row.locator('[data-fk="plan:add:M002"]').click();
  await pickCombo(dialog.locator("#yn-me-f-contract_id"), "その他");
  await dialog.locator("#yn-me-f-allocation").fill("0.3");
  await dialog.locator('[data-role="submit"]').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(`[data-fk="plan:cell:M002:o:その他:${next}"]`)).toHaveText("0.30");
  await expect(sub).toHaveCount(1);
});

test("リソース計画: 過去の月を含む運用保守以外の追加は、影響する月を確認してから入れる（§50.6）", async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("yojitsu-navi:masters-draft:v1"));
  await gotoPage(page, "/plan?member=M002");
  await page.locator('[data-fk="plan:add:M002"]').click();
  const dialog = page.locator("dialog.yn-me-dialog[open]");
  await pickCombo(dialog.locator("#yn-me-f-contract_id"), "その他");
  const prev = model.meta.fiscalYearMonths.filter((m) => m < ASOF).pop();
  test.skip(!prev, "年度の最初の月が基準月");
  await dialog.locator("#yn-me-f-start_month").fill(prev!);
  await dialog.locator("#yn-me-f-allocation").fill("0.1");
  await dialog.locator('[data-role="submit"]').click();
  await expect(dialog.locator(".yn-me-confirm")).toBeVisible();
  await expect(dialog.locator('[data-role="submit"]')).toContainText("過去");
  await dialog.locator('[data-role="submit"]').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('tr.yn-me-plan-sub.is-outside[data-member="M002"] .yn-me-plan-name')).toHaveText(["その他"]);
});

test("リソース計画: セルの「作業を追加」でも、受け皿の「その他」を案件より先に選べる（§50.6）", async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("yojitsu-navi:masters-draft:v1"));
  const next = model.meta.fiscalYearMonths.find((m) => m > ASOF) ?? ASOF;
  await gotoPage(page, "/plan?member=M002");
  await page.locator(`[data-fk="plan:cell:M002:all:${next}"]`).click();
  const pop = page.locator("dialog.yn-plan-pop[open]");
  const input = pop.locator("#yn-plan-pop-project");
  await input.click();
  const list = page.locator(`#${await input.getAttribute("aria-controls")}`);
  await expect(list.locator('[role="option"]').first()).toContainText(model.outsideTypes[0]!);
  await pickCombo(input, "その他");
  await pop.locator("#yn-plan-pop-new").fill("0.1");
  await pop.getByRole("button", { name: "反映" }).click();
  await expect(pop).toHaveCount(0);
  await expect(page.locator(`[data-fk="plan:cell:M002:o:その他:${next}"]`)).toHaveText("0.10");
});
