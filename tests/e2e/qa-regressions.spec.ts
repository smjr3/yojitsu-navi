/**
 * 実操作 QA で見つかった不具合の再発防止
 * - URL の team にプロトタイプのキー（constructor 等）を入れても例外にならず、全体に戻る
 * - 1024px 未満でも上部タブがすべて見える（2 段目に回る）。1024px 以上はヘッダーが 1 段（単位のボタンも折り返さない）
 * - 並べ替えは絞り込み・単位の変更や「戻る」で既定に戻らない。絞り込み・検索は「戻る」で復元される
 * - 案件詳細の ID は前後の空白・大文字小文字の違いを許す
 * - 最終 QA（2026-10-29）: 「戻る」でスクロール位置を戻す、「＋ 変更」で ID を変えさせない、色付きの値の読み上げ名、
 *   スマホ幅の計算根拠の長い案件名、Excel の見出しの重複、計画も実績も無いメンバーの差額の文
 */
import { createRequire } from "node:module";
import { test, expect, gotoPage, kpiValue } from "./helpers/app.js";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx") as typeof import("xlsx");

for (const team of ["constructor", "__proto__", "toString"]) {
  test(`team=${team} は未知のチームとして全体に戻る`, async ({ page }) => {
    await gotoPage(page, `/?team=${team}`);
    await expect(kpiValue(page, 0)).not.toHaveText(/^0\.0/);
    expect(new URL(page.url()).searchParams.get("team")).toBe("");
    await gotoPage(page, "/contracts");
    expect(await page.locator("table tbody tr[data-key]").count()).toBeGreaterThan(0);
  });
}

for (const width of [768, 900, 1000]) {
  test(`${width}px 幅で上部タブがすべて見える`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await gotoPage(page, "/contracts");
    const visible = await page.evaluate(() => {
      const nav = document.querySelector(".yn-tabs")!.getBoundingClientRect();
      return [...document.querySelectorAll(".yn-tab")].every((t) => {
        const r = t.getBoundingClientRect();
        return r.left >= nav.left - 1 && r.right <= nav.right + 1;
      });
    });
    expect(visible).toBe(true);
  });
}

test("1024px 幅ではヘッダーが 1 段（タブ・単位・右上のリンク）で、単位のボタンも折り返さない", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await gotoPage(page, "/");
  const centers = await page.evaluate(() =>
    [".yn-brand", ".yn-tabs", ".yn-unit-slot .yn-seg", ".yn-tools"].map((s) => {
      const r = document.querySelector(s)!.getBoundingClientRect();
      return Math.round((r.top + r.bottom) / 2);
    }),
  );
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(4);
  const unitTops = await page.locator(".yn-unit-slot .yn-seg-btn").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(unitTops).size).toBe(1);
});

test("案件一覧: 並べ替え・絞り込み・検索が、絞り込み変更と詳細からの「戻る」で保たれる", async ({ page }) => {
  await gotoPage(page, "/contracts");
  const sortTh = page.locator('th[data-key="grossMargin"]');
  await sortTh.locator("button.yn-sort").click();
  const dir = await sortTh.getAttribute("aria-sort");
  await page.locator('label[for="yn-f-prelim"]').click();
  await expect(page.locator('th[data-key="grossMargin"]')).toHaveAttribute("aria-sort", dir!);
  await page.fill("#yn-f-text", "保守");
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("保守");
  expect(new URL(page.url()).searchParams.get("f")).toBe("prelim");
  const count = await page.locator("table tbody tr[data-key]").count();
  await page.locator(".yn-row-link").first().click();
  await expect(page).toHaveURL(/\/contract\?/);
  await page.goBack();
  await expect(page.locator("#yn-f-text")).toHaveValue("保守");
  await expect(page.locator("#yn-f-prelim")).toBeChecked();
  await expect(page.locator('th[data-key="grossMargin"]')).toHaveAttribute("aria-sort", dir!);
  await expect(page.locator("table tbody tr[data-key]")).toHaveCount(count);
});

test("案件詳細: ID の前後の空白と大文字小文字の違いを許す", async ({ page }) => {
  await gotoPage(page, "/contract?id=c008%20");
  await expect(page.locator("h1")).toHaveText("こもれび出版 / 会員サイト保守");
  await expect(page.getByText("見つかりません")).toHaveCount(0);
});

test("スマホ幅ではヘッダを固定しない（画面の 1/4 を占めない）。PC 幅では固定する", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoPage(page, "/contracts");
  await page.mouse.wheel(0, 1500);
  await expect.poll(() => page.evaluate(() => document.querySelector("#observablehq-header")!.getBoundingClientRect().bottom)).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.mouse.wheel(0, 300);
  await expect.poll(() => page.evaluate(() => document.querySelector("#observablehq-header")!.getBoundingClientRect().top)).toBe(0);
});

test("「速報含む」のアイコンはフォントに頼らず円で描く", async ({ page }) => {
  await gotoPage(page, "/contracts");
  const icon = page.locator(".yn-icon-prelim").first();
  await expect(icon).toBeVisible();
  const box = (await icon.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(10);
  expect(box.height).toBeGreaterThanOrEqual(10);
});

test("スマホ幅のマスタ編集: 行を追加して表が右へスクロールしても、行のエラー文が見える", async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("yojitsu-navi:masters-draft:v1"));
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoPage(page, "/masters");
  await page.getByRole("tab", { name: /組織/ }).click();
  await page.locator('button[data-fk="add:teams"]').click();
  const dlg = page.locator("dialog[open]");
  // 親組織に自分自身を指す ID を入れてエラーの行を作る（リーダー・親組織は候補から選ぶ欄なので、存在しない値は ID 欄で作る）
  await dlg.locator('[name="team_id"]').fill("NOPE");
  await dlg.locator('[name="name"]').fill("自分が親");
  await dlg.locator('[name="parent_team_id"]').evaluate((el: HTMLSelectElement) => {
    el.append(new Option("NOPE", "NOPE", true, true));
  });
  await dlg.locator('[data-role="submit"]').click();
  if (await page.locator("dialog[open] .yn-me-confirm").isVisible().catch(() => false)) await page.locator('dialog[open] [data-role="submit"]').click();
  const ul = page.locator(".yn-me-issue-row .yn-me-issues").first();
  await expect(ul).toContainText("NOPE");
  await page.locator(".yn-me-issue-row").first().evaluate((tr) => tr.closest(".yn-table-wrap")!.scrollTo({ left: 10000 }));
  const box = (await ul.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
});

test("リソース計画のセルの編集欄を開いたまま狭い画面に変えても、画面内に収まり操作できる（モンキーテストで発見）", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  await page.locator('tr.yn-me-plan-row[data-member="M010"] [data-fk="plan:cell:M010:all:2027-01"]').click();
  const pop = page.locator("dialog.yn-plan-pop[open]");
  await expect(pop).toBeVisible();
  for (const width of [414, 1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(async () => {
      const box = (await pop.boundingBox())!;
      return box.x >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= 801;
    }, { message: `${width}px` }).toBe(true);
  }
  await pop.locator("#yn-plan-pop-new").click();
  await expect(pop.locator("#yn-plan-pop-new")).toBeFocused();
});

test("リソース計画のセルの編集欄を開いたまま画面の高さを縮めても、ボタンが画面内に残る（モンキーテストで発見）", async ({ page }) => {
  await page.setViewportSize({ width: 828, height: 985 });
  await gotoPage(page, "/plan?team=T111");
  const btn = page.locator('[data-fk="plan:cell:M010:all:2027-01"]');
  await btn.scrollIntoViewIfNeeded();
  // セルが画面の下の方にある状態で開く
  await page.evaluate(() => window.scrollBy(0, -200));
  await btn.click();
  const pop = page.locator("dialog.yn-plan-pop[open]");
  await expect(pop).toBeVisible();
  for (const height of [626, 480, 985]) {
    await page.setViewportSize({ width: 828, height });
    // 置き直しは resize イベントの後（次のフレーム）なので、収まるまで待つ
    await expect.poll(async () => {
      const box = (await pop.boundingBox())!;
      return box.y >= 0 && box.y + box.height <= height + 1;
    }, { message: `${height}px` }).toBe(true);
  }
  await expect(pop.getByRole("button", { name: "反映" })).toBeInViewport();
});

// ---- リリース前の最終 QA（2026-10-29） ---------------------------------------------

test("一覧を下までスクロールして詳細を開き「戻る」と、元のスクロール位置に戻る", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoPage(page, "/contracts");
  await page.evaluate(() => scrollTo(0, 1500));
  await expect.poll(() => page.evaluate(() => Math.round(scrollY))).toBeGreaterThan(1400);
  const before = await page.evaluate(() => Math.round(scrollY));
  // 見えている行の案件を開く
  const link = page.locator(".yn-row-link").nth(20);
  // クリック前に要素へスクロールさせない（今の位置のまま離れる）
  await link.evaluate((a) => (a as HTMLAnchorElement).click());
  await expect(page).toHaveURL(/\/contract\?/);
  await page.goBack();
  await expect(page.locator("table tbody tr[data-key]").first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => Math.round(scrollY)), { timeout: 10_000 }).toBeGreaterThan(before - 50);
});

test("マスタ編集の「＋ 変更」では対象の ID を変えられない（変えると別人の行になるため）", async ({ page }) => {
  await gotoPage(page, "/masters");
  await page.getByRole("button", { name: /^佐藤 健一 の変更を追加/ }).first().click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  await expect(d.locator("#yn-me-f-member_id")).toBeDisabled();
  await expect(d.locator("#yn-me-f-member_id-hint")).toHaveText("変更の追加では変えられません");
  // 所属チームは名前で選ぶ欄なので「英数字の ID」の注記は出さない
  await expect(d.locator("#yn-me-f-team_id-hint")).toHaveText("");
  await d.locator("#yn-me-f-title").selectOption("部長");
  await d.locator('[data-role="submit"]').click();
  if (await d.isVisible()) await d.locator('[data-role="submit"]').click();
  await expect(page.locator(".yn-me-diff-table")).toContainText("M001");
  await expect(page.locator(".yn-me-diff-table")).toContainText("部長");
});

test("色付きの値（消化率超過など）のボタンも、読み上げ名に値が入る", async ({ page }) => {
  await gotoPage(page, "/contracts");
  const labels = await page.locator('tbody td button[aria-label*="消化率"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
  expect(labels.length).toBeGreaterThan(0);
  for (const l of labels) expect(l).toMatch(/^消化率 -?[\d.,]+% の計算根拠を表示$|^消化率 — の計算根拠を表示$/);
});

test("スマホ幅の計算根拠: 長い案件名は折り返し、表の横幅を広げすぎない", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoPage(page, "/contract?id=C160");
  await page.locator('button[aria-label*="計算根拠"]').first().click();
  const cell = page.locator("dialog[open] .yn-bd-section table tbody td").first();
  await expect(cell).toBeVisible();
  const w = await cell.evaluate((td) => td.getBoundingClientRect().width);
  expect(w).toBeLessThan(260);
});

test("案件一覧の Excel: 見出しに同じ名前の列が無い（顧客 / 案件・顧客・案件）", async ({ page }) => {
  await gotoPage(page, "/contracts");
  const dl = page.waitForEvent("download");
  await page.locator(".yn-export").first().click();
  const d = await dl;
  const wb = XLSX.readFile((await d.path())!);
  const aoa = XLSX.utils.sheet_to_json<Array<string | number | null>>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, defval: null });
  const header = aoa.find((r) => r.includes("契約ID"))!;
  expect(header[0]).toBe("顧客 / 案件");
  expect(new Set(header).size).toBe(header.length);
});

test("計画も実績も無い期間のメンバーでは、差額に「計画どおり」と出さない", async ({ page }) => {
  // M122 は 2026-04 に退職（今年度は計画も実績も無い）
  await gotoPage(page, "/member?id=M122");
  const tile = page.locator(".yn-kpi").filter({ hasText: "差額" }).first();
  await expect(tile).toBeVisible();
  await expect(tile).not.toContainText("計画どおり");
});
