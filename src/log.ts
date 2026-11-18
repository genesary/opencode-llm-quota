/**
 * Leveled logger with a `[quota]` prefix. `OPENCODE_QUOTA_LOG` sets the level
 * (silent, error, warn by default, info, debug). Never log the token or a
 * `/v1/quota` body: model name, HTTP status and next attempt only.
 */
import { appendFileSync } from "node:fs";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const LEVELS: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const DEFAULT_PREFIX = "[quota]";
const ENV_KEY = "OPENCODE_QUOTA_LOG";
const FILE_ENV_KEY = "OPENCODE_QUOTA_LOG_FILE";

type Env = Record<string, string | undefined>;

/** Where log lines go. `console` satisfies this shape. */
export interface LogSink {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

export interface Logger {
  error: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
  readonly level: LogLevel;
  readonly enabled: (level: Exclude<LogLevel, "silent">) => boolean;
}

/**
 * Parse a level string, tolerating common aliases. Unknown values fall back to
 * `fallback` rather than throwing: a bad log level must never break the plugin.
 */
export function parseLevel(value: string | undefined, fallback: LogLevel = "warn"): LogLevel {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "") return fallback;
  if (v in LEVELS) return v as LogLevel;
  switch (v) {
    case "off":
    case "none":
    case "quiet":
      return "silent";
    case "warning":
      return "warn";
    case "verbose":
    case "trace":
      return "debug";
    default:
      return fallback;
  }
}

export interface LoggerOptions {
  /** Explicit level; overrides `env`. */
  level?: LogLevel;
  /** Sink to write to. Default: the global `console`. */
  sink?: LogSink;
  /** Environment to read `OPENCODE_QUOTA_LOG` from when `level` is not given. */
  env?: Env;
  /** Line prefix. Default: `[quota]`. */
  prefix?: string;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? console;
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const level = options.level ?? parseLevel(options.env?.[ENV_KEY]);
  const threshold = LEVELS[level];

  const enabled = (lvl: Exclude<LogLevel, "silent">): boolean => threshold >= LEVELS[lvl];

  const at =
    (lvl: Exclude<LogLevel, "silent">, write: (...args: unknown[]) => void) =>
    (message: string, ...args: unknown[]): void => {
      if (enabled(lvl)) write(`${prefix} ${lvl}: ${message}`, ...args);
    };

  return {
    error: at("error", (...a) => sink.error(...a)),
    warn: at("warn", (...a) => sink.warn(...a)),
    info: at("info", (...a) => sink.info(...a)),
    debug: at("debug", (...a) => sink.debug(...a)),
    level,
    enabled,
  };
}

/** Re-reads `OPENCODE_QUOTA_LOG` on every call, so tests can drive it with `vi.stubEnv`. */
/**
 * OpenCode v2 does not surface plugin console output anywhere, so
 * `OPENCODE_QUOTA_LOG_FILE` also appends each line to that file.
 */
function toFile(line: string): void {
  const file = process.env[FILE_ENV_KEY];
  if (!file) return;
  try {
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // An unwritable log file must not break the plugin.
  }
}

export const log: Logger = (() => {
  const enabled = (lvl: Exclude<LogLevel, "silent">): boolean =>
    LEVELS[parseLevel(process.env[ENV_KEY])] >= LEVELS[lvl];

  const at =
    (lvl: Exclude<LogLevel, "silent">, write: (...args: unknown[]) => void) =>
    (message: string, ...args: unknown[]): void => {
      if (!enabled(lvl)) return;
      const line = `${DEFAULT_PREFIX} ${lvl}: ${message}`;
      write(line, ...args);
      toFile(line);
    };

  return {
    error: at("error", (...a) => console.error(...a)),
    warn: at("warn", (...a) => console.warn(...a)),
    info: at("info", (...a) => console.info(...a)),
    debug: at("debug", (...a) => console.debug(...a)),
    get level(): LogLevel {
      return parseLevel(process.env[ENV_KEY]);
    },
    enabled,
  };
})();
