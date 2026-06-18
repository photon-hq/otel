import { context as otelContext } from "@opentelemetry/api";
import { type Logger, logs, SeverityNumber } from "@opentelemetry/api-logs";
import { PHOTON_OTEL_VERSION } from "./version";

export type LogAttrs = Record<string, string | number | boolean | undefined>;

/**
 * Minimum severity that gets emitted (to both the OTLP record and the console).
 * `"silent"` suppresses everything, including errors.
 */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: SeverityNumber.DEBUG, // 5
  info: SeverityNumber.INFO, // 9
  warn: SeverityNumber.WARN, // 13
  error: SeverityNumber.ERROR, // 17
  silent: Number.POSITIVE_INFINITY,
};

let levelOverride: LogLevel | undefined;

function envLevel(): LogLevel | undefined {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw && raw in LEVEL_SEVERITY) {
    return raw as LogLevel;
  }
  return;
}

function defaultLevel(): LogLevel {
  return (process.env.DEPLOYMENT_ENV ?? "development") === "development"
    ? "debug"
    : "info";
}

/**
 * Resolve the active level fresh on each call so that `LOG_LEVEL` changes and
 * `setLogLevel()` both take effect immediately. Resolution order (env wins, to
 * match the rest of the package's config story):
 *   1. `LOG_LEVEL` env var
 *   2. `setLogLevel()` / `setupOtel({ logLevel })`
 *   3. environment-driven default (`debug` in development, `info` otherwise)
 */
function resolveLevel(): LogLevel {
  return envLevel() ?? levelOverride ?? defaultLevel();
}

/**
 * Programmatically set the minimum log level. Takes effect immediately for
 * subsequent logs. `LOG_LEVEL` env var still wins if set.
 */
export function setLogLevel(level: LogLevel): void {
  levelOverride = level;
}

/** Current effective log level, after env / override / default resolution. */
export function getLogLevel(): LogLevel {
  return resolveLevel();
}

let scopedLogger: Logger | undefined;

function getLogger(): Logger {
  if (!scopedLogger) {
    scopedLogger = logs.getLogger("@photon-ai/otel", PHOTON_OTEL_VERSION);
  }
  return scopedLogger;
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

  getLogger().emit({
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
