/**
 * 閲覧画面に ID を出さない（SPEC §139）
 * - 社員番号・チーム ID・案件 ID・正式な案件 ID は、閲覧画面（本文・ホバー・読み上げ・計算根拠のダイアログ・作業ログ）に出さない。
 *   人・組織・案件は氏名・組織名・「顧客 / 案件名」で出す
 * - 取り込み・照合に ID が要る画面（マスタ編集・データ確認・設定）は対象外
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage } from "./helpers/app.js";
import { getModel } from "./helpers/core.js";

/** データにある ID（社員番号・チーム ID・案件 ID・正式な案件 ID） */
function idPattern(): RegExp {
  const model = getModel();
  const ids = new Set<string>();
  for (const m of model.members) ids.add(m.memberId);
  for (const t of model.teams) ids.add(t.teamId);
  for (const r of model.contracts) {
    ids.add(r.contract.contractId);
    if (r.contract.projectId) ids.add(r.contract.projectId);
  }
  const list = [...ids].filter((s) => s.length >= 2).sort((a, b) => b.length - a.length);
  const esc = list.map((s) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"));
  return new RegExp(`(?<![A-Za-z0-9_-])(?:${esc.join("|")})(?![A-Za-z0-9_-])`);
}

/** 本文の文字・title・aria-label のうち ID を含む行 */
async function idLines(page: Page, scope: string, re: RegExp): Promise<string[]> {
  const texts = await page.evaluate((sel) => {
    const out: string[] = [];
    for (const root of document.querySelectorAll(sel)) {
      out.push((root as HTMLElement).innerText);
      for (const el of root.querySelectorAll("[title], [aria-label]")) out.push(`${el.getAttribute("title") ?? ""} ${el.getAttribute("aria-label") ?? ""}`);
    }
    return out;
  }, scope);
  return texts.flatMap((t) => t.split("\n")).filter((l) => re.test(l)).map((l) => l.trim().slice(0, 120));
}

/** 「作業ログを読み込む」「すべて表示」を押して、隠れている行も出す */
async function expandAll(page: Page, scope: string): Promise<void> {
  for (const b of await page.locator(scope).getByRole("button", { name: /作業ログを読み込む|すべて表示/ }).all()) {
    if (await b.isVisible()) await b.click().catch(() => {});
  }
  await page.waitForTimeout(300);
}

const PAGES = ["/", "/teams", "/teams?view=chart", "/team?id=T221", "/contracts", "/contract?id=C011", "/customers", "/members", "/member?id=M004", "/member?id=M099", "/workload", "/plan?team=S11"];

for (const path of PAGES) {
  test(`ID を出さない: ${path}`, async ({ page }) => {
    test.setTimeout(120_000);
    const re = idPattern();
    await gotoPage(page, path);
    await expandAll(page, "#observablehq-main");
    expect(await idLines(page, "#observablehq-main", re), "本文・ホバー").toEqual([]);
    // 計算根拠のダイアログ（数字のボタン）。作業ログの明細も読み込む
    const buttons = page.locator("#observablehq-main .yn-kpi-value, #observablehq-main td button");
    const n = Math.min(await buttons.count(), 30);
    const hits = new Set<string>();
    for (let i = 0; i < n; i++) {
      const b = buttons.nth(i);
      if (!(await b.isVisible())) continue;
      await b.click();
      // 計算根拠（yn-dialog）のほか、リソース計画のマスの吹き出しなども見る
      const d = page.locator("dialog[open]");
      if (!(await d.first().isVisible().catch(() => false))) continue;
      await expandAll(page, "dialog[open]");
      for (const l of await idLines(page, "dialog[open]", re)) hits.add(l);
      await page.keyboard.press("Escape");
      // Esc で閉じない吹き出し（リソース計画のマス）は開き直して続ける
      if (await d.first().isVisible().catch(() => false)) await gotoPage(page, path);
    }
    expect([...hits], "ダイアログ").toEqual([]);
  });
}

test("案件詳細の作業ログ: メンバーは氏名で、社員番号の列も無い", async ({ page }) => {
  await gotoPage(page, "/contract?id=C011");
  await page.getByRole("button", { name: "作業ログを読み込む" }).click();
  const table = page.locator(".yn-worklog table").first();
  await expect(table).toBeVisible();
  await page.locator(".yn-worklog").getByRole("button", { name: /すべて表示/ }).click();
  await expect(table.locator("thead")).not.toContainText("社員番号");
  // マスタに無い人（M099）は作業実績の氏名
  await expect(table.locator("tbody")).toContainText("臨時 太郎");
  // 「列」で選べる列にも社員番号は無い
  await page.locator(".yn-worklog .yn-cols-btn").click();
  const pop = page.locator(".yn-cols-pop");
  await expect(pop).toContainText("作業コード");
  await expect(pop).not.toContainText("社員番号");
});
