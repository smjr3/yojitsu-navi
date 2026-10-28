/**
 * マスタ編集（SPEC §19）の結合テスト: ダミーデータの 4 ファイルで
 *   ローダ（masters.json の中身）→ 編集 → 書き出し → data/ に書き戻し → loadDataset / validate-data / buildModel
 * の往復を確かめる。一時ディレクトリに生成するので、リポジトリの data/ は触らない
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate, writeDummy } from "../../scripts/generate-dummy.js";
import { loadDataset } from "../../scripts/lib/load.js";
import { runValidation } from "../../scripts/validate-data.js";
import { buildMastersPayload } from "../../src/data/_masters.js";
import { aggregate, buildModel } from "../../src/core/index.js";
import {
  MASTER_FILES,
  MASTER_FILE_IDS,
  addRow,
  cellOf,
  deleteRow,
  diffMasterDoc,
  impactBetween,
  parseMasterDoc,
  serializeMasterDoc,
  updateRow,
  validateEdited,
  type MasterDoc,
  type MasterFileId,
} from "../../src/core/masterEdit.js";

const REPO = join(import.meta.dirname, "..", "..");
const AS_OF = "2026-10-27";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "yojitsu-masters-"));
  cpSync(join(REPO, "config.json"), join(root, "config.json"));
  writeDummy({ seed: 42, asOf: AS_OF, outDir: join(root, "data") });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function docsOf(payload: ReturnType<typeof buildMastersPayload>): Record<MasterFileId, MasterDoc> {
  return Object.fromEntries(MASTER_FILE_IDS.map((id) => [id, parseMasterDoc(id, payload.files[id].text)])) as Record<MasterFileId, MasterDoc>;
}

/** 書き出したテキストを一時ディレクトリの data/ に書き戻す */
function writeBack(dir: string, texts: Record<MasterFileId, string>): void {
  for (const id of MASTER_FILE_IDS) writeFileSync(join(dir, MASTER_FILES[id].path), texts[id]);
}

describe("ローダ（src/data/masters.json.ts の中身）", () => {
  it("4 ファイルの生テキスト・パス・設定。git 管理外なら最終コミット ID は null", () => {
    const p = buildMastersPayload(root);
    for (const id of MASTER_FILE_IDS) {
      expect(p.files[id].path).toBe(MASTER_FILES[id].path);
      expect(p.files[id].exists).toBe(true);
      expect(p.files[id].text.length).toBeGreaterThan(20);
      expect(p.files[id].lastCommitId).toBeNull();
      expect(p.files[id].lineEnding).toBe("lf");
    }
    expect(p.gitAvailable).toBe(false);
    expect(p.masterEdit.mode).toBe("gitlab") // §24: 既定は gitlab（接続先が空なら画面で download に落とす）;
    expect(p.memberSourceAdapter).toBe("none");
    expect(p.context.contracts).toContain("contract_id");
    expect(p.context.holidays.charCodeAt(0)).not.toBe(0xfeff); // BOM は除いて渡す
  });

  it("リポジトリの data/ では最終コミット ID（40 桁）とリポジトリ内パスを返す", () => {
    const p = buildMastersPayload(REPO);
    for (const id of MASTER_FILE_IDS) {
      expect(p.files[id].repoPath.endsWith(MASTER_FILES[id].path)).toBe(true);
      if (p.gitAvailable) expect(p.files[id].lastCommitId ?? "").toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

describe("ダミーデータの 4 ファイルで往復", () => {
  it("編集しなければ書き出しは元のファイルと完全に同じで、検証エラー 0", () => {
    const p = buildMastersPayload(root);
    const docs = docsOf(p);
    for (const id of MASTER_FILE_IDS) expect(serializeMasterDoc(docs[id]).text).toBe(p.files[id].text);
    const v = validateEdited(docs, p.context, loadDataset(root).dataset.config);
    expect(v.errors).toBe(0);
  });

  it("全ファイルを編集 → 書き戻し → loadDataset で編集どおりの値。validate-data もエラー 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "yojitsu-masters-rt-"));
    try {
      cpSync(root, dir, { recursive: true });
      const p = buildMastersPayload(dir);
      const docs = docsOf(p);
      const g = generate({ seed: 42, asOf: AS_OF });
      const anyTitle = g.members.find((m) => m.title !== "")!.title;
      const anyTeam = g.teams[0]!.team_id;
      const anyMember = docs.members.rows[0]!;
      const memberId = cellOf(docs.members, anyMember, "member_id");
      // 単価: 役職の単価を 2026-11 から改定（未来なので過去に影響なし）
      docs.rates = addRow(docs.rates, { key: anyTitle, hourly_rate: "99999", effective_from: "2026-11" }).doc;
      // メンバー: 2026-11 から別チームへ（名前にカンマと引用符を含めてエスケープも確かめる）
      docs.members = addRow(docs.members, { ...Object.fromEntries(docs.members.header.map((h) => [h, cellOf(docs.members, anyMember, h)])), name: '山田, "テスト"', team_id: anyTeam, effective_from: "2026-11" }).doc;
      // チーム: 名前の変更（既存行の修正）
      docs.teams = updateRow(docs.teams, docs.teams.rows[0]!.id, { name: "改称した本部" });
      // アサイン: 1 行削除
      const removed = docs.assignments.rows[0]!;
      docs.assignments = deleteRow(docs.assignments, removed.id);

      const v = validateEdited(docs, p.context, loadDataset(dir).dataset.config);
      expect(v.issues.filter((i) => i.severity === "error")).toEqual([]);
      for (const id of MASTER_FILE_IDS) expect(diffMasterDoc(docs[id]).count).toBe(1);

      writeBack(dir, v.texts);
      const { dataset, issues } = loadDataset(dir);
      expect(issues.filter((i) => i.severity === "error")).toEqual([]);
      expect(dataset.rates.some((r) => r.key === anyTitle && r.hourlyRate === 99999 && r.effectiveFrom === "2026-11")).toBe(true);
      expect(dataset.members.some((m) => m.memberId === memberId && m.name === '山田, "テスト"' && m.teamId === anyTeam)).toBe(true);
      expect(dataset.teams[0]!.name).toBe("改称した本部");
      expect(dataset.assignments).toHaveLength(docs.assignments.rows.length);
      expect(runValidation(dir).errors).toEqual([]);

      // 書き戻したファイルをもう一度ローダで読むと、書き出しと同じテキスト（往復で安定）
      const p2 = buildMastersPayload(dir);
      for (const id of MASTER_FILE_IDS) expect(p2.files[id].text).toBe(v.texts[id]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("過去月の単価を変えると、影響月の原価だけが変わる（impact の月 = 原価が変わりうる月）", () => {
    const dir = mkdtempSync(join(tmpdir(), "yojitsu-masters-impact-"));
    try {
      cpSync(root, dir, { recursive: true });
      const before = loadDataset(dir).dataset;
      const modelBefore = buildModel(before, { asOf: AS_OF });
      const p = buildMastersPayload(dir);
      const docs = docsOf(p);
      // 2026-04 以降の原価に実際に使われている役職単価を 2026-04 から上げる
      const titles = new Set(before.members.map((m) => m.title));
      const title = modelBefore.contracts
        .flatMap((c) => c.months.filter((m) => m.month >= "2026-04" && m.month <= modelBefore.meta.asOfMonth))
        .flatMap((m) => m.costLines)
        .find((l) => l.hours > 0 && l.rateSource !== null && titles.has(l.rateSource.key))!.rateSource!.key;
      const after = addRow(docs.rates, { key: title, hourly_rate: "50000", effective_from: "2026-04" }).doc;
      const imp = impactBetween(docs.rates, after, { fromMonth: modelBefore.meta.minMonth, toMonth: modelBefore.meta.asOfMonth });
      expect(imp.months[0]).toBe("2026-04");
      expect(imp.months.at(-1)).toBe(modelBefore.meta.asOfMonth);
      writeBack(dir, { ...Object.fromEntries(MASTER_FILE_IDS.map((id) => [id, serializeMasterDoc(docs[id]).text])), rates: serializeMasterDoc(after).text } as Record<MasterFileId, string>);
      const modelAfter = buildModel(loadDataset(dir).dataset, { asOf: AS_OF });
      // 影響の無い月（2026-03 まで）の原価は同じ、影響月のどこかで原価が増える
      const costOf = (m: typeof modelBefore, from: string, to: string) => aggregate(m, { period: { from, to } }).cost;
      expect(costOf(modelAfter, modelBefore.meta.minMonth, "2026-03")).toBe(costOf(modelBefore, modelBefore.meta.minMonth, "2026-03"));
      expect(costOf(modelAfter, "2026-04", modelBefore.meta.asOfMonth)).toBeGreaterThan(costOf(modelBefore, "2026-04", modelBefore.meta.asOfMonth));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("検証エラーになる編集（存在しないチーム）は、書き戻すと validate-data も同じくエラー", () => {
    const dir = mkdtempSync(join(tmpdir(), "yojitsu-masters-err-"));
    try {
      cpSync(root, dir, { recursive: true });
      const p = buildMastersPayload(dir);
      const docs = docsOf(p);
      const r = addRow(docs.members, { member_id: "MX", name: "x", kind: "employee", title: "", department: "", section: "", team_id: "NO_SUCH_TEAM", effective_from: "2026-11" });
      docs.members = r.doc;
      const v = validateEdited(docs, p.context, loadDataset(dir).dataset.config);
      expect(v.byRow.members[r.rowId]!.map((i) => i.code)).toEqual(["MEMBER_UNKNOWN_TEAM"]);
      writeBack(dir, v.texts);
      expect(runValidation(dir).errors.map((e) => e.code)).toEqual(["MEMBER_UNKNOWN_TEAM"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
