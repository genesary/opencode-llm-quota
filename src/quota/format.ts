/**
 * Display of a model's quota as a state rather than raw percentages. With a
 * soft budget, "100% used" reads as blocked when the user is only at low
 * priority, so the budget shows a priority and what is left, never more than 100%.
 */
import type { HardCap, ModelQuota, Period, SoftBudget } from "./classify.js";

export interface DisplayThresholds {
  /** Show a per-minute cap only above this usage (%). */
  minutePct: number;
  /** Show a weekly cap from this usage (%). */
  weeklyPct: number;
  /** Show in-flight requests from this share of the limit (%); 75 is 12/16. */
  inFlightPct: number;
}

export const DEFAULT_THRESHOLDS: DisplayThresholds = { minutePct: 80, weeklyPct: 50, inFlightPct: 75 };

export interface FormatOptions {
  thresholds?: DisplayThresholds;
  /** IANA time zone for absolute reset times; defaults to the system's. */
  timeZone?: string;
}

export function formatPct(value: number): string {
  return `${Math.min(100, Math.max(0, Math.round(value)))}%`;
}

/** 45 → "<1 min", 2400 → "40 min", 5400 → "1h30", 37567 → "10h". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return "<1 min";
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min`;
  const hours = Math.floor(seconds / 3600);
  if (hours >= 3) return `${Math.round(seconds / 3600)}h`;
  const minutes = Math.round((seconds % 3600) / 60);
  if (minutes === 60) return `${hours + 1}h`;
  return minutes === 0 ? `${hours}h` : `${hours}h${pad(minutes)}`;
}

/** 35 → "~35 min", 65 → "~1h05". */
export function formatEtaMinutes(minutes: number): string {
  if (minutes < 60) return `~${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `~${h}h` : `~${h}h${pad(m)}`;
}

/** "Mon 10:00" in the given time zone. */
export function formatWeekdayTime(date: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("hour")}:${get("minute")}`;
}

const pad = (n: number): string => String(n).padStart(2, "0");

export type ReturnToNormal = { kind: "soon" } | { kind: "minutes"; minutes: number } | { kind: "unknown" };

/**
 * Time until a budget in debt is back to normal priority. `/quota` gives no
 * refill rate, so it comes from the time to full: rate = (limit − level) /
 * resets_in_s, then time = −level / rate, rounded up to the minute.
 */
export function returnToNormal(budget: SoftBudget): ReturnToNormal {
  if (budget.level >= 0) return { kind: "soon" };
  const resetsIn = budget.resetsInS;
  if (resetsIn === null || resetsIn <= 0) return { kind: "unknown" };
  const missing = budget.limit - budget.level;
  if (!(missing > 0)) return { kind: "unknown" };
  // Same formula with a single division, so an exact 2100 s stays 35 min.
  const seconds = (-budget.level * resetsIn) / missing;
  return { kind: "minutes", minutes: Math.max(1, Math.ceil(seconds / 60)) };
}

export function budgetSegments(budget: SoftBudget): string[] {
  if (!budget.over) {
    return ["normal priority", `budget ${formatPct((budget.level / budget.limit) * 100)} left`];
  }
  const eta = returnToNormal(budget);
  if (eta.kind === "soon") return ["low priority", "normal soon"];
  if (eta.kind === "minutes") return ["low priority", `normal in ${formatEtaMinutes(eta.minutes)}`];
  return ["low priority"];
}

const PERIOD_WORD: Record<Period, string> = {
  minute: "minute",
  hour: "this hour",
  day: "today",
  week: "week",
};

/** Weekly caps reset at a stated time ("Mon 10:00"); shorter ones show a countdown. */
export function capReset(cap: HardCap, options: FormatOptions = {}): string | undefined {
  if (cap.period === "week" && cap.resetsAt)
    return `resets ${formatWeekdayTime(cap.resetsAt, options.timeZone)}`;
  if (cap.resetsInS !== null) return `resets in ${formatDuration(cap.resetsInS)}`;
  return undefined;
}

export function capSegments(cap: HardCap, options: FormatOptions = {}): string[] {
  if (cap.period === "minute") {
    const unit = cap.counts === "requests" ? "req" : "tokens";
    return [`${Math.round(cap.used)}/${Math.round(cap.limit)} ${unit}/min`];
  }
  const reset = capReset(cap, options);
  return [`${PERIOD_WORD[cap.period]} ${formatPct(cap.usedPct)}`, ...(reset ? [reset] : [])];
}

/** Whether a cap belongs in the status line. */
export function capVisible(cap: HardCap, thresholds: DisplayThresholds): boolean {
  if (cap.period === "minute") return (cap.used / cap.limit) * 100 > thresholds.minutePct;
  if (cap.period === "week") return cap.usedPct >= thresholds.weeklyPct;
  return true;
}

export function inFlightSegment(inFlight: { inFlight: number; limit: number }): string {
  return `in flight ${inFlight.inFlight}/${inFlight.limit}`;
}

/** Status-line segments: budget, caps from the longest period down, then in-flight requests. */
export function compactSegments(quota: ModelQuota, options: FormatOptions = {}): string[] {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const segments: string[] = [];
  if (quota.budget) segments.push(...budgetSegments(quota.budget));
  const order: Period[] = ["week", "day", "hour", "minute"];
  const caps = [...quota.caps].sort((a, b) => order.indexOf(a.period) - order.indexOf(b.period));
  for (const cap of caps) if (capVisible(cap, thresholds)) segments.push(...capSegments(cap, options));
  if (quota.inFlight && (quota.inFlight.inFlight * 100) / quota.inFlight.limit >= thresholds.inFlightPct) {
    segments.push(inFlightSegment(quota.inFlight));
  }
  return segments;
}

/** "Model A · normal priority · budget 62% left", or `undefined` when nothing is worth showing. */
export function compactLine(
  label: string,
  quota: ModelQuota,
  options: FormatOptions = {},
): string | undefined {
  const segments = compactSegments(quota, options);
  return segments.length ? [label, ...segments].join(" · ") : undefined;
}

/** Every limit of a model, one per line, ignoring thresholds. */
export function detailLines(quota: ModelQuota, options: FormatOptions = {}): string[] {
  const lines: string[] = [];
  if (quota.budget) lines.push(budgetSegments(quota.budget).join(" · "));
  for (const cap of quota.caps) {
    const segments = capSegments(cap, options).join(" · ");
    lines.push(cap.period === "minute" ? `per minute: ${segments}` : segments);
  }
  if (quota.inFlight) lines.push(inFlightSegment(quota.inFlight));
  return lines;
}
