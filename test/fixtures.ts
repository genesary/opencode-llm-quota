/**
 * `/v1/quota` bodies in the rate-limit service's format, in the gateway's descriptor
 * order. `SOFT_BUDGET_REAL` and `HARD_CAPS_REAL` are copied verbatim from the quota route
 * report (kind cluster, reduced limits).
 */

export const SOFT_BUDGET_REAL = {
  descriptors: [
    {
      limits: [
        {
          level: -45,
          limit: 600,
          name: "budget",
          over: true,
          quota_mode: false,
          remaining: 0,
          resets_at: "2026-11-18T14:12:33Z",
          resets_in_s: 2320,
          shadow_mode: false,
          soft: true,
          used: 645,
          used_pct: 107.5,
          window: { burst: 600, duration_s: 3600, type: "token_bucket" },
        },
      ],
    },
    {
      limits: [
        {
          limit: 2000,
          name: "runaway",
          quota_mode: false,
          remaining: 1320,
          resets_at: "2026-11-21T18:00:00Z",
          resets_in_s: 275167,
          shadow_mode: false,
          used: 680,
          used_pct: 34.0,
          window: { duration_s: 604800, type: "fixed" },
        },
      ],
    },
    {
      limits: [
        {
          in_flight: 0,
          limit: 16,
          name: "inflight",
          quota_mode: false,
          remaining: 16,
          resets_at: null,
          resets_in_s: null,
          shadow_mode: false,
          used: 0,
          used_pct: 0.0,
          window: { lease_s: 600, retry_after_s: 2, type: "concurrency" },
        },
      ],
    },
  ],
  now: "2026-11-18T13:33:53Z",
};

export const HARD_CAPS_REAL = {
  descriptors: [
    {
      limits: [
        {
          limit: 60,
          name: "requests_minute",
          quota_mode: false,
          remaining: 59,
          resets_at: "2026-11-18T13:34:00Z",
          resets_in_s: 7,
          shadow_mode: false,
          used: 1,
          used_pct: 1.7,
          window: { type: "unit", unit: "MINUTE" },
        },
      ],
    },
    {
      limits: [
        {
          limit: 1000,
          name: "weighted_tokens_day",
          quota_mode: false,
          remaining: 320,
          resets_at: "2026-11-19T00:00:00Z",
          resets_in_s: 37567,
          shadow_mode: false,
          used: 680,
          used_pct: 68.0,
          window: { type: "unit", unit: "DAY" },
        },
      ],
    },
  ],
  now: "2026-11-18T13:33:53Z",
};

type Limit = Record<string, unknown>;

const flags = { quota_mode: false, shadow_mode: false };

/** The soft budget (token bucket, 1 h, burst `limit`). `used` = limit − level. */
export function budget(
  level: number,
  opts: { limit?: number; over?: boolean; resetsInS?: number } = {},
): Limit {
  const limit = opts.limit ?? 600;
  const used = limit - level;
  return {
    ...flags,
    name: "budget",
    soft: true,
    over: opts.over ?? level <= 0,
    level,
    limit,
    used,
    remaining: Math.max(0, level),
    used_pct: Math.round((used / limit) * 1000) / 10,
    resets_at: "2026-11-18T14:00:00Z",
    resets_in_s: opts.resetsInS ?? 1200,
    window: { type: "token_bucket", duration_s: 3600, burst: limit },
  };
}

/** A hard weekly cap (`runaway`, fixed 7 days). */
export function weekly(usedPct: number, resetsAt = "2026-11-23T10:00:00Z"): Limit {
  const limit = 2000;
  const used = (usedPct / 100) * limit;
  return {
    ...flags,
    name: "runaway",
    limit,
    used,
    remaining: Math.max(0, limit - used),
    used_pct: usedPct,
    resets_at: resetsAt,
    resets_in_s: 400000,
    window: { type: "fixed", duration_s: 604800 },
  };
}

/** A concurrency window (`inflight`, 16 slots). */
export function inflight(inFlight: number, limit = 16): Limit {
  return {
    ...flags,
    name: "inflight",
    in_flight: inFlight,
    limit,
    used: inFlight,
    remaining: limit - inFlight,
    used_pct: Math.round((inFlight / limit) * 1000) / 10,
    resets_at: null,
    resets_in_s: null,
    window: { type: "concurrency", lease_s: 600, retry_after_s: 2 },
  };
}

/** A per-minute request cap. */
export function perMinute(used: number, limit = 60): Limit {
  return {
    ...flags,
    name: "requests_minute",
    limit,
    used,
    remaining: Math.max(0, limit - used),
    used_pct: Math.round((used / limit) * 1000) / 10,
    resets_at: "2026-11-18T13:34:00Z",
    resets_in_s: 7,
    window: { type: "unit", unit: "MINUTE" },
  };
}

/** A daily weighted-token cap. */
export function daily(usedPct: number, resetsInS = 21600): Limit {
  const limit = 1000;
  const used = (usedPct / 100) * limit;
  return {
    ...flags,
    name: "weighted_tokens_day",
    limit,
    used,
    remaining: Math.max(0, limit - used),
    used_pct: usedPct,
    resets_at: "2026-11-19T00:00:00Z",
    resets_in_s: resetsInS,
    window: { type: "unit", unit: "DAY" },
  };
}

/** A `/v1/quota` body with one limit per descriptor, in the given order. */
export function body(...limits: unknown[]): unknown {
  return { now: "2026-11-18T13:33:53Z", descriptors: limits.map((l) => ({ limits: [l] })) };
}

export function softBudgetModel(
  budgetLimit: Limit,
  weeklyLimit = weekly(34),
  inflightLimit = inflight(0),
): unknown {
  return body(budgetLimit, weeklyLimit, inflightLimit);
}

export function hardCapsModel(minuteLimit = perMinute(1), dailyLimit = daily(41)): unknown {
  return body(minuteLimit, dailyLimit);
}
