/**
 * Limits are recognised by window type and fields, never by guessing from numbers:
 * a soft budget is `soft: true` on a `token_bucket`, in-flight requests are a
 * `concurrency` window, a hard cap is a non-soft `fixed`/`anchored`/`unit` window
 * of a known period. Anything else is ignored without error.
 *
 * The gateway sends descriptors in a documented order (quota route report, section 3);
 * `caps` keeps it, and the first budget or concurrency window wins.
 * Names matter only for the documented `<counted>_<window>` naming: a `requests`
 * prefix turns the unit label into "req", nothing else.
 */
import type { QuotaLimit, QuotaResponse } from "./response.js";

export type Period = "minute" | "hour" | "day" | "week";

export interface SoftBudget {
  /** Whole tokens in the bucket; negative in debt. */
  level: number;
  /** Bucket capacity. */
  limit: number;
  /** Whether the next decision would find the budget over (→ low priority). */
  over: boolean;
  /** Time until the bucket is full again; 0 when full; `null` if unknown. */
  resetsInS: number | null;
}

export interface HardCap {
  name: string;
  period: Period;
  counts: "requests" | "tokens";
  used: number;
  limit: number;
  /** `used / limit × 100`, not capped (it can exceed 100). */
  usedPct: number;
  resetsAt: Date | null;
  resetsInS: number | null;
}

export interface InFlight {
  inFlight: number;
  limit: number;
}

export interface ModelQuota {
  budget: SoftBudget | undefined;
  caps: HardCap[];
  inFlight: InFlight | undefined;
}

const UNIT_PERIODS: Record<string, Period> = { MINUTE: "minute", HOUR: "hour", DAY: "day", WEEK: "week" };
const DURATION_PERIODS: Record<number, Period> = { 60: "minute", 3600: "hour", 86400: "day", 604800: "week" };

function periodOf(limit: QuotaLimit): Period | undefined {
  const window = limit.window;
  if (!window) return undefined;
  if (window.type === "unit") return window.unit ? UNIT_PERIODS[window.unit.toUpperCase()] : undefined;
  if (window.type === "fixed" || window.type === "anchored") {
    return window.duration_s !== undefined ? DURATION_PERIODS[window.duration_s] : undefined;
  }
  return undefined;
}

function toBudget(limit: QuotaLimit): SoftBudget | undefined {
  if (!limit.soft || limit.window?.type !== "token_bucket") return undefined;
  if (limit.level === undefined || limit.limit === undefined || limit.limit <= 0) return undefined;
  return {
    level: limit.level,
    limit: limit.limit,
    // `over` is authoritative; without it, a bucket at or below 0 is over.
    over: limit.over ?? limit.level <= 0,
    resetsInS: limit.resets_in_s ?? null,
  };
}

function toInFlight(limit: QuotaLimit): InFlight | undefined {
  if (limit.window?.type !== "concurrency") return undefined;
  if (limit.in_flight === undefined || limit.limit === undefined || limit.limit <= 0) return undefined;
  return { inFlight: limit.in_flight, limit: limit.limit };
}

function toHardCap(limit: QuotaLimit): HardCap | undefined {
  if (limit.soft) return undefined;
  const period = periodOf(limit);
  if (!period || limit.used === undefined || limit.limit === undefined || limit.limit <= 0) return undefined;
  const resetsAt = limit.resets_at ? new Date(limit.resets_at) : null;
  return {
    name: limit.name,
    period,
    counts: limit.name.startsWith("requests") ? "requests" : "tokens",
    used: limit.used,
    limit: limit.limit,
    usedPct: limit.used_pct ?? (limit.used / limit.limit) * 100,
    resetsAt: resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt : null,
    resetsInS: limit.resets_in_s ?? null,
  };
}

export function classify(response: QuotaResponse): ModelQuota {
  const quota: ModelQuota = { budget: undefined, caps: [], inFlight: undefined };
  for (const limits of response.descriptors) {
    for (const limit of limits) {
      if (limit.unlimited) continue;
      const budget = toBudget(limit);
      if (budget) {
        quota.budget ??= budget;
        continue;
      }
      const inFlight = toInFlight(limit);
      if (inFlight) {
        quota.inFlight ??= inFlight;
        continue;
      }
      const cap = toHardCap(limit);
      if (cap) quota.caps.push(cap);
    }
  }
  return quota;
}
