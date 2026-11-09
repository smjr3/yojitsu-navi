/**
 * 増分ビルドの前処理（scripts/build.ts が別プロセスで呼ぶ。単体で使うものではない）。中身は scripts/lib/prebuild.ts
 *
 * 入力の指紋・計算基準日は環境変数で受け取る（ローダと同じ: YOJITSU_INPUT_HASH・YOJITSU_CODE_HASH・YOJITSU_AS_OF・YOJITSU_AS_OF_FIXED）。
 * 終わったら記録（.yojitsu-outputs.json）の件数を 1 行の JSON で標準出力に出す
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prebuildOutputs } from "./lib/prebuild.js";
import { resolveAsOf } from "./lib/inputs.js";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const hash = process.env.YOJITSU_INPUT_HASH?.trim() ?? "";
const codeHash = process.env.YOJITSU_CODE_HASH?.trim() ?? "";
if (!/^[0-9a-f]{64}$/.test(hash) || !/^[0-9a-f]{64}$/.test(codeHash)) {
  console.error("[prebuild] YOJITSU_INPUT_HASH・YOJITSU_CODE_HASH がありません（npm run build から呼んでください）");
  process.exit(2);
}
// 計算コアなどの console.log は _shared.ts が標準エラーに回すので、標準出力は最後の 1 行だけになる
const write = process.stdout.write.bind(process.stdout);
try {
  const m = prebuildOutputs(ROOT, { hash, codeHash, asOf: resolveAsOf() });
  write(`${JSON.stringify(m.stats)}\n`);
} catch (error) {
  console.error(`[prebuild] 失敗: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
}
