import { vi } from "vitest";
import { resolveConfig, type QuotaConfig, type QuotaPluginOptions } from "../src/config.js";
import type { ServiceDeps, Target } from "../src/service.js";

export function testConfig(options: QuotaPluginOptions = {}): QuotaConfig {
  return resolveConfig({ labels: { "model-a": "Model A", "model-b": "Model B" }, ...options }, {});
}

export const GATEWAY = "https://gateway.example.com";

export const TARGET: Target = {
  baseURL: `${GATEWAY}/v1`,
  models: [
    { id: "model-a", apiName: "model-a", label: "Model A" },
    { id: "model-b", apiName: "model-b", label: "Model B" },
  ],
};

/** A manual clock with timers: `advance(ms)` runs what falls due, in order. */
export function fakeClock(start = Date.parse("2026-11-18T13:33:53Z")) {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id: unknown) => void timers.delete(id as number),
    pending: () => timers.size,
    /** Move time forward, firing due timers (and letting their async work settle). */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** A `/v1/quota` fetch mock: `responder(url)` returns `{ status, body }`; every call is recorded. */
export function quotaFetch(responder: (url: URL) => { status?: number; body?: unknown }) {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const { status = 200, body } = responder(url);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return Object.assign(fn as unknown as typeof fetch, { calls });
}

export type Deps = Partial<ServiceDeps>;
