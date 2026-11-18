/**
 * Reads `/v1/quota` for each model of the platform provider and keeps the last
 * state. A read costs the gateway as much as a rate-limit decision, so each model
 * is read at most once per interval (60 s floor), plus once after a response ends,
 * never sooner than 60 s after the previous read. Failures back off up to 15 min;
 * a 404 parks the model for an hour. Neither the token nor a response body is logged.
 */
import { MIN_INTERVAL_SECONDS, type QuotaConfig } from "./config.js";
import { quotaUrl, readQuota, type ReadOutcome } from "./gateway.js";
import type { ModelQuota } from "./quota/classify.js";
import { compactLine, detailLines, type FormatOptions } from "./quota/format.js";
import { transitions, type QuotaToast } from "./quota/transitions.js";
import { log } from "./log.js";
import { sharedRead } from "./shared-reads.js";

export interface ModelRef {
  /** OpenCode's id of the model (the key under `provider.<id>.models`). */
  id: string;
  /** The name sent to the gateway (the model's `id` setting, else its key). */
  apiName: string;
  label: string;
}

export interface Target {
  baseURL: string;
  models: ModelRef[];
}

export type ModelStatus = "pending" | "ok" | "no-quota" | "unavailable";

export interface ModelView {
  id: string;
  apiName: string;
  label: string;
  status: ModelStatus;
  /** Status-line text; `undefined` when nothing is worth showing. */
  line: string | undefined;
  detail: string[];
  /** Last successful read, ms since epoch. */
  updatedAt: number | undefined;
}

export interface Snapshot {
  /** Gateway origin, e.g. `https://gateway.example.com`. */
  gateway: string | undefined;
  models: ModelView[];
}

export interface ServiceDeps {
  config: QuotaConfig;
  /** Gateway and models from the live OpenCode config, re-read every cycle. */
  resolveTarget: () => Promise<Target | undefined>;
  /** The current access token, or `undefined`. Must never start a login. */
  getToken: () => Promise<string | undefined>;
  read?: (url: URL, token: string) => Promise<ReadOutcome>;
  onToast?: (toast: QuotaToast) => void;
  onChange?: (snapshot: Snapshot) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  timeZone?: string;
  /** Where the process-wide read ledger lives; tests pass their own object. */
  ledgerScope?: Record<PropertyKey, unknown>;
}

export const NO_QUOTA_RECHECK_MS = 60 * 60_000;
export const MAX_BACKOFF_MS = 15 * 60_000;
/** Wait after a response ends, so the gateway has counted it. */
export const SETTLE_MS = 2_000;
/** Older states show their age. */
export const STALE_AFTER_MS = 5 * 60_000;
/** Retry delay when nothing was sent to the gateway: no token yet, or no provider yet. */
export const RETRY_SOON_MS = 10_000;
/** Longest wait of the `quota` tool for a first read. */
export const CURRENT_WAIT_MS = 12_000;

interface ModelState {
  ref: ModelRef;
  status: ModelStatus;
  quota: ModelQuota | undefined;
  updatedAt: number | undefined;
  lastAttemptAt: number | undefined;
  nextAt: number;
  failures: number;
  reading: boolean;
  waitingForToken: boolean;
}

export interface QuotaService {
  start(): void;
  stop(): void;
  /** A response of `model` (id or API name) ended: read it soon, at most once a minute. */
  requestRefresh(model: string): void;
  snapshot(): Snapshot;
  /**
   * The snapshot, after one read cycle when nothing is known yet (a host instance
   * that just started). Failing models keep their backoff.
   */
  current(): Promise<Snapshot>;
  /** Reads every model that is due. */
  tick(): Promise<void>;
}

export function createQuotaService(deps: ServiceDeps): QuotaService {
  const { config } = deps;
  const now = deps.now ?? Date.now;
  const read = sharedRead(deps.read ?? ((url: URL, token: string) => readQuota(url, token)), {
    windowMs: MIN_INTERVAL_SECONDS * 1000,
    now,
    ...(deps.ledgerScope ? { scope: deps.ledgerScope } : {}),
  });
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    });
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  const format: FormatOptions = {
    thresholds: config.thresholds,
    ...(deps.timeZone ? { timeZone: deps.timeZone } : {}),
  };

  let gateway: string | undefined;
  let baseURL: string | undefined;
  const states = new Map<string, ModelState>();
  let timer: unknown;
  let started = false;
  let ticking: Promise<void> | undefined;
  let nextTargetAt = 0;

  const view = (s: ModelState): ModelView => {
    let line: string | undefined;
    if (s.status === "unavailable" && !s.quota) line = `${s.ref.label} · quota unavailable`;
    else if (s.quota && s.status !== "no-quota") {
      line = compactLine(s.ref.label, s.quota, format);
      const age = s.updatedAt !== undefined ? now() - s.updatedAt : 0;
      if (line && age > STALE_AFTER_MS) line += ` (${Math.round(age / 60_000)} min ago)`;
    }
    return {
      id: s.ref.id,
      apiName: s.ref.apiName,
      label: s.ref.label,
      status: s.status,
      line,
      detail: s.quota && s.status !== "no-quota" ? detailLines(s.quota, format) : [],
      updatedAt: s.updatedAt,
    };
  };

  const snapshot = (): Snapshot => ({ gateway, models: [...states.values()].map(view) });
  const changed = (): void => deps.onChange?.(snapshot());

  const schedule = (): void => {
    if (!started) return;
    if (timer !== undefined) clearTimer(timer);
    let due = nextTargetAt;
    for (const s of states.values()) if (!s.reading) due = Math.min(due, s.nextAt);
    timer = setTimer(
      () => {
        timer = undefined;
        void service.tick();
      },
      Math.max(0, due - now()),
    );
  };

  const syncTarget = async (): Promise<void> => {
    let target: Target | undefined;
    try {
      target = await deps.resolveTarget();
    } catch (cause) {
      log.debug(
        `could not read the provider config: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    const origin = target ? quotaUrl(target.baseURL, config.quotaPath, "x")?.origin : undefined;
    // On v2 the provider appears only once the config overlay has loaded.
    nextTargetAt = now() + (origin ? config.intervalMs : RETRY_SOON_MS);
    if (!target || !origin) {
      if (gateway !== undefined || states.size) {
        log.info(`provider ${config.providerId}: no gateway in the config; quota display paused`);
      }
      gateway = undefined;
      baseURL = undefined;
      states.clear();
      return;
    }
    if (origin !== gateway) {
      if (gateway !== undefined) log.info(`gateway changed to ${origin}; quota state reset`);
      states.clear();
      gateway = origin;
    }
    baseURL = target.baseURL;
    const seen = new Set<string>();
    for (const ref of target.models) {
      seen.add(ref.apiName);
      const existing = states.get(ref.apiName);
      if (existing) existing.ref = ref;
      else {
        states.set(ref.apiName, {
          ref,
          status: "pending",
          quota: undefined,
          updatedAt: undefined,
          lastAttemptAt: undefined,
          nextAt: now(),
          failures: 0,
          reading: false,
          waitingForToken: false,
        });
      }
    }
    for (const key of [...states.keys()]) if (!seen.has(key)) states.delete(key);
  };

  const fail = (s: ModelState, what: string): void => {
    s.failures += 1;
    const backoff = Math.min(MAX_BACKOFF_MS, config.intervalMs * 2 ** (s.failures - 1));
    s.nextAt = now() + backoff;
    if (!s.quota) s.status = "unavailable";
    const message = `${s.ref.apiName}: quota unavailable (${what}); next attempt in ${Math.round(backoff / 1000)}s`;
    if (s.failures === 1) log.warn(message);
    else log.debug(message);
  };

  const readModel = async (s: ModelState): Promise<void> => {
    if (!baseURL) return;
    const url = quotaUrl(baseURL, config.quotaPath, s.ref.apiName);
    if (!url) return;
    s.reading = true;
    try {
      let token: string | undefined;
      try {
        token = await deps.getToken();
      } catch {
        token = undefined;
      }
      if (!token) {
        if (!s.waitingForToken) log.debug(`${s.ref.apiName}: no token yet; not reading`);
        s.waitingForToken = true;
        if (!s.quota) s.status = "unavailable";
        // Nothing reaches the gateway, so checking often is free; on v1 the token
        // only appears once opencode-keycloak-auth's loader has run.
        s.nextAt = now() + RETRY_SOON_MS;
        return;
      }
      s.waitingForToken = false;
      s.lastAttemptAt = now();
      const outcome = await read(url, token);
      log.debug(`${s.ref.apiName}: ${outcome.kind}`);
      switch (outcome.kind) {
        case "ok": {
          if (s.failures > 0) log.info(`${s.ref.apiName}: quota available again`);
          const previous = s.status === "ok" ? s.quota : undefined;
          s.quota = outcome.quota;
          s.status = "ok";
          s.updatedAt = now();
          s.failures = 0;
          s.nextAt = now() + config.intervalMs;
          if (config.toasts && deps.onToast) {
            for (const toast of transitions(s.ref.label, previous, outcome.quota, {
              ...format,
              toastThresholds: config.toastThresholds,
            })) {
              deps.onToast(toast);
            }
          }
          break;
        }
        case "no-quota":
          log.debug(`${s.ref.apiName}: no quota on this model (404); ignored`);
          s.status = "no-quota";
          s.quota = undefined;
          s.failures = 0;
          s.nextAt = now() + NO_QUOTA_RECHECK_MS;
          break;
        case "no-token":
          if (!s.quota) s.status = "unavailable";
          s.nextAt = now() + config.intervalMs;
          break;
        case "unauthorized":
          fail(s, `HTTP ${outcome.status}, token refused`);
          break;
        case "error":
          fail(s, outcome.reason);
          break;
      }
    } finally {
      s.reading = false;
    }
  };

  const runTick = async (): Promise<void> => {
    if (now() >= nextTargetAt || !gateway) await syncTarget();
    const due = [...states.values()].filter((s) => !s.reading && s.nextAt <= now());
    await Promise.all(due.map(readModel));
    changed();
  };

  const service: QuotaService = {
    start() {
      if (started || !config.enabled) return;
      started = true;
      void service.tick();
    },
    stop() {
      started = false;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
    requestRefresh(model) {
      const s = [...states.values()].find((x) => x.ref.id === model || x.ref.apiName === model);
      if (!s || s.status === "no-quota") return;
      // The floor is one read per minute, whatever the (longer) periodic interval.
      const floor = s.lastAttemptAt !== undefined ? s.lastAttemptAt + MIN_INTERVAL_SECONDS * 1000 : 0;
      let at = Math.max(now() + SETTLE_MS, floor);
      // A failing model keeps its backoff.
      if (s.failures > 0) at = Math.max(at, s.nextAt);
      if (at < s.nextAt) {
        s.nextAt = at;
        schedule();
      }
    },
    snapshot,
    async current() {
      const pending = (): boolean => [...states.values()].some((st) => st.status === "pending");
      if (!started || (gateway && !pending())) return snapshot();
      const cycle = async (): Promise<void> => {
        nextTargetAt = 0;
        // Only models never read are forced; the others keep their floor and backoff.
        for (const st of states.values()) if (st.status === "pending") st.nextAt = Math.min(st.nextAt, now());
        await service.tick();
        // A tick already running when we were called may have used the old target.
        if (!gateway || pending()) {
          nextTargetAt = 0;
          await service.tick();
        }
      };
      // A stalled gateway must not hold the agent: answer with what is known.
      let timer: unknown;
      await Promise.race([
        cycle(),
        new Promise<void>((resolve) => {
          timer = setTimer(resolve, CURRENT_WAIT_MS);
        }),
      ]);
      clearTimer(timer);
      return snapshot();
    },
    async tick() {
      if (ticking) return ticking;
      ticking = runTick()
        .catch((cause) => log.debug(`tick failed: ${cause instanceof Error ? cause.message : String(cause)}`))
        .finally(() => {
          ticking = undefined;
          schedule();
        });
      return ticking;
    },
  };
  return service;
}
