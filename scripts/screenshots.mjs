// README のスクリーンショット（docs/screenshots/*.png）を今の画面で撮り直す
//   npm run build && npm run screenshots
// - dist/ を小さな静的サーバで配信し、Playwright（Chromium）で撮る
// - 下の SHOTS に無い PNG は消す（古い画像を残さない）
// - 画面を変えた PR では撮り直して README と一緒にコミットする（docs/UI_NOTES.md「ドキュメントの更新」）
import { spawn } from "node:child_process";
import { readdirSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const OUT = "docs/screenshots";
const PORT = Number(process.env.SHOTS_PORT ?? 4690);
const BASE = `http://localhost:${PORT}`;

/** name → 撮り方。width は画面幅、full はページ全体、prepare は撮る前の操作 */
const SHOTS = [
  { name: "index", path: "/" },
  { name: "index-dark", path: "/", theme: "dark" },
  { name: "index-phone", path: "/", width: 390, height: 844, full: false },
  { name: "teams", path: "/teams" },
  { name: "teams-1024", path: "/teams", width: 1024 },
  { name: "contracts", path: "/contracts" },
  { name: "contracts-1024", path: "/contracts", width: 1024 },
  { name: "contract", path: "/contract?id=C008" },
  { name: "workload", path: "/workload" },
  {
    name: "breakdown",
    path: "/",
    full: false,
    prepare: async (page) => {
      await page.locator(".yn-kpi-grid").first().locator(".yn-kpi").nth(1).locator(".yn-kpi-value").click();
      await page.locator("dialog.yn-dialog[open]").waitFor();
    },
  },
  { name: "data-check", path: "/data-check" },
  { name: "rules", path: "/rules" },
  {
    name: "plan",
    path: "/plan?team=T111",
    prepare: async (page) => {
      await page.locator('[data-fk="plan:toggle:M010"]').click();
      for (const b of await page.locator('tr.yn-me-plan-sub[data-member="M010"] [data-fk^="plan:hist:"]').all()) await b.click();
    },
    clip: "#yn-me-panel",
  },
  {
    name: "masters",
    path: "/masters",
    prepare: async (page) => {
      await page.getByRole("tab", { name: /単価/ }).click();
      await page.locator('tr.yn-me-group[data-group="主任"] .yn-me-hist-toggle').click();
    },
    clip: "#yn-me-panel",
  },
];

async function waitHealthy() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/__health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

const server = spawn(process.execPath, ["tests/e2e/serve.mjs", "dist", String(PORT)], { stdio: "ignore" });
try {
  await waitHealthy();
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
  for (const s of SHOTS) {
    const ctx = await browser.newContext({ viewport: { width: s.width ?? 1280, height: s.height ?? 900 }, deviceScaleFactor: 1 });
    await ctx.addInitScript((t) => {
      try {
        localStorage.setItem("yn-theme", t);
        localStorage.removeItem("yojitsu-navi:masters-draft:v1");
      } catch {}
    }, s.theme ?? "light");
    const page = await ctx.newPage();
    await page.goto(BASE + s.path);
    await page.locator("#page-skeleton").waitFor({ state: "detached", timeout: 20000 }).catch(() => {});
    await page.locator("h1").first().waitFor();
    await page.waitForTimeout(800);
    if (s.prepare) await s.prepare(page);
    // ホバーの色が写らないよう、マウスを画面の外寄りへ
    await page.mouse.move((s.width ?? 1280) - 2, (s.height ?? 900) - 2);
    await page.waitForTimeout(300);
    const file = join(OUT, `${s.name}.png`);
    if (s.clip) await page.locator(s.clip).screenshot({ path: file });
    else await page.screenshot({ path: file, fullPage: s.full !== false });
    console.log("✓", file);
    await ctx.close();
  }
  await browser.close();
  const keep = new Set(SHOTS.map((s) => `${s.name}.png`));
  for (const f of readdirSync(OUT)) {
    if (f.endsWith(".png") && !keep.has(f)) {
      rmSync(join(OUT, f));
      console.log("− removed", join(OUT, f));
    }
  }
} finally {
  server.kill();
}
