/**
 * TUI part (OpenCode v2): the selected model's line after `prompt.footer.status`,
 * toasts relayed from the server part, and `/quota`. Data arrives over RPC, so the
 * TUI never holds the token. `@opentui/solid` must be the host's instance.
 */
import type { Plugin } from "@opencode/plugin/tui";
import { createElement, insert, setProp } from "@opentui/solid";
import { resolveConfig, type QuotaPluginOptions } from "./config.js";
import { QUOTA_RPC } from "./rpc.js";
import type { Snapshot } from "./service.js";
import { currentLine, renderDetail } from "./view.js";
import { PLUGIN_ID } from "./id.js";
import { log } from "./log.js";

type Context = Plugin.Context;

interface RpcClient {
  snapshot: (input: object) => Promise<unknown>;
  events: {
    on: (name: "changed" | "toast", handler: (event: { data: unknown }) => void) => () => void;
  };
}

const EMPTY: Snapshot = { gateway: undefined, models: [] };

const isSnapshot = (value: unknown): value is Snapshot =>
  typeof value === "object" && value !== null && Array.isArray((value as Snapshot).models);

export async function setupTui(ctx: Context): Promise<Plugin.Cleanup | void> {
  const config = resolveConfig((ctx.options ?? {}) as QuotaPluginOptions);
  if (!config.enabled) return;

  const [state, setState] = ctx.storage.memory<{ snapshot: Snapshot }>("quota", {
    initial: { snapshot: EMPTY },
  });
  const update = (value: unknown): void => {
    if (isSnapshot(value)) setState((draft) => void (draft.snapshot = value));
  };

  const rpc = (ctx.client as unknown as { rpc: (definition: unknown) => RpcClient }).rpc(QUOTA_RPC);
  const cleanups: Array<() => void> = [];
  let received = false;

  cleanups.push(
    rpc.events.on("changed", (event) => {
      received = true;
      update(event.data);
    }),
  );
  if (config.toasts) {
    cleanups.push(
      rpc.events.on("toast", (event) => {
        const toast = event.data as { message?: unknown; variant?: unknown };
        if (typeof toast.message !== "string") return;
        const variant = ["info", "success", "warning", "error"].includes(String(toast.variant))
          ? (toast.variant as "info" | "success" | "warning" | "error")
          : "info";
        ctx.ui.toast.show({ title: "Quota", message: toast.message, variant });
      }),
    );
  }
  // The server part of this location may register after the TUI starts (`rpc.unavailable`).
  let retry: ReturnType<typeof setTimeout> | undefined;
  const fetchSnapshot = (delayMs: number): void => {
    rpc.snapshot({}).then(
      (value) => {
        received = true;
        update(value);
      },
      (cause: unknown) => {
        log.debug(
          `tui: snapshot unavailable: ${cause instanceof Error ? cause.message : JSON.stringify(cause)}`,
        );
        if (received) return;
        retry = setTimeout(() => fetchSnapshot(Math.min(delayMs * 2, 60_000)), delayMs);
        retry.unref?.();
      },
    );
  };
  fetchSnapshot(2_000);
  cleanups.push(() => clearTimeout(retry));

  cleanups.push(
    ctx.ui.slot({
      after: "prompt.footer.status",
      render: () => {
        const node = createElement("text");
        // The home footer is narrow: cut the line instead of wrapping it.
        setProp(node, "wrapMode", "none");
        setProp(node, "truncate", true);
        insert(node, () => currentLine(state.snapshot, ctx.ui.model.current(), config.providerId) ?? "");
        return node as never;
      },
    }),
  );

  // Like the built-in plugins: a layer created inside a render lives with it, and
  // "global" keeps the command reachable from the prompt.
  cleanups.push(
    ctx.ui.slot({
      append: "app",
      render: () => {
        ctx.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "quota.show",
              title: "Quota",
              description: "AI platform quotas for every model",
              group: "Quota",
              palette: true,
              slash: { name: "quota" },
              run: () => {
                void ctx.ui.dialog.alert({ title: "Quota", message: renderDetail(state.snapshot) });
              },
            },
          ],
        }));
        return null as never;
      },
    }),
  );

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

const tui = { id: PLUGIN_ID, setup: setupTui };

export default tui;
