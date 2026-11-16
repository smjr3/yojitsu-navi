/** マージ待ちの変更がある対象（SPEC §126.3） */
import { describe, expect, it } from "vitest";
import { pendingFor, pendingKeysOf } from "../../src/core/mrPending.js";

const mr = (iid: number) => ({ iid, title: `t${iid}`, author: `a${iid}` });

describe("pendingKeysOf", () => {
  it("追加・変更（前後）・削除の行のキー（1 列目）を集め、同じ MR は 1 回", () => {
    const p = pendingKeysOf([
      {
        mr: mr(1),
        files: [
          { id: "assignments", diff: { added: [{ after: { member_id: "M1", contract_id: "C1" } }, { after: { member_id: "M1", contract_id: "C2" } }], changed: [{ before: { member_id: "M2" }, after: { member_id: "M3" } }], removed: [{ before: { member_id: "M4" } }] } },
          { id: "other", diff: null },
        ],
      },
      { mr: mr(2), files: [{ id: "assignments", diff: { added: [{ after: { member_id: "M1" } }], changed: [], removed: [] } }] },
    ]);
    expect([...p.assignments!.keys()].sort()).toEqual(["M1", "M2", "M3", "M4"]);
    expect(p.assignments!.get("M1")!.map((m) => m.iid)).toEqual([1, 2]);
    expect(pendingFor(p, ["assignments", "outside"], "M1").map((m) => m.iid)).toEqual([1, 2]);
    expect(pendingFor(p, ["outside"], "M1")).toEqual([]);
  });

  it("目標は種類と対象の 2 列で見分ける。空のキーは無視", () => {
    const p = pendingKeysOf([{ mr: mr(3), files: [{ id: "targets", diff: { added: [{ after: { target_type: "team", target_id: "T1" } }, { after: {} }], changed: [], removed: [] } }] }]);
    expect([...p.targets!.keys()]).toEqual(["team\u0001T1"]);
  });
});
