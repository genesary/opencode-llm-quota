import { defineConfig } from "vitest/config";

// Real OpenCode binaries, run one file at a time: `npm run test:e2e`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/e2e/**/*.e2e.test.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 180_000,
    hookTimeout: 600_000,
  },
});
