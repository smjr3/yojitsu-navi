/**
 * データローダの「入力の指紋」（Node 側専用）
 *
 * Observable Framework のローダのキャッシュ（src/.observablehq/cache）は、ローダのファイル自体の更新時刻しか見ない。
 * しかも `observable build` は古いキャッシュでもそのまま使う。CSV・config.json・計算コアを直しても、
 * キャッシュが残っていると古い数値のまま公開されてしまう。
 *
 * そこでローダの出力を左右するものを全部まとめてハッシュにし（= 指紋）、
 *   - ビルド・プレビューの前に、前回の指紋と違えばローダのキャッシュを捨てる（loader-cache.ts）
 *   - ローダの出力に指紋を埋め込み、ビルド後に全出力の指紋が今の指紋と一致するか確かめる（verify-dist.ts）
 * の 2 段で、古い出力・混ざった出力が公開されないようにする。
 *
 * 指紋に入るもの:
 *   data/ 配下の全ファイル、config.json、計算コア・ローダ・文言（src/core, src/data, src/i18n, worklog-key.js）、
 *   Node 側の読み込み処理（scripts/lib, scripts/adapters）、package-lock.json、計算基準日（asOf）、
 *   マスタ編集が使う Git の最終コミット（HEAD と data/ の未コミット変更の有無）、
 *   GitLab の接続先の環境変数（YOJITSU_GITLAB_*。§38.1）
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { GITLAB_ENV_KEYS } from "../../src/components/gitlab-env.js";

/** 指紋の計算方法を変えたら上げる（古い指紋のキャッシュを確実に捨てるため） */
export const FINGERPRINT_VERSION = 2;

/** ローダの出力を左右するファイル・フォルダ（プロジェクトルートからの相対パス） */
export const INPUT_PATHS = [
  "data",
  "config.json",
  "package-lock.json",
  "src/core",
  "src/data",
  "src/i18n",
  "src/components/worklog-key.js",
  "src/components/gitlab-env.js",
  "src/rules.md.js",
  "scripts/lib",
  "scripts/adapters",
] as const;

/** 今日の日付（JST）を YYYY-MM-DD で返す */
export function todayJst(now: Date = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

/** 計算基準日: 環境変数 YOJITSU_AS_OF（YYYY-MM-DD）、無ければ今日（JST） */
export function resolveAsOf(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.YOJITSU_AS_OF?.trim();
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : todayJst();
}

/** パス配下のファイルを再帰で列挙（並びは決定的。一時ファイル・隠しフォルダ・OS のゴミは除く） */
export function listInputFiles(rootDir: string, paths: readonly string[] = INPUT_PATHS): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        if (name.startsWith(".") || name === "node_modules") continue;
        walk(join(abs, name));
      }
    } else if (st.isFile()) {
      const name = abs.slice(abs.lastIndexOf(sep) + 1);
      if (/\.tmp-\d+-[0-9a-f]{8}$/.test(name) || name === "Thumbs.db" || name === "desktop.ini") return;
      out.push(relative(rootDir, abs).split(sep).join("/"));
    }
  };
  for (const p of paths) walk(join(rootDir, p));
  return [...new Set(out)].sort();
}

function git(rootDir: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: rootDir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export interface Fingerprint {
  /** 16 進 64 文字 */
  hash: string;
  asOf: string;
  files: number;
}

/**
 * 入力の指紋を計算する。内容（バイト列）で比べるので、更新時刻だけ変わった（git checkout など）ときは同じ値になる
 * @param opts.git false にすると Git の状態を含めない（テスト用）
 */
export function computeFingerprint(rootDir: string, opts: { asOf?: string; git?: boolean; paths?: readonly string[]; env?: NodeJS.ProcessEnv } = {}): Fingerprint {
  const asOf = opts.asOf ?? resolveAsOf();
  const h = createHash("sha256");
  h.update(`v${FINGERPRINT_VERSION}\0asOf=${asOf}\0`);
  // マスタ編集の接続先（masters.json）は環境変数でも変わる
  for (const k of GITLAB_ENV_KEYS) h.update(`${k}=${(opts.env ?? process.env)[k] ?? ""}\0`);
  const files = listInputFiles(rootDir, opts.paths ?? INPUT_PATHS);
  for (const f of files) {
    const bytes = readFileSync(join(rootDir, f));
    h.update(`${f}\0${bytes.length}\0`);
    h.update(bytes);
    h.update("\0");
  }
  if (opts.git !== false && existsSync(join(rootDir, ".git"))) {
    // マスタ編集（masters.json）は各ファイルの最終コミット ID を持つので、コミットが変わったら作り直す
    h.update(`head=${git(rootDir, ["rev-parse", "HEAD"]) ?? ""}\0`);
    h.update(`shallow=${git(rootDir, ["rev-parse", "--is-shallow-repository"]) ?? ""}\0`);
  }
  return { hash: h.digest("hex"), asOf, files: files.length };
}
