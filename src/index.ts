/**
 * Server part. Plain `{ id, setup, server }` export: OpenCode v2 calls `setup`
 * (the v2 code loads lazily), v1 calls `server`. The v2 TUI part is `./tui`.
 */
import type { Plugin as V2Plugin } from "@opencode/plugin";
import { PLUGIN_ID } from "./id.js";
import { QuotaPluginV1 } from "./v1/index.js";

export type { QuotaPluginOptions } from "./config.js";
export { PLUGIN_ID };

const plugin = {
  id: PLUGIN_ID,
  setup: async (ctx: V2Plugin.Context): Promise<V2Plugin.Cleanup | void> => {
    const { setupV2 } = await import("./v2/index.js");
    return setupV2(ctx);
  },
  server: QuotaPluginV1,
};

export default plugin;
