/**
 * 設定画面のバージョン情報（SPEC §59）: package.json の version・ビルドしたコミット・ビルド日時
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { test, expect, gotoPage } from "./helpers/app.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

test("設定画面の一番下にバージョン・コミット・ビルド日時が出る", { tag: "@smoke" }, async ({ page }) => {
  await gotoPage(page, "/settings");
  const section = page.locator('[data-role="version"]');
  await expect(section.getByRole("heading", { name: "バージョン情報" })).toBeVisible();
  await expect(section.locator('[data-version="version"]')).toHaveText(pkg.version);
  const head = execFileSync("git", ["rev-parse", "HEAD"]).toString().trim();
  const commit = (await section.locator('[data-version="commit"]').textContent())?.trim() ?? "";
  expect(commit).toMatch(/^[0-9a-f]{7,}$/);
  // ビルドの後にコミットすることがあるので、ビルドしたコミットが今の履歴にあることだけ見る（無ければ例外）
  execFileSync("git", ["merge-base", "--is-ancestor", commit, head], { stdio: "ignore" });
  await expect(section.locator('[data-version="built-at"]')).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  // 設定画面の最後のセクション
  await expect(page.locator(".yn-settings > section").last()).toHaveAttribute("data-role", "version");
});

test("バージョン情報は設定画面だけに出す", async ({ page }) => {
  await gotoPage(page, "/");
  await expect(page.locator('[data-role="version"]')).toHaveCount(0);
});

for (const width of [390, 1280]) {
  test(`バージョン情報がはみ出さない（${width}px）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await gotoPage(page, "/settings");
    const section = page.locator('[data-role="version"]');
    await expect(section).toBeVisible();
    const over = await section.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(over).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
