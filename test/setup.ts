import { beforeEach } from "vitest";

// Silence the plugin's logger unless a test opts in with
// `vi.stubEnv("OPENCODE_QUOTA_LOG", "warn")` (restored by `unstubEnvs`).
process.env.OPENCODE_QUOTA_LOG = "silent";

// The read ledger is process-wide by design; every test starts with an empty one.
beforeEach(() => {
  delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("opencode-llm-quota/reads@1")];
});
