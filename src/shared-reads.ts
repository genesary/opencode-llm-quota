/**
 * One gateway read per URL and token per minute for the whole process. OpenCode v2
 * runs one plugin instance per location (project directory) in the same service,
 * so without this each open project would poll on its own.
 */
import { createHash } from "node:crypto";
import type { ReadOutcome } from "./gateway.js";

const LEDGER_KEY = Symbol.for("opencode-llm-quota/reads@1");

interface Entry {
  at: number;
  outcome: Promise<ReadOutcome>;
}

function ledger(scope: Record<PropertyKey, unknown>): Map<string, Entry> {
  let map = scope[LEDGER_KEY] as Map<string, Entry> | undefined;
  if (!(map instanceof Map)) {
    map = new Map();
    Object.defineProperty(scope, LEDGER_KEY, { value: map, configurable: true });
  }
  return map;
}

export function sharedRead(
  read: (url: URL, token: string) => Promise<ReadOutcome>,
  options: { windowMs: number; now: () => number; scope?: Record<PropertyKey, unknown> },
): (url: URL, token: string) => Promise<ReadOutcome> {
  const entries = ledger(options.scope ?? (globalThis as Record<PropertyKey, unknown>));
  return (url, token) => {
    // The key holds a token fingerprint, never the token.
    const key = `${url.href} ${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
    const now = options.now();
    const entry = entries.get(key);
    if (entry && now - entry.at < options.windowMs) return entry.outcome;
    for (const [k, e] of entries) if (now - e.at >= options.windowMs) entries.delete(k);
    const outcome = read(url, token);
    entries.set(key, { at: now, outcome });
    return outcome;
  };
}
