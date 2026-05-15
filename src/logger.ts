import { context as otelContext } from "@opentelemetry/api";
import { type Logger, logs, SeverityNumber } from "@opentelemetry/api-logs";
import { PHOTON_OTEL_VERSION } from "./version";

export type LogAttrs = Record<string, string | number | boolean | undefined>;

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

function emit(
  severityNumber: SeverityNumber,
  severityText: string,
  module: string,
  message: string,
  attrs?: LogAttrs,
  error?: unknown
): void {
  const attributes: Record<string, string | number | boolean> = {
    "log.module": module,
    ...filterUndefined(attrs),
  };

  if (error instanceof Error) {
    attributes["exception.type"] = error.name;
    attributes["exception.message"] = error.message;
    if (error.stack) {
      attributes["exception.stacktrace"] = error.stack;
    }
  }

  getLogger().emit({
    severityNumber,
    severityText,
    body: message,
    attributes,
    context: otelContext.active(),
  });

  const prefix = `[${module}]`;
  if (severityNumber >= SeverityNumber.ERROR) {
    console.error(prefix, message, ...(error ? [error] : []));
  } else {
    console.log(prefix, message);
  }
}

export interface PhotonLogger {
  debug(message: string, attrs?: LogAttrs): void;
  error(message: string, attrs?: LogAttrs, error?: unknown): void;
  info(message: string, attrs?: LogAttrs): void;
  warn(message: string, attrs?: LogAttrs): void;
}

export function createLogger(module: string): PhotonLogger {
  return {
    info: (message, attrs) =>
      emit(SeverityNumber.INFO, "INFO", module, message, attrs),
    warn: (message, attrs) =>
      emit(SeverityNumber.WARN, "WARN", module, message, attrs),
    error: (message, attrs, error) =>
      emit(SeverityNumber.ERROR, "ERROR", module, message, attrs, error),
    debug: (message, attrs) =>
      emit(SeverityNumber.DEBUG, "DEBUG", module, message, attrs),
  };
}
