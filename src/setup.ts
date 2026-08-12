import { createRequire } from "node:module";
import {
  context,
  type Meter,
  type MeterOptions,
  type MeterProvider,
  metrics,
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
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider as SdkLoggerProvider,
} from "@opentelemetry/sdk-logs";
import {
  PeriodicExportingMetricReader,
  MeterProvider as SdkMeterProvider,
} from "@opentelemetry/sdk-metrics";
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
import {
  resolveMetricReaderTiming,
  resolveOtlpEndpoint,
  resolveOtlpHeaders,
} from "./otlp-config";
import { IS_BUN } from "./runtime";
import { clearActiveProviders, setActiveProviders } from "./scope";

export interface SetupOtelOptions {
  /**
   * Default OTLP/HTTP base endpoint (e.g. `https://otel.example.com`). The
   * `/v1/traces`, `/v1/logs`, and `/v1/metrics` paths are appended
   * automatically. Standard `OTEL_EXPORTER_OTLP_*` env vars always take
   * precedence.
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
   * Takes precedence over `LOG_LEVEL`. Defaults to `info`, independently of
   * `DEPLOYMENT_ENV`.
   *
   * Invalid runtime values from untyped JavaScript callers throw a `TypeError`.
   */
  logLevel?: LogLevel;
  /**
   * Whether to register this pipeline as the process-global OpenTelemetry
   * tracer/logger/meter providers. Defaults to `true` (the convenient app-level
   * setup). Set to `false` for **scoped** mode: the library keeps its own
   * providers and routes `withSpan` / `createLogger` / `createInstrumentedFetch`
   * through them, but leaves the host app's global tracer/logger/meter providers
   * untouched — so an embedded library can emit telemetry without taking over
   * the host's OpenTelemetry. The shared context manager and W3C propagator are
   * still installed if absent (needed for span nesting and trace propagation),
   * and auto fetch instrumentation defaults off (see `instrumentFetch`).
   */
  register?: boolean;
  /**
   * Extra resource attributes attached to every span/log/metric alongside
   * `service.name` / `service.version`.
   */
  resourceAttributes?: Record<string, string | number | boolean>;
  serviceName: string;
  serviceVersion?: string;
}

export interface OtelHandle {
  /** Get a meter from this setup's provider in global or scoped mode. */
  getMeter(name: string, version?: string, options?: MeterOptions): Meter;
  /** The logger provider this setup built (private in scoped mode). */
  loggerProvider: LoggerProvider;
  /** The meter provider this setup built (private in scoped mode). */
  meterProvider: MeterProvider;
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

function optionalHeaders(
  headers: Record<string, string>
): Record<string, string> | undefined {
  return Object.keys(headers).length > 0 ? headers : undefined;
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
  endpoints: readonly (string | undefined)[]
): string[] {
  const keys: string[] = [];
  for (const endpoint of endpoints) {
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
  logsEndpoint: string | undefined,
  metricsEndpoint: string | undefined
): FetchInstrumentation | undefined {
  // Scoped mode (register === false) never auto-enables: native undici can't
  // target the library's held provider, and wrapping globalThis.fetch is
  // process-wide. An explicit `option` still turns it on (forced onto the wrap).
  const want = option ?? (register && hasTraces);
  if (!want) {
    return;
  }
  const userOptions = typeof option === "object" ? option : undefined;
  const otlpEndpointKeys = otlpEndpointKeysOf([
    tracesEndpoint,
    logsEndpoint,
    metricsEndpoint,
  ]);
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
 * Boot an OTLP/HTTP-based OpenTelemetry pipeline (traces + logs + metrics).
 *
 * Idempotent: calling twice in the same process is a no-op on the second
 * call, so libraries can safely invoke this without clobbering an app-level
 * OTel setup that ran earlier.
 *
 * Registers the global tracer/logger/meter providers by default; pass
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

  if (options.logLevel !== undefined) {
    setLogLevel(options.logLevel);
  }

  const tracesEndpoint = resolveOtlpEndpoint("traces", options.endpoint);
  const logsEndpoint = resolveOtlpEndpoint("logs", options.endpoint);
  const metricsEndpoint = resolveOtlpEndpoint("metrics", options.endpoint);
  const traceHeaders = optionalHeaders(
    resolveOtlpHeaders("traces", options.headers)
  );
  const logHeaders = optionalHeaders(
    resolveOtlpHeaders("logs", options.headers)
  );
  const metricHeaders = optionalHeaders(
    resolveOtlpHeaders("metrics", options.headers)
  );

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
            headers: traceHeaders,
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
    logsEndpoint,
    metricsEndpoint
  );

  const logProcessors = logsEndpoint
    ? [
        new BatchLogRecordProcessor(
          new OTLPLogExporter({
            url: logsEndpoint,
            headers: logHeaders,
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

  const metricReaders = metricsEndpoint
    ? [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({
            url: metricsEndpoint,
            headers: metricHeaders,
          }),
          ...resolveMetricReaderTiming(),
        }),
      ]
    : [];
  const meterProvider = new SdkMeterProvider({
    resource,
    readers: metricReaders,
  });
  if (register) {
    metrics.setGlobalMeterProvider(meterProvider);
  }

  // Route the library's own helpers (withSpan / createLogger / the fetch wrap)
  // through these providers in both modes, so scoped mode emits into them while
  // the host app's global providers stay untouched.
  setActiveProviders({ tracerProvider, loggerProvider });

  const handle: OtelHandle = {
    getMeter: (name, version, meterOptions) =>
      meterProvider.getMeter(name, version, meterOptions),
    tracerProvider,
    loggerProvider,
    meterProvider,
    async shutdown() {
      fetchInstrumentation?.unpatch();
      await Promise.allSettled([
        tracerProvider.shutdown(),
        loggerProvider.shutdown(),
        meterProvider.shutdown(),
      ]);
      if (activeHandle === handle) {
        clearActiveProviders();
        activeHandle = undefined;
      }
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
