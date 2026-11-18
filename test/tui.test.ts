import { describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../src/service.js";
import { currentLine, renderDetail } from "../src/view.js";

// @opentui/solid only exists inside the OpenCode host: a minimal stand-in that
// evaluates the inserted accessor, enough to check what the status line shows.
vi.mock("@opentui/solid", () => ({
  createElement: (tag: string) => ({ tag, text: () => "" }),
  setProp: (node: Record<string, unknown>, name: string, value: unknown) => (node[name] = value),
  insert: (node: { text: () => unknown }, accessor: () => unknown) => {
    node.text = accessor;
    return node;
  },
}));

const SNAPSHOT: Snapshot = {
  gateway: "https://gw.example",
  models: [
    {
      id: "model-a",
      apiName: "model-a",
      label: "Model A",
      status: "ok",
      line: "Model A · normal priority · budget 62% left",
      detail: ["normal priority · budget 62% left", "week 34% · resets Sat 18:00", "in flight 0/16"],
      updatedAt: 1_000,
    },
    {
      id: "jina",
      apiName: "jina-embeddings-v5",
      label: "jina",
      status: "no-quota",
      line: undefined,
      detail: [],
      updatedAt: undefined,
    },
  ],
};

function fakeTui(current: { providerID: string; modelID: string } | undefined) {
  let store: { snapshot: Snapshot } = { snapshot: { gateway: undefined, models: [] } };
  const handlers = new Map<string, (event: { data: unknown }) => void>();
  const slots: Array<{ after?: string; append?: string; render: () => { text: () => unknown } }> = [];
  const commands: Array<{ slash?: { name: string }; run: () => void }> = [];
  const toast = vi.fn();
  const alert = vi.fn(async () => {});
  const ctx = {
    options: {},
    storage: {
      memory: (_key: string, { initial }: { initial: { snapshot: Snapshot } }) => {
        store = initial;
        return [
          new Proxy({}, { get: (_t, k) => store[k as "snapshot"] }),
          (mutate: (draft: typeof store) => void) => mutate(store),
        ];
      },
    },
    client: {
      rpc: () => ({
        snapshot: async () => SNAPSHOT,
        events: {
          on: (name: string, h: (event: { data: unknown }) => void) => (handlers.set(name, h), () => {}),
        },
      }),
    },
    ui: {
      toast: { show: toast },
      dialog: { alert },
      model: { current: () => current },
      slot: (claim: (typeof slots)[number]) => (slots.push(claim), () => {}),
    },
    keymap: {
      layer: (factory: () => { mode?: string; commands: typeof commands }) => {
        const layer = factory();
        if (layer.mode === "global") commands.push(...layer.commands);
      },
    },
  };
  return { ctx, handlers, slots, commands, toast, alert };
}

describe("TUI part (v2)", () => {
  it("puts the selected model's line after prompt.footer.status", async () => {
    const { setupTui } = await import("../src/tui.js");
    const t = fakeTui({ providerID: "keycloak", modelID: "model-a" });
    await setupTui(t.ctx as never);
    await Promise.resolve();
    const status = t.slots.find((s) => s.after === "prompt.footer.status");
    const node = status?.render() as unknown as { text: () => unknown; wrapMode: string; truncate: boolean };
    expect(node.text()).toBe("Model A · normal priority · budget 62% left");
    expect([node.wrapMode, node.truncate]).toEqual(["none", true]);
  });

  it("shows nothing for a model of another provider", async () => {
    const { setupTui } = await import("../src/tui.js");
    const t = fakeTui({ providerID: "openai", modelID: "gpt" });
    await setupTui(t.ctx as never);
    await Promise.resolve();
    expect(
      t.slots
        .find((s) => s.after === "prompt.footer.status")
        ?.render()
        .text(),
    ).toBe("");
  });

  it("relays server toasts and opens the detail with /quota", async () => {
    const { setupTui } = await import("../src/tui.js");
    const t = fakeTui(undefined);
    await setupTui(t.ctx as never);
    t.handlers.get("toast")?.({ data: { variant: "warning", message: "Model A · low priority" } });
    expect(t.toast).toHaveBeenCalledWith({
      title: "Quota",
      message: "Model A · low priority",
      variant: "warning",
    });

    // The layer is created inside the "app" slot render, like the built-in plugins.
    t.slots.find((s) => s.append === "app")?.render();
    const quota = t.commands.find((c) => c.slash?.name === "quota");
    quota?.run();
    expect(t.alert).toHaveBeenCalledWith({ title: "Quota", message: expect.stringContaining("Model A") });
  });
});

describe("views", () => {
  it("renderDetail lists every model", () => {
    expect(renderDetail(SNAPSHOT, 21_000)).toBe(
      [
        "Quotas · https://gw.example",
        "Model A (model-a)",
        "  normal priority · budget 62% left",
        "  week 34% · resets Sat 18:00",
        "  in flight 0/16",
        "  read 20s ago",
        "jina (jina-embeddings-v5): no quota on this model",
      ].join("\n"),
    );
  });

  it("renderDetail without a gateway", () => {
    expect(renderDetail({ gateway: undefined, models: [] })).toMatch(/^Quota unavailable/);
  });

  it("currentLine matches by id or API name, only for the provider", () => {
    expect(currentLine(SNAPSHOT, { providerID: "keycloak", modelID: "model-a" }, "keycloak")).toBe(
      "Model A · normal priority · budget 62% left",
    );
    expect(currentLine(SNAPSHOT, { providerID: "x", modelID: "model-a" }, "keycloak")).toBeUndefined();
    expect(currentLine(SNAPSHOT, undefined, "keycloak")).toBeUndefined();
  });
});
