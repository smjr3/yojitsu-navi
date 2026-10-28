/**
 * 閲覧画面のレビュー指摘（M3 / M5 / L1 / L2 / L3 / L4 / L6 / L9）の回帰テスト
 *   M3  チーム詳細のメンバー別原価の根拠パネルは、選択単位に関係なく円
 *   M5  明細の表（作業ログ・メンバー別原価・メンバー詳細の月別/契約別/単価）は選択単位に関係なく円で、見出しに「（円）」。
 *       メンバー一覧の行（メンバー×期間の集計）は選択単位に従う。差額に添える文は丸め後の値で判定
 *   L1  「単価なし」は赤にしない（neutral）
 *   L2  顧客詳細の担当チーム行 → 契約一覧は顧客キー（厳密）＋チームで絞り、件数が行と一致する
 *   L3  顧客詳細はチーム絞り込みを引き継ぎ、数字が変わることを注記する
 *   L4  メンバー別をチームで絞っても、期間全体の計画の対象が経過月だけで決まらない
 *   L6  合計行の着地粗利は年度内の契約が 0 件なら「—」
 *   L9  メンバー列は名前順、検索欄の案内にチームが入る
 * 既定単位（百万円）で開いて「単位に従わない」ことを確かめる。
 */
import { createRequire } from "node:module";
import { aggregateMembers, contractsForTeam, groupByCustomer } from "../../src/core/index.js";
import { test, expect, gotoPage, tableByCaption, dataRows, headerIndex, col, cell, cellText, kpiValue, dialog, dialogRow, rowKeys, parseNumber, query } from "./helpers/app.js";
import { aggregate, contractResult, fiscalPeriod, getModel, treeAt, yen } from "./helpers/core.js";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx") as typeof import("xlsx");

const model = getModel();
const FY = fiscalPeriod(model);
const ASOF = model.meta.asOfMonth;
const groups = groupByCustomer(model.contracts.map((r) => r.contract));
const tree = treeAt(FY.to, model);

/** 円表示（"1,234円" / "-1,234円" / "+1,234円" / "±0円"）。百万円・千円は含まない */
const YEN_TEXT = /^[+±-]?[\d,]+円$/;

const inFy = (ids: readonly string[]) => aggregate(model, { period: FY, contractIds: ids as string[] });

async function expectAllYen(table: ReturnType<typeof tableByCaption>, label: string) {
  const h = await headerIndex(table);
  const rows = dataRows(table);
  const n = await rows.count();
  expect(n, `${label}: 行がある`).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) expect(await cellText(rows.nth(i), col(h, label)), `${label} の ${i} 行目`).toMatch(YEN_TEXT);
}

test.describe("M5 明細の表は常に円（既定の百万円で開く）", () => {
  test("契約詳細: 作業ログ表（単価・金額）とメンバー別の原価が円で、見出しに（円）", async ({ page }) => {
    await gotoPage(page, "/contract?id=C008&unit=m");
    // KPI・月ごとの予実は選択単位（百万円）に従う
    await expect(kpiValue(page, 0)).toContainText("百万円");

    const members = tableByCaption(page, "メンバー別の原価");
    const mh = await headerIndex(members);
    expect([...mh.keys()]).toContain("原価（円）");
    await expectAllYen(members, "原価");
    // 値は core の原価行の合計と一致
    const r = contractResult("C008", model);
    const byMember = new Map<string, number>();
    for (const m of r.months) if (m.month >= FY.from && m.month <= FY.to) for (const l of m.costLines) byMember.set(l.memberId, (byMember.get(l.memberId) ?? 0) + l.amount);
    for (const [id, amount] of byMember) expect(await cellText(members.locator(`tbody tr[data-key="${id}"]`), col(mh, "原価"))).toBe(yen(amount));

    await page.getByRole("button", { name: "作業ログを読み込む" }).click();
    const wl = tableByCaption(page, "作業ログ");
    await expect(wl).toBeVisible();
    const wh = await headerIndex(wl);
    expect([...wh.keys()]).toEqual(expect.arrayContaining(["単価（円）", "金額（円）"]));
    await expectAllYen(wl, "金額");
    await expectAllYen(wl, "単価");
    const total = r.months.filter((m) => m.month >= FY.from && m.month <= FY.to).reduce((s, m) => s + m.cost, 0);
    expect(await cellText(wl.locator("tfoot tr"), col(wh, "金額"))).toBe(yen(total));
  });

  test("チーム詳細: メンバー別の原価が円。根拠パネル（M3）も円", async ({ page }) => {
    await gotoPage(page, "/team?id=S21&unit=m");
    const table = tableByCaption(page, "メンバー別の原価");
    const h = await headerIndex(table);
    expect([...h.keys()]).toContain("原価（円）");
    await expectAllYen(table, "原価");
    const key = (await rowKeys(table))[0]!;
    const amountText = await cellText(table.locator(`tbody tr[data-key="${key}"]`), col(h, "原価"));
    await table.locator(`tbody tr[data-key="${key}"] td button.yn-num`).nth(1).click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    // 根拠は常に円: 「原価合計」も原価行の金額も、フッターの合計も 百万円/千円 を含まない
    expect(await dialogRow(page, "原価合計")).toBe(amountText);
    await expect(d).not.toContainText("百万円");
    await expect(d).not.toContainText("千円");
    const lines = d.locator("table tbody tr");
    const n = await lines.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) expect(await cellText(lines.nth(i), 4)).toMatch(/^-?[\d,]+円$/);
    expect(await cellText(d.locator("table tfoot tr"), 4)).toBe(amountText);
    await page.keyboard.press("Escape");
  });

  test("メンバー詳細: 月ごと・契約別・単価の表が円。KPI は選択単位", async ({ page }) => {
    await gotoPage(page, "/member?id=M019&unit=m");
    await expect(kpiValue(page, 0)).toContainText("百万円");
    for (const [caption, labels] of [
      ["月ごとの計画と実績", ["計画原価", "実績原価", "差額"]],
      ["契約別の計画と実績", ["計画原価", "実績原価", "差額"]],
      ["単価の変遷", ["時間単価"]],
    ] as const) {
      const table = tableByCaption(page, caption);
      await expect(table).toBeVisible();
      const h = await headerIndex(table);
      for (const label of labels) {
        const head = [...h.keys()].find((k) => k.startsWith(label));
        expect(head, `${caption} の「${label}」見出し`).toContain("（円）");
        const rows = dataRows(table);
        const n = await rows.count();
        for (let i = 0; i < n; i++) {
          const t = await cellText(rows.nth(i), col(h, label));
          // 未来月の実績・差額は「—」、単価なしは文言
          if (t === "—" || /単価なし/.test(t)) continue;
          expect(t, `${caption} ${label} ${i} 行目`).toMatch(YEN_TEXT);
        }
      }
    }
  });

  test("メンバー一覧: 行（メンバー×期間の集計）は選択単位に従う（決定）。KPI の差額の文は丸め後で判定", async ({ page }) => {
    await gotoPage(page, "/members?unit=m");
    const table = tableByCaption(page, "メンバー別の計画と実績");
    const h = await headerIndex(table);
    expect([...h.keys()].some((k) => k.startsWith("計画原価"))).toBe(true);
    expect([...h.keys()].some((k) => k.includes("（円）"))).toBe(false);
    expect(await cellText(dataRows(table).first(), col(h, "計画原価"))).toContain("百万円");
    // 差額タイルの文 = 表示（百万円に丸めた値）の符号
    const cmp = { from: FY.from, to: FY.to < ASOF ? FY.to : ASOF };
    const v = aggregateMembers(model, { period: cmp }).total.variance;
    const r = Math.round(v / 100_000) / 10;
    const expected = r > 0 ? "計画より原価が少ない" : r < 0 ? "計画より原価が多い" : "計画どおり";
    await expect(page.locator(".yn-kpi-grid").first().locator(".yn-kpi").nth(2)).toContainText(expected);
  });

  test("Excel 出力の金額は従来どおり円の整数（列名に（円））", async ({ page }) => {
    await gotoPage(page, "/team?id=S21&unit=m");
    const table = tableByCaption(page, "メンバー別の原価");
    const h = await headerIndex(table);
    const key = (await rowKeys(table))[0]!;
    const shown = parseNumber(await cellText(table.locator(`tbody tr[data-key="${key}"]`), col(h, "原価")))!;
    const dl = page.waitForEvent("download");
    await page.locator(".yn-table-block").filter({ has: table }).locator(".yn-export").click();
    const d = await dl;
    const wb = XLSX.readFile((await d.path())!);
    const aoa = XLSX.utils.sheet_to_json<Array<string | number | null>>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, defval: null });
    const hr = aoa.findIndex((r) => r.some((c) => c === "原価（円）"));
    expect(hr).toBeGreaterThanOrEqual(0);
    const header = aoa[hr]!.map((x) => String(x ?? ""));
    const row = aoa.slice(hr + 1).find((r) => String(r[0] ?? "").includes(key) || r.some((c) => c === shown));
    expect(row![header.indexOf("原価（円）")]).toBe(shown);
  });
});

test.describe("L1 単価なしは赤にしない", () => {
  const withMissing = model.contracts.find((r) => r.months.some((m) => m.costLines.some((l) => l.rateMissing)))!;
  const tid = withMissing.contract.teamId!;

  test("契約詳細とチーム詳細の『単価なし』チップは neutral", async ({ page }) => {
    await gotoPage(page, `/contract?id=${withMissing.contract.contractId}&unit=yen`);
    const chip = tableByCaption(page, "メンバー別の原価").locator(".yn-chip", { hasText: "単価なし" }).first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveClass(/yn-chip-neutral/);
    await expect(page.locator(".yn-chip-danger", { hasText: "単価なし" })).toHaveCount(0);
    await expect(page.locator(".yn-danger-text", { hasText: "単価なし" })).toHaveCount(0);

    await gotoPage(page, `/team?id=${tid}&unit=yen`);
    await expect(page.locator(".yn-chip-danger", { hasText: "単価なし" })).toHaveCount(0);
    await expect(tableByCaption(page, "メンバー別の原価").locator(".yn-chip-neutral", { hasText: "単価なし" }).first()).toBeVisible();
  });

  test("根拠パネルの原価行の『単価なし』も赤くない", async ({ page }) => {
    await gotoPage(page, `/contract?id=${withMissing.contract.contractId}&unit=yen`);
    const month = withMissing.months.find((m) => m.costLines.some((l) => l.rateMissing))!.month;
    const table = tableByCaption(page, "月ごとの予実");
    const h = await headerIndex(table);
    await cell(table.locator(`tbody tr[data-key="${month}"]`), col(h, "原価")).locator("button").click();
    const d = dialog(page);
    await expect(d.locator(".yn-chip", { hasText: "単価なし" }).first()).toBeVisible();
    await expect(d.locator(".yn-chip-danger")).toHaveCount(0);
  });
});

test.describe("L2 / L3 顧客詳細", () => {
  test("担当チーム行 → 契約一覧: 顧客キーで厳密に絞り、件数が行の契約数と一致する（全顧客・全行）", async ({ page }) => {
    for (const g of groups) {
      await gotoPage(page, `/customer?key=${encodeURIComponent(g.key)}&unit=yen`);
      const teams = tableByCaption(page, "担当チーム別");
      if ((await teams.count()) === 0) continue;
      const keys = await rowKeys(teams);
      for (const k of keys) {
        const h = await headerIndex(teams);
        const row = teams.locator("tbody tr[data-key]").filter({ has: page.locator(`xpath=self::tr[@data-key=${JSON.stringify(k)}]`) });
        const count = parseNumber(await cellText(row, col(h, "契約数")))!;
        await row.locator("a").first().click();
        await page.locator("#page-skeleton").waitFor({ state: "detached" }).catch(() => {});
        await expect(page.locator("h1").first()).toHaveText("契約一覧");
        expect(query(page).get("customer")).toBe(g.key);
        expect(query(page).get("team")).toBe(k);
        await expect(page.locator(".yn-note", { hasText: "だけを表示しています" })).toBeVisible();
        const table = tableByCaption(page, "契約一覧");
        if (count === 0) await expect(table).toHaveCount(0);
        else await expect(dataRows(table), `${g.key} / ${k}`).toHaveCount(count);
        // 全行がこの顧客の契約
        for (const id of await rowKeys(table)) expect(g.contractIds).toContain(id);
        await page.goBack();
        await page.locator("#page-skeleton").waitFor({ state: "detached" }).catch(() => {});
        await expect(tableByCaption(page, "担当チーム別")).toBeVisible();
      }
    }
  });

  test("契約一覧 ?customer=&direct=1: 主担当チームがちょうどそのチームの契約だけ（配下は含まない）", async ({ page }) => {
    // 上位チームの配下にだけ契約がある顧客: direct なしは配下の契約を含み、direct=1 は 0 件
    let pick: { team: string; key: string; inScope: string[]; direct: string[] } | null = null;
    for (const n of Object.values(tree)) {
      const ids = new Set(contractsForTeam(model, n.teamId, tree).map((c) => c.contractId));
      for (const g of groups) {
        const inScope = g.contractIds.filter((id) => ids.has(id) && inFy([id]).contractCount > 0);
        const direct = inScope.filter((id) => contractResult(id, model).contract.teamId === n.teamId);
        if (!pick && inScope.length > 0 && direct.length < inScope.length) pick = { team: n.teamId, key: g.key, inScope, direct };
      }
    }
    expect(pick, "配下にだけ契約がある顧客がいる").toBeTruthy();
    const { team, key, inScope, direct } = pick!;
    const base = `/contracts?team=${team}&customer=${encodeURIComponent(key)}&unit=yen&from=${FY.from}&to=${FY.to}`;

    await gotoPage(page, base);
    await expect(dataRows(tableByCaption(page, "契約一覧"))).toHaveCount(inScope.length);
    expect((await rowKeys(tableByCaption(page, "契約一覧"))).sort()).toEqual([...inScope].sort());

    await gotoPage(page, `${base}&direct=1`);
    if (direct.length === 0) await expect(page.getByText("該当する契約がありません")).toBeVisible();
    else await expect(dataRows(tableByCaption(page, "契約一覧"))).toHaveCount(direct.length);
    await expect(page.locator(".yn-note", { hasText: "配下のチームは含みません" })).toBeVisible();
  });

  test("未知の顧客キー: 警告と解除リンク、0 件。解除で全契約に戻る", async ({ page }) => {
    await gotoPage(page, "/contracts?customer=__nothing__&unit=yen");
    await expect(page.locator(".yn-note-warn", { hasText: "見つかりません" })).toBeVisible();
    await expect(page.getByText("該当する契約がありません")).toBeVisible();
    await page.getByRole("link", { name: "絞り込みを解除" }).click();
    await expect(dataRows(tableByCaption(page, "契約一覧")).first()).toBeVisible();
    expect(query(page).get("customer")).toBeNull();
  });

  test("L3: チームで絞ると顧客詳細もそのチームの契約だけで集計して注記を出す。含まないチームなら 0 件の警告。全体に戻すと注記は消える", async ({ page }) => {
    // ダミーデータは顧客が 1 つの系統に収まるので、「含む系統」と「含まない系統」で確かめる
    const g = groups.find((x) => x.contractIds.some((id) => (tree.D1?.descendantIds ?? []).includes(contractResult(id, model).contract.teamId ?? "")))!;
    const d1 = new Set(contractsForTeam(model, "D1", tree).map((c) => c.contractId));
    const scoped = g.contractIds.filter((id) => d1.has(id));
    expect(scoped.length).toBeGreaterThan(0);
    await gotoPage(page, `/customer?key=${encodeURIComponent(g.key)}&team=D1&unit=yen`);
    await expect(kpiValue(page, 0)).toHaveText(yen(inFy(scoped).budget));
    await expect(kpiValue(page, 1)).toHaveText(yen(inFy(scoped).cost));
    const note = page.locator(".yn-note", { hasText: "契約だけで集計しています" });
    await expect(note).toContainText(`全 ${g.contractIds.length} 件のうち ${scoped.length} 件`);
    await expect(page.locator("#yn-filter-team")).toHaveValue("D1");

    // 含まない系統（D2 など）: 警告つきで 0 件、画面は壊れない
    const other = "D2";
    await page.locator("#yn-filter-team").selectOption(other);
    const noneIds = new Set(contractsForTeam(model, other, tree).map((c) => c.contractId));
    const n = g.contractIds.filter((id) => noneIds.has(id)).length;
    await expect(page.locator(".yn-note", { hasText: "契約だけで集計しています" })).toContainText(`全 ${g.contractIds.length} 件のうち ${n} 件`);

    await page.locator("#yn-filter-team").selectOption("");
    await expect(page.locator(".yn-note", { hasText: "契約だけで集計しています" })).toHaveCount(0);
    await expect(kpiValue(page, 0)).toHaveText(yen(inFy(g.contractIds).budget));
  });

  test("顧客一覧 → 顧客詳細: 一覧の行の数字と詳細の KPI がチーム絞り込みでも一致する", async ({ page }) => {
    await gotoPage(page, "/customers?team=T111&unit=yen");
    const table = tableByCaption(page, "顧客一覧");
    const h = await headerIndex(table);
    const first = dataRows(table).first();
    const listed = await cellText(first, col(h, "原価"));
    await first.locator("a").first().click();
    await expect(page.locator(".yn-note", { hasText: "契約だけで集計しています" })).toBeVisible();
    await expect(kpiValue(page, 1)).toHaveText(listed);
  });
});

test.describe("L6 合計行の着地粗利は年度内 0 件なら —", () => {
  const g = groups.find((x) => x.contractIds.includes("C016"))!;
  const early = "2025-04";

  test("契約一覧: 年度に掛からない契約だけ表示しているとき", async ({ page }) => {
    await gotoPage(page, `/contracts?customer=${encodeURIComponent(g.key)}&from=${early}&to=${early}&unit=yen`);
    const table = tableByCaption(page, "契約一覧");
    const h = await headerIndex(table);
    await expect(dataRows(table)).toHaveCount(1);
    expect(await cellText(dataRows(table).first(), col(h, "着地粗利"))).toBe("—");
    expect(await cellText(table.locator("tfoot tr"), col(h, "着地粗利"))).toBe("—");
  });

  test("顧客一覧: 行と合計行の着地粗利が食い違わない（行が値を持つなら合計行も同じ値）", async ({ page }) => {
    await gotoPage(page, `/customers?q=${encodeURIComponent(g.label)}&from=${early}&to=${early}&unit=yen`);
    const table = tableByCaption(page, "顧客一覧");
    const h = await headerIndex(table);
    await expect(dataRows(table)).toHaveCount(1);
    const row = (await cellText(dataRows(table).first(), col(h, "着地粗利"))).replace(/\d+件$/, "");
    expect(await cellText(table.locator("tfoot tr"), col(h, "着地粗利"))).toBe(row);
  });

  test("年度内の契約があれば合計行に金額が出る（契約一覧・既定期間）", async ({ page }) => {
    await gotoPage(page, "/contracts?unit=yen");
    const table = tableByCaption(page, "契約一覧");
    const h = await headerIndex(table);
    expect(await cellText(table.locator("tfoot tr"), col(h, "着地粗利"))).not.toBe("—");
  });
});

test.describe("L4 / L9 メンバー一覧", () => {
  test("チーム絞り込みでも『期間全体の計画』が対象メンバーの期間全体の計画と一致する", async ({ page }) => {
    for (const team of ["T111", "S21", "T211"]) {
      const full = aggregateMembers(model, { period: FY });
      const ids = full.members.filter((m) => m.teamId && (tree[team]?.descendantIds ?? []).includes(m.teamId)).map((m) => m.memberId);
      if (ids.length === 0) continue;
      const expected = aggregateMembers(model, { period: FY, memberIds: ids });
      await gotoPage(page, `/members?team=${team}&unit=yen`);
      await expect(dataRows(tableByCaption(page, "メンバー別の計画と実績"))).toHaveCount(
        aggregateMembers(model, { period: { from: FY.from, to: FY.to < ASOF ? FY.to : ASOF }, memberIds: ids }).members.length,
      );
      const noteText = (await page.locator(".yn-note", { hasText: "期間全体の計画" }).first().textContent()) ?? "";
      expect(noteText).toContain(yen(expected.total.plannedCost));
    }
  });

  test("L9: メンバー列は名前順で並ぶ。検索欄の案内にチームが入り、チーム名でも絞れる", async ({ page }) => {
    await gotoPage(page, "/members?unit=yen");
    const search = page.locator("#yn-m-text");
    await expect(search).toHaveAttribute("placeholder", /チーム/);
    await expect(search).toHaveAttribute("aria-label", /チーム/);
    const table = tableByCaption(page, "メンバー別の計画と実績");
    await table.locator("thead th[data-key='memberName'] button").click();
    const names = await dataRows(table).evaluateAll((trs) => trs.map((tr) => tr.querySelector(".yn-cell-main")?.textContent ?? ""));
    const sorted = [...names].sort((a, b) => a.localeCompare(b, "ja"));
    expect(names).toEqual(sorted);
    // チーム名で検索できる
    const teamName = tree[model.members.find((m) => m.teamId && tree[m.teamId])!.teamId!]!.name;
    await search.fill(teamName);
    await expect.poll(async () => dataRows(table).count()).toBeGreaterThan(0);
    await expect.poll(async () => dataRows(table).count()).toBeLessThan(names.length + 1);
  });
});
