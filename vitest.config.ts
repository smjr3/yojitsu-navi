import { defineConfig } from "vitest/config";
import { defaultMaxWorkers, scaled } from "./tests/test-env.js";

// 遅い環境（Windows の Runner・PC）向けの調整は環境変数で行う（docs/OPERATIONS.md「テストを Windows で動かす」、SPEC §79.1）
//   YOJITSU_TEST_TIMEOUT_SCALE … タイムアウトの倍率（既定: Windows 3・それ以外 1）
//   VITEST_MAX_FORKS           … 同時に動かすワーカーの数（既定: Windows 2・それ以外 CPU の数 - 1）。Vitest 4 の VITEST_MAX_WORKERS と同じ意味で、
//                                Vitest 3 のころの名前を設定済みの CI がそのまま使えるようにここで読む（両方あれば VITEST_MAX_WORKERS）
//   YOJITSU_PERF               … 性能テストの判定（loose 既定・strict・report。tests/test-env.ts）
// Windows は並列で動かすとワーカーの通信がタイムアウトすることがある（導入先の Runner で発生）ので、既定で 2 つまでにする（tests/test-env.ts）
const maxWorkers = defaultMaxWorkers();

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/property/**/*.test.ts", "tests/integration/**/*.test.ts", "tests/fuzz/**/*.test.ts"],
    // 別プロセスを使うテスト（結合テスト）があるので、ワーカーは子プロセス（forks。Vitest の既定）を明示する
    pool: "forks",
    ...(maxWorkers ? { maxWorkers } : {}),
    // 結合テストは実運用規模（作業実績 約 10 万行）のダミーデータを何度も読むので、並列実行の負荷で 5 秒を超えることがある
    testTimeout: scaled(30_000),
    hookTimeout: scaled(60_000),
    teardownTimeout: scaled(10_000),
    coverage: { provider: "v8", include: ["src/core/**"] },
  },
});
