/**
 * One read of `GET <gateway>/v1/quota?model=<name>`. Redirects are refused so a
 * 30x cannot carry the `Authorization` header to another host.
 */
import { classify, type ModelQuota } from "./quota/classify.js";
import { parseQuotaResponse } from "./quota/response.js";

export type ReadOutcome =
  | { kind: "ok"; quota: ModelQuota }
  /** 404: no quota on this model, or an unknown name. */
  | { kind: "no-quota" }
  | { kind: "no-token" }
  /** 401/403: an expired token or an API key. */
  | { kind: "unauthorized"; status: number }
  | { kind: "error"; reason: string };

export const READ_TIMEOUT_MS = 10_000;

/** The quota route on the origin of `baseURL`; `undefined` unless `baseURL` is absolute http(s). */
export function quotaUrl(baseURL: string, path: string, model: string): URL | undefined {
  let base: URL;
  try {
    base = new URL(baseURL);
  } catch {
    return undefined;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return undefined;
  const url = new URL(path, base.origin);
  // A path such as "//other-host/x" would resolve to another host and take the token with it.
  if (url.origin !== base.origin) return undefined;
  url.searchParams.set("model", model);
  return url;
}

export async function readQuota(
  url: URL,
  token: string,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ReadOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(deps.timeoutMs ?? READ_TIMEOUT_MS),
    });
  } catch (cause) {
    const name = cause instanceof Error ? cause.name : "";
    return { kind: "error", reason: name === "TimeoutError" ? "timeout" : "network error" };
  }

  if (response.status === 404) return discard(response, { kind: "no-quota" });
  if (response.status === 401 || response.status === 403) {
    return discard(response, { kind: "unauthorized", status: response.status });
  }
  if (!response.ok) return discard(response, { kind: "error", reason: `HTTP ${response.status}` });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "error", reason: "invalid JSON" };
  }
  const parsed = parseQuotaResponse(body);
  if (!parsed) return { kind: "error", reason: "not a quota snapshot" };
  return { kind: "ok", quota: classify(parsed) };
}

/** Frees the connection without reading the body. */
async function discard<T>(response: Response, outcome: T): Promise<T> {
  await response.body?.cancel().catch(() => {});
  return outcome;
}
