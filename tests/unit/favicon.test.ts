/**
 * ファビコン（SPEC §89）: 画像ファイルを置かず、SVG を data URI で埋め込む。色はテーマカラーの既定（style.css）と同じ
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FAVICON_SVG, faviconLink } from "../../src/components/favicon.js";

const css = readFileSync(new URL("../../src/style.css", import.meta.url), "utf8");
/** style.css の --yn-accent の既定（ライト・ダークの順） */
const accents = [...css.matchAll(/^\s*--yn-accent:\s*(#[0-9a-f]{6});/gim)].map((m) => (m[1] ?? "").toLowerCase());

describe("ファビコン", () => {
  it("data URI の SVG で、戻すと元の SVG になる（外部ファイルを読まない）", () => {
    const href = faviconLink().match(/href="([^"]+)"/)?.[1] ?? "";
    expect(href.startsWith("data:image/svg+xml,")).toBe(true);
    expect(href).not.toMatch(/["<> ]/);
    expect(decodeURIComponent(href.slice("data:image/svg+xml,".length))).toBe(FAVICON_SVG);
    expect(faviconLink()).toMatch(/^<link rel="icon" type="image\/svg\+xml" href="[^"]+">$/);
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
