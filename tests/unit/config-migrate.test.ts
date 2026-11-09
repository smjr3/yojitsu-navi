/**
 * config.json の不足の項目・名前が変わった項目の書き足し（SPEC §100、scripts/lib/config-migrate.mjs）
 * - 今ある値・ほかの行の書式・メモ（"_" の項目）は変えない
 * - 親が無ければ親ごと、親が 1 行なら同じ行に、複数行なら 1 項目 1 行で足す
 * - 名前が変わった項目は値を新しい名前へ移す（新しい名前もあれば移さない）
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error 型の無い .mjs
import { addPath, configDiff, migrateConfigText, removePath, renamedPaths } from "../../scripts/lib/config-migrate.mjs";

const ROOT = join(__dirname, "..", "..");
const TEMPLATE = readFileSync(join(ROOT, "config.json"), "utf-8");

describe("addPath・removePath", () => {
  it("複数行のオブジェクトには同じ字下げで 1 行足す。ほかの行は変えない", () => {
    const text = '{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}\n';
    expect(addPath(text, "b.d", true)).toBe('{\n  "a": 1,\n  "b": {\n    "c": 2,\n    "d": true\n  }\n}\n');
    expect(addPath(text, "e", [1, "x"])).toBe('{\n  "a": 1,\n  "b": {\n    "c": 2\n  },\n  "e": [1, "x"]\n}\n');
  });
  it("1 行のオブジェクトには同じ行に足す。親が無ければ親ごと足す", () => {
    const text = '{\n  "currency": { "code": "JPY" }\n}\n';
    expect(addPath(text, "currency.defaultUnit", "yen")).toBe('{\n  "currency": { "code": "JPY", "defaultUnit": "yen" }\n}\n');
    expect(addPath(text, "x.y.z", 1)).toBe('{\n  "currency": { "code": "JPY" },\n  "x": { "y": { "z": 1 } }\n}\n');
    expect(addPath('{\n  "o": {}\n}\n', "o.k", "v")).toBe('{\n  "o": { "k": "v" }\n}\n');
  });
  it("もうある項目は変えない。CRLF・文字列の中の括弧があっても位置を誤らない", () => {
    const text = '{\r\n  "a": "{\\"}",\r\n  "b": { "c": 1 }\r\n}\r\n';
    expect(addPath(text, "b.c", 9)).toBe(text);
    const added = addPath(text, "b.d", 2);
    expect(JSON.parse(added)).toEqual({ a: '{"}', b: { c: 1, d: 2 } });
  });
  it("項目を消す（前後の「,」も）", () => {
    const text = '{\n  "a": 1,\n  "b": { "c": 2, "d": 3 },\n  "e": 4\n}\n';
    expect(removePath(text, "a")).toBe('{\n  "b": { "c": 2, "d": 3 },\n  "e": 4\n}\n');
    expect(removePath(text, "e")).toBe('{\n  "a": 1,\n  "b": { "c": 2, "d": 3 }\n}\n');
    expect(removePath(text, "b.c")).toBe('{\n  "a": 1,\n  "b": { "d": 3 },\n  "e": 4\n}\n');
    expect(removePath(text, "b.d")).toBe('{\n  "a": 1,\n  "b": { "c": 2 },\n  "e": 4\n}\n');
  });
});

describe("configDiff・migrateConfigText", () => {
  const local = (cfg: Record<string, unknown>) => `${JSON.stringify(cfg, null, 2)}\n`;
  const base = JSON.parse(TEMPLATE);

  it("ひな形にあって導入先に無い項目を出す（メモの項目は見ない）", () => {
    const cfg = structuredClone(base);
    delete cfg.projectFromTask;
    delete cfg.masterEdit.gitlab.tokenUrl;
    cfg._memo = "社内のメモ";
    const d = configDiff(local(cfg), TEMPLATE);
    expect(d.missing.map((m: { path: string }) => m.path)).toEqual(["projectFromTask", "masterEdit.gitlab.tokenUrl"]);
    expect(d.renames).toEqual([]);
    expect(configDiff(TEMPLATE, TEMPLATE)).toEqual({ missing: [], renames: [] });
  });

  it("選んだ項目だけをひな形の値で書き足し、今ある値は変えない（親を選ぶと下をまとめて）", () => {
    const cfg = structuredClone(base);
    delete cfg.projectFromTask;
    delete cfg.masterEdit.gitlab.tokenUrl;
    cfg.fiscalYearStartMonth = 1;
    const r = migrateConfigText({ localText: local(cfg), templateText: TEMPLATE, add: ["projectFromTask", "currency", "nothing"] });
    expect(r.added).toEqual(["projectFromTask"]);
    expect(r.skipped.map((s: { path: string }) => s.path)).toEqual(["currency", "nothing"]);
    const after = JSON.parse(r.text);
    expect(after.projectFromTask).toEqual(base.projectFromTask);
    expect(after.fiscalYearStartMonth).toBe(1);
    expect(after.masterEdit.gitlab.tokenUrl).toBeUndefined();
    // 足した行のほかは同じ
    expect(r.text.replace(/,\n {2}"projectFromTask": .*\n/, "\n")).toBe(local(cfg));
  });

  it("親ごと無いときは、選んだ下の項目だけを親を作って足す", () => {
    const cfg = structuredClone(base);
    delete cfg.labels;
    const r = migrateConfigText({ localText: local(cfg), templateText: TEMPLATE, add: ["labels.customer"] });
    expect(r.added).toEqual(["labels.customer"]);
    expect(JSON.parse(r.text).labels).toEqual({ customer: base.labels.customer });
  });

  it("名前が変わった項目は値を新しい名前へ移す。新しい名前もあれば移さない", () => {
    const schema = { type: "object", props: { old: { type: "string", deprecated: "x に名前が変わりました", renamedTo: "grp.x" }, grp: { type: "object", props: { x: { type: "string" } } } } };
    expect(renamedPaths(schema)).toEqual([{ from: "old", to: "grp.x" }]);
    const tpl = '{\n  "grp": { "x": "" }\n}\n';
    const r = migrateConfigText({ localText: '{\n  "a": 1,\n  "old": "v"\n}\n', templateText: tpl, renames: true, schema });
    expect(r.moved).toEqual([{ from: "old", to: "grp.x" }]);
    expect(JSON.parse(r.text)).toEqual({ a: 1, grp: { x: "v" } });
    const both = migrateConfigText({ localText: '{\n  "old": "v",\n  "grp": { "x": "w" }\n}\n', templateText: tpl, renames: true, schema });
    expect(both.moved).toEqual([]);
    expect(both.skipped[0].path).toBe("old");
  });
});
