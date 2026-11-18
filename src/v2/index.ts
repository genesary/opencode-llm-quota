/**
 * OpenCode v2 server entry (`setup`, 2.0.25 and later). The token comes from the
 * host connection, which the host refreshes through opencode-keycloak-auth, so
 * nothing here talks to Keycloak. The v2 server has no UI: it publishes to the
 * TUI part over RPC and registers a `quota` tool that works without it.
 */
import type { Plugin } from "@opencode/plugin";
import { resolveConfig, type QuotaPluginOptions } from "../config.js";
import { log } from "../log.js";
import { labelFor } from "../models.js";
import { QUOTA_RPC } from "../rpc.js";
import { createQuotaService, type ModelRef, type Snapshot, type Target } from "../service.js";
import { renderDetail, TOOL_DESCRIPTION } from "../view.js";

type Context = Plugin.Context;
export type SetupContext = Pick<
  Context,
  "options" | "provider" | "model" | "integration" | "event" | "rpc" | "tool"
>;

interface ProviderInfoShape {
  integrationID?: string;
  settings?: Record<string, unknown>;
}

interface ModelInfoShape {
  id: string;
  modelID?: string;
  providerID: string;
  name?: string;
}

/** OpenCode v1 (1.17 at least) also calls `setup()`, with a context missing these domains. */
export function isV2Host(ctx: Partial<SetupContext>): boolean {
  return (
    typeof ctx.provider?.get === "function" &&
    typeof ctx.model?.list === "function" &&
    typeof ctx.integration?.connection?.resolve === "function" &&
    typeof ctx.event?.subscribe === "function"
  );
}

export async function setupV2(ctx: SetupContext): Promise<Plugin.Cleanup | void> {
  if (!isV2Host(ctx)) {
    log.debug("setup() called without the v2 host API; the v1 entry handles this host");
    return;
  }
  const config = resolveConfig((ctx.options ?? {}) as QuotaPluginOptions);
  if (!config.enabled) {
    log.info("disabled (enabled: false)");
    return;
  }
  let integrationID = config.providerId;

  const resolveTarget = async (): Promise<Target | undefined> => {
    const provider = (await ctx.provider.get({ providerID: config.providerId })).data as ProviderInfoShape;
    integrationID = provider.integrationID ?? config.providerId;
    const baseURL = provider.settings?.["baseURL"];
    if (typeof baseURL !== "string" || !baseURL) return undefined;
    const models = ((await ctx.model.list()).data as ModelInfoShape[])
      .filter((m) => m.providerID === config.providerId)
      .map((m): ModelRef => ({
        id: m.id,
        apiName: m.modelID || m.id,
        label: labelFor(config.labels, m.id, m.modelID || m.id, m.name),
      }));
    return { baseURL, models };
  };

  const getToken = async (): Promise<string | undefined> => {
    const connection = await ctx.integration.connection.active(integrationID);
    if (!connection) return undefined;
    const value = await ctx.integration.connection.resolve(connection);
    return value?.type === "oauth" && value.access ? value.access : undefined;
  };

  type Emit = (name: "changed" | "toast", data: Record<string, unknown>) => Promise<void>;
  let emit: Emit | undefined;

  const service = createQuotaService({
    config,
    resolveTarget,
    getToken,
    onToast: (toast) => void emit?.("toast", { ...toast }).catch(() => {}),
    onChange: (snapshot: Snapshot) => {
      // Sent after every cycle, changed or not, so a TUI that started late catches up.
      void emit?.("changed", toJson(snapshot)).catch(() => {});
    },
  });

  const disposers: Array<() => Promise<void> | void> = [];

  // If RPC fails, the tool still works.
  try {
    const registration = await ctx.rpc.register(
      QUOTA_RPC as never,
      {
        snapshot: async () => toJson(service.snapshot()) as never,
      } as never,
    );
    const events = (registration as unknown as { events: { emit: (...args: unknown[]) => Promise<void> } })
      .events;
    emit = (name, data) => events.emit(name, data);
    disposers.push(() => registration.dispose());
  } catch (cause) {
    log.warn(
      `RPC registration failed, no status bar/toasts: ${cause instanceof Error ? cause.message : cause}`,
    );
  }

  try {
    const tool = await ctx.tool.transform((editor) => {
      editor.add({
        name: "quota",
        description: TOOL_DESCRIPTION,
        input: { type: "object", properties: {} },
        execute: async () => ({ content: renderDetail(await service.current()) }),
      } as never);
    });
    disposers.push(() => tool.dispose());
  } catch (cause) {
    log.warn(`quota tool registration failed: ${cause instanceof Error ? cause.message : cause}`);
  }

  const abort = new AbortController();
  disposers.push(() => abort.abort());
  void followResponses(ctx, config.providerId, abort.signal, (model) => service.requestRefresh(model));

  service.start();
  log.info(`started (v2): provider=${config.providerId} interval=${config.intervalMs / 1000}s`);

  return async () => {
    service.stop();
    await Promise.all(disposers.map((dispose) => Promise.resolve(dispose()).catch(() => {})));
  };
}

/** The host validates RPC payloads as JSON, which has no `undefined`. */
export function toJson(snapshot: Snapshot): Record<string, unknown> {
  return JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
}

interface StepEvent {
  type: string;
  data?: { assistantMessageID?: string; model?: { id?: string; providerID?: string } };
}

/** Calls `onEnd(modelId)` when a response of the provider ends, failed or not. */
export async function followResponses(
  ctx: Pick<SetupContext, "event">,
  providerId: string,
  signal: AbortSignal,
  onEnd: (model: string) => void,
): Promise<void> {
  const models = new Map<string, string>();
  const subscribe = ctx.event.subscribe as (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>;
  // The stream ends on a host restart; periodic reads continue while it reconnects.
  while (!signal.aborted) {
    try {
      for await (const raw of subscribe({ signal })) handle(raw as StepEvent);
    } catch (cause) {
      if (!signal.aborted) log.debug(`event stream ended: ${cause instanceof Error ? cause.message : cause}`);
    }
    if (!signal.aborted) await sleep(RESUBSCRIBE_MS, signal);
  }

  function handle(event: StepEvent): void {
    const messageID = event.data?.assistantMessageID;
    if (!messageID) return;
    if (event.type === "session.step.started") {
      const model = event.data?.model;
      if (model?.providerID === providerId && model.id) models.set(messageID, model.id);
    } else if (event.type === "session.step.ended" || event.type === "session.step.failed") {
      const model = models.get(messageID);
      models.delete(messageID);
      if (model) onEnd(model);
    }
    if (models.size > 1000) models.clear();
  }
}

const RESUBSCRIBE_MS = 5_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });
}
