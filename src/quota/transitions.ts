/**
 * Toasts fire on state changes only: entering low priority, returning to
 * normal, and crossing a threshold upward on an hourly or longer hard cap.
 * Per-minute caps and in-flight requests move too fast to toast. The first
 * reading is compared with "normal, 0%", so starting at low priority toasts once.
 */
import type { HardCap, ModelQuota } from "./classify.js";
import { budgetSegments, capReset, formatPct, type FormatOptions } from "./format.js";

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface QuotaToast {
  variant: ToastVariant;
  message: string;
}

export const DEFAULT_TOAST_THRESHOLDS: readonly number[] = [80, 100];

const capKey = (cap: HardCap): string => `${cap.period}:${cap.name}`;

/** The highest threshold reached by `usedPct`, or 0. */
export function band(usedPct: number, thresholds: readonly number[]): number {
  return thresholds.reduce((reached, t) => (usedPct >= t && t > reached ? t : reached), 0);
}

const CAP_FULL: Record<HardCap["period"], string> = {
  minute: "per-minute cap reached",
  hour: "hourly cap reached",
  day: "daily cap reached",
  week: "weekly cap reached",
};

const CAP_WORD: Record<HardCap["period"], string> = {
  minute: "minute",
  hour: "this hour",
  day: "today",
  week: "week",
};

export function transitions(
  label: string,
  previous: ModelQuota | undefined,
  next: ModelQuota,
  options: FormatOptions & { toastThresholds?: readonly number[] } = {},
): QuotaToast[] {
  const thresholds = options.toastThresholds ?? DEFAULT_TOAST_THRESHOLDS;
  const toasts: QuotaToast[] = [];

  if (next.budget) {
    const wasLow = previous?.budget?.over ?? false;
    const isLow = next.budget.over;
    if (!wasLow && isLow) {
      toasts.push({ variant: "warning", message: [label, ...budgetSegments(next.budget)].join(" · ") });
    } else if (wasLow && !isLow) {
      toasts.push({ variant: "success", message: `${label} · back to normal priority` });
    }
  }

  const before = new Map((previous?.caps ?? []).map((cap) => [capKey(cap), cap]));
  for (const cap of next.caps) {
    if (cap.period === "minute") continue;
    const prev = before.get(capKey(cap));
    const was = prev ? band(prev.usedPct, thresholds) : 0;
    const now = band(cap.usedPct, thresholds);
    if (now <= was) continue;
    const reset = capReset(cap, options);
    const full = now >= 100;
    const head = full ? CAP_FULL[cap.period] : `${CAP_WORD[cap.period]} ${formatPct(cap.usedPct)}`;
    toasts.push({
      variant: full ? "error" : "warning",
      message: [label, head, ...(reset ? [reset] : [])].join(" · "),
    });
  }
  return toasts;
}
