// ファビコンのファイルを作り直す（SPEC §89）: node scripts/make-favicons.mjs
// src/components/favicon.js の FAVICON_SVG から src/icons/ の favicon.svg・favicon-32.png・apple-touch-icon.png を作る。
// PNG は Playwright の Chromium で描く（開発環境だけで使う。利用環境のビルドでは使わない）。
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FAVICON_SVG } from "../src/components/favicon.js";

const OUT = join(fileURLToPath(import.meta.url), "..", "..", "src", "icons");
const { chromium } = createRequire(import.meta.url)("playwright");

writeFileSync(join(OUT, "favicon.svg"), `${FAVICON_SVG}\n`);
const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
// iPhone のホーム画面は OS が角を丸めるので、apple-touch-icon は角丸なしで塗りつぶす
for (const [name, size, svg] of [
  ["favicon-32.png", 32, FAVICON_SVG],
  ["apple-touch-icon.png", 180, FAVICON_SVG.replace(' rx="7"', "")],
]) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, colorScheme: "light" });
  await page.setContent(`<body style="margin:0">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body>`);
  writeFileSync(join(OUT, name), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
}
await browser.close();
console.log(`[favicons] ${OUT} に 3 ファイルを書きました`);
