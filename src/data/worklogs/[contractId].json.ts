/**
 * 契約ごとの作業ログ明細（遅延読み込み用）。observablehq.config.js の dynamicPaths で列挙する。
 *
 *   npx tsx 'src/data/worklogs/[contractId].json.ts' --contractId=C001
 */
import { argValue, buildModelFromData } from "../_shared.js";

const rawId = argValue("contractId");
// observablehq.config.js の dynamicPaths は encodeURIComponent 済みの ID でパスを作る
const contractId = rawId === undefined ? undefined : decodeURIComponent(rawId);
if (!contractId) {
  console.error("--contractId=... が必要です");
  process.exit(1);
}
const model = buildModelFromData();
const result = model.contracts.find((r) => r.contract.contractId === contractId);
const out = result
  ? {
      contractId,
      asOf: model.meta.asOf,
      worklogFetchedAt: model.meta.worklogFetchedAt,
      months: result.months.map((m) => ({ month: m.month, status: m.status, worklogs: m.worklogs })),
    }
  : { contractId, asOf: model.meta.asOf, worklogFetchedAt: model.meta.worklogFetchedAt, months: [], notFound: true };
process.stdout.write(JSON.stringify(out));
