/**
 * OpenCode v1 entry (`server()`, 1.17 and later). v1 gives a server plugin no way
 * to write into the TUI status bar, so v1 gets toasts and the `quota` tool only.
 */
import type { Hooks, Plugin, PluginOptions } from "@opencode-ai/plugin";
import { resolveConfig, type QuotaPluginOptions } from "../config.js";
import { log } from "../log.js";
import { modelsFromConfig } from "../models.js";
import { createQuotaService, type Target } from "../service.js";
import { tokenFor } from "../token-source.js";
import { renderDetail, TOOL_DESCRIPTION } from "../view.js";

type Client = Parameters<Plugin>[0]["client"];

interface ProviderShape {
  options?: { baseURL?: unknown };
  models?: Record<string, { id?: string; name?: string } | undefined>;
}

export async function v1Target(
  client: Client,
  providerId: string,
  labels: Record<string, string>,
): Promise<Target | undefined> {
  const response = await client.config.get();
  const provider = (response.data?.provider as Record<string, ProviderShape | undefined> | undefined)?.[
    providerId
  ];
  const baseURL = provider?.options?.baseURL;
  if (typeof baseURL !== "string" || !baseURL) return undefined;
  return { baseURL, models: modelsFromConfig(provider?.models, labels) };
}

export const QuotaPluginV1: Plugin = async (input, options?: PluginOptions) => {
  const config = resolveConfig((options ?? {}) as QuotaPluginOptions);
  if (!config.enabled) {
    log.info("disabled (enabled: false)");
    return {};
  }

  const service = createQuotaService({
    config,
    resolveTarget: () => v1Target(input.client, config.providerId, config.labels),
    getToken: () => tokenFor(config.providerId),
    onToast: (toast) => {
      input.client.tui
        .showToast({ body: { title: "Quota", message: toast.message, variant: toast.variant } })
        .catch(() => {});
    },
  });
  service.start();
  log.info(`started (v1): provider=${config.providerId} interval=${config.intervalMs / 1000}s`);

  const hooks: Hooks = {
    event: async ({ event }) => {
      if (event.type !== "message.updated") return;
      const info = event.properties.info;
      if (info.role === "assistant" && info.providerID === config.providerId && info.time.completed) {
        service.requestRefresh(info.modelID);
      }
    },
    tool: {
      quota: {
        description: TOOL_DESCRIPTION,
        args: {},
        execute: async () => renderDetail(await service.current()),
      },
    },
    dispose: async () => service.stop(),
  };
  return hooks;
};
