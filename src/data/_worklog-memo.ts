/**
 * 作業ログ明細の作り置き（src/data/worklogs/[contractId].json.js から呼ぶ。単体でも動く）
 *
 *   npx tsx src/data/_worklog-memo.ts C001     # 全契約分を作り置きし、C001 の明細を標準出力に出す
 */
import { emitText, worklogDetailJson } from "./_shared.js";

const contractId = process.argv[2];
if (!contractId) {
  console.error("契約 ID を指定してください");
  process.exit(1);
}
emitText(() => worklogDetailJson(contractId));
