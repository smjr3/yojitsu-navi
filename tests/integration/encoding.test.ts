/**
 * 文字コード自動判定のテスト。fixtures はバイト列から組み立てる（ファイルに依存しない）
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeAuto, readTextAuto, readTextAutoDetailed } from "../../scripts/lib/encoding.js";

const SAMPLE = "contract_id,customer_name\nC001,株式会社青葉物流 テスト\n";

/** Shift_JIS（CP932）のバイト列: "株式会社" = 8A 94 8E AE 89 EF 8E D0 */
function sjisBytes(): Uint8Array {
  const head = new TextEncoder().encode("contract_id,customer_name\nC001,");
  const kabu = Uint8Array.from([0x8a, 0x94, 0x8e, 0xae, 0x89, 0xef, 0x8e, 0xd0]);
  const tail = new TextEncoder().encode("\n");
  const out = new Uint8Array(head.length + kabu.length + tail.length);
  out.set(head, 0);
  out.set(kabu, head.length);
  out.set(tail, head.length + kabu.length);
  return out;
}

describe("decodeAuto", () => {
  it("UTF-8（BOMなし）をそのまま読む", () => {
    const r = decodeAuto(new TextEncoder().encode(SAMPLE));
    expect(r.encoding).toBe("utf-8");
    expect(r.text).toBe(SAMPLE);
  });

  it("UTF-8（BOMあり）は BOM を取り除く", () => {
    const body = new TextEncoder().encode(SAMPLE);
    const bytes = new Uint8Array(3 + body.length);
    bytes.set([0xef, 0xbb, 0xbf], 0);
    bytes.set(body, 3);
    const r = decodeAuto(bytes);
    expect(r.encoding).toBe("utf-8-bom");
    expect(r.text).toBe(SAMPLE);
    expect(r.text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("Shift_JIS は UTF-8 として不正なので Shift_JIS として読む", () => {
    const r = decodeAuto(sjisBytes());
    expect(r.encoding).toBe("shift_jis");
    expect(r.text).toBe("contract_id,customer_name\nC001,株式会社\n");
  });

  it("空のバイト列は空文字", () => {
    expect(decodeAuto(new Uint8Array(0))).toEqual({ text: "", encoding: "utf-8" });
  });

  it("ASCII だけなら UTF-8 と判定（Shift_JIS と互換）", () => {
    const r = decodeAuto(new TextEncoder().encode("date,name\n2026-01-01,x\n"));
    expect(r.encoding).toBe("utf-8");
  });
});

describe("readTextAuto", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "yojitsu-enc-"));
    writeFileSync(join(dir, "utf8.csv"), SAMPLE);
    writeFileSync(join(dir, "bom.csv"), "﻿" + SAMPLE);
    writeFileSync(join(dir, "sjis.csv"), sjisBytes());
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("3種類のファイルを同じ文字列として読める", () => {
    expect(readTextAuto(join(dir, "utf8.csv"))).toBe(SAMPLE);
    expect(readTextAuto(join(dir, "bom.csv"))).toBe(SAMPLE);
    expect(readTextAutoDetailed(join(dir, "sjis.csv"))).toEqual({ text: "contract_id,customer_name\nC001,株式会社\n", encoding: "shift_jis" });
  });
});
