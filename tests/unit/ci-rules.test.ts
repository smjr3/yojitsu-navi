/**
 * 利用環境の .gitlab-ci.yml が、変わったファイルに応じて要るジョブだけを選ぶこと（SPEC §102.3）。
 * GitLab の rules:（if・changes・when）の評価をここで真似て、パイプラインの種類と変わったファイルごとに、動くジョブを確かめる。
 *   - MR: プログラムが変わった → build、データだけ → validate、それ以外 → ci-check（どれか 1 つだけ）
 *   - 既定ブランチへの push: プログラム・データ・CI の設定が変わった → build → pages、文書だけ → 何も動かない
 *   - 依存を取る（npm ci する）ジョブはパイプライン 1 回につき 1 つまで（test を有効にしたときを除く。SPEC §79.3）
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yaml: any = createRequire(import.meta.url)("js-yaml");
type Obj = Record<string, unknown>;
const CI = (yaml.safeLoad ?? yaml.load)(readFileSync(join(ROOT, ".gitlab-ci.yml"), "utf-8")) as Obj;
const GLOBAL = new Set(["default", "include", "stages", "variables", "workflow", "image", "services", "cache", "before_script", "after_script", "spec"]);

type Vars = Record<string, string | undefined>;
interface Rule {
  if?: string;
  changes?: string[];
  when?: string;
}

/** GitLab の rules:if の式（ここで使う形だけ: ==・!=・=~、&&・||、変数だけ） */
function evalIf(expr: string, vars: Vars): boolean {
  const value = (tok: string): string | null => {
    const t = tok.trim();
    if (t.startsWith("$")) return vars[t.slice(1)] ?? null;
    if (/^".*"$/.test(t)) return t.slice(1, -1);
    if (t === "null") return null;
    throw new Error(`読めない値: ${t}`);
  };
  return expr.split("||").some((or) =>
    or.split("&&").every((term) => {
      const t = term.trim();
      const re = /^(\S+)\s*=~\s*\/(.*)\/$/.exec(t);
      if (re) return new RegExp(re[2]!).test(value(re[1]!) ?? "");
      const cmp = /^(\S+)\s*(==|!=)\s*(.+)$/.exec(t);
      if (cmp) {
        const eq = value(cmp[1]!) === value(cmp[3]!);
        return cmp[2] === "==" ? eq : !eq;
      }
      const v = value(t);
      return v !== null && v !== "";
    }),
  );
}

/** rules:changes のパターン（File.fnmatch の FNM_PATHNAME 相当: ** は 0 個以上のフォルダ、* は / をまたがない） */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*" && glob[i + 2] === "/") {
      re += "(?:.*/)?";
      i += 2;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** push・MR 以外（Run pipeline・スケジュールなど）では changes: は常に「変わった」 */
const changed = (patterns: string[], files: string[] | null) => files === null || files.some((f) => patterns.some((p) => globToRegExp(p).test(f)));

function firstMatch(rules: Rule[], vars: Vars, files: string[] | null): Rule | null {
  for (const r of rules) {
    if (r.if !== undefined && !evalIf(r.if, vars)) continue;
    if (r.changes !== undefined && !changed(r.changes, files)) continue;
    return r;
  }
  return null;
}

/** パイプラインで動くジョブの名前（パイプラインが作られないなら null） */
function pipeline(source: string, opts: { branch?: string; files?: string[]; vars?: Vars } = {}): string[] | null {
  const mr = source === "merge_request_event";
  const vars: Vars = {
    CI_PIPELINE_SOURCE: source,
    CI_DEFAULT_BRANCH: "main",
    CI_COMMIT_BRANCH: mr ? undefined : (opts.branch ?? "main"),
    CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: mr ? "feature" : undefined,
    ...opts.vars,
  };
  const files = source === "push" || mr ? (opts.files ?? []) : null;
  const wf = firstMatch(((CI.workflow as Obj).rules as Rule[]) ?? [], vars, files);
  if (!wf || wf.when === "never") return null;
  const jobs: string[] = [];
  for (const [name, job] of Object.entries(CI)) {
    if (GLOBAL.has(name) || name.startsWith(".")) continue;
    const rules = (job as Obj).rules as Rule[] | undefined;
    const hit = rules ? firstMatch(rules, vars, files) : {};
    if (hit && hit.when !== "never") jobs.push(name);
  }
  // needs: の先が無いと GitLab はパイプラインを作れない
  for (const name of jobs) {
    for (const need of ((CI[name] as Obj).needs as string[] | undefined) ?? []) if (!jobs.includes(need)) throw new Error(`${name} が要る ${need} がパイプラインにありません`);
  }
  return jobs.length ? jobs.sort() : null;
}

/** 依存を取る（全体の before_script の npm ci を使う）ジョブ */
const installs = (jobs: string[]) => jobs.filter((j) => !(Array.isArray((CI[j] as Obj).before_script) && ((CI[j] as Obj).before_script as unknown[]).length === 0));

describe("変わったファイルを見て要るジョブだけを選ぶ（SPEC §102.3）", () => {
  it.each([
    ["作業実績の自動取り込み", ["data/worklogs/2026-10.csv", "data/worklogs/_meta.json"], ["validate"]],
    ["マスタ編集の保存", ["data/masters/rates.csv"], ["validate"]],
    ["案件の一覧の取り込み", ["data/projects.csv", "data/contracts.csv", "data/_projects-meta.json"], ["validate"]],
    ["config.json", ["config.json"], ["validate"]],
    ["パッケージの更新", ["src/index.md", "package-lock.json", "data/task-types.csv", "CHANGELOG.md"], ["build"]],
    ["スクリプトだけ", ["scripts/lib/load.ts"], ["build"]],
    ["文書だけ", ["README.md", "docs/OPERATIONS.md"], ["ci-check"]],
    ["社内の CI の設定", [".gitlab-ci.local.yml"], ["ci-check"]],
  ])("MR: %s → %j", (_label, files, want) => {
    const jobs = pipeline("merge_request_event", { files: files as string[] });
    expect(jobs).toEqual(want);
    expect(installs(jobs!).length).toBeLessThanOrEqual(1);
  });

  it("MR: YOJITSU_MR_BUILD=1 ならデータだけでも build（validate・ci-check は動かさない）", () => {
    expect(pipeline("merge_request_event", { files: ["data/masters/rates.csv"], vars: { YOJITSU_MR_BUILD: "1" } })).toEqual(["build"]);
    expect(pipeline("merge_request_event", { files: ["README.md"], vars: { YOJITSU_MR_BUILD: "1" } })).toEqual(["build"]);
  });

  it.each([
    ["作業実績の自動 MR のマージ", ["data/worklogs/2026-10.csv"], ["build", "pages"]],
    ["パッケージの更新のマージ", ["src/index.md", "package-lock.json"], ["build", "pages"]],
    ["社内の CI の設定", [".gitlab-ci.local.yml"], ["build", "pages"]],
    ["文書だけ", ["README.md", "docs/OPERATIONS.md"], null],
  ])("既定ブランチへの push: %s → %j", (_label, files, want) => {
    expect(pipeline("push", { files: files as string[] })).toEqual(want);
  });

  it("MR の無いほかのブランチへの push はビルドだけ（公開しない）。文書だけなら何も動かない", () => {
    expect(pipeline("push", { branch: "work", files: ["data/masters/rates.csv"] })).toEqual(["build"]);
    expect(pipeline("push", { branch: "work", files: ["README.md"] })).toBeNull();
    // MR があるブランチへの push は MR のパイプラインだけ
    expect(pipeline("push", { branch: "work", files: ["data/masters/rates.csv"], vars: { CI_OPEN_MERGE_REQUESTS: "group/p!1" } })).toBeNull();
  });

  it("Run pipeline（手動）は build → pages。過去の取り直し・初回の取り込みは取り込みも動く", () => {
    expect(pipeline("web")).toEqual(["build", "pages"]);
    expect(pipeline("web", { vars: { FETCH_MODE: "initial" } })).toEqual(["build", "fetch-worklogs", "pages"]);
    expect(pipeline("web", { branch: "work" })).toEqual(["build"]);
  });

  it("スケジュール実行は取り込みだけ（ビルド・公開は取り込みの MR がマージされてから）", () => {
    expect(pipeline("schedule")).toEqual(["fetch-worklogs"]);
    expect(pipeline("schedule", { vars: { MEMBER_FETCH_ENABLED: "1", PROJECT_FETCH_ENABLED: "1" } })).toEqual(["fetch-members", "fetch-projects", "fetch-worklogs"]);
  });

  it("test は YOJITSU_RUN_TESTS=1 のときだけ足される", () => {
    expect(pipeline("merge_request_event", { files: ["src/index.md"], vars: { YOJITSU_RUN_TESTS: "1" } })).toEqual(["build", "test"]);
    expect(pipeline("push", { files: ["data/worklogs/2026-10.csv"], vars: { YOJITSU_RUN_TESTS: "1" } })).toEqual(["build", "pages", "test"]);
  });

  it("ci-check は依存を取らない（Node の標準モジュールだけ）", () => {
    const job = CI["ci-check"] as Obj;
    expect(job.before_script).toEqual([]);
    expect(job.script).toEqual(["node scripts/ci/check.mjs"]);
  });

  it("build はローダのキャッシュ（src/.observablehq/cache/）を cache: で使い回し、npm のダウンロードのキャッシュも残す", () => {
    const cache = (CI.build as Obj).cache as Array<{ key: unknown; paths: string[] }>;
    expect(cache.flatMap((c) => c.paths)).toEqual([".npm/", "src/.observablehq/cache/"]);
    expect(cache[0]!.key).toEqual((CI.cache as Obj).key);
  });

  it("このテストの真似の確かめ: ** は 0 個以上のフォルダ、* は / をまたがない", () => {
    expect(globToRegExp("data/**/*").test("data/contracts.csv")).toBe(true);
    expect(globToRegExp("data/**/*").test("data/masters/rates.csv")).toBe(true);
    expect(globToRegExp("data/**/*").test("database.csv")).toBe(false);
    expect(globToRegExp("config.json").test("x/config.json")).toBe(false);
    expect(evalIf('$A == "1" && $B != "2"', { A: "1" })).toBe(true);
    expect(evalIf("$CI_COMMIT_BRANCH != $CI_DEFAULT_BRANCH", { CI_DEFAULT_BRANCH: "main" })).toBe(true);
  });
});
