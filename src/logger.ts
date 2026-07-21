import { context as otelContext } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { resolveLogger } from "./scope";
import { PHOTON_OTEL_VERSION } from "./version";

export type LogAttrs = Record<string, string | number | boolean | undefined>;

/**
 * Minimum severity that gets emitted (to both the OTLP record and the console).
 * `"silent"` suppresses everything, including errors.
 */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
const DEFAULT_LOG_LEVEL: LogLevel = "info";
const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: SeverityNumber.DEBUG, // 5
  info: SeverityNumber.INFO, // 9
  warn: SeverityNumber.WARN, // 13
  error: SeverityNumber.ERROR, // 17
  silent: Number.POSITIVE_INFINITY,
};

let levelOverride: LogLevel | undefined;
const warnedInvalidEnvLevels = new Set<string>();

function isLogLevel(value: unknown): value is LogLevel {
  return LOG_LEVELS.some((level) => level === value);
}

function envLevel(): LogLevel | undefined {
  const raw = process.env.LOG_LEVEL;
  if (raw === undefined) {
    return;
  }

  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return;
  }
  if (isLogLevel(normalized)) {
    return normalized;
  }

  if (!warnedInvalidEnvLevels.has(normalized)) {
    warnedInvalidEnvLevels.add(normalized);
    console.warn(
      `[@photon-ai/otel] Ignoring invalid LOG_LEVEL ${JSON.stringify(raw)}; expected one of: ${LOG_LEVELS.join(", ")}. Using ${DEFAULT_LOG_LEVEL}.`
    );
  }
  return;
}

/**
 * Resolve the active level fresh on each call so that `LOG_LEVEL` changes and
 * `setLogLevel()` both take effect immediately. Resolution order:
 *   1. `setLogLevel()` / `setupOtel({ logLevel })`
 *   2. `LOG_LEVEL` env var
 *   3. `info`
 */
function resolveLevel(): LogLevel {
  return levelOverride ?? envLevel() ?? DEFAULT_LOG_LEVEL;
}

/**
 * Programmatically set the minimum log level. Takes effect immediately for
 * subsequent logs and takes precedence over `LOG_LEVEL`.
 *
 * Invalid runtime values from untyped JavaScript callers throw a `TypeError`.
 */
export function setLogLevel(level: LogLevel): void {
  if (!isLogLevel(level)) {
    throw new TypeError(
      `Invalid log level; expected one of: ${LOG_LEVELS.join(", ")}.`
    );
  }
  levelOverride = level;
}

/** Current effective log level after programmatic / env / default resolution. */
export function getLogLevel(): LogLevel {
  return resolveLevel();
}

function filterUndefined(
  attrs?: LogAttrs
): Record<string, string | number | boolean> {
  if (!attrs) {
    return {};
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function consoleFor(
  severityNumber: SeverityNumber
): (...args: unknown[]) => void {
  if (severityNumber >= SeverityNumber.ERROR) {
    return console.error;
  }
  if (severityNumber >= SeverityNumber.WARN) {
    return console.warn;
  }
  if (severityNumber >= SeverityNumber.INFO) {
    return console.info;
  }
  return console.debug;
}

function emit(
  severityNumber: SeverityNumber,
  severityText: string,
  module: string,
  message: string,
  attrs?: LogAttrs,
  error?: unknown
): void {
  // Single gate: drop sub-threshold logs before they reach OTLP or the console.
  if (severityNumber < LEVEL_SEVERITY[resolveLevel()]) {
    return;
  }

  const userAttrs = filterUndefined(attrs);
  const attributes: Record<string, string | number | boolean> = {
    "log.module": module,
    ...userAttrs,
  };

  if (error instanceof Error) {
    attributes["exception.type"] = error.name;
    attributes["exception.message"] = error.message;
    if (error.stack) {
      attributes["exception.stacktrace"] = error.stack;
    }
  } else if (error !== undefined) {
    // Don't silently drop non-Error throws (strings, plain objects, etc.).
    attributes["exception.type"] = typeof error;
    attributes["exception.message"] = String(error);
  }

  resolveLogger("@photon-ai/otel", PHOTON_OTEL_VERSION).emit({
    severityNumber,
    severityText,
    body: message,
    attributes,
    context: otelContext.active(),
  });

  // Console: `[module] LEVEL message { ...attrs }` plus the raw error so the
  // runtime renders the full stack and pretty-prints the attribute bag.
  const extras: unknown[] = [];
  if (Object.keys(userAttrs).length > 0) {
    extras.push(userAttrs);
  }
  if (error !== undefined) {
    extras.push(error);
  }
  consoleFor(severityNumber)(`[${module}]`, severityText, message, ...extras);
}

export interface PhotonLogger {
  debug(message: string, attrs?: LogAttrs, error?: unknown): void;
  error(message: string, attrs?: LogAttrs, error?: unknown): void;
  info(message: string, attrs?: LogAttrs, error?: unknown): void;
  warn(message: string, attrs?: LogAttrs, error?: unknown): void;
}

export function createLogger(module: string): PhotonLogger {
  return {
    debug: (message, attrs, error) =>
      emit(SeverityNumber.DEBUG, "DEBUG", module, message, attrs, error),
    info: (message, attrs, error) =>
      emit(SeverityNumber.INFO, "INFO", module, message, attrs, error),
    warn: (message, attrs, error) =>
      emit(SeverityNumber.WARN, "WARN", module, message, attrs, error),
    error: (message, attrs, error) =>
      emit(SeverityNumber.ERROR, "ERROR", module, message, attrs, error),
  };
}
