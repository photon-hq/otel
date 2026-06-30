import { type Tracer, type TracerProvider, trace } from "@opentelemetry/api";
import {
  type Logger,
  type LoggerProvider,
  logs,
} from "@opentelemetry/api-logs";

/**
 * Holds the tracer/logger providers the active `setupOtel()` built. This lets
 * the library's own helpers (`withSpan`, `createLogger`, the fetch wrap) emit
 * into those providers even in scoped mode (`register: false`), where the
 * global OTel provider registry is deliberately left untouched so the library
 * can coexist with a host app's own OpenTelemetry setup.
 *
 * Resolution prefers the held provider and falls back to the global API, so
 * helpers used before `setupOtel()` (or after `shutdown()`) behave exactly as
 * they did when they read `trace.getTracer()` / `logs.getLogger()` directly.
 */
let heldTracerProvider: TracerProvider | undefined;
let heldLoggerProvider: LoggerProvider | undefined;

export function setActiveProviders(providers: {
  tracerProvider: TracerProvider;
  loggerProvider: LoggerProvider;
}): void {
  heldTracerProvider = providers.tracerProvider;
  heldLoggerProvider = providers.loggerProvider;
}

export function clearActiveProviders(): void {
  heldTracerProvider = undefined;
  heldLoggerProvider = undefined;
}

/**
 * The active tracer: the provider `setupOtel()` built when set, else the global
 * one. Resolved per call — `getTracer` is memoized inside the provider, so this
 * is cheap and never pins a stale provider across setup/shutdown cycles.
 */
export function resolveTracer(name: string, version?: string): Tracer {
  return (heldTracerProvider ?? trace.getTracerProvider()).getTracer(
    name,
    version
  );
}

/** The active logger: the held provider when set, else the global one. */
export function resolveLogger(name: string, version?: string): Logger {
  return (heldLoggerProvider ?? logs.getLoggerProvider()).getLogger(
    name,
    version
  );
}
