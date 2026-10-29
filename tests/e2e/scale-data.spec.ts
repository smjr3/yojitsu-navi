/**
 * 実運用規模のデータ（退職者・長い名前・0 の月）で崩れないこと（SPEC §35、docs/DUMMY_DATA.md）
 *   - 退職者: 一覧・詳細・リソース計画に「退職」が出る。退職後の計画は警告チップ
 *   - 値がすべて 0 のグラフ: 棒が全高で描かれず、目盛りが 0.000000 にならない
 *   - 長い案件名・顧客名・作業名: 390px でもページが横にはみ出さない
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, gotoPage } from "./helpers/app.js";
import { ROOT_DIR } from "./constants.js";
import { buildMastersPayload } from "../../src/data/_masters.js";
import { parseMasterDoc, planSourcesFromDocs } from "../../src/core/masterEdit.js";
import { planView } from "../../src/core/plan.js";

const PAYLOAD = buildMastersPayload(ROOT_DIR);
const FY = Array.from({ length: 12 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 3 + i, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
});
const memberLines = readFileSync(join(ROOT_DIR, "data/masters/members.csv"), "utf-8").trim().split("\n");
const header = memberLines[0]!.split(",");
const rows = memberLines.slice(1).map((l) => Object.fromEntries(l.split(",").map((v, i) => [header[i], v])) as Record<string, string>);
/** 今年度より前に退職し、今年度は計画も実績も無い人 */
const leftBefore = rows.find((r) => r.status === "退職" && r.effective_from! < FY[0]!)!;

test("退職者の詳細: 退職チップと最後の所属。すべて 0h のグラフは全高の棒にならない", async ({ page }) => {
  expect(leftBefore, "今年度より前に退職した人がダミーデータにいる").toBeTruthy();
  await gotoPage(page, `/member?id=${leftBefore.member_id}`);
  await expect(page.locator("h1")).toHaveText(leftBefore.name!);
  await expect(page.locator(".yn-chip", { hasText: "退職" }).first()).toBeVisible();
  await expect(page.getByText(/退職（最後の所属:/)).toBeVisible();
  const svg = page.locator("figure svg, .yn-chart svg").first();
  await expect(svg).toBeVisible();
  await expect(svg).not.toContainText("0.000000");
  // 棒（rect）の高さは 0 に近い（domain が [0,0] だと全高になる）
  const heights = await svg.locator("rect").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  const plotH = (await svg.boundingBox())!.height;
  expect(heights.filter((h) => h > plotH * 0.5).length, "全高に近い棒が無い").toBeLessThanOrEqual(1); // 未来月の背景の帯だけ
});

test("メンバー一覧: 退職者に退職チップ（色だけに頼らず文字）", async ({ page }) => {
  await gotoPage(page, "/members");
  const left = page.locator("tbody tr").filter({ has: page.locator(".yn-chip", { hasText: "退職" }) });
  expect(await left.count()).toBeGreaterThan(0);
});

test("リソース計画: 退職後に残った計画は行に「退職後の計画」の警告チップ", async ({ page }) => {
  const docs = {
    teams: parseMasterDoc("teams", PAYLOAD.files.teams.text),
    members: parseMasterDoc("members", PAYLOAD.files.members.text),
    assignments: parseMasterDoc("assignments", PAYLOAD.files.assignments.text),
  };
  const view = planView(planSourcesFromDocs(docs, PAYLOAD.context.contracts), null, FY);
  const target = view.rows.find((r) => r.afterLeftMonths.length > 0);
  expect(target, "退職後の計画が残っている人がダミーデータにいる").toBeTruthy();
  await page.addInitScript(() => localStorage.removeItem("yojitsu-navi:masters-draft:v1"));
  await gotoPage(page, "/plan");
  const row = page.locator(`tr.yn-me-plan-row[data-member="${target!.memberId}"]`);
  await row.scrollIntoViewIfNeeded();
  await expect(row).toContainText(`退職後の計画 ${target!.afterLeftMonths.length}か月`);
  await expect(row.locator("td.yn-me-plan-cell.is-left").first()).toBeVisible();
});

for (const path of ["/contracts", "/customers", "/workload", "/members", "/teams"]) {
  test(`390px: 長い名前でも ${path} が横にはみ出さない`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoPage(page, path);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over).toBeLessThanOrEqual(1);
  });
}

for (const path of ["/teams", "/contracts", "/customer?key=" + encodeURIComponent("青葉物流"), "/members"]) {
  test(`1280px: 長い組織名・作業種別名でも ${path} の表が横スクロールにならない`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoPage(page, path);
    const over = await page.evaluate(() =>
      [...document.querySelectorAll(".yn-table-scroll")]
        .filter((e) => e.scrollWidth - e.clientWidth > 1)
        .map((e) => e.querySelector("caption")?.textContent ?? "?"),
    );
    expect(over).toEqual([]);
  });
}
