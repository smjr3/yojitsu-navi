// README の画面のスクリーンショット（docs/screenshots/*.png）を今の dist/ から撮り直す
//   npm run build && npm run screenshots
//   PW_CHROMIUM_PATH=<chromium の実行ファイル>  Playwright 同梱のブラウザと版がずれている環境で指定
// 画面を変えた PR では撮り直す（CONTRIBUTING.md）。ここに無い画像は README から参照しない。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "docs", "screenshots");
const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;

/** [ファイル名, パス, 設定] */
const SHOTS = [
  ["index", "/"],
  ["teams", "/teams"],
  ["contracts", "/contracts"],
  ["contract", "/contract?id=C008"],
  ["customers", "/customers"],
  ["members", "/members"],
  ["workload", "/workload"],
  ["plan", "/plan?team=S11"],
  ["masters", "/masters"],
  ["data-check", "/data-check"],
  ["breakdown", "/", { breakdown: true }],
  ["index-dark", "/", { dark: true }],
  ["index-phone", "/", { width: 390, height: 844 }],
];

if (!existsSync(join(ROOT, "dist", "index.html"))) {
  console.error("dist/ がありません。先に npm run build を実行してください");
  process.exit(1);
}

const server = spawn(process.execPath, [join(ROOT, "tests", "e2e", "serve.mjs"), join(ROOT, "dist"), String(PORT)], { stdio: "ignore" });
const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
let failed = false;
try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/__health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  // 撮り直さない古い画像を残さない
  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT)) if (f.endsWith(".png")) rmSync(join(OUT, f));

  for (const [name, path, opt = {}] of SHOTS) {
    const context = await browser.newContext({ viewport: { width: opt.width ?? 1280, height: opt.height ?? 860 }, deviceScaleFactor: 1, colorScheme: opt.dark ? "dark" : "light" });
    await context.addInitScript((dark) => {
      try {
        localStorage.setItem("yn-theme", dark ? "dark" : "light");
        localStorage.removeItem("yojitsu-navi:masters-draft:v1");
      } catch {}
    }, !!opt.dark);
    const page = await context.newPage();
    await page.goto(BASE + path);
    await page.locator("#page-skeleton").waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
    await page.locator("h1").first().waitFor({ timeout: 30_000 });
    if (opt.breakdown) {
      await page.locator(".yn-kpi button").first().click();
      await page.locator("dialog[open]").waitFor();
    }
    // 同梱フォント（SPEC §46）が読み込まれてから撮る
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    console.log(`docs/screenshots/${name}.png`);
    await context.close();
  }
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
