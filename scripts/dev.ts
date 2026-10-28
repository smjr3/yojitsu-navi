/**
 * 開発プレビュー（npm run dev）: キャッシュの点検 → observable preview ＋ 入力の監視
 *
 * プレビューはローダのファイルが更新されたときしか作り直さない。CSV・config.json・計算コアを直したときも
 * 作り直されるよう、入力を監視して指紋が変わったらキャッシュを捨て、ローダのファイルの更新時刻を進める
 * （中身は変えない）。ブラウザは自動で読み込み直す。
 */
import { spawn } from "node:child_process";
import { readdirSync, utimesSync, watch } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeFingerprint, INPUT_PATHS, resolveAsOf } from "./lib/inputs.js";
import { prepareLoaderCache } from "./lib/loader-cache.js";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const OBSERVABLE = join(ROOT, "node_modules", "@observablehq", "framework", "dist", "bin", "observable.js");

function loaderFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...loaderFiles(p));
    else if (/\.(json|csv)\.(ts|js)$/.test(e.name) || e.name === "rules.md.js") out.push(p);
  }
  return out;
}

let last = computeFingerprint(ROOT, { asOf: resolveAsOf() });
const prep = prepareLoaderCache(ROOT, last);
console.log(`[dev] 指紋 ${last.hash.slice(0, 12)}…${prep.cleared ? "（ローダのキャッシュを捨てました）" : ""}`);

let timer: NodeJS.Timeout | null = null;
const onChange = () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      const fp = computeFingerprint(ROOT, { asOf: resolveAsOf() });
      if (fp.hash === last.hash) return;
      last = fp;
      prepareLoaderCache(ROOT, fp);
      const now = new Date();
      for (const f of [...loaderFiles(join(ROOT, "src", "data")), join(ROOT, "src", "rules.md.js")]) utimesSync(f, now, now);
      console.log(`[dev] 入力が変わったのでデータを作り直します（指紋 ${fp.hash.slice(0, 12)}…）`);
    } catch (e) {
      console.error(`[dev] 入力の確認に失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, 400);
};
for (const p of INPUT_PATHS) {
  if (p === "src/data" || p === "src/rules.md.js") continue; // ローダ自体の変更はプレビューが自分で拾う
  try {
    watch(join(ROOT, p), { recursive: true }, onChange);
  } catch {
    /* 無いパスは監視しない */
  }
}

const child = spawn(process.execPath, [OBSERVABLE, "preview", ...process.argv.slice(2)], { cwd: ROOT, stdio: "inherit" });
child.on("close", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
