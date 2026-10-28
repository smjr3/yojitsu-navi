/**
 * 稼働計画 /plan（SPEC §23）と、組織の種別・リーダーの表示（§21・§22）
 */
import { test, expect, gotoPage, pickCombo } from "./helpers/app.js";
import { ROOT_DIR } from "./constants.js";
import { buildMastersPayload } from "../../src/data/_masters.js";
import { addRow, parseMasterDoc, planSourcesFromDocs, serializeMasterDoc } from "../../src/core/masterEdit.js";
import { planView } from "../../src/core/plan.js";

const PAYLOAD = buildMastersPayload(ROOT_DIR);
const FY = Array.from({ length: 12 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 3 + i, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
});
const docs = () => ({
  teams: parseMasterDoc("teams", PAYLOAD.files.teams.text),
  members: parseMasterDoc("members", PAYLOAD.files.members.text),
  assignments: parseMasterDoc("assignments", PAYLOAD.files.assignments.text),
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("yojitsu-navi:masters-draft:v1"));
});

test("稼働計画: 組織（第1課）を指定して開くと、配下のメンバーと月の配分合計（人月）が core と一致", async ({ page }) => {
  await gotoPage(page, "/plan?team=S11");
  await expect(page.getByRole("tab", { name: /稼働計画/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".yn-tools a", { hasText: "稼働計画" })).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#yn-me-plan-team")).toHaveValue("S11");
  await expect(page.locator(".yn-me-plan-unit")).toContainText("リーダー: 田中 さくら");
  const expected = planView(planSourcesFromDocs(docs(), PAYLOAD.context.contracts), "S11", FY);
  const rows = page.locator("tr.yn-me-plan-row");
  await expect(rows).toHaveCount(expected.rows.length);
  for (const [i, r] of expected.rows.entries()) {
    const row = rows.nth(i);
    await expect(row).toHaveAttribute("data-member", r.memberId);
    const cells = row.locator("td.yn-me-plan-cell");
    for (const [m, v] of r.monthly.entries()) await expect(cells.nth(m)).toHaveText(v > 0 ? v.toFixed(2) : "—");
  }
});

test("稼働計画: 時間で入力すると人月に直して保存し、表示は人月", async ({ page }) => {
  await gotoPage(page, "/plan?member=M011");
  await expect(page.locator("#yn-me-plan-team")).toHaveValue("T111");
  const row = page.locator('tr.yn-me-plan-row[data-member="M011"]');
  await expect(row).toHaveClass(/is-focus/);
  await row.getByRole("button", { name: /計画を追加/ }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  await expect(d.locator("#yn-me-f-member_id")).toHaveValue("小林 玲奈");
  await expect(d.locator('input[name="member_id"]')).toHaveValue("M011");
  // 案件で選ぶ（期間 2026-11〜2027-03 は更新後の契約 C002 に割り当てられる。§24.3）
  await pickCombo(d.locator("#yn-me-f-contract_id"), "倉庫管理");
  await d.locator("#yn-me-f-start_month").fill("2026-11");
  await d.locator("#yn-me-f-end_month").fill("2027-03");
  await d.locator("#yn-me-f-allocation-unit").selectOption("hours");
  await d.locator("#yn-me-f-allocation").fill("16");
  await expect(d.locator(".yn-me-conv")).toContainText("16 時間 = 0.1 人月");
  await d.locator('[data-role="submit"]').click();
  await expect(d).toHaveCount(0);
  // 11月（8 列目）から 0.90 + 0.10 = 1.00
  const cells = row.locator("td.yn-me-plan-cell");
  await expect(cells.nth(6)).toHaveText("0.90");
  await expect(cells.nth(7)).toHaveText("1.00");
  await expect(page.locator(".yn-me-plan-item.is-added")).toContainText("0.10 人月/月");
  // 保存されるのは人月
  const expected = addRow(parseMasterDoc("assignments", PAYLOAD.files.assignments.text), { member_id: "M011", contract_id: "C002", start_month: "2026-11", end_month: "2027-03", allocation: "0.1" }).doc;
  await expect(page.locator(".yn-me-diff-slot")).toContainText(/小林 玲奈 ・ 青葉物流 \/ 倉庫管理システム保守 ・ 2026-11 ・ 2027-03 ・ 0\.1/);
  expect(serializeMasterDoc(expected).text).toContain("M011,C002,2026-11,2027-03,0.1\n");
});

test("稼働計画: 単位を切り替えると入っている値を換算して見せる。1.0 人月を超える月は「超過」", async ({ page }) => {
  await gotoPage(page, "/plan?member=M011");
  const row = page.locator('tr.yn-me-plan-row[data-member="M011"]');
  await row.getByRole("button", { name: /計画を追加/ }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  await pickCombo(d.locator("#yn-me-f-contract_id"), "倉庫管理");
  await d.locator("#yn-me-f-allocation").fill("0.5");
  await d.locator("#yn-me-f-allocation-unit").selectOption("hours");
  await expect(d.locator("#yn-me-f-allocation")).toHaveValue("80");
  await d.locator("#yn-me-f-allocation-unit").selectOption("personMonth");
  await expect(d.locator("#yn-me-f-allocation")).toHaveValue("0.5");
  await d.locator('[data-role="submit"]').click();
  await expect(d).toHaveCount(0);
  await expect(row).toContainText("1.0 超");
  await expect(row.locator("td.yn-me-plan-cell.is-over").first()).toHaveText("1.40");
  await expect(page.locator(".yn-me-check")).toContainText("保存できません");
});

test("組織の種別とリーダー: チーム一覧の列、チーム詳細の見出し、マスタ編集の組織タブ", async ({ page }) => {
  await gotoPage(page, "/teams");
  const s11 = page.locator("tr", { hasText: "第1課" }).first();
  await expect(s11).toContainText("課");
  await expect(s11).toContainText("田中 さくら");
  await gotoPage(page, "/team?id=T212");
  await expect(page.locator("#yn-team-org")).toContainText("チーム");
  await expect(page.locator("#yn-team-org")).toContainText("清水 莉子");
  await expect(page.locator("#yn-team-plan-link")).toHaveAttribute("href", /plan\?team=T212/);
  await gotoPage(page, "/masters?view=teams");
  await expect(page.getByRole("tab", { name: /組織/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("table.yn-me-table thead")).toContainText("種別（課・チーム・班など）");
  await expect(page.locator("table.yn-me-table thead")).toContainText("リーダー");
  // 班を新設（種別は自由入力）
  await page.getByRole("button", { name: "＋ 新しい適用開始月の行を追加" }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  await d.locator("#yn-me-f-team_id").fill("G1111");
  await d.locator("#yn-me-f-name").fill("監視班");
  await d.locator("#yn-me-f-parent_team_id").selectOption("T111");
  await d.locator("#yn-me-f-level").fill("班");
  await pickCombo(d.locator("#yn-me-f-leader_member_id"), "小林");
  await d.locator('[data-role="submit"]').click();
  await expect(d).toHaveCount(0);
  await expect(page.locator(".yn-me-check")).toContainText("エラーなし");
  await expect(page.locator("tr.yn-me-row.is-added")).toContainText("小林 玲奈");
});
