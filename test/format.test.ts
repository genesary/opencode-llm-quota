import { describe, expect, it } from "vitest";
import type { SoftBudget } from "../src/quota/classify.js";
import {
  formatDuration,
  formatEtaMinutes,
  formatPct,
  formatWeekdayTime,
  returnToNormal,
} from "../src/quota/format.js";

const b = (level: number, limit: number, resetsInS: number | null, over = level <= 0): SoftBudget => ({
  level,
  limit,
  over,
  resetsInS,
});

describe("returnToNormal (time back to normal priority)", () => {
  it("rate = (limit − level) / resets_in_s, time = −level / rate, rounded up to the minute", () => {
    // Real response of the report: level −45, limit 600, resets_in_s 2320.
    // rate = 645 / 2320 ≈ 0.278 tokens/s; 45 / rate ≈ 161.9 s → 3 min.
    expect(returnToNormal(b(-45, 600, 2320))).toEqual({ kind: "minutes", minutes: 3 });
  });

  it("an exact number of minutes is not rounded up", () => {
    // 45 × 30100 / 645 = 2100 s = 35 min exactly.
    expect(returnToNormal(b(-45, 600, 30100))).toEqual({ kind: "minutes", minutes: 35 });
  });

  it("one second over a minute counts as the next minute", () => {
    // −level × resets / (limit − level) = 100 × 3660 / 6100 = 60.0 s → 1 min; 61 s → 2 min.
    expect(returnToNormal(b(-100, 6000, 3660))).toEqual({ kind: "minutes", minutes: 1 });
    expect(returnToNormal(b(-100, 6000, 3721))).toEqual({ kind: "minutes", minutes: 2 });
  });

  it("deep debt: hours", () => {
    // 6000 × 7200 / 12000 = 3600 s = 60 min.
    expect(returnToNormal(b(-6000, 6000, 7200))).toEqual({ kind: "minutes", minutes: 60 });
  });

  it("level 0 → soon", () => {
    expect(returnToNormal(b(0, 600, 3600))).toEqual({ kind: "soon" });
  });

  it("resets_in_s 0 or null (no rate) → unknown", () => {
    expect(returnToNormal(b(-45, 600, 0))).toEqual({ kind: "unknown" });
    expect(returnToNormal(b(-45, 600, null))).toEqual({ kind: "unknown" });
  });

  it("at least one minute for a tiny debt", () => {
    expect(returnToNormal(b(-1, 600, 10))).toEqual({ kind: "minutes", minutes: 1 });
  });
});

describe("formatting", () => {
  it("formatPct rounds and clamps to 0..100", () => {
    expect(formatPct(61.6)).toBe("62%");
    expect(formatPct(107.5)).toBe("100%");
    expect(formatPct(-3)).toBe("0%");
  });

  it("formatDuration", () => {
    expect(formatDuration(7)).toBe("<1 min");
    expect(formatDuration(2320)).toBe("39 min");
    expect(formatDuration(5400)).toBe("1h30");
    expect(formatDuration(7200)).toBe("2h");
    expect(formatDuration(7190)).toBe("2h");
    expect(formatDuration(21600)).toBe("6h");
    expect(formatDuration(37567)).toBe("10h");
  });

  it("formatEtaMinutes", () => {
    expect(formatEtaMinutes(35)).toBe("~35 min");
    expect(formatEtaMinutes(65)).toBe("~1h05");
    expect(formatEtaMinutes(120)).toBe("~2h");
  });

  it("formatWeekdayTime in the given time zone", () => {
    expect(formatWeekdayTime(new Date("2026-11-23T10:00:00Z"), "UTC")).toBe("Mon 10:00");
    expect(formatWeekdayTime(new Date("2026-11-23T10:00:00Z"), "Europe/Paris")).toBe("Mon 11:00");
    expect(formatWeekdayTime(new Date("2026-11-21T18:00:00Z"), "UTC")).toBe("Sat 18:00");
  });
});
