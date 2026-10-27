import { describe, expect, it } from "vitest";
import { NONE_CUSTOMER_KEY, NONE_CUSTOMER_LABEL, customerKey, groupByCustomer } from "../../src/core/customers.js";

const c = (contractId: string, customerName: string) => ({ contractId, customerName });

describe("customerKey (SPEC §17)", () => {
  it("normalizeName と同じ: 全角半角・大文字小文字・法人格・空白の揺れを同じ顧客にする", () => {
    const k = customerKey("ABC商事");
    expect(k).toBe("abc商事");
    expect(customerKey("ＡＢＣ商事")).toBe(k);
    expect(customerKey("株式会社 ABC商事")).toBe(k);
    expect(customerKey("ABC商事（株）")).toBe(k);
    expect(customerKey("  abc商事 ")).toBe(k);
  });

  it("空・空白・法人格だけは「顧客名なし」", () => {
    for (const raw of ["", "   ", "　", "株式会社", "(株)", null, undefined]) expect(customerKey(raw)).toBe(NONE_CUSTOMER_KEY);
  });

  it("予約キーと同じ綴りの顧客名は別キーになる（単射）", () => {
    const k = customerKey("__none__");
    expect(k).not.toBe(NONE_CUSTOMER_KEY);
    expect(customerKey("___none__")).not.toBe(k);
    expect(new Set([k, customerKey("___none__"), customerKey("__x"), customerKey("_x"), NONE_CUSTOMER_KEY]).size).toBe(5);
  });

  it("日本語・記号・空白・予約文字を含む名前もそのまま保つ（URL への符号化は呼び出し側）", () => {
    expect(customerKey("A&B / 100% #1?x=y")).toBe("a&b / 100% #1?x=y");
  });
});

describe("groupByCustomer", () => {
  it("表示名は契約ID昇順で最初の契約の顧客名", () => {
    const g = groupByCustomer([c("C3", "Ｘ商事"), c("C1", "x商事（株）"), c("C2", "株式会社X商事")]);
    expect(g).toHaveLength(1);
    expect(g[0]!.label).toBe("x商事（株）");
    expect(g[0]!.contractIds).toEqual(["C1", "C2", "C3"]);
  });

  it("入力の並びに依らず同じ結果（決定的）", () => {
    const input = [c("C2", "B社"), c("C1", "A社"), c("C3", "b社"), c("C4", ""), c("C0", "株式会社")];
    const a = groupByCustomer(input);
    const b = groupByCustomer([...input].reverse());
    expect(b).toEqual(a);
  });

  it("「顧客名なし」は末尾、表示名は固定の文言", () => {
    const g = groupByCustomer([c("C1", ""), c("C2", "あ社"), c("C3", "  ")]);
    expect(g.map((x) => x.key)).toEqual(["あ社", NONE_CUSTOMER_KEY]);
    expect(g[1]!.label).toBe(NONE_CUSTOMER_LABEL);
    expect(g[1]!.contractIds).toEqual(["C1", "C3"]);
  });

  it("契約IDの重複は 1 件に数える・契約が無ければ空", () => {
    expect(groupByCustomer([c("C1", "A"), c("C1", "B")])).toEqual([{ key: "a", label: "A", contractIds: ["C1"] }]);
    expect(groupByCustomer([])).toEqual([]);
  });

  it("契約ID は文字コード順（C10 は C2 の前）", () => {
    expect(groupByCustomer([c("C2", "A"), c("C10", "A")])[0]!.contractIds).toEqual(["C10", "C2"]);
  });
});
