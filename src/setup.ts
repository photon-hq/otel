import { createRequire } from "node:module";
import {
  context,
  propagation,
  type TracerProvider,
  trace,
} from "@opentelemetry/api";
import { type LoggerProvider, logs } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider as SdkLoggerProvider,
} from "@opentelemetry/sdk-logs";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  type FetchInstrumentation,
  type InstrumentFetchOptions,
  instrumentFetch,
} from "./instrument-fetch";
import { instrumentFetchNative } from "./instrument-fetch-native";
import { type LogLevel, setLogLevel } from "./logger";
import { IS_BUN } from "./runtime";
import { clearActiveProviders, setActiveProviders } from "./scope";

export interface SetupOtelOptions {
  /**
   * Default OTLP/HTTP base endpoint (e.g. `https://otel.example.com`). The
   * `/v1/traces` and `/v1/logs` paths are appended automatically. Standard
   * `OTEL_EXPORTER_OTLP_*` env vars always take precedence.
   */
  endpoint?: string;
  /**
   * Default OTLP headers (e.g. `{ Authorization: "Basic ..." }`). Merged with
   * any headers parsed from `OTEL_EXPORTER_OTLP_HEADERS`; env values win on
   * conflicts.
   */
  headers?: Record<string, string>;
  /**
   * Auto-instrument outbound `globalThis.fetch` with CLIENT spans and W3C
   * trace-context propagation. On Bun this is the only fetch instrumentation
   * that works (diagnostics_channel-based instrumentations emit nothing on
   * Bun's native fetch); it works identically on Node.
   *
   * `true` enables with defaults; pass an object to filter URLs via `ignore`.
   * Defaults to enabled when a traces endpoint is configured. Pass `false` to
   * disable. In scoped mode (`register: false`) it defaults to disabled — use
   * `createInstrumentedFetch()` per client instead of wrapping the global.
   */
  instrumentFetch?: boolean | InstrumentFetchOptions;
  /**
   * Minimum log level emitted by `createLogger()` (to both OTLP and console).
   * The `LOG_LEVEL` env var still takes precedence. Defaults to `debug` in
   * development and `info` otherwise.
   */
  logLevel?: LogLevel;
  /**
   * Whether to register this pipeline as the process-global OpenTelemetry
   * tracer/logger providers. Defaults to `true` (the convenient app-level
   * setup). Set to `false` for **scoped** mode: the library keeps its own
   * providers and routes `withSpan` / `createLogger` / `createInstrumentedFetch`
   * through them, but leaves the host app's global tracer/logger providers
   * untouched — so an embedded library can emit telemetry without taking over
   * the host's OpenTelemetry. The shared context manager and W3C propagator are
   * still installed if absent (needed for span nesting and trace propagation),
   * and auto fetch instrumentation defaults off (see `instrumentFetch`).
   */
  register?: boolean;
  /**
   * Extra resource attributes attached to every span/log alongside
   * `service.name` / `service.version`.
   */
  resourceAttributes?: Record<string, string | number | boolean>;
  serviceName: string;
  serviceVersion?: string;
}

export interface OtelHandle {
  /** The logger provider this setup built (private in scoped mode). */
  loggerProvider: LoggerProvider;
  shutdown(): Promise<void>;
  /**
   * The tracer provider this setup built. In scoped mode it is the library's
   * private provider (not the global one), so embedders can build extra tracers
   * or attach processors against it.
   */
  tracerProvider: TracerProvider;
}

let activeHandle: OtelHandle | undefined;

const TRAILING_SLASH = /\/$/;

function parseEnvHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

function resolveTracesEndpoint(base: string | undefined): string | undefined {
  const traces = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (traces) {
    return traces;
  }
  const generic = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? base;
  return generic
    ? `${generic.replace(TRAILING_SLASH, "")}/v1/traces`
    : undefined;
}

function resolveLogsEndpoint(base: string | undefined): string | undefined {
  const logsEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (logsEndpoint) {
    return logsEndpoint;
  }
  const generic = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? base;
  return generic ? `${generic.replace(TRAILING_SLASH, "")}/v1/logs` : undefined;
}

/**
 * Normalize a URL to an `origin + path` key (trailing slash stripped) for exact
 * self-trace matching. Returns `undefined` for unparseable URLs.
 */
function otlpEndpointKey(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(TRAILING_SLASH, "")}`;
  } catch {
    return;
  }
}

function otlpEndpointKeysOf(
  tracesEndpoint: string | undefined,
  logsEndpoint: string | undefined
): string[] {
  const keys: string[] = [];
  for (const endpoint of [tracesEndpoint, logsEndpoint]) {
    if (!endpoint) {
      continue;
    }
    const key = otlpEndpointKey(endpoint);
    if (key) {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Start fetch instrumentation unless disabled. Defaults to on when a traces
 * pipeline is configured, except in scoped mode (`register: false`) where it
 * defaults off. On Node (mode `"auto"`) this registers the native
 * `@opentelemetry/instrumentation-undici`; on Bun, with mode `"global"`, or in
 * scoped mode, it wraps `globalThis.fetch` (native can only read the global
 * tracer provider, so scoped mode can't use it). Always excludes our own OTLP
 * endpoints so the exporter's traffic is never self-traced (matters on Node,
 * where the OTLP exporter can use fetch).
 */
function startFetchInstrumentation(
  option: boolean | InstrumentFetchOptions | undefined,
  register: boolean,
  hasTraces: boolean,
  tracesEndpoint: string | undefined,
  logsEndpoint: string | undefined
): FetchInstrumentation | undefined {
  // Scoped mode (register === false) never auto-enables: native undici can't
  // target the library's held provider, and wrapping globalThis.fetch is
  // process-wide. An explicit `option` still turns it on (forced onto the wrap).
  const want = option ?? (register && hasTraces);
  if (!want) {
    return;
  }
  const userOptions = typeof option === "object" ? option : undefined;
  const otlpEndpointKeys = otlpEndpointKeysOf(tracesEndpoint, logsEndpoint);
  const ignore = (url: string): boolean => {
    const key = otlpEndpointKey(url);
    const isOtlpEndpoint = key !== undefined && otlpEndpointKeys.includes(key);
    return isOtlpEndpoint || (userOptions?.ignore?.(url) ?? false);
  };

  // "auto" (default) prefers Node's native undici instrumentation; "global"
  // forces the globalThis.fetch wrap. Native never applies on Bun, whose fetch
  // emits no diagnostics_channel events, nor in scoped mode (it reads the global
  // provider, which scoped mode doesn't set). Fall back to the wrap when the
  // optional undici packages aren't installed, so Node still gets fetch spans.
  if (register && (userOptions?.mode ?? "auto") === "auto" && !IS_BUN) {
    const native = instrumentFetchNative(
      { ...userOptions, ignore },
      createRequire(import.meta.url)
    );
    if (native) {
      return native;
    }
  }
  // Forward the user's options (e.g. static `attributes`) to the wrap too; the
  // composed `ignore` overrides any user-supplied one so OTLP self-traces stay
  // excluded.
  return instrumentFetch({ ...userOptions, ignore });
}

/**
 * Boot an OTLP/HTTP-based OpenTelemetry pipeline (traces + logs).
 *
 * Idempotent: calling twice in the same process is a no-op on the second
 * call, so libraries can safely invoke this without clobbering an app-level
 * OTel setup that ran earlier.
 *
 * Registers the global tracer/logger providers by default; pass
 * `register: false` for scoped mode, which keeps the library's own providers
 * and leaves the host app's global OpenTelemetry untouched (see
 * `SetupOtelOptions.register`).
 *
 * Standard `OTEL_EXPORTER_OTLP_*` env vars override the `endpoint` and
 * `headers` arguments — this matches the OpenTelemetry SDK config spec.
 */
export function setupOtel(options: SetupOtelOptions): OtelHandle {
  if (activeHandle) {
    return activeHandle;
  }

  const register = options.register !== false;

  if (options.logLevel) {
    setLogLevel(options.logLevel);
  }

  const tracesEndpoint = resolveTracesEndpoint(options.endpoint);
  const logsEndpoint = resolveLogsEndpoint(options.endpoint);
  const mergedHeaders = {
    ...options.headers,
    ...parseEnvHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
  };
  const hasHeaders = Object.keys(mergedHeaders).length > 0;

  const resource = resourceFromAttributes({
    "service.name": options.serviceName,
    ...(options.serviceVersion
      ? { "service.version": options.serviceVersion }
      : {}),
    "deployment.environment": process.env.DEPLOYMENT_ENV ?? "development",
    ...options.resourceAttributes,
  });

  // Context manager + propagator are shared, process-global infrastructure (not
  // data routing), and the API rejects a duplicate registration — so these are
  // effectively set-if-absent. Scoped mode still wants them present for span
  // nesting and W3C propagation, sharing the host's if it already installed one.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager());
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    })
  );

  const traceProcessors = tracesEndpoint
    ? [
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: tracesEndpoint,
            headers: hasHeaders ? mergedHeaders : undefined,
          })
        ),
      ]
    : [];

  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: traceProcessors,
  });
  if (register) {
    trace.setGlobalTracerProvider(tracerProvider);
  }

  const fetchInstrumentation = startFetchInstrumentation(
    options.instrumentFetch,
    register,
    traceProcessors.length > 0,
    tracesEndpoint,
    logsEndpoint
  );

  const logProcessors = logsEndpoint
    ? [
        new BatchLogRecordProcessor(
          new OTLPLogExporter({
            url: logsEndpoint,
            headers: hasHeaders ? mergedHeaders : undefined,
          })
        ),
      ]
    : [];

  const loggerProvider = new SdkLoggerProvider({
    resource,
    processors: logProcessors,
  });
  if (register) {
    logs.setGlobalLoggerProvider(loggerProvider);
  }

  // Route the library's own helpers (withSpan / createLogger / the fetch wrap)
  // through these providers in both modes, so scoped mode emits into them while
  // the host app's global providers stay untouched.
  setActiveProviders({ tracerProvider, loggerProvider });

  const handle: OtelHandle = {
    tracerProvider,
    loggerProvider,
    async shutdown() {
      fetchInstrumentation?.unpatch();
      await Promise.allSettled([
        tracerProvider.shutdown(),
        loggerProvider.shutdown(),
      ]);
      clearActiveProviders();
      activeHandle = undefined;
    },
  };

  activeHandle = handle;
  return handle;
}

/**
 * Read-only accessor for tests / debug paths that need to know whether
 * `setupOtel` has already run in this process.
 */
export function isOtelActive(): boolean {
  return activeHandle !== undefined;
}
