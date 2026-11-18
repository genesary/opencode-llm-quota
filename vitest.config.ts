import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Real OpenCode runs, slow and stateful: `npm run test:e2e` only.
    exclude: ["test/e2e/**", "node_modules/**"],
    setupFiles: ["test/setup.ts"],
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
  },
});
