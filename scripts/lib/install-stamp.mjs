// 依存（node_modules）を入れ直さなくてよいかの印（SPEC §104・§126）。Node の標準モジュールだけを使う
//   - CI の before_script（scripts/ci/install.mjs）と yojitsu-navi upgrade が同じ印を使う
//   - 印は node_modules/ の中に置く（npm ci が node_modules を消すと印も消える）
// プロジェクトにも入る。yojitsu-navi コマンドには npm run app:build が packages/app/lib に写す
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const INSTALL_STAMP = "node_modules/.yojitsu-navi-install.json";
const VENDOR_CACHE = "vendor/npm-cache";

/** 依存の中身を決めるもの（package-lock.json・依存込みのキャッシュの有無・Node の主な版・OS） */
export function installKey(dir, nodeVersion = process.version, platform = `${process.platform}-${process.arch}`) {
  const lock = join(dir, "package-lock.json");
  const h = createHash("sha256").update(existsSync(lock) ? readFileSync(lock) : Buffer.alloc(0)).digest("hex");
  return { lock: h, vendor: existsSync(join(dir, VENDOR_CACHE)), node: nodeVersion.split(".")[0], platform };
}

/** 前に入れた依存がそのまま使えるか（node_modules があり、印が今の lock ファイルなどと同じ） */
export function installUpToDate(dir, key = installKey(dir)) {
  try {
    const s = JSON.parse(readFileSync(join(dir, INSTALL_STAMP), "utf-8"));
    return s.lock === key.lock && s.vendor === key.vendor && s.node === key.node && s.platform === key.platform;
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
