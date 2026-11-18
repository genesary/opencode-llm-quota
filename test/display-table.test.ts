// One test per row of the display table in the README.
import { describe, expect, it } from "vitest";
import { classify } from "../src/quota/classify.js";
import { compactLine } from "../src/quota/format.js";
import { parseQuotaResponse } from "../src/quota/response.js";
import {
  body,
  budget,
  daily,
  inflight,
  SOFT_BUDGET_REAL,
  softBudgetModel,
  perMinute,
  HARD_CAPS_REAL,
  hardCapsModel,
  weekly,
} from "./fixtures.js";

const line = (label: string, raw: unknown): string | undefined => {
  const parsed = parseQuotaResponse(raw);
  if (!parsed) throw new Error("not a quota snapshot");
  return compactLine(label, classify(parsed), { timeZone: "UTC" });
};

describe("display table", () => {
  it("Model A, budget OK → normal priority · budget <level/limit> %", () => {
    expect(line("Model A", softBudgetModel(budget(372, { over: false })))).toBe(
      "Model A · normal priority · budget 62% left",
    );
  });

  it("Model A, budget exhausted → low priority · normal in ~35 min", () => {
    // rate = (600 + 45) / 30100 tokens/s; back to 0 in 45 / rate = 2100 s = 35 min.
    expect(line("Model A", softBudgetModel(budget(-45, { resetsInS: 30100 })))).toBe(
      "Model A · low priority · normal in ~35 min",
    );
  });

  it("Model A, budget at exactly 0 and over → low priority · normal soon", () => {
    expect(line("Model A", softBudgetModel(budget(0, { over: true })))).toBe(
      "Model A · low priority · normal soon",
    );
  });

  it("Model A in debt (used_pct > 100) never shows a percentage above 100", () => {
    const text = line("Model A", SOFT_BUDGET_REAL);
    expect(text).toBe("Model A · low priority · normal in ~3 min");
    expect(text).not.toMatch(/\d+\s?%/);
  });

  it("Model B → today <used_pct> % · resets in <resets_in_s>", () => {
    expect(line("Model B", hardCapsModel(perMinute(1), daily(41, 6 * 3600)))).toBe(
      "Model B · today 41% · resets in 6h",
    );
  });

  it("Model B, real response of the report", () => {
    expect(line("Model B", HARD_CAPS_REAL)).toBe("Model B · today 68% · resets in 10h");
  });

  it("Model B per minute: nothing up to 80%", () => {
    expect(line("Model B", hardCapsModel(perMinute(48), daily(41)))).not.toMatch(/req\/min/);
  });

  it("Model B per minute: shown above 80% as used/limit req/min", () => {
    expect(line("Model B", hardCapsModel(perMinute(52), daily(41)))).toBe(
      "Model B · today 41% · resets in 6h · 52/60 req/min",
    );
  });

  it("Model B with only a per-minute window under its threshold shows nothing", () => {
    expect(line("Model B", body(perMinute(10)))).toBeUndefined();
  });

  it("Model A weekly cap: nothing under 50%", () => {
    expect(line("Model A", softBudgetModel(budget(372, { over: false }), weekly(49.9)))).toBe(
      "Model A · normal priority · budget 62% left",
    );
  });

  it("Model A weekly cap: from 50%, week <used_pct> % · reset <weekday> <HH:MM>", () => {
    // 2026-11-23 is a Monday.
    expect(
      line("Model A", softBudgetModel(budget(372, { over: false }), weekly(78, "2026-11-23T10:00:00Z"))),
    ).toBe("Model A · normal priority · budget 62% left · week 78% · resets Mon 10:00");
  });

  it("in-flight requests: nothing under 12/16", () => {
    expect(
      line("Model A", softBudgetModel(budget(372, { over: false }), weekly(10), inflight(11))),
    ).not.toMatch(/in flight/);
  });

  it("in-flight requests: shown at 12/16 or more", () => {
    expect(line("Model A", softBudgetModel(budget(372, { over: false }), weekly(10), inflight(12)))).toMatch(
      /· in flight 12\/16$/,
    );
    expect(line("Model A", softBudgetModel(budget(372, { over: false }), weekly(10), inflight(14)))).toBe(
      "Model A · normal priority · budget 62% left · in flight 14/16",
    );
  });

  it("a hard cap above 100% is shown at 100%", () => {
    expect(line("Model B", hardCapsModel(perMinute(1), daily(112.4)))).toBe(
      "Model B · today 100% · resets in 6h",
    );
  });
});
