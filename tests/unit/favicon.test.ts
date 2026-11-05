/**
 * ファビコン（SPEC §89）: src/icons/ のファイルを全ページの head から読む。favicon.svg は FAVICON_SVG と同じで、
 * 色はテーマカラーの既定（style.css）と同じ
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FAVICON_SVG, faviconLink } from "../../src/components/favicon.js";
// @ts-expect-error 型定義の無い .mjs
import { IMAGE_ALLOWLIST } from "../../scripts/lib/image-detect.mjs";

const css = readFileSync(new URL("../../src/style.css", import.meta.url), "utf8");
/** style.css の --yn-accent の既定（ライト・ダークの順） */
const accents = [...css.matchAll(/^\s*--yn-accent:\s*(#[0-9a-f]{6});/gim)].map((m) => (m[1] ?? "").toLowerCase());
const icon = (name: string) => readFileSync(new URL(`../../src/icons/${name}`, import.meta.url));

/** PNG の幅・高さ（IHDR） */
function pngSize(buf: Buffer): [number, number] {
  expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe("ファビコン", () => {
  it("head のリンクは src/icons/ のファイル（data URI にしない）で、どれも画像の許可リストにある", () => {
    const hrefs = [...faviconLink().matchAll(/href="([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(hrefs).toEqual(["./icons/favicon-32.png", "./icons/favicon.svg", "./icons/apple-touch-icon.png"]);
    for (const h of hrefs) {
      expect(Object.keys(IMAGE_ALLOWLIST)).toContain(`src/icons/${h.slice("./icons/".length)}`);
      expect(icon(h.slice("./icons/".length)).length).toBeGreaterThan(0);
    }
  });

  it("favicon.svg は FAVICON_SVG と同じ（作り直しは node scripts/make-favicons.mjs）", () => {
    expect(icon("favicon.svg").toString("utf8").replace(/\r\n/g, "\n")).toBe(`${FAVICON_SVG}\n`);
  });

  it("PNG の大きさ（32px・180px）", () => {
    expect(pngSize(icon("favicon-32.png"))).toEqual([32, 32]);
    expect(pngSize(icon("apple-touch-icon.png"))).toEqual([180, 180]);
  });

  it("色はテーマカラーの既定と同じ（ライト・OS がダークのとき）", () => {
    expect(accents.length).toBeGreaterThanOrEqual(2);
    const [light, dark] = accents;
    const [, lightPart, darkPart] = FAVICON_SVG.match(/<style>(.*?)@media \(prefers-color-scheme:dark\)\{(.*?)\}<\/style>/) ?? [];
    expect(lightPart).toContain(`.b{fill:${light}}`);
    expect(darkPart).toContain(`.b{fill:${dark}}`);
  });

  it("SVG として読める（タグが閉じている）", () => {
    const open = (FAVICON_SVG.match(/<(svg|style|rect)\b/g) ?? []).length;
    const closed = (FAVICON_SVG.match(/<\/(svg|style)>|\/>/g) ?? []).length;
    expect(open).toBe(closed);
  });
});
