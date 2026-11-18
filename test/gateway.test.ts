import { describe, expect, it, vi } from "vitest";
import { quotaUrl, readQuota } from "../src/gateway.js";
import { SOFT_BUDGET_REAL } from "./fixtures.js";
import { quotaFetch } from "./helpers.js";

describe("quotaUrl", () => {
  it("is /v1/quota on the origin of the provider's baseURL, whatever its path", () => {
    expect(quotaUrl("https://gateway.example.com/v1", "/v1/quota", "model-a")?.href).toBe(
      "https://gateway.example.com/v1/quota?model=model-a",
    );
    expect(quotaUrl("https://gw.example/some/prefix/", "/v1/quota", "a b")?.href).toBe(
      "https://gw.example/v1/quota?model=a+b",
    );
  });

  it("never resolves to another host than the gateway's", () => {
    expect(quotaUrl("https://gw.example/v1", "//evil.example/x", "m")).toBeUndefined();
    expect(quotaUrl("https://gw.example/v1", "https://evil.example/x", "m")).toBeUndefined();
    expect(quotaUrl("https://gw.example/v1", "/\\evil.example/x", "m")).toBeUndefined();
  });

  it("rejects anything but an absolute http(s) URL", () => {
    expect(quotaUrl("not a url", "/v1/quota", "m")).toBeUndefined();
    expect(quotaUrl("file:///etc/passwd", "/v1/quota", "m")).toBeUndefined();
  });
});

describe("readQuota", () => {
  const url = new URL("https://gw.example/v1/quota?model=m");

  it("200 → classified quota", async () => {
    const outcome = await readQuota(url, "tok", {
      fetchImpl: quotaFetch(() => ({ body: SOFT_BUDGET_REAL })),
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") expect(outcome.quota.budget?.over).toBe(true);
  });

  it("sends the bearer token, refuses redirects, and sets a timeout", async () => {
    const fetchImpl = quotaFetch(() => ({ body: SOFT_BUDGET_REAL }));
    await readQuota(url, "tok", { fetchImpl });
    const init = fetchImpl.calls[0]?.init;
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [404, { kind: "no-quota" }],
    [401, { kind: "unauthorized", status: 401 }],
    [403, { kind: "unauthorized", status: 403 }],
    [500, { kind: "error", reason: "HTTP 500" }],
    [429, { kind: "error", reason: "HTTP 429" }],
  ])("HTTP %i", async (status, expected) => {
    const outcome = await readQuota(url, "tok", {
      fetchImpl: quotaFetch(() => ({ status, body: { error: "x" } })),
    });
    expect(outcome).toEqual(expected);
  });

  it("a network error, a timeout or a bad body is an error, never a throw", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await readQuota(url, "tok", { fetchImpl: down })).toEqual({
      kind: "error",
      reason: "network error",
    });

    const slow = vi.fn(async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    expect(await readQuota(url, "tok", { fetchImpl: slow })).toEqual({ kind: "error", reason: "timeout" });

    const text = vi.fn(
      async () => new Response("authentication failure", { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await readQuota(url, "tok", { fetchImpl: text })).toEqual({
      kind: "error",
      reason: "invalid JSON",
    });

    const other = quotaFetch(() => ({ body: { hello: "world" } }));
    expect(await readQuota(url, "tok", { fetchImpl: other })).toEqual({
      kind: "error",
      reason: "not a quota snapshot",
    });
  });
});
