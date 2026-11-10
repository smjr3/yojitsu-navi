/** 表の列の表示・並び順（SPEC §106） */
import { afterEach, describe, expect, it, vi } from "vitest";
import { arrangeColumns, isCustomized, loadColumnPrefs, orderColumns, saveColumnPrefs } from "../../src/components/column-prefs.js";

const cols = ["a", "b", "c", "d"].map((key) => ({ key }));
const keys = (list: { key: string }[]) => list.map((c) => c.key);

describe("列の並び順", () => {
  it("覚えた順に並べ、隠した列を除く", () => {
    expect(keys(arrangeColumns(cols, { order: ["c", "a", "b", "d"], hidden: ["b"] }))).toEqual(["c", "a", "d"]);
  });
  it("覚えた後に増えた列は既定の位置に入る・無くなった列は無視する", () => {
    // d は覚えた後に増えた列、x は無くなった列
    expect(keys(orderColumns(cols, { order: ["c", "x", "b", "a"], hidden: [] }))).toEqual(["c", "b", "a", "d"]);
    expect(keys(orderColumns(cols, { order: ["b", "a"], hidden: ["x"] }))).toEqual(["b", "a", "c", "d"]);
  });
  it("既定のままなら変えていない扱い", () => {
    expect(isCustomized(cols, { order: [], hidden: [] })).toBe(false);
    expect(isCustomized(cols, { order: ["a", "b", "c", "d"], hidden: ["x"] })).toBe(false);
    expect(isCustomized(cols, { order: ["b", "a"], hidden: [] })).toBe(true);
    expect(isCustomized(cols, { order: [], hidden: ["c"] })).toBe(true);
  });
  it("列が変わって覚えた設定が今の列を全部隠すことになるときは、何も隠さない（月の列など）", () => {
    // 4〜5 月で 5 月以外を隠した後、期間を 4 月だけにした
    const april = [{ key: "m:04" }];
    expect(keys(arrangeColumns(april, { order: [], hidden: ["m:04"] }))).toEqual(["m:04"]);
    expect(isCustomized(april, { order: [], hidden: ["m:04"] })).toBe(false);
    expect(keys(arrangeColumns(cols, { order: [], hidden: ["a", "b", "c"] }))).toEqual(["d"]);
  });
  it("選べる列（optional）は既定で隠し、shown に入れた列だけ出す", () => {
    const withOpt = [{ key: "a" }, { key: "b" }, { key: "x", optional: true }, { key: "y", optional: true }];
    const none = { order: [], hidden: [], shown: [] };
    expect(keys(arrangeColumns(withOpt, none))).toEqual(["a", "b"]);
    expect(isCustomized(withOpt, none)).toBe(false);
    const p = { order: ["y", "a", "b", "x"], hidden: ["b"], shown: ["y"] };
    expect(keys(arrangeColumns(withOpt, p))).toEqual(["y", "a"]);
    expect(isCustomized(withOpt, p)).toBe(true);
    // 以前の形式（shown なし）でも読める
    expect(keys(arrangeColumns(withOpt, { order: [], hidden: [] }))).toEqual(["a", "b"]);
    // 普通の列を全部隠しても、選べる列を出していればそのまま
    expect(keys(arrangeColumns(withOpt, { order: [], hidden: ["a", "b"], shown: ["x"] }))).toEqual(["x"]);
    // 全部隠れるときは利用者が隠した列を戻す
    expect(keys(arrangeColumns(withOpt, { order: [], hidden: ["a", "b"], shown: [] }))).toEqual(["a", "b"]);
  });
  it("列の名前を返す関数を渡せる（マスタ編集の台帳）", () => {
    const named = [{ name: "x" }, { name: "y" }];
    expect(arrangeColumns(named, { order: ["y", "x"], hidden: [] }, (c) => c.name).map((c) => c.name)).toEqual(["y", "x"]);
  });
});

describe("保存", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("壊れた値・使えない保存先では既定に戻る", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    saveColumnPrefs("p", { order: ["b", "a"], hidden: ["c"] });
    expect(loadColumnPrefs("p")).toEqual({ order: ["b", "a"], hidden: ["c"], shown: [] });
    saveColumnPrefs("p", { order: [], hidden: [] });
    expect(store.size).toBe(0);
    store.set("yojitsu-navi:columns:q", "{壊れた");
    expect(loadColumnPrefs("q")).toEqual({ order: [], hidden: [], shown: [] });
    store.set("yojitsu-navi:columns:q", JSON.stringify({ order: [1, "a"], hidden: "b" }));
    expect(loadColumnPrefs("q")).toEqual({ order: ["a"], hidden: [], shown: [] });
    vi.stubGlobal("localStorage", undefined);
    expect(loadColumnPrefs("r")).toEqual({ order: [], hidden: [], shown: [] });
    // 保存できなくても、変えた設定はこの画面のあいだ効く
    expect(() => saveColumnPrefs("r", { order: ["b", "a"], hidden: ["c"] })).not.toThrow();
    expect(loadColumnPrefs("r")).toEqual({ order: ["b", "a"], hidden: ["c"], shown: [] });
  });
});
