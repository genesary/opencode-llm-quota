import { describe, expect, it, vi } from "vitest";
import { followResponses, setupV2, toJson, type SetupContext } from "../src/v2/index.js";
import { budget, softBudgetModel } from "./fixtures.js";
import { quotaFetch, settle } from "./helpers.js";

/** An async iterable fed by `push`, ended by the abort signal. */
function eventStream() {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  const push = (event: unknown) => {
    queue.push(event);
    wake?.();
  };
  const subscribe = vi.fn((options?: { signal?: AbortSignal }) => ({
    async *[Symbol.asyncIterator]() {
      while (!options?.signal?.aborted) {
        if (queue.length) yield queue.shift();
        else
          await new Promise<void>((r) => ((wake = r), options?.signal?.addEventListener("abort", () => r())));
      }
    },
  }));
  return { push, subscribe };
}

function fakeContext(overrides: { credential?: unknown; integrationID?: string } = {}) {
  const events = eventStream();
  const emitted: Array<[string, unknown]> = [];
  const tools: Array<{ name: string; execute: () => Promise<{ content: string }> }> = [];
  const resolve = vi.fn(
    async () => overrides.credential ?? { type: "oauth", access: "jwt-v2", refresh: "r", expires: 0 },
  );
  const active = vi.fn(async (id: string) =>
    id === (overrides.integrationID ?? "keycloak") ? { id: "conn" } : undefined,
  );
  const register = vi.fn(async () => ({
    events: { emit: async (name: string, data: unknown) => void emitted.push([name, data]) },
    dispose: vi.fn(async () => {}),
  }));
  const ctx = {
    options: { labels: { "model-a": "Model A" } },
    provider: {
      get: vi.fn(async () => ({
        data: {
          id: "keycloak",
          ...(overrides.integrationID ? { integrationID: overrides.integrationID } : {}),
          settings: { baseURL: "https://gateway.example.com/v1" },
        },
      })),
    },
    model: {
      list: vi.fn(async () => ({
        data: [
          {
            id: "model-a",
            modelID: "model-a",
            providerID: "keycloak",
            name: "SI",
          },
          { id: "gpt-x", modelID: "gpt-x", providerID: "openai", name: "GPT" },
        ],
      })),
    },
    integration: { connection: { active, resolve } },
    event: { subscribe: events.subscribe },
    rpc: { register },
    tool: {
      transform: vi.fn(async (fn: (editor: { add: (tool: never) => void }) => void) => {
        fn({ add: (tool) => void tools.push(tool) });
        return { dispose: vi.fn(async () => {}) };
      }),
    },
  };
  return { ctx: ctx as unknown as SetupContext, raw: ctx, events, emitted, tools, active, resolve, register };
}

describe("setupV2", () => {
  it("reads the gateway and models from the host, the token from the host connection", async () => {
    const fetchImpl = quotaFetch(() => ({ body: softBudgetModel(budget(-45, { resetsInS: 30100 })) }));
    vi.stubGlobal("fetch", fetchImpl);
    const f = fakeContext();
    const cleanup = await setupV2(f.ctx);
    await vi.waitFor(() => expect(fetchImpl.calls).toHaveLength(1));
    await settle();

    // Only the provider's own models, under their API name, to the provider's gateway.
    expect(fetchImpl.calls[0]?.url.href).toBe("https://gateway.example.com/v1/quota?model=model-a");
    expect(new Headers(fetchImpl.calls[0]?.init?.headers).get("authorization")).toBe("Bearer jwt-v2");
    expect(f.active).toHaveBeenCalledWith("keycloak");

    // Snapshot and toast published to the TUI part over RPC.
    const changed = f.emitted.find(([name]) => name === "changed")?.[1] as {
      models: Array<{ line: string }>;
    };
    expect(changed.models[0]?.line).toBe("Model A · low priority · normal in ~35 min");
    expect(f.emitted).toContainEqual([
      "toast",
      { variant: "warning", message: "Model A · low priority · normal in ~35 min" },
    ]);

    // The quota tool works without the TUI part.
    expect(f.tools.map((t) => t.name)).toEqual(["quota"]);
    expect((await f.tools[0]!.execute()).content).toContain("Model A (model-a)");

    await cleanup?.();
    vi.unstubAllGlobals();
  });

  it("uses the provider's integrationID when it differs from its id", async () => {
    vi.stubGlobal(
      "fetch",
      quotaFetch(() => ({ body: softBudgetModel(budget(100, { over: false })) })),
    );
    const f = fakeContext({ integrationID: "kc" });
    const cleanup = await setupV2(f.ctx);
    await vi.waitFor(() => expect(f.active).toHaveBeenCalledWith("kc"));
    await cleanup?.();
    vi.unstubAllGlobals();
  });

  it("a non-OAuth credential (API key) is not sent: quota unavailable", async () => {
    const fetchImpl = quotaFetch(() => ({ body: {} }));
    vi.stubGlobal("fetch", fetchImpl);
    const f = fakeContext({ credential: { type: "key", key: "sk-123" } });
    const cleanup = await setupV2(f.ctx);
    await vi.waitFor(() => expect(f.resolve).toHaveBeenCalled());
    await settle();
    expect(fetchImpl.calls).toHaveLength(0);
    await cleanup?.();
    vi.unstubAllGlobals();
  });

  it("keeps working (tool only) when RPC registration fails", async () => {
    vi.stubGlobal(
      "fetch",
      quotaFetch(() => ({ body: softBudgetModel(budget(100, { over: false })) })),
    );
    const f = fakeContext();
    f.raw.rpc.register.mockRejectedValueOnce(new Error("no rpc"));
    const cleanup = await setupV2(f.ctx);
    expect(f.tools).toHaveLength(1);
    await cleanup?.();
    vi.unstubAllGlobals();
  });
});

describe("RPC payloads", () => {
  it("contain no undefined, which the host rejects as invalid JSON", () => {
    const json = toJson({
      gateway: undefined,
      models: [
        {
          id: "a",
          apiName: "a",
          label: "a",
          status: "pending",
          line: undefined,
          detail: [],
          updatedAt: undefined,
        },
      ],
    });
    expect(json).toEqual({ models: [{ id: "a", apiName: "a", label: "a", status: "pending", detail: [] }] });
  });
});

describe("v1 host calling setup()", () => {
  it("does nothing when the context lacks the v2 API", async () => {
    vi.stubEnv("OPENCODE_QUOTA_LOG", "warn");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await setupV2({ options: {} } as never)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("followResponses", () => {
  it("reports the end of a step of the provider's models only", async () => {
    const { push, subscribe } = eventStream();
    const abort = new AbortController();
    const ended: string[] = [];
    void followResponses({ event: { subscribe } } as never, "keycloak", abort.signal, (m) => ended.push(m));

    push({
      type: "session.step.started",
      data: { assistantMessageID: "a1", model: { id: "si", providerID: "keycloak" } },
    });
    push({
      type: "session.step.started",
      data: { assistantMessageID: "a2", model: { id: "gpt", providerID: "openai" } },
    });
    push({ type: "session.text.delta", data: { assistantMessageID: "a1" } });
    push({ type: "session.step.ended", data: { assistantMessageID: "a2" } });
    push({ type: "session.step.ended", data: { assistantMessageID: "a1" } });
    push({
      type: "session.step.started",
      data: { assistantMessageID: "a3", model: { id: "si", providerID: "keycloak" } },
    });
    push({ type: "session.step.failed", data: { assistantMessageID: "a3" } });
    await settle();
    expect(ended).toEqual(["si", "si"]);
    abort.abort();
  });
});
