// 依存（node_modules）を入れ直さなくてよいかの印（SPEC §104・§126）。Node の標準モジュールだけを使う
//   - CI の before_script（scripts/ci/install.mjs）と yojitsu-navi upgrade が同じ印を使う
//   - 印は node_modules/ の中に置く（npm ci が node_modules を消すと印も消える）
// プロジェクトにも入る。yojitsu-navi コマンドには npm run app:build が packages/app/lib に写す
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const INSTALL_STAMP = "node_modules/.yojitsu-navi-install.json";
const VENDOR_CACHE = "vendor/npm-cache";

/** package.json のうち依存を決める項目 */
const MANIFEST_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides", "workspaces", "allowScripts"];

/** ファイルの SHA-256（無ければ空の中身として） */
export function fileHash(file) {
  return createHash("sha256").update(existsSync(file) ? readFileSync(file) : Buffer.alloc(0)).digest("hex");
}

/**
 * package.json の依存の項目の SHA-256。lock ファイルと食い違う変更（依存を足したのに lock を直していない）も
 * 入れ直しにして、npm ci に止めさせる（版の番号などほかの項目だけの変更では入れ直さない）
 */
export function manifestHash(file) {
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(file, "utf-8"));
  } catch {}
  const picked = Object.fromEntries(MANIFEST_FIELDS.map((k) => [k, pkg[k] ?? null]));
  return createHash("sha256").update(JSON.stringify(picked)).digest("hex");
}

/** 依存の中身を決めるもの（package-lock.json・package.json の依存の項目・依存込みのキャッシュの有無・Node の主な版・OS） */
export function installKey(dir, nodeVersion = process.version, platform = `${process.platform}-${process.arch}`) {
  return {
    lock: fileHash(join(dir, "package-lock.json")),
    manifest: manifestHash(join(dir, "package.json")),
    vendor: existsSync(join(dir, VENDOR_CACHE)),
    node: nodeVersion.split(".")[0],
    platform,
  };
}

/** 前に入れた依存がそのまま使えるか（node_modules があり、印が今の lock ファイルなどと同じ） */
export function installUpToDate(dir, key = installKey(dir)) {
  try {
    const s = JSON.parse(readFileSync(join(dir, INSTALL_STAMP), "utf-8"));
    return s.lock === key.lock && s.manifest === key.manifest && s.vendor === key.vendor && s.node === key.node && s.platform === key.platform;
  } catch {
    return false;
  }
}

/** 入れ終わったときに印を書く（node_modules が無ければ書かない） */
export function writeInstallStamp(dir, key = installKey(dir)) {
  if (existsSync(join(dir, "node_modules"))) writeFileSync(join(dir, INSTALL_STAMP), `${JSON.stringify(key)}\n`);
}

/** 入れ始める前に印を消す（途中で止まった node_modules を「入れ終わった」と見なさない） */
export function clearInstallStamp(dir) {
  rmSync(join(dir, INSTALL_STAMP), { force: true });
}
