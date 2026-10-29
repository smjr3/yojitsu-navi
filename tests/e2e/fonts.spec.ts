/**
 * 画面フォント（SPEC §44）: 同梱の BIZ UDPゴシックが読み込まれ、外部に取りに行かず、数字の桁がそろう
 */
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";

const PAGES = ["/", "/contracts", "/plan", "/settings"];

test.describe("画面フォント", () => {
  test("各画面で同梱フォント（400・700）が読み込まれ、外部への通信がない", { tag: "@smoke" }, async ({ page }) => {
    const external: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.protocol.startsWith("http") && u.hostname !== "127.0.0.1" && u.hostname !== "localhost") external.push(r.url());
    });
    for (const path of PAGES) {
      await gotoPage(page, path);
      const faces = await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(["400", "700"].map((w) => document.fonts.load(`${w} 16px "YN BIZ UDPGothic"`, "予実0123")));
        return [...document.fonts].filter((f) => f.family.replace(/"/g, "") === "YN BIZ UDPGothic").map((f) => `${f.weight}:${f.status}`).sort();
      });
      expect(faces, path).toEqual(["400:loaded", "700:loaded"]);
      expect(await page.locator("h1").first().evaluate((e) => getComputedStyle(e).fontFamily)).toMatch(/^"YN BIZ UDPGothic"/);
    }
    expect(external).toEqual([]);
  });

  test("数字 0〜9 の幅がすべて同じ（表の桁がそろう）・ライト/ダーク", async ({ page }) => {
    for (const dark of [false, true]) {
      if (dark) await useDarkTheme(page);
      await gotoPage(page, "/contracts");
      const widths = await page.evaluate(async () => {
        await document.fonts.ready;
        const out: Record<string, number[]> = {};
        for (const w of ["400", "700"]) {
          await document.fonts.load(`${w} 20px "YN BIZ UDPGothic"`, "0123456789");
          const s = document.createElement("span");
          s.style.cssText = `position:absolute;font:${w} 20px "YN BIZ UDPGothic";font-variant-numeric:normal`;
          document.body.append(s);
          out[w] = [..."0123456789"].map((d) => {
            s.textContent = d.repeat(10);
            return Math.round(s.getBoundingClientRect().width * 10) / 10;
          });
          s.remove();
        }
        return out;
      });
      for (const [w, list] of Object.entries(widths)) expect(new Set(list).size, `${w} ${list.join(",")}`).toBe(1);
    }
  });
});
