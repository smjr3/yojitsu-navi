/** E2E 全体で共有する定数（globalSetup とテストの両方から読む） */
import { fileURLToPath } from "node:url";

/** ビルドとテストの計算基準日。dist/ と core の期待値をこの日付で揃える */
export const AS_OF = "2026-10-27";
/** リポジトリのルート */
export const ROOT_DIR = fileURLToPath(new URL("../../", import.meta.url));
export const PORT = Number(process.env.E2E_PORT ?? 4173);
export const BASE_URL = `http://127.0.0.1:${PORT}`;
