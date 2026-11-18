/**
 * RPC contract between the server part, which holds the token, and the TUI part.
 * Plain JSON Schemas, so neither side needs `effect` at runtime. Payloads carry
 * display data only.
 */
export const QUOTA_RPC = {
  id: "opencode-llm-quota",
  methods: {
    /** The current {@link Snapshot} (gateway origin and one view per model). */
    snapshot: { input: { type: "object" }, output: { type: "object" } },
  },
  events: {
    /** A new {@link Snapshot}, after every read cycle that changed something. */
    changed: { schema: { type: "object" } },
    /** A state change worth a toast: `{ variant, message }`. */
    toast: { schema: { type: "object" } },
  },
} as const;
