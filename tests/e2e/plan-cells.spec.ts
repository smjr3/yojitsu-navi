/**
 * 稼働計画のセル（SPEC §31.4・§36: 人の行は保守の配分＋契約外予定の合計）・案件で選ぶアサイン（§31.3）・候補から選ぶ入力欄（§31.2）・ID を出さない表示（§31.1）
 */
import type { Page } from "@playwright/test";
import { test, expect, gotoPage, pickCombo, useDarkTheme } from "./helpers/app.js";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("yn-e2e-keep-draft") !== "1") localStorage.removeItem("yojitsu-navi:masters-draft:v1");
    sessionStorage.removeItem("yojitsu-navi:masters-draft-session");
    sessionStorage.removeItem("yojitsu-navi:plan-cell-scope");
  });
});

const cell = (page: Page, member: string, month: string) => page.locator(`[data-fk="plan:cell:${member}:all:${month}"]`);
const pop = (page: Page) => page.locator("dialog.yn-plan-pop[open]");

test("行は 1 行に詰め、ID は出さない（名前と所属だけ）", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  const row = page.locator('tr.yn-me-plan-row[data-member="M010"]');
  await expect(row.locator("th")).toContainText("中村 拓也");
  await expect(row.locator("th")).toContainText("インフラ保守チーム");
  await expect(row.locator("th")).not.toContainText("M010");
  const box = await row.boundingBox();
  expect(box!.height).toBeLessThanOrEqual(40);
});

test("セルにマウスを載せると内訳の吹き出し、フォーカスでも出る", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  await cell(page, "M010", "2026-10").hover();
  const tip = page.locator("#yn-plan-tip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("2026年10月 合計 0.90 人月（144 時間）");
  await expect(tip).toContainText("青葉物流 / 倉庫管理システム保守");
  await expect(tip).toContainText("空き 0.10 人月");
  await expect(tip).not.toContainText("C002");
  // 契約外予定のある月: 内訳に契約外予定、合計が 1.0 を超えると超過
  await cell(page, "M010", "2026-12").hover();
  await expect(tip).toContainText("2026年12月 合計 1.10 人月");
  await expect(tip).toContainText("運用保守以外: 提案");
  await expect(tip).toContainText("1.0 人月を 0.10 超えています");
  await page.mouse.move(0, 0);
  await expect(tip).toBeHidden();
  await cell(page, "M010", "2027-01").focus();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("2027年1月");
});

test("クリックで修正: この月だけ変えると行を月で分け、元の値に戻すと 1 行に戻る", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  await cell(page, "M010", "2026-12").click();
  const p = pop(page);
  await expect(p).toBeVisible();
  await expect(p.locator("#yn-plan-pop-0")).toBeFocused();
  await expect(p.locator("#yn-plan-pop-0")).toHaveValue("0.9");
  await page.keyboard.type("0.5");
  await page.keyboard.press("Enter");
  await expect(p).toHaveCount(0);
  // 人の行は保守 0.5 ＋ 契約外予定 0.2
  await expect(cell(page, "M010", "2026-12")).toHaveText("0.70");
  await expect(cell(page, "M010", "2026-11")).toHaveText("1.10");
  await expect(cell(page, "M010", "2027-01")).toHaveText("1.10");
  // フォーカスは修正したセルへ戻る
  await expect(cell(page, "M010", "2026-12")).toBeFocused();
  // 案件の行は 1 行のまま。変更の履歴が 3 件（4月〜 0.9・12月 0.5 に変更・1月〜 0.9 に変更）
  await page.locator('[data-fk="plan:toggle:M010"]').click();
  const subs = page.locator('tr.yn-me-plan-sub.is-project[data-member="M010"]');
  await expect(subs).toHaveCount(1);
  await subs.locator('[data-fk^="plan:hist:"]').click();
  const entries = page.locator("tr.yn-me-plan-hist li.yn-me-plan-entry[data-key]");
  await expect(entries).toHaveCount(3);
  await expect(entries.nth(1)).toContainText("0.90 → 0.50 人月に変更");
  await expect(entries.nth(2)).toContainText("0.50 → 0.90 人月に変更");
  // 元に戻す → 1 件・変更なし
  await cell(page, "M010", "2026-12").click();
  await p.locator("#yn-plan-pop-0").fill("0.9");
  await p.locator("#yn-plan-pop-0").press("Enter");
  await expect(entries).toHaveCount(1);
  await expect(page.locator(".yn-me-diff-slot")).toContainText("変更はありません");
});

test("この月以降: 以降の月をまとめて変える。選んだ範囲は次も覚えている", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  await cell(page, "M011", "2027-01").click();
  const p = pop(page);
  await p.getByLabel("この月以降").check();
  await expect(p.locator(".yn-plan-pop-after")).toBeVisible();
  await p.locator("#yn-plan-pop-0").fill("0.6");
  await p.getByRole("button", { name: "反映" }).click();
  await expect(cell(page, "M011", "2026-12")).toHaveText("0.90");
  for (const m of ["2027-01", "2027-02", "2027-03"]) await expect(cell(page, "M011", m)).toHaveText("0.60");
  await cell(page, "M011", "2026-11").click();
  await expect(p.getByLabel("この月以降")).toBeChecked();
  await p.locator("#yn-plan-pop-0").press("Escape");
  await expect(p).toHaveCount(0);
});

test("空のセルから案件を候補で選んで追加（0 で外す、数値でなければ案内）", async ({ page }) => {
  await gotoPage(page, "/plan?team=S11");
  await cell(page, "M004", "2026-12").click();
  const p = pop(page);
  // 案件を選ばずに人月だけ → 案内
  await p.locator("#yn-plan-pop-new").fill("0.2");
  await p.getByRole("button", { name: "反映" }).click();
  await expect(p.locator(".yn-me-form-msg")).toContainText("案件を選んでください");
  // 数値でない → 案内
  await p.locator("#yn-plan-pop-new").fill("abc");
  await p.getByRole("button", { name: "反映" }).click();
  await expect(p.locator(".yn-me-form-msg")).toContainText("数値");
  await pickCombo(p.locator("#yn-plan-pop-project"), "ひまわり");
  await expect(p.locator("#yn-plan-pop-project")).toHaveValue("受発注システム保守");
  await p.locator("#yn-plan-pop-new").fill("0.2");
  await p.locator("#yn-plan-pop-new").press("Enter");
  await expect(p).toHaveCount(0);
  await expect(cell(page, "M004", "2026-12")).toHaveText("0.60");
  await expect(cell(page, "M004", "2027-01")).toHaveText("0.40");
  await expect(page.locator(".yn-me-diff-slot")).toContainText("ひまわり食品 / 受発注システム保守 ・ 2026-12 ・ 2026-12 ・ 0.2");
  // 0 にすると外れる
  await cell(page, "M004", "2026-12").click();
  const inputs = p.locator(".yn-plan-pop-rows input");
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    if ((await inputs.nth(i).getAttribute("aria-label"))?.includes("受発注")) await inputs.nth(i).fill("0");
  }
  await p.getByRole("button", { name: "反映" }).click();
  await expect(cell(page, "M004", "2026-12")).toHaveText("0.40");
  await expect(page.locator(".yn-me-diff-slot")).toContainText("変更はありません");
});

test("過去の月を変えるときは影響の注記を出し、もう一度押して確定", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  await cell(page, "M012", "2026-06").click();
  const p = pop(page);
  await p.locator("#yn-plan-pop-0").fill("0.5");
  await p.locator("#yn-plan-pop-0").press("Enter");
  await expect(p.locator(".yn-me-impact")).toContainText("1 か月");
  await expect(cell(page, "M012", "2026-06")).toHaveText("0.90");
  await p.getByRole("button", { name: /過去 1 か月にも反映/ }).click();
  await expect(p).toHaveCount(0);
  await expect(cell(page, "M012", "2026-06")).toHaveText("0.50");
});

test("キーボード: 矢印でセルを移動、Enter で開いて Esc で閉じる（変更は捨てる）", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  await cell(page, "M010", "2026-04").focus();
  await page.keyboard.press("ArrowRight");
  await expect(cell(page, "M010", "2026-05")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(cell(page, "M011", "2026-05")).toBeFocused();
  await page.keyboard.press("Enter");
  const p = pop(page);
  await expect(p).toBeVisible();
  await page.keyboard.type("0.1");
  await page.keyboard.press("Escape");
  await expect(p).toHaveCount(0);
  await expect(cell(page, "M011", "2026-05")).toHaveText("0.90");
  await expect(cell(page, "M011", "2026-05")).toBeFocused();
});

test("スマホ幅（390）・ダーク: 編集欄は画面下のシートで、はみ出さない", async ({ page }) => {
  await useDarkTheme(page);
  await page.setViewportSize({ width: 390, height: 780 });
  await gotoPage(page, "/plan?team=T111");
  await cell(page, "M010", "2026-12").scrollIntoViewIfNeeded();
  await cell(page, "M010", "2026-12").click();
  const p = pop(page);
  const box = (await p.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(780);
  await pickCombo(p.locator("#yn-plan-pop-project"), "倉庫");
  await p.getByRole("button", { name: "キャンセル" }).click();
  await expect(p).toHaveCount(0);
  const hscroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(hscroll).toBe(false);
});

test("アサインの追加: 案件を選び、期間が契約の切り替わりをまたぐと 2 行に分けて保存", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  await page.getByRole("button", { name: "＋ 計画を追加", exact: true }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  await pickCombo(d.locator("#yn-me-f-member_id"), "インフラ 小林");
  await expect(d.locator("#yn-me-f-member_id")).toHaveValue("小林 玲奈");
  await pickCombo(d.locator("#yn-me-f-contract_id"), "青葉");
  await d.locator("#yn-me-f-start_month").fill("2026-01");
  await d.locator("#yn-me-f-end_month").fill("2026-06");
  await d.locator("#yn-me-f-allocation").fill("0.05");
  await d.locator('[data-role="submit"]').click();
  await expect(d.locator(".yn-me-split")).toContainText("2 行に分けて保存します: 2026-01〜2026-03、2026-04〜2026-06");
  await d.locator('[data-role="submit"]').click();
  await expect(d).toHaveCount(0);
  const diff = page.locator(".yn-me-diff-table");
  await expect(diff).toContainText("小林 玲奈 ・ 青葉物流 / 倉庫管理システム保守 ・ 2026-01 ・ 2026-03 ・ 0.05");
  await expect(diff).toContainText("小林 玲奈 ・ 青葉物流 / 倉庫管理システム保守 ・ 2026-04 ・ 2026-06 ・ 0.05");
  // 案件の行は 1 行のまま（契約が 2 つでも案件でまとめる）。4〜6 月は 0.95
  const sub = page.locator('tr.yn-me-plan-sub.is-project[data-member="M011"]');
  await expect(sub).toHaveCount(1);
  await expect(sub).toContainText("追加");
  await expect(cell(page, "M011", "2026-06")).toHaveText("0.95");
  await expect(page.locator("table.yn-me-table tbody")).not.toContainText("C001");
});

test("候補の入力欄: 打った文字で絞り込み、候補に無い文字は元の値に戻す。Esc は候補だけ閉じる", async ({ page }) => {
  await gotoPage(page, "/plan");
  await page.getByRole("button", { name: "＋ 計画を追加", exact: true }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  const input = d.locator("#yn-me-f-member_id");
  await input.click();
  await input.fill("クラウド");
  const list = page.locator("#yn-me-f-member_id-listbox");
  // 所属に「クラウド」を含む人だけ（所属で引ける。5 倍データでは公共クラウド運用チームなども当たる）。ID は出さない
  const options = list.locator('[role="option"]');
  await expect(options.first()).toBeVisible();
  for (const t of await options.allTextContents()) expect(t).toContain("クラウド");
  expect((await options.allTextContents()).some((t) => t.includes("クラウド運用チーム"))).toBe(true);
  await expect(list).not.toContainText("M02");
  // ↓ で移動して Enter（森 大翔まで）
  const names = (await options.allTextContents()).map((t) => t.split("クラウド")[0]!.trim());
  const idx = names.indexOf("森 大翔");
  expect(idx).toBeGreaterThanOrEqual(0);
  for (let i = 0; i < idx; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(input).toHaveValue("森 大翔");
  await input.fill("存在しない人");
  await expect(list).toContainText("一致する候補がありません");
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(d).toBeVisible();
  await expect(input).toHaveValue("森 大翔");
  await expect(d.locator('input[name="member_id"]')).toHaveValue("M022");
});

test("ID を前面に出さない: メンバー一覧・案件一覧・案件詳細・メンバー詳細", async ({ page }) => {
  await gotoPage(page, "/members");
  await expect(page.locator("table.yn-table tbody")).toContainText("小林 玲奈");
  await expect(page.locator("table.yn-table tbody")).not.toContainText("M011");
  await gotoPage(page, "/contracts");
  await expect(page.locator("table.yn-table tbody")).not.toContainText(/C0\d\d/);
  await gotoPage(page, "/contract?id=C002");
  await expect(page.locator("h1")).toHaveText("青葉物流 / 倉庫管理システム保守");
  await gotoPage(page, "/member?id=M011");
  await expect(page.locator("h1")).toHaveText("小林 玲奈");
  await gotoPage(page, "/team?id=T111");
  await expect(page.locator("h1")).toHaveText("インフラ保守チーム");
});

test("パートナーの会社名は出さない", async ({ page }) => {
  await gotoPage(page, "/members");
  await expect(page.locator("table.yn-table tbody")).toContainText("岡田 浩二");
  await expect(page.locator("table.yn-table tbody")).not.toContainText("（テクノブリッジ）");
});

for (const width of [1280, 1024, 768, 390]) {
  test(`期間フィルタ: 見出しと選択欄・ボタンの高さの中心が揃う（${width}px）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await gotoPage(page, "/");
    const center = async (sel: string) => {
      const b = (await page.locator(sel).first().boundingBox())!;
      return b.y + b.height / 2;
    };
    const legend = await center(".yn-filter-period legend");
    expect(Math.abs(legend - (await center("#yn-filter-from")))).toBeLessThanOrEqual(1.5);
    // 同じ行に並ぶもの（狭い幅では折り返す）は中心が揃う
    for (const sel of [".yn-filter-period .yn-seg", "#yn-filter-team"]) {
      const c = await center(sel);
      if (Math.abs(c - legend) < 16) expect(Math.abs(c - legend), sel).toBeLessThanOrEqual(1.5);
    }
  });
}

test("下書きの復元待ちのあいだは、セルをクリックしても内訳を見せるだけ（編集欄は開かない）", async ({ page }) => {
  await gotoPage(page, "/plan?team=T111");
  await cell(page, "M010", "2027-02").click();
  await pop(page).locator("#yn-plan-pop-0").fill("0.4");
  await pop(page).locator("#yn-plan-pop-0").press("Enter");
  await expect(cell(page, "M010", "2027-02")).toHaveText("0.40");
  // 下書きが残った状態で開き直す（beforeEach の削除は最初の読み込みだけに効かせる）
  await page.evaluate(() => sessionStorage.setItem("yn-e2e-keep-draft", "1"));
  await page.reload();
  await expect(page.locator("#yn-me-draft-title")).toBeVisible();
  await cell(page, "M010", "2027-02").click();
  await expect(page.locator("#yn-plan-tip")).toBeVisible();
  await expect(page.locator("#yn-plan-tip")).not.toContainText("クリックで修正");
  await expect(pop(page)).toHaveCount(0);
});

test("修正欄を開いたまま画面を狭く・広くしても、画面の中に収まり操作できる", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoPage(page, "/plan?team=T111");
  await cell(page, "M010", "2027-02").click();
  const p = pop(page);
  await expect(p).toBeVisible();
  const inView = async () => {
    const r = (await p.boundingBox())!;
    const vp = page.viewportSize()!;
    return r.x >= -1 && r.x + r.width <= vp.width + 1;
  };
  for (const size of [{ width: 368, height: 944 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await expect.poll(inView).toBe(true);
    await expect(p.locator(".yn-combo-toggle")).toBeInViewport();
  }
  await p.locator(".yn-combo-toggle").click();
  await expect(p.locator("[role=listbox]")).toBeVisible();
});
