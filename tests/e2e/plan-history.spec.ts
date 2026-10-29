/**
 * リソース計画の持ち方（SPEC §36）: 人 × 案件の行・「＋ 変更」・変更の履歴・契約外予定、
 * マスタ編集（台帳）との役割分担（旧 URL の転送・別画面の変更の案内）
 */
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";
import { ROOT_DIR } from "./constants.js";
import { buildMastersPayload } from "../../src/data/_masters.js";

const PAYLOAD = buildMastersPayload(ROOT_DIR);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("yn-e2e-keep-draft") !== "1") localStorage.removeItem("yojitsu-navi:masters-draft:v1");
    sessionStorage.removeItem("yojitsu-navi:plan-cell-scope");
  });
});

const cell = (page: Page, member: string, month: string) => page.locator(`[data-fk="plan:cell:${member}:all:${month}"]`);
const dialog = (page: Page) => page.locator("dialog.yn-me-dialog[open]");

/** 人の行を開いて、案件（または契約外予定）の行を返す */
async function subRow(page: Page, member: string, target: "outside" | string) {
  const toggle = page.locator(`[data-fk="plan:toggle:${member}"]`);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const rows = page.locator(`tr.yn-me-plan-sub[data-member="${member}"]`);
  return target === "outside" ? rows.and(page.locator(".is-outside")) : rows.and(page.locator(".is-project")).filter({ hasText: target });
}

/** 変更の履歴を開いて、項目（li）を返す */
async function historyOf(page: Page, sub: ReturnType<Page["locator"]>) {
  const btn = sub.locator('[data-fk^="plan:hist:"]');
  if ((await btn.getAttribute("aria-expanded")) !== "true") await btn.click();
  const id = await btn.getAttribute("aria-controls");
  return page.locator(`#${id} li.yn-me-plan-entry`);
}

test("人ごとに 1 行。開くと案件ごとの行と契約外予定の行（同じ案件が 2 行に増えない）", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  // M010 は 11〜1 月に契約外予定 0.2 → 人の行は 1.10、「1.0 超 3か月」
  const main = page.locator('tr.yn-me-plan-row[data-member="M010"]');
  await expect(main).toContainText("1.0 超 3か月");
  await expect(cell(page, "M010", "2026-11")).toHaveText("1.10");
  const toggle = page.locator('[data-fk="plan:toggle:M010"]');
  await expect(toggle).toHaveText(/案件 1＋契約外/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const proj = await subRow(page, "M010", "倉庫管理");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(proj).toHaveCount(1);
  await expect(proj).toContainText("青葉物流");
  const out = await subRow(page, "M010", "outside");
  await expect(out).toContainText("契約外予定");
  await expect(out).toContainText("提案など保守の契約外");
  await expect(page.locator('[data-fk="plan:cell:M010:o:2026-12"]')).toHaveText("0.20");
  await expect(page.locator('[data-fk="plan:cell:M010:o:2026-10"]')).toHaveText("—");
  // 合計の下に「うち契約外予定」
  await expect(page.locator("tr.yn-me-plan-foot-sub")).toContainText("0.20");
  // 案件の行は ID を出さない
  await expect(proj).not.toContainText("C002");
});

test("＋ 変更: 「何月から何人月」で入れると期間を分けて保存し、変更の履歴で前 → 後が見える。未来だけなら確認なし", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  const proj = await subRow(page, "M011", "倉庫管理");
  await proj.getByRole("button", { name: /人月を、ある月から変える/ }).click();
  const d = dialog(page);
  await expect(d.locator("#yn-me-dialog-title")).toContainText("小林 玲奈 ・ 倉庫管理システム保守 の人月を変える");
  // 既定は翌月から・計画の終わりまで
  await expect(d.locator("#yn-me-chg-from")).toHaveValue("2026-11");
  await expect(d.getByLabel(/計画の終わりまで/)).toBeChecked();
  await expect(d.locator(".yn-me-chg-preview")).toContainText("2026-11 の今の計画: 0.90 人月");
  await d.locator("#yn-me-chg-from").fill("2027-01");
  await d.locator("#yn-me-f-__value").fill("0.5");
  await expect(d.locator(".yn-me-chg-preview")).toContainText("2027-01〜2027-03 を 0.90 → 0.50 人月にします");
  await d.getByRole("button", { name: "反映" }).click();
  await expect(d).toHaveCount(0);
  await expect(cell(page, "M011", "2026-12")).toHaveText("0.90");
  for (const m of ["2027-01", "2027-02", "2027-03"]) await expect(cell(page, "M011", m)).toHaveText("0.50");
  // 案件の行は 1 行のまま。履歴は自動で開き、2 件（開始・変更）
  await expect(await subRow(page, "M011", "倉庫管理")).toHaveCount(1);
  const entries = page.locator(`tr.yn-me-plan-hist li.yn-me-plan-entry[data-key]`);
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(0)).toContainText("2026-04〜2026-12");
  await expect(entries.nth(0)).toContainText("開始");
  await expect(entries.nth(1)).toContainText("2027-01〜2027-03");
  await expect(entries.nth(1)).toContainText("0.90 → 0.50 人月に変更");
  // フォーカスは「＋ 変更」に戻る
  await expect(proj.getByRole("button", { name: /人月を、ある月から変える/ })).toBeFocused();
  // 差分: 元の行の期間を縮め、新しい行を足す
  const diff = page.locator(".yn-me-diff-table");
  await expect(diff).toContainText("2027-03 → 2026-12");
  await expect(diff).toContainText("小林 玲奈 ・ 青葉物流 / 倉庫管理システム保守 ・ 2027-01 ・ 2027-03 ・ 0.5");
  await expect(page.locator(".yn-me-check")).toContainText("エラーなし");

  // 同じ値に戻すと 1 件にまとまり、変更なし
  await proj.getByRole("button", { name: /人月を、ある月から変える/ }).click();
  await d.locator("#yn-me-chg-from").fill("2027-01");
  await d.locator("#yn-me-f-__value").fill("0.9");
  await d.getByRole("button", { name: "反映" }).click();
  await expect(entries).toHaveCount(1);
  await expect(page.locator(".yn-me-diff-slot")).toContainText("変更はありません");
});

test("＋ 変更: 0 で計画を外すと「計画なし」。この月だけ・終わりの月の指定。過去の月は確認してから", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  const proj = await subRow(page, "M012", "倉庫管理");
  const d = dialog(page);
  // この月だけ 0 → 12 月だけ外れる
  await proj.getByRole("button", { name: /人月を、ある月から変える/ }).click();
  await d.locator("#yn-me-chg-from").fill("2026-12");
  await d.locator("#yn-me-f-__value").fill("0");
  await d.getByLabel("この月だけ").check();
  await expect(d.locator(".yn-me-chg-preview")).toContainText("2026-12〜2026-12 の計画を外します");
  await d.getByRole("button", { name: "反映" }).click();
  await expect(cell(page, "M012", "2026-12")).toHaveText("—");
  await expect(cell(page, "M012", "2027-01")).toHaveText("0.90");
  const entries = await historyOf(page, proj);
  // 12 月から計画なし → 1 月から再開（最後は 2027-04 から計画なし）
  await expect(entries.filter({ hasText: /2026-12 から\s*計画なし/ })).toHaveCount(1);
  await expect(entries.filter({ hasText: /2027-04 から\s*計画なし/ })).toHaveCount(1);
  await expect(entries.filter({ hasText: "再開" })).toHaveCount(1);
  // 終わりの月を指定: 過去（2026-06〜2026-07）は影響の確認
  await proj.getByRole("button", { name: /人月を、ある月から変える/ }).click();
  await d.locator("#yn-me-chg-from").fill("2026-06");
  await d.getByLabel("終わりの月を指定").check();
  await d.locator("#yn-me-chg-to").fill("2026-07");
  await d.locator("#yn-me-f-__value").fill("0.7");
  await d.getByRole("button", { name: "反映" }).click();
  await expect(d.locator(".yn-me-impact")).toContainText("2 か月");
  await expect(cell(page, "M012", "2026-06")).toHaveText("0.90");
  await d.getByRole("button", { name: /過去 2 か月/ }).click();
  await expect(d).toHaveCount(0);
  await expect(cell(page, "M012", "2026-06")).toHaveText("0.70");
  await expect(cell(page, "M012", "2026-08")).toHaveText("0.90");
  // 入力の誤り
  await proj.getByRole("button", { name: /人月を、ある月から変える/ }).click();
  await d.locator("#yn-me-f-__value").fill("1.5");
  await d.getByRole("button", { name: "反映" }).click();
  await expect(d.locator(".yn-me-form-msg")).toContainText("0〜1.0");
  await d.locator("#yn-me-f-__value").fill("");
  await d.getByRole("button", { name: "反映" }).click();
  await expect(d.locator(".yn-me-form-msg")).toContainText("人月を入れてください");
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
});

test("変更の履歴から直接修正・削除できる（削除後はフォーカスが履歴の開閉ボタンへ）", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  const out = await subRow(page, "M010", "outside");
  const entries = await historyOf(page, out);
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(0)).toContainText("2026-11〜2027-01");
  await expect(entries.nth(0)).toContainText("0.20 人月");
  await expect(entries.nth(0)).toContainText("次期更改の提案");
  await expect(entries.nth(1)).toContainText("計画なし");
  // 修正: 人月を 0.1 に
  await entries.nth(0).getByRole("button", { name: /を修正/ }).click();
  const d = dialog(page);
  await expect(d.locator(".yn-dialog-head .yn-tip-pop")).toContainText("「＋ 変更」");
  await d.locator("#yn-me-f-person_months").fill("0.1");
  await d.locator('[data-role="submit"]').click();
  // 変わる内容を見せてから適用（過去には及ばない）
  await expect(d.locator(".yn-me-change-list")).toContainText("0.2 → 0.1");
  await d.locator('[data-role="submit"]').click();
  await expect(d).toHaveCount(0);
  await expect(cell(page, "M010", "2026-12")).toHaveText("1.00");
  await expect(entries.nth(0)).toContainText("変更");
  await entries.nth(0).getByRole("button", { name: /修正を元に戻す/ }).click();
  await expect(cell(page, "M010", "2026-12")).toHaveText("1.10");
  // 削除
  await entries.nth(0).getByRole("button", { name: /を削除/ }).click();
  await d.locator('[data-role="confirm-delete"]').click();
  await expect(cell(page, "M010", "2026-12")).toHaveText("0.90");
  await expect(out.locator('[data-fk^="plan:hist:"]')).toBeFocused();
  await expect(page.locator(".yn-me-removed")).toContainText("次期更改の提案");
});

test("契約外予定: ＋ 変更で入れる → 1.0 超の表示、ダウンロードは outside-plans.csv（予算・着地見込みには入らない）", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  const out = await subRow(page, "M011", "outside");
  await expect(out.locator('[data-fk^="plan:hist:"]')).toContainText("変更 0件");
  await out.getByRole("button", { name: /人月を、ある月から変える/ }).click();
  const d = dialog(page);
  await expect(d.locator(".yn-me-chg-preview")).toContainText("今の計画: 0.00 人月");
  await d.locator("#yn-me-f-__value").fill("0.3");
  await d.getByLabel("この月だけ").check();
  await expect(d.locator(".yn-me-chg-preview")).toContainText("2026-11〜2026-11 に 0.30 人月の計画を入れます");
  await d.getByRole("button", { name: "反映" }).click();
  await expect(d).toHaveCount(0);
  await expect(cell(page, "M011", "2026-11")).toHaveText("1.20");
  await expect(page.locator('tr.yn-me-plan-row[data-member="M011"]')).toContainText("1.0 超 1か月");
  // 超えても保存は止めない
  await expect(page.locator(".yn-me-check")).toContainText("エラーなし");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /outside-plans\.csv をダウンロード/ }).click()]);
  expect(readFileSync((await dl.path())!, "utf-8")).toBe(`${PAYLOAD.files.outside.text}M011,2026-11,2026-11,0.3,\n`);
  await expect(page.getByRole("button", { name: /assignments\.csv をダウンロード/ })).toHaveCount(0);
});

test("セルの修正欄で契約外予定も直せる", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  await cell(page, "M010", "2026-12").click();
  const p = page.locator("dialog.yn-plan-pop[open]");
  await expect(p.locator("#yn-plan-pop-out")).toHaveValue("0.2");
  await p.locator("#yn-plan-pop-out").fill("0");
  await p.locator("#yn-plan-pop-out").press("Enter");
  await expect(p).toHaveCount(0);
  await expect(cell(page, "M010", "2026-12")).toHaveText("0.90");
  await expect(cell(page, "M010", "2026-11")).toHaveText("1.10");
  const entries = await historyOf(page, await subRow(page, "M010", "outside"));
  // 11 月・1 月の 2 行に分かれ、12 月と 2 月から「計画なし」
  await expect(entries.filter({ hasText: "計画なし" })).toHaveCount(2);
  await expect(entries.filter({ hasText: "再開" })).toHaveCount(1);
});

test("マスタ編集とリソース計画の役割分担: 旧 URL はリソース計画へ。行き来しても編集は続き、別の画面の変更は保存欄で案内して同じ保存に入る", async ({ page }) => {
  await gotoPage(page, "/masters?view=assignments");
  await expect(page).toHaveURL(/\/plan/);
  await expect(page.locator("h1")).toHaveText("リソース計画");
  // リソース計画で 1 件変える → マスタ編集の保存欄で案内
  await cell(page, "M011", "2027-02").click();
  await page.locator("dialog.yn-plan-pop[open] #yn-plan-pop-0").fill("0.4");
  await page.locator("dialog.yn-plan-pop[open] #yn-plan-pop-0").press("Enter");
  await page.evaluate(() => sessionStorage.setItem("yn-e2e-keep-draft", "1"));
  await page.getByRole("link", { name: "マスタ編集", exact: true }).click();
  await expect(page.locator("h1")).toHaveText("マスタ編集");
  // 同じタブの続きなので「復元しますか」は聞かない
  await expect(page.locator(".yn-me-banner")).toHaveCount(0);
  await expect(page.locator(".yn-me-save")).toContainText("別の画面で編集");
  await expect(page.locator(".yn-me-save").getByRole("link", { name: /リソース計画を開く/ })).toHaveAttribute("href", /plan/);
  await expect(page.getByRole("button", { name: /assignments\.csv をダウンロード/ })).toBeVisible();
});

test("台帳の「＋ 変更」: メンバーの役職を来月から変えると、今の値はそのまま「予定」として見える", async ({ page }) => {
  await gotoPage(page, "/masters");
  const g = page.locator('tr.yn-me-group[data-group="M011"]');
  await g.getByRole("button", { name: /小林 玲奈 の変更を追加/ }).click();
  const d = dialog(page);
  await expect(d.locator("#yn-me-dialog-title")).toContainText("小林 玲奈 の変更を追加");
  await expect(d.locator("#yn-me-f-effective_from")).toHaveValue("2026-11");
  await d.locator("#yn-me-f-title").fill("課長");
  await d.locator('[data-role="submit"]').click();
  await expect(d).toHaveCount(0);
  await expect(g).toContainText("予定 1");
  await expect(g).toContainText("2026年11月〜 課長");
  const hist = page.locator('tr.yn-me-hist[data-parent="M011"]');
  // 2025-04 登録・2026-07 主任・2026-11 課長（予定）
  await expect(hist).toHaveCount(3);
  await expect(hist.last()).toContainText("2026-11 から");
  await expect(hist.last()).toContainText("予定");
  await expect(hist.last()).toContainText("主任 → 課長");
});

for (const [w, theme] of [[1280, "light"], [768, "dark"], [390, "dark"]] as const) {
  test(`開いた案件・履歴・＋ 変更のダイアログが横にはみ出さない（${w}px ${theme}）`, async ({ page }) => {
    if (theme === "dark") await useDarkTheme(page);
    await page.setViewportSize({ width: w, height: 860 });
    await gotoPage(page, "/plan?team=T111");
    const sub = await subRow(page, "M010", "倉庫管理");
    await historyOf(page, sub);
    await historyOf(page, await subRow(page, "M010", "outside"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await sub.getByRole("button", { name: /人月を、ある月から変える/ }).click();
    const box = (await dialog(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(w);
    await expect(dialog(page).getByRole("button", { name: "反映" })).toBeInViewport();
  });
}

test("名前・所属・案件で人を絞り込める（数百人の組織で探す）。合計は絞り込んだ人の分", async ({ page }) => {
  await gotoPage(page, "/plan");
  const rows = page.locator("tr.yn-me-plan-row");
  const all = await rows.count();
  expect(all).toBeGreaterThan(5);
  const q = page.getByRole("searchbox", { name: /リソース計画の人を/ });
  await q.fill("小林");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("小林 玲奈");
  await expect(page.locator(".yn-me-plan-filter .yn-table-count")).toContainText(`1 / ${all} 人`);
  await expect(page.locator("tfoot")).toContainText("合計（1人）");
  // 入力中もフォーカスは検索欄のまま
  await expect(q).toBeFocused();
  // 案件名・所属でも引ける（空白区切りはすべて含む）
  await q.fill("インフラ 倉庫管理");
  await expect(rows.first()).toContainText("インフラ保守チーム");
  await q.fill("該当なしの語");
  await expect(rows).toHaveCount(0);
  await expect(page.locator(".yn-me-plan .yn-table-empty")).toContainText("条件に合う人がいません");
  await q.fill("");
  await expect(rows).toHaveCount(all);
});
