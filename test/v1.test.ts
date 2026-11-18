import { afterEach, describe, expect, it, vi } from "vitest";
import { TOKEN_SOURCE_KEY } from "../src/token-source.js";
import { QuotaPluginV1, v1Target } from "../src/v1/index.js";
import { budget, softBudgetModel } from "./fixtures.js";
import { quotaFetch, settle } from "./helpers.js";

const CONFIG = {
  provider: {
    keycloak: {
      options: { baseURL: "https://gateway.example.com/v1" },
      models: {
        "model-a": { name: "Model A" },
        hardCapsModel: { id: "model-b" },
      },
    },
    other: { options: { baseURL: "https://elsewhere.example/v1" } },
  },
};

function client(config: unknown = CONFIG) {
  return {
    config: { get: vi.fn(async () => ({ data: config })) },
    tui: { showToast: vi.fn(async () => ({ data: true })) },
  };
}

afterEach(() => {
  delete (globalThis as Record<PropertyKey, unknown>)[TOKEN_SOURCE_KEY];
});

describe("v1Target", () => {
  it("reads baseURL and models of the provider from the live config", async () => {
    const target = await v1Target(client() as never, "keycloak", {});
    expect(target).toEqual({
      baseURL: "https://gateway.example.com/v1",
      models: [
        { id: "model-a", apiName: "model-a", label: "Model A" },
        { id: "hardCapsModel", apiName: "model-b", label: "hardCapsModel" },
      ],
    });
  });

  it("no provider or no baseURL → undefined", async () => {
    expect(await v1Target(client() as never, "missing", {})).toBeUndefined();
    expect(await v1Target(client({ provider: { keycloak: {} } }) as never, "keycloak", {})).toBeUndefined();
  });
});

describe("QuotaPluginV1", () => {
  it("registers an event hook, a quota tool and dispose; never chat.* request hooks", async () => {
    const hooks = await QuotaPluginV1({ client: client() } as never, {});
    expect(Object.keys(hooks).sort()).toEqual(["dispose", "event", "tool"]);
    expect(hooks.tool?.["quota"]?.args).toEqual({});
    await hooks.dispose?.();
  });

  it("reads with the keycloak token, shows toasts via client.tui.showToast, and the tool shows the detail", async () => {
    const fetchImpl = quotaFetch(() => ({ body: softBudgetModel(budget(-45, { resetsInS: 30100 })) }));
    vi.stubGlobal("fetch", fetchImpl);
    (globalThis as Record<PropertyKey, unknown>)[TOKEN_SOURCE_KEY] = { version: 1, token: async () => "jwt" };
    const c = client({
      provider: {
        keycloak: {
          options: { baseURL: "https://gw.example/v1" },
          models: { softBudgetModel: { name: "Model A" } },
        },
      },
    });

    const hooks = await QuotaPluginV1({ client: c } as never, {});
    await vi.waitFor(() => expect(fetchImpl.calls).toHaveLength(1));
    await settle();

    expect(new Headers(fetchImpl.calls[0]?.init?.headers).get("authorization")).toBe("Bearer jwt");
    expect(c.tui.showToast).toHaveBeenCalledWith({
      body: { title: "Quota", message: "Model A · low priority · normal in ~35 min", variant: "warning" },
    });
    const output = await hooks.tool!["quota"]!.execute({}, {} as never);
    expect(output).toContain("Quotas · https://gw.example");
    expect(output).toContain("low priority · normal in ~35 min");
    await hooks.dispose?.();
    vi.unstubAllGlobals();
  });

  it("without opencode-keycloak-auth's token source: no request, quota unavailable", async () => {
    const fetchImpl = quotaFetch(() => ({ body: {} }));
    vi.stubGlobal("fetch", fetchImpl);
    const hooks = await QuotaPluginV1({ client: client() } as never, {});
    await settle();
    await settle();
    expect(fetchImpl.calls).toHaveLength(0);
    expect(await hooks.tool!["quota"]!.execute({}, {} as never)).toContain("quota unavailable");
    await hooks.dispose?.();
    vi.unstubAllGlobals();
  });

  it("enabled: false → no hooks at all", async () => {
    expect(await QuotaPluginV1({ client: client() } as never, { enabled: false })).toEqual({});
  });
});
