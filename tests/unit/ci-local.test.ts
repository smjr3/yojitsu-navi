/**
 * 社内の CI 設定（.gitlab-ci.local.yml）の点検と移し替え（SPEC §91.3・§91.4）。
 * - GitLab の CI Lint の代わり: .gitlab-ci.yml と .gitlab-ci.local.yml を YAML として読み、GitLab と同じく合わせて（include は深くマージ、同じ項目は .gitlab-ci.yml が勝つ）、
 *   GitLab が失敗にする形（空のファイル・中身の無いジョブ「config can't be blank」・script の無いジョブ）が無いことを確かめる。
 *   中身の無い項目を失敗にするのは、GitLab のどの版でもジョブ（. で始まる隠しジョブも）の設定が空でないことを求めるため
 * - 0.2.0〜0.2.1 のひな形「.yojitsu-navi-local: {}」を見つけて直す
 * - migrate-ci: 社内で直した .gitlab-ci.yml から、タグ・変数・社内だけのジョブを移す
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLACEHOLDER, ciHash, filledKeys, lintCiYaml, migrateCi, migratedHash, repairLocalPlaceholder } from "../../scripts/lib/ci-local.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yaml: any = createRequire(import.meta.url)("js-yaml");
const load = (text: string): unknown => (yaml.safeLoad ?? yaml.load)(text);
const CI = readFileSync(join(ROOT, ".gitlab-ci.yml"), "utf-8");
const LOCAL = readFileSync(join(ROOT, ".gitlab-ci.local.yml"), "utf-8");

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const GLOBAL = new Set(["default", "include", "stages", "variables", "workflow", "image", "services", "cache", "before_script", "after_script", "spec"]);

/** GitLab の include の合わせ方（ハッシュは深くマージし、同じ項目は後から＝.gitlab-ci.yml が勝つ） */
function deepMerge(a: unknown, b: unknown): unknown {
  if (!isObj(a) || !isObj(b)) return b;
  const out: Obj = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out;
}

/** GitLab の CI Lint が失敗にする形（ここで見るものだけ）を探す */
function gitlabLint(main: string, includes: Record<string, string>): string[] {
  const problems: string[] = [];
  let merged: unknown = {};
  for (const [file, text] of Object.entries(includes)) {
    const doc = load(text);
    // GitLab: 空の include は「Local file `…` is empty」・ハッシュでないものは「does not have valid YAML syntax」
    if (!isObj(doc) || !Object.keys(doc).length) problems.push(`${file}: 空・ハッシュでない`);
    else merged = deepMerge(merged, doc);
  }
  const doc = load(main);
  if (!isObj(doc)) return [...problems, ".gitlab-ci.yml: ハッシュでない"];
  merged = deepMerge(merged, doc);
  for (const [k, v] of Object.entries(merged as Obj)) {
    if (GLOBAL.has(k)) continue;
    // GitLab: jobs:<名前> config can't be blank（隠しジョブも同じ）
    if (v === null || v === undefined || (isObj(v) && !Object.keys(v).length)) problems.push(`jobs:${k} config can't be blank`);
    else if (!isObj(v)) problems.push(`jobs:${k} config should be a hash`);
    else if (!k.startsWith(".") && !("script" in v) && !("trigger" in v) && !("extends" in v)) problems.push(`jobs:${k} config should implement a script: or a trigger: keyword`);
  }
  return problems;
}

describe("GitLab が受け付ける CI 定義か（CI Lint の代わり）", () => {
  it("開発元の .gitlab-ci.yml と .gitlab-ci.local.yml のひな形は、合わせても GitLab が失敗にしない", () => {
    expect(gitlabLint(CI, { ".gitlab-ci.local.yml": LOCAL })).toEqual([]);
    expect(lintCiYaml(CI, ".gitlab-ci.yml")).toEqual([]);
    expect(lintCiYaml(LOCAL, ".gitlab-ci.local.yml")).toEqual([]);
    // ひな形は何もしない項目を持つ（中身が空のファイルは include できない）
    expect(LOCAL).toContain(PLACEHOLDER);
  });

  it("0.2.0〜0.2.1 のひな形（.yojitsu-navi-local: {}）は GitLab が失敗にし、点検も見つける", () => {
    const old = "# 社内の設定\n.yojitsu-navi-local: {}\n";
    expect(gitlabLint(CI, { ".gitlab-ci.local.yml": old })).toEqual(["jobs:.yojitsu-navi-local config can't be blank"]);
    expect(lintCiYaml(old, ".gitlab-ci.local.yml")).toEqual([expect.stringContaining("config can't be blank")]);
  });

  it("点検は空のファイル・中身の無いジョブ・中身の無い全体の設定を見つけ、書き方のよいものは通す", () => {
    expect(lintCiYaml("# コメントだけ\n", "a.yml")).toEqual([expect.stringContaining("1 つもありません")]);
    expect(lintCiYaml("", "a.yml")).toHaveLength(1);
    expect(lintCiYaml("job:\n  # 中はコメントだけ\nother:\n  script: [a]\n", "a.yml")).toEqual([expect.stringContaining("ジョブ job")]);
    expect(lintCiYaml(".hidden: null\n.h2: ~\n.h3:\n", "a.yml")).toHaveLength(3);
    expect(lintCiYaml("variables:\n", "a.yml")).toEqual([expect.stringContaining("variables:")]);
    expect(lintCiYaml("default:\n  tags: [windows]\nbuild:\n  tags:\n    - large\nvariables: {}\n", "a.yml")).toEqual([]);
    expect(lintCiYaml("job: { script: [a] }\n", "a.yml")).toEqual([]);
    // GitLab の判定と点検が合う
    for (const text of ["job:\n", "job: {}\n", ".x: {}\n", "default:\n  tags: [w]\n"]) {
      expect(lintCiYaml(text, "a.yml").length > 0).toBe(gitlabLint(CI, { a: text }).length > 0);
    }
  });
});

describe("合わせた結果で見る（SPEC §91.3）", () => {
  it("ほかの定義が中身つきで書いたジョブは、include 先で空でも失敗にしない（GitLab は合わせてから確かめる）", () => {
    const local = "build: {}\n.yojitsu-navi-local: {}\n";
    expect(gitlabLint(CI, { ".gitlab-ci.local.yml": local })).toEqual(["jobs:.yojitsu-navi-local config can't be blank"]);
    expect(lintCiYaml(local, ".gitlab-ci.local.yml", new Set(filledKeys(CI)))).toEqual([expect.stringContaining(".yojitsu-navi-local")]);
    // .gitlab-ci.yml（合わせるとき勝つ）の null・空は include の中身を消すので知らせる。{} は合わさるので知らせない
    const job = "build:\n  script: [a]\n";
    for (const [main, bad] of [["build: null\n", true], ["build:\n", true], ["build: {}\n", false]] as const) {
      expect(lintCiYaml(main, ".gitlab-ci.yml", new Set(filledKeys(job)), true).length > 0).toBe(bad);
    }
  });
});

describe("ひな形の直し（SPEC §91.3）", () => {
  it("0.2.0〜0.2.1 のひな形の行だけを直し、ほかの行・改行（CRLF）は変えない", () => {
    const fixed = repairLocalPlaceholder("# 社内\r\n.yojitsu-navi-local: {}\r\ndefault:\r\n  tags: [windows]\r\n");
    expect(fixed).toBe(`# 社内\r\n${PLACEHOLDER.replace(/\n/g, "\r\n")}\r\ndefault:\r\n  tags: [windows]\r\n`);
    expect(lintCiYaml(fixed, "a.yml")).toEqual([]);
    expect(gitlabLint(CI, { ".gitlab-ci.local.yml": fixed })).toEqual([]);
    for (const ok of [LOCAL, "default:\n  tags: [w]\n", ".yojitsu-navi-local:\n  variables:\n    X: \"1\"\n"]) expect(repairLocalPlaceholder(ok)).toBe(ok);
  });
});

describe("migrate-ci（SPEC §91.4）", () => {
  // 社内で .gitlab-ci.yml に書き足したもの: 全ジョブのタグ・新しい変数・既存の変数の値の変更・build の変数・社内だけのジョブ
  const custom = CI.replace("default:\n  before_script:", "default:\n  tags: [windows, yojitsu]\n  before_script:")
    .replace('  GIT_DEPTH: "20"\n', '  GIT_DEPTH: "20"\n  NODE_OPTIONS: "--use-system-ca"\n')
    .replace("build:\n  stage: build\n", 'build:\n  stage: build\n  tags:\n    - large\n')
    .replace('    GIT_DEPTH: "0"\n', '    GIT_DEPTH: "0"\n    VITEST_MAX_FORKS: "1"\n')
    .concat("\ninternal-job:\n  stage: build\n  script:\n    - node -v\n");

  it("タグ・変数・社内だけのジョブを移し、合わせた結果が社内で直した .gitlab-ci.yml と同じ設定になる", () => {
    expect(custom).not.toBe(CI);
    const r = migrateCi({ current: custom, base: CI, local: "# 社内\n.yojitsu-navi-local: {}\n" });
    expect(r.manual).toEqual([]);
    expect(r.moved).toEqual(["変数 NODE_OPTIONS", "default のタグ", "build のタグ", "build の変数 VITEST_MAX_FORKS", "ジョブ internal-job"]);
    expect(lintCiYaml(r.local, ".gitlab-ci.local.yml")).toEqual([]);
    expect(gitlabLint(CI, { ".gitlab-ci.local.yml": r.local })).toEqual([]);
    // 新しい版の .gitlab-ci.yml + 移した .gitlab-ci.local.yml = 社内で直した .gitlab-ci.yml
    const merged = deepMerge(load(r.local), load(CI)) as Obj;
    const want = load(custom) as Obj;
    for (const k of Object.keys(want)) expect([k, merged[k]]).toEqual([k, want[k]]);
    expect(migratedHash(r.local)).toBe(ciHash(custom));
    expect(ciHash(custom.replace(/\n/g, "\r\n"))).toBe(ciHash(custom));
    // もう一度動かしても変わらない
    const again = migrateCi({ current: custom, base: CI, local: r.local });
    expect([again.changed, again.moved, again.same.length]).toEqual([false, [], 5]);
  });

  it(".gitlab-ci.local.yml の既存の項目に足し、同じ名前で違う中身・.gitlab-ci.local.yml では変えられないものは手で移すものに出して印を書かない", () => {
    const local = 'default:\n  interruptible: true\nvariables:\n  NODE_OPTIONS: "--other"\n# 最後のコメント\n';
    const cur = custom.replace('  GIT_DEPTH: "20"', '  GIT_DEPTH: "5"');
    const r = migrateCi({ current: cur, base: CI, local });
    expect(r.manual).toEqual([
      "変数 GIT_DEPTH の値（.gitlab-ci.local.yml では変えられない。CI/CD 変数に GIT_DEPTH を登録する）",
      "変数 NODE_OPTIONS（.gitlab-ci.local.yml に同じ名前で違う中身があります。どちらにするか決めて手で直す）",
    ]);
    expect(load(r.local)).toMatchObject({ default: { interruptible: true, tags: ["windows", "yojitsu"] }, variables: { NODE_OPTIONS: "--other" } });
    expect(migratedHash(r.local)).toBe("");
    expect(r.local).toContain("# 最後のコメント");
    // --force なら印を書く
    expect(migratedHash(migrateCi({ current: cur, base: CI, local, force: true }).local)).toBe(ciHash(cur));
  });

  it("値の中の「 #」・複数行の文字列はそのまま写す", () => {
    const cur = CI.replace('  GIT_DEPTH: "20"\n', '  GIT_DEPTH: "20"\n  CUSTOM: "hello # world"\n').concat("\ninternal:\n  script:\n    - |\n      echo a\n\n      # 文字列の中\n      echo b\n");
    const r = migrateCi({ current: cur, base: CI, local: "" });
    expect(r.manual).toEqual([]);
    const merged = deepMerge(load(r.local), load(CI)) as Obj;
    const want = load(cur) as Obj;
    expect(merged.variables).toEqual(want.variables);
    expect(merged.internal).toEqual(want.internal);
  });

  it("消した変数・1 行で書いた variables は自動で移さず、手で移すものに出す（印を書かない）", () => {
    const removed = CI.replace('  GIT_DEPTH: "20"\n', "").replace('    YOJITSU_GITLAB_PROJECT: $CI_PROJECT_PATH\n', "");
    const r = migrateCi({ current: removed, base: CI, local: "" });
    expect(r.manual).toEqual([expect.stringContaining("変数 GIT_DEPTH を消した"), expect.stringContaining("build の変数 YOJITSU_GITLAB_PROJECT を消した")]);
    expect(migratedHash(r.local)).toBe("");
    const flow = CI.replace(/\nvariables:\n(?:  .*\n|\s*#.*\n)+/, '\nvariables: { NODE_IMAGE: "node:22", CUSTOM: "3" }\n');
    expect(flow).not.toBe(CI);
    const f = migrateCi({ current: flow, base: CI, local: "" });
    expect(f.manual).toEqual([expect.stringContaining("1 行の書き方")]);
    expect(migratedHash(f.local)).toBe("");
    const jobFlow = CI.replace(/(\nbuild:\n[\s\S]*?)  variables:\n(?:    .*\n|\s*#.*\n)+/, '$1  variables: { GIT_DEPTH: "0", X: "1" }\n');
    expect(jobFlow).not.toBe(CI);
    expect(migrateCi({ current: jobFlow, base: CI, local: "" }).manual).toEqual([expect.stringContaining("build の variables: の変更")]);
  });

  it("ほかで定義したアンカーを使うジョブ・<<: で受け継ぐ項目の追加は自動で移さない", () => {
    const alias = CI.concat('\ninternal:\n  <<: *normal-rules\n  script: ["node -v"]\n');
    const a = migrateCi({ current: alias, base: CI, local: "" });
    expect(a.manual).toEqual([expect.stringContaining("アンカー *normal-rules")]);
    expect(migratedHash(a.local)).toBe("");
    const ownAnchor = CI.concat('\n.mine: &mine\n  tags: [x]\n');
    expect(migrateCi({ current: ownAnchor, base: CI, local: "" }).manual).toEqual([]);
    const rules = CI.replace("build:\n  stage: build\n", "build:\n  stage: build\n  rules:\n    - when: manual\n");
    expect(rules).not.toBe(CI);
    const r = migrateCi({ current: rules, base: CI, local: "" });
    expect([r.moved, r.manual]).toEqual([[], [expect.stringContaining("build の rules: の追加")]]);
  });

  it("ジョブの script の変更・ジョブを消したことは手で移すものに出す。.gitlab-ci.local.yml が無くても何もしない項目を入れて空にしない", () => {
    const cur = CI.replace("    - npm run validate\n", "    - npm run validate -- --strict\n").replace(/\nfetch-members:[\s\S]*$/, "\n");
    const r = migrateCi({ current: cur, base: CI, local: "" });
    expect(r.manual).toEqual(["build の script: の変更（.gitlab-ci.local.yml では変えられない。差分は yojitsu-navi update --dry-run）", "ジョブ fetch-members を消したこと（.gitlab-ci.local.yml では消せない）"]);
    expect(lintCiYaml(r.local, ".gitlab-ci.local.yml")).toEqual([]);
    expect(r.local).toContain(PLACEHOLDER);
  });
});
