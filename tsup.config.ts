import { defineConfig } from "tsup";

export default defineConfig({
  // Two self-contained files: the server part (OpenCode v1 `server()` and v2
  // `setup()`, also shipped alone as opencode-llm-quota.js) and the v2 TUI
  // part. Without splitting, each file inlines what it needs, and the lazy
  // `import("./v2/index.js")` stays a deferred module initializer.
  entry: ["src/index.ts", "src/tui.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  // Nothing is bundled from OpenCode: types only, except @opentui/solid, which the
  // host provides to TUI plugins at runtime (its own instance).
  external: ["@opencode-ai/plugin", "@opencode-ai/sdk", "@opencode/plugin", "@opentui/solid"],
});
