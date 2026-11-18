/**
 * 目標（SPEC §63）
 * - チーム・顧客・案件の詳細に「目標」の表（core の evaluateTarget と一致）。目標の無い対象には出さない
 * - 一覧の「目標」列（基準月以降で最も近い終了月の目標）と、ノート PC 幅で横スクロールにならないこと
 * - マスタ編集の「目標」タブ: 追加（対象をチーム・顧客・案件から選ぶ）・修正・削除・検証エラー・ダウンロード
 * - 390px・ダークで横スクロール無し
 */
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme, pickCombo } from "./helpers/app.js";
import { getModel } from "./helpers/core.js";
import { ROOT_DIR } from "./constants.js";
import { buildMastersPayload } from "../../src/data/_masters.js";
import { addRow, parseMasterDoc, serializeMasterDoc, stampChangedRows } from "../../src/core/masterEdit.js";
import { evaluateTarget, targetsOf, formatPercent } from "../../src/core/index.js";

const model = getModel();
const TARGETS_TEXT = buildMastersPayload(ROOT_DIR).files.targets.text;
const STATUS = { achieved: "達成", missed: "未達", onTrack: "達成見込み", atRisk: "未達見込み", noBudget: "予算なし" } as const;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem("yojitsu-navi:masters-draft:v1");
    sessionStorage.removeItem("yojitsu-navi:masters-draft-session");
  });
});

/** 詳細の「目標」の表の行（終了月の順）が core と一致する */
async function expectTargetTable(page: Page, kind: "team" | "customer" | "project", id: string): Promise<void> {
  const list = targetsOf(model, kind, id).map((t) => evaluateTarget(model, t, "assignment"));
  expect(list.length).toBeGreaterThan(0);
  const rows = page.locator(".yn-targets-table tbody tr");
  await expect(rows).toHaveCount(list.length);
  for (const [i, ev] of list.entries()) {
    await expect(rows.nth(i)).toContainText(formatPercent(ev.rate));
    await expect(rows.nth(i).locator(".yn-chip")).toHaveText(new RegExp(`${STATUS[ev.status]}$`));
  }
}

test("チーム詳細: 終了月の違う目標を終了月の順に、確定（実績）と見込みを分けて出す。残予算率を押すと計算根拠", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/team?id=T111");
  await expect(page.getByRole("heading", { name: "目標" })).toBeVisible();
  await expectTargetTable(page, "team", "T111");
  const rows = page.locator(".yn-targets-table tbody tr");
  await expect(rows.nth(0)).toContainText("実績");
  await expect(rows.nth(0)).toContainText("未達");
  await expect(rows.nth(1)).toContainText("見込み");
  await rows.nth(1).locator("button.yn-num").click();
  const d = page.locator("dialog[open]");
  await expect(d).toContainText("残予算率 = (予算 − 着地) ÷ 予算");
  await expect(d).toContainText("対象の案件 1件");
});

test("顧客詳細・案件詳細にも目標。目標の無い対象には表を出さない", async ({ page }) => {
  await gotoPage(page, `/customer?key=${encodeURIComponent("こもれび出版")}`);
  await expectTargetTable(page, "customer", "こもれび出版");
  await expect(page.locator(".yn-targets-table .yn-chip-danger")).toHaveCount(1);
  await gotoPage(page, "/contract?id=C007");
  await expectTargetTable(page, "project", "C007");
  // 開始月が契約開始（年度をまたぐ）
  await expect(page.locator(".yn-targets-table")).toContainText("2025年4月〜2027年3月");
  await gotoPage(page, "/team?id=T112");
  await expect(page.locator(".yn-targets")).toHaveCount(0);
});

test("一覧の「目標」列: チーム・顧客・案件。目標の無い行は —。1280 幅で横スクロールしない、1024 幅では列を隠す", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const [path, label] of [["/teams", "第1事業部"], ["/customers", "こもれび出版"], ["/contracts", "クラウド基盤運用"]] as const) {
    await gotoPage(page, path);
    const th = page.locator('.yn-table th[data-key="target"]');
    await expect(th).toHaveText(/目標/);
    const row = page.locator(".yn-table tbody tr", { hasText: label }).first();
    await expect(row.locator(".yn-target-cell")).toBeVisible();
    const over = await page.locator(".yn-table-wrap").first().evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(over, path).toBeLessThanOrEqual(1);
  }
  // 1024px 幅では「目標」列を隠して横スクロールを避ける（チーム詳細の表も同じ列）
  await page.setViewportSize({ width: 1024, height: 900 });
  for (const path of ["/customers", "/team?id=HQ"]) {
    await gotoPage(page, path);
    await expect(page.locator('.yn-table th[data-key="target"]').first()).toBeHidden();
    for (const wrap of await page.locator(".yn-table-wrap:has(th[data-key=\"target\"])").all()) {
      expect(await wrap.evaluate((el) => el.scrollWidth - el.clientWidth), path).toBeLessThanOrEqual(1);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoPage(page, "/team?id=D1");
  await expect(page.locator('.yn-table th[data-key="target"]')).toHaveCount(2);
  await gotoPage(page, "/teams");
  await expect(page.locator(".yn-table tbody tr", { hasText: "ネットワーク保守チーム" }).locator('td:has-text("—")').first()).toBeVisible();
});

test("マスタ編集「目標」: 対象を検索して追加 → 一覧に名前で出る → ダウンロードした CSV は元 + 1 行。修正・削除もできる", async ({ page }) => {
  await gotoPage(page, "/masters?view=targets");
  await expect(page.getByRole("tab", { name: /目標/ })).toHaveAttribute("aria-selected", "true");
  const rows = page.locator("table.yn-me-table tbody tr.yn-me-group");
  const before = parseMasterDoc("targets", TARGETS_TEXT).rows.length;
  await expect(rows).toHaveCount(before);
  // 誰がいつ入れたか（§56 と同じ記録。ダミーは全行に例がある）。変更者は氏名で（§117）
  await expect(rows.first().locator('[data-role="stamp"]')).toHaveText(/^\d{4}-\d{2}-\d{2}・(佐藤 健一|鈴木 美咲|高橋 大輔)$/);
  await page.getByRole("button", { name: "＋ 新しい目標" }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  // 対象の種類は対象の欄でまとめて選ぶ（別の欄は無い）
  await expect(d.locator("#yn-me-f-target_type")).toHaveCount(0);
  await pickCombo(d.locator("#yn-me-f-target_id"), "ネットワーク", /ネットワーク保守チーム/);
  await d.locator("#yn-me-f-end_month").fill("2027-03");
  await expect(d.locator("#yn-me-f-end_month-hint")).toContainText("この月までの累計で判定します");
  await d.locator("#yn-me-f-remaining_rate").fill("18");
  await d.locator('[data-role="submit"]').click();
  await expect(d).toHaveCount(0);
  await expect(rows).toHaveCount(before + 1);
  // 足した行は同じ種類（組織）の目標の後ろに入る（§120.1）
  const added = rows.filter({ hasText: "追加" });
  await expect(added).toHaveCount(1);
  await expect(added).toContainText("ネットワーク保守チーム");
  await expect(added).toContainText("18%");
  await expect(added).toContainText("追加");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /targets\.csv をダウンロード/ }).click()]);
  const text = readFileSync((await dl.path())!, "utf-8");
  // 追加した行だけに変更日（ダウンロードでは変更者は空。§56）
  const today = await page.evaluate(() => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()));
  expect(text).toBe(serializeMasterDoc(stampChangedRows(addRow(parseMasterDoc("targets", TARGETS_TEXT), { target_type: "team", target_id: "T112", end_month: "2027-03", remaining_rate: "18", start_month: "", note: "" }).doc, "", today)).text);

  // 顧客に付け替えて修正 → 確認 → 反映
  await added.getByRole("button", { name: "修正" }).click();
  await pickCombo(d.locator("#yn-me-f-target_id"), "こもれび", /こもれび出版/);
  await d.locator('[data-role="submit"]').click();
  await expect(d).toContainText("対象の種類");
  await d.locator('[data-role="submit"]').click();
  await expect(added).toContainText("こもれび出版");
  await expect(added).toContainText("顧客");

  // 同じ対象・同じ終了月の重複は検証エラー（行に出る）
  await expect(page.locator(".yn-me-check")).toContainText("エラー");
  await expect(page.locator("tr.yn-me-issue-row").first()).toContainText("複数の行");

  // 削除すると元に戻る
  await added.getByRole("button", { name: "削除" }).click();
  await page.locator("dialog.yn-me-dialog[open]").locator('[data-role="confirm-delete"]').click();
  await expect(rows).toHaveCount(before);
  await expect(page.locator(".yn-me-check")).toContainText("エラーなし");
});

test("マスタ編集「目標」: 表に出る対象の名前（チーム名・案件名）で探せる", async ({ page }) => {
  await gotoPage(page, "/masters?view=targets");
  const rows = page.locator("table.yn-me-table tbody tr.yn-me-group");
  const q = page.locator("#yn-me-q-targets");
  await q.fill("インフラ保守チーム");
  await expect(rows).toHaveCount(targetsOf(model, "team", "T111").length);
  await q.fill("クラウド基盤運用");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("北斗建設");
});

test("マスタ編集「目標」: 対象・終了月・率の未入力は止め、100% 超はエラー", async ({ page }) => {
  await gotoPage(page, "/masters?view=targets");
  await page.getByRole("button", { name: "＋ 新しい目標" }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  await d.locator('[data-role="submit"]').click();
  await expect(d.locator(".yn-me-form-msg")).toContainText("対象");
  await expect(d.locator(".yn-me-form-msg")).toContainText("終了月");
  await pickCombo(d.locator("#yn-me-f-target_id"), "C002");
  await d.locator("#yn-me-f-end_month").fill("2027-02");
  await d.locator("#yn-me-f-remaining_rate").fill("150");
  await d.locator('[data-role="submit"]').click();
  await expect(d).toHaveCount(0);
  await expect(page.locator("tr.yn-me-issue-row").first()).toContainText("100 以下");
  await expect(page.locator(".yn-me-check")).toContainText("エラー");
});

test("マイナスの目標（超過を減らす）: 案件詳細に -50% の目標と判定。▲50 も入力できる", async ({ page }) => {
  await gotoPage(page, "/contract?id=C117");
  await expectTargetTable(page, "project", "C117");
  await expect(page.locator(".yn-targets-table")).toContainText("-50%");
  const ev = evaluateTarget(model, targetsOf(model, "project", "C117")[0]!, "assignment");
  expect(ev.target.remainingRate).toBe(-0.5);
  expect(ev.status).toBe("atRisk");
  await gotoPage(page, "/contract?id=C143");
  await expect(page.locator(".yn-targets-table .yn-chip")).toHaveText(/達成見込み$/);

  await gotoPage(page, "/masters?view=targets");
  await page.getByRole("button", { name: "＋ 新しい目標" }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  await pickCombo(d.locator("#yn-me-f-target_id"), "C013");
  await d.locator("#yn-me-f-end_month").fill("2027-03");
  await d.locator("#yn-me-f-remaining_rate").fill("▲50");
  await d.locator('[data-role="submit"]').click();
  await expect(d).toHaveCount(0);
  await expect(page.locator(".yn-me-check")).toContainText("エラーなし");
});

test("390px・ダーク: 詳細の目標・マスタ編集の目標タブで横スクロールしない", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useDarkTheme(page);
  for (const path of ["/team?id=T111", `/customer?key=${encodeURIComponent("こもれび出版")}`, "/contract?id=C007", "/masters?view=targets"]) {
    await gotoPage(page, path);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(over, path).toBeLessThanOrEqual(0);
  }
  // 状況のチップが表からはみ出さない（列を隠して収める）
  await gotoPage(page, "/team?id=T111");
  await page.locator(".yn-targets-table").scrollIntoViewIfNeeded();
  for (const chip of await page.locator(".yn-targets-table .yn-chip").all()) await expect(chip).toBeInViewport({ ratio: 1 });
});
