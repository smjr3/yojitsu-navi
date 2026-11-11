/**
 * データローダ・キャッシュの破損対策（docs/DATA_LOADERS.md）
 *   - 原子的な書き込み（途中で失敗しても元のファイルが残る・一部だけ差し替わらない）
 *   - 入力の指紋（内容が変われば変わる・更新時刻だけでは変わらない）
 *   - キャッシュの掃除（プログラムが変われば全部捨てる・データだけなら依存ライブラリの束とローダの出力を残す・_npm は残す・*.err と一時ファイルは必ず消す。SPEC §102）
 *   - JSON に出せない値の検出（NaN を黙って null にしない）
 *   - ビルド結果の検証（古い出力・欠け・余り・壊れた JSON を見つける）
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listStaleTempFiles, writeFileAtomic, writeFilesAtomic } from "../../scripts/lib/atomic.js";
import { computeFingerprint, isAsOfFixed, listInputFiles, resolveAsOf, todayJst } from "../../scripts/lib/inputs.js";
import { CACHE_DIR, MANIFEST_FILE, prepareLoaderCache, STAMP_FILE } from "../../scripts/lib/loader-cache.js";
import type { OutputManifest } from "../../scripts/lib/prebuild.js";
import { createHash } from "node:crypto";
import { verifyDist } from "../../scripts/verify-dist.js";
import { findInvalidJsonValue, serializeChecked } from "../../scripts/lib/json-out.js";
import { worklogKey } from "../../src/components/worklog-key.js";

const REPO = join(__dirname, "..", "..");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yn-loader-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomic / writeFilesAtomic", () => {
  it("書き込んだ内容になり、一時ファイルが残らない", () => {
    const p = join(dir, "a.csv");
    writeFileSync(p, "old");
    writeFileAtomic(p, "new");
    expect(readFileSync(p, "utf-8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["a.csv"]);
  });

  it("1 つでも書けなければ何も差し替えない（元のファイルはそのまま・一時ファイルも消える）", () => {
    const a = join(dir, "2026-09.csv");
    const b = join(dir, "2026-10.csv");
    writeFileSync(a, "old-a");
    writeFileSync(b, "old-b");
    const bad = join(dir, "no-such-dir", "2026-11.csv");
    expect(() =>
      writeFilesAtomic([
        { path: a, data: "new-a" },
        { path: b, data: "new-b" },
        { path: bad, data: "x" },
      ]),
    ).toThrow();
    expect(readFileSync(a, "utf-8")).toBe("old-a");
    expect(readFileSync(b, "utf-8")).toBe("old-b");
    expect(readdirSync(dir).sort()).toEqual(["2026-09.csv", "2026-10.csv"]);
  });

  it("バイト列も書ける・空でも書ける", () => {
    const p = join(dir, "b.bin");
    writeFileAtomic(p, new Uint8Array([0xef, 0xbb, 0xbf, 0x41]));
    expect([...readFileSync(p)]).toEqual([0xef, 0xbb, 0xbf, 0x41]);
    writeFileAtomic(p, "");
    expect(readFileSync(p, "utf-8")).toBe("");
  });

  it("異常終了で残った一時ファイルを見つけられる", () => {
    writeFileSync(join(dir, "2026-10.csv.tmp-123-0badf00d"), "partial");
    writeFileSync(join(dir, "2026-10.csv"), "ok");
    expect(listStaleTempFiles(dir).map((p) => p.slice(dir.length + 1))).toEqual(["2026-10.csv.tmp-123-0badf00d"]);
    expect(listStaleTempFiles(join(dir, "none"))).toEqual([]);
  });
});

describe("入力の指紋", () => {
  function seed() {
    mkdirSync(join(dir, "data", "worklogs"), { recursive: true });
    writeFileSync(join(dir, "data", "contracts.csv"), "contract_id\nC001\n");
    writeFileSync(join(dir, "data", "worklogs", "2026-10.csv"), "date\n");
    writeFileSync(join(dir, "config.json"), "{}");
  }
  const fp = (asOf = "2026-10-27") => computeFingerprint(dir, { asOf, git: false });

  it("同じ内容なら同じ。更新時刻だけ変わっても同じ（git checkout で作り直さない）", () => {
    seed();
    const a = fp();
    const t = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "data", "contracts.csv"), t, t);
    expect(fp().hash).toBe(a.hash);
    expect(a.files).toBe(3);
  });

  it("内容・ファイルの追加削除・ファイル名・計算基準日のどれが変わっても変わる", () => {
    seed();
    const base = fp().hash;
    writeFileSync(join(dir, "data", "contracts.csv"), "contract_id\nC002\n");
    const changed = fp().hash;
    expect(changed).not.toBe(base);
    writeFileSync(join(dir, "data", "worklogs", "2026-11.csv"), "date\n");
    const added = fp().hash;
    expect(added).not.toBe(changed);
    rmSync(join(dir, "data", "worklogs", "2026-11.csv"));
    expect(fp().hash).toBe(changed);
    expect(fp("2026-10-28").hash).not.toBe(changed);
  });

  it("中身を 2 つのファイルで入れ替えると変わる（ファイル名も指紋に入る）", () => {
    seed();
    writeFileSync(join(dir, "data", "a.csv"), "x");
    writeFileSync(join(dir, "data", "b.csv"), "y");
    const before = fp().hash;
    writeFileSync(join(dir, "data", "a.csv"), "y");
    writeFileSync(join(dir, "data", "b.csv"), "x");
    expect(fp().hash).not.toBe(before);
  });

  it("一時ファイル・隠しファイルは数えない（書き込み途中のファイルで指紋が揺れない）", () => {
    seed();
    const base = fp().hash;
    writeFileSync(join(dir, "data", "worklogs", "2026-10.csv.tmp-99-deadbeef"), "partial");
    writeFileSync(join(dir, "data", ".DS_Store"), "x");
    mkdirSync(join(dir, "data", ".git"));
    writeFileSync(join(dir, "data", ".git", "x"), "x");
    expect(fp().hash).toBe(base);
    expect(listInputFiles(dir)).toEqual(["config.json", "data/contracts.csv", "data/worklogs/2026-10.csv"]);
  });

  it("このリポジトリの入力には data/ と計算コアとローダが入る", () => {
    const files = listInputFiles(REPO);
    expect(files).toContain("data/contracts.csv");
    expect(files).toContain("config.json");
    expect(files).toContain("src/core/model.ts");
    expect(files).toContain("src/data/model.json.ts");
    expect(files.some((f) => f.startsWith("src/.observablehq"))).toBe(false);
  });

  it("計算基準日は YOJITSU_AS_OF、形式が違えば今日（JST）", () => {
    expect(resolveAsOf({ YOJITSU_AS_OF: "2026-10-27" })).toBe("2026-10-27");
    expect(resolveAsOf({ YOJITSU_AS_OF: " 2026-10-27 " })).toBe("2026-10-27");
    expect(resolveAsOf({ YOJITSU_AS_OF: "2026/10/27" })).toBe(todayJst());
    expect(resolveAsOf({})).toBe(todayJst());
    // UTC 15:00 = JST 翌日 0:00
    expect(todayJst(new Date("2026-10-27T14:59:59Z"))).toBe("2026-10-27");
    expect(todayJst(new Date("2026-10-27T15:00:00Z"))).toBe("2026-10-28");
  });

  it("固定したかは YOJITSU_AS_OF_FIXED を優先し、無ければ YOJITSU_AS_OF の有無（§75。build.ts は日付を必ず渡すため）", () => {
    expect(isAsOfFixed({ YOJITSU_AS_OF: "2026-10-27" })).toBe(true);
    expect(isAsOfFixed({})).toBe(false);
    expect(isAsOfFixed({ YOJITSU_AS_OF: "2026-10-27", YOJITSU_AS_OF_FIXED: "0" })).toBe(false);
    expect(isAsOfFixed({ YOJITSU_AS_OF: "2026-10-27", YOJITSU_AS_OF_FIXED: "1" })).toBe(true);
    // 固定したかで出力（meta.asOfFixed）が変わるので、指紋も変わる
    const a = computeFingerprint(dir, { asOf: "2026-10-27", git: false, env: { YOJITSU_AS_OF: "2026-10-27" } }).hash;
    const b = computeFingerprint(dir, { asOf: "2026-10-27", git: false, env: {} }).hash;
    expect(a).not.toBe(b);
  });
});

describe("prepareLoaderCache", () => {
  const cache = () => join(dir, CACHE_DIR);
  const CODE = "0".repeat(64);
  const fp = (hash: string, codeHash = CODE) => ({ hash, codeHash, asOf: "2026-10-27", files: 1 });
  function seedCache() {
    mkdirSync(join(cache(), "_npm", "react@19.3.1"), { recursive: true });
    mkdirSync(join(cache(), "_node", "d3@7.9.0"), { recursive: true });
    writeFileSync(join(cache(), "rules.md"), "# old");
    writeFileSync(join(cache(), MANIFEST_FILE), "{}");
    mkdirSync(join(cache(), "data", "worklogs"), { recursive: true });
    writeFileSync(join(cache(), "data", "model.json"), '{"old":true}');
    writeFileSync(join(cache(), "data", "worklogs", "C001.json"), "{}");
    mkdirSync(join(cache(), ".yojitsu", "worklogs-aaaa"), { recursive: true });
  }

  it("初回は捨てて指紋を書く。_npm は残す", () => {
    seedCache();
    const r = prepareLoaderCache(dir, fp("a".repeat(64)));
    expect(r.cleared).toBe(true);
    expect(existsSync(join(cache(), "data"))).toBe(false);
    expect(existsSync(join(cache(), ".yojitsu"))).toBe(false);
    expect(existsSync(join(cache(), "_npm", "react@19.3.1"))).toBe(true);
    expect(JSON.parse(readFileSync(join(cache(), STAMP_FILE), "utf-8")).hash).toBe("a".repeat(64));
  });

  it("指紋が同じなら残す。プログラムが違えば全部捨てる（_npm は残す）", () => {
    prepareLoaderCache(dir, fp("a".repeat(64)));
    seedCache();
    expect(prepareLoaderCache(dir, fp("a".repeat(64)))).toMatchObject({ cleared: false, full: false, reason: "same" });
    expect(existsSync(join(cache(), "data", "model.json"))).toBe(true);
    expect(prepareLoaderCache(dir, fp("b".repeat(64), "1".repeat(64)), { keepDataOutputs: true })).toMatchObject({ cleared: true, full: true, reason: "code" });
    expect(readdirSync(cache()).sort()).toEqual([STAMP_FILE, "_npm"]);
    expect(JSON.parse(readFileSync(join(cache(), STAMP_FILE), "utf-8"))).toMatchObject({ hash: "b".repeat(64), codeHash: "1".repeat(64) });
  });

  it("データだけが違えば、依存ライブラリの束（_node）を残す。npm run build（keepDataOutputs）はローダの出力と記録も残す（増分ビルド）", () => {
    prepareLoaderCache(dir, fp("a".repeat(64)));
    seedCache();
    expect(prepareLoaderCache(dir, fp("b".repeat(64)), { keepDataOutputs: true })).toMatchObject({ cleared: true, full: false, reason: "data" });
    expect(readdirSync(cache()).sort()).toEqual([STAMP_FILE, MANIFEST_FILE, "_node", "_npm", "data"]);
    expect(existsSync(join(cache(), "data", "worklogs", "C001.json"))).toBe(true);
    // npm run dev はローダに作り直させるので、出力は捨てる
    seedCache();
    expect(prepareLoaderCache(dir, fp("c".repeat(64)))).toMatchObject({ reason: "data" });
    expect(readdirSync(cache()).sort()).toEqual([STAMP_FILE, "_node", "_npm"]);
  });

  it("full を指定すると、データだけの違い・同じ入力でも全部捨てる（YOJITSU_FULL_BUILD=1）", () => {
    prepareLoaderCache(dir, fp("a".repeat(64)));
    seedCache();
    expect(prepareLoaderCache(dir, fp("a".repeat(64)), { full: true, keepDataOutputs: true })).toMatchObject({ cleared: true, full: true, reason: "forced" });
    expect(readdirSync(cache()).sort()).toEqual([STAMP_FILE, "_npm"]);
  });

  it("プログラムの指紋が無い記録（以前の版）は読めないものとして全部捨てる", () => {
    prepareLoaderCache(dir, fp("a".repeat(64)));
    seedCache();
    writeFileSync(join(cache(), STAMP_FILE), JSON.stringify({ hash: "a".repeat(64) }));
    expect(prepareLoaderCache(dir, fp("a".repeat(64)), { keepDataOutputs: true })).toMatchObject({ full: true, reason: "unreadable" });
    expect(existsSync(join(cache(), "_node"))).toBe(false);
  });

  it("指紋が同じでも、失敗の記録（*.err）と書きかけ（<name>.<pid>）は消す", () => {
    prepareLoaderCache(dir, fp("a".repeat(64)));
    seedCache();
    writeFileSync(join(cache(), "data", "model.json.4242.err"), "");
    writeFileSync(join(cache(), "data", "model.json.4242"), '{"half');
    writeFileSync(join(cache(), "data", "x.json.tmp-1-00000000"), "");
    const r = prepareLoaderCache(dir, fp("a".repeat(64)));
    expect(r).toMatchObject({ cleared: false, removedLeftovers: 3 });
    expect(readdirSync(join(cache(), "data")).sort()).toEqual(["model.json", "worklogs"]);
  });

  it("指紋の記録が壊れていたら捨てる", () => {
    prepareLoaderCache(dir, fp("a".repeat(64)));
    seedCache();
    writeFileSync(join(cache(), STAMP_FILE), "{broken");
    expect(prepareLoaderCache(dir, fp("a".repeat(64)))).toMatchObject({ cleared: true, reason: "unreadable" });
    expect(existsSync(join(cache(), "data"))).toBe(false);
  });

  it("記録が無いのに出力だけある（以前の版でビルドした）なら捨てる", () => {
    seedCache();
    expect(prepareLoaderCache(dir, fp("a".repeat(64))).reason).toBe("unreadable");
  });

  it("キャッシュのフォルダが無くても動く", () => {
    expect(prepareLoaderCache(dir, fp("a".repeat(64)))).toMatchObject({ cleared: true, reason: "first" });
    expect(existsSync(join(cache(), STAMP_FILE))).toBe(true);
  });
});

describe("JSON に出せない値の検出", () => {
  it("NaN・Infinity・配列の undefined・関数・BigInt・循環を場所付きで見つける", () => {
    expect(findInvalidJsonValue({ a: [1, { b: NaN }] })).toBe("$.a[1].b = NaN");
    expect(findInvalidJsonValue({ x: -Infinity })).toBe("$.x = -Infinity");
    expect(findInvalidJsonValue([1, undefined])).toBe("$[1] = undefined");
    expect(findInvalidJsonValue({ f: () => 1 })).toBe("$.f = function");
    expect(findInvalidJsonValue({ n: 1n })).toBe("$.n = bigint");
    const c: Record<string, unknown> = {};
    c.self = c;
    expect(findInvalidJsonValue(c)).toContain("循環参照");
  });

  it("普通の値・省略可能な項目（undefined）・同じオブジェクトの共有でない値は通す", () => {
    expect(findInvalidJsonValue({ a: 1, b: "x", c: null, d: true, e: undefined, f: [0, -0, 1e300] })).toBeNull();
    expect(serializeChecked({ a: 1, e: undefined })).toBe('{"a":1}');
    expect(() => serializeChecked({ a: NaN })).toThrow(/NaN/);
  });

  it("深い入れ子でもスタックあふれしない", () => {
    let v: unknown = 1;
    for (let i = 0; i < 20000; i++) v = [v];
    expect(findInvalidJsonValue(v)).toBeNull();
  });
});

describe("ビルド結果の検証（verifyDist）", () => {
  const HASH = "c".repeat(64);
  const FP = { hash: HASH, codeHash: "0".repeat(64), asOf: "2026-10-27", files: 1 };
  const stamp = { inputHash: HASH, asOf: "2026-10-27" };
  /** 作業ログ明細は指紋を持たない（増分ビルドで変わらなければ書き換えないため。SPEC §102） */
  const detailStamp = { asOf: "2026-10-27" };
  let ids: string[];
  let manifest: OutputManifest;
  const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
  /** 今の dist の中身どおりの記録（seedRoot の直後に作る。そのあと dist を変えると記録と合わなくなる） */
  function record(): OutputManifest {
    const d = join(dir, "dist");
    const outputs: Record<string, string> = {};
    for (const n of readdirSync(join(d, "_file", "data"))) outputs[`data/${n.replace(/\.[0-9a-f]{8}\.json$/, ".json")}`] = sha(join(d, "_file", "data", n));
    for (const n of readdirSync(join(d, "data", "worklogs"))) outputs[`data/worklogs/${n}`] = sha(join(d, "data", "worklogs", n));
    if (existsSync(join(d, "data", "my-month.json"))) outputs["data/my-month.json"] = sha(join(d, "data", "my-month.json"));
    return { version: 1, hash: HASH, codeHash: FP.codeHash, asOf: FP.asOf, outputs, stats: { aggregates: 6, details: ids.length, written: 0, detailsWritten: 0, unchanged: 0, removed: 0 } };
  }
  const verify = (m: OutputManifest | null = manifest) => verifyDist(dir, FP, join(dir, "dist"), m);

  function seedRoot() {
    cpSync(join(REPO, "data"), join(dir, "data"), { recursive: true });
    cpSync(join(REPO, "config.json"), join(dir, "config.json"));
    const csv = readFileSync(join(dir, "data", "contracts.csv"), "utf-8").trim().split(/\r?\n/).slice(1);
    ids = [...new Set(csv.map((l) => l.split(",")[0]!))];
    const d = join(dir, "dist");
    mkdirSync(join(d, "_file", "data"), { recursive: true });
    mkdirSync(join(d, "data", "worklogs"), { recursive: true });
    writeFileSync(join(d, "index.html"), "<!doctype html>");
    writeFileSync(join(d, "_file", "data", "model.0123abcd.json"), JSON.stringify({ meta: { asOf: "2026-10-27" }, contracts: ids.map((id) => ({ id })), _build: stamp }));
    for (const n of ["member-months", "masters", "dataset-issues", "work-hours", "daily"]) writeFileSync(join(d, "_file", "data", `${n}.0123abcd.json`), JSON.stringify({ _build: stamp }));
    for (const id of ids) writeFileSync(join(d, "data", "worklogs", `${worklogKey(id)}.json`), JSON.stringify({ contractId: id, months: [], _build: detailStamp }));
    writeFileSync(join(d, "data", "my-month.json"), JSON.stringify({ users: {}, members: {}, _build: stamp }));
    manifest = record();
  }

  it("ヘッダー右上の「今月の残り」のデータ（固定のパス）が無ければ失敗（§113）", () => {
    seedRoot();
    rmSync(join(dir, "dist", "data", "my-month.json"));
    expect(verify().some((p) => p.includes("dist/data/my-month.json がありません"))).toBe(true);
  });

  it("正しい dist は問題なし", () => {
    seedRoot();
    expect(verify()).toEqual([]);
  });

  it("古い入力から作られた出力が 1 つでも混ざると見つける", () => {
    seedRoot();
    writeFileSync(join(dir, "dist", "data", "worklogs", `${worklogKey(ids[0]!)}.json`), JSON.stringify({ contractId: ids[0], _build: { inputHash: "d".repeat(64), asOf: "2026-10-27" } }));
    expect(verify().join("\n")).toMatch(/別の入力から作られています/);
  });

  it("指紋の無い出力（以前の版のキャッシュ）・計算基準日の違いを見つける", () => {
    seedRoot();
    writeFileSync(join(dir, "dist", "_file", "data", "masters.0123abcd.json"), "{}");
    writeFileSync(join(dir, "dist", "_file", "data", "dataset-issues.0123abcd.json"), JSON.stringify({ _build: { inputHash: HASH, asOf: "2026-10-26" } }));
    const p = verify().join("\n");
    expect(p).toMatch(/masters.*指紋（_build）がありません/);
    expect(p).toMatch(/計算基準日 2026-10-26/);
  });

  it("壊れた JSON・空ファイル・必須出力の欠け・重複を見つける", () => {
    seedRoot();
    writeFileSync(join(dir, "dist", "_file", "data", "member-months.0123abcd.json"), '{"memberMonths":[');
    writeFileSync(join(dir, "dist", "_file", "data", "work-hours.0123abcd.json"), "");
    rmSync(join(dir, "dist", "_file", "data", "masters.0123abcd.json"));
    writeFileSync(join(dir, "dist", "_file", "data", "model.89abcdef.json"), JSON.stringify({ _build: stamp }));
    const p = verify().join("\n");
    expect(p).toMatch(/member-months.*JSON として読めません/);
    expect(p).toMatch(/work-hours.*空です/);
    expect(p).toMatch(/masters\.<hash>\.json がありません/);
    expect(p).toMatch(/model\.\*\.json が 2 個/);
  });

  it("作業ログ明細の欠け・余り・取り違え・契約件数の不一致を見つける", () => {
    seedRoot();
    rmSync(join(dir, "dist", "data", "worklogs", `${worklogKey(ids[1]!)}.json`));
    writeFileSync(join(dir, "dist", "data", "worklogs", "ZZZ.json"), JSON.stringify({ contractId: "ZZZ", _build: stamp }));
    writeFileSync(join(dir, "dist", "data", "worklogs", `${worklogKey(ids[2]!)}.json`), JSON.stringify({ contractId: ids[3], _build: stamp }));
    writeFileSync(join(dir, "dist", "_file", "data", "model.0123abcd.json"), JSON.stringify({ meta: { asOf: "2026-10-27" }, contracts: [], _build: stamp }));
    const p = verify().join("\n");
    expect(p).toContain(`契約 ${ids[1]} の作業ログ明細`);
    expect(p).toContain("ZZZ.json は contracts.csv に無い契約");
    expect(p).toContain(`contractId が ${ids[3]} です`);
    expect(p).toMatch(/契約が 0 件ですが contracts.csv は \d+ 件/);
  });

  it("ローダの出力の記録が無い・別の入力のもの・中身が記録と違う（古い明細の混入）を見つける", () => {
    seedRoot();
    expect(verify(null).join("\n")).toMatch(/出力の記録.*がありません/);
    expect(verify({ ...manifest, hash: "d".repeat(64) }).join("\n")).toMatch(/記録は別の入力のもの/);
    // 指紋を持たない明細でも、記録のハッシュと違えば見つかる
    writeFileSync(join(dir, "dist", "data", "worklogs", `${worklogKey(ids[0]!)}.json`), JSON.stringify({ contractId: ids[0], months: [{ month: "2026-04" }], _build: detailStamp }));
    expect(verify()).toEqual([expect.stringMatching(/中身がローダの出力の記録と違います/)]);
    const { [`data/worklogs/${worklogKey(ids[1]!)}.json`]: _drop, ...rest } = manifest.outputs;
    expect(verify({ ...manifest, outputs: rest }).join("\n")).toMatch(/記録にありません/);
  });

  it("dist/ が無ければ index.html が無いと言う", () => {
    seedRoot();
    rmSync(join(dir, "dist"), { recursive: true });
    expect(verify()[0]).toMatch(/index.html がありません/);
  });
});
