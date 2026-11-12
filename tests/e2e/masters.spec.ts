/**
 * マスタ編集 /masters（SPEC §19・§36 台帳）
 * - 台帳: 1 行 = 1 つの対象。開くと適用開始月ごとの変更の履歴（修正・元に戻す・削除）、「＋ 変更」で変更を追加
 * - download モード（既定の config.json）: 行の追加・修正・削除と確認、検証エラーで保存不可、差分、CSV の中身、下書き復元
 * - gitlab モード: masters.json を page.route で書き換えて有効にし、GitLab API を page.route でモック
 *   （mr / direct / 競合 / 403 / CORS 失敗 → download 切替）
 * - 社員番号・氏名は保存済みの行では読み取り専用（§81）。取り込みモード（memberSource.adapter != "none"）では columns に書いた列も読み取り専用
 * - a11y（タブのキーボード操作・ダイアログ・表の見出し）、ダーク、390px
 */
import { readFileSync } from "node:fs";
import type { Page, Request, Route } from "@playwright/test";
import { test, expect, useDarkTheme, gotoPage, type ErrorLog } from "./helpers/app.js";
import { ROOT_DIR } from "./constants.js";
import { buildMastersPayload } from "../../src/data/_masters.js";
import { MASTER_FILES, parseMasterDoc, serializeMasterDoc, addRow, deleteRow, updateRow } from "../../src/core/masterEdit.js";

const GITLAB = "https://gitlab.test/api/v4";
const PAYLOAD = buildMastersPayload(ROOT_DIR);
const RATES_TEXT = PAYLOAD.files.rates.text;
/** 元の単価に部長 14000（2026-11）を足した CSV（足した行は同じ部長の行のすぐ後ろ。§120.1） */
const RATES_WITH_BUCHO = serializeMasterDoc(addRow(parseMasterDoc("rates", RATES_TEXT), { key: "部長", hourly_rate: "14000", effective_from: "2026-11" }).doc).text;
const DRAFT_KEY = "yojitsu-navi:masters-draft:v1";

/** masters.json の中身を書き換える（gitlab モード・取り込みモードの再現） */
async function patchMasters(page: Page, patch: (p: typeof PAYLOAD) => unknown): Promise<void> {
  await page.route(/\/_file\/data\/masters\.[^/]*json/, async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    await route.fulfill({ response: res, body: JSON.stringify(patch(json)), headers: { ...res.headers(), "content-type": "application/json" } });
  });
}

function gitlabMode(commitMode: "mr" | "direct" = "mr") {
  return (p: typeof PAYLOAD) => ({ ...p, masterEdit: { mode: "gitlab", gitlab: { apiBaseUrl: GITLAB, projectId: "grp/yojitsu-navi", targetBranch: "main", commitMode } } });
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "content-type": "application/json" };

interface GitLabMock {
  calls: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }>;
}

/** GitLab API のモック。responder が null を返したら通信失敗（CORS/ネットワーク）にする */
async function mockGitLab(page: Page, responder: (req: Request) => { status: number; body: unknown } | null): Promise<GitLabMock> {
  const mock: GitLabMock = { calls: [] };
  await page.route(`${GITLAB}/**`, async (route: Route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    mock.calls.push({ method: req.method(), url: req.url(), headers: req.headers(), body: req.postData() ? JSON.parse(req.postData()!) : undefined });
    const r = responder(req);
    if (r === null) return route.abort("failed");
    return route.fulfill({ status: r.status, headers: CORS, body: JSON.stringify(r.body) });
  });
  return mock;
}

/** 想定どおりに失敗させた GitLab への通信は、エラー監視から外す */
function ignoreGitLabErrors(errors: ErrorLog): void {
  const keep = (s: string) => !s.includes("gitlab.test");
  errors.failedRequests.splice(0, errors.failedRequests.length, ...errors.failedRequests.filter(keep));
  errors.console.splice(0, errors.console.length, ...errors.console.filter(keep));
}

async function open(page: Page): Promise<void> {
  await gotoPage(page, "/masters");
  await expect(page.getByRole("tablist", { name: "編集するファイル" })).toBeVisible();
}

async function selectTab(page: Page, label: string): Promise<void> {
  await page.getByRole("tab", { name: new RegExp(label) }).click();
  await expect(page.getByRole("tab", { name: new RegExp(label) })).toHaveAttribute("aria-selected", "true");
}

/** 単価タブで行を追加する（過去に影響すれば確認画面で適用まで押す） */
async function addRate(page: Page, key: string, rate: string, from: string): Promise<void> {
  await selectTab(page, "単価");
  await page.getByRole("button", { name: "＋ 新しい単価" }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  await d.locator("#yn-me-f-key").fill(key);
  await d.locator("#yn-me-f-hourly_rate").fill(rate);
  await d.locator("#yn-me-f-effective_from").fill(from);
  await d.locator('[data-role="submit"]').click();
  if (await d.isVisible()) await d.locator('[data-role="submit"]').click();
  await expect(d).toHaveCount(0);
}

function ratesTable(page: Page) {
  return page.locator("table.yn-me-table");
}

/** 台帳の対象の行（data-group = キー） */
function group(page: Page, key: string) {
  return page.locator(`tr.yn-me-group[data-group="${key}"]`);
}

/** 対象の変更の履歴の行（開いていなければ開く） */
async function history(page: Page, key: string) {
  const toggle = group(page, key).locator(".yn-me-hist-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  return page.locator(`tr.yn-me-hist[data-parent="${key}"]`);
}

/** 対象ごとの行の数（キーの種類の数） */
function groupCount(id: "members" | "rates" | "teams"): number {
  const doc = parseMasterDoc(id, PAYLOAD.files[id].text);
  return new Set(doc.rows.map((r) => r.cells[0])).size;
}

test.beforeEach(async ({ page }) => {
  // 下書きが前のテストから残らないように（同じオリジンの localStorage はテストごとに新しいコンテキストだが念のため）
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("__e2e_keep_draft__")) localStorage.removeItem("yojitsu-navi:masters-draft:v1");
    // 再訪は「別のタブ・後日」として扱う（同じタブの続きは聞かずに戻る。plan-history.spec で確かめる）
    sessionStorage.removeItem("yojitsu-navi:masters-draft-session");
  });
});

test("初期表示: 「⋯」のメニューの先頭に「マスタ編集」（選択状態）、台帳の 7 タブ（リソース計画は別画面）、説明文（折りたたみ）、行数は対象の数、既定は CSV ダウンロード", async ({ page }) => {
  await open(page);
  await expect(page.locator(".yn-more-btn")).toHaveClass(/is-current/);
  const first = page.locator("#yn-more-menu a.yn-more-item").first();
  await expect(first).toHaveText("マスタ編集");
  await expect(first).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("tab")).toHaveText([/メンバー/, /単価/, /組織/, /案件/, /顧客/, /目標/, /祝日/]);
  // 説明は本文に出さない（見出し横の「?」だけ。§37）
  await expect(page.locator("details.yn-me-intro")).toHaveCount(0);
  for (const [label, id] of [["メンバー", "members"], ["単価", "rates"], ["組織", "teams"]] as const) {
    await selectTab(page, label);
    await expect(page.locator("table.yn-me-table tbody tr.yn-me-group")).toHaveCount(groupCount(id));
    // 履歴の行は閉じている
    await expect(page.locator("table.yn-me-table tbody tr.yn-me-hist")).toHaveCount(0);
    await expect(page.locator("#yn-me-panel")).toContainText(MASTER_FILES[id].path);
  }
  // 主任は 2 件の履歴（2025-04 8000 → 2026-04 8500）。開くと前 → 後
  await selectTab(page, "単価");
  await expect(group(page, "主任")).toContainText("8500");
  await expect(group(page, "主任").locator(".yn-me-hist-toggle")).toContainText("履歴 2");
  const h = await history(page, "主任");
  await expect(h).toHaveCount(2);
  await expect(h.nth(0)).toContainText("2025-04 から");
  await expect(h.nth(0)).toContainText("登録");
  await expect(h.nth(1)).toContainText("2026-04 から");
  await expect(h.nth(1)).toContainText("いまの値");
  await expect(h.nth(1)).toContainText("8000 → 8500");
  // 変更が無いうちは保存の欄を出さない
  await expect(page.getByRole("heading", { name: "保存（CSV ダウンロード）" })).toHaveCount(0);
  await expect(page.locator(".yn-me-check")).toContainText("エラーなし");
  await expect(page.locator(".yn-me-diff-slot")).toContainText("変更はありません");
});

test("download: 未来の単価行の追加は確認なしで反映 → 差分 → ダウンロードした CSV は元 + 1 行（LF・BOM なし・未変更行はそのまま）", { tag: "@smoke" }, async ({ page }) => {
  await open(page);
  await addRate(page, "部長", "14000", "2026-11");
  // 今の値は 12000 のまま。予定の変更として見える
  const g = group(page, "部長");
  await expect(g).toContainText("12000");
  await expect(g).toContainText("14000");
  await expect(g).toContainText("予定 1");
  await expect(g).toContainText("追加");
  const h = await history(page, "部長");
  await expect(h.last()).toContainText("2026-11 から");
  await expect(h.last()).toContainText("予定");
  await expect(h.last()).toContainText("12000 → 14000");
  await expect(page.getByRole("tab", { name: /単価/ })).toContainText("変更 1");
  const diff = page.locator(".yn-me-diff-table");
  await expect(diff.locator("tbody tr")).toHaveCount(1);
  await expect(diff).toContainText("部長 ・ 14000 ・ 2026-11");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /rates\.csv をダウンロード/ }).click()]);
  expect(dl.suggestedFilename()).toBe("rates.csv");
  const text = readFileSync((await dl.path())!, "utf-8");
  const expected = serializeMasterDoc(addRow(parseMasterDoc("rates", RATES_TEXT), { key: "部長", hourly_rate: "14000", effective_from: "2026-11" }).doc).text;
  expect(text).toBe(expected);
  // 元の行はそのまま、足した行は部長の行のすぐ後ろ（末尾ではない。§120.1）
  const lines = text.split("\n");
  expect(lines.filter((l) => l !== "部長,14000,2026-11").join("\n")).toBe(RATES_TEXT);
  expect(lines[lines.indexOf("部長,14000,2026-11") - 1]).toMatch(/^部長,/);
  expect(text.charCodeAt(0)).not.toBe(0xfeff);
  expect(text).not.toContain("\r");
  // 変更していないファイルのボタンは出ない
  await expect(page.getByRole("button", { name: /members\.csv をダウンロード/ })).toHaveCount(0);
  await expect(page.locator(".yn-me-steps")).toContainText("置換");
});

test("過去に影響する追加・修正・削除は確認画面で影響月数を出す。削除は取り消せる", async ({ page }) => {
  await open(page);
  await selectTab(page, "単価");
  // 追加（2026-04 → 2026-10 までの 7 か月）
  await page.getByRole("button", { name: "＋ 新しい単価" }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  await expect(d).toHaveRole("dialog");
  await d.locator("#yn-me-f-key").fill("一般");
  await d.locator("#yn-me-f-hourly_rate").fill("6500");
  await d.locator("#yn-me-f-effective_from").fill("2026-04");
  await d.locator('[data-role="submit"]').click();
  await expect(d.locator(".yn-me-impact")).toContainText("過去の計算結果が変わります（影響: 7 か月）");
  await expect(d.locator(".yn-me-fields")).toBeHidden();
  // 入力に戻ってキャンセルできる
  await d.getByRole("button", { name: "入力に戻る" }).click();
  await expect(d.locator(".yn-me-fields")).toBeVisible();
  await d.locator('[data-role="submit"]').click();
  await d.locator('[data-role="submit"]').click();
  await expect(d).toHaveCount(0);
  // 2026-04 からの値が今の値になる
  await expect(group(page, "一般")).toContainText("6500");
  await expect(group(page, "一般").locator(".yn-me-hist-toggle")).toContainText("履歴 2");

  // 今の値の修正: 変わる値と影響を表示
  const row = group(page, "課長");
  await row.getByRole("button", { name: /課長 の今の値/ }).click();
  await d.locator("#yn-me-f-hourly_rate").fill("10500");
  await d.locator('[data-role="submit"]').click();
  await expect(d.locator(".yn-me-change-list")).toContainText("10000 → 10500");
  await expect(d.locator(".yn-me-impact")).toContainText(/影響: \d+ か月/);
  await d.locator('[data-role="submit"]').click();
  await expect(row.locator(".yn-me-state")).toContainText("変更");
  // 修正した履歴は開いて見える。元に戻す
  const kacho = await history(page, "課長");
  await expect(kacho.first()).toContainText("10500");
  await kacho.first().getByRole("button", { name: /修正を元に戻す/ }).click();
  await expect(row.locator(".yn-me-state")).not.toContainText("変更");

  // 削除（確認つき）→ 一覧から取り消し
  const p002 = await history(page, "P002");
  await p002.getByRole("button", { name: /藤井 隆 の 2025-10 からの履歴を削除/ }).click();
  await expect(d).toContainText("行を削除しますか");
  await expect(d.locator(".yn-me-impact")).toContainText("過去の計算結果が変わります");
  await d.locator('[data-role="confirm-delete"]').click();
  await expect(group(page, "P002")).toHaveCount(0);
  await expect(page.locator(".yn-me-removed")).toContainText("藤井 隆");
  await page.getByRole("button", { name: "削除を取り消す" }).click();
  await expect(group(page, "P002")).toHaveCount(1);
});

test("必須の未入力はダイアログで止め、検証エラーは行に表示して保存（ダウンロード）を押せない", async ({ page }) => {
  await open(page);
  await selectTab(page, "単価");
  await page.getByRole("button", { name: "＋ 新しい単価" }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  await d.locator('[data-role="submit"]').click();
  await expect(d.locator(".yn-me-form-msg")).toContainText("入力してください");
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);

  await addRate(page, "課長", "abc", "2026-12");
  // エラーのある対象は履歴を自動で開く
  await expect(group(page, "課長")).toHaveClass(/is-invalid/);
  const bad = ratesTable(page).locator("tbody tr.yn-me-row.is-invalid");
  await expect(bad).toHaveCount(1);
  await expect(page.locator(".yn-me-issue-row")).toContainText("hourly_rate が数値ではありません");
  await expect(page.getByRole("tab", { name: /単価/ })).toContainText("エラー 1");
  await expect(page.locator(".yn-me-check")).toContainText("保存できません");
  await expect(page.getByRole("button", { name: /rates\.csv をダウンロード/ })).toBeDisabled();
  await expect(page.locator("#yn-me-save-reason")).toContainText("検証エラーが 1 件");

  // 別タブの行にもエラーが出る: チームを消すとメンバー行がエラー
  await selectTab(page, "組織");
  const team = await history(page, "S11");
  await team.first().getByRole("button", { name: /履歴を削除/ }).click();
  await page.locator('[data-role="confirm-delete"]').click();
  await expect(page.getByRole("tab", { name: /メンバー/ })).toContainText(/エラー \d+/);
  // 検証の一覧から、そのメンバーの行へ（§40）
  await page.locator(".yn-me-issue-item.is-error", { hasText: "S11 は存在しません" }).first().getByRole("button").click();
  await expect(page.getByRole("tab", { name: /メンバー/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".yn-me-issue-row.is-error").first()).toContainText("S11 は存在しません");

  // 直すと保存できる
  await page.getByRole("button", { name: "編集をすべて取り消す" }).click();
  await page.locator('[data-role="confirm-discard"]').click();
  await expect(page.locator(".yn-me-check")).toContainText("エラーなし");
  await addRate(page, "課長", "11000", "2026-12");
  await expect(page.getByRole("button", { name: /rates\.csv をダウンロード/ })).toBeEnabled();
});

test("下書き: 再訪で復元を提案し、復元すると編集が戻る。土台が変わっていれば「元データが更新されています」", async ({ page }) => {
  await open(page);
  await addRate(page, "部長", "14000", "2026-11");
  const draft = await page.evaluate((k) => localStorage.getItem(k), DRAFT_KEY);
  expect(draft).toContain("14000");
  await page.evaluate(() => sessionStorage.setItem("__e2e_keep_draft__", "1"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "保存していない編集内容（下書き）があります" })).toBeVisible();
  await expect(page.locator(".yn-me-banner")).toContainText("単価 1件");
  await expect(page.locator(".yn-me-stale")).toHaveCount(0);
  await expect(page.locator(".yn-me-diff-slot")).toContainText("変更はありません");
  await page.getByRole("button", { name: "下書きを復元する" }).click();
  await expect(page.locator(".yn-me-banner")).toHaveCount(0);
  await expect(page.locator(".yn-me-diff-table")).toContainText("部長 ・ 14000 ・ 2026-11");

  // 土台（コミット ID と本文）が変わった下書き
  await page.evaluate((k) => {
    const d = JSON.parse(localStorage.getItem(k)!);
    d.files.rates.baseCommitId = "0".repeat(40);
    d.files.rates.baseText = d.files.rates.baseText.replace("15000", "15500");
    localStorage.setItem(k, JSON.stringify(d));
  }, DRAFT_KEY);
  await page.reload();
  await expect(page.locator(".yn-me-stale")).toContainText("元データが更新されています");
  await expect(page.locator(".yn-me-stale")).toContainText("rates.csv");
  await expect(page.locator(".yn-me-stale")).toContainText("最新のデータに当て直します");
  await expect(page.locator(".yn-me-stale")).toContainText("そのまま当て直せる変更: 1 件");
  await expect(page.locator(".yn-me-conflict")).toHaveCount(0);
  await page.getByRole("button", { name: "下書きを復元する" }).click();
  await selectTab(page, "単価");
  await expect(page.locator("#yn-me-panel")).toContainText("古い元データで作った下書きを最新のデータに当て直して復元しました");
  // ダウンロードする CSV は最新の元データ ＋ 自分の追加（下書きの古い土台 15500 は出ない）
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /rates\.csv をダウンロード/ }).click()]);
  const text = readFileSync((await dl.path())!, "utf-8");
  expect(text).toBe(RATES_WITH_BUCHO);
  expect(text).not.toContain("15500");
  // 破棄
  await page.reload();
  await page.getByRole("button", { name: "下書きを破棄する" }).click();
  expect(await page.evaluate((k) => localStorage.getItem(k), DRAFT_KEY)).toBeNull();
});

/** 単価の課長の行を 10500 に、P002 の行を削除した下書きを作り、その下書きの土台を「他の人が更新する前」に書き換えて再読み込み */
async function staleDraftWithConflict(page: Page): Promise<void> {
  await open(page);
  await selectTab(page, "単価");
  const d = page.locator("dialog.yn-me-dialog[open]");
  await group(page, "課長").getByRole("button", { name: /課長 の今の値/ }).click();
  await d.locator("#yn-me-f-hourly_rate").fill("10500");
  await d.locator('[data-role="submit"]').click();
  await d.locator('[data-role="submit"]').click();
  await (await history(page, "P002")).getByRole("button", { name: /履歴を削除/ }).click();
  await d.locator('[data-role="confirm-delete"]').click();
  await addRate(page, "部長", "14000", "2026-11");
  await page.evaluate((k) => {
    const draft = JSON.parse(localStorage.getItem(k)!);
    // 下書きを作ったときの元データでは課長が 9877 だった（= その後、他の人が 10000 に変えた）。コミットも古い
    draft.files.rates.baseCommitId = "0".repeat(40);
    draft.files.rates.baseText = draft.files.rates.baseText.replace("課長,10000,", "課長,9877,");
    localStorage.setItem(k, JSON.stringify(draft));
    sessionStorage.setItem("__e2e_keep_draft__", "1");
  }, DRAFT_KEY);
  await page.reload();
  await expect(page.locator(".yn-me-stale")).toContainText("元データが更新されています");
}

/** 期待する rates.csv: 最新の元データに、課長 10500・P002 削除・部長 14000 追加 */
function expectedRates(keepMine: boolean): string {
  let doc = parseMasterDoc("rates", RATES_TEXT);
  const kacho = doc.rows.find((r) => r.cells[0] === "課長")!;
  const p002 = doc.rows.find((r) => r.cells[0] === "P002")!;
  if (keepMine) doc = updateRow(doc, kacho.id, { hourly_rate: "10500" });
  doc = deleteRow(doc, p002.id);
  return serializeMasterDoc(addRow(doc, { key: "部長", hourly_rate: "14000", effective_from: "2026-11" }).doc).text;
}

test("下書きの当て直し: 土台が変わった後の復元で、同じ行の衝突を行ごとに選んでから復元 → 差分 → ダウンロードは最新の土台＋自分の変更", async ({ page }) => {
  await staleDraftWithConflict(page);
  const banner = page.locator(".yn-me-banner");
  await expect(banner).toContainText("そのまま当て直せる変更: 2 件");
  await expect(banner).toContainText("当て直せない変更: 1 件");
  const conflict = page.locator("fieldset.yn-me-conflict");
  await expect(conflict).toHaveCount(1);
  await expect(conflict.locator("legend")).toContainText("課長: あなたも他の人も、この行を変更しました");
  await expect(conflict).toContainText("下書きを作ったときの行: 課長 ・ 9877 ・ 2025-04");
  await expect(conflict.getByRole("radio", { name: /自分の下書きを残す: 時間単価（円）: 10500/ })).toBeVisible();
  await expect(conflict.getByRole("radio", { name: /最新のデータを残す: 時間単価（円）: 10000/ })).toBeVisible();
  // 選ばずに復元 → 止めて案内し、最初の未選択の行へフォーカス
  await page.getByRole("button", { name: "下書きを復元する" }).click();
  await expect(banner.locator('[role="alert"].yn-me-form-msg')).toContainText("まだ選んでいない行が 1 件");
  await expect(conflict.getByRole("radio").first()).toBeFocused();
  await expect(page.locator(".yn-me-diff-slot")).toContainText("変更はありません");
  // キーボードで選ぶ（Space）→ 復元
  await page.keyboard.press("Space");
  await expect(conflict.getByRole("radio", { name: /自分の下書きを残す/ })).toBeChecked();
  await expect(banner).toContainText("未選択 0 件");
  await page.getByRole("button", { name: "下書きを復元する" }).click();
  await expect(banner).toHaveCount(0);
  await selectTab(page, "単価");
  await expect(page.locator("#yn-me-panel")).toContainText("どちらを残すか選んだ行 1 件");
  // 差分は最新の元データ（課長 10000）に対する自分の変更
  const diff = page.locator(".yn-me-diff-table");
  await expect(diff).toContainText("時間単価（円）: 10000 → 10500");
  await expect(diff).toContainText("藤井 隆");
  await expect(diff).toContainText("部長 ・ 14000 ・ 2026-11");
  await expect(diff).not.toContainText("9877");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /rates\.csv をダウンロード/ }).click()]);
  const text = readFileSync((await dl.path())!, "utf-8");
  expect(text).toBe(expectedRates(true));
  expect(text).not.toContain("9877");
  // 元データのコミットを示し、GitLab 側が新しければアップロードしないよう案内
  await expect(page.locator(".yn-me-steps")).toContainText("アップロードせずに");
  if (PAYLOAD.files.rates.lastCommitId) await expect(page.locator('[data-base-commit="rates"]')).toContainText(PAYLOAD.files.rates.lastCommitId.slice(0, 8));
  // 復元後の下書きは最新の土台に対する差分（もう一度開いても当て直し不要）
  await page.reload();
  await expect(page.locator(".yn-me-banner")).toBeVisible();
  await expect(page.locator(".yn-me-stale")).toHaveCount(0);
  await expect(page.locator(".yn-me-banner")).toContainText("単価 3件");
});

test("下書きの当て直し: 「最新のデータを残す」を選ぶと他の人の値が残り、他の自分の変更は当たる", async ({ page }) => {
  await staleDraftWithConflict(page);
  await page.getByRole("radio", { name: /最新のデータを残す/ }).check();
  await page.getByRole("button", { name: "下書きを復元する" }).click();
  await expect(page.locator(".yn-me-banner")).toHaveCount(0);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /rates\.csv をダウンロード/ }).click()]);
  expect(readFileSync((await dl.path())!, "utf-8")).toBe(expectedRates(false));
});

test("役職はプルダウン（§31.5）: 候補は（なし）→ 単価の役職（ファイル順）→ メンバーだけの役職。単価に役職を足すと候補に出る", async ({ page }) => {
  await open(page);
  await addRate(page, "エキスパート", "9000", "2026-11");
  await selectTab(page, "メンバー");
  const d = page.locator("dialog.yn-me-dialog[open]");
  await page.locator("table.yn-me-table tbody tr.yn-me-group").first().getByRole("button", { name: /の変更を追加/ }).click();
  const title = d.locator("#yn-me-f-title");
  await expect(title).toHaveJSProperty("tagName", "SELECT");
  const values = await title.locator("option").evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
  const rateTitles = PAYLOAD.files.rates.text.split("\n").slice(1).map((l) => l.split(",")[0]).filter((k) => k && !/^[MP]\d+$/.test(k));
  const rateOrder = [...new Set([...rateTitles, "エキスパート"])];
  expect(values[0]).toBe("");
  expect(values.slice(1, 1 + rateOrder.length)).toEqual(rateOrder);
  expect(values).toContain("パートナー");
  expect(new Set(values).size).toBe(values.length);
  await expect(d.locator("#yn-me-f-title-hint")).toHaveText("新しい役職は、単価に役職の行を追加すると選べます");
  await title.selectOption("エキスパート");
  await d.locator('[data-role="submit"]').click();
  if (await d.isVisible()) await d.locator('[data-role="submit"]').click();
  await expect(page.getByRole("table", { name: "メンバーの変更内容" })).toContainText("エキスパート");
});

test("事業本部・部・課は既存の値から選べ、新しい名前も書ける（§31.5 の横展開）", async ({ page }) => {
  await open(page);
  await selectTab(page, "メンバー");
  const d = page.locator("dialog.yn-me-dialog[open]");
  await page.locator("table.yn-me-table tbody tr.yn-me-group").first().getByRole("button", { name: /の変更を追加/ }).click();
  const header = PAYLOAD.files.members.text.split("\n")[0]!.split(",");
  const rows = PAYLOAD.files.members.text.split("\n").slice(1).filter(Boolean).map((l) => l.split(","));
  for (const col of ["division", "department", "section"]) {
    const input = d.locator(`#yn-me-f-${col}`);
    if ((await input.count()) === 0) continue; // 列ごと省略できる（division）
    const listId = await input.getAttribute("list");
    expect(listId).toBeTruthy();
    const opts = await d.locator(`datalist[id="${listId}"] option`).evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    const i = header.indexOf(col);
    const expected = new Set(rows.map((r) => r[i] ?? "").filter(Boolean));
    expect(new Set(opts)).toEqual(expected);
    expect(opts.length).toBe(expected.size);
  }
  // 候補に無い新しい部の名前もそのまま入れられる
  await d.locator("#yn-me-f-department").fill("新設部");
  await expect(d.locator("#yn-me-f-department")).toHaveValue("新設部");
});

test("影響ダイアログ: 所属チームだけ変える行の追加は「組織別の集計」と出し、実績・残予算は変わらないと明記。役職を変えると実績・残予算", async ({ page }) => {
  await open(page);
  await selectTab(page, "メンバー");
  const d = page.locator("dialog.yn-me-dialog[open]");
  const first = page.locator("table.yn-me-table tbody tr.yn-me-group").first();
  await first.getByRole("button", { name: /の変更を追加/ }).click();
  // 変える月は既定で翌月（過去を変えない）
  await expect(d.locator("#yn-me-f-effective_from")).toHaveValue("2026-11");
  const team = d.locator("#yn-me-f-team_id");
  const current = await team.inputValue();
  const other = await team.locator("option").evaluateAll((opts, cur) => opts.map((o) => (o as HTMLOptionElement).value).find((v) => v !== "" && v !== cur)!, current);
  await team.selectOption(other);
  await d.locator("#yn-me-f-effective_from").fill("2026-04");
  await d.locator('[data-role="submit"]').click();
  const impact = d.locator(".yn-me-impact");
  await expect(impact).toContainText("過去の計算結果が変わります（影響: 7 か月）");
  await expect(impact).toContainText("所属チームによる組織別の集計");
  await expect(impact).toContainText("実績・残予算・消化率・着地見込みは変わりません");
  await expect(impact).toHaveAttribute("data-cost-changes", "false");
  await d.getByRole("button", { name: "入力に戻る" }).click();
  await team.selectOption(current);
  await d.locator("#yn-me-f-title").selectOption("部長");
  await d.locator('[data-role="submit"]').click();
  await expect(impact).toContainText("時間単価と、実績・残予算・消化率・着地見込みが変わります");
  await expect(impact).not.toContainText("組織別の集計");
  await expect(impact).toHaveAttribute("data-cost-changes", "true");
});

test.describe("gitlab モード", () => {
  const okResponder = (req: Request) => {
    // マージ待ちの変更（§26）の一覧
    if (req.method() === "GET" && req.url().includes("/merge_requests?")) return { status: 200, body: [] };
    if (req.url().endsWith("/user")) return { status: 200, body: { username: "taro" } };
    if (req.url().endsWith("/repository/commits")) return { status: 201, body: { id: "c0ffee00aa", web_url: "https://gitlab.test/grp/yojitsu-navi/-/commit/c0ffee00aa" } };
    if (req.url().endsWith("/merge_requests")) return { status: 201, body: { iid: 12, web_url: "https://gitlab.test/grp/yojitsu-navi/-/merge_requests/12" } };
    return { status: 404, body: { message: "404" } };
  };

  /** 保存の呼び出しだけ（トークンを入れた直後の「マージ待ちの変更」の読み込み = 最初の GET /user と一覧の GET を除く） */
  function saveCalls(mock: GitLabMock) {
    const calls = mock.calls.filter((c) => !(c.method === "GET" && c.url.includes("/merge_requests?")));
    return calls.slice(1);
  }

  /** トークンは設定画面で登録する（§28）。ここでは登録済みの状態にして読み込み直す（同じタブの下書きは自動で戻る） */
  async function enterToken(page: Page) {
    await expect(page.locator("#yn-me-token")).toHaveCount(0);
    await page.evaluate(() => {
      sessionStorage.setItem("yojitsu-navi:gitlab-token", "glpat-secret-token");
      sessionStorage.setItem("__e2e_keep_draft__", "1");
    });
    await page.reload();
    await page.getByRole("button", { name: "下書きを復元する" }).click();
    await expect(page.locator(".yn-me-diff-table")).toBeVisible();
  }

  test("mr: トークンは sessionStorage のみ・再表示しない。新ブランチにコミットして MR を作り、リンクを出す", async ({ page }) => {
    await patchMasters(page, gitlabMode("mr"));
    const mock = await mockGitLab(page, okResponder);
    await open(page);
    await addRate(page, "部長", "14000", "2026-11");
    await expect(page.getByRole("heading", { name: "保存（GitLab）" })).toBeVisible();
    // トークンの入力欄は保存欄に無い（設定画面だけ。§28）
    await expect(page.locator('.yn-me-save input[type="password"]')).toHaveCount(0);
    const save = page.getByRole("button", { name: "GitLab に保存（マージリクエストを作成）" });
    await expect(save).toBeDisabled();
    await expect(page.locator("#yn-me-save-reason")).toContainText("トークンが未登録");
    await expect(page.locator("#yn-me-save-reason").getByRole("link", { name: "設定へ" })).toHaveAttribute("href", "./settings");
    await enterToken(page);
    expect(await page.evaluate(() => sessionStorage.getItem("yojitsu-navi:gitlab-token"))).toBe("glpat-secret-token");
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain("glpat-secret-token");
    expect(await page.content()).not.toContain("glpat-secret-token");
    await page.locator("#yn-me-message").fill("2026年11月の部長単価改定");
    await save.click();
    const outcome = page.locator(".yn-me-outcome.is-ok");
    await expect(outcome).toContainText("マージリクエストを作成しました");
    await expect(outcome.getByRole("link", { name: /!12/ })).toHaveAttribute("href", "https://gitlab.test/grp/yojitsu-navi/-/merge_requests/12");
    await expect(outcome).toContainText(/masters\/\d{8}-\d{6}-taro/);
    const calls = saveCalls(mock);
    expect(calls.map((c) => `${c.method} ${c.url.replace(GITLAB, "")}`)).toEqual(["GET /user", "POST /projects/grp%2Fyojitsu-navi/repository/commits", "POST /projects/grp%2Fyojitsu-navi/merge_requests"]);
    expect(mock.calls.every((c) => c.headers["private-token"] === "glpat-secret-token")).toBe(true);
    const commit = calls[1]!.body as { branch: string; start_branch: string; commit_message: string; actions: Array<{ action: string; file_path: string; content: string; last_commit_id?: string }> };
    expect(commit.branch).toMatch(/^masters\/\d{8}-\d{6}-taro$/);
    expect(commit.start_branch).toBe("main");
    expect(commit.commit_message).toBe("2026年11月の部長単価改定");
    expect(commit.actions).toHaveLength(1);
    expect(commit.actions[0]).toMatchObject({ action: "update", file_path: PAYLOAD.files.rates.repoPath });
    expect(commit.actions[0]!.content).toBe(RATES_WITH_BUCHO);
    if (PAYLOAD.files.rates.lastCommitId) expect(commit.actions[0]!.last_commit_id).toBe(PAYLOAD.files.rates.lastCommitId);
    expect(calls[2]!.body).toMatchObject({ source_branch: commit.branch, target_branch: "main", title: "2026年11月の部長単価改定" });
    // 保存後は下書きを消し、編集をロック
    expect(await page.evaluate((k) => localStorage.getItem(k), DRAFT_KEY)).toBeNull();
    await expect(page.getByRole("button", { name: "＋ 新しい単価" })).toBeDisabled();
    await page.getByRole("button", { name: "新しく編集を始める（元のデータから）" }).click();
    await expect(page.locator(".yn-me-diff-slot")).toContainText("変更はありません");
  });

  test("direct: targetBranch に直接コミット（MR は作らない）", async ({ page }) => {
    await patchMasters(page, gitlabMode("direct"));
    const mock = await mockGitLab(page, okResponder);
    await open(page);
    await addRate(page, "部長", "14000", "2026-11");
    await enterToken(page);
    await page.getByRole("button", { name: "GitLab に保存（直接コミット）" }).click();
    await expect(page.locator(".yn-me-outcome.is-ok")).toContainText("main にコミットしました");
    const calls = saveCalls(mock);
    expect(calls).toHaveLength(2);
    expect((calls[1]!.body as { branch: string }).branch).toBe("main");
    expect(calls[1]!.body).not.toHaveProperty("start_branch");
  });

  test("競合（400 last_commit_id 不一致）: 人が読める案内を出し、編集内容と下書きは残る", async ({ page, errors }) => {
    await patchMasters(page, gitlabMode("mr"));
    await mockGitLab(page, (req) => (req.url().endsWith("/user") ? { status: 200, body: { username: "taro" } } : { status: 400, body: { message: "You are attempting to update a file that has changed since you started editing it." } }));
    await open(page);
    await addRate(page, "部長", "14000", "2026-11");
    await enterToken(page);
    await page.getByRole("button", { name: /GitLab に保存/ }).click();
    const err = page.locator(".yn-me-outcome.is-error");
    await expect(err).toHaveAttribute("data-error-kind", "conflict");
    await expect(err).toContainText("他の人が先に更新しました");
    await expect(err).toContainText("編集内容は消えていません");
    await expect(err.getByRole("button", { name: "CSV ダウンロードに切り替える" })).toHaveCount(0);
    await expect(page.locator(".yn-me-diff-table")).toContainText("14000");
    expect(await page.evaluate((k) => localStorage.getItem(k), DRAFT_KEY)).toContain("14000");
    ignoreGitLabErrors(errors);
  });

  test("古い土台の下書きを当て直して保存すると、最新のコミット ID と最新の土台＋自分の変更を送る（古い土台は送らない）", async ({ page }) => {
    await patchMasters(page, gitlabMode("mr"));
    const mock = await mockGitLab(page, okResponder);
    await staleDraftWithConflict(page);
    await page.getByRole("radio", { name: /自分の下書きを残す/ }).check();
    await page.getByRole("button", { name: "下書きを復元する" }).click();
    await enterToken(page);
    await page.getByRole("button", { name: "GitLab に保存（マージリクエストを作成）" }).click();
    await expect(page.locator(".yn-me-outcome.is-ok")).toContainText("マージリクエストを作成しました");
    const commit = saveCalls(mock)[1]!.body as { actions: Array<{ content: string; last_commit_id?: string }> };
    expect(commit.actions[0]!.content).toBe(expectedRates(true));
    expect(commit.actions[0]!.last_commit_id).not.toBe("0".repeat(40));
    if (PAYLOAD.files.rates.lastCommitId) expect(commit.actions[0]!.last_commit_id).toBe(PAYLOAD.files.rates.lastCommitId);
  });

  test("権限不足（403）: Developer 以上が必要と案内。編集は残る", async ({ page, errors }) => {
    await patchMasters(page, gitlabMode("mr"));
    await mockGitLab(page, (req) => (req.url().endsWith("/user") ? { status: 200, body: { username: "taro" } } : { status: 403, body: { message: "403 Forbidden" } }));
    await open(page);
    await addRate(page, "部長", "14000", "2026-11");
    await enterToken(page);
    await page.getByRole("button", { name: /GitLab に保存/ }).click();
    const err = page.locator(".yn-me-outcome.is-error");
    await expect(err).toHaveAttribute("data-error-kind", "permission");
    await expect(err).toContainText("Developer 以上");
    await expect(err).toContainText("403 Forbidden");
    await expect(page.locator(".yn-me-diff-table")).toContainText("14000");
    ignoreGitLabErrors(errors);
  });

  test("CORS / ネットワーク失敗: 「CSV ダウンロードに切り替える」で download に切り替え、そのままダウンロードできる", async ({ page, errors }) => {
    await patchMasters(page, gitlabMode("mr"));
    await mockGitLab(page, () => null);
    await open(page);
    await addRate(page, "部長", "14000", "2026-11");
    await enterToken(page);
    await page.getByRole("button", { name: /GitLab に保存/ }).click();
    const err = page.locator(".yn-me-outcome.is-error");
    await expect(err).toHaveAttribute("data-error-kind", "network");
    await expect(err).toContainText("CORS");
    await err.getByRole("button", { name: "CSV ダウンロードに切り替える" }).click();
    await expect(page.getByRole("heading", { name: "保存（CSV ダウンロード）" })).toBeFocused();
    await expect(page.locator(".yn-me-save")).toContainText("GitLab に接続できなかったため");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /rates\.csv をダウンロード/ }).click()]);
    expect(readFileSync((await dl.path())!, "utf-8")).toBe(RATES_WITH_BUCHO);
    // GitLab のファイル画面へのリンク（projectId が group/project 形式）
    await expect(page.getByRole("link", { name: "GitLab でこのファイルを開く" })).toHaveAttribute("href", "https://gitlab.test/grp/yojitsu-navi/-/blob/main/data/masters/rates.csv");
    ignoreGitLabErrors(errors);
  });

  test("トークン無効（401）: トークンを消して再入力を促す", async ({ page, errors }) => {
    await patchMasters(page, gitlabMode("mr"));
    await mockGitLab(page, () => ({ status: 401, body: { message: "401 Unauthorized" } }));
    await open(page);
    await addRate(page, "部長", "14000", "2026-11");
    await enterToken(page);
    await page.getByRole("button", { name: /GitLab に保存/ }).click();
    await expect(page.locator(".yn-me-outcome.is-error")).toContainText("トークンが無効か期限切れ");
    expect(await page.evaluate(() => sessionStorage.getItem("yojitsu-navi:gitlab-token"))).toBeNull();
    await expect(page.locator("#yn-me-save-reason")).toContainText("トークンが未登録");
    ignoreGitLabErrors(errors);
  });
});

test("取り込みモード（memberSource.adapter = csv）: columns に書いた列だけ読み取り専用。所属（書いていない列）・チーム・適用開始月は編集できる", async ({ page }) => {
  await patchMasters(page, (p) => ({ ...p, memberSourceAdapter: "csv", memberImportedColumns: ["name", "kind", "title"] }));
  await open(page);
  await expect(page.locator("#yn-me-panel")).toContainText("人事データから自動で取り込みます");
  const row = await history(page, "M001");
  await expect(row.getByRole("button", { name: /履歴を削除/ })).toHaveCount(0);
  await row.first().getByRole("button", { name: /履歴を修正/ }).click();
  const d = page.locator("dialog.yn-me-dialog[open]");
  for (const name of ["member_id", "name", "kind", "title"]) await expect(d.locator(`[name="${name}"]`)).toBeDisabled();
  for (const name of ["division", "department", "section", "team_id", "effective_from"]) await expect(d.locator(`[name="${name}"]`)).toBeEnabled();
  await page.keyboard.press("Escape");
});

test("社員番号・氏名は人事から取り込むため、保存済みのメンバーでは変えられない（所属・役職は変えられる）。新しいメンバーでは入力する。CSV で編集は無い", { tag: "@smoke" }, async ({ page }) => {
  await open(page);
  await expect(page.getByRole("button", { name: "CSV で編集" })).toHaveCount(0);
  const d = page.locator("dialog.yn-me-dialog[open]");
  // 今の値の修正
  await group(page, "M001").getByRole("button", { name: /の今の値/ }).click();
  for (const name of ["member_id", "name"]) {
    await expect(d.locator(`[name="${name}"]`)).toBeDisabled();
    await expect(d.locator(`#yn-me-f-${name}-hint`)).toHaveText("人事データから取り込むため変更できません");
  }
  for (const name of ["kind", "title", "division", "department", "section", "team_id", "effective_from"]) await expect(d.locator(`[name="${name}"]`)).toBeEnabled();
  await d.locator('[name="section"]').fill("第9課");
  await d.locator('[data-role="submit"]').click();
  if (await d.isVisible()) await d.locator('[data-role="submit"]').click();
  await expect(d).toHaveCount(0);
  await expect(group(page, "M001")).toContainText("第9課");
  await expect(group(page, "M001")).toContainText("佐藤 健一");
  // 「＋ 変更」でも氏名は前の履歴のまま
  await group(page, "M001").getByRole("button", { name: /の変更を追加/ }).click();
  await expect(d.locator('[name="name"]')).toBeDisabled();
  await expect(d.locator('[name="name"]')).toHaveValue("佐藤 健一");
  await page.keyboard.press("Escape");
  // 新しいメンバーは社員番号・氏名を入力する
  await page.getByRole("button", { name: "＋ 新しいメンバー" }).click();
  for (const name of ["member_id", "name"]) await expect(d.locator(`[name="${name}"]`)).toBeEnabled();
  await page.keyboard.press("Escape");
});

test("a11y: タブは矢印キーで移動、ダイアログは role=dialog で Esc で閉じてフォーカスが戻る、表の見出し", async ({ page }) => {
  await open(page);
  const first = page.getByRole("tab", { name: /メンバー/ });
  await first.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /単価/ })).toBeFocused();
  await expect(page.getByRole("tab", { name: /単価/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: /祝日/ })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(first).toBeFocused();
  await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "yn-me-tab-members");

  const add = page.getByRole("button", { name: "＋ 新しいメンバー" });
  await add.click();
  const d = page.getByRole("dialog");
  await expect(d).toBeVisible();
  const labelledBy = await d.getAttribute("aria-labelledby");
  await expect(page.locator(`#${labelledBy}`)).toContainText("新しいメンバー");
  await expect(d.locator("#yn-me-f-member_id")).toBeFocused();
  // すべての入力にラベル
  const ids = await d.locator("input, select").evaluateAll((els) => els.filter((e) => (e as HTMLInputElement).type !== "hidden").map((e) => e.id));
  for (const id of ids) await expect(d.locator(`label[for="${id}"]`)).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
  await expect(add).toBeFocused();

  const t = page.locator("table.yn-me-table");
  await expect(t.locator("caption")).toHaveCount(1);
  // 名前（ID）・区分・役職・事業本部・部・課・所属チーム・在籍区分・変更の履歴・状態・操作（§60）
  await expect(t.locator("thead th[scope=col]")).toHaveCount(11);
  const g = t.locator("tbody tr.yn-me-group").first();
  await expect(g.locator("th[scope=row]")).toHaveCount(1);
  // 行の操作ボタンは「誰の行か」を名前で含む（ID ではなく）
  await expect(g.getByRole("button", { name: /佐藤 健一 の今の値/ })).toBeVisible();
  await expect(g.getByRole("button", { name: /佐藤 健一 の変更の履歴（1 件）/ })).toHaveAttribute("aria-expanded", "false");
  await g.getByRole("button", { name: /佐藤 健一 の変更の履歴/ }).click();
  await expect(g.getByRole("button", { name: /佐藤 健一 の変更の履歴/ })).toBeFocused();
  await expect(g.getByRole("button", { name: /佐藤 健一 の変更の履歴/ })).toHaveAttribute("aria-expanded", "true");
  const controls = await g.getByRole("button", { name: /佐藤 健一 の変更の履歴/ }).getAttribute("aria-controls");
  await expect(page.locator(`#${controls}`)).toHaveClass(/yn-me-hist/);
  // h1 は 1 つ
  await expect(page.locator("h1")).toHaveCount(1);
});

test("ダークモード・390px: 横スクロール無し、主要な操作が見える", async ({ page }) => {
  await useDarkTheme(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).not.toBe("rgb(255, 255, 255)");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole("button", { name: "＋ 新しいメンバー" })).toBeVisible();
  await addRate(page, "部長", "14000", "2026-11");
  await expect(page.locator(".yn-me-diff-table")).toBeVisible();
  const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow2).toBeLessThanOrEqual(0);
  // 1280 / 1024 でも横スクロール無し（表はラッパの中）
  for (const w of [1280, 1024]) {
    await page.setViewportSize({ width: w, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  }
});
