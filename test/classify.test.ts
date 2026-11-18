import { describe, expect, it } from "vitest";
import { classify } from "../src/quota/classify.js";
import { detailLines } from "../src/quota/format.js";
import { parseQuotaResponse } from "../src/quota/response.js";
import { body, budget, daily, SOFT_BUDGET_REAL, perMinute, HARD_CAPS_REAL, weekly } from "./fixtures.js";

const quotaOf = (raw: unknown) => {
  const parsed = parseQuotaResponse(raw);
  if (!parsed) throw new Error("not a quota snapshot");
  return classify(parsed);
};

describe("classify", () => {
  it("recognises Model A's three limits by type and fields", () => {
    const quota = quotaOf(SOFT_BUDGET_REAL);
    expect(quota.budget).toEqual({ level: -45, limit: 600, over: true, resetsInS: 2320 });
    expect(quota.caps).toHaveLength(1);
    expect(quota.caps[0]).toMatchObject({ name: "runaway", period: "week", counts: "tokens", usedPct: 34 });
    expect(quota.inFlight).toEqual({ inFlight: 0, limit: 16 });
  });

  it("recognises Model B's two windows (requests per minute, tokens per day)", () => {
    const quota = quotaOf(HARD_CAPS_REAL);
    expect(quota.budget).toBeUndefined();
    expect(quota.inFlight).toBeUndefined();
    expect(quota.caps.map((c) => [c.period, c.counts])).toEqual([
      ["minute", "requests"],
      ["day", "tokens"],
    ]);
  });

  it("ignores unknown or unsupported limits without error", () => {
    const quota = quotaOf(
      body(
        { name: "x", unlimited: true },
        { name: "sliding", window: { type: "sliding", duration_s: 60 }, limit: 10, used: 1 },
        { name: "odd", window: { type: "fixed", duration_s: 1234 }, limit: 10, used: 1, used_pct: 10 },
        { name: "hard-bucket", window: { type: "token_bucket", duration_s: 3600 }, limit: 10, level: 5 },
        { name: "soft-fixed", soft: true, window: { type: "fixed", duration_s: 86400 }, limit: 10, used: 1 },
        { name: "zero", window: { type: "unit", unit: "DAY" }, limit: 0, used: 0 },
        { name: "no-window", limit: 10, used: 1 },
        "not an object",
        daily(10),
      ),
    );
    expect(quota.budget).toBeUndefined();
    expect(quota.inFlight).toBeUndefined();
    expect(quota.caps.map((c) => c.name)).toEqual(["weighted_tokens_day"]);
  });

  it("keeps the first budget when two are present (documented order)", () => {
    const quota = quotaOf(body(budget(100, { over: false }), budget(-10)));
    expect(quota.budget?.level).toBe(100);
  });

  it("a descriptor that no rule matches (limits: []) adds nothing", () => {
    expect(quotaOf({ descriptors: [{ limits: [] }] })).toEqual({
      budget: undefined,
      caps: [],
      inFlight: undefined,
    });
  });

  it("rejects a body that is not a quota snapshot", () => {
    expect(parseQuotaResponse({ error: "unknown model" })).toBeUndefined();
    expect(parseQuotaResponse("x")).toBeUndefined();
  });

  it("detail lines list every limit, without thresholds", () => {
    expect(detailLines(quotaOf(body(perMinute(1), daily(41), weekly(10))), { timeZone: "UTC" })).toEqual([
      "per minute: 1/60 req/min",
      "today 41% · resets in 6h",
      "week 10% · resets Mon 10:00",
    ]);
  });
});
