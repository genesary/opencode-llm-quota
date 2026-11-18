/**
 * Body of `GET /v1/quota`, the rate-limit service's `POST /quota` snapshot.
 * Parsed as untrusted input: a missing or mistyped field
 * drops that limit, so a server change can hide a limit but never break OpenCode.
 */

export interface QuotaWindow {
  /** `fixed`, `anchored`, `token_bucket`, `concurrency` or `unit`. */
  type: string;
  /** For `unit` windows: `SECOND`, `MINUTE`, `HOUR`, `DAY`… */
  unit?: string;
  duration_s?: number;
  burst?: number;
  lease_s?: number;
  retry_after_s?: number;
}

export interface QuotaLimit {
  name: string;
  window: QuotaWindow | undefined;
  unlimited: boolean;
  limit: number | undefined;
  used: number | undefined;
  remaining: number | undefined;
  used_pct: number | undefined;
  resets_at: string | null | undefined;
  resets_in_s: number | null | undefined;
  /** Token buckets only: whole tokens in the bucket, negative in debt. */
  level: number | undefined;
  /** Concurrency windows only: slots held. */
  in_flight: number | undefined;
  /** Soft limits only. */
  soft: boolean;
  over: boolean | undefined;
}

export interface QuotaResponse {
  now: Date | undefined;
  /** One entry per descriptor in request order, limits in configuration order. */
  descriptors: QuotaLimit[][];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const nullableNum = (v: unknown): number | null | undefined => (v === null ? null : num(v));
const nullableStr = (v: unknown): string | null | undefined => (v === null ? null : str(v));

function parseWindow(raw: unknown): QuotaWindow | undefined {
  if (!isObject(raw)) return undefined;
  const type = str(raw["type"]);
  if (!type) return undefined;
  const window: QuotaWindow = { type };
  const unit = str(raw["unit"]);
  if (unit !== undefined) window.unit = unit;
  for (const key of ["duration_s", "burst", "lease_s", "retry_after_s"] as const) {
    const value = num(raw[key]);
    if (value !== undefined) window[key] = value;
  }
  return window;
}

function parseLimit(raw: unknown): QuotaLimit | undefined {
  if (!isObject(raw)) return undefined;
  return {
    name: str(raw["name"]) ?? "",
    window: parseWindow(raw["window"]),
    unlimited: raw["unlimited"] === true,
    limit: num(raw["limit"]),
    used: num(raw["used"]),
    remaining: num(raw["remaining"]),
    used_pct: num(raw["used_pct"]),
    resets_at: nullableStr(raw["resets_at"]),
    resets_in_s: nullableNum(raw["resets_in_s"]),
    level: num(raw["level"]),
    in_flight: num(raw["in_flight"]),
    soft: raw["soft"] === true,
    over: typeof raw["over"] === "boolean" ? raw["over"] : undefined,
  };
}

/** `undefined` when the body is not a quota snapshot. */
export function parseQuotaResponse(body: unknown): QuotaResponse | undefined {
  if (!isObject(body) || !Array.isArray(body["descriptors"])) return undefined;
  const nowRaw = str(body["now"]);
  const now = nowRaw ? new Date(nowRaw) : undefined;
  const descriptors = body["descriptors"].map((descriptor) => {
    if (!isObject(descriptor) || !Array.isArray(descriptor["limits"])) return [];
    return descriptor["limits"].map(parseLimit).filter((l): l is QuotaLimit => l !== undefined);
  });
  return { now: now && !Number.isNaN(now.getTime()) ? now : undefined, descriptors };
}
