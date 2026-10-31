/**
 * リソース計画 /plan（SPEC §23・§36）と、組織の種別・リーダーの表示（§21・§22）
 */
import { test, expect, gotoPage, pickCombo, usePlanFiscalYear } from "./helpers/app.js";
import { AS_OF, ROOT_DIR } from "./constants.js";
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

/** 契約外予定（outside-plans.csv）の人 × 月の人月 */
function outsideAt(memberId: string, month: string): number {
  const doc = parseMasterDoc("outside", PAYLOAD.files.outside.text);
  const col = (r: { cells: string[] }, c: string) => r.cells[doc.header.indexOf(c)] ?? "";
  return doc.rows.filter((r) => col(r, "member_id") === memberId && col(r, "start_month") <= month && month <= col(r, "end_month")).reduce((s, r) => s + Number(col(r, "person_months")), 0);
}

test.beforeEach(async ({ page }) => {
  // 年度の月を前提にしたテスト（表示する月の既定は今月から 12 か月。§71）
  await usePlanFiscalYear(page, AS_OF);
  await page.addInitScript(() => localStorage.removeItem("yojitsu-navi:masters-draft:v1"));
});

test("リソース計画: 組織（第1課）を指定して開くと、配下のメンバーと月の配分合計（人月）が core と一致", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/plan?team=S11");
  // リソース計画は 1 画面（タブは出さない）
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.locator(".yn-tools a", { hasText: "リソース計画" })).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#yn-me-plan-team")).toHaveValue("S11");
  await expect(page.locator(".yn-me-plan-unit")).toContainText("リーダー: 田中 さくら");
  const expected = planView(planSourcesFromDocs(docs(), PAYLOAD.context.contracts), "S11", FY);
  const rows = page.locator("tr.yn-me-plan-row");
  await expect(rows).toHaveCount(expected.rows.length);
  for (const [i, r] of expected.rows.entries()) {
    const row = rows.nth(i);
    await expect(row).toHaveAttribute("data-member", r.memberId);
    const cells = row.locator("td.yn-me-plan-cell");
    // 人の行 = 保守の配分 ＋ 契約外予定
    for (const [m, v] of r.monthly.entries()) {
      const total = v + outsideAt(r.memberId, FY[m]!);
      await expect(cells.nth(m)).toHaveText(total > 0 ? total.toFixed(2) : "—");
      // 色: 1.0 超は黄、0 より多く 1.0 未満は青系、0 とちょうど 1.0 は色なし（§41）
      const level = total > 1 + 1e-9 ? "is-over" : total > 1e-9 && total < 1 - 1e-9 ? "is-under" : null;
      for (const c of ["is-over", "is-under"]) {
        if (c === level) await expect(cells.nth(m)).toHaveClass(new RegExp(`\\b${c}\\b`));
        else await expect(cells.nth(m)).not.toHaveClass(new RegExp(`\\b${c}\\b`));
      }
    }
  }
});

test("リソース計画: 時間で入力すると人月に直して保存し、表示は人月", async ({ page }) => {
  await gotoPage(page, "/plan?member=M011");
  await expect(page.locator("#yn-me-plan-team")).toHaveValue("T111");
  const row = page.locator('tr.yn-me-plan-row[data-member="M011"]');
  await expect(row).toHaveClass(/is-focus/);
  await row.getByRole("button", { name: /計画を追加/ }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  await expect(d.locator("#yn-me-f-member_id")).toHaveValue("小林 玲奈");
  await expect(d.locator('input[name="member_id"]')).toHaveValue("M011");
  // 案件で選ぶ（期間 2026-11〜2027-03 は更新後の案件 C002 に割り当てられる。§31.3）
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
  // 追加した人は開いて案件の行が見える。案件の行に「追加」、変更の履歴に 11月からの 0.10 人月
  await expect(page.locator('[data-fk="plan:toggle:M011"]')).toHaveAttribute("aria-expanded", "true");
  const sub = page.locator('tr.yn-me-plan-sub.is-project[data-member="M011"]').filter({ hasText: "倉庫管理" });
  await expect(sub).toContainText("追加");
  await sub.locator('[data-fk^="plan:hist:"]').click();
  await expect(page.locator("tr.yn-me-plan-hist li.yn-me-plan-entry.is-added")).toContainText("2026-11〜2027-03");
  // 保存されるのは人月
  const expected = addRow(parseMasterDoc("assignments", PAYLOAD.files.assignments.text), { member_id: "M011", contract_id: "C002", start_month: "2026-11", end_month: "2027-03", allocation: "0.1" }).doc;
  await expect(page.locator(".yn-me-diff-slot")).toContainText(/小林 玲奈 ・ 青葉物流 \/ 倉庫管理システム保守 ・ 2026-11 ・ 2027-03 ・ 0\.1/);
  expect(serializeMasterDoc(expected).text).toContain("M011,C002,2026-11,2027-03,0.1,,\n");
});

test("リソース計画: 単位を切り替えると入っている値を換算して見せる。1.0 人月を超える月は「超過」", async ({ page }) => {
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
  // 1.0 超は警告（保存は止めない。§40）
  await expect(page.locator(".yn-me-check")).toContainText("エラーなし");
  await expect(page.locator(".yn-me-issue-item.is-warning", { hasText: "1.0 を超えています" })).toContainText("小林 玲奈");
});

for (const dark of [false, true]) {
  test(`リソース計画: 1.0 未満の月は青系、1.0 超は黄、0 は色なし（${dark ? "ダーク" : "ライト"}。§41）`, async ({ page }) => {
    if (dark) await page.addInitScript(() => localStorage.setItem("yn-theme", "dark"));
    await gotoPage(page, "/plan?member=M011");
    const row = page.locator('tr.yn-me-plan-row[data-member="M011"]');
    await row.getByRole("button", { name: /計画を追加/ }).click();
    const d = page.locator("dialog.yn-me-dialog[open]");
    await pickCombo(d.locator("#yn-me-f-contract_id"), "倉庫管理");
    await d.locator("#yn-me-f-start_month").fill("2026-11");
    await d.locator("#yn-me-f-end_month").fill("2026-11");
    await d.locator("#yn-me-f-allocation").fill("0.5");
    await d.locator('[data-role="submit"]').click();
    await expect(d).toHaveCount(0);
    const cells = row.locator("td.yn-me-plan-cell");
    const under = row.locator("td.yn-me-plan-cell.is-under").first();
    const over = row.locator("td.yn-me-plan-cell.is-over").first();
    await expect(under).toBeVisible();
    await expect(over).toHaveText("1.40");
    const style = (l: typeof cells) => l.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }));
    const u = await style(under);
    const o = await style(over);
    expect(u.bg).not.toBe(o.bg);
    expect(u.fg).not.toBe(o.fg);
    // 青系（青の成分が赤より大きい）
    const rgb = (c: string) => c.match(/\d+/g)!.map(Number);
    const [r, , b] = rgb(u.fg);
    expect(b).toBeGreaterThan(r!);
    // 0 の月は色なし
    const empty = cells.filter({ hasText: "—" }).first();
    if (await empty.count()) await expect(empty).not.toHaveClass(/is-under|is-over/);
    // 内訳の行は色を付けない
    await expect(page.locator('[data-fk="plan:toggle:M011"]')).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('tr.yn-me-plan-sub[data-member="M011"] td.yn-me-plan-cell').first()).toBeVisible();
    await expect(page.locator('tr.yn-me-plan-sub[data-member="M011"] td.yn-me-plan-cell.is-under')).toHaveCount(0);
  });
}

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
  await page.getByRole("button", { name: "＋ 新しい組織" }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  await d.locator("#yn-me-f-team_id").fill("G1111");
  await d.locator("#yn-me-f-name").fill("監視班");
  await d.locator("#yn-me-f-parent_team_id").selectOption("T111");
  await d.locator("#yn-me-f-level").fill("班");
  await pickCombo(d.locator("#yn-me-f-leader_member_id"), "小林");
  await d.locator('[data-role="submit"]').click();
  await expect(d).toHaveCount(0);
  await expect(page.locator(".yn-me-check")).toContainText("エラーなし");
  const g = page.locator('tr.yn-me-group[data-group="G1111"]');
  await expect(g).toContainText("監視班");
  await expect(g).toContainText("小林 玲奈");
  await expect(g).toContainText("追加");
});
