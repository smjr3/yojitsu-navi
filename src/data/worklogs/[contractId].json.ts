/**
 * 契約ごとの作業ログ明細（遅延読み込み用）。observablehq.config.js の dynamicPaths で列挙する。
 *
 *   npx tsx 'src/data/worklogs/[contractId].json.ts' --contractId=C001
 *
 * 契約の数だけ別プロセスで動くので、最初の 1 回で全契約分を作り置きし、2 回目以降はそれを読む（_shared.ts）。
 */
import { argValue, emitText, worklogDetailJson } from "../_shared.js";
import { contractIdFromWorklogKey } from "../../components/worklog-key.js";

const rawId = argValue("contractId");
// observablehq.config.js の dynamicPaths は worklogKey(id) でパスを作る
const contractId = rawId === undefined ? undefined : contractIdFromWorklogKey(rawId);
if (!contractId) {
  console.error("--contractId=... が必要です");
  process.exit(1);
}
// 作り置きの JSON は書いたときに検査済み。ここでは文字列のまま出す（パースし直さない）
emitText(() => worklogDetailJson(contractId));
