import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/property/**/*.test.ts", "tests/integration/**/*.test.ts", "tests/fuzz/**/*.test.ts"],
    // 結合テストは実運用規模（作業実績 約 10 万行）のダミーデータを何度も読むので、並列実行の負荷で 5 秒を超えることがある
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: { provider: "v8", include: ["src/core/**"] },
  },
});
