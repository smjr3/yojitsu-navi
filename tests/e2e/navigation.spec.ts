/**
 * 遷移・並べ替え・絞り込み・Excel 出力
 */
import { createRequire } from "node:module";
import { test, expect, gotoPage, tableByCaption, dataRows, headerIndex, col, cell, cellText, parseNumber, query, rowKeys } from "./helpers/app.js";
import { contractResult, contractRowExpected, contractsInPeriod, fiscalPeriod, getModel, teamContractIds, treeAt, yen, UNIT_LABEL } from "./helpers/core.js";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx") as typeof import("xlsx");

const model = getModel();
const FY = fiscalPeriod(model);

test("チーム一覧 → 末端チーム詳細 → 契約一覧（team=）→ 契約詳細、パンくず、同じチームの契約一覧", async ({ page }) => {
  await gotoPage(page, "/teams");
  const teams = tableByCaption(page, "チーム一覧");
  const leaf = "T111";
  const tree = treeAt(FY.to, model);
  expect(tree[leaf]!.children).toEqual([]);
  // 行リンク（キーボード到達用）で遷移
  const link = teams.locator(`tbody tr[data-key="${leaf}"] .yn-row-link`);
  await expect(link).toContainText(tree[leaf]!.name);
  await link.click();
  // チーム行はチーム詳細へ。契約一覧への絞り込みは詳細内のリンクから
  await expect(page).toHaveURL(/\/team\?/);
  expect(query(page).get("id")).toBe(leaf);
  await page.getByRole("link", { name: "このチームの契約一覧へ" }).click();
  await expect(page).toHaveURL(/\/contracts\?/);
  expect(query(page).get("team")).toBe(leaf);
  await expect(page.locator("h1")).toHaveText("契約一覧");
  await expect(page.locator("#yn-filter-team")).toHaveValue(leaf);
  const contracts = tableByCaption(page, "契約一覧");
  const ids = teamContractIds(leaf, FY, model)!;
  const expected = contractsInPeriod(FY, ids, model).map((r) => r.contract.contractId);
  expect(expected.length).toBeGreaterThan(0);
  expect(new Set(await rowKeys(contracts))).toEqual(new Set(expected));
  await expect(page.locator(".yn-section-hint").first()).toContainText(tree[leaf]!.name);
  // 行をクリック（リンク以外のセル）で詳細へ
  const firstKey = (await rowKeys(contracts))[0]!;
  const h = await headerIndex(contracts);
  await cell(contracts.locator(`tbody tr[data-key="${firstKey}"]`), col(h, "残予算率")).click({ position: { x: 2, y: 2 } });
  await expect(page).toHaveURL(/\/contract\?/);
  expect(query(page).get("id")).toBe(firstKey);
  expect(query(page).get("team")).toBe(leaf);
  await expect(page.locator("h1")).toContainText(firstKey);
  await expect(page.locator("h1 .yn-title-id")).toHaveText(firstKey);
  const r = contractResult(firstKey, model);
  await expect(page.locator("h1")).toContainText(r.contract.customerName);
  // パンくず
  const crumbs = page.locator('nav[aria-label="パンくず"] li');
  await expect(crumbs).toHaveCount(3);
  await expect(crumbs.nth(0).locator("a")).toHaveText("全体サマリー");
  await expect(crumbs.nth(1).locator("a")).toHaveText("契約一覧");
  await expect(crumbs.nth(1).locator("a")).toHaveAttribute("href", new RegExp(`team=${leaf}`));
  await expect(crumbs.nth(2).locator('[aria-current="page"]')).toHaveText(firstKey);
  // 主担当チームのリンクと「同じチームの契約一覧」
  await expect(page.locator(".yn-facts > div").filter({ hasText: "主担当" }).locator("a")).toHaveText(tree[r.contract.teamId!]!.name);
  const same = page.getByRole("link", { name: "同じチームの契約一覧" });
  await expect(same).toBeVisible();
  await same.click();
  await expect(page).toHaveURL(/\/contracts\?/);
  expect(query(page).get("team")).toBe(r.contract.teamId);
  await expect(page.locator("#yn-filter-team")).toHaveValue(r.contract.teamId!);
  // パンくずで全体サマリーへ（状態を引き継ぐ）
  await page.locator('nav[aria-label="パンくず"] a', { hasText: "全体サマリー" }).click();
  await expect(page.locator("h1")).toHaveText("全体サマリー");
  expect(query(page).get("team")).toBe(r.contract.teamId);
  await expect(page.locator("#yn-filter-team")).toHaveValue(r.contract.teamId!);
});

test("チーム一覧の木: 折りたたみで配下が隠れ、開くと戻る。中間の課からも契約一覧へ", async ({ page }) => {
  await gotoPage(page, "/teams");
  const table = tableByCaption(page, "チーム一覧");
  const tree = treeAt(FY.to, model);
  const d1 = tree["D1"]!;
  const descendants = d1.descendantIds.filter((id) => id !== "D1");
  expect(descendants.length).toBeGreaterThan(0);
  const toggle = table.locator('tbody tr[data-key="D1"] .yn-tree-toggle');
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  for (const id of descendants) await expect(table.locator(`tbody tr[data-key="${id}"]`)).toHaveCount(0);
  await expect(table.locator('tbody tr[data-key="D2"]')).toHaveCount(1);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  for (const id of descendants) await expect(table.locator(`tbody tr[data-key="${id}"]`)).toHaveCount(1);
  // 中間の課（S21）→ チーム詳細 → 契約一覧
  await table.locator('tbody tr[data-key="S21"] .yn-row-link').click();
  await expect(page).toHaveURL(/\/team\?/);
  expect(query(page).get("id")).toBe("S21");
  await page.getByRole("link", { name: "このチームの契約一覧へ" }).click();
  await expect(page).toHaveURL(/\/contracts\?/);
  expect(query(page).get("team")).toBe("S21");
  const ids = teamContractIds("S21", FY, model)!;
  const expected = contractsInPeriod(FY, ids, model).map((r) => r.contract.contractId);
  expect(new Set(await rowKeys(tableByCaption(page, "契約一覧")))).toEqual(new Set(expected));
});

test("上部タブと右上のリンクで全ページに行ける（現在のページは aria-current）", async ({ page }) => {
  await gotoPage(page, "/");
  const header = page.locator("#observablehq-header");
  await expect(page.locator("#observablehq-sidebar")).toHaveCount(0);
  for (const [name, h1] of [
    ["チーム", "チーム一覧"],
    ["契約", "契約一覧"],
    ["計算ルール", "計算ルール"],
    ["データ確認", "データ確認"],
    ["全体", "全体サマリー"],
  ] as const) {
    const link = header.getByRole("link", { name, exact: true });
    await link.click();
    await expect(page.locator("h1")).toHaveText(h1);
    await expect(header.getByRole("link", { name, exact: true })).toHaveAttribute("aria-current", "page");
  }
  // 契約詳細では「契約」タブが選択状態
  await gotoPage(page, "/contract?id=C008");
  await expect(header.getByRole("link", { name: "契約", exact: true })).toHaveAttribute("aria-current", "page");
});

test("フィルタはヘッダの固定バーにあり、スクロールしても画面上端に残る", async ({ page }) => {
  await gotoPage(page, "/contracts");
  const bar = page.locator("#yn-filterbar-slot .yn-filters");
  await expect(bar).toBeVisible();
  await page.mouse.wheel(0, 2000);
  await expect.poll(async () => (await bar.boundingBox())?.y ?? -1).toBeLessThan(120);
  await expect(page.locator("#yn-filter-from")).toBeInViewport();
});

test("見出しクリックで並べ替え: aria-sort が切り替わり、数値順（辞書順ではない）に並ぶ", async ({ page }) => {
  await gotoPage(page, "/contracts");
  const table = tableByCaption(page, "契約一覧");
  const h = await headerIndex(table);
  const th = table.locator("thead th").nth(col(h, "予算"));
  const btn = th.locator("button.yn-sort");
  await expect(th).toHaveAttribute("aria-sort", "none");
  const values = async () => {
    const rows = dataRows(table);
    const n = await rows.count();
    const out: Array<{ text: string; value: number }> = [];
    for (let i = 0; i < n; i++) {
      const text = await cellText(rows.nth(i), col(h, "予算"));
      out.push({ text, value: parseNumber(text)! });
    }
    return out;
  };
  await btn.click();
  await expect(th).toHaveAttribute("aria-sort", "descending");
  // 他の見出しは none に戻る
  await expect(table.locator('thead th[aria-sort="descending"], thead th[aria-sort="ascending"]')).toHaveCount(1);
  const desc = await values();
  for (let i = 1; i < desc.length; i++) expect(desc[i]!.value, `${desc[i - 1]!.text} ≥ ${desc[i]!.text}`).toBeLessThanOrEqual(desc[i - 1]!.value);
  // 辞書順とは異なる並びであること（1,000,000 と 120,000 のような組が含まれる）
  const lexical = [...desc].sort((a, b) => b.text.localeCompare(a.text)).map((x) => x.text);
  expect(lexical, "数値順と辞書順が区別できるデータ").not.toEqual(desc.map((x) => x.text));
  await btn.click();
  await expect(th).toHaveAttribute("aria-sort", "ascending");
  const asc = await values();
  for (let i = 1; i < asc.length; i++) expect(asc[i]!.value).toBeGreaterThanOrEqual(asc[i - 1]!.value);
  expect(asc.map((x) => x.value)).toEqual([...desc.map((x) => x.value)].reverse());
  // 文字列列は昇順から
  const nameTh = table.locator("thead th").first();
  await nameTh.locator("button.yn-sort").click();
  await expect(nameTh).toHaveAttribute("aria-sort", "ascending");
  await expect(th).toHaveAttribute("aria-sort", "none");
  // 並べ替え後も件数は変わらない
  await expect(dataRows(table)).toHaveCount(desc.length);
});

test("絞り込み: 超過見込み / 消化率超過 / 速報含む / 期間外も表示 / 検索", async ({ page }) => {
  await gotoPage(page, "/contracts");
  const table = () => tableByCaption(page, "契約一覧");
  const all = contractsInPeriod(FY, undefined, model);
  const ex = new Map(all.map((r) => [r.contract.contractId, contractRowExpected(r, FY, "recent3", model)]));
  const expectRows = async (ids: string[], label: string) => {
    if (ids.length === 0) {
      await expect(page.getByText("該当する契約がありません"), label).toBeVisible();
      return;
    }
    // 絞り込みは入力イベント → セル再計算で反映されるので、期待の集合になるまで待つ
    await expect
      .poll(async () => ((await table().count()) ? [...(await rowKeys(table()))].sort() : []), { message: label, timeout: 10_000 })
      .toEqual([...ids].sort());
    await expect(page.locator(".yn-table-count")).toHaveText(`${ids.length} 件`);
  };
  // 超過見込み
  const deficit = [...ex].filter(([, e]) => e.isDeficit).map(([id]) => id);
  expect(deficit).toContain("C008");
  await page.locator("#yn-f-deficit").check();
  await expectRows(deficit, "超過見込み");
  const h = await headerIndex(table());
  for (const id of deficit) expect(await cellText(table().locator(`tbody tr[data-key="${id}"]`), col(h, "状態"))).toContain("超過見込み");
  await page.locator("#yn-f-deficit").uncheck();
  await expectRows([...ex.keys()], "解除");
  // 消化率超過
  const over = [...ex].filter(([, e]) => e.isOverBudget).map(([id]) => id);
  await page.locator("#yn-f-over").check();
  await expectRows(over, "消化率超過");
  for (const id of over) expect(await cellText(table().locator(`tbody tr[data-key="${id}"]`), col(h, "状態"))).toContain("消化率超過");
  await page.locator("#yn-f-over").uncheck();
  // 速報含む
  const prelim = [...ex].filter(([, e]) => e.includesPreliminary).map(([id]) => id);
  await page.locator("#yn-f-prelim").check();
  await expectRows(prelim, "速報含む");
  await page.locator("#yn-f-prelim").uncheck();
  // 検索（顧客名）: さくら製菓は FY2026 の C005 だけ（C014 は前年度で期間外）
  const search = page.locator("#yn-f-text");
  await search.fill("さくら");
  await expectRows(["C005"], "検索 さくら");
  // 期間外の契約も表示 → C014 も出る
  await page.locator("#yn-f-showOutside").check();
  await expectRows(["C005", "C014"], "検索 さくら + 期間外");
  await page.locator("#yn-f-showOutside").uncheck();
  // 契約ID で検索
  await search.fill("c008");
  await expectRows(["C008"], "検索 c008（大文字小文字を区別しない）");
  // チーム名で検索
  const tree = treeAt(FY.to, model);
  const teamName = tree["T121"]!.name;
  await search.fill(teamName);
  await expectRows(contractsInPeriod(FY, teamContractIds("T121", FY, model), model).map((r) => r.contract.contractId), `検索 ${teamName}`);
  // 該当なし
  await search.fill("存在しない契約 zzz");
  await expectRows([], "該当なし");
  await search.fill("");
  await expectRows([...ex.keys()], "検索解除");
  // URL の f= / q= で初期状態を与えられる
  await gotoPage(page, "/contracts?f=deficit&q=C0");
  await expect(page.locator("#yn-f-deficit")).toBeChecked();
  await expect(search).toHaveValue("C0");
  await expectRows(deficit, "URL f=deficit&q=C0");
});

test("Excel 出力: .xlsx がダウンロードされ、見出しと数値が表と一致する", async ({ page }) => {
  // 表を円で出して（URL に unit=yen）、Excel の円の整数と厳密に比べる。表示単位が変わっても Excel は円（下で確認）
  await gotoPage(page, "/contracts?unit=yen");
  const table = tableByCaption(page, "契約一覧");
  const h = await headerIndex(table);
  // 表の現在の並び（既定: 状態 → 消化率）で値を控える
  const rows = dataRows(table);
  const n = await rows.count();
  const seen: Array<{ id: string; budget: number; cost: number; gp: number; forecast: number | null }> = [];
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    seen.push({
      id: (await row.getAttribute("data-key"))!,
      budget: parseNumber(await cellText(row, col(h, "予算")))!,
      cost: parseNumber(await cellText(row, col(h, "実績")))!,
      gp: parseNumber(await cellText(row, col(h, "残予算")))!,
      forecast: parseNumber(await cellText(row, col(h, "着地差"))),
    });
  }
  const exportBtn = page.locator(".yn-table-block").filter({ has: table }).locator(".yn-table-toolbar .yn-export");
  await expect(exportBtn).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await exportBtn.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  expect(download.suggestedFilename()).toBe(`contracts_${FY.from}_${FY.to}.xlsx`);
  const path = await download.path();
  expect(path).toBeTruthy();
  const wb = XLSX.readFile(path!);
  const sheetName = wb.SheetNames[0]!;
  const ws = wb.Sheets[sheetName]!;
  const aoa = XLSX.utils.sheet_to_json<Array<string | number | null>>(ws, { header: 1, defval: null });
  // 1 行目は単位の注記、見出しは「契約ID」を含む最初の行
  const headerRow = aoa.findIndex((r) => r.some((c) => c === "契約ID"));
  expect(headerRow, "見出し行（契約ID を含む行）がある").toBeGreaterThanOrEqual(0);
  if (headerRow > 0) expect(String(aoa[0]![0] ?? ""), "先頭行は単位の注記").toContain("単位");
  const header = aoa[headerRow]!.map((x) => String(x ?? ""));
  for (const label of ["契約ID", "顧客", "案件", "チーム", "契約期間", "予算（円）", "実績（円）", "残予算（円）", "残予算率（%）", "消化率（%）", "着地差（円）", "状態"]) {
    expect(header, `見出し ${label}`).toContain(label);
  }
  const rowsAll = aoa.slice(headerRow + 1).filter((r) => r.some((c) => c !== null && c !== ""));
  // 最終行は画面の合計行と同じ
  const total = rowsAll.at(-1)!;
  expect(String(total[0]), "最終行は合計行").toMatch(/^合計/);
  const body = rowsAll.slice(0, -1);
  expect(body.length, "行数 = 表示中の行数 + 合計行").toBe(seen.length);
  const bi = header.indexOf("予算（円）");
  expect(total[bi], "合計行の予算 = 各行の合計").toBe(body.reduce((a, r) => a + Number(r[bi]), 0));
  const ci = (label: string) => header.indexOf(label);
  for (let i = 0; i < seen.length; i++) {
    const r = body[i]!;
    const s = seen[i]!;
    expect(r[ci("契約ID")], `行 ${i} の契約ID（並び順も同じ）`).toBe(s.id);
    expect(typeof r[ci("予算（円）")], "金額は数値セル").toBe("number");
    expect(r[ci("予算（円）")]).toBe(s.budget);
    expect(r[ci("実績（円）")]).toBe(s.cost);
    expect(r[ci("残予算（円）")]).toBe(s.gp);
    expect(r[ci("着地差（円）")]).toBe(s.forecast);
    const e = contractRowExpected(contractResult(s.id, model), FY, "recent3", model);
    expect(r[ci("予算（円）")]).toBe(e.totals.budget);
    const margin = r[ci("残予算率（%）")];
    if (e.totals.grossMargin !== null) expect(margin).toBeCloseTo(Math.round(e.totals.grossMargin * 1000) / 10, 6);
    const cust = contractResult(s.id, model).contract.customerName;
    expect(r[ci("顧客")]).toBe(cust);
  }
  // 表示単位が 百万円（既定）・千円 でも Excel の金額は円の整数（見出しも「（円）」のまま）
  const bodyYen = body.map((r) => ({ id: String(r[ci("契約ID")]), budget: r[ci("予算（円）")], cost: r[ci("実績（円）")] }));
  for (const unit of ["m", "k"] as const) {
    await page.locator(`.yn-seg-btn[data-unit=${unit}]`).click();
    await expect(page.locator(`.yn-seg-btn[data-unit=${unit}]`)).toHaveAttribute("aria-pressed", "true");
    const first = dataRows(tableByCaption(page, "契約一覧")).first();
    await expect(cell(first, col(h, "予算"))).toContainText(UNIT_LABEL[unit]);
    const dl2 = page.waitForEvent("download");
    await page.locator(".yn-table-block").filter({ has: tableByCaption(page, "契約一覧") }).locator(".yn-export").click();
    const d2 = await dl2;
    const wb2 = XLSX.readFile((await d2.path())!);
    const aoa2 = XLSX.utils.sheet_to_json<Array<string | number | null>>(wb2.Sheets[wb2.SheetNames[0]!]!, { header: 1, defval: null });
    const headerRow2 = aoa2.findIndex((r) => r.some((c) => c === "契約ID"));
    const header2 = aoa2[headerRow2]!.map((x) => String(x ?? ""));
    expect(header2, `表示単位 ${unit} でも見出しは円`).toContain("予算（円）");
    expect(header2.some((x) => /（(百万円|千円)）/.test(x)), `表示単位 ${unit} の見出しが混ざらない`).toBe(false);
    const rows2 = aoa2.slice(headerRow2 + 1).filter((r) => r.some((c) => c !== null && c !== "") && !/^合計/.test(String(r[0])));
    expect(rows2.length).toBe(bodyYen.length);
    for (let i = 0; i < rows2.length; i++) {
      const id = String(rows2[i]![header2.indexOf("契約ID")]);
      const e = contractRowExpected(contractResult(id, model), FY, "recent3", model);
      expect(rows2[i]![header2.indexOf("予算（円）")], `${unit}: ${id} 予算（円）`).toBe(e.totals.budget);
      expect(rows2[i]![header2.indexOf("実績（円）")], `${unit}: ${id} 実績（円）`).toBe(e.totals.cost);
    }
    // 表示は選択単位（core の値を同じ書式で丸めたもの）
    const e0 = contractRowExpected(contractResult((await first.getAttribute("data-key"))!, model), FY, "recent3", model);
    expect(await cellText(first, col(h, "予算"))).toBe(yen(e0.totals.budget, unit));
  }
});
