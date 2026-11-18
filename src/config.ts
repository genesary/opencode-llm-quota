/**
 * Options from `opencode.json`, then `OPENCODE_QUOTA_*` variables, then defaults.
 * There is no gateway URL option on purpose: the URL comes from the provider's
 * `baseURL`, so the token only goes where LLM requests already go.
 */
import { DEFAULT_THRESHOLDS, type DisplayThresholds } from "./quota/format.js";
import { DEFAULT_TOAST_THRESHOLDS } from "./quota/transitions.js";
import { log } from "./log.js";

export interface QuotaPluginOptions {
  enabled?: boolean | string;
  /** Defaults to opencode-keycloak-auth's provider (`OPENCODE_KC_PROVIDER_ID`, else `keycloak`). */
  providerId?: string;
  /** Seconds between two reads of a model; values below 60 become 60. */
  intervalSeconds?: number | string;
  minuteThresholdPct?: number | string;
  weeklyThresholdPct?: number | string;
  inFlightThresholdPct?: number | string;
  /** Hard-cap usage levels (%) that toast when crossed upward. */
  toastThresholdsPct?: number[] | string;
  toasts?: boolean | string;
  /** Display names by model id or API name, e.g. `{ "model-a": "Model A" }`. */
  labels?: Record<string, string>;
  /** Matches the chart value `rateLimiting.quotaLookup.path`. */
  quotaPath?: string;
}

export interface QuotaConfig {
  enabled: boolean;
  providerId: string;
  intervalMs: number;
  thresholds: DisplayThresholds;
  toastThresholds: number[];
  toasts: boolean;
  labels: Record<string, string>;
  quotaPath: string;
}

/** A read costs the gateway as much as a rate-limit decision. */
export const MIN_INTERVAL_SECONDS = 60;

type Env = Record<string, string | undefined>;

const ENV_PREFIX = "OPENCODE_QUOTA_";

function env(name: string, source: Env): string | undefined {
  const value = source[ENV_PREFIX + name]?.trim();
  return value ? value : undefined;
}

function toBool(value: boolean | string | undefined, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  log.warn(`${label}: expected true/false, got ${JSON.stringify(value)}; using ${fallback}`);
  return fallback;
}

function toNumber(value: number | string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    log.warn(`${label}: expected a non-negative number, got ${JSON.stringify(value)}; using ${fallback}`);
    return fallback;
  }
  return n;
}

function toThresholds(value: number[] | string | undefined): number[] {
  if (value === undefined) return [...DEFAULT_TOAST_THRESHOLDS];
  const list =
    typeof value === "string"
      ? value
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number)
      : value;
  const valid = list.filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0);
  return valid.length ? [...new Set(valid)].sort((a, b) => a - b) : [...DEFAULT_TOAST_THRESHOLDS];
}

const DEFAULT_QUOTA_PATH = "/v1/quota";

/** A plain absolute path on the gateway; anything that could name another host falls back to the default. */
function toQuotaPath(value: string): string {
  const path = value.startsWith("/") ? value : `/${value}`;
  if (/^\/(?!\/)[A-Za-z0-9._~/-]*$/.test(path)) return path;
  log.warn(`quotaPath ${JSON.stringify(value)} is not a plain path; using ${DEFAULT_QUOTA_PATH}`);
  return DEFAULT_QUOTA_PATH;
}

export function resolveConfig(options: QuotaPluginOptions = {}, source: Env = process.env): QuotaConfig {
  const requested = toNumber(
    options.intervalSeconds ?? env("INTERVAL", source),
    MIN_INTERVAL_SECONDS,
    "intervalSeconds",
  );
  if (requested < MIN_INTERVAL_SECONDS) {
    log.warn(`intervalSeconds ${requested} is below the ${MIN_INTERVAL_SECONDS}s minimum; using 60`);
  }
  const quotaPath = options.quotaPath ?? env("PATH", source) ?? DEFAULT_QUOTA_PATH;
  return {
    enabled: toBool(options.enabled ?? env("ENABLED", source), true, "enabled"),
    providerId:
      options.providerId ??
      env("PROVIDER_ID", source) ??
      source["OPENCODE_KC_PROVIDER_ID"]?.trim() ??
      "keycloak",
    intervalMs: Math.max(MIN_INTERVAL_SECONDS, requested) * 1000,
    thresholds: {
      minutePct: toNumber(
        options.minuteThresholdPct ?? env("MINUTE_THRESHOLD", source),
        DEFAULT_THRESHOLDS.minutePct,
        "minuteThresholdPct",
      ),
      weeklyPct: toNumber(
        options.weeklyThresholdPct ?? env("WEEKLY_THRESHOLD", source),
        DEFAULT_THRESHOLDS.weeklyPct,
        "weeklyThresholdPct",
      ),
      inFlightPct: toNumber(
        options.inFlightThresholdPct ?? env("INFLIGHT_THRESHOLD", source),
        DEFAULT_THRESHOLDS.inFlightPct,
        "inFlightThresholdPct",
      ),
    },
    toastThresholds: toThresholds(options.toastThresholdsPct ?? env("TOAST_THRESHOLDS", source)),
    toasts: toBool(options.toasts ?? env("TOASTS", source), true, "toasts"),
    labels: options.labels && typeof options.labels === "object" ? { ...options.labels } : {},
    quotaPath: toQuotaPath(quotaPath),
  };
}
