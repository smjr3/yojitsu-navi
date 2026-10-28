/**
 * 契約ごとの作業ログ明細（遅延読み込み用）。observablehq.config.js の dynamicPaths で列挙する。
 *
 *   node 'src/data/worklogs/[contractId].json.js' --contractId=C001
 *
 * 契約の数だけ別プロセスで動く（実運用規模で 100 件以上）。1 件ごとに TypeScript の計算コアを読み込むと
 * それだけで数十秒かかるので、このローダは素の JavaScript にして、最初の 1 回だけ src/data/_worklog-memo.ts が
 * 全契約分を作り置きし、2 回目以降は作り置きをそのまま出す（作り置きの場所・作り方は _shared.ts）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contractIdFromWorklogKey, worklogKey } from "../../components/worklog-key.js";

const prefix = "--contractId=";
const rawId = process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
// observablehq.config.js の dynamicPaths は worklogKey(id) でパスを作る
const contractId = rawId === undefined ? undefined : contractIdFromWorklogKey(rawId);
if (!contractId) {
  console.error("--contractId=... が必要です");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// scripts/build.ts が渡す入力の指紋があり、作り置きが完成していれば、それをそのまま出す（_shared.ts の worklogMemoDir と同じ場所）
const hash = process.env.YOJITSU_INPUT_HASH?.trim();
const dir = hash && /^[0-9a-f]{64}$/.test(hash) ? join(root, "src", ".observablehq", "cache", ".yojitsu", `worklogs-${hash.slice(0, 16)}`) : null;
const file = dir ? join(dir, `${worklogKey(contractId)}.json`) : null;
if (dir && file && existsSync(join(dir, ".complete")) && existsSync(file)) {
  process.stdout.write(readFileSync(file));
} else {
  // 作り置きが無い（初回・単体実行）: 計算コアで作る。結果は標準出力にそのまま流す
  const r = spawnSync(process.execPath, ["--import", "tsx", join(root, "src", "data", "_worklog-memo.ts"), contractId], { cwd: root, stdio: ["ignore", "inherit", "inherit"], env: process.env });
  if (r.error) {
    console.error(`[loader] 作業ログ明細を作れませんでした: ${r.error.message}`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}
