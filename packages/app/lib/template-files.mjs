// パッケージに入れるファイルの分け方（SPEC §93）。Node の標準モジュールだけを使う
//   - 開発元だけで使うもの（パッケージの組み立て・公開、ダミーデータ・ファズ・プロパティ・性能・E2E などのテスト）は利用環境に配らない
//   - 利用環境で動かすテストは運用に要るもの（取り込み・データ検証・CI のスクリプト）だけ。設定とデータはテストの中とテスト専用のフォルダ（tests/fixtures/）に持つ
//   - data/ はサンプルを入れず、空（見出しの行だけ）にする。サンプルは sample/ に分け、init --sample のときだけ入れる
// scripts/build-app.mjs（組み立て）と lib/project.mjs（init・update）が使う
import { readFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

/** 利用環境で動かすテスト（運用に要るもの: 取り込み・データ検証・CI のスクリプト） */
export const USER_TESTS = [
  "tests/unit/api-adapter.test.ts",
  "tests/unit/adapter-review.test.ts",
  "tests/unit/gitlab-env.test.ts",
  "tests/unit/validate.test.ts",
  "tests/integration/api-adapter.test.ts",
  "tests/integration/encoding.test.ts",
  "tests/integration/http-adapter.test.ts",
  "tests/integration/member-targets.test.ts",
  "tests/integration/task-code-fetch.test.ts",
];

/** テストの設定が読むヘルパー（vitest.config.ts が import する） */
export const TEST_HELPERS = ["tests/test-env.ts"];

/** テスト専用のデータ・設定の置き場（利用環境にも入れる） */
export const FIXTURES_DIR = "tests/fixtures/";

/** 開発元だけで使うファイル（テストを除く） */
const DEV_FILES = new Set([
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "scripts/build-app.mjs",
  "scripts/check-publish.mjs",
  "scripts/lib/image-detect.mjs",
  "scripts/lib/package-guard.mjs",
  "scripts/lib/package-guard.d.mts",
  "scripts/ci/publish-npm.mjs",
  "scripts/make-favicons.mjs",
]);
/** 開発元だけで使うフォルダ（packages/ はこのパッケージ自体と計算コアの元） */
const DEV_DIRS = [".github/", "packages/"];

/** 開発元だけで使う package.json の scripts（利用環境の package.json から外す。中のファイルを配らないので） */
export const DEV_SCRIPTS = ["app:build", "app:pack", "test:e2e", "test:e2e:smoke"];

/** サンプルではなく、利用環境でもそのまま使えるデータ（祝日・作業種類の既定） */
export const STARTER_DATA_KEEP = new Set(["data/holidays.csv", "data/task-types.csv"]);

const posix = (p) => p.split(sep).join("/");

/** テストのファイルが相対パスで読み込む、tests/ の中のファイル（ヘルパー）を辿った一式 */
export function testClosure(root, entries = [...USER_TESTS, ...TEST_HELPERS]) {
  const out = new Set();
  const queue = [...entries];
  while (queue.length) {
    const f = queue.shift();
    if (out.has(f)) continue;
    out.add(f);
    let text;
    try {
      text = readFileSync(join(root, f), "utf-8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/\bfrom\s*["'](\.{1,2}\/[^"']+)["']|\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
      const dep = posix(normalize(join(dirname(f), m[1] ?? m[2]))).replace(/\.js$/, ".ts");
      if (dep.startsWith("tests/")) queue.push(dep);
    }
  }
  return out;
}

/**
 * 利用環境に配るか。tests は testClosure の結果（利用環境で動かすテストとヘルパー）
 * @param {string} path プロジェクトからの相対パス（/ 区切り）
 * @param {Set<string>} tests
 */
export function isShipped(path, tests) {
  if (DEV_FILES.has(path) || DEV_DIRS.some((d) => path.startsWith(d))) return false;
  if (path.startsWith("tests/")) return path.startsWith(FIXTURES_DIR) || tests.has(path);
  return true;
}

/**
 * 空の data/ に入れる中身（サンプルを除いたもの）。null なら入れない。
 * CSV は見出しの行だけ（列の形は残す）、作業実績（data/worklogs/）は入れない。祝日・作業種類はそのまま
 * @param {string} path data/ から始まるパス
 * @param {Buffer} buf サンプルの中身
 */
export function starterData(path, buf) {
  if (STARTER_DATA_KEEP.has(path)) return buf;
  if (path.startsWith("data/worklogs/")) return null;
  if (!path.endsWith(".csv")) return null;
  const text = buf.toString("utf-8");
  const end = text.indexOf("\n");
  return Buffer.from(end < 0 ? `${text}\n` : text.slice(0, end + 1), "utf-8");
}

/**
 * 利用環境のプロジェクトの名前（package.json・package-lock.json の name）。コマンドのパッケージ名 yojitsu-navi と同じにすると、
 * プロジェクトの中の npx yojitsu-navi が自分自身（bin が無い）を指して「could not determine executable to run」で動かない（SPEC §91.3）
 */
export const PROJECT_PACKAGE_NAME = "yojitsu-navi-site";

/** 利用環境の package.json（開発元だけの scripts を外し、名前を PROJECT_PACKAGE_NAME にする。書式は 2 文字下げ＋最後に改行） */
export function userPackageJson(text) {
  const pkg = JSON.parse(text);
  for (const s of DEV_SCRIPTS) delete pkg.scripts?.[s];
  pkg.name = PROJECT_PACKAGE_NAME;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** 利用環境の package-lock.json（名前を package.json に合わせる。ほかは変えない） */
export function userPackageLock(text) {
  const lock = JSON.parse(text);
  lock.name = PROJECT_PACKAGE_NAME;
  if (lock.packages?.[""]) lock.packages[""].name = PROJECT_PACKAGE_NAME;
  return `${JSON.stringify(lock, null, 2)}\n`;
}
