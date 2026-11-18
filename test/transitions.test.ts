import { describe, expect, it } from "vitest";
import { classify, type ModelQuota } from "../src/quota/classify.js";
import { parseQuotaResponse } from "../src/quota/response.js";
import { band, transitions } from "../src/quota/transitions.js";
import { budget, daily, softBudgetModel, perMinute, hardCapsModel, weekly } from "./fixtures.js";

const q = (raw: unknown): ModelQuota => classify(parseQuotaResponse(raw)!);
const opts = { timeZone: "UTC" };

describe("toasts on state change only", () => {
  it("no toast when nothing changes", () => {
    const state = q(softBudgetModel(budget(300, { over: false })));
    expect(transitions("Model A", state, state, opts)).toEqual([]);
  });

  it("no toast on the first reading when everything is normal", () => {
    expect(transitions("Model A", undefined, q(softBudgetModel(budget(300, { over: false }))), opts)).toEqual(
      [],
    );
  });

  it("entering low priority → one warning toast", () => {
    const before = q(softBudgetModel(budget(10, { over: false })));
    const after = q(softBudgetModel(budget(-45, { resetsInS: 30100 })));
    expect(transitions("Model A", before, after, opts)).toEqual([
      { variant: "warning", message: "Model A · low priority · normal in ~35 min" },
    ]);
    // Staying low: nothing more, even as the ETA moves.
    expect(
      transitions("Model A", after, q(softBudgetModel(budget(-20, { resetsInS: 20000 }))), opts),
    ).toEqual([]);
  });

  it("back to normal priority → one success toast", () => {
    const before = q(softBudgetModel(budget(-45)));
    const after = q(softBudgetModel(budget(50, { over: false })));
    expect(transitions("Model A", before, after, opts)).toEqual([
      { variant: "success", message: "Model A · back to normal priority" },
    ]);
  });

  it("starting already at low priority is told once", () => {
    expect(transitions("Model A", undefined, q(softBudgetModel(budget(-45))), opts)).toHaveLength(1);
  });

  it("crossing 80% then 100% of the daily cap → warning, then error", () => {
    const at70 = q(hardCapsModel(perMinute(1), daily(70)));
    const at85 = q(hardCapsModel(perMinute(1), daily(85)));
    const at90 = q(hardCapsModel(perMinute(1), daily(90)));
    const full = q(hardCapsModel(perMinute(1), daily(103)));
    expect(transitions("Model B", at70, at85, opts)).toEqual([
      { variant: "warning", message: "Model B · today 85% · resets in 6h" },
    ]);
    expect(transitions("Model B", at85, at90, opts)).toEqual([]);
    expect(transitions("Model B", at90, full, opts)).toEqual([
      { variant: "error", message: "Model B · daily cap reached · resets in 6h" },
    ]);
    // The daily reset (going down) is silent.
    expect(transitions("Model B", full, at70, opts)).toEqual([]);
  });

  it("weekly cap: absolute reset time in the toast", () => {
    const before = q(softBudgetModel(budget(300, { over: false }), weekly(60)));
    const after = q(softBudgetModel(budget(300, { over: false }), weekly(81)));
    expect(transitions("Model A", before, after, opts)).toEqual([
      { variant: "warning", message: "Model A · week 81% · resets Mon 10:00" },
    ]);
  });

  it("per-minute caps never toast", () => {
    expect(
      transitions("Model B", q(hardCapsModel(perMinute(1))), q(hardCapsModel(perMinute(60))), opts),
    ).toEqual([]);
  });

  it("custom thresholds", () => {
    const toasts = transitions(
      "Model B",
      q(hardCapsModel(perMinute(1), daily(40))),
      q(hardCapsModel(perMinute(1), daily(55))),
      {
        ...opts,
        toastThresholds: [50],
      },
    );
    expect(toasts).toHaveLength(1);
  });

  it("band", () => {
    expect(band(79.9, [80, 100])).toBe(0);
    expect(band(80, [80, 100])).toBe(80);
    expect(band(150, [80, 100])).toBe(100);
  });
});
