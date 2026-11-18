import { describe, expect, it, vi } from "vitest";
import { readQuota } from "../src/gateway.js";
import { createQuotaService, MAX_BACKOFF_MS, type ServiceDeps, type Target } from "../src/service.js";
import { budget, daily, softBudgetModel, perMinute, hardCapsModel } from "./fixtures.js";
import { fakeClock, GATEWAY, quotaFetch, TARGET, testConfig } from "./helpers.js";

const MINUTE = 60_000;

function setup(overrides: Partial<ServiceDeps> & { status?: (model: string) => number } = {}) {
  const clock = fakeClock();
  const fetchImpl = quotaFetch((url) => {
    const model = url.searchParams.get("model") ?? "";
    const status = overrides.status?.(model) ?? 200;
    if (status !== 200) return { status, body: { error: "x" } };
    return {
      body:
        model === "model-b"
          ? hardCapsModel(perMinute(1), daily(41))
          : softBudgetModel(budget(372, { over: false })),
    };
  });
  const toasts: unknown[] = [];
  const service = createQuotaService({
    config: testConfig(),
    resolveTarget: async () => TARGET,
    getToken: async () => "jwt-token",
    read: (url, token) => readQuota(url, token, { fetchImpl }),
    onToast: (t) => toasts.push(t),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    timeZone: "UTC",
    ledgerScope: {},
    ...overrides,
  });
  const reads = (model?: string) =>
    fetchImpl.calls.filter((c) => !model || c.url.searchParams.get("model") === model).length;
  return { clock, fetchImpl, service, toasts, reads };
}

describe("pace", () => {
  it("reads each model once at start, then at most once per minute", async () => {
    const { clock, service, reads } = setup();
    service.start();
    await clock.advance(0);
    expect(reads("model-a")).toBe(1);
    expect(reads("model-b")).toBe(1);

    await clock.advance(59_000);
    expect(reads()).toBe(2);
    await clock.advance(1_000);
    expect(reads()).toBe(4);
    await clock.advance(10 * MINUTE);
    expect(reads("model-a")).toBe(12);
    service.stop();
  });

  it("the interval can be raised but never set below 60 s", async () => {
    const { clock, service, reads } = setup({ config: testConfig({ intervalSeconds: 5 }) });
    service.start();
    await clock.advance(0);
    await clock.advance(30_000);
    expect(reads("model-a")).toBe(1);
    service.stop();

    const slow = setup({ config: testConfig({ intervalSeconds: 300 }) });
    slow.service.start();
    await slow.clock.advance(0);
    await slow.clock.advance(4 * MINUTE);
    expect(slow.reads("model-a")).toBe(1);
    await slow.clock.advance(MINUTE);
    expect(slow.reads("model-a")).toBe(2);
    slow.service.stop();
  });

  it("end of a response: one extra read, but not before a minute after the last one", async () => {
    const { clock, service, reads } = setup();
    service.start();
    await clock.advance(0);
    await clock.advance(20_000);

    service.requestRefresh("model-a");
    service.requestRefresh("model-a");
    await clock.advance(30_000); // t = 50 s: still under the floor
    expect(reads("model-a")).toBe(1);
    await clock.advance(10_000); // t = 60 s
    expect(reads("model-a")).toBe(2);
    service.stop();
  });

  it("end of a response long after the last read: read ~2 s later (settle delay)", async () => {
    const { clock, service, reads } = setup({ config: testConfig({ intervalSeconds: 600 }) });
    service.start();
    await clock.advance(0);
    await clock.advance(5 * MINUTE);
    service.requestRefresh("model-b");
    await clock.advance(1_000);
    expect(reads("model-b")).toBe(1);
    await clock.advance(1_000);
    expect(reads("model-b")).toBe(2);
    expect(reads("model-a")).toBe(1);
    service.stop();
  });

  it("never reads on anything but the timer and response ends (no keystroke path)", async () => {
    const { clock, service, reads } = setup();
    service.start();
    await clock.advance(0);
    for (let i = 0; i < 100; i++) service.snapshot();
    expect(reads()).toBe(2);
    service.stop();
  });
});

describe("errors and backoff", () => {
  it("backs off exponentially on errors, without a warning per failure", async () => {
    vi.stubEnv("OPENCODE_QUOTA_LOG", "warn");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let failing = true;
    const { clock, service, reads } = setup({
      status: (model) => (model === "model-b" ? 200 : failing ? 503 : 200),
    });
    service.start();
    await clock.advance(0); // fail #1 → +60 s
    await clock.advance(MINUTE); // fail #2 → +120 s
    await clock.advance(2 * MINUTE); // fail #3 → +240 s
    expect(reads("model-a")).toBe(3);
    await clock.advance(3 * MINUTE);
    expect(reads("model-a")).toBe(3);
    await clock.advance(MINUTE);
    expect(reads("model-a")).toBe(4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(service.snapshot().models[0]?.line).toBe("Model A · quota unavailable");

    failing = false;
    await clock.advance(8 * MINUTE);
    expect(service.snapshot().models[0]?.line).toBe("Model A · normal priority · budget 62% left");
    service.stop();
  });

  it("caps the backoff at 15 min", async () => {
    const { clock, service, reads } = setup({ status: () => 500 });
    service.start();
    await clock.advance(0);
    await clock.advance(2 * 60 * MINUTE);
    const before = reads("model-a");
    await clock.advance(MAX_BACKOFF_MS);
    expect(reads("model-a")).toBe(before + 1);
    service.stop();
  });

  it("a response end does not shortcut the backoff", async () => {
    const { clock, service, reads } = setup({ status: (m) => (m === "model-b" ? 200 : 500) });
    service.start();
    await clock.advance(0);
    await clock.advance(MINUTE); // fail #2 → next in 120 s
    service.requestRefresh("model-a");
    await clock.advance(90_000);
    expect(reads("model-a")).toBe(2);
    service.stop();
  });

  it("keeps the last good state when the gateway starts failing", async () => {
    let status = 200;
    const { clock, service } = setup({ status: () => status });
    service.start();
    await clock.advance(0);
    status = 502;
    await clock.advance(MINUTE);
    expect(service.snapshot().models[0]?.line).toBe("Model A · normal priority · budget 62% left");
    await clock.advance(10 * MINUTE);
    expect(service.snapshot().models[0]?.line).toMatch(
      /^Model A · normal priority · budget 62% left \(\d+ min ago\)$/,
    );
    service.stop();
  });

  it("404 (model without quota): ignored, not shown, re-checked only after an hour", async () => {
    const { clock, service, reads } = setup({ status: (m) => (m === "model-b" ? 404 : 200) });
    service.start();
    await clock.advance(0);
    await clock.advance(30 * MINUTE);
    expect(reads("model-b")).toBe(1);
    const hardCapsView = service.snapshot().models.find((m) => m.label === "Model B");
    expect(hardCapsView?.status).toBe("no-quota");
    expect(hardCapsView?.line).toBeUndefined();
    service.requestRefresh("model-b");
    await clock.advance(MINUTE);
    expect(reads("model-b")).toBe(1);
    await clock.advance(30 * MINUTE);
    expect(reads("model-b")).toBe(2);
    service.stop();
  });

  it("no token: nothing is sent, the model shows quota unavailable, no login is attempted", async () => {
    const getToken = vi.fn(async () => undefined);
    const { clock, service, reads } = setup({ getToken });
    service.start();
    await clock.advance(0);
    await clock.advance(3 * MINUTE);
    expect(reads()).toBe(0);
    expect(getToken).toHaveBeenCalled();
    expect(service.snapshot().models.map((m) => m.line)).toEqual([
      "Model A · quota unavailable",
      "Model B · quota unavailable",
    ]);
    service.stop();
  });

  it("reads as soon as a token appears, without waiting a full interval", async () => {
    let token: string | undefined;
    const { clock, service, reads } = setup({ getToken: async () => token });
    service.start();
    await clock.advance(0);
    expect(reads()).toBe(0);
    token = "jwt-token";
    await clock.advance(10_000);
    expect(reads()).toBe(2);
    service.stop();
  });

  it("a throwing token source counts as no token", async () => {
    const { clock, service, reads } = setup({
      getToken: async () => {
        throw new Error("refresh failed");
      },
    });
    service.start();
    await clock.advance(0);
    expect(reads()).toBe(0);
    expect(service.snapshot().models[0]?.status).toBe("unavailable");
    service.stop();
  });

  it("401 (token refused): quota unavailable and backoff", async () => {
    const { clock, service, reads } = setup({ status: () => 401 });
    service.start();
    await clock.advance(0);
    await clock.advance(MINUTE);
    await clock.advance(MINUTE);
    expect(reads("model-a")).toBe(2);
    expect(service.snapshot().models[0]?.line).toBe("Model A · quota unavailable");
    service.stop();
  });
});

describe("several plugin instances in one process (OpenCode v2 locations)", () => {
  it("share one gateway read per model and minute", async () => {
    const clock = fakeClock();
    const fetchImpl = quotaFetch(() => ({ body: softBudgetModel(budget(372, { over: false })) }));
    const ledgerScope = {};
    const make = () =>
      createQuotaService({
        config: testConfig(),
        resolveTarget: async () => ({ ...TARGET, models: [TARGET.models[0]!] }),
        getToken: async () => "jwt-token",
        read: (url, token) => readQuota(url, token, { fetchImpl }),
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        ledgerScope,
      });
    const a = make();
    const b = make();
    a.start();
    b.start();
    await clock.advance(0);
    await clock.advance(5 * MINUTE);
    expect(fetchImpl.calls).toHaveLength(6);
    expect(b.snapshot().models[0]?.line).toBe("Model A · normal priority · budget 62% left");
    a.stop();
    b.stop();
  });
});

describe("current() for the quota tool", () => {
  it("reads once before answering when the provider was not there at start", async () => {
    let target: Target | undefined;
    const { clock, service, reads } = setup({ resolveTarget: async () => target });
    service.start();
    await clock.advance(0);
    expect(service.snapshot().gateway).toBeUndefined();

    target = TARGET;
    const snapshot = await service.current();
    expect(snapshot.gateway).toBe(GATEWAY);
    expect(snapshot.models[0]?.line).toBe("Model A · normal priority · budget 62% left");
    expect(reads()).toBe(2);
    service.stop();
  });

  it("two tool calls a few seconds apart give one gateway read per model", async () => {
    let target: Target | undefined;
    const { clock, service, reads } = setup({ resolveTarget: async () => target });
    service.start();
    await clock.advance(0);
    target = TARGET;
    await service.current();
    await clock.advance(3_000);
    await service.current();
    expect(reads("model-a")).toBe(1);
    expect(reads("model-b")).toBe(1);
    service.stop();
  });

  it("answers with what is known when the gateway stalls", async () => {
    let target: Target | undefined;
    const { clock, service } = setup({
      resolveTarget: async () => target,
      read: () => new Promise(() => {}),
    });
    service.start();
    await clock.advance(0);
    target = TARGET;
    const answer = service.current();
    await clock.advance(12_000);
    const snapshot = await answer;
    expect(snapshot.gateway).toBe(GATEWAY);
    expect(snapshot.models.every((m) => m.status === "pending")).toBe(true);
    service.stop();
  });

  it("does not read again when the state is already known", async () => {
    const { clock, service, reads } = setup();
    service.start();
    await clock.advance(0);
    await service.current();
    expect(reads()).toBe(2);
    service.stop();
  });
});

describe("gateway and models from the live config", () => {
  it("follows a workspace switch (new baseURL) without restart, and resets the state", async () => {
    let target: Target = TARGET;
    const { clock, service, fetchImpl } = setup({ resolveTarget: async () => target });
    service.start();
    await clock.advance(0);
    expect(fetchImpl.calls[0]?.url.origin).toBe(GATEWAY);

    target = { ...TARGET, baseURL: "https://other-gateway.example.com/v1" };
    await clock.advance(MINUTE);
    expect(service.snapshot().gateway).toBe("https://other-gateway.example.com");
    expect(fetchImpl.calls.at(-1)?.url.origin).toBe("https://other-gateway.example.com");
    service.stop();
  });

  it("no provider or no baseURL: nothing is read, the state is empty", async () => {
    const { clock, service, reads } = setup({ resolveTarget: async () => undefined });
    service.start();
    await clock.advance(0);
    await clock.advance(5 * MINUTE);
    expect(reads()).toBe(0);
    expect(service.snapshot()).toEqual({ gateway: undefined, models: [] });
    service.stop();
  });

  it("sends the token only to the gateway origin of the provider's baseURL", async () => {
    const { clock, service, fetchImpl } = setup();
    service.start();
    await clock.advance(0);
    for (const call of fetchImpl.calls) {
      expect(call.url.origin).toBe(GATEWAY);
      expect(call.url.pathname).toBe("/v1/quota");
      expect(new Headers(call.init?.headers).get("authorization")).toBe("Bearer jwt-token");
      expect(call.init?.redirect).toBe("error");
    }
    service.stop();
  });

  it("queries each model under its configured name", async () => {
    const { clock, service, fetchImpl } = setup({
      resolveTarget: async () => ({
        baseURL: `${GATEWAY}/v1`,
        models: [{ id: "si", apiName: "si-alias", label: "Model A" }],
      }),
    });
    service.start();
    await clock.advance(0);
    expect(fetchImpl.calls.map((c) => c.url.searchParams.get("model"))).toEqual(["si-alias"]);
    service.stop();
  });
});

describe("toasts", () => {
  it("one toast per state change, none per reading", async () => {
    let level = 372;
    const clock = fakeClock();
    const fetchImpl = quotaFetch(() => ({
      body: softBudgetModel(budget(level, { over: level <= 0, resetsInS: 30100 })),
    }));
    const toasts: Array<{ message: string }> = [];
    const service = createQuotaService({
      config: testConfig(),
      resolveTarget: async () => ({ ...TARGET, models: [TARGET.models[0]!] }),
      getToken: async () => "t",
      read: (url, token) => readQuota(url, token, { fetchImpl }),
      onToast: (t) => toasts.push(t),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    service.start();
    await clock.advance(0);
    await clock.advance(5 * MINUTE);
    expect(toasts).toEqual([]);
    level = -45;
    await clock.advance(MINUTE);
    await clock.advance(5 * MINUTE);
    expect(toasts.map((t) => t.message)).toEqual(["Model A · low priority · normal in ~35 min"]);
    level = 20;
    await clock.advance(MINUTE);
    expect(toasts.map((t) => t.message).at(-1)).toBe("Model A · back to normal priority");
    expect(toasts).toHaveLength(2);
    service.stop();
  });

  it("toasts: false disables them", async () => {
    const { clock, service, toasts } = setup({
      config: testConfig({ toasts: false }),
      status: () => 200,
    });
    service.start();
    await clock.advance(0);
    expect(toasts).toEqual([]);
    service.stop();
  });

  it("enabled: false never starts", async () => {
    const { clock, service, reads } = setup({ config: testConfig({ enabled: false }) });
    service.start();
    await clock.advance(10 * MINUTE);
    expect(reads()).toBe(0);
  });
});
